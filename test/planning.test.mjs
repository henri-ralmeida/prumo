import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/engine.mjs')
const check = { kind: 'functional', run: 'node delivery.test.cjs', expect: 'Express delivery takes 1 day and normal delivery takes 3 days' }

function fixture(t, tasks = [{ id: 'T1', title: 'Delivery estimate' }], options = {}, { lang = 'en' } = {}) {
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
  const plan = { name: 'Planning regression', planningMode: 'task', ...options, tasks: tasks.map(task => ({ validation: [check], ...task })) }
  const planPath = join(root, 'plan.json')
  const writePlan = () => writeFileSync(planPath, JSON.stringify(plan))
  writePlan()
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, GRAPH_ROOT: root, GRAPH_FOREMAN_HOME: home, PRUMO_LANG: lang }
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [engine, ...args], { env, cwd: project, encoding: 'utf8', timeout: 20000, windowsHide: true })
    assert.ifError(result.error)
    return { ...result, output: result.stdout + result.stderr }
  }
  const ok = (...args) => {
    if (args[0] === 'start' && !state().tasks[args[1]]?.executionAuthorization) {
      const authorization = cli('authorize', '--scope', `tasks:${args[1]}`, '--confirmed-by-user')
      assert.equal(authorization.status, 0, authorization.output)
    }
    const result = cli(...args); assert.equal(result.status, 0, result.output)
    if (args[0] === 'init') {
      const authorization = cli('authorize', '--scope', 'run', '--confirmed-by-user')
      assert.equal(authorization.status, 0, authorization.output)
    }
    return result
  }
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
  const discovery = (id = 'T1') => ({
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
    executionBoundary: { deferredToExecutor: [id], prematureTaskWork: [] },
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
  const discuss = (id = 'T1', value = discovery(id)) => {
    ok('begin-discussion', id)
    const round = state().tasks[id].discussionAttempts.at(-1)
    const bound = { ...value, roundId: round.roundId, nonce: round.nonce,
      questions: value.questions.map(question => ({ ...question, roundId: round.roundId,
        ...(round.confirmsContract ? { confirmsContract: round.confirmsContract } : {}) })) }
    const path = contextPath(bound, id)
    ok('finish-discussion', id, '--context', path)
    return path
  }
  const beginPlan = (id = 'T1', agent = 'planner-' + id, value = discovery(id)) => {
    discuss(id, value)
    return ok('plan-task', id, '--agent', agent)
  }
  const planTask = (id = 'T1', agent = 'planner-' + id) => { beginPlan(id, agent); finish(id) }
  const initialized = ok('init', '--plan', planPath, '--run', 'planning')
  return { root, project, plan, planPath, writePlan, cli, ok, rejected, state, save, events, graph,
    artifact, discovery, contextPath, discuss, beginPlan, finish, planTask, initialized }
}

test('event progress counts executor plan steps and actual reviewer checks per attempt', t => {
  const f = fixture(t, [{ id: 'T4', title: 'Four steps', validation: [check, check, check, check] }])
  f.beginPlan('T4')
  f.finish('T4', { ...f.artifact('T4'), steps: ['Inspect', 'Implement', 'Verify', 'Report'] })
  const started = f.ok('start', 'T4', '--agent', 'executor')
  assert.match(started.output, /progress 'T4' --step 1 --agent 'executor' --run 'planning'/)
  const log = () => f.events().trim().split('\n').map(JSON.parse)
  assert.equal(log().at(-1).current, 1)
  assert.equal(log().at(-1).total, 4)
  const baseline = f.state(), events = f.events()
  f.rejected(/current executor/, 'progress', 'T4', '--step', '2', '--agent', 'someone-else')
  f.rejected(/index/, 'progress', 'T4', '--step', '5', '--agent', 'executor')
  assert.deepEqual(f.state(), baseline)
  assert.equal(f.events(), events)
  assert.match(f.ok('progress', 'T4', '--step', '2', '--agent', 'executor').output,
    /execution position recorded at 2\/4/)
  for (const step of [3, 4]) f.ok('progress', 'T4', '--step', String(step), '--agent', 'executor')
  const atFour = f.events()
  assert.match(f.ok('progress', 'T4', '--step', '4', '--agent', 'executor').output,
    /execution position already recorded at 4\/4/)
  assert.equal(f.events(), atFour)
  f.rejected(/backwards/, 'progress', 'T4', '--step', '1', '--agent', 'executor')
  assert.deepEqual(log().filter(e => ['task_start', 'task_progress'].includes(e.type)).map(e => [e.current, e.total]),
    [[1, 4], [2, 4], [3, 4], [4, 4]])
  f.ok('review', 'T4', '--agent', 'reviewer')
  const reviewStarted = log().find(event => event.type === 'task_review')
  assert.deepEqual([reviewStarted.current, reviewStarted.total], [1, 4])
  f.ok('validate', 'T4', '--ok', '--evidence', 'All four delivery checks match', '--cwd', f.project)
  const checks = log().filter(e => e.type === 'task_check')
  assert.deepEqual(checks.filter(e => e.status === 'started').map(e => [e.current, e.total]), [[1, 4], [2, 4], [3, 4], [4, 4]])
  assert.ok(checks.every(e => e.by === 'review' && e.attempt === 1 && e.token))
  assert.equal(checks.filter(e => e.status === 'passed').length, 4)
  f.ok('fail', 'T4', '--reason', 'Exercise a fresh attempt')
  f.ok('retry', 'T4')
  f.planTask('T4')
  f.ok('start', 'T4', '--agent', 'executor')
  assert.equal(log().at(-1).current, 1)
  assert.equal(log().at(-1).attempt, 2)
})

test('start prints a PowerShell-safe command for paths and shell metacharacters', t => {
  if (process.platform !== 'win32') return t.skip('PowerShell command-line compatibility')
  const f = fixture(t, [{ id: 'T4', title: 'Command quoting' }])
  f.beginPlan('T4')
  f.finish('T4', { ...f.artifact('T4'), steps: ['Inspect', 'Report'] })

  const copiedScripts = join(f.root, "engine path & 'quoted'")
  mkdirSync(copiedScripts)
  for (const file of ['engine.mjs', 'atomic-state.mjs', 'validation.mjs', 'storage.mjs', 'i18n.mjs',
    'messages.json', 'region.mjs', 'sync-plan-audit.mjs', 'contract-drift.mjs'])
    copyFileSync(join(dirname(engine), file), join(copiedScripts, file))
  const copiedEngine = join(copiedScripts, 'engine.mjs')
  const home = dirname(f.root)
  const env = { ...process.env, GRAPH_FOREMAN_HOME: home, GRAPH_ROOT: f.root, PRUMO_HOME: home,
    PRUMO_ROOT: f.root, PRUMO_LANG: 'en' }
  const agent = "executor & 'quoted'"
  const started = spawnSync(process.execPath, [copiedEngine, 'start', 'T4', '--agent', agent, '--run', 'planning'],
    { cwd: f.project, env, encoding: 'utf8', timeout: 20000, windowsHide: true })
  assert.ifError(started.error)
  const output = started.stdout + started.stderr
  assert.equal(started.status, 0, output)
  const command = output.split(/\r?\n/).find(line => line.startsWith('& '))
  assert.ok(command, output)
  assert.ok(command.includes("engine path & ''quoted''"), command)
  assert.ok(command.includes(`--agent '${agent.replaceAll("'", "''")}'`), command)

  const executed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { cwd: f.project, env, encoding: 'utf8', timeout: 20000, windowsHide: true })
  assert.ifError(executed.error)
  assert.equal(executed.status, 0, executed.stdout + executed.stderr)
  assert.match(executed.stdout + executed.stderr, /execution position already recorded at 1\/2/)
  assert.equal(f.state().tasks.T4.agent, agent)
})

