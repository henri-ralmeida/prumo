import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { discoveryDigest, planningContext, phasePlanningContext } from '../scripts/validation.mjs'
import { plannedManualInspectionState } from './fixtures/planned-manual-inspection.mjs'

const serverFile = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))
const task = (id, fields = {}) => ({ id, title: `Tarefa ${id}`, state: 'pending', phase: 'F1', deps: [],
  attempts: [], validations: [], planningRequired: true, discussionRequired: true, validation: 'Inspecionar', ...fields })
const state = (mode = 'phase') => ({ run: 'workflow', plan: { name: 'Contrato', description: 'Resultado aprovado',
  planningMode: mode, phases: [{ id: 'F1', title: 'Primeira' }] }, tasks: { T1: task('T1') }, phaseWorkflows: {} })
const scope = (s, targets = ['T1']) => JSON.stringify([s.plan.name, s.plan.description, s.plan.planningRevision ?? 0,
  'F1', targets.map(id => [id, phasePlanningContext(s, s.tasks[id])]).sort()])
function discussed(s) {
  const context = scope(s)
  const discovery = { roundId: 'D1', nonce: 'N1', context, closure: 'Contrato confirmado' }
  discovery.digest = discoveryDigest(discovery)
  s.phaseWorkflows.F1 = { id: 'F1', state: 'discussed', discovery, discussionAttempts: [
    { result: 'discussed', targets: ['T1'], roundId: 'D1', nonce: 'N1', discoveryDigest: discovery.digest, context, endedAt: '2026-01-01T00:00:02Z' },
  ] }
  return s
}
function phaseSkip(s, fields = {}) {
  const decision = { decision: 'skipped', confirmedByUser: true, targets: ['T1'], decisionId: 'S1', digest: 'decisão',
    at: '2026-01-01T00:00:03Z', context: scope(s), ...fields }
  s.phaseWorkflows.F1 ??= { id: 'F1', state: 'pending' }
  s.phaseWorkflows.F1.discussionSkips = [decision]
  return s
}

