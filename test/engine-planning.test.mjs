import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/engine.mjs')
const validation = [{ kind: 'functional', run: 'node check.cjs', expect: 'delivery behavior passes' }]

function fixture(t, dependent = false, { requireReview = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-corrective-retry-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'workspace'), project = join(home, 'project')
  mkdirSync(root); mkdirSync(project)
  writeFileSync(join(project, 'check.cjs'), "require('node:assert/strict').equal(1, 1)\n")
  const planPath = join(root, 'plan.json')
  writeFileSync(planPath, JSON.stringify({ name: 'Corrective retry', requireReview, tasks: [
    ...(dependent ? [{ id: 'T0', title: 'Dependency', validation }] : []),
    { id: 'T1', title: 'Delivery', deps: dependent ? ['T0'] : [], validation },
  ] }))
  const discovery = {
    research: [{ source: 'delivery', findings: 'Current behavior inspected.' }],
    questions: [{ question: 'Preserve the contract?', answer: 'Yes.', channel: 'chat-fallback', round: 1 }],
    coverage: { problem: 'Incorrect delivery.', affected: 'Users.', outcome: 'Correct delivery.', currentBehavior: 'Reviewed.',
      desiredBehavior: 'Approved behavior.', rules: 'Keep contract.', exceptions: 'None.', scope: 'T1.', acceptance: 'Check passes.' },
    decisions: [], deferred: [], executionBoundary: { deferredToExecutor: ['T1'], prematureTaskWork: [] },
    closure: 'No gray area remains.',
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

test('skip encerra tentativa ativa sem inventar recibo de validação', t => {
  for (const phase of ['running', 'reviewing', 'blocked']) {
    const f = fixture(t)
    f.ok('start', 'T1', '--agent', 'executor-1')
    if (phase === 'reviewing') f.ok('review', 'T1', '--agent', 'reviewer-1')
    if (phase === 'blocked') f.ok('block', 'T1', '--reason', 'Pause before cancellation')
    const before = f.state().tasks.T1
    f.ok('skip', 'T1', '--reason', 'Approved cancellation')
    const task = f.state().tasks.T1
    const attempt = task.attempts.at(-1)
    assert.equal(task.state, 'skipped')
    assert.equal(task.skipReason, 'Approved cancellation')
    assert.equal(task.validations.length, before.validations.length)
    assert.equal(attempt.result, 'skipped')
    assert.equal(attempt.reason, 'Approved cancellation')
    assert.ok(attempt.endedAt)
    assert.ok(attempt.endedAt >= attempt.startedAt)
    const unchanged = JSON.stringify(task)
    f.rejects(/already terminal/, 'skip', 'T1', '--reason', 'Second decision')
    assert.equal(JSON.stringify(f.state().tasks.T1), unchanged)
  }
})

test('skip exige motivo explícito antes de alterar estado ou histórico', t => {
  const f = fixture(t)
  const before = f.state()
  f.rejects(/requires --reason/, 'skip', 'T1')
  assert.deepEqual(f.state(), before)
})

test('retry recusa mudança global aprovada antes de mutar a tarefa falha', t => {
  const f = fixture(t, false, { requireReview: false })
  const plan = JSON.parse(readFileSync(f.planPath, 'utf8'))
  f.ok('start', 'T1', '--agent', 'executor-1')
  f.ok('review', 'T1', '--agent', 'reviewer-1')
  f.ok('fail', 'T1', '--reason', 'The reviewed implementation needs correction')
  plan.requireReview = true
  writeFileSync(f.planPath, JSON.stringify(plan))
  const before = f.state()
  f.rejects(/global plan decisions differ.*requireReview.*sync-plan/, 'retry', 'T1')
  assert.deepEqual(f.state(), before)
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
      decisions: [], deferred: [], executionBoundary: { deferredToExecutor: round.targets, prematureTaskWork: [] },
      closure: 'No gray area remains.', roundId: round.roundId, nonce: round.nonce }
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

function printedPhasePlanFragments(output) {
  return [...output.matchAll(/task-plan-([A-Za-z0-9._-]+)\.json:\r?\n```json\r?\n([\s\S]*?)\r?\n```/g)]
    .map(([, id, json]) => [id, JSON.parse(json)])
}

test('plan-phase prints the persisted copyable contract on first dispatch and no-op, including skipped discussion IDs', async t => {
  await t.test('first dispatch and active-round no-op repeat the same fragments', t => {
    const f = phaseFixture(t, [
      { id: 'A', phase: 'F1', title: 'Producer' },
      { id: 'B', phase: 'F1', title: 'Consumer', deps: ['A'] },
    ])
    f.ok('begin-phase-discussion', 'F1')
    const discussionId = f.state().phaseWorkflows.F1.discussionAttempts.at(-1).roundId
    f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
    const first = f.ok('plan-phase', 'F1', '--agent', 'phase-planner')
    const firstState = f.state(), round = firstState.phaseWorkflows.F1.planningAttempts.at(-1)
    assert.equal(round.n, 1)
    const fragments = printedPhasePlanFragments(first.stdout)
    assert.deepEqual(fragments.map(([id]) => id), ['A', 'B'])
    assert.deepEqual(fragments[0][1], {
      phaseBinding: { phaseId: 'F1', discussionRoundId: discussionId, plannerRound: 1 }, unresolvedInputs: [],
    })
    assert.deepEqual(fragments[1][1].unresolvedInputs, round.requiredInputs.B)
    assert.deepEqual(fragments[1][1].unresolvedInputs, [{
      task: 'A', phase: 'F1', requiredEvidence: 'current terminal receipt for A',
    }])

    const repeat = f.ok('plan-phase', 'F1', '--agent', 'phase-planner')
    assert.match(repeat.stdout, /no new round recorded/)
    assert.deepEqual(printedPhasePlanFragments(repeat.stdout), fragments)
    assert.equal(f.state().phaseWorkflows.F1.planningAttempts.length, 1)
  })

  await t.test('a skipped discussion binds to its persisted decision ID', t => {
    const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Delivery' }])
    f.ok('skip-phase-discussion', 'F1', '--reason', 'The contract is settled', '--confirmed-by-user')
    const decisionId = f.state().phaseWorkflows.F1.discussionSkips.at(-1).decisionId
    const planned = f.ok('plan-phase', 'F1', '--agent', 'phase-planner')
    assert.deepEqual(printedPhasePlanFragments(planned.stdout), [['A', {
      phaseBinding: { phaseId: 'F1', discussionRoundId: decisionId, plannerRound: 1 }, unresolvedInputs: [],
    }]])
  })
})

test('finish-phase-planning reports every artifact error with its filename and accepts a UTF-8 BOM atomically', t => {
  const f = phaseFixture(t, ['A', 'B', 'C', 'D'].map(id => ({ id, phase: 'F1', title: `Task ${id}` })))
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner')
  f.writeArtifacts('F1')
  const statePath = join(f.root, '.specs/graph/phase-negative/state.json')
  const before = readFileSync(statePath, 'utf8')
  const files = Object.fromEntries(['A', 'B', 'C', 'D'].map(id => [id, join(f.plans, `task-plan-${id}.json`)]))
  rmSync(files.A)
  writeFileSync(files.B, '{invalid json')
  const wrongBinding = JSON.parse(readFileSync(files.C, 'utf8'))
  wrongBinding.phaseBinding.phaseId = 'F2'
  writeFileSync(files.C, JSON.stringify(wrongBinding))
  const invalidPlan = JSON.parse(readFileSync(files.D, 'utf8'))
  invalidPlan.steps = []
  writeFileSync(files.D, JSON.stringify(invalidPlan))

  const refusal = f.rejects(/task-plan-A\.json:[\s\S]*task-plan-D\.json:/, 'finish-phase-planning', 'F1', '--plan-dir', f.plans)
  const output = refusal.stdout + refusal.stderr
  assert.match(output, /finish-phase-planning F1 rejected 4 task-plan artifact\(s\); nothing was recorded/)
  for (const id of ['A', 'B', 'C', 'D']) assert.match(output, new RegExp(`task-plan-${id}\\.json:`))
  assert.match(output, /does not exist/)
  assert.match(output, /JSON is invalid/)
  assert.match(output, /binding must match/)
  assert.match(output, /execution steps/)
  assert.equal(readFileSync(statePath, 'utf8'), before, 'no plan is recorded when any artifact fails')
  assert.deepEqual(Object.values(f.state().tasks).map(task => task.taskPlan), [undefined, undefined, undefined, undefined])

  f.writeArtifacts('F1')
  writeFileSync(files.B, `\uFEFF${readFileSync(files.B, 'utf8')}`)
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  assert.equal(f.state().phaseWorkflows.F1.state, 'planned')
  assert.ok(f.state().tasks.B.taskPlan)
})

test('unresolvedInputs diagnostics distinguish missing and unexpected inputs and preserve the round-opening snapshot', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'Missing input', deps: ['B'] },
    { id: 'B', phase: 'F1', title: 'Producer' },
    { id: 'C', phase: 'F1', title: 'Unexpected input' },
    { id: 'D', phase: 'F1', title: 'Both directions', deps: ['B'] },
  ])
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner')
  const round = f.state().phaseWorkflows.F1.planningAttempts.at(-1)
  f.writeArtifacts('F1')
  const writeInputs = (id, inputs) => {
    const path = join(f.plans, `task-plan-${id}.json`)
    const plan = JSON.parse(readFileSync(path, 'utf8'))
    plan.unresolvedInputs = inputs
    writeFileSync(path, JSON.stringify(plan))
  }
  writeInputs('A', [])
  writeInputs('C', [{ task: 'X', phase: 'F2', requiredEvidence: 'unexpected evidence' }])
  writeInputs('D', [{ task: 'X', phase: 'F2', requiredEvidence: 'unexpected evidence' }])

  const refusal = f.rejects(/unresolvedInputs differ/, 'finish-phase-planning', 'F1', '--plan-dir', f.plans)
  const output = refusal.stdout + refusal.stderr
  assert.match(output, /task-plan-A\.json:.*phase task plan A/)
  assert.match(output, /task-plan-C\.json:.*phase task plan C/)
  assert.match(output, /task-plan-D\.json:.*phase task plan D/)
  assert.match(output, /missing \[\{"task":"B","phase":"F1"\}\]; unexpected \[\]/)
  assert.match(output, /missing \[\]; unexpected \[\{"task":"X","phase":"F2"\}\]/)
  assert.match(output, /expected JSON at round opening: \[\{"task":"B","phase":"F1","requiredEvidence":"current terminal receipt for B"\}\]/)
  assert.deepEqual(round.requiredInputs.A, [{ task: 'B', phase: 'F1', requiredEvidence: 'current terminal receipt for B' }])
})

