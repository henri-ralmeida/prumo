import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, fork } from 'node:child_process'

// Exercise an actual published updater against a local registry serving the candidate.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const fromVersion = process.argv[2] ?? '1.0.8'
assert.match(fromVersion, /^\d+\.\d+\.\d+$/)
const archive = process.argv[3] ?? join(repo, `henri-ralmeida-prumo-${fromVersion}.tgz`)
const phaseEra = Number(fromVersion.split('.')[1]) >= 3
const home = realpathSync(mkdtempSync(join(tmpdir(), 'prumo-legacy-smoke-')))
const project = join(home, 'project'), prefix = join(home, 'npm-global')
const installed = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@henri-ralmeida/prumo')
const cli = join(installed, 'bin/prumo.mjs'), engine = join(installed, 'scripts/engine.mjs')
const oldRoot = join(home, '.local/share/graph-foreman/legacy')
const newRoot = join(home, '.local/share/prumo/legacy')
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'),
  LOCALAPPDATA: join(home, 'AppData/Local'), CODEX_HOME: join(home, '.codex'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'), PRUMO_HOME: join(home, '.local/share/prumo'),
  PRUMO_LANG: 'en', npm_config_prefix: prefix, npm_config_cache: join(home, 'npm-cache'),
  npm_config_userconfig: join(home, 'npmrc'), npm_config_fetch_retries: '0' }
