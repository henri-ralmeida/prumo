import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/engine.mjs')
const check = { kind: 'functional', run: 'node delivery.test.cjs', expect: 'Express delivery takes 1 day and normal delivery takes 3 days' }

function fixture(t, tasks = [{ id: 'T1', title: 'Delivery estimate' }], options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-planning-'))
  t.after(() => {
    assert.equal(dirname(home), resolve(tmpdir()))
    assert.ok(home.startsWith(join(resolve(tmpdir()), 'prumo-planning-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  const root = join(home, 'workspace')
  mkdirSync(root)
  const project = join(home, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'delivery.cjs'), 'exports.days = express => express ? 1 : 3;\n')
  writeFileSync(join(project, 'delivery.test.cjs'), "const assert=require('node:assert/strict');const {days}=require('./delivery.cjs');assert.equal(days(true),1);assert.equal(days(false),3);\n")
  const plan = { name: 'Planning regression', ...options, tasks: tasks.map(task => ({ validation: [check], ...task })) }
  const planPath = join(root, 'plan.json')
  const writePlan = () => writeFileSync(planPath, JSON.stringify(plan))
  writePlan()
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, GRAPH_ROOT: root, GRAPH_FOREMAN_HOME: home, PRUMO_LANG: 'en' }
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [engine, ...args], { env, cwd: project, encoding: 'utf8', timeout: 20000, windowsHide: true })
    assert.ifError(result.error)
    return { ...result, output: result.stdout + result.stderr }
  }
  const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.output); return result }
  const rejected = (pattern, ...args) => {
    const result = cli(...args)
    assert.notEqual(result.status, 0, result.output)
    assert.match(result.output, pattern)
    return result
  }
  const statePath = join(root, '.specs/graph/planning/state.json')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const save = value => writeFileSync(statePath, JSON.stringify(value))
  const events = () => readFileSync(join(root, '.specs/graph/planning/events.ndjson'), 'utf8')
  const graph = () => JSON.parse(ok('graph').stdout)
  const artifact = (id = 'T1') => {
    const task = state().tasks[id]
    return {
      research: [{ source: join(project, 'delivery.cjs'), findings: readFileSync(join(project, 'delivery.cjs'), 'utf8').trim() }],
      decisions: [],
      steps: ['Compare delivery.cjs with the approved delivery policy, adjust mismatched branches, and run the recorded delivery scenarios.'],
      verification: Array.isArray(task.validation) ? task.validation.map((step, index) => ({ criterion: step.expect, check: index + 1 })) :
        [{ criterion: task.validation, check: 'inspection' }],
      openQuestions: [],
    }
  }
  const discovery = () => ({
    research: [{ source: join(project, 'delivery.cjs'), findings: 'Current delivery behavior and dependency outputs were inspected.' }],
    questions: [{ question: 'Should this task preserve the approved delivery behavior?', answer: 'Yes.', channel: 'chat-fallback', round: 1 }],
    coverage: {
      problem: 'Keep delivery estimates aligned with the approved contract.', affected: 'Customers requesting delivery estimates.',
      outcome: 'Express and normal estimates remain correct.', currentBehavior: 'The implementation returns one or three days.',
      desiredBehavior: 'Preserve the approved one-day and three-day results.', rules: 'Use the approved validation contract.',
      exceptions: 'No additional exception was approved.', scope: 'Only the current task and its declared files.',
      acceptance: 'The recorded functional check passes.',
    },
    decisions: [{ question: 'Preserve the approved behavior?', answer: 'Yes.' }], deferred: [],
    closure: 'The user confirmed the only task-specific gray area; no consequential uncertainty remains.',
  })
  const contextPath = (value = discovery(), id = 'T1') => {
    const path = join(root, id + '-discovery.json')
    writeFileSync(path, JSON.stringify(value))
    return path
  }
  const finish = (id = 'T1', value = artifact(id)) => {
    const path = join(root, id + '-task-plan.json')
    writeFileSync(path, JSON.stringify(value))
    return ok('finish-planning', id, '--plan', path)
  }
  const beginPlan = (id = 'T1', agent = 'planner-' + id, value = discovery()) =>
    ok('plan-task', id, '--agent', agent, '--context', contextPath(value, id))
  const planTask = (id = 'T1', agent = 'planner-' + id) => { beginPlan(id, agent); finish(id) }
  ok('init', '--plan', planPath, '--run', 'planning')
  return { root, project, plan, planPath, writePlan, cli, ok, rejected, state, save, events, graph,
    artifact, discovery, contextPath, beginPlan, finish, planTask }
}