test('review warns when executor progress remains at the first of several steps', t => {
  const f = fixture(t, [{ id: 'T4', title: 'Four steps', validation: [check, check, check, check] }])
  f.beginPlan('T4')
  f.finish('T4', { ...f.artifact('T4'), steps: ['Inspect', 'Implement', 'Verify', 'Report'] })
  const started = f.ok('start', 'T4', '--agent', 'executor')
  assert.match(started.output, /--run 'planning'/)
  const review = f.ok('review', 'T4', '--agent', 'reviewer')
  assert.match(review.output, /WARNING: executor progress stayed at 1\/4/)
  const event = f.events().trim().split('\n').map(JSON.parse).findLast(item => item.type === 'task_review')
  assert.deepEqual([event.current, event.total], [1, 4])
  assert.equal(f.state().tasks.T4.attempts.at(-1).executionStep, 1)
})

test('structured inspection criteria must be traversed in order before a passing validation', t => {
  const f = fixture(t, [{ id: 'DOC', title: 'Delivery policy docs', validationMode: 'inspection',
    inspectionReason: 'The task only updates documentation.', validation: 'Compare the documented policy with the implementation.' }])
  f.beginPlan('DOC')
  f.finish('DOC', { ...f.artifact('DOC'), verification: [
    { criterion: 'The documented express rate matches the code.', check: 'inspection' },
    { criterion: 'The documented normal rate matches the code.', check: 'inspection' },
  ] })
  f.ok('start', 'DOC', '--agent', 'executor')
  f.ok('review', 'DOC', '--agent', 'reviewer')
  const reviewEvent = f.events().trim().split('\n').map(JSON.parse).findLast(item => item.type === 'task_review')
  assert.deepEqual([reviewEvent.current, reviewEvent.total, reviewEvent.basis], [1, 2, 'inspection'])

  const before = f.state(), events = f.events()
  f.rejected(/inspection criteria are not fully traversed/, 'validate', 'DOC', '--ok', '--evidence', 'Docs inspected')
  assert.deepEqual(f.state(), before)
  assert.equal(f.events(), events)
  f.rejected(/traverse the next criterion in order/, 'review-progress', 'DOC', '--step', '2', '--agent', 'reviewer')
  assert.deepEqual(f.state(), before)
  assert.equal(f.events(), events)

  assert.match(f.ok('review-progress', 'DOC', '--step', '1', '--agent', 'reviewer').output,
    /review progress reports 1\/2 criteria traversed; next criterion 2\/2; reviewer report is not proof of inspection/)
  assert.match(f.ok('review-progress', 'DOC', '--step', '2', '--agent', 'reviewer').output,
    /review progress reports 2\/2 criteria traversed; reviewer report is not proof of inspection or approval/)
  const progressEvent = f.events().trim().split('\n').map(JSON.parse).findLast(item => item.type === 'task_review_progress')
  assert.deepEqual([progressEvent.reviewer, progressEvent.traversed, progressEvent.total, progressEvent.selfReported],
    ['reviewer', 2, 2, true])
  f.ok('validate', 'DOC', '--ok', '--evidence', 'Both documented rates match the current implementation')
  f.ok('done', 'DOC')
})

test('inspection denominator counts criteria even when they share one static check', t => {
  const f = fixture(t, [{ id: 'DOC', title: 'Delivery policy docs', validationMode: 'inspection',
    inspectionReason: 'The task only updates documentation.',
    validation: [{ kind: 'static', run: 'node --check delivery.cjs', expect: 'syntax valid' }] }])
  f.beginPlan('DOC')
  f.finish('DOC', { ...f.artifact('DOC'), verification: [
    { criterion: 'The documented express rate matches the code.', check: 1 },
    { criterion: 'The documented normal rate matches the code.', check: 1 },
  ] })
  f.ok('start', 'DOC', '--agent', 'executor')
  f.ok('review', 'DOC', '--agent', 'reviewer')
  const reviewEvent = f.events().trim().split('\n').map(JSON.parse).findLast(item => item.type === 'task_review')
  assert.deepEqual([reviewEvent.current, reviewEvent.total, reviewEvent.basis], [1, 2, 'inspection'])

  const before = f.state(), events = f.events()
  f.rejected(/inspection criteria are not fully traversed/, 'validate', 'DOC', '--ok', '--evidence', 'Docs inspected', '--cwd', f.project)
  assert.deepEqual(f.state(), before)
  assert.equal(f.events(), events)
  f.ok('review-progress', 'DOC', '--step', '1', '--agent', 'reviewer')
  const afterFirst = f.state(), afterFirstEvents = f.events()
  f.rejected(/inspection criteria are not fully traversed/, 'validate', 'DOC', '--ok', '--evidence', 'Docs inspected', '--cwd', f.project)
  assert.deepEqual(f.state(), afterFirst)
  assert.equal(f.events(), afterFirstEvents)
  f.ok('review-progress', 'DOC', '--step', '2', '--agent', 'reviewer')
  f.ok('validate', 'DOC', '--ok', '--evidence', 'Both documented rates match the current implementation', '--cwd', f.project)
  f.ok('done', 'DOC')
})

