import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/engine.mjs')
const validation = [{ kind: 'functional', run: 'node check.cjs', expect: 'delivery behavior passes' }]

function fixture(t, dependent = false) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-corrective-retry-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'workspace'), project = join(home, 'project')
  mkdirSync(root); mkdirSync(project)
  writeFileSync(join(project, 'check.cjs'), "require('node:assert/strict').equal(1, 1)\n")
  const planPath = join(root, 'plan.json')
  writeFileSync(planPath, JSON.stringify({ name: 'Corrective retry', tasks: [
    ...(dependent ? [{ id: 'T0', title: 'Dependency', validation }] : []),
    { id: 'T1', title: 'Delivery', deps: dependent ? ['T0'] : [], validation },
  ] }))
  const discovery = {
    research: [{ source: 'delivery', findings: 'Current behavior inspected.' }],
    questions: [{ question: 'Preserve the contract?', answer: 'Yes.', channel: 'chat-fallback', round: 1 }],
    coverage: { problem: 'Incorrect delivery.', affected: 'Users.', outcome: 'Correct delivery.', currentBehavior: 'Reviewed.',
      desiredBehavior: 'Approved behavior.', rules: 'Keep contract.', exceptions: 'None.', scope: 'T1.', acceptance: 'Check passes.' },
    decisions: [], deferred: [], closure: 'No gray area remains.',
  }
  const discoveryPath = join(root, 'discovery.json'), taskPlanPath = join(root, 'task-plan.json')
  writeFileSync(taskPlanPath, JSON.stringify({ research: [{ source: 'delivery', findings: 'Implementation inspected.' }], decisions: [],
    steps: ['Correct the implementation and run its check.'], verification: [{ criterion: 'delivery behavior passes', check: 1 }], openQuestions: [] }))
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: 'en' }
  const cli = (...args) => spawnSync(process.execPath, [engine, ...args], { cwd: project, env, encoding: 'utf8', windowsHide: true })
  const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.stdout + result.stderr); return result }
  const rejects = (pattern, ...args) => { const result = cli(...args); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, pattern) }
  ok('init', '--plan', planPath, '--run', 'retry')
  if (dependent) ok('skip', 'T0', '--reason', 'Dependency explicitly waived')
  ok('begin-discussion', 'T1')
  const round = JSON.parse(readFileSync(join(root, '.specs/graph/retry/state.json'), 'utf8')).tasks.T1.discussionAttempts.at(-1)
  discovery.roundId = round.roundId
  discovery.nonce = round.nonce
  discovery.questions = discovery.questions.map(question => ({ ...question, roundId: round.roundId }))
  writeFileSync(discoveryPath, JSON.stringify(discovery))
  ok('finish-discussion', 'T1', '--context', discoveryPath)
  ok('plan-task', 'T1', '--agent', 'planner')
  ok('finish-planning', 'T1', '--plan', taskPlanPath)
  const statePath = join(root, '.specs/graph/retry/state.json')
  return { project, planPath, ok, rejects, state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    save: state => writeFileSync(statePath, JSON.stringify(state)) }
}

test('bounded reviewer correction reuses the immutable approved plan and reason', t => {
  const f = fixture(t)
  const planned = structuredClone(f.state().tasks.T1.taskPlan)
  f.ok('start', 'T1', '--agent', 'executor-1')
  f.ok('review', 'T1', '--agent', 'reviewer-1')
  f.ok('fail', 'T1', '--reason', 'The normal-delivery branch still returns the wrong value')
  const failed = structuredClone(f.state().tasks.T1)
  f.ok('retry', 'T1')
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.T1.effective, 'ready')
  assert.deepEqual(f.state().tasks.T1.taskPlan, planned)
  assert.deepEqual(f.state().tasks.T1.planningHistory, failed.planningHistory)
  f.ok('start', 'T1', '--agent', 'executor-2')
  const running = f.state().tasks.T1
  assert.equal(running.attempts.length, 2)
  assert.equal(running.attempts[1].planSourceAttempt, 1)
  assert.equal(running.attempts[1].correctionOf, 1)
  assert.equal(running.attempts[1].correctionReason, failed.attempts[0].reason)
  f.rejects(/independent reviewer/, 'validate', 'T1', '--ok', '--evidence', 'self check', '--cwd', f.project)
  f.ok('review', 'T1', '--agent', 'reviewer-2')
  f.ok('validate', 'T1', '--ok', '--evidence', 'reviewed correction', '--cwd', f.project)
  f.ok('done', 'T1')
})