test('new tasks require researched planning before execution and still require independent behavioral review', t => {
  const f = fixture(t, [{ id: 'T1', title: 'Delivery estimate' }, { id: 'T2', title: 'Dependent delivery', deps: ['T1'] }])
  assert.equal(f.graph().derived.T1.effective, 'ready_to_plan')
  assert.equal(f.graph().derived.T2.effective, 'waiting')
  f.rejected(/completed current planning/, 'start', 'T1', '--agent', 'executor', '--force')
  f.rejected(/still waiting on: T1/, 'plan-task', 'T2', '--agent', 'planner-T2', '--force', '--context', f.contextPath(f.discovery(), 'T2'))
  assert.match(f.ok('ready').output, /T1.*ready_to_plan/)
  f.beginPlan('T1', 'planner')
  assert.equal(f.graph().derived.T1.effective, 'planning')
  assert.equal(f.state().tasks.T1.attempts.length, 0)
  assert.match(f.ok('status').output, /@planner/)
  f.rejected(/not pending/, 'start', 'T1', '--agent', 'executor', '--force')
  f.finish()
  const planned = f.state().tasks.T1
  assert.equal(f.graph().derived.T1.effective, 'ready')
  assert.equal(planned.taskPlan.planner, 'planner')
  assert.equal(planned.planningAttempts[0].result, 'planned')
  assert.equal(planned.attempts.length, 0)
  assert.deepEqual(planned.planningHistory, [planned.taskPlan])
  writeFileSync(join(f.root, 'T1-task-plan.json'), '{}')
  assert.deepEqual(f.state().tasks.T1.taskPlan, planned.taskPlan, 'the artifact is persisted, not a live file reference')
  f.ok('start', 'T1', '--agent', 'executor')
  f.rejected(/no passing validation/, 'done', 'T1', '--force')
  f.rejected(/independent reviewer/, 'validate', 'T1', '--ok', '--evidence', 'Self report', '--cwd', f.project)
  f.ok('review', 'T1', '--agent', 'reviewer')
  writeFileSync(join(f.project, 'delivery.cjs'), 'exports.days = () => 99;\n')
  f.rejected(/functional.*failed/, 'validate', 'T1', '--ok', '--evidence', 'Ran both delivery scenarios', '--cwd', f.project)
  f.rejected(/no passing validation/, 'done', 'T1')
  writeFileSync(join(f.project, 'delivery.cjs'), 'exports.days = express => express ? 1 : 3;\n')
  f.ok('validate', 'T1', '--ok', '--evidence', 'Both delivery scenarios match the policy', '--cwd', f.project)
  f.ok('done', 'T1')
  assert.equal(f.graph().derived.T2.effective, 'ready_to_plan')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
})

test('discovery is completed in the principal conversation before a planner is dispatched', t => {
  const f = fixture(t)
  const baseline = f.state(), events = f.events()
  f.rejected(/needs --context/, 'plan-task', 'T1', '--agent', 'planner')
  for (const change of [
    { questions: [] },
    { questions: [{ question: 'What changes?', answer: '', channel: 'chat-fallback', round: 1 }] },
    { questions: [{ question: 'What changes?', answer: 'Approved answer', channel: 'unknown', round: 1 }] },
    { coverage: { problem: 'Only one area' } },
    { closure: '' },
  ]) {
    f.rejected(/discovery/, 'plan-task', 'T1', '--agent', 'planner', '--context', f.contextPath({ ...f.discovery(), ...change }))
    assert.deepEqual(f.state(), baseline)
    assert.equal(f.events(), events)
  }
  const context = f.discovery()
  context.questions.push({ question: 'Is there another consequential gray area?', answer: 'No.', channel: 'native', round: 2 })
  f.beginPlan('T1', 'planner', context)
  const task = f.state().tasks.T1
  assert.equal(task.state, 'planning')
  assert.equal(task.discovery.questions.length, 2)
  assert.equal(task.discovery.questions[1].channel, 'native')
  assert.equal(task.discovery.attempt, 1)
  assert.equal(task.discovery.context, task.planningAttempts[0].context)
  assert.match(task.discovery.digest, /^[a-f0-9]{64}$/)
  assert.equal(task.discovery.digest, task.planningAttempts[0].discoveryDigest)
  assert.match(f.events(), /"discoveryQuestions":2/)
})