test('phase plan dependencies completed after dispatch remain bound to the round-opening snapshot', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Existing producer' }])
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'first-planner')
  f.writeArtifacts('F1')
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)

  f.plan.tasks.push({ id: 'B', phase: 'F1', title: 'New consumer', deps: ['A'], validation })
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', f.planPath)
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'second-planner')
  const opened = f.state().phaseWorkflows.F1.planningAttempts.at(-1)
  assert.deepEqual(opened.requiredInputs.B, [{
    task: 'A', phase: 'F1', requiredEvidence: 'current terminal receipt for A',
  }])

  f.ok('start', 'A', '--agent', 'producer')
  f.ok('review', 'A', '--agent', 'producer-reviewer')
  f.ok('validate', 'A', '--ok', '--evidence', 'producer output independently validated', '--cwd', f.project)
  f.ok('done', 'A')
  assert.equal(f.state().tasks.A.state, 'done')
  f.writeArtifacts('F1')
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  assert.deepEqual(f.state().tasks.B.taskPlan.unresolvedInputs, opened.requiredInputs.B,
    'the accepted artifact preserves the dependency state captured when its planning round opened')
})

test('independent phases plan concurrently by explicit choice without moving tasks', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'First phase' },
    { id: 'B', phase: 'F2', title: 'Independent phase' },
    { id: 'C', phase: 'F2', title: 'Internal dependency', deps: ['B'] },
  ])
  const source = readFileSync(f.planPath, 'utf8')
  const derived = JSON.parse(f.ok('graph').stdout).derived
  for (const id of ['A', 'B', 'C']) assert.equal(derived[id].effective, 'ready_for_discussion')
  f.ok('begin-phase-discussion', 'F2')
  const discussing = JSON.parse(f.ok('graph').stdout).derived
  assert.equal(discussing.A.effective, 'ready_for_discussion')
  for (const id of ['B', 'C']) assert.equal(discussing[id].effective, 'discussing')
  assert.equal(f.state().phaseWorkflows.F1.discussionAttempts.length, 0, 'eligibility does not open other phases')
  f.ok('finish-phase-discussion', 'F2', '--context', f.discovery('F2'))
  f.ok('plan-phase', 'F2', '--agent', 'planner-f2')
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner-f1')
  for (const id of ['F1', 'F2']) assert.equal(f.state().phaseWorkflows[id].state, 'planning')
  const activelyPlanning = JSON.parse(f.ok('graph').stdout).derived
  for (const id of ['A', 'B', 'C']) assert.equal(activelyPlanning[id].effective, 'planning')
  assert.match(f.ok('status').stdout, /A\s+planning\s+@planner-f1.*planning/)
  assert.match(f.ok('status').stdout, /B\s+planning\s+@planner-f2.*planning/)
  assert.equal(f.state().tasks.B.phase, 'F2')
  assert.deepEqual(f.state().tasks.C.deps, ['B'])
  f.writeArtifacts('F2')
  f.ok('finish-phase-planning', 'F2', '--plan-dir', f.plans)
  const plannedF2 = JSON.parse(f.ok('graph').stdout).derived
  assert.equal(plannedF2.C.effective, 'waiting')
  assert.equal(plannedF2.C.inputStatus, 'unresolved_input')
  assert.equal(readFileSync(f.planPath, 'utf8'), source)
})

