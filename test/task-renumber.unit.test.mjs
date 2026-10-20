import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTaskMapping, renumberTasks, eventLogPath, renumberEventHistory } from '../scripts/task-renumber.mjs'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { phasePlanningContext, planningContext, taskPlanDigest, discoveryDigest } from '../scripts/validation.mjs'

function fixture() {
  const state = { plan: { name: 'Entrega', description: '', requireReview: true, phases: [{ id: 'F1' }] },
    tasks: {}, phaseWorkflows: { F1: { state: 'pending', discussionAttempts: [], planningAttempts: [] } } }
  for (const id of ['T1', 'T2', 'T3']) state.tasks[id] = { id, title: id + ' conteúdo original', phase: 'F1', deps: [], state: 'pending',
    planningRequired: false, attempts: [], validations: [], notes: [{ text: 'T1=T2 é texto histórico' }] }
  state.tasks.T2.deps = ['T1']
  state.tasks.T3.deps = ['T2']
  return { state, plan: { ...state.plan, tasks: Object.values(state.tasks) } }
}

test('mapa aceita ciclos e recusa entradas ambíguas antes de alterar tarefas', () => {
  assert.deepEqual(parseTaskMapping('T1=T2, T2=T1'), { T1: 'T2', T2: 'T1' })
  for (const value of [undefined, '', 'T1=T1', 'T1=T2,T1=T3', 'T1=T2,', 'T01=T2', 'T1=../../x'])
    assert.throws(() => parseTaskMapping(value))
})

test('permutações preservam conteúdo e transformam somente referências, perguntas e autorizações', () => {
  const { state, plan } = fixture()
  state.tasks.T1.state = 'done'
  state.tasks.T1.attempts = [{ endedAt: '1', result: 'failed' }, { endedAt: '2', result: 'failed' }, { endedAt: '3', result: 'done' }]
  state.tasks.T2.question = { questionRef: 'T2:plan:abc', resolvesQuestion: 'T1:plan:xyz', ref: 'sem-prefixo' }
  state.tasks.T2.taskPlan = { unresolvedInputs: [{ task: 'T1', phase: 'F1', requiredEvidence: 'Recibo de T1' }] }
  state.tasks.T2.authorization = { scope: 'tasks:T1,T2', taskIds: ['T1', 'T2'] }
  state.phaseWorkflows.F1.planningAttempts = [{ targets: ['T1', 'T2'], workers: { T1: { endedAt: '1' } }, assignments: { T1: 'agente' },
    requiredInputs: { T2: [{ task: 'T1' }] }, endedAt: '3' }]
  state.taskIdAliases = { antigo: 'T1', T2: 'T1' }
  state.nullValue = null
  state.value = false
  const before = JSON.stringify({ state, plan })
  const result = renumberTasks(state, plan, { T1: 'T2', T2: 'T1' })
  assert.equal(JSON.stringify({ state, plan }), before)
  assert.deepEqual(result.state.tasks.T2.attempts, state.tasks.T1.attempts)
  assert.equal(result.state.tasks.T2.state, 'done')
  assert.equal(result.state.tasks.T2.title, 'T1 conteúdo original')
  assert.equal(result.state.tasks.T2.previousTaskId, 'T1')
  assert.deepEqual(result.state.tasks.T1.deps, ['T2'])
  assert.deepEqual(result.state.tasks.T3.deps, ['T1'])
  assert.deepEqual(result.state.tasks.T1.authorization, { scope: 'tasks:T2,T1', taskIds: ['T2', 'T1'] })
  assert.deepEqual(result.state.tasks.T1.question, { questionRef: 'T1:plan:abc', resolvesQuestion: 'T2:plan:xyz', ref: 'sem-prefixo' })
  assert.equal(result.state.tasks.T1.taskPlan.unresolvedInputs[0].task, 'T2')
  assert.deepEqual(result.state.taskIdAliases, { antigo: 'T2' })
  assert.ok(result.state.phaseWorkflows.F1.planningAttempts[0].workers.T2)
  assert.deepEqual(result.state.phaseWorkflows.F1.planningAttempts[0].assignments, { T2: 'agente' })
  assert.equal(result.state.phaseWorkflows.F1.planningAttempts[0].requiredInputs.T1[0].task, 'T2')
  assert.equal(result.plan.tasks[0].id, 'T2')
  assert.deepEqual(result.state.tasks.T2.notes, state.tasks.T1.notes)
  assert.deepEqual(renumberTasks(state, plan, { T1: 'T4' }).state.taskIdAliases, { antigo: 'T4', T1: 'T4' })
})