test('planning is bound to canonical discovery and restarts only when its content changes', t => {
  const f = fixture(t)
  const discoveryA = f.discovery()
  f.beginPlan('T1', 'planner-A', discoveryA)
  const afterA = f.state(), eventsA = f.events()
  const digestA = afterA.tasks.T1.discovery.digest

  const sameA = structuredClone(discoveryA)
  sameA.coverage = Object.fromEntries(Object.entries(sameA.coverage).reverse())
  f.ok('plan-task', 'T1', '--agent', 'planner-that-must-not-start', '--context', f.contextPath(sameA))
  assert.deepEqual(f.state(), afterA)
  assert.equal(f.events(), eventsA)

  const discoveryB = structuredClone(discoveryA)
  discoveryB.questions[0].answer = 'Yes, with the clarified B decision.'
  discoveryB.decisions[0].answer = 'Use clarified behavior B.'
  discoveryB.closure = 'Decision B resolves the changed task-specific gray area.'
  f.beginPlan('T1', 'planner-B', discoveryB)
  const afterB = f.state(), task = afterB.tasks.T1
  assert.equal(task.planner, 'planner-B')
  assert.equal(task.planningAttempts.length, 2)
  assert.equal(task.planningAttempts[0].result, 'superseded')
  assert.ok(task.planningAttempts[0].endedAt)
  assert.notEqual(task.discovery.digest, digestA)
  assert.equal(task.planningAttempts[1].discoveryDigest, task.discovery.digest)

  const damaged = structuredClone(afterB)
  damaged.tasks.T1.discovery.questions[0].answer = 'Changed behind the planner'
  f.save(damaged)
  const beforeRefusal = f.events()
  f.rejected(/stale discovery/, 'finish-planning', 'T1', '--plan', f.contextPath(f.artifact(), 'task-plan'))
  assert.equal(f.events(), beforeRefusal)

  f.save(afterB)
  f.finish()
  const planned = f.state().tasks.T1
  assert.equal(planned.taskPlan.discoveryDigest, planned.discovery.digest)
  assert.equal(f.graph().derived.T1.effective, 'ready')
})

test('incomplete research, missing check coverage and unanswered blocking questions are refused atomically', t => {
  const f = fixture(t)
  f.beginPlan('T1', 'planner')
  const baseline = f.state(), events = f.events()
  const path = join(f.root, 'invalid.json')
  const cases = [
    null, {}, { research: [] }, { research: [{ source: '', findings: 'Read source' }] },
    { decisions: [{ question: 'Behavior?', answer: '' }] }, { steps: [] },
    { verification: [] }, { verification: [{ criterion: 'Policy matches', check: 0 }] },
    { openQuestions: [{ question: 'Which delivery policy is approved?', blocking: true }] },
    { openQuestions: [{ question: 'Policy?', blocking: 'yes' }] },
  ]
  for (const change of cases) {
    writeFileSync(path, JSON.stringify(change === null ? null : change === cases[1] ? change : { ...f.artifact(), ...change }))
    f.rejected(/task plan/, 'finish-planning', 'T1', '--plan', path, '--force')
    assert.deepEqual(f.state(), baseline)
    assert.equal(f.events(), events)
  }
  writeFileSync(path, '{invalid')
  f.rejected(/JSON|property name/i, 'finish-planning', 'T1', '--plan', path)
  f.rejected(/ENOENT/, 'finish-planning', 'T1', '--plan', join(f.root, 'missing.json'))
  assert.deepEqual(f.state(), baseline)
  f.finish('T1', { ...f.artifact(), decisions: [{ question: 'Which policy?', answer: 'The approved task specifies 1 day express and 3 days normal.' }],
    openQuestions: [{ question: 'Which policy?', blocking: true, answer: 'Use the approved contract.' }, { question: 'Future holiday policy?', blocking: false }] })
})