test('discussion and planning are independent explicit optional gates', async t => {
  await t.test('skip discussion then plan', t => {
    const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Delivery' }])
    const before = f.state()
    f.rejects(/confirmed-by-user/, 'skip-phase-discussion', 'F1', '--reason', 'Contract is already settled')
    assert.deepEqual(f.state(), before)
    f.ok('skip-phase-discussion', 'F1', '--reason', 'Contract is already settled', '--confirmed-by-user')
    assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'ready_to_plan')
    f.ok('plan-phase', 'F1', '--agent', 'planner')
    f.writeArtifacts('F1')
    f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
    assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'ready')
    assert.equal(f.state().tasks.A.taskPlan.phaseDecision, 'skipped')
  })

  await t.test('discuss then skip planning without waiving review', t => {
    const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Delivery' }])
    f.ok('begin-phase-discussion', 'F1')
    f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
    f.ok('skip-phase-planning', 'F1', '--reason', 'Global contract is sufficient', '--confirmed-by-user')
    const task = f.state().tasks.A
    assert.equal(task.taskPlan, undefined)
    assert.equal(task.planningSkips.at(-1).confirmedByUser, true)
    assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'ready')
    f.ok('start', 'A', '--agent', 'executor')
    f.rejects(/independent reviewer/, 'validate', 'A', '--ok', '--evidence', 'executor self-check', '--cwd', f.project)
    f.ok('review', 'A', '--agent', 'reviewer')
    f.ok('validate', 'A', '--ok', '--evidence', 'independent behavioral check', '--cwd', f.project)
    f.ok('done', 'A')
  })

  await t.test('skip both gates and preserve both reasons', t => {
    const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Homologation correction' }])
    f.ok('skip-phase-discussion', 'F1', '--reason', 'User feedback already settles the correction', '--confirmed-by-user')
    f.ok('skip-phase-planning', 'F1', '--reason', 'Executor can use the global contract and feedback', '--confirmed-by-user')
    const state = f.state()
    assert.equal(state.phaseWorkflows.F1.discussionSkips.at(-1).reason, 'User feedback already settles the correction')
    assert.equal(state.tasks.A.planningSkips.at(-1).reason, 'Executor can use the global contract and feedback')
    assert.match(f.events(), /phase_discussion_skipped/)
    assert.match(f.events(), /phase_planning_skipped/)
    assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.planningStatus, 'planning_skipped')
    assert.match(f.ok('status').stdout, /Discussion skipped:\s+1/)
    assert.match(f.ok('status').stdout, /Planning skipped:\s+1/)
  })

  await t.test('a phase plan defect invalidates a plan bound to a skipped discussion', t => {
    const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Homologation correction' }])
    f.ok('skip-phase-discussion', 'F1', '--reason', 'User feedback already settles the correction', '--confirmed-by-user')
    f.ok('plan-phase', 'F1', '--agent', 'planner-1')
    f.writeArtifacts('F1')
    f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
    f.ok('start', 'A', '--agent', 'executor-1')
    f.ok('review', 'A', '--agent', 'reviewer-1')
    f.ok('fail', 'A', '--reason', 'The approved steps omit one required branch', '--plan-defect')
    f.ok('retry', 'A')
    assert.equal(f.state().tasks.A.phasePlanDefect, true)
    assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'ready_to_plan')
    f.rejects(/completed current planning/, 'start', 'A', '--agent', 'executor-2')
    f.ok('plan-phase', 'F1', '--agent', 'planner-2')
    f.writeArtifacts('F1')
    f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
    assert.equal(f.state().tasks.A.phasePlanDefect, undefined)
    assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'ready')
  })

  await t.test('retry after skipped planning preserves the correction and reviewer gates', t => {
    const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Homologation correction' }])
    f.ok('skip-phase-discussion', 'F1', '--reason', 'User feedback already settles the correction', '--confirmed-by-user')
    f.ok('skip-phase-planning', 'F1', '--reason', 'Use the approved global contract', '--confirmed-by-user')
    f.ok('start', 'A', '--agent', 'executor-1')
    f.ok('review', 'A', '--agent', 'reviewer-1')
    f.ok('fail', 'A', '--reason', 'Homologation found one correction still needed')
    f.ok('retry', 'A')
    assert.equal(f.state().tasks.A.retryPlan.skippedPlanning, true)
    assert.equal(f.state().tasks.A.retryPlan.planSourceAttempt, undefined)
    assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'ready')
    f.ok('start', 'A', '--agent', 'executor-2')
    assert.equal(f.state().tasks.A.attempts[1].correctionOf, 1)
    assert.equal(f.state().tasks.A.attempts[1].correctionReason, 'Homologation found one correction still needed')
    f.rejects(/independent reviewer/, 'validate', 'A', '--ok', '--evidence', 'executor self-check', '--cwd', f.project)
    f.ok('review', 'A', '--agent', 'reviewer-2')
    f.ok('validate', 'A', '--ok', '--evidence', 'independent behavioral check', '--cwd', f.project)
    f.ok('done', 'A')
  })
})

