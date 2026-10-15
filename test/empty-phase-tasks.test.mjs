import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, check } from './fixtures/approved-graph.mjs'
import { taskIdentifierProblem } from '../scripts/task-identifiers.mjs'

const NEXT = /must use the next number T/
const SUFFIX = /must extend an existing task with a lowercase suffix/
const eleven = Array.from({ length: 11 }, (_, i) => ({ id: 'T' + (i + 1) }))
const extra = (id, phase, deps = ['T1']) => ({ id, phase, title: 'Entrega ' + id, summary: 'Planejada fase a fase.', deps, validation: [check] })

function placeholderFixture(t) {
  const f = fixture(t, { phase: true, tasks: eleven })
  f.plan.phases.push({ id: 'F3', title: 'Terceira' }, { id: 'F4', title: 'Quarta' }); f.writePlan()
  f.ok('sync-plan', '--plan', f.source)
  return f
}
const add = (f, ...tasks) => { f.plan.tasks.push(...tasks); f.writePlan() }

test('fase placeholder vazia aceita a proxima numeracao global, com e sem --propose', t => {
  const f = placeholderFixture(t)
  add(f, extra('T12', 'F2'))
  const before = JSON.stringify(f.state())
  f.ok('sync-plan', '--plan', f.source, '--propose', '--dry-run')
  assert.equal(JSON.stringify(f.state()), before)
  f.ok('sync-plan', '--plan', f.source, '--propose')
  assert.equal(f.state().tasks.T12.phase, 'F2')
  assert.equal(f.state().tasks.T1.phase, 'F1')
  add(f, extra('T13', 'F2'))
  f.rejects(SUFFIX, 'sync-plan', '--plan', f.source)
})

test('duas fases vazias recebem T12 e T13 no mesmo sync', t => {
  const f = placeholderFixture(t)
  add(f, extra('T12', 'F2'), extra('T13', 'F3'))
  f.ok('sync-plan', '--plan', f.source)
  assert.deepEqual([f.state().tasks.T12.phase, f.state().tasks.T13.phase], ['F2', 'F3'])
})

test('numero errado em fase vazia e recusado com a mensagem do proximo numero', t => {
  const f = placeholderFixture(t)
  for (const id of ['T14', 'T5', 'T13']) {
    add(f, extra(id, 'F2'))
    const before = JSON.stringify(f.state())
    f.rejects(id === 'T5' ? /duplicate task id T5/ : NEXT, 'sync-plan', '--plan', f.source)
    assert.equal(JSON.stringify(f.state()), before)
    f.plan.tasks.pop()
  }
})

test('tarefa nova sem sufixo em fase com tarefas continua recusada', t => {
  const f = placeholderFixture(t)
  add(f, extra('T12', 'F1'))
  f.rejects(SUFFIX, 'sync-plan', '--plan', f.source)
  add(f, extra('T12', 'F1'))
})

test('fase vazia anterior a uma fase ja preenchida recebe o proximo numero sem alterar os existentes', t => {
  const f = placeholderFixture(t)
  add(f, extra('T12', 'F3'))
  f.ok('sync-plan', '--plan', f.source)
  f.plan.tasks.push(extra('T13', 'F2')); f.writePlan()
  f.ok('sync-plan', '--plan', f.source)
  const { tasks } = f.state()
  assert.deepEqual([tasks.T12.phase, tasks.T13.phase], ['F3', 'F2'])
  add(f, extra('T14', 'F3'))
  f.rejects(SUFFIX, 'sync-plan', '--plan', f.source)
})

test('fase esvaziada por --remove volta a aceitar o proximo numero sem reutilizar o ID reservado', t => {
  const f = placeholderFixture(t)
  add(f, extra('T12', 'F2'))
  f.ok('sync-plan', '--plan', f.source)
  f.plan.tasks.pop(); f.writePlan()
  f.ok('sync-plan', '--plan', f.source, '--remove', 'T12', '--reason', 'Reorganizacao aprovada')
  assert.equal(f.state().tasks.T12, undefined)
  add(f, extra('T12', 'F2'))
  f.rejects(/removed task identifier/, 'sync-plan', '--plan', f.source)
  f.plan.tasks.pop(); add(f, extra('T13', 'F2'))
  f.ok('sync-plan', '--plan', f.source)
  assert.equal(f.state().tasks.T13.phase, 'F2')
})

test('taskIdentifierProblem trata fase declarada sem tarefas como fase acrescentada', () => {
  const task = (id, phase) => ({ id, phase, deps: [] })
  const existing = Object.fromEntries(['T1', 'T2'].map(id => [id, task(id, 'F1')]))
  const phases = [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }]
  const options = { phases, existingPhases: ['F1', 'F2', 'F3'] }
  const run = (...added) => taskIdentifierProblem([...Object.values(existing), ...added], Object.keys(existing), existing, options)?.message ?? null
  assert.equal(run(task('T3', 'F2')), null)
  assert.equal(run(task('T3', 'F2'), task('T4', 'F3')), null)
  assert.match(run(task('T4', 'F2')), NEXT)
  assert.match(run(task('T3', 'F1')), SUFFIX)
  // F3 preenchida antes de F2: a posicao da fase nao altera a numeracao global
  const filled = { ...existing, T3: task('T3', 'F3') }
  const later = taskIdentifierProblem([...Object.values(filled), task('T4', 'F2')], Object.keys(filled), filled, options)
  assert.equal(later, null)
  // fase removida do estado (sem tarefas) com ID reservado: o numero reservado nao volta
  const reserved = id => taskIdentifierProblem([...Object.values(existing), task(id, 'F2')], ['T1', 'T2', 'T3'], existing, options)
  assert.deepEqual(reserved('T5').values, ['T5', 4])
  assert.equal(reserved('T4'), null)
  // fase nova (nao existente) no fim continua acrescentada; fase nova antes de fase com tarefas continua sem numero novo
  const fresh = taskIdentifierProblem([...Object.values(existing), task('T3', 'F4')], Object.keys(existing), existing, { phases: [...phases, { id: 'F4' }], existingPhases: ['F1'] })
  assert.equal(fresh, null)
  const before = taskIdentifierProblem([task('T3', 'F0'), ...Object.values(existing)], Object.keys(existing), existing, { phases: [{ id: 'F0' }, { id: 'F1' }], existingPhases: ['F1'] })
  assert.match(before.message, SUFFIX)
})
