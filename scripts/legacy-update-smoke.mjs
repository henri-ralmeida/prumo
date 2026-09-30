import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync, spawn, fork } from 'node:child_process'
import { createConnection, createServer } from 'node:net'

// Exercise an actual published updater against a local registry serving the candidate.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const fromVersion = process.argv[2] ?? '1.0.8'
assert.match(fromVersion, /^\d+\.\d+\.\d+$/)
const archive = process.argv[3] ?? join(repo, `henri-ralmeida-prumo-${fromVersion}.tgz`)
// From 1.1.0 prose validation is accepted only for a justified inspection task.
const since = version => fromVersion.split('.').map(Number).reduce((result, value, index) => result || value - version.split('.').map(Number)[index], 0) >= 0
const phaseEra = since('1.3.0')
const inspectionEra = since('1.1.0')
// 1.2.x planned each task before execution; 1.2.1 added the discovery context.
const taskEra = since('1.2.0') && !phaseEra
// A tag-built archive can replace the repository-root candidate produced by `npm pack`.
const candidate = process.env.PRUMO_CANDIDATE_ARCHIVE ?? join(repo, `henri-ralmeida-prumo-${pkg.version}.tgz`)
const home = realpathSync(mkdtempSync(join(tmpdir(), 'prumo-legacy-smoke-')))
const project = join(home, 'project'), prefix = join(home, 'npm-global')
const installed = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@henri-ralmeida/prumo')
const cli = join(installed, 'bin/prumo.mjs'), engine = join(installed, 'scripts/engine.mjs')
const oldRoot = join(home, '.local/share/graph-foreman/legacy')
const newRoot = join(home, '.local/share/prumo/legacy')
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'),
  LOCALAPPDATA: join(home, 'AppData/Local'), CODEX_HOME: join(home, '.codex'),
  DSH_HOME: join(home, '.dsh'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PRUMO_HOME: join(home, '.local/share/prumo'),
  PRUMO_LANG: 'en', npm_config_prefix: prefix, npm_config_cache: join(home, 'npm-cache'),
  npm_config_userconfig: join(home, 'npmrc'), npm_config_fetch_retries: '0' }
