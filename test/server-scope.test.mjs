import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { executionReadiness, planQuestionRef, openQuestionRecords, questionResolutionMap, taskHasStarted, phaseWorkflowHasStarted, targetHasStarted, overdueQuestions, questionIsOverdue, occupancy, isExternalBlock } from '../scripts/execution-readiness.mjs'

const task = (id, fields = {}) => ({ id, title: id, state: 'pending', deps: [], attempts: [], discussionAttempts: [], planningAttempts: [], planningHistory: [], planningSkips: [], discussionSkips: [], touches: [], ...fields })
const base = () => ({ run: 'scope', plan: { name: 'Escopo', planningMode: 'task', scopePolicy: 'explicit' }, tasks: { T1: task('T1', { writeScope: 'files', touches: ['src'] }) } })

test('ocupação distingue agente de discussão do executor e não conta fila nem rodada encerrada', () => {
  const state = base()
  state.tasks.T1 = task('T1', { state: 'discussing', agent: 'executor-original', discussionAttempts: [{ agent: 'discutidor' }] })
  state.tasks.T2 = task('T2')
  state.phaseWorkflows = { F1: { id: 'F1', state: 'planning', planningAttempts: [{ workers: {
    T2: { agent: 'planejador', endedAt: 'encerrado' },
  }, queuedTargets: ['T2'] }] } }
  assert.deepEqual(occupancy(state).busy.map(value => value.agent), ['discutidor'])
  assert.equal(state.tasks.T1.agent, 'executor-original')
  state.phaseWorkflows.F1.planningAttempts[0].endedAt = 'encerrado'
  assert.equal(occupancy(state).busy.length, 1)
  state.tasks.T1.discussionAttempts = []
  assert.equal(occupancy(state).discussers[0].agent, 'executor-original')
  state.phaseWorkflows.F2 = { id: 'F2', state: 'planning', planner: 'planejador-legado', planningAttempts: [{}] }
  assert.equal(occupancy(state).phasePlanners[0].agent, 'planejador-legado')
  assert.equal(isExternalBlock(undefined), false)
  assert.equal(isExternalBlock({ state: 'blocked' }), true)
  assert.equal(isExternalBlock({ state: 'blocked', blockKind: 'replan' }), false)
})

test('fila não inicia prazo de tarefa e bloquear um trabalhador não apaga o início registrado', () => {
  const state = base()
  state.plan.planningMode = 'phase'
  state.tasks.T1.phase = 'F1'
  state.tasks.T2 = task('T2', { phase: 'F1' })
  state.phaseWorkflows = { F1: { planningAttempts: [{ targets: ['T2'], originalTargets: ['T1', 'T2'], workers: {
    T1: { agent: 'planejador', endedAt: 'bloqueado' },
  }, queuedTargets: ['T2'] }] } }
  assert.equal(targetHasStarted(state, { beforeTask: 'T2' }), false)
  assert.equal(targetHasStarted(state, { beforeTask: 'T1' }), true)
  assert.equal(targetHasStarted(state, { beforePhase: 'F1' }), true)
  delete state.phaseWorkflows.F1.planningAttempts[0].workers
  assert.equal(targetHasStarted(state, { beforeTask: 'T1' }), true)
})