test('planners consume total capacity and cannot share an agent with execution or review', t => {
  const tasks = ['T1', 'T2', 'T3'].map(id => ({ id, title: id }))
  const f = fixture(t, tasks, { maxParallel: 2, maxExecutors: 1 })
  f.planTask('T1')
  f.ok('start', 'T1', '--agent', 'executor')
  f.rejected(/already on T1/, 'plan-task', 'T2', '--agent', 'executor', '--force', '--context', f.contextPath(f.discovery(), 'T2'))
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.rejected(/already on T1/, 'plan-task', 'T2', '--agent', 'reviewer', '--context', f.contextPath(f.discovery(), 'T2'))
  f.beginPlan('T2', 'planner')
  f.rejected(/agents busy/, 'plan-task', 'T3', '--agent', 'other', '--force', '--context', f.contextPath(f.discovery(), 'T3'))
  assert.match(f.ok('ready').output, /1 in planning.*0 agent slots/)
  f.ok('block', 'T1', '--reason', 'Release review slot')
  f.rejected(/already on T2/, 'plan-task', 'T3', '--agent', 'planner', '--force', '--context', f.contextPath(f.discovery(), 'T3'))
  f.planTask('T3', 'third-planner')
  f.rejected(/already on T2/, 'start', 'T3', '--agent', 'planner', '--force')
  f.ok('start', 'T3', '--agent', 'third-executor')
  f.rejected(/already on T2/, 'review', 'T3', '--agent', 'planner')
  f.rejected(/already on T2/, 'review', 'T3', '--agent', 'planner', '--force')
})

test('planning pause restores the planner phase and excludes paused time from active rounds', t => {
  const f = fixture(t, [{ id: 'T1', title: 'First' }, { id: 'T2', title: 'Second' }], { maxParallel: 1 })
  f.beginPlan('T1', 'planner')
  f.ok('block', 'T1', '--reason', 'Need a product decision')
  f.ok('block', 'T1', '--reason', 'Question clarified')
  assert.equal(f.state().tasks.T1.stateBeforeBlock, 'planning')
  assert.equal(f.state().tasks.T1.planningAttempts[0].result, 'blocked')
  assert.ok(f.state().tasks.T1.planningAttempts[0].endedAt)
  f.rejected(/paused active attempt/, 'unblock', 'T1', '--reviewer', 'reviewer', '--force')
  f.beginPlan('T2', 'second')
  const before = f.state()
  f.rejected(/agents busy/, 'unblock', 'T1')
  assert.deepEqual(f.state(), before)
  f.ok('block', 'T2', '--reason', 'Release planner slot')
  f.ok('unblock', 'T1')
  const resumed = f.state().tasks.T1
  assert.equal(resumed.state, 'planning')
  assert.equal(resumed.planner, 'planner')
  assert.equal(resumed.planningAttempts.length, 2)
  assert.equal(resumed.planningAttempts[1].context, resumed.planningAttempts[0].context)
  assert.equal(resumed.attempts.length, 0)
  f.finish()
})

test('task contract changes invalidate completed planning, including a later return to the old contract', t => {
  const f = fixture(t)
  f.planTask()
  const before = f.state().tasks.T1
  for (const title of ['Updated delivery policy', f.plan.tasks[0].title]) {
    f.plan.tasks[0].title = title
    f.writePlan()
    f.ok('sync-plan', '--plan', f.planPath)
    assert.equal(f.graph().derived.T1.effective, 'ready_to_plan')
    f.rejected(/completed current planning/, 'start', 'T1', '--agent', 'executor', '--force')
  }
  assert.deepEqual(f.state().tasks.T1.taskPlan, before.taskPlan)
  f.planTask('T1', 'fresh-planner')
  assert.equal(f.state().tasks.T1.planningHistory.length, 2)
  f.ok('start', 'T1', '--agent', 'executor')
})