test('retry requires new planning when the validation contract changes after failure', t => {
  const f = fixture(t)
  f.ok('start', 'T1', '--agent', 'executor-1')
  f.ok('review', 'T1', '--agent', 'reviewer-1')
  f.ok('fail', 'T1', '--reason', 'The bounded implementation still fails review')
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.tasks[0].validation[0].expect = 'updated delivery behavior passes'
  writeFileSync(f.planPath, JSON.stringify(approved))
  f.ok('refresh-contract', 'T1', '--plan', f.planPath)
  f.ok('retry', 'T1')
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.T1.effective, 'ready_for_discussion')
  assert.equal(f.state().tasks.T1.retryPlan, undefined)
  f.rejects(/completed current planning/, 'start', 'T1', '--agent', 'executor-2')
})

test('retry binding rejects a contract revision change with the same checks', t => {
  const f = fixture(t)
  f.ok('start', 'T1', '--agent', 'executor-1')
  f.ok('review', 'T1', '--agent', 'reviewer-1')
  f.ok('fail', 'T1', '--reason', 'The bounded implementation still fails review')
  f.ok('retry', 'T1')
  const state = f.state()
  state.tasks.T1.contractRevision = (state.tasks.T1.contractRevision ?? 0) + 1
  f.save(state)
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.T1.effective, 'ready_for_discussion')
  f.rejects(/completed current planning/, 'start', 'T1', '--agent', 'executor-2')
})

test('successive retries preserve plan origin and correct the immediate failed attempt', t => {
  const f = fixture(t)
  const planned = structuredClone(f.state().tasks.T1.taskPlan)
  const history = structuredClone(f.state().tasks.T1.planningHistory)
  f.ok('start', 'T1', '--agent', 'executor-1')
  f.ok('review', 'T1', '--agent', 'reviewer-1')
  f.ok('fail', 'T1', '--reason', 'First reviewed defect')
  f.ok('retry', 'T1')
  f.ok('start', 'T1', '--agent', 'executor-2')
  f.ok('review', 'T1', '--agent', 'reviewer-2')
  f.ok('fail', 'T1', '--reason', 'Second reviewed defect')
  f.ok('retry', 'T1')
  const retry = f.state().tasks.T1.retryPlan
  assert.equal(retry.planSourceAttempt, 1)
  assert.equal(retry.failedAttempt, 2)
  f.ok('start', 'T1', '--agent', 'executor-3')
  const task = f.state().tasks.T1
  assert.equal(task.attempts[2].planSourceAttempt, 1)
  assert.equal(task.attempts[2].correctionOf, 2)
  assert.equal(task.attempts[2].correctionReason, 'Second reviewed defect')
  assert.deepEqual(task.taskPlan, planned)
  assert.deepEqual(task.planningHistory, history)
})

test('plan defects and missing reviewer reasons force a new planning round', t => {
  for (const failure of [
    ['--reason', 'The approved execution steps omit a required branch', '--plan-defect'],
    [],
  ]) {
    const f = fixture(t)
    f.ok('start', 'T1', '--agent', 'executor')
    f.ok('review', 'T1', '--agent', 'reviewer')
    f.ok('fail', 'T1', ...failure)
    f.ok('retry', 'T1')
    assert.equal(JSON.parse(f.ok('graph').stdout).derived.T1.effective, 'ready_for_discussion')
    f.rejects(/completed current planning/, 'start', 'T1', '--agent', 'executor-2')
  }
})