test('one external dependency blocks every member until its producer is terminal', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'Producer', touches: ['src/shared'] },
    { id: 'B', phase: 'F2', title: 'Dependent member', touches: ['src/shared'], deps: ['A'] },
    { id: 'C', phase: 'F2', title: 'Independent member' },
  ])
  for (const state of ['pending', 'running', 'failed', 'blocked', 'done', 'skipped']) {
    const current = f.state(); current.tasks.A.state = state; f.save(current)
    const derived = JSON.parse(f.ok('graph').stdout).derived
    const terminal = ['done', 'skipped'].includes(state)
    for (const id of ['B', 'C']) {
      assert.equal(derived[id].effective, terminal ? 'ready_for_discussion' : 'waiting', `${state}: ${id}`)
      assert.deepEqual(derived[id].planningBlockedBy, terminal ? undefined : ['F1'])
    }
    if (!terminal) f.rejects(/F2 waits for external dependencies: F1/, 'begin-phase-discussion', 'F2')
  }
})

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

test('migration refuses newer state schemas without downgrading or writing backups', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Future task' }])
  const future = f.state()
  future.schemaVersion = 999
  f.save(future)
  const statePath = join(f.root, '.specs/graph/phase-negative/state.json')
  const before = readFileSync(statePath, 'utf8'), events = f.events()
  f.rejects(/newer.*schema|schema.*newer/, 'migrate')
  f.rejects(/newer.*schema|schema.*newer/, 'status')
  assert.equal(readFileSync(statePath, 'utf8'), before)
  assert.equal(f.events(), events)
  assert.equal(existsSync(join(f.root, '.specs/graph/phase-negative/state.pre-migrate-v1.json')), false)
})