test('changed contracts while planning or paused have an explicit restart preserving research history', t => {
  for (const paused of [false, true]) {
    const f = fixture(t)
    f.beginPlan('T1', 'planner')
    if (paused) f.ok('block', 'T1', '--reason', 'Approved clarification is pending')
    f.plan.tasks[0].validation = [{ ...check, timeoutMs: 900000 }]
    f.writePlan()
    f.ok('refresh-contract', 'T1', '--plan', f.planPath)
    if (paused) f.ok('unblock', 'T1')
    const path = join(f.root, 'stale.json')
    writeFileSync(path, JSON.stringify(f.artifact()))
    f.rejected(/planning is stale/, 'finish-planning', 'T1', '--plan', path, '--force')
    const before = f.state().tasks.T1
    f.beginPlan('T1', 'planner')
    const restarted = f.state().tasks.T1
    assert.equal(restarted.planningAttempts.at(-2).result, 'superseded')
    assert.equal(restarted.planningAttempts.length, before.planningAttempts.length + 1)
    assert.equal(restarted.attempts.length, 0)
    f.finish()
    f.ok('start', 'T1', '--agent', 'executor')
  }
})

test('delivered dependency changes invalidate planning; unrelated task progress and notes do not', t => {
  const f = fixture(t, [{ id: 'T0', title: 'Prerequisite' }, { id: 'T1', title: 'Delivery', deps: ['T0'] }, { id: 'T2', title: 'Independent task' }])
  f.ok('skip', 'T0', '--reason', 'Prerequisite waived explicitly')
  f.planTask('T1')
  const original = f.state().tasks.T1.taskPlan
  f.plan.tasks[2].title = 'Clarified independent work'
  f.writePlan()
  f.ok('sync-plan', '--plan', f.planPath)
  f.ok('note', 'T0', '--text', 'Unrelated scheduling note')
  f.beginPlan('T2', 'other-planner')
  assert.equal(f.graph().derived.T1.effective, 'ready')
  f.ok('skip', 'T0', '--reason', 'Different approved prerequisite outcome')
  assert.equal(f.graph().derived.T1.effective, 'ready_to_plan')
  f.rejected(/completed current planning/, 'start', 'T1', '--agent', 'executor', '--force')
  assert.deepEqual(f.state().tasks.T1.taskPlan, original)
  f.planTask('T1')
  const state = f.state()
  state.tasks.T0.title = 'Recovered dependency contract changed'
  f.save(state)
  assert.equal(f.graph().derived.T1.effective, 'ready_to_plan')
  f.rejected(/completed current planning/, 'start', 'T1', '--agent', 'executor')
})

test('real failure requires fresh research for the next attempt and preserves the previous plan and delivery history', t => {
  const f = fixture(t)
  f.planTask()
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'reviewer')
  writeFileSync(join(f.project, 'delivery.cjs'), 'exports.days = () => 99;\n')
  f.rejected(/functional.*failed/, 'validate', 'T1', '--ok', '--evidence', 'Delivery branches returned 99 days', '--cwd', f.project)
  f.ok('fail', 'T1', '--reason', 'Both delivery branches violate the approved policy')
  const failed = f.state().tasks.T1
  f.ok('retry', 'T1')
  assert.equal(f.graph().derived.T1.effective, 'ready_to_plan')
  assert.deepEqual(f.state().tasks.T1.taskPlan, failed.taskPlan)
  f.rejected(/completed current planning/, 'start', 'T1', '--agent', 'executor-v2', '--force')
  f.planTask('T1', 'planner-v2')
  assert.match(f.state().tasks.T1.taskPlan.research[0].findings, /99/)
  assert.equal(f.state().tasks.T1.taskPlan.attempt, 2)
  f.ok('start', 'T1', '--agent', 'executor-v2')
  assert.deepEqual(f.state().tasks.T1.attempts[0], failed.attempts[0])
  assert.deepEqual(f.state().tasks.T1.validations, failed.validations)
  assert.equal(f.state().tasks.T1.planningHistory.length, 2)
  assert.equal(f.state().tasks.T1.attempts.length, 2)
})

