import test from 'node:test'
import assert from 'node:assert/strict'
import { TASK_STAGES, stageSkipScope, stageSkipAttempt, stageSkipReviewRound, currentStageSkips, currentStageSkip } from '../scripts/stage-skips.mjs'
import { executionInputReceipt } from '../scripts/validation.mjs'
import { dispatchOwners, recordDispatchMetadata, reportedUsageTotals } from '../scripts/run-metadata.mjs'

const fixture = () => ({ run: 'approved', plan: { name: 'Entrega', planningMode: 'task', requireReview: true },
  tasks: { T1: { id: 'T1', stageSkipIdentity: 'task-one', title: 'Contrato aprovado', deps: [], validation: [{ kind: 'functional', run: 'node --version', expect: 'Node disponível' }], attempts: [], state: 'pending' } } })
const decide = (state, task, extra = {}) => ({ decision: 'skipped', decisionId: 'choice', stages: [...TASK_STAGES],
  run: state.run, confirmedByUser: true, scope: stageSkipScope(state, task), attempt: stageSkipAttempt(task), reviewRound: 1, ...extra })

test('rodada de revisão pertence à tentativa selecionada; histórico anterior não contamina o próximo aceite', () => {
  const task = fixture().tasks.T1
  task.state = 'done'; assert.equal(stageSkipReviewRound(task), 1)
  task.attempts = [{ n: 1, reviewRound: 2 }]; task.state = 'reviewing'
  assert.equal(stageSkipReviewRound(task), 2)
  task.state = 'failed'; assert.equal(stageSkipReviewRound(task), 1)
  task.state = 'pending'; assert.equal(stageSkipReviewRound(task), 1)
  task.attempts.push({ n: 2 }); task.state = 'reviewing'
  assert.equal(stageSkipReviewRound(task), 1)
})

test('revisão sem execução registra somente o revisor e conta seu consumo uma vez', () => {
  const state = fixture(), before = structuredClone(state)
  const attempt = { kind: 'review-only', agent: null, reviewer: 'reviewer', startedAt: '2026-01-01', reviewStartedAt: '2026-01-01',
    usageReports: [{ task: 'T1', tokens: 12, tools: 2 }] }
  state.tasks.T1.attempts = [attempt]
  assert.deepEqual(dispatchOwners(state).map(item => item.role), ['review'])
  assert.deepEqual(recordDispatchMetadata(before, state).map(item => item.role), ['review'])
  assert.equal(reportedUsageTotals(state).run.tokens, 12)
  assert.equal(reportedUsageTotals(state).run.receipts, 1)
  delete attempt.kind; attempt.agent = 'executor'
  assert.deepEqual(dispatchOwners(state).map(item => item.role), ['execution', 'review'])
  assert.equal(reportedUsageTotals(state).run.tokens, 12)
})

test('dispensa exige registro confirmado, contrato e tentativa atuais; legado não recebe dispensas', () => {
  const state = fixture(), task = state.tasks.T1
  for (const history of [undefined, null, {}, []]) { task.stageSkips = history; assert.deepEqual(currentStageSkips(state, task), []) }
  const valid = decide(state, task)
  task.stageSkips = [null, {}, { ...valid, stages: 'review' }, { ...valid, confirmedByUser: false }, { ...valid, scope: 'outro' },
    { ...valid, attempt: 2 }, { ...valid, reviewRound: 2 }, valid]
  assert.deepEqual(currentStageSkips(state, task), [valid])
  assert.equal(currentStageSkip(state, task, 'execution'), valid)
  assert.equal(currentStageSkip(state, task, 'unknown'), null)
  task.stageSkips = [valid]
  delete task.stageSkipIdentity
  assert.deepEqual(currentStageSkips(state, task), [])
  task.stageSkipIdentity = 'task-one'
  task.attempts.push({ n: 1 }); task.state = 'running'
  assert.equal(stageSkipAttempt(task), 1)
  assert.equal(currentStageSkips(state, task).length, 1)
  task.attempts[0].reviewRound = 2
  assert.deepEqual(currentStageSkips(state, task), [])
  task.attempts[0].reviewRound = 1; task.state = 'pending'
  assert.equal(stageSkipAttempt(task), 2)
  assert.deepEqual(currentStageSkips(state, task), [])
  task.state = 'done'
  assert.equal(stageSkipAttempt(task), 1)
  task.completionDecision = { by: 'user', attempt: 2 }
  assert.equal(stageSkipAttempt(task), 2)
})

test('renumeração preserva a dispensa; alteração real de contrato, revisão e escopo a invalida', () => {
  const state = fixture(), task = state.tasks.T1, scope = stageSkipScope(state, task)
  task.id = 'T7'; task.phase = 'F7'; task.deps = ['T6']
  assert.equal(stageSkipScope(state, task), scope)
  for (const field of ['contractRevision', 'scopeRevision', 'planningRevision']) {
    task[field] = 1; assert.notEqual(stageSkipScope(state, task), scope); delete task[field]
  }
  task.validation[0].run = 'node -v'
  assert.notEqual(stageSkipScope(state, task), scope)
  task.validation[0].run = 'node --version'; state.plan.requireReview = false
  assert.notEqual(stageSkipScope(state, task), scope)
})

test('entrada aceita pelo usuário exige a decisão original atual e preserva sua identidade', () => {
  const state = fixture(), dep = state.tasks.T1, choice = decide(state, dep)
  dep.stageSkips = [choice]; dep.state = 'done'
  dep.completionDecision = { by: 'user', attempt: 1, stages: [...TASK_STAGES], decisions: ['choice'], reason: 'Aceite explícito' }
  const task = { id: 'T2', deps: ['T1'] }
  const before = executionInputReceipt(state, task)
  assert.equal(before.inputs[0].result, 'user-accepted')
  dep.completionDecision.reason = 'Outro aceite'
  assert.notEqual(executionInputReceipt(state, task).digest, before.digest)
  dep.completionDecision.decisions = null
  assert.throws(() => executionInputReceipt(state, task), /no current explicit user completion decision/)
  dep.completionDecision.decisions = ['choice']; dep.scopeRevision = 1
  assert.throws(() => executionInputReceipt(state, task), /no current explicit user completion decision/)
})

test('uma escolha não é transferida para outra tarefa ou execução do grafo', () => {
  const state = fixture(), task = state.tasks.T1, choice = decide(state, task)
  task.stageSkips = [choice]
  const other = { ...task, id: 'T2', stageSkipIdentity: 'task-two' }
  assert.deepEqual(currentStageSkips(state, other), [])
  assert.deepEqual(currentStageSkips({ ...state, run: 'other' }, task), [])
})