test('corrective review reuses earlier path-scoped receipts through the engine', t => {
  const steps = [
    { kind: 'static', cacheable: true, cachePaths: ['stable.txt', 'step.cjs'], run: 'node step.cjs first', expect: 'passes' },
    { kind: 'static', cacheable: true, cachePaths: ['changed.txt', 'step.cjs'], run: 'node step.cjs second once', expect: 'passes' },
  ]
  const f = fixture(t, [{ id: 'T1', title: 'Corrective review', validationMode: 'inspection',
    inspectionReason: 'Fixture exercises deterministic static review steps.', validation: steps }], {}, { lang: 'pt-BR' })
  writeFileSync(join(f.project, 'stable.txt'), 'stable\n')
  writeFileSync(join(f.project, 'changed.txt'), 'before\n')
  writeFileSync(join(f.project, 'step.cjs'), `const fs=require('node:fs');const [name,fail]=process.argv.slice(2);fs.appendFileSync(name+'.count','x');if(fail==='once'&&!fs.existsSync(name+'.failed')){fs.writeFileSync(name+'.failed','1');process.exit(7)}\n`)
  spawnSync('git', ['init'], { cwd: f.project, encoding: 'utf8', windowsHide: true })
  spawnSync('git', ['add', '.'], { cwd: f.project, encoding: 'utf8', windowsHide: true })
  f.planTask()
  f.ok('start', 'T1', '--agent', 'executor-a')
  f.ok('review', 'T1', '--agent', 'reviewer-a')
  f.ok('review-progress', 'T1', '--step', '1', '--agent', 'reviewer-a')
  f.ok('review-progress', 'T1', '--step', '2', '--agent', 'reviewer-a')
  f.rejected(/verificação 2\/2/, 'validate', 'T1', '--ok', '--evidence', 'first review', '--cwd', f.project)
  f.ok('fail', 'T1', '--reason', 'review: second check failed')
  f.ok('retry', 'T1')
  f.ok('start', 'T1', '--agent', 'executor-b')
  writeFileSync(join(f.project, 'changed.txt'), 'after\n')
  f.ok('review', 'T1', '--agent', 'reviewer-b')
  f.ok('review-progress', 'T1', '--step', '1', '--agent', 'reviewer-b')
  f.ok('review-progress', 'T1', '--step', '2', '--agent', 'reviewer-b')
  f.ok('validate', 'T1', '--ok', '--evidence', 'corrective review', '--cwd', f.project)
  const reused = f.ok('show-check', 'T1', '--check', '1', '--attempt', '2')
  assert.match(reused.output, /reutilizada sim/)
  assert.match(reused.output, /código de saída: 0/)
  assert.ok(reused.output.includes(`diretório de trabalho: ${f.project}`))
  const checks = f.events().trim().split('\n').map(JSON.parse).filter(event => event.type === 'task_check' && event.attempt === 2)
  assert.deepEqual(checks.map(event => [event.current, event.status]), [[1, 'reused'], [2, 'started'], [2, 'passed']])
  assert.equal(readFileSync(join(f.project, 'first.count'), 'utf8'), 'x')
  assert.equal(readFileSync(join(f.project, 'second.count'), 'utf8'), 'xx')
})

test('new tasks require researched planning before execution and still require independent behavioral review', t => {
  const f = fixture(t, [{ id: 'T1', title: 'Delivery estimate' }, { id: 'T2', title: 'Dependent delivery', deps: ['T1'] }])
  assert.equal(f.graph().derived.T1.effective, 'ready_for_discussion')
  assert.equal(f.graph().derived.T2.effective, 'waiting')
  f.rejected(/completed current planning/, 'start', 'T1', '--agent', 'executor', '--force')
  f.rejected(/still waiting on: T1/, 'begin-discussion', 'T2')
  assert.match(f.ok('ready').output, /T1.*ready_for_discussion/)
  f.beginPlan('T1', 'planner')
  assert.equal(f.graph().derived.T1.effective, 'planning')
  assert.equal(f.state().tasks.T1.attempts.length, 0)
  assert.match(f.ok('status').output, /@planner/)
  f.rejected(/not pending/, 'start', 'T1', '--agent', 'executor', '--force')
  assert.match(f.finish().stdout, /declares no writes/)
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
  assert.equal(f.graph().derived.T2.effective, 'ready_for_discussion')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
})

test('discussion is persisted before questions and must close before a planner is dispatched', t => {
  const f = fixture(t)
  f.rejected(/completed current discussion/, 'plan-task', 'T1', '--agent', 'planner')
  f.ok('begin-discussion', 'T1')
  const baseline = f.state(), events = f.events()
  assert.equal(baseline.tasks.T1.state, 'discussing')
  assert.match(baseline.tasks.T1.discussionAttempts[0].roundId, /^[0-9a-f-]{36}$/)
  const issued = baseline.tasks.T1.discussionAttempts[0]
  const wrongRound = { ...f.discovery(), roundId: 'wrong-round', nonce: issued.nonce,
    questions: f.discovery().questions.map(question => ({ ...question, roundId: 'wrong-round' })) }
  f.rejected(/roundId and nonce/, 'finish-discussion', 'T1', '--context', f.contextPath(wrongRound))
  assert.deepEqual(f.state(), baseline)
  for (const change of [
    { questions: [] },
    { questions: [{ question: 'What changes?', answer: '', channel: 'chat-fallback', round: 1 }] },
    { questions: [{ question: 'What changes?', answer: 'Approved answer', channel: 'unknown', round: 1 }] },
    { coverage: { problem: 'Only one area' } },
    { executionBoundary: undefined },
    { closure: '' },
  ]) {
    const round = baseline.tasks.T1.discussionAttempts[0]
    const candidate = { ...f.discovery(), ...change, roundId: round.roundId, nonce: round.nonce }
    candidate.questions = (candidate.questions ?? []).map(question => ({ ...question, roundId: round.roundId }))
    f.rejected(/discovery/, 'finish-discussion', 'T1', '--context', f.contextPath(candidate))
    assert.deepEqual(f.state(), baseline)
    assert.equal(f.events(), events)
  }
  const context = f.discovery()
  context.questions.push({ question: 'Is there another consequential gray area?', answer: 'No.', channel: 'native', round: 2 })
  const round = baseline.tasks.T1.discussionAttempts[0]
  context.roundId = round.roundId
  context.nonce = round.nonce
  context.questions = context.questions.map(question => ({ ...question, roundId: round.roundId }))
  f.ok('finish-discussion', 'T1', '--context', f.contextPath(context))
  assert.equal(f.graph().derived.T1.effective, 'ready_to_plan')
  const discussed = f.state()
  f.rejected(/no open discussion/, 'finish-discussion', 'T1', '--context', f.contextPath(context))
  assert.deepEqual(f.state(), discussed)
  f.ok('plan-task', 'T1', '--agent', 'planner')
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

test('sync-plan during task discussion supersedes the stale round before reopening', t => {
  const f = fixture(t)
  f.ok('begin-discussion', 'T1')
  const first = f.state().tasks.T1.discussionAttempts.at(-1)
  f.plan.tasks[0].title = 'Approved homologation correction'
  f.writePlan()
  f.ok('sync-plan', '--plan', f.planPath)
  f.ok('begin-discussion', 'T1')
  const rounds = f.state().tasks.T1.discussionAttempts
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0].roundId, first.roundId)
  assert.equal(rounds[0].result, 'superseded')
  assert.ok(rounds[0].endedAt)
  assert.notEqual(rounds[1].roundId, first.roundId)
})

