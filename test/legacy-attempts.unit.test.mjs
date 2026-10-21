import test from 'node:test'
import assert from 'node:assert/strict'
import { terminalAttemptRepairs, repairTerminalAttempts, attemptsForContext } from '../scripts/legacy-attempts.mjs'
import { planningContext, hasCurrentTaskScope, assertTaskPlan } from '../scripts/validation.mjs'

const at = hour => `2026-09-21T${String(hour).padStart(2, '0')}:00:00Z`
const state = (attempts, value = 'done') => ({ tasks: { T3: { id: 'T3', state: value, attempts } } })

test('reparo histórico preserva exatamente o contexto aceito e mantém alterações posteriores visíveis', () => {
  for (const fields of [{}, { endedAt: null, result: 'failed' }, { endedAt: '', result: null }]) {
    const value = state([{ n: 1, ...fields, startedAt: at(10), evidence: 'Registro original' }])
    const original = JSON.stringify(value.tasks.T3.attempts)
    repairTerminalAttempts(value, [{ task: 'T3', type: 'task_done', at: at(12) }])
    assert.equal(JSON.stringify(attemptsForContext(value.tasks.T3.attempts)), original)
    const repaired = structuredClone(value.tasks.T3.attempts)
    value.tasks.T3.attempts[0].endedAt = at(13)
    assert.notEqual(JSON.stringify(attemptsForContext(value.tasks.T3.attempts)), original)
    value.tasks.T3.attempts = repaired
    value.tasks.T3.attempts[0].result = 'Resultado posterior diferente'
    assert.notEqual(JSON.stringify(attemptsForContext(value.tasks.T3.attempts)), original)
  }
  assert.equal(attemptsForContext(undefined), undefined)
  assert.equal(attemptsForContext(null), null)
  const untouched = [{ n: 1 }, { n: 2, legacyClosure: {} }, { n: 3, legacyClosure: { context: { version: 2 } } }]
  assert.deepEqual(attemptsForContext(untouched), untouched)
  assert.equal(attemptsForContext(untouched)[0], untouched[0])
})

test('reparar a dependência não invalida um plano aceito nem torna atual um plano obsoleto', () => {
  for (const stale of [false, true]) {
    const validation = [{ kind: 'functional', run: 'node check.cjs', expect: 'Resultado correto' }]
    const graph = { plan: { name: 'Entrega com dependência', planningMode: 'task', requireReview: true }, tasks: {
      T1: { id: 'T1', title: 'Dependência concluída', state: 'done', deps: [], attempts: [
        { n: 1, startedAt: at(10) }, { n: 2, startedAt: at(11), endedAt: at(12), result: 'done' },
      ], validations: [], validation },
      T2: { id: 'T2', title: 'Entrega dependente', state: 'pending', deps: ['T1'], attempts: [], validations: [], validation,
        planningRequired: true, discoveryRequired: false },
    } }
    const task = graph.tasks.T2
    task.taskPlan = { research: [{ source: 'Contrato', findings: 'Dependência concluída' }], decisions: [],
      steps: ['Verificar resultado correto'], verification: [{ criterion: 'Resultado correto', check: 1 }],
      openQuestions: [], planner: 'planejador', completedAt: at(13), attempt: 1,
      scope: stale ? 'contrato-obsoleto' : planningContext(graph, task, { scopeOnly: true, attempt: 1 }),
      context: planningContext(graph, task, { attempt: 1 }) }
    assertTaskPlan(task, task.taskPlan)
    const before = planningContext(graph, task, { attempt: 1 })
    assert.equal(hasCurrentTaskScope(graph, task, 1), !stale)
    repairTerminalAttempts(graph)
    assert.equal(planningContext(graph, task, { attempt: 1 }), before)
    assert.equal(hasCurrentTaskScope(graph, task, 1), !stale)
  }
})

test('tentativa histórica de tarefa concluída recebe o início seguinte sem alterar sua entrega', () => {
  const value = state([{ n: 1, agent: 'executor-antigo', startedAt: at(10) },
    { n: 2, agent: 'executor-final', startedAt: at(11), endedAt: at(13), result: 'done' }])
  value.tasks.T3.taskPlan = { digest: 'contrato-aprovado' }
  value.tasks.T3.validations = [{ ok: true, token: 'recibo-preservado' }]
  const before = structuredClone(value)
  const preview = terminalAttemptRepairs(value)
  assert.deepEqual(value, before)
  assert.deepEqual(preview, { repairs: [{ collection: 'tasks', owner: 'T3', index: 0, attempt: 1,
    endedAt: at(11), source: { type: 'next-attempt', attempt: 2 } }], unresolved: [] })
  assert.deepEqual(repairTerminalAttempts(value), preview)
  const expected = structuredClone(before)
  Object.assign(expected.tasks.T3.attempts[0], { endedAt: at(11), result: 'legacy-superseded', legacyClosure: { type: 'next-attempt', attempt: 2, context: { version: 1, resultAdded: true, appliedEndedAt: at(11) } } })
  assert.deepEqual(value, expected)
  assert.deepEqual(repairTerminalAttempts(value), { repairs: [], unresolved: [] })
})