test('material discovery, task scope and dependency changes invalidate a retry binding', t => {
  for (const [dependent, mutate] of [
    [false, state => state.tasks.T1.discovery.decisions.push({ question: 'New scope?', answer: 'Yes.' })],
    [false, state => { state.tasks.T1.title = 'Materially changed delivery' }],
    [true, state => { state.tasks.T0.skipReason = 'Changed dependency outcome' }],
  ]) {
    const f = fixture(t, dependent)
    f.ok('start', 'T1', '--agent', 'executor')
    f.ok('review', 'T1', '--agent', 'reviewer')
    f.ok('fail', 'T1', '--reason', 'Correct the bounded implementation defect')
    f.ok('retry', 'T1')
    const state = f.state()
    mutate(state)
    f.save(state)
    assert.equal(JSON.parse(f.ok('graph').stdout).derived.T1.effective, 'ready_for_discussion')
    f.rejects(/completed current planning/, 'start', 'T1', '--agent', 'executor-2')
  }
})

function phaseFixture(t, tasks, { planningMode = 'phase' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-phase-negative-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'workspace'), project = join(home, 'project'), plans = join(root, 'plans')
  mkdirSync(root); mkdirSync(project); mkdirSync(plans)
  writeFileSync(join(project, 'check.cjs'), "require('node:assert/strict').equal(1, 1)\n")
  const planPath = join(root, 'plan.json')
  const plan = { name: 'Phase negative cases', planningMode,
    phases: [{ id: 'F1', title: 'First' }, { id: 'F2', title: 'Second' }],
    tasks: tasks.map(task => ({ validation, ...task })) }
  writeFileSync(planPath, JSON.stringify(plan))
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: 'en' }
  const cli = (...args) => spawnSync(process.execPath, [engine, ...args], { cwd: project, env, encoding: 'utf8', windowsHide: true })
  const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.stdout + result.stderr); return result }
  const rejects = (pattern, ...args) => { const result = cli(...args); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, pattern); return result }
  const statePath = join(root, '.specs/graph/phase-negative/state.json')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const save = value => writeFileSync(statePath, JSON.stringify(value))
  const events = () => readFileSync(join(root, '.specs/graph/phase-negative/events.ndjson'), 'utf8')
  const discovery = phaseId => {
    const round = state().phaseWorkflows[phaseId].discussionAttempts.at(-1)
    const value = { research: [{ source: 'fixture', findings: 'Current phase contracts inspected.' }],
      questions: [{ question: 'Keep the approved phase behavior?', answer: 'Yes.', channel: 'chat-fallback', round: 1, roundId: round.roundId }],
      coverage: { problem: 'A phase needs planning.', affected: 'Graph users.', outcome: 'Stable phase plans.', currentBehavior: 'Inspected.',
        desiredBehavior: 'Approved.', rules: 'Keep task bindings.', exceptions: 'None.', scope: phaseId, acceptance: 'Current receipts only.' },
      decisions: [], deferred: [], closure: 'No gray area remains.', roundId: round.roundId, nonce: round.nonce }
    const path = join(root, `discovery-${phaseId}.json`); writeFileSync(path, JSON.stringify(value)); return path
  }
  const writeArtifacts = phaseId => {
    const current = state(), round = current.phaseWorkflows[phaseId].planningAttempts.at(-1)
    const binding = { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n }
    for (const id of round.targets) writeFileSync(join(plans, `task-plan-${id}.json`), JSON.stringify({
      research: [{ source: 'fixture', findings: `${id} inspected.` }], decisions: [], steps: [`Deliver ${id}.`],
      verification: [{ criterion: 'delivery behavior passes', check: 1 }], openQuestions: [], phaseBinding: binding,
      unresolvedInputs: round.requiredInputs[id],
    }))
  }
  ok('init', '--plan', planPath, '--run', 'phase-negative')
  return { root, project, plans, plan, planPath, ok, rejects, state, save, events, discovery, writeArtifacts }
}