test('active contract refresh preserves execution and review in the same attempt', t => {
  const f = fixture(t)
  f.planTask()
  f.ok('start', 'T1', '--agent', 'executor')
  const started = f.state().tasks.T1
  f.plan.tasks[0].validation = [{ ...check, timeoutMs: 900000 }]
  f.writePlan()
  f.ok('refresh-contract', 'T1', '--plan', f.planPath)
  f.ok('block', 'T1', '--reason', 'Pause delivered work')
  f.ok('unblock', 'T1', '--reviewer', 'reviewer')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
  assert.equal(f.state().tasks.T1.attempts[0].startedAt, started.attempts[0].startedAt)
  assert.deepEqual(f.state().tasks.T1.planningHistory, started.planningHistory)
  f.ok('validate', 'T1', '--ok', '--evidence', 'Both scenarios pass under the refreshed deadline', '--cwd', f.project)
  f.ok('done', 'T1')
})

test('paused execution must replan changed scope before resume without replacing its attempt or block reason', t => {
  for (const phase of ['running', 'reviewing']) {
    const f = fixture(t, [{ id: 'T1', title: 'Delivery estimate' }, { id: 'T0', title: 'Prerequisite' }])
    f.ok('skip', 'T0', '--reason', 'Prerequisite explicitly waived')
    f.planTask()
    f.ok('start', 'T1', '--agent', 'executor')
    if (phase === 'reviewing') f.ok('review', 'T1', '--agent', 'reviewer')
    f.ok('validate', 'T1', phase === 'reviewing' ? '--ok' : '--failed', '--evidence', 'Recorded the original delivery review', '--cwd', f.project)
    f.ok('note', 'T1', '--text', 'Preserve the delivered implementation')
    f.ok('block', 'T1', '--reason', 'Wait for the approved scope clarification')
    const original = f.state().tasks.T1
    Object.assign(f.plan.tasks[0], { title: 'Clarified delivery scope', touches: ['delivery.cjs'], deps: ['T0'] })
    f.writePlan()
    f.ok('sync-plan', '--plan', f.planPath)
    const changed = f.state()
    f.rejected(/scope.*planning/, 'unblock', 'T1', '--force')
    f.rejected(/scope.*planning/, 'unblock', 'T1', '--reviewer', 'new-reviewer', '--force')
    assert.deepEqual(f.state(), changed)
    f.beginPlan('T1', 'scope-planner')
    assert.equal(f.state().tasks.T1.state, 'planning')
    assert.equal(f.state().tasks.T1.planningAttempts.at(-1).attempt, 1)
    assert.deepEqual(f.state().tasks.T1.attempts, original.attempts)
    f.ok('block', 'T1', '--reason', 'Research needs another answer')
    f.ok('unblock', 'T1')
    assert.equal(f.state().tasks.T1.state, 'planning')
    f.finish()
    const planned = f.state().tasks.T1
    assert.equal(planned.state, 'blocked', 'completing research must not dispatch or resume execution')
    assert.equal(planned.stateBeforeBlock, phase)
    assert.equal(planned.blockReason, original.blockReason)
    assert.equal(planned.taskPlan.attempt, 1)
    assert.equal(planned.planningHistory.length, 2)
    assert.deepEqual(planned.attempts, original.attempts)
    assert.deepEqual(planned.validations, original.validations)
    assert.deepEqual(planned.notes, original.notes)
    f.rejected(/not pending/, 'start', 'T1', '--agent', 'executor', '--force')
    f.ok('unblock', 'T1')
    assert.equal(f.state().tasks.T1.state, phase)
    if (phase === 'running') f.ok('review', 'T1', '--agent', 'reviewer')
    else f.rejected(/scope changed after validation/, 'done', 'T1', '--force')
    f.ok('validate', 'T1', '--ok', '--evidence', 'Current delivery scenarios pass after scope research', '--cwd', f.project)
    f.ok('done', 'T1')
    assert.equal(f.state().tasks.T1.attempts.length, 1)
  }
})