test('tarefa terminal com tentativa única usa o evento real e conserva resultado já registrado', () => {
  const value = state([{ n: 1, startedAt: at(10), result: 'done', evidence: 'manter' }])
  const events = [{ task: 'T3', type: 'task_done', at: at(12) }]
  const result = repairTerminalAttempts(value, events)
  assert.equal(value.tasks.T3.attempts[0].endedAt, at(12))
  assert.equal(value.tasks.T3.attempts[0].result, 'done')
  assert.equal(value.tasks.T3.attempts[0].evidence, 'manter')
  assert.deepEqual(result.repairs[0].source, { type: 'event', eventType: 'task_done', eventIndex: 0 })
  assert.deepEqual(events, [{ task: 'T3', type: 'task_done', at: at(12) }])
})

test('tarefa pulada encerra tentativa pelo evento correspondente e mantém o estado terminal', () => {
  const value = state([{ startedAt: at(10) }], 'skipped')
  const result = repairTerminalAttempts(value, [{ task: 'T3', type: 'task_skip', at: at(12) }])
  assert.equal(result.repairs[0].attempt, 1)
  assert.equal(value.tasks.T3.state, 'skipped')
  assert.equal(value.tasks.T3.attempts[0].endedAt, at(12))
})

test('início da tentativa posterior e falha numerada são evidências de encerramento', () => {
  const value = state([{ n: 1, startedAt: at(10) }, { n: 2, startedAt: at(12) }])
  const result = repairTerminalAttempts(value, [
    { task: 'T3', type: 'task_start', attempt: 2, at: at(11) },
    { task: 'T3', type: 'task_fail', attempt: 2, at: at(13) },
  ])
  assert.deepEqual(result.repairs.map(repair => repair.endedAt), [at(11), at(13)])
  assert.equal(result.repairs[0].source.eventType, 'task_start')
})

test('ausência de evidência e início ausente são diagnósticos sem fabricar horários', () => {
  const value = state([{ n: 1 }, { n: 2, startedAt: at(13) }])
  const before = structuredClone(value)
  const result = repairTerminalAttempts(value, [
    { task: 'T3', type: 'task_done', at: at(12) },
    { task: 'T3', type: 'task_done', at: 'inválido' },
    { task: 'T3', type: 'task_note', at: at(14) },
    { task: 'T4', type: 'task_done', at: at(14) },
    { task: 'T3', type: 'task_fail', attempt: 1, at: at(14) },
    { task: 'T3', type: 'task_start', attempt: '3', at: at(14) },
  ])
  assert.deepEqual(result.repairs, [])
  assert.deepEqual(result.unresolved.map(item => [item.attempt, item.reason]), [[1, 'missing-start'], [2, 'missing-end-evidence']])
  assert.deepEqual(value, before)
})

test('owners não terminais permanecem intocados mesmo quando há eventos de encerramento', () => {
  for (const status of ['failed', 'pending', 'blocked', 'running', 'reviewing']) {
    const value = state([{ n: 1, startedAt: at(10) }], status), before = structuredClone(value)
    assert.deepEqual(repairTerminalAttempts(value, [{ task: 'T3', type: 'task_done', at: at(12) }]), { repairs: [], unresolved: [] })
    assert.deepEqual(value, before)
  }
  assert.deepEqual(terminalAttemptRepairs({}), { repairs: [], unresolved: [] })
  assert.deepEqual(terminalAttemptRepairs({ tasks: { T1: { state: 'done' } } }), { repairs: [], unresolved: [] })
})

test('tentativas do fluxo de fase usam somente eventos da mesma fase', () => {
  const value = { phaseWorkflows: { F5: { state: 'done', attempts: [{ n: 1, startedAt: at(10) }] } } }
  const result = repairTerminalAttempts(value, [
    { phase: 'F6', type: 'phase_done', at: at(11) },
    { task: 'F5', type: 'task_done', at: at(11) },
    { phase: 'F5', type: 'phase_done', attempt: 1, at: at(12) },
  ])
  assert.equal(result.repairs[0].collection, 'phaseWorkflows')
  assert.equal(result.repairs[0].owner, 'F5')
  assert.equal(value.phaseWorkflows.F5.attempts[0].endedAt, at(12))
})

test('datas inválidas ou anteriores na tentativa seguinte não servem como encerramento', () => {
  const value = state([{ n: 0, startedAt: at(12) }, { startedAt: 'inválido' }, { startedAt: at(11), endedAt: at(13) }])
  const result = terminalAttemptRepairs(value)
  assert.deepEqual(result.repairs, [])
  assert.deepEqual(result.unresolved.map(item => item.reason), ['missing-end-evidence', 'missing-start'])
})