test('legacy runs migrate into phase planning without opening work or changing terminal tasks', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'Completed legacy task' },
    { id: 'B', phase: 'F2', title: 'Pending legacy task' },
  ])
  const legacy = f.state()
  legacy.tasks.A.state = 'done'
  const completed = structuredClone(legacy.tasks.A)
  delete legacy.schemaVersion
  delete legacy.plan.planningMode
  delete legacy.phaseWorkflows
  for (const field of ['discussionRequired', 'discoveryRequired', 'planningRequired', 'discussionAttempts', 'planningAttempts', 'planningHistory']) delete legacy.tasks.B[field]
  f.save(legacy)
  const statePath = join(f.root, '.specs/graph/phase-negative/state.json')
  const before = readFileSync(statePath, 'utf8')

  assert.match(f.ok('migrate', '--check').stdout, /needs schema migration/)
  assert.equal(readFileSync(statePath, 'utf8'), before)
  assert.match(f.ok('migrate').stdout, /migrated to schema v1/)

  const migrated = f.state()
  assert.equal(migrated.schemaVersion, 1)
  assert.equal(migrated.plan.planningMode, 'phase')
  assert.deepEqual(migrated.tasks.A, completed)
  assert.equal(migrated.tasks.B.discussionRequired, true)
  assert.equal(migrated.tasks.B.discoveryRequired, true)
  assert.equal(migrated.tasks.B.planningRequired, true)
  assert.equal(migrated.phaseWorkflows.F1.adoptedLegacy, true)
  assert.equal(migrated.phaseWorkflows.F2.adoptedLegacy, true)
  assert.equal(migrated.phaseWorkflows.F2.state, 'pending')
  assert.equal(migrated.phaseWorkflows.F2.discussionAttempts.length, 0)
  assert.equal(existsSync(join(f.root, '.specs/graph/phase-negative/state.pre-migrate-v1.json')), true)
})

test('automatic migration refuses active legacy work and preserves its state', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Active legacy task' }])
  const legacy = f.state()
  delete legacy.schemaVersion
  delete legacy.plan.planningMode
  delete legacy.phaseWorkflows
  legacy.tasks.A.state = 'running'
  legacy.tasks.A.attempts = [{ n: 1, agent: 'legacy-executor' }]
  for (const field of ['discussionRequired', 'discoveryRequired', 'planningRequired']) delete legacy.tasks.A[field]
  f.save(legacy)
  const statePath = join(f.root, '.specs/graph/phase-negative/state.json')
  const before = readFileSync(statePath, 'utf8')
  f.rejects(/needs migration, blocked by A: state running, 1 execution attempt/, 'status')
  assert.equal(readFileSync(statePath, 'utf8'), before)
})

test('material sync invalidates a completed phase discussion before planner dispatch', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Original' }])
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.plan.tasks[0].title = 'Materially changed'
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', f.planPath)
  const before = readFileSync(join(f.root, '.specs/graph/phase-negative/state.json'), 'utf8'), events = f.events()
  f.rejects(/completed current phase discussion/, 'plan-phase', 'F1', '--agent', 'stale-planner')
  assert.equal(readFileSync(join(f.root, '.specs/graph/phase-negative/state.json'), 'utf8'), before)
  assert.equal(f.events(), events)
})

test('stale phase planning is superseded before a fresh discussion without partial plans', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'Original contract' },
    { id: 'B', phase: 'F2', title: 'Independent phase' },
  ])
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'released-planner')
  f.writeArtifacts('F1')

  const currentState = readFileSync(join(f.root, '.specs/graph/phase-negative/state.json'), 'utf8')
  f.rejects(/currently planning/, 'begin-phase-discussion', 'F1')
  assert.equal(readFileSync(join(f.root, '.specs/graph/phase-negative/state.json'), 'utf8'), currentState)
  assert.equal(f.state().phaseWorkflows.F1.planningAttempts.at(-1).endedAt, undefined)

  f.plan.tasks[0].title = 'Materially changed contract'
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', f.planPath)
  const staleState = readFileSync(join(f.root, '.specs/graph/phase-negative/state.json'), 'utf8')
  const staleEvents = f.events()
  f.rejects(/planning is stale/, 'finish-phase-planning', 'F1', '--plan-dir', f.plans)
  assert.equal(readFileSync(join(f.root, '.specs/graph/phase-negative/state.json'), 'utf8'), staleState)
  assert.equal(f.events(), staleEvents)
  assert.equal(f.state().tasks.A.taskPlan, undefined)
  assert.deepEqual(f.state().tasks.A.planningHistory, [])

  f.ok('begin-phase-discussion', 'F1')
  const recovered = f.state()
  assert.equal(recovered.phaseWorkflows.F1.state, 'discussing')
  assert.equal(recovered.phaseWorkflows.F1.planner, null)
  assert.equal(recovered.phaseWorkflows.F1.planningAttempts[0].result, 'superseded')
  assert.ok(recovered.phaseWorkflows.F1.planningAttempts[0].endedAt)
  assert.equal(recovered.phaseWorkflows.F1.discussionAttempts.length, 2)
  assert.deepEqual(recovered.phaseWorkflows.F1.discussionAttempts.at(-1).targets, ['A'])
  assert.equal(recovered.tasks.A.taskPlan, undefined)
  assert.deepEqual(recovered.tasks.A.planningHistory, [])

  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'released-planner')
})

