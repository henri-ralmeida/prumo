import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { businessContract, contractDrift } from '../scripts/contract-drift.mjs'

test('comparação não confunde tarefa ausente com propriedade herdada', () => {
  const tasks = ['constructor', 'toString', '__proto__'].map(id => ({ id, title: id, deps: [], validation: '' }))
  const state = { plan: { name: 'Plano' }, tasks: {} }, before = JSON.stringify(state)
  assert.deepEqual(contractDrift(state, { plan: { name: 'Plano', tasks } }).tasks,
    tasks.map(task => ({ task: task.id, fields: ['notSynchronized'] })))
  assert.equal(JSON.stringify(state), before)
  state.tasks = JSON.parse('{"constructor":{"id":"constructor","title":"constructor","phase":null,"deps":[],"validation":"","tags":[],"touches":[]}}')
  assert.deepEqual(contractDrift(state, { plan: { name: 'Plano', tasks: tasks.slice(0, 1) } }).tasks, [])
  assert.deepEqual(contractDrift({ tasks: {} }, { plan: { tasks: [] } }).planFields, [])
})

test('fonte inválida informa indisponibilidade sem modificar o arquivo aprovado', t => {
  const root = mkdtempSync(join(tmpdir(), 'prumo-drift-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }) })
  const source = join(root, 'plan.json'), state = { plan: { source }, tasks: {} }
  for (const input of ['null', '1', '{}', '{"tasks":[null]}', '{"tasks":[1]}', '{"tasks":[{}]}', '{']) {
    writeFileSync(source, input)
    assert.deepEqual(contractDrift(state), { available: false, reason: 'unreadable', planFields: [], tasks: [] })
    assert.equal(readFileSync(source, 'utf8'), input)
  }
  assert.equal(contractDrift({ plan: { source: 1 } }).reason, 'missing')
  assert.equal(contractDrift({ plan: { source: '' } }).reason, 'missing')
})

test('contrato de negócio remove comandos executáveis e preserva expectativas', () => {
  const result = businessContract(undefined, { id: 'T1', title: 'Entrega', unavailable: ['local', 'local'],
    validation: [null, { expect: 'Resultado' }, { kind: 'functional', run: 'secret-command', expect: 'Fluxo correto' }] })
  assert.deepEqual(result.task.unavailable, ['local'])
  assert.deepEqual(result.task.validation, [{ expect: undefined }, { expect: 'Resultado' }, { kind: 'functional', expect: 'Fluxo correto' }])
  assert.equal(JSON.stringify(result).includes('secret-command'), false)
})

test('estado sem tarefas informa contratos pendentes e consulta aceita validação ausente', () => {
  const approved = { name: 'Plano', tasks: [{ id: 'T1', title: 'Entrega' }] }
  const state = { plan: { name: 'Plano' } }
  const before = JSON.stringify(state)
  assert.deepEqual(contractDrift(state, { plan: approved }), {
    available: true, planFields: [], tasks: [{ task: 'T1', fields: ['notSynchronized'] }],
  })
  assert.equal(businessContract(approved, approved.tasks[0]).task.validation, '')
  assert.equal(JSON.stringify(state), before)
})