test('migration adds current gates to an unstarted unmarked task when the mode already exists', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Unstarted legacy task' }])
  const legacy = f.state()
  delete legacy.schemaVersion
  delete legacy.phaseWorkflows
  delete legacy.tasks.A.planningRequired
  delete legacy.tasks.A.discussionRequired
  delete legacy.tasks.A.discoveryRequired
  delete legacy.tasks.A.discussionAttempts
  delete legacy.tasks.A.planningAttempts
  delete legacy.tasks.A.planningHistory
  f.save(legacy)

  f.ok('status')
  const migrated = f.state()
  assert.equal(migrated.plan.planningMode, 'phase')
  assert.equal(migrated.tasks.A.planningRequired, true)
  assert.deepEqual(migrated.tasks.A.discussionAttempts, [])
  assert.deepEqual(migrated.tasks.A.planningAttempts, [])
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.effective, 'ready_for_discussion')
  f.rejects(/completed current planning/, 'start', 'A', '--agent', 'too-early')
})

test('unsafe migration blockers reject new task-mode flow but allow legacy continuation', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'Current planning in flight' },
    { id: 'B', phase: 'F1', title: 'New task' },
    { id: 'C', phase: 'F1', title: 'Legacy attempt' },
  ])
  const state = f.state()
  state.tasks.A.state = 'planning'
  state.tasks.A.planner = 'planner'
  state.tasks.A.planningAttempts = [{ n: 1, agent: 'planner', startedAt: '2026-09-21T12:00:00.000Z' }]
  state.tasks.C.state = 'running'
  state.tasks.C.agent = 'legacy-executor'
  state.tasks.C.attempts = [{ n: 1, agent: 'legacy-executor', startedAt: '2026-09-21T12:00:00.000Z' }]
  state.tasks.C.planningRequired = false
  delete state.schemaVersion
  delete state.plan.planningMode
  delete state.phaseWorkflows
  f.save(state)

  f.rejects(/unsafe in-flight planning/, 'begin-discussion', 'B')
  f.rejects(/unsafe in-flight planning/, 'start', 'B', '--agent', 'new-executor')
  f.ok('review', 'C', '--agent', 'independent-reviewer')
  assert.equal(f.state().tasks.C.state, 'reviewing')
  f.ok('status')
})