test('vínculos atuais mudam com as referências e evidência inválida permanece inválida', () => {
  const { state, plan } = fixture()
  const discovery = { coverage: {}, questions: [{ confirmsContract: [{ task: 'T1', digest: phasePlanningContext(state, state.tasks.T1) }] }],
    executionBoundary: { deferredToExecutor: ['T1'] } }
  discovery.digest = discoveryDigest(discovery)
  state.phaseWorkflows.F1.discovery = discovery
  const round = { endedAt: '1', discoveryArtifact: 'discoveries/antigo.json' }
  Object.defineProperty(round, 'discovery', { value: discovery })
  state.phaseWorkflows.F1.discussionAttempts.push(round)
  const taskPlan = { research: [], steps: ['Executar'], unresolvedInputs: [{ task: 'T1' }],
    openQuestions: [{ questionRef: 'T2:plan:ref', decideBy: { beforeTask: 'T3' } }],
    scope: phasePlanningContext(state, state.tasks.T2), context: planningContext(state, state.tasks.T2) }
  taskPlan.digest = taskPlanDigest(taskPlan)
  state.tasks.T2.taskPlan = taskPlan
  state.tasks.T3.taskPlan = { research: [], steps: [], digest: 'corrompido', scope: 'obsoleto' }
  state.phaseWorkflows.F1.context = JSON.stringify([state.plan.name, '', 0, 'F1', [['T1', phasePlanningContext(state, state.tasks.T1)]]])
  state.phaseWorkflows.F1.originalContext = JSON.stringify([state.plan.name, '', 0, 'F1', [['T1', 'hash-obsoleto']]])
  const result = renumberTasks(state, plan, { T1: 'T2', T2: 'T1' })
  const nextPlan = result.state.tasks.T1.taskPlan
  assert.equal(nextPlan.digest, taskPlanDigest(nextPlan))
  assert.notEqual(nextPlan.digest, taskPlan.digest)
  assert.equal(nextPlan.scope, phasePlanningContext(result.state, result.state.tasks.T1))
  assert.equal(nextPlan.context, planningContext(result.state, result.state.tasks.T1))
  assert.equal(result.state.phaseWorkflows.F1.discovery.digest, discoveryDigest(result.state.phaseWorkflows.F1.discovery))
  assert.equal(result.state.phaseWorkflows.F1.discussionAttempts[0].discoveryArtifact, undefined)
  assert.ok(result.state.phaseWorkflows.F1.discussionAttempts[0].discovery)
  assert.equal(result.state.tasks.T3.taskPlan.digest, 'corrompido')
  assert.equal(result.state.tasks.T3.taskPlan.scope, 'obsoleto')
  assert.equal(JSON.parse(result.state.phaseWorkflows.F1.context)[4][0][0], 'T2')
  assert.equal(JSON.parse(result.state.phaseWorkflows.F1.originalContext)[4][0][1], 'hash-obsoleto')
})

test('migração recusa colisões, planos divergentes e qualquer trabalho em aberto', () => {
  for (const mapping of [{ ausente: 'T4' }, { T1: 'T2' }, { T1: 'T0' }]) {
    const { state, plan } = fixture()
    assert.throws(() => renumberTasks(state, plan, mapping))
  }
  for (const fields of [{ state: 'running' }, { attempts: [{}] }, { discussionAttempts: [{}] }, { planningAttempts: [{}] }]) {
    const { state, plan } = fixture()
    Object.assign(state.tasks.T1, fields)
    assert.throws(() => renumberTasks(state, plan, { T1: 'T4' }))
  }
  const { state, plan } = fixture()
  assert.throws(() => renumberTasks(state, { ...plan, tasks: [] }, { T1: 'T4' }))
  delete state.phaseWorkflows
  assert.ok(renumberTasks(state, plan, { T1: 'T4' }).state.tasks.T4)
  state.removedTasks = { T4: { id: 'T4' } }
  assert.throws(() => renumberTasks(state, plan, { T1: 'T4' }), /removido/)
  state.phaseWorkflows = { F1: { discussionAttempts: [{ endedAt: '1', discoveryArtifact: 'discoveries/ausente.json' }] } }
  assert.throws(() => renumberTasks(state, plan, { T1: 'T5' }), /arquivada.*indisponível/)
  state.phaseWorkflows.F1.discussionAttempts[0].discoveries = []
  assert.ok(renumberTasks(state, plan, { T1: 'T5' }).state.tasks.T5)
})

test('histórico remapeia referências e diferenças contratuais sem reescrever texto e origem', () => {
  const events = [{ task: 'T1', changes: [{ field: 'deps', before: ['T1'], after: ['T2'] }, { field: 'title', before: 'T1', after: 'T2' }] },
    { task: 'T1', originalTask: 'antigo', value: null }, { task: 'T3', number: 2, text: 'T1' }]
  const result = renumberEventHistory(events, { T1: 'T2', T2: 'T1' })
  assert.deepEqual(result[0], { task: 'T2', originalTask: 'T1', changes: [
    { field: 'deps', before: ['T2'], after: ['T1'] }, { field: 'title', before: 'T1', after: 'T2' }] })
  assert.equal(result[1].originalTask, 'antigo')
  assert.deepEqual(result[2], events[2])
  assert.equal(events[0].task, 'T1')
})

test('histórico versionado recusa caminhos externos e links e preserva o caminho legado', t => {
  const directory = mkdtempSync(join(tmpdir(), 'prumo-event-log-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  assert.equal(eventLogPath(directory, {}), join(directory, 'events.ndjson'))
  assert.throws(() => eventLogPath(directory, { eventLog: '../events.ndjson' }))
  const eventLog = 'task-id-backups/00000000-0000-0000-0000-000000000000/events.ndjson'
  assert.equal(eventLogPath(directory, { eventLog }), join(directory, eventLog))
  const target = join(directory, 'target'); mkdirSync(target)
  symlinkSync(target, join(directory, 'task-id-backups'), 'junction')
  assert.throws(() => eventLogPath(directory, { eventLog }), /ligados/)
})