test('discussion reports premature task work and requires explicit acceptance without reusing it', t => {
  const f = fixture(t)
  f.ok('begin-discussion', 'T1')
  const round = f.state().tasks.T1.discussionAttempts.at(-1)
  const discovery = f.discovery('T1')
  discovery.roundId = round.roundId
  discovery.nonce = round.nonce
  discovery.questions = discovery.questions.map(question => ({ ...question, roundId: round.roundId }))
  discovery.executionBoundary.prematureTaskWork = [{ task: 'T1', action: 'Ran the acceptance query during discussion.' }]
  const path = f.contextPath(discovery)
  const before = f.state()
  f.rejected(/explicit user approval.*--accept-premature-work/, 'finish-discussion', 'T1', '--context', path)
  assert.deepEqual(f.state(), before)
  f.ok('finish-discussion', 'T1', '--context', path, '--accept-premature-work')
  assert.equal(f.state().tasks.T1.discovery.executionBoundary.deferredToExecutor[0], 'T1')
  assert.match(f.events(), /"prematureTaskWork":1/)
})

test('planning is bound to canonical discovery and restarts only when its content changes', t => {
  const f = fixture(t)
  const discoveryA = f.discovery()
  f.beginPlan('T1', 'planner-A', discoveryA)
  const afterA = f.state(), eventsA = f.events()
  const digestA = afterA.tasks.T1.discovery.digest

  f.ok('plan-task', 'T1', '--agent', 'planner-that-must-not-start')
  assert.deepEqual(f.state(), afterA)
  assert.equal(f.events(), eventsA)

  const afterB = f.state(), task = afterB.tasks.T1
  assert.equal(task.discovery.digest, digestA)
  assert.equal(task.planningAttempts.length, 1)

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
  f.rejected(/invalid\.json: .*JSON|invalid\.json: .*property name/i, 'finish-planning', 'T1', '--plan', path)
  f.rejected(/missing\.json: .*does not exist/i, 'finish-planning', 'T1', '--plan', join(f.root, 'missing.json'))
  assert.deepEqual(f.state(), baseline)
  const accepted = { ...f.artifact(), decisions: [{ question: 'Which policy?', answer: 'The approved task specifies 1 day express and 3 days normal.' }],
    openQuestions: [{ question: 'Which policy?', blocking: true, answer: 'Use the approved contract.' }, { question: 'Future holiday policy?', blocking: false }] }
  writeFileSync(path, `\uFEFF${JSON.stringify(accepted)}`)
  f.ok('finish-planning', 'T1', '--plan', path)
  assert.deepEqual(f.state().tasks.T1.taskPlan.steps, accepted.steps)
})

test('planners consume total capacity and cannot share an agent with execution or review', t => {
  const tasks = ['T1', 'T2', 'T3'].map(id => ({ id, title: id }))
  const f = fixture(t, tasks, { maxParallel: 2, maxExecutors: 1 })
  f.planTask('T1')
  f.ok('start', 'T1', '--agent', 'executor')
  f.discuss('T2')
  f.rejected(/already on T1/, 'plan-task', 'T2', '--agent', 'executor', '--force')
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.rejected(/already on T1/, 'plan-task', 'T2', '--agent', 'reviewer')
  f.ok('plan-task', 'T2', '--agent', 'planner')
  f.discuss('T3')
  f.rejected(/agents busy/, 'plan-task', 'T3', '--agent', 'other', '--force')
  assert.match(f.ok('ready').output, /1 in planning.*0 agent slots/)
  f.ok('block', 'T1', '--reason', 'Release review slot')
  f.rejected(/already on T2/, 'plan-task', 'T3', '--agent', 'planner', '--force')
  f.ok('plan-task', 'T3', '--agent', 'third-planner')
  f.finish('T3')
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
    assert.equal(f.graph().derived.T1.effective, 'ready_for_discussion')
    f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
    f.rejected(/completed current planning/, 'start', 'T1', '--agent', 'executor', '--force')
  }
  assert.deepEqual(f.state().tasks.T1.taskPlan, before.taskPlan)
  f.planTask('T1', 'fresh-planner')
  assert.equal(f.state().tasks.T1.planningHistory.length, 2)
  f.ok('start', 'T1', '--agent', 'executor')
})