test('legacy work can finish independently reviewed while new tasks use the current workflow', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Active legacy task' }, { id: 'B', phase: 'F2', title: 'New work' }])
  const legacy = f.state()
  delete legacy.schemaVersion
  delete legacy.plan.planningMode
  delete legacy.phaseWorkflows
  legacy.tasks.A.state = 'running'
  legacy.tasks.A.attempts = [{ n: 1, agent: 'legacy-executor' }]
  Object.assign(legacy.tasks.A, { agent: 'legacy-executor', validationMode: 'inspection', inspectionReason: 'Inspect fixture documentation', validation: 'Documentation inspected' })
  Object.assign(f.plan.tasks[0], { validationMode: 'inspection', inspectionReason: 'Inspect fixture documentation', validation: 'Documentation inspected' })
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  for (const field of ['discussionRequired', 'discoveryRequired', 'planningRequired']) delete legacy.tasks.A[field]
  const legacyAttempts = structuredClone(legacy.tasks.A.attempts)
  f.save(legacy)
  f.ok('status')
  const migrated = f.state()
  assert.equal(migrated.plan.planningMode, 'phase')
  assert.equal(migrated.tasks.A.planningRequired, false)
  assert.equal(migrated.tasks.B.planningRequired, true)
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.B.effective, 'ready_for_discussion')
  assert.deepEqual(migrated.tasks.A.attempts, legacyAttempts)
  f.ok('block', 'A', '--reason', 'Waiting for an existing input')
  f.ok('unblock', 'A')
  f.ok('fail', 'A', '--reason', 'Transient execution failure')
  f.ok('retry', 'A')
  f.ok('start', 'A', '--agent', 'legacy-executor')
  f.rejects(/independent|executor/, 'review', 'A', '--agent', 'legacy-executor')
  f.ok('review', 'A', '--agent', 'independent-reviewer')
  f.ok('validate', 'A', '--ok', '--evidence', 'Fixture document inspected')
  f.ok('done', 'A')
  const completed = f.state().tasks.A
  f.ok('status')
  assert.equal(f.state().plan.planningMode, 'phase')
  assert.deepEqual(f.state().tasks.A, completed)
  assert.equal(f.state().tasks.A.attempts.length, 2)
  assert.equal(f.state().tasks.A.attempts[0].result, 'failed')
})

test('an unstarted legacy human block enters the current workflow during migration', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Awaiting human input' }])
  const legacy = f.state()
  delete legacy.schemaVersion
  delete legacy.plan.planningMode
  delete legacy.phaseWorkflows
  legacy.tasks.A.state = 'blocked'
  legacy.tasks.A.stateBeforeBlock = 'pending'
  f.save(legacy)
  f.ok('status')
  assert.equal(f.state().schemaVersion, 1)
  assert.equal(f.state().tasks.A.planningRequired, true)
  assert.equal(f.state().tasks.A.state, 'blocked')
  f.ok('unblock', 'A')
  assert.equal(f.state().tasks.A.state, 'pending')
  assert.equal(f.state().phaseWorkflows.F1.state, 'pending')
})