test('API real expõe prontidão compartilhada sem modificar o contrato persistido', { timeout: 60000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-server-scope-')), root = join(home, 'root'), graph = join(root, '.specs/graph')
  mkdirSync(join(graph, 'scope'), { recursive: true }); writeFileSync(join(graph, 'CURRENT'), 'scope')
  const path = join(graph, 'scope/state.json'); writeFileSync(path, JSON.stringify(base()))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url)), '--port', '0'], {
    env: { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: 'en' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const deadline = Date.now() + 30000
  while (!/localhost:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await setTimeout(40)
  const port = output.match(/localhost:(\d+)/)?.[1]; assert.ok(port, output)
  const check = async (state, expected) => {
    const before = JSON.stringify(state); writeFileSync(path, before)
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200)
    const body = await response.json(), readiness = body.derived.T1.executionReadiness
    assert.deepEqual(readiness.reasons.map(reason => reason.code).sort(), expected.sort())
    assert.equal(readiness.ready, !expected.length)
    assert.deepEqual(readiness, executionReadiness(state, state.tasks.T1, body.derived.T1))
    assert.equal(readFileSync(path, 'utf8'), before)
    assert.equal(body.tasks.T1.executionReadiness, undefined)
    return body
  }
  await check(base(), [])
  let state = base(); delete state.plan.scopePolicy; delete state.tasks.T1.writeScope; await check(state, [])
  state.tasks.T1.planningRequired = false; delete state.plan.planningMode; await check(state, [])
  state = base(); state.tasks.T1.writeScope = 'unknown'; state.tasks.T1.touches = []; await check(state, ['scope_unknown'])
  state = base(); state.tasks.T1.deps = ['T2']; state.tasks.T2 = task('T2'); await check(state, ['dependencies'])
  state = base(); state.tasks.T1.planningRequired = true; state.tasks.T1.discussionRequired = true; await check(state, ['planning', 'discussion'])
  state.tasks.T1.discussionRequired = false; await check(state, ['planning'])
  state = base(); state.plan.maxAgents = 1; state.tasks.T2 = task('T2', { state: 'running', touches: ['src/file'], sharedResources: [{ id: 'db', access: 'write' }] }); state.tasks.T1.sharedResources = [{ id: 'db', access: 'read' }]
  const conflict = await check(state, ['capacity', 'path_conflict', 'shared_resource_conflict'])
  assert.deepEqual(conflict.derived.T1.executionReadiness.reasons.find(reason => reason.code === 'shared_resource_conflict').resources, ['db'])
  state = base(); state.authorizations = [{ id: 'recorded' }]; await check(state, ['authorization'])
  state.tasks.T1.executionAuthorization = { mode: 'manual' }; await check(state, ['manual_confirmation'])
  state.tasks.T1.executionAuthorization.mode = 'auto'; await check(state, [])
  state = base(); state.tasks.T2 = task('T2', { executionAuthorization: { mode: 'auto' } }); await check(state, ['authorization'])
  delete state.tasks.T2.executionAuthorization; state.tasks.T2.authorizationHistory = [{}]; await check(state, ['authorization'])
  state = base(); state.tasks.T1.taskPlan = { openQuestions: [{ question: 'Escolha pendente', decideBy: 'user-now' }] }; await check(state, ['questions'])
  state.tasks.T1.taskPlan.openQuestions[0].answer = 'Respondida'; await check(state, [])
})

test('prontidão considera ocupação por planejador de fase e estado ativo', () => {
  const state = base(); delete state.tasks.T1.writeScope
  state.plan.maxAgents = 1; state.phaseWorkflows = { F1: { id: 'F1', state: 'planning' } }
  assert.deepEqual(executionReadiness(state, state.tasks.T1, { effective: 'ready', blockedBy: [] }).reasons.map(reason => reason.code), ['scope_unknown', 'capacity'])
  state.tasks.T1.state = 'reviewing'; state.tasks.T1.authorizationHistory = [{}]
  assert.ok(executionReadiness(state, state.tasks.T1, { effective: 'reviewing', blockedBy: [] }).reasons.some(reason => reason.code === 'state'))
})