test('task contract changes require a same-round answered acceptance; skips cannot replace it', t => {
  const f = fixture(t)
  f.discuss()
  assert.equal(f.state().tasks.T1.contractConfirmationRequired, undefined)

  f.planTask('T1', 'first-planner')
  f.plan.tasks[0].title = 'Updated accepted delivery policy'
  f.writePlan()
  const synced = f.ok('sync-plan', '--plan', f.planPath).stdout
  assert.match(synced, /sync-plan warning: T1 discussion was invalidated/)
  assert.ok(f.state().tasks.T1.contractConfirmationRequired)
  for (const command of ['status', 'ready'])
    assert.match(f.ok(command).stdout, /contract confirmation required for task T1/)
  f.rejected(/fresh answered contract confirmation/, 'skip-discussion', 'T1', '--reason', 'Skip is not acceptance', '--confirmed-by-user')
  f.rejected(/fresh answered contract confirmation/, 'skip-planning', 'T1', '--reason', 'Skip is not acceptance', '--confirmed-by-user')

  const begun = f.ok('begin-discussion', 'T1')
  assert.match(begun.stdout, /contract confirmation required/)
  const round = f.state().tasks.T1.discussionAttempts.at(-1)
  assert.deepEqual(round.confirmsContract.map(item => item.task), ['T1'])
  const discovery = f.discovery()
  discovery.roundId = round.roundId
  discovery.nonce = round.nonce
  discovery.questions[0].roundId = round.roundId
  const path = f.contextPath(discovery)
  f.rejected(/confirmsContract matching every current task and digest/, 'finish-discussion', 'T1', '--context', path)

  discovery.questions[0].confirmsContract = [{ task: 'T1', digest: '0'.repeat(64) }]
  writeFileSync(path, JSON.stringify(discovery))
  f.rejected(/confirmsContract matching every current task and digest/, 'finish-discussion', 'T1', '--context', path)

  discovery.questions[0].confirmsContract = round.confirmsContract
  discovery.questions.push({ ...discovery.questions[0], question: 'Stale acceptance?', roundId: 'old-round' })
  discovery.questions[0].confirmsContract = undefined
  writeFileSync(path, JSON.stringify(discovery))
  f.rejected(/confirmsContract matching every current task and digest/, 'finish-discussion', 'T1', '--context', path)

  discovery.questions.pop()
  discovery.questions[0].confirmsContract = round.confirmsContract
  writeFileSync(path, JSON.stringify(discovery))
  f.ok('finish-discussion', 'T1', '--context', path)
  const accepted = f.state().tasks.T1
  assert.equal(accepted.contractConfirmationRequired, null)
  assert.deepEqual(accepted.contractConfirmations.at(-1).contracts, round.confirmsContract)
  f.ok('skip-planning', 'T1', '--reason', 'The user accepted the revised contract and chose direct execution', '--confirmed-by-user')
  assert.equal(f.state().tasks.T1.planningSkips.at(-1).confirmedByUser, true)
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
  const changedWaiver = f.state()
  changedWaiver.tasks.T0.skipReason = 'Recovered legacy waiver changed outside the current engine'
  f.save(changedWaiver)
  assert.equal(f.graph().derived.T1.effective, 'ready_for_discussion')
  f.rejected(/completed current planning/, 'start', 'T1', '--agent', 'executor', '--force')
  assert.deepEqual(f.state().tasks.T1.taskPlan, original)
  f.planTask('T1')
  const state = f.state()
  state.tasks.T0.title = 'Recovered dependency contract changed'
  f.save(state)
  assert.equal(f.graph().derived.T1.effective, 'ready_for_discussion')
  f.rejected(/completed current planning/, 'start', 'T1', '--agent', 'executor')
})

test('real failure requires fresh research for the next attempt and preserves the previous plan and delivery history', t => {
  const f = fixture(t)
  f.planTask()
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'reviewer')
  writeFileSync(join(f.project, 'delivery.cjs'), 'exports.days = () => 99;\n')
  f.rejected(/functional.*failed/, 'validate', 'T1', '--ok', '--evidence', 'Delivery branches returned 99 days', '--cwd', f.project)
  f.ok('fail', 'T1', '--reason', 'Both delivery branches violate the approved policy', '--plan-defect')
  const failed = f.state().tasks.T1
  f.ok('retry', 'T1')
  assert.equal(f.graph().derived.T1.effective, 'ready_for_discussion')
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
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
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
    f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
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
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
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
  for (const field of ['discussionRequired', 'discussionAttempts', 'discoveryRequired', 'planningRequired', 'planner', 'planningAttempts', 'planningHistory']) delete legacy.tasks.T1[field]
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
  f.rejected(/completed current discussion/, 'plan-task', 'T2', '--agent', 'planner')
  assert.equal(f.graph().derived.T2.effective, 'ready_for_discussion')
  f.ok('fail', 'T1', '--reason', 'Legacy real failure')
  f.ok('retry', 'T1')
  f.ok('start', 'T1', '--agent', 'legacy-executor-v2')
  assert.equal(f.state().tasks.T1.attempts.length, 2)
})