test('sync-plan adding a phase member makes the previous discussion stale without invalidating current plans', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Already planned' }])
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'first-planner')
  f.writeArtifacts('F1')
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  const existingPlan = structuredClone(f.state().tasks.A.taskPlan)

  f.plan.tasks.push({ id: 'B', phase: 'F1', title: 'Added later', validation })
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', f.planPath)

  let derived = JSON.parse(f.ok('graph').stdout).derived
  assert.equal(derived.A.effective, 'ready')
  assert.equal(derived.B.effective, 'ready_for_discussion')
  assert.deepEqual(f.state().tasks.A.taskPlan, existingPlan)
  f.rejects(/completed current phase discussion/, 'plan-phase', 'F1', '--agent', 'stale-planner')

  f.ok('begin-phase-discussion', 'F1')
  assert.deepEqual(f.state().phaseWorkflows.F1.discussionAttempts.at(-1).targets, ['B'])
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  derived = JSON.parse(f.ok('graph').stdout).derived
  assert.equal(derived.B.effective, 'ready_to_plan')
  f.ok('plan-phase', 'F1', '--agent', 'second-planner')
  assert.deepEqual(f.state().phaseWorkflows.F1.planningAttempts.at(-1).targets, ['B'])
  assert.deepEqual(f.state().tasks.A.taskPlan, existingPlan)
})

test('sync-plan adding a phase member rejects an open plan batch atomically and reopens complete coverage', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Original member' }])
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'first-planner')
  f.writeArtifacts('F1')

  f.plan.tasks.push({ id: 'B', phase: 'F1', title: 'Added while planning', validation })
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', f.planPath)
  const statePath = join(f.root, '.specs/graph/phase-negative/state.json')
  const before = readFileSync(statePath, 'utf8'), events = f.events()
  f.rejects(/planning is stale/, 'finish-phase-planning', 'F1', '--plan-dir', f.plans)
  assert.equal(readFileSync(statePath, 'utf8'), before)
  assert.equal(f.events(), events)
  assert.equal(f.state().tasks.A.taskPlan, undefined)
  assert.equal(f.state().tasks.B.taskPlan, undefined)
  assert.deepEqual(f.state().tasks.A.planningHistory, [])
  assert.deepEqual(f.state().tasks.B.planningHistory, [])

  f.ok('begin-phase-discussion', 'F1')
  const reopened = f.state()
  assert.equal(reopened.phaseWorkflows.F1.planningAttempts[0].result, 'superseded')
  assert.ok(reopened.phaseWorkflows.F1.planningAttempts[0].endedAt)
  assert.equal(reopened.phaseWorkflows.F1.planner, null)
  assert.deepEqual(reopened.phaseWorkflows.F1.discussionAttempts.at(-1).targets, ['A', 'B'])
})

test('legacy phase adoption refuses an open task workflow anywhere without mutation', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'Adoption target' },
    { id: 'B', phase: 'F2', title: 'Open task discussion' },
  ], { planningMode: 'task' })
  f.ok('begin-discussion', 'B')
  const statePath = join(f.root, '.specs/graph/phase-negative/state.json')
  const before = readFileSync(statePath, 'utf8'), events = f.events()
  f.rejects(/open task discussion or planning.*B/, 'begin-phase-discussion', 'F1', '--adopt-legacy')
  assert.equal(readFileSync(statePath, 'utf8'), before)
  assert.equal(f.events(), events)
})

