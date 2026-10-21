import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTaskMapping, renumberTasks, renumberBlockers, RenumberError } from '../scripts/task-renumber.mjs'
import { executionInputReceipt, phasePlanningContext, planningContext } from '../scripts/validation.mjs'

function fixture(state = 'done', attempts = [{ n: 1, startedAt: '2026-01-01' }]) {
  const task = { id: 'T1', title: 'Entrega preservada', deps: [], state, planningRequired: false, attempts, validations: [] }
  const original = { plan: { name: 'Entrega', requireReview: true, phases: [] }, tasks: { T1: task } }
  return { original, plan: { ...original.plan, tasks: [task] } }
}

test('tarefas terminais preservam tentativas legadas sem encerramento, inclusive a única tentativa', () => {
  for (const terminal of ['done', 'skipped']) for (const withSuccessor of [false, true]) {
    const { original, plan } = fixture(terminal)
    if (withSuccessor) original.tasks.T1.attempts.push({ n: 2, startedAt: '2026-01-02', endedAt: '2026-01-03', result: 'done' })
    const before = structuredClone(original)
    assert.deepEqual(renumberBlockers(original), [])
    const result = renumberTasks(original, plan, { T1: 'T2' })
    assert.deepEqual(original, before)
    assert.equal(result.state.tasks.T2.state, terminal)
    assert.deepEqual(result.state.tasks.T2.attempts, before.tasks.T1.attempts)
    assert.equal(result.state.tasks.T2.attempts[0].endedAt, undefined)
  }
})

test('tentativa substituída não bloqueia uma tarefa não terminal cuja tentativa atual foi encerrada', () => {
  const { original, plan } = fixture('failed', [{ n: 1 }, { n: 2, endedAt: '2026-01-03', result: 'failed' }])
  assert.deepEqual(renumberBlockers(original), [])
  assert.deepEqual(renumberTasks(original, plan, { T1: 'T2' }).state.tasks.T2.attempts, original.tasks.T1.attempts)
})

test('a última tentativa aberta continua bloqueando tarefas não terminais e identifica tarefa e tentativa', () => {
  for (const state of ['failed', 'pending', 'blocked']) {
    const { original, plan } = fixture(state, [{ n: 1, endedAt: '2026-01-02' }, { n: 2, startedAt: '2026-01-03' }])
    const expected = [{ owner: 'T1', ownerType: 'task', state, kind: 'attempt', attempt: 2 }]
    const before = structuredClone(original)
    assert.deepEqual(renumberBlockers(original), expected)
    assert.throws(() => renumberTasks(original, plan, { T1: 'T2' }), error => {
      assert.ok(error instanceof RenumberError)
      assert.equal(error.code, 'PRUMO_RENUMBER')
      assert.equal(error.message, 'Renumbering is blocked by open work')
      assert.deepEqual(error.blockers, expected)
      assert.deepEqual(error.params, [])
      return true
    })
    assert.deepEqual(original, before)
  }
})

test('a prévia de bloqueios conserva estados ativos e todas as rodadas abertas de tarefas e fases', () => {
  for (const state of ['running', 'reviewing', 'planning', 'discussing']) {
    const { original } = fixture(state, [])
    const before = structuredClone(original)
    assert.deepEqual(renumberBlockers(original), [{ owner: 'T1', ownerType: 'task', state, kind: 'active-state' }])
    assert.deepEqual(original, before)
  }
  const { original } = fixture('done', [])
  original.tasks.T1.discussionAttempts = [{ endedAt: '2026-01-01' }, { n: 7 }]
  original.phaseWorkflows = { F1: { state: 'planning', planningAttempts: [{}], attempts: [{}] } }
  assert.deepEqual(renumberBlockers(original), [
    { owner: 'T1', ownerType: 'task', state: 'done', kind: 'discussion', round: 7 },
    { owner: 'F1', ownerType: 'phase', state: 'planning', kind: 'active-state' },
    { owner: 'F1', ownerType: 'phase', state: 'planning', kind: 'planning', round: 1 },
    { owner: 'F1', ownerType: 'phase', state: 'planning', kind: 'attempt', attempt: 1 },
  ])
  assert.deepEqual(renumberBlockers({}), [])
})

test('tentativas de fase seguem a mesma distinção entre registro histórico e trabalho aberto', () => {
  for (const state of ['done', 'skipped']) {
    const { original, plan } = fixture('pending', [])
    original.phaseWorkflows = { F1: { id: 'F1', state, attempts: [{ n: 1 }] } }
    assert.deepEqual(renumberBlockers(original), [])
    assert.deepEqual(renumberTasks(original, plan, { T1: 'T2' }).state.phaseWorkflows.F1.attempts, [{ n: 1 }])
  }
  const { original } = fixture('pending', [])
  original.phaseWorkflows = { F1: { state: 'blocked', attempts: [{ n: 3 }] } }
  assert.deepEqual(renumberBlockers(original), [{ owner: 'F1', ownerType: 'phase', state: 'blocked', kind: 'attempt', attempt: 3 }])
})

test('recusas esperadas expõem mensagem e parâmetros traduzíveis sem confundir falhas inesperadas', () => {
  assert.throws(() => parseTaskMapping('T1=T2,T1=T3'), error => {
    assert.ok(error instanceof RenumberError)
    assert.equal(error.message, 'Repeated source identifier: {0}')
    assert.deepEqual(error.params, ['T1'])
    return true
  })
  const { original, plan } = fixture('pending', [])
  assert.throws(() => renumberTasks(original, plan, { T9: 'T2' }), error => error instanceof RenumberError && error.params[0] === 'T9')
  original.invalidContext = '[contexto-corrompido'
  assert.throws(() => renumberTasks(original, plan, { T1: 'T2' }), SyntaxError)
})

test('renumerar uma entrega legada mantém os recibos atuais das tarefas dependentes', () => {
  const { original, plan } = fixture('done', [{ n: 1 }, { n: 2, endedAt: '2026-01-03', result: 'done' }])
  original.tasks.T1.validations = [{ ok: true, attempt: 2, token: 'recibo-aprovado', at: '2026-01-03', agent: 'revisor', evidence: 'Comportamento verificado' }]
  original.tasks.T2 = { id: 'T2', title: 'Consumir entrega aprovada', deps: ['T1'], state: 'pending', planningRequired: false, attempts: [], validations: [] }
  plan.tasks.push(original.tasks.T2)
  const beforeReceipt = executionInputReceipt(original, original.tasks.T2)
  original.tasks.T2.inputDigest = beforeReceipt.digest
  original.tasks.T2.validationDigest = beforeReceipt.inputs[0].validation
  const contextDigests = (state, tasks) => tasks.map(task => ({ task: task.id,
    contextDigest: phasePlanningContext(state, task), inputDigest: planningContext(state, task),
    outputDigest: planningContext(state, task, { scopeOnly: true }) }))
  const result = renumberTasks(original, plan, { T1: 'T3' }, { contextDigests })
  const afterReceipt = executionInputReceipt(result.state, result.state.tasks.T2)
  assert.equal(afterReceipt.inputs[0].task, 'T3')
  assert.equal(result.state.tasks.T2.inputDigest, afterReceipt.digest)
  assert.equal(result.state.tasks.T2.validationDigest, afterReceipt.inputs[0].validation)
  assert.deepEqual(result.state.tasks.T3.attempts, original.tasks.T1.attempts)
})