test('legacy discussion adoption is explicit, atomic and limited to one eligible task', t => {
  const f = fixture(t, [{ id: 'T1', title: 'Adopt this task' }, { id: 'T2', title: 'Keep legacy' }])
  const legacy = f.state()
  for (const task of Object.values(legacy.tasks)) {
    for (const field of ['discussionRequired', 'discoveryRequired', 'planningRequired', 'planner']) delete task[field]
    task.discussionAttempts = [{ roundId: 'old-discussion', endedAt: '2025-01-01T00:00:00.000Z', result: 'closed' }]
    task.planningAttempts = [{ n: 1, endedAt: '2025-01-01T00:00:00.000Z', result: 'planned' }]
    task.planningHistory = [{ planner: 'old-planner', completedAt: '2025-01-01T00:00:00.000Z' }]
    task.notes.push({ text: 'preserve me', at: '2025-01-01T00:00:00.000Z' })
  }
  legacy.tasks.T1.state = 'failed'
  f.save(legacy)
  const untouched = structuredClone(legacy.tasks.T2)

  f.rejected(/--adopt-legacy/, 'begin-discussion', 'T2')
  assert.deepEqual(f.state().tasks.T2, untouched)
  f.ok('begin-discussion', 'T1', '--adopt-legacy')

  const adopted = f.state().tasks.T1
  assert.equal(adopted.state, 'discussing')
  assert.equal(adopted.discussionRequired, true)
  assert.equal(adopted.discoveryRequired, true)
  assert.equal(adopted.planningRequired, true)
  assert.equal(adopted.notes[0].text, 'preserve me')
  assert.equal(adopted.planningHistory[0].planner, 'old-planner')
  assert.equal(adopted.planningAttempts[0].result, 'planned')
  assert.equal(adopted.discussionAttempts[0].result, 'closed')
  assert.match(adopted.discussionAttempts.at(-1).roundId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(f.state().tasks.T2, untouched)
  const event = f.events().trim().split('\n').map(JSON.parse).at(-1)
  assert.equal(event.type, 'task_discussion')
  assert.equal(event.task, 'T1')
  assert.equal(event.adoptedLegacy, true)
  const discovery = f.discovery(), round = adopted.discussionAttempts.at(-1)
  discovery.roundId = round.roundId
  discovery.nonce = round.nonce
  discovery.questions = discovery.questions.map(question => ({ ...question, roundId: round.roundId }))
  f.ok('finish-discussion', 'T1', '--context', f.contextPath(discovery))
  assert.equal(f.graph().derived.T1.effective, 'ready_to_plan')
})

test('legacy discussion adoption refuses unsafe tasks without changing state or events', t => {
  const f = fixture(t)
  const initial = f.state().tasks.T1
  const legacy = overrides => ({ ...structuredClone(initial), discussionRequired: undefined,
    discoveryRequired: undefined, planningRequired: undefined, ...overrides })
  const cases = [
    ['running state', /only while pending or failed/, legacy({ state: 'running' })],
    ['terminal state', /only while pending or failed/, legacy({ state: 'done' })],
    ['execution history', /after execution started/, legacy({ state: 'failed', attempts: [{ n: 1, result: 'failed' }] })],
    ['open discussion', /open discussion or planning round/, legacy({ state: 'pending', discussionAttempts: [{ startedAt: '2025-01-01T00:00:00.000Z' }] })],
    ['open planning', /open discussion or planning round/, legacy({ state: 'pending', planningAttempts: [{ startedAt: '2025-01-01T00:00:00.000Z' }] })],
  ]
  for (const [label, pattern, task] of cases) {
    const state = f.state()
    state.tasks.T1 = task
    f.save(state)
    const statePath = join(f.root, '.specs/graph/planning/state.json')
    const beforeState = readFileSync(statePath, 'utf8')
    const beforeEvents = f.events()
    f.rejected(pattern, 'begin-discussion', 'T1', '--adopt-legacy')
    assert.equal(readFileSync(statePath, 'utf8'), beforeState, label)
    assert.equal(f.events(), beforeEvents, label)
  }

  const blocked = fixture(t, [{ id: 'T1', title: 'Dependency' }, { id: 'T2', title: 'Blocked legacy', deps: ['T1'] }])
  const state = blocked.state()
  delete state.tasks.T2.discussionRequired
  blocked.save(state)
  const statePath = join(blocked.root, '.specs/graph/planning/state.json')
  const beforeState = readFileSync(statePath, 'utf8'), beforeEvents = blocked.events()
  blocked.rejected(/still waiting on: T1/, 'begin-discussion', 'T2', '--adopt-legacy')
  assert.equal(readFileSync(statePath, 'utf8'), beforeState)
  assert.equal(blocked.events(), beforeEvents)
})

test('1.2.0 planning tasks remain compatible without a retroactive discovery gate', t => {
  const f = fixture(t)
  const previous = f.state()
  delete previous.tasks.T1.discussionRequired
  delete previous.tasks.T1.discussionAttempts
  delete previous.tasks.T1.discoveryRequired
  f.save(previous)
  f.ok('plan-task', 'T1', '--agent', 'previous-planner')
  assert.equal(f.state().tasks.T1.state, 'planning')
  assert.match(f.finish().stdout, /declares no writes/)
  assert.equal(f.graph().derived.T1.effective, 'ready')
})

test('task plans persist declared resources and manual inspection clears after current reviewer approval', t => {
  const f = fixture(t, [{ id: 'T1', title: 'Manual review', touches: ['./delivery.cjs//'],
    unavailable: ['database', 'manual-inspection'] }])
  f.beginPlan()
  const artifact = { ...f.artifact(), verification: [{ criterion: 'delivery behavior passes', check: 1,
    requires: ['database', 'manual-inspection'] }], writes: ['./delivery.cjs'] }
  const finished = f.finish('T1', artifact)
  assert.match(finished.stdout, /task T1 verification 1 requires unavailable resource database/)
  assert.match(finished.stdout, /task T1 verification 1 requires unavailable resource manual-inspection/)
  const task = f.state().tasks.T1
  assert.deepEqual(task.taskPlan.writes, artifact.writes)
  assert.deepEqual(task.taskPlan.verification[0].requires, artifact.verification[0].requires)
  assert.deepEqual(task.unavailable, ['database', 'manual-inspection'])
  assert.equal(f.graph().derived.T1.manualInspectionPending, true)
  assert.match(f.ok('status').stdout, /Manual inspection pending/)
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('validate', 'T1', '--ok', '--evidence', 'Reviewer inspected the required manual condition and the functional check passed', '--cwd', f.project)
  assert.equal(f.graph().derived.T1.manualInspectionPending, undefined)
  f.ok('done', 'T1')
  assert.equal(f.graph().derived.T1.manualInspectionPending, undefined)
  assert.doesNotMatch(f.ok('status').stdout, /Manual inspection pending/)
})

test('manual inspection becomes pending again when its approved scope changes after review', t => {
  const f = fixture(t, [{ id: 'T1', title: 'Current manual review', touches: ['delivery.cjs'], unavailable: ['manual-inspection'] }])
  f.beginPlan()
  f.finish('T1', { ...f.artifact(), verification: [{ criterion: 'delivery behavior passes', check: 1,
    requires: ['manual-inspection'] }], writes: ['delivery.cjs'] })
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('validate', 'T1', '--ok', '--evidence', 'Current manual inspection passed', '--cwd', f.project)
  assert.equal(f.graph().derived.T1.manualInspectionPending, undefined)

  f.plan.tasks[0].touches = ['delivery.cjs', 'delivery.test.cjs']
  f.writePlan()
  f.ok('sync-plan', '--plan', f.planPath)
  assert.equal(f.graph().derived.T1.manualInspectionPending, true)
})

test('task plan writes must be safe and stay inside normalized touches prefixes', t => {
  const f = fixture(t, [{ id: 'T1', title: 'Scoped write', touches: ['./src///feature/'] }])
  f.beginPlan()
  const base = f.artifact()
  for (const writes of [
    ['/outside/file.mjs'], ['C:/outside/file.mjs'], ['../outside/file.mjs'],
    ['src/../outside.mjs'], ['src/feature\0outside.mjs'], ['src/feature-other/file.mjs'],
    ...(process.platform === 'win32' ? [] : [['SRC/feature/check.mjs']]),
  ]) {
    f.rejected(/task plan writes/, 'finish-planning', 'T1', '--plan', writeFileSyncArtifact(f, { ...base, writes }))
    assert.equal(f.state().tasks.T1.taskPlan, undefined)
  }
  const writes = [process.platform === 'win32' ? 'SRC/FEATURE/check.mjs' : './/src\\feature///check.mjs']
  f.finish('T1', { ...base, writes })
  assert.deepEqual(f.state().tasks.T1.taskPlan.writes, writes)
})

function writeFileSyncArtifact(f, artifact) {
  const path = join(f.root, 'writes-task-plan.json')
  writeFileSync(path, JSON.stringify(artifact))
  return path
}

test('unavailable uses a closed vocabulary and a contract change stales current planning', t => {
  const invalid = fixture(t)
  invalid.plan.tasks[0].unavailable = ['gpu']
  invalid.writePlan()
  const before = invalid.state()
  invalid.rejected(/unavailable must be an array containing only/, 'sync-plan', '--plan', invalid.planPath)
  assert.deepEqual(invalid.state(), before)

  const portuguese = fixture(t, [{ id: 'T1', title: 'Bad resource' }], {}, { lang: 'pt-BR' })
  portuguese.plan.tasks[0].unavailable = ['gpu']
  portuguese.writePlan()
  portuguese.rejected(/tarefa T1: unavailable deve ser uma lista contendo somente/, 'sync-plan', '--plan', portuguese.planPath)

  const f = fixture(t)
  f.beginPlan()
  f.plan.tasks[0].unavailable = ['network']
  f.writePlan()
  assert.match(f.ok('sync-plan', '--plan', f.planPath).stdout, /unavailable/)
  assert.deepEqual(f.state().tasks.T1.unavailable, ['network'])
  f.rejected(/planning is stale/, 'finish-planning', 'T1', '--plan', writeFileSyncArtifact(f, f.artifact()))
})

test('verification requires rejects resources outside the closed vocabulary', t => {
  const f = fixture(t)
  f.beginPlan()
  f.rejected(/verification requires must be an array containing only/, 'finish-planning', 'T1', '--plan',
    writeFileSyncArtifact(f, { ...f.artifact(), verification: [{ criterion: 'delivery behavior passes', check: 1, requires: ['gpu'] }] }))
  assert.equal(f.state().tasks.T1.taskPlan, undefined)
})

test('init and sync-plan warn on missing touches paths, suggest close paths and allow new folders', t => {
  const existing = fixture(t, [{ id: 'T1', title: 'Existing path', touches: ['delivery.cjs'] }])
  assert.doesNotMatch(existing.ok('sync-plan', '--plan', existing.planPath).stdout, /touches warning/)

  const typo = fixture(t, [{ id: 'T1', title: 'Typo', touches: ['deliveri.cjs'] }])
  assert.match(typo.initialized.stdout, /touches warning/)
  const suggestion = typo.ok('sync-plan', '--plan', typo.planPath).stdout
  assert.match(suggestion, /touches warning/)
  assert.match(suggestion, /closest existing path: delivery\.cjs/)

  const freshFolder = fixture(t, [{ id: 'T1', title: 'New folder', touches: ['new/components/'] }])
  const warning = freshFolder.ok('sync-plan', '--plan', freshFolder.planPath).stdout
  assert.match(warning, /touches warning/)
  assert.match(warning, /new file or folder is allowed/)
  assert.deepEqual(freshFolder.state().tasks.T1.touches, ['new/components/'])
})

test('touches existence check reports when a declared validation cwd is inaccessible', t => {
  const f = fixture(t, [{ id: 'T1', title: 'Remote check', touches: ['delivery.cjs', '../outside'],
    validation: [{ ...check, cwd: join(fixtureTempBase(), 'missing-repository') }] }])
  const output = f.ok('sync-plan', '--plan', f.planPath).stdout
  assert.match(output, /touches check not run/)
  assert.match(output, /inaccessible/)
  assert.match(output, /only repository-relative paths can be checked/)
})

test('status and ready surface contract drift without blocking, and show-contract omits validation commands', t => {
  const f = fixture(t)
  assert.doesNotMatch(f.ok('status').stdout, /contract drift/)
  assert.doesNotMatch(f.ok('ready').stdout, /contract drift/)

  f.plan.tasks[0].title = 'Changed approved title'
  f.plan.tasks[0].validation[0] = { ...f.plan.tasks[0].validation[0],
    run: 'node secret-validation-command.cjs',
    expect: 'The complete user-visible result must hold for every branch.' }
  f.writePlan()
  for (const command of ['status', 'ready']) {
    const output = f.ok(command).stdout
    assert.match(output, /contract drift: task T1 fields: title, validation/)
    assert.doesNotMatch(output, /secret-validation-command/)
  }

  const display = JSON.parse(f.ok('show-contract', 'T1', '--diff').stdout)
  assert.deepEqual(display.fields, ['title', 'validation'])
  assert.equal(display.before.task.title, 'Delivery estimate')
  assert.equal(display.after.task.title, 'Changed approved title')
  assert.equal(display.after.task.validation[0].expect, 'The complete user-visible result must hold for every branch.')
  assert.doesNotMatch(JSON.stringify(display), /secret-validation-command/)

  f.ok('sync-plan', '--plan', f.planPath)
  assert.doesNotMatch(f.ok('status').stdout, /contract drift/)
  assert.doesNotMatch(f.ok('ready').stdout, /contract drift/)
  const history = JSON.parse(f.ok('show-contract', 'T1', '--diff').stdout)
  assert.equal(history.before.task.validation[0].expect, 'Express delivery takes 1 day and normal delivery takes 3 days')
  assert.equal(history.after.task.validation[0].expect, 'The complete user-visible result must hold for every branch.')
  assert.doesNotMatch(JSON.stringify(history), /secret-validation-command/)

  rmSync(f.planPath)
  assert.match(f.ok('status').stdout, /approved plan source unavailable \(missing\)/)
  assert.match(f.ok('ready').stdout, /approved plan source unavailable \(missing\)/)
  writeFileSync(f.planPath, '{invalid json')
  assert.match(f.ok('status').stdout, /approved plan source unavailable \(unreadable\)/)
  assert.match(f.ok('ready').stdout, /approved plan source unavailable \(unreadable\)/)
})

test('task planning status shows age and accepted artifact counts', t => {
  const f = fixture(t)
  f.beginPlan()
  for (const command of ['status', 'ready'])
    assert.match(f.ok(command).stdout, /planning round T1 \(1\) open for \d+s; artifacts 0\/1/)
  f.finish()
  for (const command of ['status', 'ready'])
    assert.match(f.ok(command).stdout, /planning round T1 \(1\) completed for \d+s; artifacts 1\/1/)
})

function fixtureTempBase() {
  return tmpdir()
}

test('task labels and summaries persist while text-only sync leaves the approved plan current', t => {
  const f = fixture(t, [{ id: 'T1', title: 'Delivery estimate', label: 'a'.repeat(24),
    summary: 'Customers get the approved delivery estimate.', validationSummary: 'Both delivery cases pass.' }])
  const initialized = f.state().tasks.T1
  assert.equal(initialized.label, 'a'.repeat(24), 'the maximum 24-character label is accepted')
  assert.equal(initialized.summary, 'Customers get the approved delivery estimate.')
  assert.equal(initialized.validationSummary, 'Both delivery cases pass.')

  f.planTask()
  const planned = structuredClone(f.state().tasks.T1)
  Object.assign(f.plan.tasks[0], {
    label: 'Entrega',
    summary: 'Customers see the estimate before choosing delivery.',
    validationSummary: 'Express shows one day; normal shows three.',
  })
  f.writePlan()
  f.ok('sync-plan', '--plan', f.planPath)

  const updated = f.state().tasks.T1
  assert.equal(updated.label, 'Entrega')
  assert.equal(updated.summary, 'Customers see the estimate before choosing delivery.')
  assert.equal(updated.validationSummary, 'Express shows one day; normal shows three.')
  assert.deepEqual(updated.taskPlan, planned.taskPlan, 'text-only plan sync preserves the recorded plan')
  for (const field of ['scopeRevision', 'planningRevision', 'contractRevision'])
    assert.equal(updated[field], planned[field], field + ' is unchanged')
  assert.equal(f.graph().derived.T1.effective, 'ready')
  const sync = JSON.parse(f.events().trim().split(/\r?\n/).at(-1))
  assert.deepEqual(sync.metadataUpdated, ['T1'])

  f.ok('start', 'T1', '--agent', 'executor')
  assert.equal(f.state().tasks.T1.state, 'running', 'the current plan remains executable')
})

test('empty task summaries and malformed labels are rejected by plan synchronization', t => {
  for (const field of ['summary', 'validationSummary']) {
    const f = fixture(t)
    f.plan.tasks[0][field] = '  \n'
    f.writePlan()
    const before = f.state(), events = f.events()
    f.rejected(new RegExp(`task T1 ${field} must be a nonempty string`), 'sync-plan', '--plan', f.planPath)
    assert.deepEqual(f.state(), before)
    assert.equal(f.events(), events)
  }

  for (const label of ['', 'four words are too many', '1234567890123456789012345', 7]) {
    const f = fixture(t)
    f.plan.tasks[0].label = label
    f.writePlan()
    const before = f.state(), events = f.events()
    f.rejected(/task T1 label must have 1 to 3 words and no more than 24 characters/, 'sync-plan', '--plan', f.planPath)
    assert.deepEqual(f.state(), before)
    assert.equal(f.events(), events)
  }

  const invalidInit = fixture(t)
  invalidInit.plan.tasks[0].label = 'four words are too many'
  invalidInit.writePlan()
  invalidInit.rejected(/task T1 label must have 1 to 3 words and no more than 24 characters/,
    'init', '--plan', invalidInit.planPath, '--run', 'invalid-label')

  const localized = fixture(t, [{ id: 'T1', title: 'Delivery estimate' }], {}, { lang: 'pt-BR' })
  localized.plan.tasks[0].label = 'quatro palavras no rotulo'
  localized.writePlan()
  localized.rejected(/rótulo da tarefa T1/, 'sync-plan', '--plan', localized.planPath)
})

test('task-plan summaries are validated and their content digest is stable across replanning attempts', t => {
  const f = fixture(t)
  f.beginPlan()
  const invalidPath = join(f.root, 'empty-summary.json')
  writeFileSync(invalidPath, JSON.stringify({ ...f.artifact(), summary: '  ' }))
  const before = f.state()
  f.rejected(/task plan summary must be a nonempty string/, 'finish-planning', 'T1', '--plan', invalidPath)
  assert.deepEqual(f.state(), before)

  const artifact = { ...f.artifact(), summary: 'Reuse the existing boundary so invalid estimates are rejected before delivery.' }
  f.finish('T1', artifact)
  const initial = f.state().tasks.T1.taskPlan
  const firstDigest = initial.digest
  assert.match(firstDigest, /^[a-f0-9]{64}$/)

  // A run written before plan digests existed can start; the engine fills the identity from content.
  const legacy = f.state()
  legacy.tasks.T1.taskPlan.summary = 'A display-only summary changed after planning.'
  delete legacy.tasks.T1.taskPlan.digest
  f.save(legacy)
  f.ok('start', 'T1', '--agent', 'executor-1')
  const firstAttempt = f.state().tasks.T1.attempts[0]
  assert.equal(firstAttempt.planDigest, firstDigest)
  assert.equal(f.state().tasks.T1.taskPlan.digest, firstDigest)
  assert.equal(f.state().tasks.T1.taskPlan.summary, 'A display-only summary changed after planning.')
  assert.match(f.ok('status').stdout, new RegExp(`Plan ${firstDigest.slice(0, 4)}`))
  let starts = f.events().trim().split(/\r?\n/).map(JSON.parse).filter(event => event.type === 'task_start')
  assert.equal(starts.at(-1).planDigest, firstDigest.slice(0, 4))

  f.ok('review', 'T1', '--agent', 'reviewer-1')
  f.ok('fail', 'T1', '--reason', 'The plan missed a required delivery branch', '--plan-defect')
  f.ok('retry', 'T1')
  f.beginPlan('T1', 'planner-2')
  f.finish('T1', artifact)
  const repeated = f.state().tasks.T1.taskPlan
  assert.notEqual(repeated.completedAt, initial.completedAt)
  assert.equal(repeated.digest, firstDigest, 'summary text and recording times do not change plan identity')
  f.ok('start', 'T1', '--agent', 'executor-2')

  f.ok('review', 'T1', '--agent', 'reviewer-2')
  f.ok('fail', 'T1', '--reason', 'The plan still missed a required branch', '--plan-defect')
  f.ok('retry', 'T1')
  f.beginPlan('T1', 'planner-3')
  f.finish('T1', { ...artifact, steps: [...artifact.steps, 'Compare the normal-delivery branch against the approved result.'] })
  const changedDigest = f.state().tasks.T1.taskPlan.digest
  assert.notEqual(changedDigest, firstDigest, 'a plan-content change gets a new identity')
  f.ok('start', 'T1', '--agent', 'executor-3')

  const attempts = f.state().tasks.T1.attempts
  assert.deepEqual(attempts.map(attempt => attempt.planDigest), [firstDigest, firstDigest, changedDigest])
  starts = f.events().trim().split(/\r?\n/).map(JSON.parse).filter(event => event.type === 'task_start')
  assert.deepEqual(starts.map(event => event.planDigest), [
    firstDigest.slice(0, 4), firstDigest.slice(0, 4), changedDigest.slice(0, 4),
  ])
})

test('validation summary remains optional, nonblank when present, and separate from full evidence', t => {
  const f = fixture(t)
  f.planTask()
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'reviewer')
  const before = f.state(), events = f.events()
  f.rejected(/validation summary must be a nonempty string/, 'validate', 'T1', '--ok',
    '--summary', '', '--evidence', 'All delivery observations are recorded.', '--cwd', f.project)
  assert.deepEqual(f.state(), before)
  assert.equal(f.events(), events)

  const summary = 'As duas estimativas aprovadas são exibidas.\nO aceite foi conferido integralmente.  '
  const evidence = 'node delivery.test.cjs retornou sucesso para os dois cenários.\nEVIDENCE_END.'
  f.ok('validate', 'T1', '--ok', '--summary', summary, '--evidence', evidence, '--cwd', f.project)
  const receipt = f.state().tasks.T1.validations.at(-1)
  assert.equal(receipt.summary, summary)
  assert.equal(receipt.evidence, evidence)
  const event = JSON.parse(f.events().trim().split(/\r?\n/).at(-1))
  assert.equal(event.type, 'task_validate')
  assert.equal(event.summary, summary)
  assert.equal(event.evidence, evidence)
})