test('legacy phases adopt sequentially without enabling or mutating another phase', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'First phase task' },
    { id: 'B', phase: 'F2', title: 'Second phase task' },
  ], { planningMode: 'task' })

  f.rejects(/F2 waits for prior phase completion: F1/, 'begin-phase-discussion', 'F2', '--adopt-legacy')
  f.ok('begin-phase-discussion', 'F1', '--adopt-legacy')
  const initialSecond = JSON.parse(f.ok('graph').stdout).derived.B
  assert.equal(initialSecond.effective, 'pending')
  assert.deepEqual(initialSecond.planningBlockedBy, ['F1'])
  let current = f.state()
  assert.equal(current.plan.planningMode, 'phase')
  assert.equal(current.phaseWorkflows.F1.adoptedLegacy, true)
  assert.equal(current.phaseWorkflows.F2.adoptedLegacy, undefined)
  const unadopted = JSON.parse(f.ok('graph').stdout).derived.B
  assert.equal(unadopted.effective, 'pending')
  assert.equal(unadopted.planningStatus, 'awaiting_phase_adoption')
  f.rejects(/completed current planning/, 'start', 'B', '--agent', 'too-early')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner-f1')
  f.writeArtifacts('F1')
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  f.ok('start', 'A', '--agent', 'executor-f1')
  f.ok('review', 'A', '--agent', 'reviewer-f1')
  f.ok('validate', 'A', '--ok', '--evidence', 'first phase independently validated', '--cwd', f.project)
  f.ok('done', 'A')

  const statePath = join(f.root, '.specs/graph/phase-negative/state.json')
  const beforeMissingOptIn = readFileSync(statePath, 'utf8'), eventsBeforeOptIn = f.events()
  f.rejects(/--adopt-legacy/, 'begin-phase-discussion', 'F2')
  assert.equal(readFileSync(statePath, 'utf8'), beforeMissingOptIn)
  assert.equal(f.events(), eventsBeforeOptIn)

  current = f.state()
  current.tasks.B.state = 'running'
  current.tasks.B.attempts = [{ n: 1, agent: 'legacy-executor', startedAt: new Date().toISOString() }]
  f.save(current)
  const unsafe = readFileSync(statePath, 'utf8'), unsafeEvents = f.events()
  f.rejects(/unsafe for: B/, 'begin-phase-discussion', 'F2', '--adopt-legacy')
  assert.equal(readFileSync(statePath, 'utf8'), unsafe)
  assert.equal(f.events(), unsafeEvents)

  current.tasks.B.state = 'pending'
  current.tasks.B.attempts = []
  f.save(current)
  f.ok('begin-phase-discussion', 'F2', '--adopt-legacy')
  current = f.state()
  assert.equal(current.phaseWorkflows.F1.adoptedLegacy, true)
  assert.equal(current.phaseWorkflows.F2.adoptedLegacy, true)
  assert.deepEqual(current.phaseWorkflows.F2.discussionAttempts.at(-1).targets, ['B'])
  f.ok('finish-phase-discussion', 'F2', '--context', f.discovery('F2'))
  f.ok('plan-phase', 'F2', '--agent', 'planner-f2')
  f.writeArtifacts('F2')
  f.ok('finish-phase-planning', 'F2', '--plan-dir', f.plans)
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'done')
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.B.effective, 'ready')
})

test('selective plan-defect replanning keeps sibling phase plans current', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'Stable sibling' },
    { id: 'C', phase: 'F1', title: 'Defective plan' },
  ])
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner-1')
  f.writeArtifacts('F1')
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  const siblingPlan = structuredClone(f.state().tasks.A.taskPlan)
  f.ok('start', 'C', '--agent', 'executor')
  f.ok('review', 'C', '--agent', 'reviewer')
  f.ok('fail', 'C', '--reason', 'The C plan omitted a required branch', '--plan-defect')
  f.ok('retry', 'C')
  f.ok('begin-phase-discussion', 'F1')
  assert.deepEqual(f.state().phaseWorkflows.F1.discussionAttempts.at(-1).targets, ['C'])
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner-2')
  f.writeArtifacts('F1')
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  assert.deepEqual(f.state().tasks.A.taskPlan, siblingPlan)
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'ready')
})