test('perguntas usam prazos e resoluções existentes sem antecipar decisões futuras', () => {
  const state = base(), owner = state.tasks.T1
  assert.equal(taskHasStarted(state, undefined), false)
  assert.equal(taskHasStarted(state, owner), false)
  assert.equal(phaseWorkflowHasStarted(state, 'missing'), false)
  assert.equal(targetHasStarted(state, null), false)
  assert.equal(targetHasStarted(state, 'executor'), false)
  assert.equal(targetHasStarted(state, { beforeTask: 'missing' }), false)
  assert.equal(targetHasStarted(state, { beforePhase: 'missing' }), false)
  assert.equal(questionIsOverdue(state, { decideBy: 'executor' }), false)
  owner.taskPlan = { startedAt: 'now', openQuestions: [null, { question: 1 }, { question: 'Agora', blocking: true }, { question: 'Depois', decideBy: 'executor' }] }
  const records = openQuestionRecords(state); assert.equal(records.length, 2)
  assert.equal(overdueQuestions(state, 'T1').length, 1)
  assert.equal(overdueQuestions(state, 'T2').length, 0)
  assert.equal(overdueQuestions(state).length, 1)
  assert.ok(planQuestionRef(owner, undefined, 0).startsWith('T1:plan:'))
  owner.taskPlan.openQuestions[2].questionRef = 'known'; assert.equal(planQuestionRef(owner, owner.taskPlan, 2), 'known')
  state.questionResolutions = [{}, { questionRef: 'known' }]; assert.equal(overdueQuestions(state).length, 0)
  owner.taskPlan.decisions = [{ resolvesQuestion: 'plan', answer: 'Sim' }, null]
  owner.discovery = { decisions: [{ resolvesQuestion: 'discovery' }] }
  owner.planningHistory = [{}, { decisions: [{ resolvesQuestion: 'history' }] }]
  owner.discussionAttempts = [{}, { discovery: { decisions: [{ resolvesQuestion: 'discussion' }] } }]
  state.phaseWorkflows = { F1: { id: 'F1', discovery: { decisions: [{ resolvesQuestion: 'phase' }, {}] }, discussionAttempts: [{}, { discovery: { decisions: [{ resolvesQuestion: 'phase-round' }] } }] } }
  assert.equal(questionResolutionMap(state).size, 7)
  assert.equal(taskHasStarted(state, owner), true)
  owner.phase = 'F1'; state.plan.planningMode = 'phase'
  state.tasks.T2 = task('T2', { phase: 'F1' }); state.phaseWorkflows.F1.planningAttempts = [{ targets: ['T2'], contextTargets: ['T1'] }]
  assert.equal(phaseWorkflowHasStarted(state, 'F1', 'T2'), true)
  assert.equal(phaseWorkflowHasStarted(state, 'F1', 'missing'), false)
  assert.equal(targetHasStarted(state, { beforeTask: 'T2' }), true)
  assert.equal(targetHasStarted(state, { beforeTask: 'T1' }), true)
  assert.equal(targetHasStarted(state, { beforePhase: 'F1' }), true)
  owner.taskPlan.openQuestions = [{ question: 'Antes da tarefa', decideBy: { beforeTask: 'T2' } }, { question: 'Antes da fase', decideBy: { beforePhase: 'F1' } }, { question: 'Outro alvo', decideBy: { beforeTask: 'missing' } }, { question: 'Prazo inválido', decideBy: {} }]
  assert.equal(overdueQuestions(state, 'T2', 'F1').length, 2)
  assert.equal(overdueQuestions(state, 'unrelated', 'unrelated').length, 0)
  state.tasks.T3 = task('T3', { state: 'running' })
  assert.equal(overdueQuestions(state, 'T2', 'F1').length, 2)
  assert.equal(targetHasStarted(state, { beforePhase: 'F2' }), false)
  state.tasks.T3.phase = 'F2'; assert.equal(targetHasStarted(state, { beforePhase: 'F2' }), true)
  state.tasks.T4 = { id: 'T4', taskPlan: {} }; assert.equal(openQuestionRecords(state).length, 4)
  state.tasks.T5 = { id: 'T5', taskPlan: { openQuestions: [{ question: 'Legado sem prazo' }] } }
  assert.equal(openQuestionRecords(state).at(-1).decideBy, 'executor')
  assert.equal(taskHasStarted(state, {}), false)
  for (const field of ['discussionAttempts', 'planningAttempts', 'discussionSkips', 'planningSkips', 'attempts']) assert.equal(taskHasStarted(state, { [field]: [{}] }), true)
  state.phaseWorkflows.F2 = { id: 'F2' }
  assert.equal(phaseWorkflowHasStarted(state, 'F2'), false)
  state.phaseWorkflows.F2.planningAttempts = [{}, { contextTargets: ['T5'] }]
  assert.equal(phaseWorkflowHasStarted(state, 'F2', 'T5'), true)
  state.phaseWorkflows.F2.discussionSkips = [{ targets: ['T4'] }]; state.phaseWorkflows.F2.planningSkips = [{ targets: ['T3'] }]
  assert.equal(phaseWorkflowHasStarted(state, 'F2', 'T3'), true)
  assert.equal(phaseWorkflowHasStarted(state, 'F2', 'T4'), true)
  assert.equal(questionResolutionMap(state).size, 7)
})