test('API mantém gates de tarefa e fase, catálogo e histórico sem modificar JSON', { timeout: 30000 }, async t => {
  const base = realpathSync(tmpdir()), home = mkdtempSync(join(base, 'prumo-api-workflow-'))
  const central = join(home, 'central'), graph = join(central, 'project', '.specs', 'graph')
  let child, closed, ended = false
  t.after(async () => {
    if (child && !ended) child.kill()
    if (closed) await closed
    assert.equal(dirname(home), base)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  child = spawn(process.execPath, [serverFile, '--global', '--port', '0'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: central, PRUMO_ROOT: '', GRAPH_ROOT: '', PRUMO_LANG: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  closed = new Promise((resolve, reject) => { child.once('close', () => { ended = true; resolve() }); child.once('error', reject) })
  let output = ''
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const deadline = Date.now() + 10000
  while (!/localhost:\d+/.test(output) && !ended && Date.now() < deadline) await setTimeout(20)
  const port = output.match(/localhost:(\d+)/)?.[1]
  assert.ok(port && port !== '0', output)
  const get = async path => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) })
    return { status: response.status, value: await response.json() }
  }
  assert.equal((await get('/api/state')).value.empty, true)
  assert.deepEqual((await get('/api/events')).value, { events: [] })
  assert.equal((await get('/api/events?after=0')).value.reset, false)
  assert.equal((await get('/api/events?after=0&revision=old')).value.reset, true)
  assert.equal((await get('/api/events?after=1')).value.reset, true)
  assert.equal((await get('/api/events?root=missing')).status, 404)
  mkdirSync(join(graph, 'workflow'), { recursive: true })
  const path = join(graph, 'workflow', 'state.json')
  const query = '/api/state?root=project&run=workflow'
  async function inspect(s, effective, planningStatus, inputStatus) {
    const original = JSON.stringify(s)
    writeFileSync(path, original)
    const response = await get(query)
    assert.equal(response.status, 200, JSON.stringify(response.value))
    assert.equal(response.value.derived.T1.effective, effective)
    if (planningStatus) assert.equal(response.value.derived.T1.planningStatus, planningStatus)
    if (inputStatus) assert.equal(response.value.derived.T1.inputStatus, inputStatus)
    assert.equal(readFileSync(path, 'utf8'), original)
    return response.value
  }
  await inspect(state(), 'ready_for_discussion', 'awaiting_phase_plan')
  const noPlanningAttempts = state(); noPlanningAttempts.phaseWorkflows.F1 = { id: 'F1', state: 'planning' }
  await inspect(noPlanningAttempts, 'ready_for_discussion', 'phase_planning')
  await inspect(discussed(state()), 'ready_to_plan')
  await inspect(phaseSkip(state()), 'ready_to_plan')
  const undatedDiscussion = phaseSkip(discussed(state()))
  delete undatedDiscussion.phaseWorkflows.F1.discussionAttempts[0].endedAt
  await inspect(undatedDiscussion, 'ready_to_plan')
  const legacyDeps = state(); legacyDeps.tasks.T2 = task('T2', { state: 'running' })
  delete legacyDeps.tasks.T2.deps
  await inspect(legacyDeps, 'ready_for_discussion')
  for (const decision of [{ decision: 'other' }, { confirmedByUser: false }, { targets: ['missing'] }, { targets: [] }, { context: 'old' }])
    await inspect(phaseSkip(state(), decision), 'ready_for_discussion')
  for (const change of [s => { s.phaseWorkflows.F1.discussionAttempts[0].targets = ['missing'] },
    s => { s.phaseWorkflows.F1.discussionAttempts[0].targets = [] },
    s => { s.phaseWorkflows.F1.discovery.nonce = 'old' },
    s => { s.phaseWorkflows.F1.discovery.digest = 'old' }]) {
    const s = discussed(state()); change(s); await inspect(s, 'ready_for_discussion')
  }
  const planning = discussed(state())
  planning.phaseWorkflows.F1.state = 'planning'
  planning.phaseWorkflows.F1.planningAttempts = [{ targets: ['T1'], discussionRoundId: 'D1', discussionDigest: planning.phaseWorkflows.F1.discovery.digest, context: scope(planning) }]
  await inspect(planning, 'planning', 'phase_planning')
  const skipPlanning = phaseSkip(discussed(state()))
  skipPlanning.phaseWorkflows.F1.state = 'planning'
  skipPlanning.phaseWorkflows.F1.planningAttempts = [{ targets: ['T1'], discussionRoundId: 'S1', discoveryDigest: 'decisão', context: scope(skipPlanning) }]
  await inspect(skipPlanning, 'planning')
  skipPlanning.phaseWorkflows.F1.discussionSkips[0].at = '2026-01-01T00:00:01Z'
  await inspect(skipPlanning, 'ready_to_plan')
  const taskPlan = discussed(state())
  taskPlan.tasks.T1.taskPlan = { phaseId: 'F1' }
  taskPlan.tasks.T1.planningSkips = [{ decision: 'skipped', confirmedByUser: true, scope: phasePlanningContext(taskPlan, taskPlan.tasks.T1) }]
  await inspect(taskPlan, 'ready', 'planning_skipped')
  for (const change of [{ endedAt: '2026-01-01T00:00:04Z' }, { targets: 'T1' }, { targets: ['missing'] }, { discussionDigest: 'old' }, { context: 'old' }]) {
    const s = structuredClone(planning); Object.assign(s.phaseWorkflows.F1.planningAttempts[0], change)
    await inspect(s, 'ready_to_plan')
  }
  const discussing = state(); discussing.phaseWorkflows.F1 = { id: 'F1', state: 'discussing', discussionAttempts: [{ targets: ['T1'] }] }
  await inspect(discussing, 'discussing', 'phase_discussing')
  const blocked = state(); blocked.tasks.T1.deps = ['missing', 'T2']; blocked.tasks.T2 = task('T2', { phase: 'F2' })
  assert.deepEqual((await inspect(blocked, 'waiting')).derived.T1.planningBlockedBy, ['missing', 'F2'])
  const legacy = state(); legacy.tasks.T1.planningRequired = false
  await inspect(legacy, 'ready')
  legacy.tasks.T1.deps = ['missing']; await inspect(legacy, 'waiting')
  const adoption = state(); adoption.legacyPhaseAdoption = true
  await inspect(adoption, 'pending', 'awaiting_phase_adoption')
  const migration = state(); delete migration.plan.planningMode
  await inspect(migration, 'pending', 'awaiting_migration')
  const taskMode = state('task')
  await inspect(taskMode, 'ready_for_discussion')
  taskMode.tasks.T1.discussionSkips = [{ decision: 'skipped', confirmedByUser: true, scope: phasePlanningContext(taskMode, taskMode.tasks.T1) }]
  await inspect(taskMode, 'ready_to_plan')
  taskMode.tasks.T1.discussionSkips[0].confirmedByUser = false
  await inspect(taskMode, 'ready_for_discussion')
  taskMode.tasks.T1.discussionSkips[0].decision = 'other'
  await inspect(taskMode, 'ready_for_discussion')
  const taskDiscussion = state('task'), owner = taskDiscussion.tasks.T1
  const context = planningContext(taskDiscussion, owner)
  owner.discovery = { roundId: 'task-D', nonce: 'task-N', closure: 'Contrato confirmado', context }
  owner.discovery.digest = discoveryDigest(owner.discovery)
  owner.discussionAttempts = [{ result: 'discussed', context, attempt: 1, roundId: 'task-D', nonce: 'task-N', discoveryDigest: owner.discovery.digest }]
  await inspect(taskDiscussion, 'ready_to_plan')
  for (const mutate of [s => { s.tasks.T1.discussionAttempts[0].context = 'old' },
    s => { s.tasks.T1.discussionAttempts[0].attempt = 2 },
    s => { delete s.tasks.T1.discovery },
    s => { s.tasks.T1.discovery.roundId = 'old' },
    s => { s.tasks.T1.discovery.nonce = 'old' },
    s => { s.tasks.T1.discovery.digest = 'old' }]) {
    const changed = structuredClone(taskDiscussion); mutate(changed)
    await inspect(changed, 'ready_for_discussion')
  }
  const returning = structuredClone(taskDiscussion)
  returning.tasks.T1.planningReturn = true
  returning.tasks.T1.discussionAttempts[0].attempt = 0
  returning.tasks.T1.discussionAttempts[0].context = planningContext(returning, returning.tasks.T1)
  await inspect(returning, 'ready_to_plan')
  const taskAdoption = state('task'); taskAdoption.legacyPhaseAdoption = true
  await inspect(taskAdoption, 'pending')
  taskAdoption.tasks.T1.deps = ['missing']; await inspect(taskAdoption, 'waiting')
  const adopted = state(); adopted.legacyPhaseAdoption = true; adopted.phaseWorkflows.F1 = { adoptedLegacy: true }
  await inspect(adopted, 'ready_for_discussion')
  adopted.tasks.T1.taskPlan = { phaseId: 'F1' }
  adopted.tasks.T1.planningSkips = [{ decision: 'skipped', confirmedByUser: true, scope: phasePlanningContext(adopted, adopted.tasks.T1) }]
  await inspect(adopted, 'ready', 'planning_skipped')
  adopted.tasks.T1.deps = ['missing']
  adopted.tasks.T1.planningSkips[0].scope = phasePlanningContext(adopted, adopted.tasks.T1)
  await inspect(adopted, 'waiting', 'planning_skipped')
  const planned = discussed(state())
  planned.tasks.T1.taskPlan = { phaseId: 'F1', approvedByUser: true, context: planningContext(planned, planned.tasks.T1) }
  await inspect(planned, 'ready_to_plan')
  const ready = state('task'); ready.tasks.T1.discussionRequired = false
  await inspect(ready, 'ready_to_plan')
  ready.tasks.T1.planningSkips = [{ decision: 'skipped', confirmedByUser: true, scope: phasePlanningContext(ready, ready.tasks.T1) }]
  await inspect(ready, 'ready')
  const inputs = state(); inputs.tasks.T1.taskPlan = { phaseId: 'F1', unresolvedInputs: [{ task: 'T2' }] }; inputs.tasks.T2 = task('T2', { phase: 'F2' })
  await inspect(inputs, 'ready_for_discussion', null, 'unresolved_later_phase_input')
  inputs.tasks.T2.phase = 'F1'; await inspect(inputs, 'ready_for_discussion', null, 'unresolved_input')
  delete inputs.tasks.T2; await inspect(inputs, 'ready_for_discussion', null, 'unresolved_input')
  inputs.tasks.T2 = task('T2', { state: 'skipped' }); await inspect(inputs, 'ready_for_discussion', null, 'waived_input')
  inputs.tasks.T2.state = 'done'; await inspect(inputs, 'ready_for_discussion', null, 'validated_input')
  assert.equal((await get('/api/state?root=project&run=absent')).status, 404)
  assert.equal((await get('/api/events?root=project&run=workflow')).value.events.length, 0)
  assert.equal((await get('/api/events?root=project&run=workflow&after=0&revision=old')).value.reset, true)
  assert.equal((await get('/api/events?root=project&run=workflow&after=0')).value.reset, false)
  const current = join(graph, 'CURRENT')
  writeFileSync(current, 'missing'); assert.ok((await get('/api/runs')).value.warnings.some(value => value.includes('without state')))
  writeFileSync(current, '../bad'); assert.ok((await get('/api/runs')).value.warnings.some(value => value.includes('invalid CURRENT')))
  writeFileSync(current, 'workflow'); assert.equal((await get('/api/runs')).value.current, 'workflow')
  const prototypeId = state()
  Object.defineProperty(prototypeId.tasks, '__proto__', { value: task('__proto__', { planningRequired: false }), enumerable: true })
  const prototypeResponse = await inspect(prototypeId, 'ready_for_discussion')
  assert.ok(Object.hasOwn(prototypeResponse.derived, '__proto__'), 'a API preserva identificadores válidos sem alterar o protótipo')
  assert.equal(prototypeResponse.derived.__proto__.effective, 'ready')
  const inheritedInput = state()
  inheritedInput.tasks.T1.taskPlan = { phaseId: 'F1', unresolvedInputs: [{ task: 'constructor' }] }
  await inspect(inheritedInput, 'ready_for_discussion', null, 'unresolved_input')
  mkdirSync(join(graph, 'without-state'))
  mkdirSync(join(central, 'no-current', '.specs', 'graph', 'legacy'), { recursive: true })
  writeFileSync(join(central, 'no-current', '.specs', 'graph', 'legacy', 'state.json'), JSON.stringify({ unknown: 'preservado' }))
  assert.ok((await get('/api/runs')).value.runs.some(run => run.run === 'legacy' && run.plan === '' && run.taskCount === 0))
  const missingRoute = await fetch(`http://127.0.0.1:${port}/missing`, { signal: AbortSignal.timeout(5000) })
  assert.equal(missingRoute.status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/index.html`, { signal: AbortSignal.timeout(5000) })).status, 200)
  writeFileSync(path, '{'); assert.equal((await get(query)).status, 500)
  assert.ok((await get('/api/runs')).value.warnings.some(value => value.includes('invalid CURRENT')))
  assert.equal((await get('/api/health')).value.readOnly, true)
  const inspection = plannedManualInspectionState()
  const inspectionBytes = JSON.stringify(inspection)
  writeFileSync(path, inspectionBytes)
  const response = await get(query)
  assert.equal(response.status, 200, JSON.stringify(response.value))
  assert.equal(response.value.tasks.T7a.state, 'pending')
  assert.equal(response.value.tasks.T7a.attempts.length, 0)
  assert.equal(response.value.derived.T7a.effective, 'ready')
  assert.equal(readFileSync(path, 'utf8'), inspectionBytes, 'o dashboard preserva histórico, inspeção e revisão')
})
