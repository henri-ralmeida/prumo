import test from 'node:test'
import assert from 'node:assert/strict'
import { questionAnswerOrigin, missingExecutionSteps, phaseOrderChange } from '../scripts/planning-context.mjs'
import { assertTaskPlan, taskPlanDigest } from '../scripts/validation.mjs'
import { overdueQuestions } from '../scripts/execution-readiness.mjs'

test('somente uma resposta literal da discussão identifica origem no usuário', () => {
  const q = { question: 'Qual formato?', answer: 'CSV' }
  assert.equal(questionAnswerOrigin({}, {}), 'proposal')
  assert.equal(questionAnswerOrigin(q, {}), 'unverified')
  assert.equal(questionAnswerOrigin(q, { discussionAttempts: [{}, { discovery: {} }] }), 'unverified')
  const discovery = { questions: [{ ...q, channel: 'chat-fallback' }] }
  assert.equal(questionAnswerOrigin(q, { discovery }), 'user-discussion')
  assert.equal(questionAnswerOrigin(q, {}, discovery), 'user-discussion')
  assert.equal(questionAnswerOrigin(q, { discussionAttempts: [{ discovery }] }), 'user-discussion')
  for (const mismatch of [{ question: 'Outra' }, { answer: 'JSON' }, { channel: undefined }])
    assert.equal(questionAnswerOrigin(q, { discovery: { questions: [{ ...discovery.questions[0], ...mismatch }] } }), 'unverified')
})

test('proposta não responde pergunta vencida nem satisfaz bloqueio; respostas legadas conservam compatibilidade', () => {
  const task = { id: 'T1', validation: 'Conferir entrega', validationMode: 'inspection', inspectionReason: 'Conferir entrega',
    taskPlan: { openQuestions: [{ question: 'Qual formato?', blocking: false, decideBy: 'user-now', proposedAnswer: 'CSV' }] } }
  const state = { tasks: { T1: task }, plan: {} }
  assert.equal(overdueQuestions(state, 'T1').length, 1)
  task.taskPlan.openQuestions[0].answer = 'JSON'
  assert.equal(overdueQuestions(state, 'T1').length, 0)
  const plan = { research: [{ source: 'Contrato', findings: 'Inspeção' }], decisions: [], steps: ['Conferir'],
    verification: [{ criterion: 'Entrega correta', check: 'inspection' }], openQuestions: [] }
  const external = { location: '/entregas/resultado.sql', purpose: 'Aplicação manual autorizada' }
  assert.doesNotThrow(() => assertTaskPlan(task, { ...plan, externalDeliverables: [external] }))
  assert.notEqual(taskPlanDigest(plan), taskPlanDigest({ ...plan, externalDeliverables: [external] }))
  for (const value of [null, {}, [null], [{}], [{ location: 'x', purpose: '' }], [{ location: '\0', purpose: 'Entrega' }]])
    assert.throws(() => assertTaskPlan(task, { ...plan, externalDeliverables: value }), /externalDeliverables/)
  assert.throws(() => assertTaskPlan(task, { ...plan, writes: ['/fora/arquivo'] }), /externalDeliverables/)
  for (const proposedAnswer of ['', null])
    assert.throws(() => assertTaskPlan(task, { ...plan, openQuestions: [{ question: 'Formato?', blocking: false, proposedAnswer }] }), /openQuestions/)
  assert.throws(() => assertTaskPlan(task, { ...plan, openQuestions: [{ question: 'Formato?', blocking: true, proposedAnswer: 'CSV' }] }), /unanswered blocking/)
})

test('passos ausentes vêm somente da tentativa atual, inclusive relatos fora de ordem e legado', () => {
  const task = { taskPlan: { steps: ['a', 'b', 'c'] }, attempts: [{ executionSteps: [1, 2, 3] }, { executionSteps: [1, 3] }] }
  assert.deepEqual(missingExecutionSteps(task), [2])
  task.attempts = [{ executionStep: 2 }]
  assert.equal(missingExecutionSteps(task), null)
  task.attempts = [{}]
  assert.equal(missingExecutionSteps(task), null)
  task.attempts = []
  assert.equal(missingExecutionSteps(task), null)
})

test('reordenar fases conserva dependências e identifica execução histórica ou relação invertida', () => {
  assert.equal(phaseOrderChange({ plan: {}, tasks: {} }, { tasks: [] }), null)
  const state = { plan: { phases: [{ id: 'F1' }, { id: 'F2' }] }, tasks: { T1: { id: 'T1', phase: 'F1', state: 'pending' } } }
  const plan = { phases: [{ id: 'F2' }, { id: 'F1' }], tasks: [{ id: 'T1', phase: 'F1' }, { id: 'T2', phase: 'F2', deps: ['T1'] }] }
  assert.deepEqual(phaseOrderChange(state, plan).conflicts, ['T2 <- T1'])
  assert.deepEqual(phaseOrderChange(state, plan).started, [])
  state.tasks.T1.attempts = [{}]
  assert.deepEqual(phaseOrderChange(state, plan).started, ['T1'])
  state.tasks.T1.attempts = []
  state.tasks.T1.state = 'done'
  assert.deepEqual(phaseOrderChange(state, plan).started, ['T1'])
  assert.deepEqual(phaseOrderChange(state, { ...plan, tasks: [{ id: 'T1', deps: ['missing'] }] }).conflicts, [])
  assert.equal(phaseOrderChange(state, { phases: [...state.plan.phases, { id: 'F3' }], tasks: [] }), null)
})
