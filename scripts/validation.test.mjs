import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'

const engine = resolve(process.env.GRAPH_TEST_ENGINE ?? join(dirname(fileURLToPath(import.meta.url)), 'engine.mjs'))
const staticStep = { run: 'node --check delivery.cjs', kind: 'static', expect: 'valid JavaScript syntax' }
const functionalStep = { run: 'node delivery.test.cjs', kind: 'functional', expect: 'express delivery is 1 day; normal delivery is 3 days' }

function fixture(t, task = {}, planOptions = {}, { init = true } = {}) {
  const parent = resolve(tmpdir())
  const home = mkdtempSync(join(parent, 'graph-validation-'))
  t.after(() => {
    assert.equal(dirname(home), parent)
    assert.ok(home.startsWith(join(parent, 'graph-validation-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  const root = join(home, 'workspace')
  const project = join(home, 'project with spaces')
  mkdirSync(root)
  mkdirSync(project)
  writeFileSync(join(project, 'delivery.cjs'), 'exports.days = express => express ? 1 : 3;\n')
  writeFileSync(join(project, 'delivery.test.cjs'), "const assert = require('node:assert/strict'); const {days} = require('./delivery.cjs'); assert.equal(days(true),1); assert.equal(days(false),3); console.log('2 delivery scenarios passed');\n")
  const plan = { name: 'validation-regression', ...planOptions, tasks: [{ id: 'T1', title: 'Delivery estimate', validation: [staticStep, functionalStep], ...task }, ...(planOptions.tasks ?? [])] }
  const planPath = join(root, 'plan.json')
  writeFileSync(planPath, JSON.stringify(plan))
  const env = { ...process.env, GRAPH_FOREMAN_HOME: home, GRAPH_ROOT: root, PRUMO_HOME: home, PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  const options = { env, cwd: project, encoding: 'utf8', timeout: 20000 }
  function cli(...args) {
    const r = spawnSync(process.execPath, [engine, ...args], options)
    assert.ifError(r.error)
    return { ...r, output: r.stdout + r.stderr }
  }
  function ok(...args) {
    const r = cli(...args)
    assert.equal(r.status, 0, r.output)
    return r
  }
  function rejected(pattern, ...args) {
    const r = cli(...args)
    assert.notEqual(r.status, 0, r.output)
    assert.match(r.output, pattern)
    return r
  }
  const statePath = join(root, '.specs/graph/regression/state.json')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const save = (value) => writeFileSync(statePath, JSON.stringify(value))
  const validate = (...extra) => cli('validate', 'T1', '--ok', '--evidence', 'Reviewed both delivery scenarios against the implementation', '--cwd', project, ...extra)
  function beginReview() {
    ok('start', 'T1', '--agent', 'executor')
    ok('review', 'T1', '--agent', 'reviewer')
  }
  if (init) ok('init', '--plan', planPath, '--run', 'regression')
  const events = () => readFileSync(join(root, '.specs/graph/regression/events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
  return { cli, ok, rejected, state, save, project, validate, beginReview, options, plan, planPath, events }
}

test('unblock restores running work and contract refresh can be reviewed in the same attempt', (t) => {
  const f = fixture(t)
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('note', 'T1', '--text', 'Delivered work preserved')
  const before = f.state().tasks.T1
  f.ok('block', 'T1', '--reason', 'Wait for contract clarification')
  f.plan.tasks[0].validation[1] = { ...functionalStep, timeoutMs: 900000 }
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('refresh-contract', 'T1', '--plan', f.planPath)
  f.ok('unblock', 'T1')
  assert.equal(f.state().tasks.T1.state, 'running')
  assert.deepEqual(f.state().tasks.T1.attempts, before.attempts)
  assert.deepEqual(f.state().tasks.T1.notes, before.notes)
  f.ok('review', 'T1', '--agent', 'reviewer')
  assert.equal(f.validate().status, 0)
  f.ok('done', 'T1')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
  assert.equal(f.events().filter(e => e.type === 'task_start').length, 1)
})

test('unblock with reviewer hands delivered work directly to review without acquiring an executor slot', (t) => {
  const f = fixture(t, {}, { maxExecutors: 1, maxParallel: 2, tasks: [{ id: 'T2', title: 'Other work', validation: [functionalStep] }] })
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('block', 'T1', '--reason', 'Pause delivered work')
  f.ok('start', 'T2', '--agent', 'other-executor')
  const before = f.state()
  f.rejected(/executors already running/, 'unblock', 'T1')
  assert.deepEqual(f.state(), before)
  f.ok('unblock', 'T1', '--reviewer', 'reviewer')
  const task = f.state().tasks.T1
  assert.equal(task.state, 'reviewing')
  assert.equal(task.agent, 'executor')
  assert.equal(task.reviewer, 'reviewer')
  assert.equal(task.attempts.length, 1)
  assert.equal(task.attempts[0].startedAt, before.tasks.T1.attempts[0].startedAt)
  f.rejected(/no passing validation/, 'done', 'T1')
  assert.equal(f.validate().status, 0)
  f.ok('done', 'T1')
  assert.equal(f.events().filter(e => e.task === 'T1' && e.type === 'task_start').length, 1)
})

test('repeated block preserves the original phase and completed review evidence', (t) => {
  const f = fixture(t)
  f.beginReview()
  assert.equal(f.validate().status, 0)
  const before = f.state().tasks.T1
  f.ok('block', 'T1', '--reason', 'Waiting for decision')
  f.ok('block', 'T1', '--reason', 'Clarified reason')
  assert.equal(f.state().tasks.T1.stateBeforeBlock, 'reviewing')
  assert.equal(f.state().tasks.T1.blockReason, 'Clarified reason')
  assert.equal(f.events().filter(e => e.type === 'task_block').length, 1)
  f.ok('unblock', 'T1')
  assert.equal(f.state().tasks.T1.state, 'reviewing')
  assert.deepEqual(f.state().tasks.T1.attempts, before.attempts)
  assert.deepEqual(f.state().tasks.T1.validations, before.validations)
  f.ok('done', 'T1')
})

test('pending and failed tasks restore their phase without bypassing dependencies or retries', (t) => {
  const f = fixture(t, { deps: ['T0'] }, { tasks: [{ id: 'T0', title: 'Prerequisite', validation: [functionalStep] }] })
  f.ok('block', 'T1', '--reason', 'Planning pause')
  const before = f.state()
  f.rejected(/paused active attempt/, 'unblock', 'T1', '--reviewer', 'reviewer', '--force')
  assert.deepEqual(f.state(), before)
  f.ok('unblock', 'T1')
  assert.equal(f.state().tasks.T1.state, 'pending')
  assert.equal(f.state().tasks.T1.attempts.length, 0)
  f.rejected(/still waiting on: T0/, 'start', 'T1', '--agent', 'executor')
  f.ok('skip', 'T0', '--reason', 'Prerequisite explicitly waived in this fixture')
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('fail', 'T1', '--reason', 'Actual defect')
  const attempts = f.state().tasks.T1.attempts
  f.ok('block', 'T1', '--reason', 'Wait before retrying')
  f.rejected(/paused active attempt/, 'unblock', 'T1', '--reviewer', 'reviewer')
  f.ok('unblock', 'T1')
  assert.equal(f.state().tasks.T1.state, 'failed')
  assert.deepEqual(f.state().tasks.T1.attempts, attempts)
  f.rejected(/not pending/, 'start', 'T1', '--agent', 'executor')
  f.ok('retry', 'T1')
  f.ok('start', 'T1', '--agent', 'executor')
  assert.equal(f.state().tasks.T1.attempts.length, 2)
})

test('active resume checks total capacity and agent ownership, including reviewer replacement', (t) => {
  const f = fixture(t, {}, { maxExecutors: 1, maxParallel: 2, tasks: [
    { id: 'T2', title: 'Second', validation: [functionalStep] },
    { id: 'T3', title: 'Third', validation: [functionalStep] }
  ] })
  f.beginReview()
  f.ok('block', 'T1', '--reason', 'Pause review')
  f.ok('start', 'T2', '--agent', 'second-executor')
  f.ok('review', 'T2', '--agent', 'reviewer')
  const before = f.state()
  f.rejected(/agent "reviewer" is already on T2/, 'unblock', 'T1')
  assert.deepEqual(f.state(), before)
  f.ok('start', 'T3', '--agent', 'third-executor')
  const full = f.state()
  f.rejected(/agents busy/, 'unblock', 'T1', '--reviewer', 'replacement')
  assert.deepEqual(f.state(), full)
  f.ok('block', 'T3', '--reason', 'Release slot')
  f.ok('unblock', 'T1', '--reviewer', 'replacement')
  assert.equal(f.state().tasks.T1.reviewer, 'replacement')
  assert.equal(f.state().tasks.T1.attempts.length, 1)

  const running = fixture(t, {}, { tasks: [{ id: 'T2', title: 'Other', validation: [functionalStep] }] })
  running.ok('start', 'T1', '--agent', 'executor')
  running.ok('block', 'T1', '--reason', 'Pause executor')
  running.ok('start', 'T2', '--agent', 'executor')
  running.rejected(/agent "executor" is already on T2/, 'unblock', 'T1')
  running.ok('unblock', 'T1', '--reviewer', 'independent-reviewer')
})

test('unblock rechecks dependencies and keeps failures atomic', (t) => {
  const f = fixture(t, {}, { tasks: [{ id: 'T0', title: 'Prerequisite', validation: [functionalStep] }] })
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('block', 'T1', '--reason', 'Dependency changed in approved plan')
  const state = f.state()
  state.tasks.T1.deps = ['T0']
  f.save(state)
  f.rejected(/still waiting on: T0/, 'unblock', 'T1', '--reviewer', 'reviewer')
  assert.deepEqual(f.state(), state)
  f.ok('skip', 'T0', '--reason', 'Dependency explicitly resolved in fixture')
  f.ok('unblock', 'T1', '--reviewer', 'reviewer')
})

test('direct review still requires an independent agent and an open attempt', (t) => {
  const f = fixture(t)
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('block', 'T1', '--reason', 'Pause')
  const before = f.state()
  f.rejected(/independent reviewer/, 'unblock', 'T1', '--reviewer', 'executor', '--force')
  f.rejected(/recorded agent/, 'unblock', 'T1', '--reviewer', '')
  assert.deepEqual(f.state(), before)
  const closed = f.state()
  closed.tasks.T1.attempts[0].result = 'failed'
  f.save(closed)
  f.rejected(/open attempt/, 'unblock', 'T1', '--reviewer', 'reviewer', '--force')
  assert.deepEqual(f.state(), closed)
})

test('legacy origin is only defaulted for unstarted tasks; completed tasks cannot be paused', (t) => {
  const fresh = fixture(t)
  const legacy = fresh.state()
  legacy.tasks.T1.state = 'blocked'
  fresh.save(legacy)
  fresh.ok('unblock', 'T1')
  assert.equal(fresh.state().tasks.T1.state, 'pending')
  fresh.ok('start', 'T1', '--agent', 'executor')
  fresh.ok('block', 'T1', '--reason', 'Pause')
  for (const origin of [null, 'blocked', 'unknown']) {
    const bad = fresh.state()
    bad.tasks.T1.stateBeforeBlock = origin
    fresh.save(bad)
    fresh.rejected(/cannot restore stateBeforeBlock/, 'unblock', 'T1', '--force')
    assert.deepEqual(fresh.state(), bad)
  }
  for (const status of ['done', 'skipped']) {
    const f = fixture(t)
    if (status === 'done') {
      f.beginReview()
      assert.equal(f.validate().status, 0)
      f.ok('done', 'T1')
    } else f.ok('skip', 'T1', '--reason', 'Explicitly skipped')
    const before = f.state()
    f.rejected(/completed tasks cannot be paused/, 'block', 'T1', '--reason', 'Invalid pause', '--force')
    assert.deepEqual(f.state(), before)
  }
})

test('pause and resume during validation cannot revive the in-flight result', async (t) => {
  const f = fixture(t, { validation: [{ ...functionalStep, run: 'node slow.test.cjs' }] })
  writeFileSync(join(f.project, 'slow.test.cjs'), "require('node:fs').writeFileSync('started','yes'); setTimeout(() => require('./delivery.test.cjs'),1500);\n")
  f.beginReview()
  const attempts = f.state().tasks.T1.attempts
  const child = spawn(process.execPath, [engine, 'validate', 'T1', '--ok', '--evidence', 'Reviewed slow test', '--cwd', f.project], f.options)
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const completed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  for (let i = 0; i < 100 && !existsSync(join(f.project, 'started')); i++) await setTimeout(30)
  assert.ok(existsSync(join(f.project, 'started')))
  f.ok('block', 'T1', '--reason', 'Pause validation')
  f.ok('unblock', 'T1')
  assert.notEqual(await completed, 0, output)
  assert.match(output, /task changed during validation/)
  assert.equal(f.state().tasks.T1.state, 'reviewing')
  assert.deepEqual(f.state().tasks.T1.attempts, attempts)
  f.rejected(/no passing validation/, 'done', 'T1')
})

test('the same lifecycle validates data, automation and migration artifacts without domain rules in the engine', (t) => {
  const examples = [
    { title: 'Data reconciliation', input: '[10,20,30]', output: 'total.json',
      execute: "writeFileSync('total.json',JSON.stringify(JSON.parse(readFileSync('input.json')).reduce((a,b)=>a+b,0)))",
      verify: "assert.equal(JSON.parse(readFileSync('total.json')),60)" },
    { title: 'Automation result', input: '[{"id":"job-1"}]', output: 'completed.json',
      execute: "writeFileSync('completed.json',JSON.stringify(JSON.parse(readFileSync('input.json')).map(job=>({...job,status:'completed'}))))",
      verify: "assert.deepEqual(JSON.parse(readFileSync('completed.json')),[{id:'job-1',status:'completed'}])" },
    { title: 'Memory migration sample', input: '{"preferences":{"language":"pt-BR"},"decisions":["preserve ids"]}', output: 'target.json',
      execute: "writeFileSync('target.json',readFileSync('input.json'))",
      verify: "assert.deepEqual(JSON.parse(readFileSync('target.json')),JSON.parse(readFileSync('input.json')))" }
  ]
  for (const example of examples) {
    const f = fixture(t, { title: example.title, validation: [{ kind: 'functional', run: 'node verify.cjs', expect: 'The persisted result satisfies the approved criterion' }] })
    writeFileSync(join(f.project, 'input.json'), example.input)
    writeFileSync(join(f.project, 'execute.cjs'), "const {readFileSync,writeFileSync}=require('node:fs');" + example.execute)
    writeFileSync(join(f.project, 'verify.cjs'), "const assert=require('node:assert/strict');const {readFileSync}=require('node:fs');" + example.verify)
    f.ok('start', 'T1', '--agent', 'executor')
    const delivery = spawnSync(process.execPath, ['execute.cjs'], f.options)
    assert.equal(delivery.status, 0, delivery.stderr)
    const delivered = readFileSync(join(f.project, example.output), 'utf8')
    f.ok('block', 'T1', '--reason', 'Pause before independent verification')
    f.ok('unblock', 'T1', '--reviewer', 'reviewer')
    const verify = () => f.cli('validate', 'T1', '--ok', '--evidence', `Checked ${example.output} against the approved result for ${example.title}`, '--cwd', f.project)
    assert.equal(verify().status, 0)
    assert.equal(readFileSync(join(f.project, example.output), 'utf8'), delivered)
    writeFileSync(join(f.project, example.output), 'null')
    assert.notEqual(verify().status, 0)
    f.rejected(/no passing validation/, 'done', 'T1')
    writeFileSync(join(f.project, example.output), delivered)
    assert.equal(verify().status, 0)
    f.ok('done', 'T1')
    assert.equal(f.state().tasks.T1.attempts.length, 1)
  }
})

test('functional task with lint only is refused during plan initialization', (t) => {
  const f = fixture(t, { validation: [staticStep] }, {}, { init: false })
  f.rejected(/requires an executable functional check/, 'init', '--plan', f.planPath, '--run', 'regression', '--force')
})

test('malformed prose, echo instructions and untyped steps cannot enter a functional run', (t) => {
  for (const [validation, error] of [
    ['Tests pass', /functional validation must be a nonempty array/],
    [[{ run: 'echo reviewer-check-this', expect: 'works' }], /requires an executable functional check/],
  ]) {
    const f = fixture(t, { validation }, {}, { init: false })
    f.rejected(error, 'init', '--plan', f.planPath, '--run', 'regression')
  }
})

for (const terminal of ['done', 'skipped']) test(`sync-plan and retry preserve legacy ${terminal} contracts`, (t) => {
  const f = fixture(t, {}, { tasks: [{ id: 'T0', title: 'Historical work', validation: [functionalStep] }] })
  const state = f.state()
  state.tasks.T0.state = terminal
  state.tasks.T0.validation = 'Historical prose'
  f.save(state)
  f.plan.tasks[1].validation = 'Historical prose'
  f.plan.tasks[0].title = 'Updated delivery'
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', f.planPath)
  assert.deepEqual(f.state().tasks.T0, state.tasks.T0)
  assert.equal(f.state().tasks.T1.title, 'Updated delivery')
  Object.assign(f.plan.tasks[1], { validationMode: 'inspection', inspectionReason: 'Historical inspection' })
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', f.planPath)
  assert.deepEqual(f.state().tasks.T0, state.tasks.T0)
  f.ok('start', 'T1', '--executor', 'executor')
  f.ok('fail', 'T1', '--reason', 'Rejected implementation')
  f.ok('retry', 'T1')
  assert.deepEqual(f.state().tasks.T0, state.tasks.T0)
  f.plan.tasks[0].validation = 'Invalid current contract'
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  const before = f.state()
  f.rejected(/functional validation must be a nonempty array/, 'sync-plan', '--plan', f.planPath)
  assert.deepEqual(f.state(), before)
})

test('start rejects conflicting executor aliases without changing state', (t) => {
  const f = fixture(t)
  const before = f.state()
  f.rejected(/must name the same agent/, 'start', 'T1', '--agent', 'one', '--executor', 'two')
  assert.deepEqual(f.state(), before)
})

test('shell-consumed Windows cwd is rejected before recording a gate', (t) => {
  const f = fixture(t)
  f.beginReview()
  const before = f.state()
  f.rejected(/backslashes were consumed.*forward slashes/, 'validate', 'T1', '--ok', '--evidence', 'Review', '--cwd', 'C:workproject')
  assert.deepEqual(f.state(), before)
})

test('a legacy pending run must synchronize a malformed contract before dispatch', (t) => {
  const f = fixture(t)
  const legacy = f.state()
  legacy.tasks.T1.validation = 'Tests pass'
  f.save(legacy)
  f.rejected(/invalid legacy validation contract.*sync-plan before start/, 'start', 'T1', '--agent', 'executor')
  f.ok('sync-plan', '--plan', f.planPath)
  f.ok('start', 'T1', '--agent', 'executor')
})

test('passing functional checks execute real code and record commands, output and directory', (t) => {
  const f = fixture(t)
  f.beginReview()
  const result = f.validate()
  assert.equal(result.status, 0, result.output)
  const receipt = f.state().tasks.T1.validations.at(-1)
  assert.equal(receipt.checks.length, 2)
  assert.equal(receipt.checks[1].cwd, f.project)
  assert.equal(receipt.checks[1].exitCode, 0)
  assert.match(receipt.checks[1].stdout, /2 delivery scenarios passed/)
  f.ok('done', 'T1')
  assert.equal(f.state().tasks.T1.state, 'done')
})

test('syntactically valid behavioral regression passes lint but blocks done', (t) => {
  const f = fixture(t)
  f.beginReview()
  writeFileSync(join(f.project, 'delivery.cjs'), 'exports.days = express => express ? 99 : 3;\n')
  assert.notEqual(f.validate().status, 0)
  const receipt = f.state().tasks.T1.validations.at(-1)
  assert.equal(receipt.checks[0].exitCode, 0)
  assert.equal(receipt.checks[1].exitCode, 1)
  assert.match(receipt.checks[1].stderr, /AssertionError/)
  f.rejected(/no passing validation/, 'done', 'T1')
})

test('documentation inspection accepts evidence without executing the application', (t) => {
  const f = fixture(t, { validationMode: 'inspection', inspectionReason: 'Documentation-only wording; no runtime behavior changes', validation: 'Verify the documented setup commands and links against the repository' })
  f.beginReview()
  f.ok('validate', 'T1', '--ok', '--evidence', 'Compared setup instructions with package scripts and checked relative links')
  f.ok('done', 'T1')
  assert.deepEqual(f.state().tasks.T1.validations.at(-1).checks, [])
})

test('documentation may use a static checker; inspection needs a justification', (t) => {
  const f = fixture(t, { validationMode: 'inspection', inspectionReason: 'Documentation-only syntax example', validation: [staticStep] })
  f.beginReview()
  assert.equal(f.validate().status, 0)
  f.ok('done', 'T1')
  const bad = fixture(t, { validationMode: 'inspection', validation: 'Review docs' }, {}, { init: false })
  bad.rejected(/inspectionReason/, 'init', '--plan', bad.planPath, '--run', 'regression')
})

test('empty evidence and pre-upgrade bare approval cannot reach done', (t) => {
  const f = fixture(t)
  f.beginReview()
  f.rejected(/evidence must not be empty/, 'validate', 'T1', '--ok')
  f.rejected(/evidence must not be empty/, 'validate', 'T1', '--ok', '--evidence', '   ')
  const state = f.state()
  state.tasks.T1.validations.push({ ok: true, by: 'review', agent: 'reviewer', evidence: 'lint passed', attempt: 1 })
  f.save(state)
  f.rejected(/execution receipt/, 'done', 'T1')
})

test('review opt-out does not opt out of functional verification', (t) => {
  const f = fixture(t, { requireReview: false, validation: [staticStep] }, {}, { init: false })
  f.rejected(/requires an executable functional check/, 'init', '--plan', f.planPath, '--run', 'regression')
  const docs = fixture(t, { requireReview: false, validationMode: 'inspection', inspectionReason: 'Documentation only', validation: 'Confirm spelling correction' })
  docs.ok('start', 'T1', '--agent', 'executor')
  docs.ok('validate', 'T1', '--ok', '--evidence', 'Confirmed spelling and unchanged instructions')
  docs.ok('done', 'T1')
})

test('failed revalidation invalidates an earlier passing verdict', (t) => {
  const f = fixture(t)
  f.beginReview()
  assert.equal(f.validate().status, 0)
  writeFileSync(join(f.project, 'delivery.cjs'), 'exports.days = () => 99;\n')
  assert.notEqual(f.validate().status, 0)
  f.rejected(/no passing validation/, 'done', 'T1')
})

test('retry cannot reuse prior attempt checks', (t) => {
  const f = fixture(t)
  f.beginReview()
  assert.equal(f.validate().status, 0)
  f.ok('fail', 'T1', '--reason', 'New correction required')
  f.ok('retry', 'T1')
  f.beginReview()
  f.rejected(/current attempt/, 'done', 'T1')
})

test('passing functional test cannot hide a later failed check or changed contract', (t) => {
  const f = fixture(t, { validation: [functionalStep, { kind: 'static', run: 'node --check missing.cjs', expect: 'syntax valid' }] })
  f.beginReview()
  assert.notEqual(f.validate().status, 0)
  assert.equal(f.state().tasks.T1.validations.at(-1).checks[0].exitCode, 0)
  f.rejected(/no passing validation/, 'done', 'T1')
  const changed = fixture(t)
  changed.beginReview()
  assert.equal(changed.validate().status, 0)
  const state = changed.state()
  state.tasks.T1.validation[1].expect = 'A new business requirement'
  changed.save(state)
  changed.rejected(/execution receipt/, 'done', 'T1')
})

test('missing directory and unavailable command are not passing checks', (t) => {
  const f = fixture(t)
  f.beginReview()
  f.rejected(/absolute --cwd/, 'validate', 'T1', '--ok', '--evidence', 'Reviewed')
  const broken = fixture(t, { validation: [{ kind: 'functional', run: 'node does-not-exist.cjs', expect: 'behavior verified' }] })
  broken.beginReview()
  assert.notEqual(broken.validate().status, 0)
  broken.rejected(/no passing validation/, 'done', 'T1')
})

test('independent reviewer remains mandatory, even with force', (t) => {
  const f = fixture(t)
  f.ok('start', 'T1', '--agent', 'executor')
  assert.notEqual(f.validate().status, 0)
  f.ok('review', 'T1', '--agent', 'executor', '--force')
  assert.notEqual(f.validate('--force').status, 0)
})

test('validation releases run lock and discards results if task changes during execution', async (t) => {
  const f = fixture(t, { validation: [{ kind: 'functional', run: 'node slow.test.cjs', expect: 'delivery scenarios pass' }] })
  writeFileSync(join(f.project, 'slow.test.cjs'), "require('node:fs').writeFileSync('started','yes'); setTimeout(() => require('./delivery.test.cjs'),1500);\n")
  f.beginReview()
  const child = spawn(process.execPath, [engine, 'validate', 'T1', '--ok', '--evidence', 'Reviewed slow test', '--cwd', f.project], f.options)
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const completed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  for (let i = 0; i < 100 && !existsSync(join(f.project, 'started')); i++) await setTimeout(30)
  assert.ok(existsSync(join(f.project, 'started')))
  f.ok('note', 'T1', '--text', 'Concurrent update preserved')
  f.ok('block', 'T1', '--reason', 'Requirements changed during execution')
  assert.notEqual(await completed, 0, output)
  assert.match(output, /task changed during validation/)
  assert.equal(f.state().tasks.T1.validations.at(-1).ok, false)
  assert.equal(f.state().tasks.T1.notes.at(-1).text, 'Concurrent update preserved')
})

test('sync-plan preserves inspection fields and completed history (when supported)', (t) => {
  if (!readFileSync(engine, 'utf8').includes("'sync-plan'()")) return t.skip('This installation has no sync-plan command')
  const f = fixture(t)
  f.plan.tasks[0].validationMode = 'inspection'
  f.plan.tasks[0].inspectionReason = 'Task reduced to documentation only'
  f.plan.tasks[0].validation = 'Verify documentation against source'
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', f.planPath)
  assert.equal(f.state().tasks.T1.validationMode, 'inspection')
  f.beginReview()
  f.ok('validate', 'T1', '--ok', '--evidence', 'Documentation checked against source')
  f.ok('done', 'T1')
  const before = f.state().tasks.T1
  f.plan.tasks[0].inspectionReason = 'Later plan wording'
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', f.planPath)
  assert.deepEqual(f.state().tasks.T1, before)
})

test('explicit business exit codes preserve the real result and still reject unexpected failures', (t) => {
  const f = fixture(t, { validation: [{ ...functionalStep, expectedExitCodes: [0, 3] }] })
  f.beginReview()
  writeFileSync(join(f.project, 'delivery.test.cjs'), "require('node:assert/strict').equal(require('./delivery.cjs').days(true),1); console.log('behavior verified; data warning'); process.exit(3);\n")
  assert.equal(f.validate().status, 0)
  assert.equal(f.state().tasks.T1.validations.at(-1).checks[0].exitCode, 3)
  f.ok('done', 'T1')

  const bad = fixture(t, { validation: [{ ...functionalStep, expectedExitCodes: [0, 3] }] })
  bad.beginReview()
  writeFileSync(join(bad.project, 'delivery.cjs'), 'exports.days = () => 99;\n')
  assert.notEqual(bad.validate().status, 0)
  assert.equal(bad.state().tasks.T1.validations.at(-1).checks[0].exitCode, 1)
  bad.rejected(/no passing validation/, 'done', 'T1', '--force')

  const defaultCodes = fixture(t)
  defaultCodes.beginReview()
  writeFileSync(join(defaultCodes.project, 'delivery.test.cjs'), 'process.exit(3);\n')
  assert.notEqual(defaultCodes.validate().status, 0)
})

test('step env passes values without shell interpolation and records the shell', (t) => {
  const value = 'Development with spaces & = $literal'
  const f = fixture(t, { validation: [{ ...functionalStep, env: { GRAPH_TEST_MODE: value } }] })
  writeFileSync(join(f.project, 'delivery.test.cjs'), `require('node:assert/strict').equal(process.env.GRAPH_TEST_MODE,${JSON.stringify(value)}); require('node:assert/strict').equal(require('./delivery.cjs').days(true),1);\n`)
  f.beginReview()
  const result = f.validate()
  assert.equal(result.status, 0, result.output)
  const receipt = f.state().tasks.T1.validations.at(-1)
  assert.ok(receipt.checks[0].shell)
  assert.equal(receipt.checks[0].timeoutMs, 600000)
  f.ok('done', 'T1')
})

test('Windows Unix-style environment assignment fails plan preflight with an actionable message', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows shell compatibility')
  const f = fixture(t, { validation: [functionalStep, { ...functionalStep, run: 'ASPNETCORE_ENVIRONMENT=Development node delivery.test.cjs' }] }, {}, { init: false })
  f.rejected(/move NAME=value into step.env/, 'init', '--plan', f.planPath, '--run', 'regression')
  assert.equal(existsSync(join(f.project, 'executed')), false)
})

test('Windows env overrides are case-insensitive and an explicit PowerShell command works', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows shell compatibility')
  const f = fixture(t, { validation: [{
    ...functionalStep, env: { graph_test_mode: 'Development' }, shell: 'powershell.exe',
    run: "if ($env:GRAPH_TEST_MODE -ne 'Development') { exit 1 }; node delivery.test.cjs; exit $LASTEXITCODE"
  }] })
  f.options.env.GRAPH_TEST_MODE = 'Inherited value must be overridden'
  f.beginReview()
  const result = f.validate()
  assert.equal(result.status, 0, result.output)
  assert.equal(f.state().tasks.T1.validations.at(-1).checks[0].shell, 'powershell.exe')
  assert.match(f.state().tasks.T1.validations.at(-1).checks[0].stdout, /2 delivery scenarios passed/)
  f.ok('done', 'T1')
})

test('timeouts may be extended or explicitly disabled; actual timeout blocks approval', (t) => {
  for (const timeoutMs of [900000, 0]) {
    const f = fixture(t, { validation: [{ ...functionalStep, timeoutMs }] })
    f.beginReview()
    assert.equal(f.validate().status, 0)
    assert.equal(f.state().tasks.T1.validations.at(-1).checks[0].timeoutMs, timeoutMs)
    f.ok('done', 'T1')
  }
  const f = fixture(t, { validation: [{ ...functionalStep, timeoutMs: 100 }] })
  writeFileSync(join(f.project, 'delivery.test.cjs'), 'setTimeout(() => {}, 400);\n')
  f.beginReview()
  assert.notEqual(f.validate().status, 0)
  assert.match(f.state().tasks.T1.validations.at(-1).checks[0].error, /ETIMEDOUT/)
  f.rejected(/no passing validation/, 'done', 'T1')
})

test('invalid execution options are refused before a run is created', (t) => {
  for (const options of [{ expectedExitCodes: [] }, { expectedExitCodes: [null] }, { env: { MODE: 3 } }, { shell: '' }, { timeoutMs: -1 }]) {
    const f = fixture(t, { validation: [{ ...functionalStep, ...options }] }, {}, { init: false })
    f.rejected(/task T1:/, 'init', '--plan', f.planPath, '--run', 'regression')
  }
})

test('timeout terminates the command and its child process before returning', (t) => {
  const f = fixture(t, { validation: [{ ...functionalStep, timeoutMs: 1000 }] })
  writeFileSync(join(f.project, 'delivery.test.cjs'), "const child = require('node:child_process').spawn(process.execPath,['-e','setTimeout(() => {},10000)'],{stdio:'inherit',windowsHide:true}); require('node:fs').writeFileSync('pids.json', JSON.stringify([process.pid,child.pid]));\n")
  f.beginReview()
  const result = f.validate()
  assert.notEqual(result.status, 0)
  const pids = JSON.parse(readFileSync(join(f.project, 'pids.json'), 'utf8'))
  try {
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert.match(f.state().tasks.T1.validations.at(-1).checks[0].error, /ETIMEDOUT/)
    f.rejected(/no passing validation/, 'done', 'T1')
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch (e) { if (e.code !== 'ESRCH') throw e } }
  }
})

test('output overflow is recorded as a failure, never as a passing process', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.project, 'delivery.test.cjs'), "process.stdout.write('x'.repeat(4*1024*1024+1)); setTimeout(() => {},1000);\n")
  f.beginReview()
  assert.notEqual(f.validate().status, 0)
  assert.match(f.state().tasks.T1.validations.at(-1).checks[1].error, /ENOBUFS/)
  f.rejected(/no passing validation/, 'done', 'T1')
})

test('refresh-contract preserves running, reviewing and blocked work without another attempt', (t) => {
  for (const status of ['running', 'reviewing', 'blocked']) {
    const f = fixture(t)
    f.ok('start', 'T1', '--agent', 'executor')
    if (status === 'reviewing') f.ok('review', 'T1', '--agent', 'reviewer')
    if (status === 'blocked') f.ok('block', 'T1', '--reason', 'User paused while engine is updated')
    f.ok('note', 'T1', '--text', 'Implementation already delivered')
    const before = f.state().tasks.T1
    f.plan.tasks[0].validation[1] = { ...functionalStep, env: { GRAPH_TEST_MODE: 'review' } }
    f.plan.tasks[0].title = 'Unrelated title change must not be applied'
    f.plan.tasks[0].requireReview = false
    writeFileSync(f.planPath, JSON.stringify(f.plan))
    const result = f.ok('refresh-contract', 'T1', '--plan', f.planPath)
    assert.match(result.output, new RegExp(`state ${status}, attempt 1 preserved`))
    assert.deepEqual(f.state().tasks.T1, { ...before, validation: f.plan.tasks[0].validation, contractRevision: 1 })
    const refreshed = f.state()
    f.ok('refresh-contract', 'T1', '--plan', f.planPath)
    assert.deepEqual(f.state(), refreshed)
    if (status === 'blocked') {
      assert.notEqual(f.validate().status, 0)
      assert.equal(f.state().tasks.T1.state, 'blocked')
    }
  }
})

test('contract refresh invalidates old approvals even if the contract is later restored', (t) => {
  const f = fixture(t)
  f.beginReview()
  assert.equal(f.validate().status, 0)
  const before = f.state().tasks.T1
  f.plan.tasks[0].validation[1] = { ...functionalStep, timeoutMs: 900000 }
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('refresh-contract', 'T1', '--plan', f.planPath)
  f.rejected(/execution receipt/, 'done', 'T1', '--force')
  f.plan.tasks[0].validation = before.validation
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('refresh-contract', 'T1', '--plan', f.planPath)
  f.rejected(/contract was refreshed/, 'done', 'T1', '--force')
  assert.deepEqual(f.state().tasks.T1.attempts, before.attempts)
  assert.deepEqual(f.state().tasks.T1.validations, before.validations)
  assert.equal(f.validate().status, 0)
  f.ok('done', 'T1')
})

test('refresh refuses invalid contracts and does not rewrite completed history', (t) => {
  const f = fixture(t)
  f.beginReview()
  const before = f.state()
  f.plan.tasks[0].validation = [staticStep]
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.rejected(/requires an executable functional check/, 'refresh-contract', 'T1', '--plan', f.planPath)
  assert.deepEqual(f.state(), before)
  writeFileSync(f.planPath, JSON.stringify({ tasks: {} }))
  f.rejected(/exactly one task/, 'refresh-contract', 'T1', '--plan', f.planPath)
  assert.deepEqual(f.state(), before)
  assert.equal(f.validate().status, 0)
  f.ok('done', 'T1')
  const done = f.state()
  f.rejected(/completed task contracts are immutable/, 'refresh-contract', 'T1', '--plan', f.planPath, '--force')
  assert.deepEqual(f.state(), done)
})

test('refresh during validation discards the old result without losing the attempt', async (t) => {
  const f = fixture(t, { validation: [{ ...functionalStep, run: 'node slow.test.cjs' }] })
  writeFileSync(join(f.project, 'slow.test.cjs'), "require('node:fs').writeFileSync('started','yes'); setTimeout(() => require('./delivery.test.cjs'),1500);\n")
  f.beginReview()
  const attempts = f.state().tasks.T1.attempts
  const child = spawn(process.execPath, [engine, 'validate', 'T1', '--ok', '--evidence', 'Reviewed slow test', '--cwd', f.project], f.options)
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const completed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  for (let i = 0; i < 100 && !existsSync(join(f.project, 'started')); i++) await setTimeout(30)
  assert.ok(existsSync(join(f.project, 'started')))
  const original = structuredClone(f.plan.tasks[0].validation)
  f.plan.tasks[0].validation[0].timeoutMs = 900000
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('refresh-contract', 'T1', '--plan', f.planPath)
  f.plan.tasks[0].validation = original
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.ok('refresh-contract', 'T1', '--plan', f.planPath)
  assert.notEqual(await completed, 0, output)
  assert.match(output, /task changed during validation/)
  assert.equal(f.state().tasks.T1.validations.at(-1).ok, false)
  assert.deepEqual(f.state().tasks.T1.attempts, attempts)
  assert.equal(f.state().tasks.T1.state, 'reviewing')
})

test('sync-plan reports active contract differences instead of already matches', (t) => {
  if (!readFileSync(engine, 'utf8').includes("'sync-plan'()")) return t.skip('This installation has no sync-plan command')
  const f = fixture(t)
  f.ok('start', 'T1', '--agent', 'executor')
  const before = f.state()
  f.plan.tasks[0].validation[1] = { ...functionalStep, timeoutMs: 900000 }
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  const result = f.ok('sync-plan', '--plan', f.planPath)
  assert.match(result.output, /plan differs for preserved tasks: T1/)
  assert.doesNotMatch(result.output, /already matches/)
  assert.deepEqual(f.state(), before)
  f.ok('refresh-contract', 'T1', '--plan', f.planPath)
  assert.equal(f.state().tasks.T1.state, 'running')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
})

test('real rejection and approved contract change preserve history and verify the new behavior on retry', (t) => {
  const f = fixture(t, { touches: ['delivery.cjs'] }, {
    description: 'Original delivery policy; changes require approval.',
    tasks: [{ id: 'T2', title: 'Independent work', touches: ['other/'], validation: [functionalStep] }],
  })
  f.ok('start', 'T2', '--agent', 'other-executor')
  const other = f.state().tasks.T2
  writeFileSync(join(f.project, 'delivery.cjs'), 'exports.days = () => 3;\n')
  f.beginReview()
  assert.notEqual(f.validate().status, 0)
  const reason = 'review: express delivery returned 3 days instead of 1'
  f.ok('fail', 'T1', '--reason', reason)
  const rejected = f.state().tasks.T1
  const priorEvents = f.events()

  f.plan.description = 'Approved policy update: normal delivery is now 4 days; original policy is superseded.'
  f.plan.tasks[0].title = 'Updated delivery policy'
  f.plan.tasks[0].touches = ['delivery.cjs', 'current-policy.test.cjs']
  f.plan.tasks[0].validation = [staticStep, {
    kind: 'functional', run: 'node current-policy.test.cjs',
    expect: 'express delivery is 1 day; normal delivery is 4 days',
  }]
  writeFileSync(join(f.project, 'current-policy.test.cjs'), "const assert = require('node:assert/strict'); const {days} = require('./delivery.cjs'); assert.equal(days(true),1); assert.equal(days(false),4); console.log('2 current policy scenarios passed');\n")
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  f.rejected(/contract differs from the approved plan.*sync-plan.*before retry/, 'retry', 'T1')
  assert.deepEqual(f.state().tasks.T1, rejected, 'a stale retry must not change the rejected task')
  f.ok('sync-plan', '--plan', f.planPath)
  const synced = f.state()
  assert.equal(synced.tasks.T1.state, 'failed')
  assert.equal(synced.plan.description, f.plan.description)
  assert.deepEqual(synced.tasks.T1.validation, f.plan.tasks[0].validation)
  assert.deepEqual(synced.tasks.T1.touches, f.plan.tasks[0].touches)
  assert.deepEqual(synced.tasks.T1.attempts, rejected.attempts)
  assert.deepEqual(synced.tasks.T1.validations, rejected.validations)
  assert.deepEqual(synced.tasks.T2, other)
  assert.deepEqual(f.events().slice(0, priorEvents.length), priorEvents)
  f.ok('retry', 'T1')
  assert.equal(f.state().tasks.T1.attempts.length, 1, 'retry must not itself create an attempt')
  f.ok('start', 'T1', '--agent', 'executor-v2')
  f.ok('review', 'T1', '--agent', 'reviewer-v2')

  // Fixing only the old defect is insufficient for the newly approved contract.
  writeFileSync(join(f.project, 'delivery.cjs'), 'exports.days = express => express ? 1 : 3;\n')
  assert.notEqual(f.validate().status, 0)
  f.rejected(/no passing validation/, 'done', 'T1')
  assert.equal(f.state().tasks.T1.validations.at(-1).checks[1].run, 'node current-policy.test.cjs')
  writeFileSync(join(f.project, 'delivery.cjs'), 'exports.days = express => express ? 1 : 4;\n')
  assert.equal(f.validate().status, 0)
  const receipt = f.state().tasks.T1.validations.at(-1)
  assert.match(receipt.checks[1].stdout, /2 current policy scenarios passed/)
  f.ok('done', 'T1')
  const done = f.state().tasks.T1
  assert.deepEqual(done.attempts[0], rejected.attempts[0])
  assert.equal(done.attempts[0].reason, reason)
  assert.equal(done.attempts.length, 2)
  assert.equal(done.attempts[1].result, 'done')
  assert.deepEqual(done.validations[0], rejected.validations[0])
  assert.deepEqual(f.state().tasks.T2, other)
})