for (const key of ['PRUMO_ROOT', 'GRAPH_ROOT', 'GRAPH_FOREMAN_HOME', 'NODE_OPTIONS']) delete env[key]
const put = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }
const evidence = []
const flows = new Map()
function saveFlow(label) {
  const root = `${oldRoot}-${label}`
  mkdirSync(join(root, '.specs/graph'), { recursive: true })
  cpSync(join(oldRoot, '.specs/graph/legacy'), join(root, '.specs/graph/legacy'), { recursive: true })
  flows.set(label, { root, before: readFileSync(join(root, '.specs/graph/legacy/state.json'), 'utf8') })
}
function run(file, args, extra = {}, expected = 0) {
  const command = process.platform === 'win32' && file === 'npm'
    ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]] : [file, args]
  const result = spawnSync(...command, { cwd: project, env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  evidence.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr })
  assert.ifError(result.error)
  assert.equal(result.status, expected, result.stdout + result.stderr)
  return result.stdout
}
let registry
try {
  mkdirSync(project)
  put(join(home, '.claude/settings.json'), {})
  put(join(home, '.kiro/steering/project.md'), '# Local fixture')
  put(join(home, '.codex/config.toml'), '')
  put(join(home, '.local/share/prumo/dashboard.json'), { enabled: false })
  run('npm', ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', archive])
  assert.equal(run(process.execPath, [cli, '-v']).trim(), fromVersion)
  for (const harness of ['claude', 'kiro', 'codex']) run(process.execPath, [cli, 'install', `--${harness}`, '--lang', 'en'])
  const planPath = join(project, 'legacy.plan.json')
  const plan = { name: 'Legacy release', phases: [{ id: 'F1', title: 'Merged' }, { id: 'F2', title: 'Remaining' }], tasks: [
    { id: 'DONE', phase: 'F1', title: 'Merged task', deps: [], validationMode: 'inspection', inspectionReason: 'Inspect fixture documentation', validation: 'Documentation inspected' },
    { id: 'SKIP', phase: 'F1', title: 'Removed scope', deps: [], validation: 'Historical prose' },
    { id: 'NEXT', phase: 'F2', title: 'Pending legacy work', deps: ['DONE', 'SKIP'], validation: 'Legacy prose to repair' },
  ] }
  if (phaseEra) for (const task of plan.tasks) {
    task.validationMode = 'inspection'
    task.inspectionReason = 'Inspect fixture documentation'
  }
  put(planPath, plan)
  mkdirSync(oldRoot, { recursive: true })
  const oldEnv = { PRUMO_ROOT: oldRoot, PRUMO_HOME: dirname(oldRoot) }
  const old = (...args) => run(process.execPath, [engine, ...args, '--run', 'legacy'], oldEnv)
  old('init', '--plan', planPath)
  if (phaseEra) {
    old('skip', 'SKIP', '--reason', 'Approved scope removal')
    const state = () => JSON.parse(readFileSync(join(oldRoot, '.specs/graph/legacy/state.json'), 'utf8'))
    old('begin-phase-discussion', 'F1')
    const round = state().phaseWorkflows.F1.discussionAttempts.at(-1)
    const context = join(project, 'initial-discovery.json')
    put(context, { roundId: round.roundId, nonce: round.nonce,
      research: [{ source: 'legacy.plan.json', findings: 'This fixture closes an inspection task before upgrading.' }],
      questions: [{ question: 'Inspect the fixture document?', answer: 'Yes.', channel: 'chat-fallback', round: 1, roundId: round.roundId }],
      coverage: { problem: 'Documentation', affected: 'Readers', outcome: 'Reviewed document', currentBehavior: 'Pending', desiredBehavior: 'Reviewed', rules: 'Independent review', exceptions: 'None', scope: 'DONE', acceptance: 'Document inspected' },
      decisions: [], deferred: [], executionBoundary: { deferredToExecutor: ['T1'], prematureTaskWork: [] },
      closure: 'Inspection scope approved.' })
    saveFlow('discussing')
    old('finish-phase-discussion', 'F1', '--context', context)
    old('plan-phase', 'F1', '--agent', 'planner')
    saveFlow('planning')
    const planning = state().phaseWorkflows.F1.planningAttempts.at(-1)
    put(join(project, 'task-plan-DONE.json'), {
      research: [{ source: 'legacy.plan.json', findings: 'Documentation inspection is sufficient for this task.' }], decisions: [],
      steps: ['Inspect the fixture document.'], verification: [{ criterion: 'Documentation inspected', check: 'inspection' }], openQuestions: [],
      phaseBinding: { phaseId: 'F1', discussionRoundId: planning.discussionRoundId, plannerRound: planning.n }, unresolvedInputs: planning.requiredInputs.DONE,
    })
    old('finish-phase-planning', 'F1', '--plan-dir', project)
  }
  old('start', 'DONE', '--agent', 'executor')
  saveFlow('running')
  old('review', 'DONE', '--agent', 'reviewer')
  saveFlow('reviewing')
  for (const [label, command] of [['blocked', 'block'], ['failed', 'fail']]) {
    saveFlow(label)
    const flow = flows.get(label)
    run(process.execPath, [engine, command, 'DONE', '--reason', 'Temporary review interruption', '--run', 'legacy'], { PRUMO_ROOT: flow.root, PRUMO_HOME: dirname(oldRoot) })
    flow.before = readFileSync(join(flow.root, '.specs/graph/legacy/state.json'), 'utf8')
  }
  old('validate', 'DONE', '--ok', '--evidence', 'Documentation inspected')
  saveFlow('validated')
  old('done', 'DONE')
  if (!phaseEra) old('skip', 'SKIP', '--reason', 'Approved scope removal')
  const relativeState = '.specs/graph/legacy/state.json'
  const before = JSON.parse(readFileSync(join(oldRoot, relativeState), 'utf8'))
  const beforeEvents = readFileSync(join(oldRoot, '.specs/graph/legacy/events.ndjson'), 'utf8')
  const dependency = 'attempt4/source/node_modules/@retro-pass/desktop'
  put(join(oldRoot, 'approved.plan.json'), plan)
  put(join(oldRoot, 'backups/approved.plan.json'), plan)
  put(join(oldRoot, 'attempt4/source/packages/desktop/value.txt'), 'preserved dependency')
  mkdirSync(dirname(join(oldRoot, dependency)), { recursive: true })
  symlinkSync(join(oldRoot, 'attempt4/source/packages/desktop'), join(oldRoot, dependency), 'junction')
  registry = fork(join(repo, 'test/fixtures/update-registry.mjs'), [], { silent: true, env: { ...env,
    PRUMO_TEST_PACKAGE: join(repo, 'package.json'), PRUMO_TEST_ARCHIVE: join(repo, `henri-ralmeida-prumo-${pkg.version}.tgz`),
    PRUMO_TEST_REQUESTS: join(home, 'requests'), PRUMO_TEST_FAILURE: join(home, 'failure') } })
  const address = await new Promise((resolve, reject) => { registry.once('message', resolve); registry.once('error', reject) })
  env.npm_config_registry = address.url
  // Na mesma versão, solicita reparo explícito para exercitar o pacote candidato.
  const output = run(process.execPath, [cli, 'update', ...(fromVersion === pkg.version ? ['--lang', 'en'] : [])])
  const compare = (a, b) => a.split('.').map(Number).reduce((result, value, index) => result || value - Number(b.split('.')[index]), 0)
  for (const released of JSON.parse(process.env.PRUMO_TEST_PUBLISHED_VERSIONS ?? '[]')) {
    if (compare(released, fromVersion) > 0 && compare(released, pkg.version) <= 0)
      assert.ok(output.includes(`Prumo v${released}\n`), `missing release notes for published ${released}`)
  }
  if (!phaseEra) assert.match(output, /Prumo v1\.0\.9/)
  if (fromVersion === '1.3.3' || !phaseEra) assert.match(output, /Prumo v1\.3\.4/)
  assert.ok(output.includes(`Prumo v${pkg.version}`))
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, pkg.version)
  for (const harness of ['.claude', '.kiro', '.agents']) {
    const skill = join(home, harness, 'skills/prumo')
    assert.equal(JSON.parse(readFileSync(join(skill, '.prumo-install.json'), 'utf8')).version, pkg.version)
    assert.equal(readFileSync(join(skill, 'scripts/engine.mjs'), 'utf8'), readFileSync(engine, 'utf8'))
  }
  assert.ok(existsSync(join(newRoot, relativeState)))
  assert.equal(existsSync(oldRoot), false, 'validated migration removes the old data root')
  assert.equal(readFileSync(join(newRoot, '.specs/graph/legacy/events.ndjson'), 'utf8'), beforeEvents)
  assert.equal(existsSync(join(newRoot, 'attempt4')), false, 'a migracao minima descarta copias de execucao')
  assert.deepEqual(JSON.parse(readFileSync(join(newRoot, 'approved.plan.json'), 'utf8')), plan)
  assert.deepEqual(JSON.parse(readFileSync(join(newRoot, 'backups/approved.plan.json'), 'utf8')), plan)
  plan.tasks[2].validationMode = 'functional'
  plan.tasks[2].validation = [{ kind: 'functional', run: 'node check.cjs', expect: 'migrated behavior passes' }]
  put(join(project, 'check.cjs'), "require('node:assert/strict').equal(1 + 1, 2)\n")
  put(planPath, plan)
  for (const [label, flow] of flows) {
    const root = `${newRoot}-${label}`
    const stateFile = join(root, '.specs/graph/legacy/state.json')
    assert.equal(readFileSync(stateFile, 'utf8'), flow.before)
    const resume = (...args) => run(process.execPath, [engine, ...args, '--run', 'legacy'], { PRUMO_ROOT: root })
    resume('status')
    if (label === 'discussing') {
      resume('finish-phase-discussion', 'F1', '--context', join(project, 'initial-discovery.json'))
      resume('plan-phase', 'F1', '--agent', 'planner')
    }
    if (['discussing', 'planning'].includes(label)) {
      resume('finish-phase-planning', 'F1', '--plan-dir', project)
      resume('start', 'DONE', '--agent', 'executor')
    }
    if (label === 'blocked') resume('unblock', 'DONE')
    if (label === 'failed') {
      if (!phaseEra) resume('skip', 'SKIP', '--reason', 'Approved scope removal')
      resume('sync-plan', '--plan', planPath)
      resume('retry', 'DONE')
      resume('start', 'DONE', '--agent', 'executor')
    }
    if (['running', 'failed', 'discussing', 'planning'].includes(label)) resume('review', 'DONE', '--agent', 'reviewer')
    // An old validation receipt may require fresh verification under the new gate.
    resume('validate', 'DONE', '--ok', '--evidence', 'Documentation inspected after update')
    resume('done', 'DONE')
    const completed = JSON.parse(readFileSync(stateFile, 'utf8')).tasks.DONE
    assert.equal(completed.state, 'done')
    assert.equal(completed.attempts.length, label === 'failed' ? 2 : 1)
  }
  const modern = (...args) => run(process.execPath, [engine, ...args, '--run', 'legacy'], { PRUMO_ROOT: newRoot })
  modern('migrate', '--check')
  modern('migrate')
  modern('sync-plan', '--plan', planPath)
  const after = JSON.parse(readFileSync(join(newRoot, relativeState), 'utf8'))
  for (const id of ['DONE', 'SKIP']) assert.deepEqual(after.tasks[id], before.tasks[id])
  assert.equal(after.plan.planningMode, 'phase')
  assert.equal(after.tasks.NEXT.discussionRequired, true)
  assert.equal(after.phaseWorkflows.F2.state, 'pending')
  modern('begin-phase-discussion', 'F2')
  const state = () => JSON.parse(readFileSync(join(newRoot, relativeState), 'utf8'))
  const discussion = state().phaseWorkflows.F2.discussionAttempts.at(-1)
  const context = join(project, 'discovery.json')
  put(context, { roundId: discussion.roundId, nonce: discussion.nonce,
    research: [{ source: 'legacy plan', findings: 'Merged tasks remain terminal; NEXT needs a current executable contract.' }],
    questions: [{ question: 'Preserve merged history?', answer: 'Yes.', channel: 'chat-fallback', round: 1, roundId: discussion.roundId }],
    coverage: { problem: 'Legacy contract.', affected: 'Run owners.', outcome: 'Resume safely.', currentBehavior: 'Old prose.',
      desiredBehavior: 'Executable gate.', rules: 'Preserve terminal tasks.', exceptions: 'None.', scope: 'NEXT.', acceptance: 'Independent review passes.' },
    decisions: [], deferred: [], executionBoundary: { deferredToExecutor: ['T1'], prematureTaskWork: [] },
    closure: 'Approved migration scope.' })
  modern('finish-phase-discussion', 'F2', '--context', context)
  modern('plan-phase', 'F2', '--agent', 'planner')
  const planning = state().phaseWorkflows.F2.planningAttempts.at(-1)
  put(join(project, 'task-plan-NEXT.json'), {
    research: [{ source: 'check.cjs', findings: 'Fixture has an executable behavior check.' }], decisions: [],
    steps: ['Run the approved fixture check.'], verification: [{ criterion: 'migrated behavior passes', check: 1 }], openQuestions: [],
    phaseBinding: { phaseId: 'F2', discussionRoundId: planning.discussionRoundId, plannerRound: planning.n },
    unresolvedInputs: planning.requiredInputs.NEXT,
  })
  modern('finish-phase-planning', 'F2', '--plan-dir', project)
  modern('start', 'NEXT', '--agent', 'executor-next')
  modern('review', 'NEXT', '--agent', 'reviewer-next')
  modern('validate', 'NEXT', '--ok', '--evidence', 'Migrated functional behavior verified', '--cwd', project)
  modern('done', 'NEXT')
  assert.equal(state().tasks.NEXT.state, 'done')
  for (const id of ['DONE', 'SKIP']) assert.deepEqual(state().tasks[id], before.tasks[id])
  const completedState = readFileSync(join(newRoot, relativeState), 'utf8')
  modern('migrate')
  assert.equal(readFileSync(join(newRoot, relativeState), 'utf8'), completedState, 'migration is idempotent')
  console.log(`Published ${fromVersion} updated to ${pkg.version}; notes, three harnesses, junctions, merged tasks and ${[...flows.keys()].join('/')} continuation verified`)
} finally {
  if (registry && registry.exitCode === null && registry.signalCode === null) { const closed = new Promise(resolve => registry.once('exit', resolve)); registry.kill(); await closed }
  put(join(repo, `.test-output/legacy-update-${fromVersion}.json`), evidence)
  assert.equal(dirname(home), realpathSync(tmpdir()))
  assert.ok(basename(home).startsWith('prumo-legacy-smoke-'))
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