test('a fresh material phase discussion invalidates and replans every targeted current plan', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'First current plan' },
    { id: 'B', phase: 'F1', title: 'Second current plan' },
  ])
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner-1')
  f.writeArtifacts('F1')
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  const first = f.state()

  f.ok('begin-phase-discussion', 'F1')
  assert.deepEqual(f.state().phaseWorkflows.F1.discussionAttempts.at(-1).targets, ['A', 'B'])
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  let current = f.state()
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'ready_to_plan')
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.B.effective, 'ready_to_plan')
  f.ok('plan-phase', 'F1', '--agent', 'planner-2')
  assert.deepEqual(f.state().phaseWorkflows.F1.planningAttempts.at(-1).targets, ['A', 'B'])
  f.writeArtifacts('F1')
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  current = f.state()
  assert.equal(current.tasks.A.planningHistory.length, first.tasks.A.planningHistory.length + 1)
  assert.equal(current.tasks.B.planningHistory.length, first.tasks.B.planningHistory.length + 1)
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'ready')
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.B.effective, 'ready')
})

test('plan and phase identifiers cannot escape the phase artifact directory', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Safe' }])
  f.plan.tasks[0].id = 'x/../../outside'
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.rejects(/invalid task id/, 'sync-plan', '--plan', f.planPath)
  f.plan.tasks[0].id = 'A'; f.plan.phases[0].id = '../outside'
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.rejects(/invalid phase id/, 'sync-plan', '--plan', f.planPath)
})