for (const key of ['PRUMO_ROOT', 'GRAPH_ROOT', 'GRAPH_FOREMAN_HOME', 'NODE_OPTIONS']) delete env[key]
// Every process of the scenario serves and probes the fixed dashboard port on an isolated one, so the
// old release's autostart and the updater's restart run for real without touching the user's dashboard.
let dashboardPort = await freePort()
env.PRUMO_TEST_DASHBOARD_PORT = String(dashboardPort)
const dashboardShutdownToken = randomBytes(16).toString('hex')
env.PRUMO_TEST_DASHBOARD_SHUTDOWN_TOKEN = dashboardShutdownToken
env.NODE_OPTIONS = `--import="${pathToFileURL(join(repo, 'test/fixtures/dashboard-port.mjs')).href}"`
const dashboardPreference = join(home, '.local/share/prumo/dashboard.json')
async function dashboardHealth() {
  try {
    const body = await (await fetch(`http://127.0.0.1:${dashboardPort}/api/health`, { signal: AbortSignal.timeout(2000) })).json()
    return body
  } catch { return null }
}
async function waitForDashboard(accept, preparation = '') {
  const deadline = Date.now() + 30000
  for (;;) {
    const body = await dashboardHealth()
    if (body && accept(body)) return body
    if (Date.now() > deadline) {
      let events = ''
      try { events = readFileSync(join(home, '.local/share/prumo/dashboard-events.ndjson'), 'utf8').trim().split('\n').slice(-10).join('\n') } catch { /* no events */ }
      throw new Error(`dashboard did not reach the expected state: ${JSON.stringify(body)}\n${events}\n${typeof preparation === 'function' ? preparation() : preparation}`)
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
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
async function freePort() {
  const probe = createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}
async function dashboardPortClosed() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: dashboardPort })
    socket.setTimeout(2000)
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(true) : reject(error))
    socket.once('timeout', () => { socket.destroy(); reject(new Error('isolated dashboard port did not respond')) })
  })
}
// The updated global dashboard must read untouched legacy state files without errors.
async function checkDashboard(labels) {
  const port = await freePort()
  const server = spawn(process.execPath, [join(installed, 'scripts/serve.mjs'), '--global', '--port', String(port)],
    { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  server.stdout.on('data', value => { output += value })
  server.stderr.on('data', value => { output += value })
  const exited = new Promise(resolve => server.once('exit', resolve))
  const get = async path => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(10000) })
    return { status: response.status, body: await response.json() }
  }
  try {
    const deadline = Date.now() + 30000
    for (;;) {
      if (server.exitCode !== null) throw new Error(`dashboard exited early: ${output}`)
      try { if ((await get('/api/health')).status === 200) break } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`dashboard did not start: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const health = await get('/api/health')
    assert.equal(health.body.version, pkg.version)
    const runs = await get('/api/runs')
    assert.equal(runs.status, 200)
    for (const label of labels) {
      const root = `${basename(newRoot)}-${label}`
      assert.ok(runs.body.runs.some(entry => entry.root === root && entry.run === 'legacy'), `dashboard lists ${root}: ${JSON.stringify(runs.body)}`)
      const state = await get(`/api/state?root=${encodeURIComponent(root)}&run=legacy`)
      assert.equal(state.status, 200, JSON.stringify(state.body))
      assert.equal(state.body.plan.name, 'Legacy release')
      assert.ok(state.body.derived && state.body.tasks.DONE, `derived state for ${root}`)
    }
    evidence.push({ dashboard: { port, runs: runs.body.runs.length, warnings: runs.body.warnings } })
  } finally {
    if (server.exitCode === null) server.kill()
    await exited
  }
}
// Starts DONE; a 1.2 task-planned task without a current plan follows the adopted phase
// workflow that the engine names, which is the path a user takes after the update.
function startDone(root, label) {
  const resume = (...args) => run(process.execPath, [engine, ...args, '--run', 'legacy'], { PRUMO_ROOT: root })
  const stateFile = join(root, '.specs/graph/legacy/state.json')
  const start = ['start', 'DONE', '--agent', 'executor', '--run', 'legacy']
  const first = spawnSync(process.execPath, [engine, ...start], { cwd: project, env: { ...env, PRUMO_ROOT: root }, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  evidence.push({ args: start, status: first.status, stdout: first.stdout, stderr: first.stderr })
  assert.ifError(first.error)
  if (first.status !== 0) {
    assert.ok(taskEra, first.stdout + first.stderr)
    assert.match(first.stderr, /DONE needs completed current planning for phase F1 — run begin-phase-discussion F1, finish-phase-discussion, plan-phase and finish-phase-planning before start/)
    const current = () => JSON.parse(readFileSync(stateFile, 'utf8'))
    // The fixture removes SKIP from scope; record that before discussing the phase's remaining work.
    if (!['done', 'skipped'].includes(current().tasks.SKIP.state)) resume('skip', 'SKIP', '--reason', 'Approved scope removal')
    resume('begin-phase-discussion', 'F1')
    const round = current().phaseWorkflows.F1.discussionAttempts.at(-1)
    const context = join(project, `retry-discovery-${label}.json`)
    put(context, { roundId: round.roundId, nonce: round.nonce,
      research: [{ source: 'legacy.plan.json', findings: 'The legacy task needs a current plan before a new attempt.' }],
      questions: [{ question: 'Plan the inspection under the current workflow?', answer: 'Yes.', channel: 'chat-fallback', round: 1, roundId: round.roundId }],
      coverage: { problem: 'Failed attempt', affected: 'Readers', outcome: 'Reviewed document', currentBehavior: 'Failed', desiredBehavior: 'Reviewed',
        rules: 'Independent review', exceptions: 'None', scope: 'DONE', acceptance: 'Document inspected' },
      decisions: [], deferred: [], executionBoundary: { deferredToExecutor: round.targets, prematureTaskWork: [] }, closure: 'Retry scope approved.' })
    resume('finish-phase-discussion', 'F1', '--context', context)
    resume('plan-phase', 'F1', '--agent', 'planner')
    const planning = current().phaseWorkflows.F1.planningAttempts.at(-1)
    const planDir = join(project, `retry-plan-${label}`)
    put(join(planDir, 'task-plan-DONE.json'), {
      research: [{ source: 'legacy.plan.json', findings: 'Documentation inspection is sufficient for this task.' }], decisions: [],
      steps: ['Inspect the fixture document.'], verification: [{ criterion: 'Documentation inspected', check: 'inspection' }], openQuestions: [],
      phaseBinding: { phaseId: 'F1', discussionRoundId: planning.discussionRoundId, plannerRound: planning.n }, unresolvedInputs: planning.requiredInputs.DONE })
    resume('finish-phase-planning', 'F1', '--plan-dir', planDir)
    resume('start', 'DONE', '--agent', 'executor')
  }
}
let registry, previousDashboard, previousDashboardClosed, scenarioError
try {
  mkdirSync(project)
  put(join(home, '.claude/settings.json'), {})
  put(join(home, '.kiro/steering/project.md'), '# Local fixture')
  put(join(home, '.codex/config.toml'), '')
  put(join(home, '.dsh/AGENTS.md'), 'Keep this legacy DSH instruction.\n')
  put(join(home, '.local/share/prumo/dashboard.json'), { enabled: false })
  run('npm', ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', archive])
  assert.equal(run(process.execPath, [cli, '-v']).trim(), fromVersion)
  // Tags antigas sem publicação usam o próprio pacote local ao preparar a instalação.
  registry = fork(join(repo, 'test/fixtures/update-registry.mjs'), [], { silent: true, env: { ...env,
    PRUMO_TEST_PACKAGE: join(installed, 'package.json'), PRUMO_TEST_ARCHIVE: archive,
    PRUMO_TEST_REQUESTS: join(home, 'old-requests'), PRUMO_TEST_FAILURE: join(home, 'old-failure') } })
  const oldAddress = await new Promise((resolve, reject) => { registry.once('message', resolve); registry.once('error', reject) })
  env.npm_config_registry = oldAddress.url
  env.npm_config_fetch_retries = '0'
  for (const harness of ['claude', 'kiro', 'codex']) run(process.execPath, [cli, 'install', `--${harness}`, '--lang', 'en'])
  // A release with autostart keeps its dashboard running through the update, as a user has it. The
  // per-user Startup entry (Windows) or XDG entry (Linux) lives in this temporary home.
  const autostartEra = ['win32', 'linux'].includes(process.platform) && existsSync(join(installed, 'lib/autostart.mjs'))
  let dashboardBefore
  if (autostartEra) {
    // Selecionar a porta imediatamente antes de iniciar evita reutilizar a porta escolhida antes da instalação.
    dashboardPort = await freePort()
    env.PRUMO_TEST_DASHBOARD_PORT = String(dashboardPort)
    put(dashboardPreference, { enabled: false, mechanism: process.platform === 'win32' ? 'windows-startup' : 'xdg' })
    // O cenário de atualização começa com o dashboard antigo em execução, inclusive quando seu lançador histórico falha.
    previousDashboard = spawn(process.execPath, [join(installed, 'scripts/serve.mjs'), '--global', '--port', '4949'],
      { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    previousDashboardClosed = new Promise(resolve => previousDashboard.once('close', resolve))
    let previousOutput = ''
    previousDashboard.on('error', error => { previousOutput += error.message })
    previousDashboard.stdout.on('data', value => { previousOutput += value })
    previousDashboard.stderr.on('data', value => { previousOutput += value })
    await waitForDashboard(body => body.product === 'prumo' && body.version === fromVersion,
      () => `dashboard (${fromVersion}): exit=${previousDashboard.exitCode}\n${previousOutput}`)
    const enable = spawnSync(process.execPath, [cli, 'dashboard', 'enable'], { cwd: project, env, encoding: 'utf8', windowsHide: true, timeout: 60000 })
    // The old release may not confirm the pid it started (seen on Windows); the dashboard must still serve.
    evidence.push({ args: ['dashboard', 'enable'], status: enable.status, stdout: enable.stdout, stderr: enable.stderr })
    if (enable.error?.code !== 'ETIMEDOUT') assert.ifError(enable.error)
    const health = await waitForDashboard(body => body.product === 'prumo' && body.version === fromVersion,
      `dashboard enable (${fromVersion}): status=${enable.status}\n${enable.stdout}\n${enable.stderr}\n${previousOutput}`)
    let preference = JSON.parse(readFileSync(dashboardPreference, 'utf8'))
    if (enable.error?.code === 'ETIMEDOUT' && preference.enabled !== true) {
      preference = { ...preference, enabled: true, node: process.execPath,
        script: join(installed, 'scripts', 'serve.mjs'), pid: previousDashboard.pid, version: fromVersion }
      put(dashboardPreference, preference)
      evidence.push({ scenario: 'dashboard antigo ja habilitado', version: fromVersion, pid: previousDashboard.pid })
    }
    assert.equal(preference.enabled, true, 'O dashboard antigo deve estar habilitado e servindo antes da atualização.')
    dashboardBefore = { pid: health.pid ?? preference.pid ?? previousDashboard.pid }
    // The state a failed restart left on the user's machine: enabled, without a recorded pid.
    delete preference.pid
    put(dashboardPreference, preference)
    evidence.push({ dashboardBefore: { health, preference } })
  }
  const planPath = join(project, 'legacy.plan.json')
  const plan = { name: 'Legacy release', phases: [{ id: 'F1', title: 'Merged' }, { id: 'F2', title: 'Remaining' }], tasks: [
    { id: 'DONE', phase: 'F1', title: 'Merged task', deps: [], validationMode: 'inspection', inspectionReason: 'Inspect fixture documentation', validation: 'Documentation inspected' },
    { id: 'SKIP', phase: 'F1', title: 'Removed scope', deps: [], validation: 'Historical prose' },
    { id: 'NEXT', phase: 'F2', title: 'Pending legacy work', deps: ['DONE', 'SKIP'], validation: 'Legacy prose to repair' },
  ] }
  if (inspectionEra) for (const task of plan.tasks) {
    task.validationMode = 'inspection'
    task.inspectionReason = 'Inspect fixture documentation'
  }
  put(planPath, plan)
  mkdirSync(oldRoot, { recursive: true })
  const oldEnv = { PRUMO_ROOT: oldRoot, PRUMO_HOME: dirname(oldRoot) }
  const old = (...args) => run(process.execPath, [engine, ...args, '--run', 'legacy'], oldEnv)
  old('init', '--plan', planPath)
  // Versões com autorização explícita precisam registrar o aceite da execução simulada.
  if (readFileSync(engine, 'utf8').includes('  authorize() {')) old('authorize', '--scope', 'run', '--confirmed-by-user')
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
      decisions: [], deferred: [], executionBoundary: { deferredToExecutor: ['DONE'], prematureTaskWork: [] },
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
  if (taskEra) {
    const discovery = join(project, 'task-discovery.json')
    put(discovery, { research: [{ source: 'legacy.plan.json', findings: 'Documentation-only task with an approved inspection contract.' }],
      questions: [{ question: 'Inspect the fixture document?', answer: 'Yes.', channel: 'chat-fallback', round: 1 }],
      coverage: { problem: 'Documentation', affected: 'Readers', outcome: 'Reviewed document', currentBehavior: 'Pending', desiredBehavior: 'Reviewed',
        rules: 'Independent review', exceptions: 'None', scope: 'DONE', acceptance: 'Document inspected' },
      decisions: [], deferred: [], closure: 'Inspection scope approved.' })
    put(join(project, 'task-plan-legacy.json'), {
      research: [{ source: 'legacy.plan.json', findings: 'Documentation inspection is sufficient for this task.' }], decisions: [],
      steps: ['Inspect the fixture document.'], verification: [{ criterion: 'Documentation inspected', check: 'inspection' }], openQuestions: [] })
    old('plan-task', 'DONE', '--agent', 'planner', ...(since('1.2.1') ? ['--context', discovery] : []))
    saveFlow('task-planning')
    old('finish-planning', 'DONE', '--plan', join(project, 'task-plan-legacy.json'))
  }
  old('start', 'DONE', '--agent', 'executor')
  saveFlow('running')
  old('review', 'DONE', '--agent', 'reviewer')
  // A inspeção só pode ser aprovada após o revisor registrar o critério percorrido.
  if (readFileSync(engine, 'utf8').includes('review-progress')) old('review-progress', 'DONE', '--step', '1', '--agent', 'reviewer')
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
  const oldRegistryClosed = new Promise(resolve => registry.once('exit', resolve))
  registry.kill()
  await oldRegistryClosed
  registry = fork(join(repo, 'test/fixtures/update-registry.mjs'), [], { silent: true, env: { ...env,
    PRUMO_TEST_PACKAGE: join(repo, 'package.json'), PRUMO_TEST_ARCHIVE: candidate,
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
  if (!since('1.0.9')) assert.match(output, /Prumo v1\.0\.9/)
  if (!since('1.3.4')) assert.match(output, /Prumo v1\.3\.4/)
  assert.ok(output.includes(`Prumo v${pkg.version}`))
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, pkg.version)
  if (autostartEra) {
    assert.doesNotMatch(output, /Dashboard restart failed|Update incomplete/)
    const health = await waitForDashboard(body => body.product === 'prumo')
    assert.equal(health.version, pkg.version, 'the update restarted the dashboard with the new release')
    assert.equal(JSON.parse(readFileSync(dashboardPreference, 'utf8')).pid, health.pid, 'the new dashboard pid is recorded')
    if (dashboardBefore.pid) {
      assert.notEqual(health.pid, dashboardBefore.pid)
      assert.equal(alive(dashboardBefore.pid), false, 'the previous dashboard was stopped')
    }
    evidence.push({ dashboardAfter: health })
  }
  run(process.execPath, [cli, 'install', '--dsh', '--lang', 'en'])
  const dshAgents = readFileSync(join(home, '.dsh/AGENTS.md'), 'utf8')
  assert.match(dshAgents, /Keep this legacy DSH instruction/)
  assert.match(dshAgents, /<!-- po-first:start -->/)
  assert.equal(existsSync(join(home, '.dsh/cordis.patch.yml')), false)
  assert.equal(existsSync(join(home, '.dsh/.credentials.yaml')), false)
  assert.equal(existsSync(join(home, '.dsh/profiles')), false)
  for (const harness of ['.claude', '.kiro', '.agents', '.dsh']) {
    const skill = join(home, harness, 'skills/prumo')
    assert.equal(JSON.parse(readFileSync(join(skill, '.prumo-install.json'), 'utf8')).version, pkg.version)
    assert.equal(readFileSync(join(skill, 'scripts/engine.mjs'), 'utf8'), readFileSync(engine, 'utf8'))
  }
  assert.ok(existsSync(join(newRoot, relativeState)))
  assert.equal(existsSync(oldRoot), true, 'a copia preserva a pasta de dados original do Prumo antigo')
  assert.deepEqual(JSON.parse(readFileSync(join(oldRoot, relativeState), 'utf8')), before)
  assert.equal(readFileSync(join(newRoot, '.specs/graph/legacy/events.ndjson'), 'utf8'), beforeEvents)
  assert.equal(existsSync(join(newRoot, 'attempt4')), false, 'a migracao minima descarta copias de execucao')
  assert.deepEqual(JSON.parse(readFileSync(join(newRoot, 'approved.plan.json'), 'utf8')), plan)
  assert.deepEqual(JSON.parse(readFileSync(join(newRoot, 'backups/approved.plan.json'), 'utf8')), plan)
  await checkDashboard([...flows.keys()])
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
    if (label === 'task-planning') {
      resume('finish-planning', 'DONE', '--plan', join(project, 'task-plan-legacy.json'))
      startDone(root, label)
    }
    if (label === 'blocked') resume('unblock', 'DONE')
    if (label === 'failed') {
      if (!phaseEra) resume('skip', 'SKIP', '--reason', 'Approved scope removal')
      resume('sync-plan', '--plan', planPath)
      resume('retry', 'DONE')
      startDone(root, label)
    }
    if (['running', 'failed', 'discussing', 'planning', 'task-planning'].includes(label)) resume('review', 'DONE', '--agent', 'reviewer')
    // An old validation receipt may require fresh verification under the new gate. Structured
    // inspection criteria must first be traversed by the reviewer; the engine names the command.
    const validate = ['validate', 'DONE', '--ok', '--evidence', 'Documentation inspected after update', '--run', 'legacy']
    const gated = spawnSync(process.execPath, [engine, ...validate], { cwd: project, env: { ...env, PRUMO_ROOT: root }, encoding: 'utf8', windowsHide: true, timeout: 120000 })
    evidence.push({ args: validate, status: gated.status, stdout: gated.stdout, stderr: gated.stderr })
    assert.ifError(gated.error)
    if (gated.status !== 0) {
      assert.match(gated.stderr, /inspection criteria are not fully traversed; record reviewer-reported progress for each criterion with review-progress DONE --step <index> --agent reviewer/, gated.stdout + gated.stderr)
      resume('review-progress', 'DONE', '--step', '1', '--agent', 'reviewer')
      resume('validate', 'DONE', '--ok', '--evidence', 'Documentation inspected after update')
    }
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
    decisions: [], deferred: [], executionBoundary: { deferredToExecutor: ['NEXT'], prematureTaskWork: [] },
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
  // O contrato de NEXT mudou; o aceite anterior não autoriza a execução do novo escopo.
  modern('authorize', '--scope', 'tasks:NEXT', '--confirmed-by-user')
  modern('start', 'NEXT', '--agent', 'executor-next')
  modern('review', 'NEXT', '--agent', 'reviewer-next')
  modern('validate', 'NEXT', '--ok', '--evidence', 'Migrated functional behavior verified', '--cwd', project)
  modern('done', 'NEXT')
  assert.equal(state().tasks.NEXT.state, 'done')
  for (const id of ['DONE', 'SKIP']) assert.deepEqual(state().tasks[id], before.tasks[id])
  const completedState = readFileSync(join(newRoot, relativeState), 'utf8')
  modern('migrate')
  assert.equal(readFileSync(join(newRoot, relativeState), 'utf8'), completedState, 'migration is idempotent')
  console.log(`Published ${fromVersion} updated to ${pkg.version}; notes, three legacy harnesses plus current DSH, junctions, merged tasks and ${[...flows.keys()].join('/')} continuation verified`)
} catch (error) {
  scenarioError = error
  throw error
} finally {
  let dashboardCleanupError
  try {
    const response = await fetch(`http://127.0.0.1:${dashboardPort}/__prumo_test_dashboard_shutdown/${dashboardShutdownToken}`,
      { method: 'POST', signal: AbortSignal.timeout(2000) })
    if (response.status !== 200) throw new Error(`isolated dashboard refused shutdown: HTTP ${response.status}`)
    const deadline = Date.now() + 10000
    while (!(await dashboardPortClosed())) {
      if (Date.now() > deadline) throw new Error('isolated dashboard did not stop')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') dashboardCleanupError = error
  }
  if (previousDashboard && previousDashboard.exitCode === null && previousDashboard.signalCode === null) previousDashboard.kill()
  if (previousDashboardClosed) await previousDashboardClosed
  if (registry && registry.exitCode === null && registry.signalCode === null) { const closed = new Promise(resolve => registry.once('exit', resolve)); registry.kill(); await closed }
  put(join(repo, `.test-output/legacy-update-${fromVersion}.json`), evidence)
  assert.equal(dirname(home), realpathSync(tmpdir()))
  assert.ok(basename(home).startsWith('prumo-legacy-smoke-'))
  if (dashboardCleanupError) throw dashboardCleanupError
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    if (!scenarioError) throw error
    console.error(`Diretório temporário preservado após falha na limpeza: ${home} (${error.code})`)
  }
}