test('partial migration keeps a blocked legacy attempt resumable while independent new tasks plan', t => {
  const f = phaseFixture(t, [
    { id: 'T11', phase: 'F1', title: 'Completed prerequisite' },
    { id: 'T12', phase: 'F1', title: 'Legacy blocked work' },
    { id: 'T25', phase: 'F1', title: 'New independent work', deps: ['T11'] },
    { id: 'T26', phase: 'F1', title: 'Another independent work', deps: ['T11'] },
  ])
  const legacy = f.state()
  legacy.tasks.T11.state = 'done'
  legacy.tasks.T11.validations = [{
    ok: true, by: 'review', agent: 'seed-reviewer', evidence: 'Seed prerequisite',
    attempt: 0, token: 'seed-receipt',
  }]
  legacy.tasks.T12.state = 'blocked'
  legacy.tasks.T12.stateBeforeBlock = 'running'
  legacy.tasks.T12.blockReason = 'Waiting for an external decision'
  legacy.tasks.T12.agent = 'legacy-executor'
  legacy.tasks.T12.attempts = [{ n: 1, agent: 'legacy-executor', startedAt: '2026-09-21T12:00:00.000Z' }]
  legacy.tasks.T12.validations = [{
    ok: false, by: 'executor', agent: 'legacy-executor', evidence: 'Prior failed evidence',
    attempt: 1, token: 'prior-evidence',
  }]
  for (const field of ['discussionRequired', 'discoveryRequired', 'planningRequired', 'discussionAttempts', 'planningAttempts', 'planningHistory'])
    delete legacy.tasks.T12[field]
  const completedBefore = structuredClone(legacy.tasks.T11)
  const attemptBefore = structuredClone(legacy.tasks.T12.attempts[0])
  const evidenceBefore = structuredClone(legacy.tasks.T12.validations)
  delete legacy.schemaVersion
  delete legacy.plan.planningMode
  delete legacy.phaseWorkflows
  f.save(legacy)

  const migrated = JSON.parse(f.ok('graph').stdout)
  assert.equal(migrated.plan.planningMode, 'phase')
  assert.deepEqual(migrated.tasks.T11, completedBefore)
  assert.equal(migrated.tasks.T12.state, 'blocked')
  assert.equal(migrated.tasks.T12.planningRequired, false)
  assert.deepEqual(migrated.tasks.T12.attempts, [attemptBefore])
  assert.deepEqual(migrated.tasks.T12.validations, evidenceBefore)
  assert.equal(migrated.derived.T25.effective, 'ready_for_discussion')
  assert.equal(migrated.derived.T26.effective, 'ready_for_discussion')

  f.ok('unblock', 'T12')
  f.ok('review', 'T12', '--agent', 'independent-reviewer')
  f.ok('validate', 'T12', '--ok', '--evidence', 'Legacy attempt reviewed', '--cwd', f.project)
  f.ok('done', 'T12')
  const completedLegacy = f.state().tasks.T12
  assert.equal(completedLegacy.attempts.length, 1)
  assert.equal(completedLegacy.attempts[0].agent, attemptBefore.agent)
  assert.equal(completedLegacy.attempts[0].startedAt, attemptBefore.startedAt)
  assert.equal(completedLegacy.attempts[0].result, 'done')
  assert.deepEqual(completedLegacy.validations[0], evidenceBefore[0])

  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner-f1')
  f.writeArtifacts('F1')
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  const planned = f.state()
  for (const id of ['T25', 'T26']) {
    assert.equal(planned.tasks[id].planningRequired, true)
    assert.equal(planned.tasks[id].taskPlan.phaseId, 'F1')
  }
  f.ok('start', 'T25', '--agent', 'new-worker-25')
  f.ok('start', 'T26', '--agent', 'new-worker-26')
  assert.equal(f.state().tasks.T25.state, 'running')
  assert.equal(f.state().tasks.T26.state, 'running')
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
  const firstDispatch = f.ok('plan-phase', 'F1', '--agent', 'released-planner')
  assert.equal(printedPhasePlanFragments(firstDispatch.stdout)[0][1].phaseBinding.plannerRound, 1)
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
  const resumedDispatch = f.ok('plan-phase', 'F1', '--agent', 'released-planner')
  const resumed = printedPhasePlanFragments(resumedDispatch.stdout)
  assert.equal(f.state().phaseWorkflows.F1.planningAttempts.at(-1).n, 2)
  assert.equal(resumed[0][1].phaseBinding.plannerRound, 2)
  assert.equal(resumed[0][1].phaseBinding.discussionRoundId, f.state().phaseWorkflows.F1.discussionAttempts.at(-1).roundId)
})

test('sync-plan adding a phase member makes the previous discussion stale without invalidating current plans', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Already planned' }])
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  const firstDispatch = f.ok('plan-phase', 'F1', '--agent', 'first-planner')
  assert.equal(printedPhasePlanFragments(firstDispatch.stdout)[0][1].phaseBinding.plannerRound, 1)
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
  const secondDispatch = f.ok('plan-phase', 'F1', '--agent', 'second-planner')
  assert.deepEqual(f.state().phaseWorkflows.F1.planningAttempts.at(-1).targets, ['B'])
  const secondFragment = printedPhasePlanFragments(secondDispatch.stdout)[0]
  assert.equal(secondFragment[0], 'B')
  assert.equal(secondFragment[1].phaseBinding.plannerRound, 2)
  assert.equal(secondFragment[1].phaseBinding.discussionRoundId, f.state().phaseWorkflows.F1.discussionAttempts.at(-1).roundId)
  assert.deepEqual(f.state().tasks.A.taskPlan, existingPlan)
})