test('one phase discussion plans every member atomically while the DAG binds later-phase evidence', t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-phase-planning-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'workspace'), project = join(home, 'project'), plans = join(root, 'plans')
  mkdirSync(root); mkdirSync(project); mkdirSync(plans)
  writeFileSync(join(project, 'check.cjs'), "require('node:assert/strict').equal(1, 1)\n")
  const planPath = join(root, 'plan.json')
  const phasePlan = { name: 'Phase workflow', phases: [{ id: 'F1', title: 'Consumers' }, { id: 'F2', title: 'Producer' }], tasks: [
    { id: 'A', phase: 'F1', title: 'Earlier consumer', deps: ['B'], validation },
    { id: 'C', phase: 'F1', title: 'Independent member', validation },
    { id: 'B', phase: 'F2', title: 'Later producer', validation },
  ] }
  writeFileSync(planPath, JSON.stringify(phasePlan))
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: 'en' }
  const cli = (...args) => spawnSync(process.execPath, [engine, ...args], { cwd: project, env, encoding: 'utf8', windowsHide: true })
  const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.stdout + result.stderr); return result }
  const rejects = (pattern, ...args) => { const result = cli(...args); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, pattern); return result }
  const statePath = join(root, '.specs/graph/phase/state.json')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const discovery = phaseId => {
    const round = state().phaseWorkflows[phaseId].discussionAttempts.at(-1)
    const value = { research: [{ source: 'phase fixture', findings: 'Contracts and phase inputs inspected.' }],
      questions: [{ question: 'Keep task DAG authoritative?', answer: 'Yes.', channel: 'chat-fallback', round: 1, roundId: round.roundId }],
      coverage: { problem: 'Repeated task discussions.', affected: 'Graph users.', outcome: 'One phase discussion.', currentBehavior: 'Task scoped.',
        desiredBehavior: 'Phase scoped.', rules: 'DAG gates execution.', exceptions: 'Later inputs stay unresolved.', scope: phaseId, acceptance: 'Receipts bind inputs.' },
      decisions: [], deferred: [], closure: 'The phase contract is settled.', roundId: round.roundId, nonce: round.nonce }
    const path = join(root, `discovery-${phaseId}.json`); writeFileSync(path, JSON.stringify(value)); return path
  }
  const artifact = (task, binding, unresolvedInputs = []) => ({
    research: [{ source: 'phase fixture', findings: `${task} contract inspected.` }], decisions: [],
    steps: [`Deliver ${task} against its approved contract.`], verification: [{ criterion: 'delivery behavior passes', check: 1 }],
    openQuestions: [], phaseBinding: binding, unresolvedInputs,
  })
  const discussAndPlan = (phaseId, agent) => {
    ok('begin-phase-discussion', phaseId)
    ok('finish-phase-discussion', phaseId, '--context', discovery(phaseId))
    ok('plan-phase', phaseId, '--agent', agent)
    const current = state(), workflow = current.phaseWorkflows[phaseId], round = workflow.planningAttempts.at(-1)
    const binding = { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n }
    for (const id of round.targets) {
      const unresolved = id === 'A' ? [{ task: 'B', phase: 'F2', requiredEvidence: 'validated producer output' }] : []
      writeFileSync(join(plans, `task-plan-${id}.json`), JSON.stringify(artifact(id, binding, unresolved)))
    }
    ok('finish-phase-planning', phaseId, '--plan-dir', plans)
  }

  ok('init', '--plan', planPath, '--run', 'phase')
  assert.equal(state().plan.planningMode, 'phase')
  ok('begin-phase-discussion', 'F1')
  assert.deepEqual(state().phaseWorkflows.F1.discussionAttempts.at(-1).targets, ['A', 'C'])
  const wrongPath = discovery('F1'), wrong = JSON.parse(readFileSync(wrongPath, 'utf8'))
  wrong.nonce = 'wrong'; writeFileSync(wrongPath, JSON.stringify(wrong))
  const beforeWrongReceipt = readFileSync(statePath, 'utf8')
  rejects(/roundId and nonce/, 'finish-phase-discussion', 'F1', '--context', wrongPath)
  assert.equal(readFileSync(statePath, 'utf8'), beforeWrongReceipt)
  ok('finish-phase-discussion', 'F1', '--context', discovery('F1'))
  ok('plan-phase', 'F1', '--agent', 'phase-planner')
  rejects(/already has planner/, 'plan-phase', 'F1', '--agent', 'second-planner')
  const before = state(), round = before.phaseWorkflows.F1.planningAttempts.at(-1)
  const binding = { phaseId: 'F1', discussionRoundId: round.discussionRoundId, plannerRound: round.n }
  writeFileSync(join(plans, 'task-plan-A.json'), JSON.stringify(artifact('A', binding,
    [{ task: 'B', phase: 'F2', requiredEvidence: 'validated producer output' }])))
  const unchanged = readFileSync(statePath, 'utf8')
  rejects(/task-plan-C|ENOENT/, 'finish-phase-planning', 'F1', '--plan-dir', plans)
  assert.equal(readFileSync(statePath, 'utf8'), unchanged, 'partial artifact batches do not mutate state')
  assert.equal(JSON.parse(ok('graph').stdout).derived.A.effective, 'ready_to_plan')
  const earlyProducer = JSON.parse(ok('graph').stdout).derived.B
  assert.equal(earlyProducer.effective, 'ready_for_discussion')
  assert.equal(earlyProducer.planningBlockedBy, undefined)

  // The producer may finish while the earlier phase planner is still working. Its progress
  // satisfies the captured unresolved input; it does not stale or rewrite that plan batch.
  discussAndPlan('F2', 'producer-planner')
  ok('start', 'B', '--agent', 'producer-executor')
  ok('review', 'B', '--agent', 'producer-reviewer')
  ok('validate', 'B', '--ok', '--evidence', 'producer output independently validated', '--cwd', project)
  ok('done', 'B')
  writeFileSync(join(plans, 'task-plan-C.json'), JSON.stringify(artifact('C', binding)))
  ok('finish-phase-planning', 'F1', '--plan-dir', plans)
  const planned = state()
  assert.equal(planned.tasks.A.planningHistory.length, 1)
  assert.equal(planned.tasks.C.planningHistory.length, 1)
  assert.equal(JSON.parse(ok('graph').stdout).derived.A.effective, 'ready')
  assert.equal(JSON.parse(ok('graph').stdout).derived.C.effective, 'ready')
  const immutable = structuredClone(state().tasks.A.taskPlan)
  ok('start', 'A', '--agent', 'consumer-executor')
  assert.equal(state().tasks.A.attempts.at(-1).inputReceipt[0].result, 'validated')
  assert.deepEqual(state().tasks.A.taskPlan, immutable, 'dependency delivery does not rewrite the earlier plan')
  const damaged = state(); damaged.tasks.B.validations.at(-1).evidence = 'tampered'; writeFileSync(statePath, JSON.stringify(damaged))
  rejects(/input receipt changed/, 'review', 'A', '--agent', 'consumer-reviewer')
})