test('changed global scope cannot bypass planning through active review or validation', t => {
  const f = fixture(t)
  f.planTask()
  f.ok('start', 'T1', '--agent', 'executor')
  f.plan.description = 'Approved clarification: preserve the exported days function.'
  f.writePlan()
  f.ok('sync-plan', '--plan', f.planPath)
  f.rejected(/scope needs current planning/, 'review', 'T1', '--agent', 'reviewer', '--force')
  f.rejected(/scope needs current planning/, 'validate', 'T1', '--ok', '--evidence', 'Old research', '--cwd', f.project)
  f.rejected(/scope needs current planning/, 'done', 'T1', '--force')
  f.ok('block', 'T1', '--reason', 'Research the approved global scope')
  f.beginPlan('T1', 'scope-planner')
  f.finish('T1', { ...f.artifact(), scope: 'an input file cannot author engine metadata' })
  assert.notEqual(f.state().tasks.T1.taskPlan.scope, 'an input file cannot author engine metadata')
  f.ok('unblock', 'T1')
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('validate', 'T1', '--ok', '--evidence', 'The exported function still passes both delivery scenarios', '--cwd', f.project)
  f.ok('done', 'T1')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
})

test('missing or damaged stored plans cannot dispatch and inspection tasks still need research', t => {
  const f = fixture(t, [{ id: 'T1', title: 'Delivery policy documentation', validationMode: 'inspection', inspectionReason: 'Only documenting the existing delivery policy', validation: 'Check the documented policy against delivery.cjs' }])
  f.planTask()
  const planned = f.state()
  for (const plan of [undefined, { ...planned.tasks.T1.taskPlan, steps: [] }, { ...planned.tasks.T1.taskPlan, context: 'outdated' }]) {
    const damaged = structuredClone(planned)
    damaged.tasks.T1.taskPlan = plan
    f.save(damaged)
    assert.equal(f.graph().derived.T1.effective, 'ready_to_plan')
    f.rejected(/completed current planning/, 'start', 'T1', '--agent', 'executor', '--force')
  }
  f.save(planned)
  f.ok('start', 'T1', '--agent', 'executor')
})

test('legacy tasks retain their lifecycle and history while tasks added by sync-plan require planning', t => {
  const f = fixture(t)
  const legacy = f.state()
  for (const field of ['discoveryRequired', 'planningRequired', 'planner', 'planningAttempts', 'planningHistory']) delete legacy.tasks.T1[field]
  f.save(legacy)
  assert.equal(f.graph().derived.T1.effective, 'ready')
  f.ok('start', 'T1', '--agent', 'legacy-executor')
  const active = f.state().tasks.T1
  f.plan.tasks.push({ id: 'T2', title: 'New task', validation: [check] })
  f.writePlan()
  f.ok('sync-plan', '--plan', f.planPath)
  assert.deepEqual(f.state().tasks.T1, active)
  assert.equal(f.state().tasks.T2.discoveryRequired, true)
  assert.equal(f.state().tasks.T2.planningRequired, true)
  f.rejected(/needs --context/, 'plan-task', 'T2', '--agent', 'planner')
  assert.equal(f.graph().derived.T2.effective, 'ready_to_plan')
  f.ok('fail', 'T1', '--reason', 'Legacy real failure')
  f.ok('retry', 'T1')
  f.ok('start', 'T1', '--agent', 'legacy-executor-v2')
  assert.equal(f.state().tasks.T1.attempts.length, 2)
})

test('1.2.0 planning tasks remain compatible without a retroactive discovery gate', t => {
  const f = fixture(t)
  const previous = f.state()
  delete previous.tasks.T1.discoveryRequired
  f.save(previous)
  f.ok('plan-task', 'T1', '--agent', 'previous-planner')
  assert.equal(f.state().tasks.T1.state, 'planning')
  f.finish()
  assert.equal(f.graph().derived.T1.effective, 'ready')
})