test('sync-plan during an open phase discussion can supersede and reopen the stale round', t => {
  const f = phaseFixture(t, [{ id: 'A', phase: 'F1', title: 'Original homologation contract' }])
  f.ok('begin-phase-discussion', 'F1')
  const first = f.state().phaseWorkflows.F1.discussionAttempts.at(-1)
  f.plan.tasks[0].title = 'Homologation correction requested by the area'
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', f.planPath)
  f.ok('begin-phase-discussion', 'F1')
  const phase = f.state().phaseWorkflows.F1
  assert.equal(phase.discussionAttempts.length, 2)
  assert.equal(phase.discussionAttempts[0].roundId, first.roundId)
  assert.equal(phase.discussionAttempts[0].result, 'superseded')
  assert.ok(phase.discussionAttempts[0].endedAt)
  assert.notEqual(phase.discussionAttempts[1].roundId, first.roundId)
  assert.deepEqual(phase.discussionAttempts[1].targets, ['A'])
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

test('legacy phase adoption waits for external dependencies without mutating another phase', t => {
  const f = phaseFixture(t, [
    { id: 'A', phase: 'F1', title: 'First phase task' },
    { id: 'B', phase: 'F2', title: 'Second phase task', deps: ['A'] },
  ], { planningMode: 'task' })

  f.rejects(/F2 waits for external dependencies: F1/, 'begin-phase-discussion', 'F2', '--adopt-legacy')
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
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.A.planningStatus, undefined)
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
      decisions: [], deferred: [], executionBoundary: { deferredToExecutor: round.targets, prematureTaskWork: [] },
      closure: 'The phase contract is settled.', roundId: round.roundId, nonce: round.nonce }
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
  const blocked = JSON.parse(ok('graph').stdout).derived
  assert.equal(blocked.A.effective, 'waiting')
  assert.equal(blocked.C.effective, 'waiting', 'one external dependency blocks the whole phase')
  assert.equal(blocked.B.effective, 'ready_for_discussion', 'phase numbering does not block a provider')
  rejects(/F1 waits for external dependencies: F2/, 'begin-phase-discussion', 'F1')
  discussAndPlan('F2', 'producer-planner')
  ok('start', 'B', '--agent', 'producer-executor')
  ok('review', 'B', '--agent', 'producer-reviewer')
  ok('validate', 'B', '--ok', '--evidence', 'producer output independently validated', '--cwd', project)
  ok('done', 'B')
  ok('begin-phase-discussion', 'F1')
  assert.deepEqual(state().phaseWorkflows.F1.discussionAttempts.at(-1).targets, ['A', 'C'])
  const wrongPath = discovery('F1'), wrong = JSON.parse(readFileSync(wrongPath, 'utf8'))
  wrong.nonce = 'wrong'; writeFileSync(wrongPath, JSON.stringify(wrong))
  const beforeWrongReceipt = readFileSync(statePath, 'utf8')
  rejects(/roundId and nonce/, 'finish-phase-discussion', 'F1', '--context', wrongPath)
  assert.equal(readFileSync(statePath, 'utf8'), beforeWrongReceipt)
  const incompletePath = discovery('F1'), incomplete = JSON.parse(readFileSync(incompletePath, 'utf8'))
  incomplete.executionBoundary.deferredToExecutor = ['A']; writeFileSync(incompletePath, JSON.stringify(incomplete))
  rejects(/defer every discussion target/, 'finish-phase-discussion', 'F1', '--context', incompletePath)
  assert.equal(readFileSync(statePath, 'utf8'), beforeWrongReceipt)
  ok('finish-phase-discussion', 'F1', '--context', discovery('F1'))
  ok('plan-phase', 'F1', '--agent', 'phase-planner')
  rejects(/already has planner/, 'plan-phase', 'F1', '--agent', 'second-planner')
  const before = state(), round = before.phaseWorkflows.F1.planningAttempts.at(-1)
  const binding = { phaseId: 'F1', discussionRoundId: round.discussionRoundId, plannerRound: round.n }
  writeFileSync(join(plans, 'task-plan-A.json'), JSON.stringify(artifact('A', binding)))
  const unchanged = readFileSync(statePath, 'utf8')
  rejects(/task-plan-C|ENOENT/, 'finish-phase-planning', 'F1', '--plan-dir', plans)
  assert.equal(readFileSync(statePath, 'utf8'), unchanged, 'partial artifact batches do not mutate state')
  assert.equal(JSON.parse(ok('graph').stdout).derived.A.effective, 'planning')
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
