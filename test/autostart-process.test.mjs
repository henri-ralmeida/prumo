import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer, createConnection } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { enableDashboard, restartDashboard, disableDashboard, stopDashboardForUpdate } from '../lib/autostart.mjs'
import { createTranslator, messages } from '../scripts/i18n.mjs'

function dashboardRequestInit(init) {
  // O despejo síncrono do V8 entre respostas pode exceder o prazo HTTP do produto no CI.
  // Apenas a integração instrumentada recebe mais tempo; a prontidão e a posse continuam obrigatórias.
  return process.env.PRUMO_TEST_COVERAGE_FLUSH === '1'
    ? { ...init, signal: AbortSignal.timeout(10000) } : init
}

test('Windows Startup launches and restarts a real isolated dashboard process', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo startup process-'))
  const reserve = createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const script = join(home, 'dashboard.mjs')
  // Mantenha a linha de comando de produção para as verificações de posse, mas sirva em uma porta isolada.
  writeFileSync(script, `process.argv[process.argv.indexOf('--port') + 1] = '${port}';\nawait import(${JSON.stringify(new URL('../scripts/serve.mjs', import.meta.url).href)});\n`)
  const env = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'data'),
    APPDATA: join(home, 'AppData/Roaming'), CODEX_HOME: join(home, '.codex'), DSH_HOME: join(home, '.dsh'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), KIRO_HOME: join(home, '.kiro'), PRUMO_ROOT: '', GRAPH_ROOT: '', GRAPH_FOREMAN_HOME: '', PRUMO_LANG: 'en' }
  // Exercite o lançador padrão com um registro de fallback existente, sem exec injetado.
  const preferencePath = join(home, '.local/share/prumo/dashboard.json')
  mkdirSync(join(home, '.local/share/prumo'), { recursive: true })
  writeFileSync(preferencePath, JSON.stringify({ enabled: true, mechanism: 'windows-startup' }))
  const options = { home, script: script.replaceAll('\\', '/'), packageRoot: fileURLToPath(new URL('..', import.meta.url)), env,
    // A inicialização real usa o prazo do produto; a cobertura não deve reduzi-lo para cinco segundos.
    fetch: (url, init) => fetch(String(url).replace(':4949/', `:${port}/`), dashboardRequestInit(init)),
    portAvailable: () => isolatedPortAvailable(port) }
  const pids = new Set()
  // Rastreie também um processo cujo registro de posse falha, para que as falhas não o deixem escapar.
  options.fetch = async (url, init) => {
    const response = await fetch(String(url).replace(':4949/', `:${port}/`), dashboardRequestInit(init))
    if (response.ok) { const body = await response.clone().json(); if (body.pid) pids.add(body.pid) }
    return response
  }
  t.after(() => {
    for (const pid of pids) try { process.kill(pid) } catch {}
    assert.ok(home.startsWith(join(tmpdir(), 'prumo startup process-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const preference = () => JSON.parse(readFileSync(join(home, '.local/share/prumo/dashboard.json'), 'utf8'))
  const first = await enableDashboard(options)
  if (preference().pid) pids.add(preference().pid)
  if (!first.ok) {
    const evidence = join(fileURLToPath(new URL('..', import.meta.url)), '.test-output')
    mkdirSync(evidence, { recursive: true })
    const diagnostics = join(home, '.local/share/prumo/dashboard-events.ndjson')
    writeFileSync(join(evidence, 'autostart-process-failure.json'), JSON.stringify({
      node: process.version, first, preference: preference(),
      events: existsSync(diagnostics) ? readFileSync(diagnostics, 'utf8') : '',
    }, null, 2))
  }
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.mechanism, 'windows-startup')
  const runs = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()
  assert.deepEqual(runs.runs, [], 'isolated dashboard must not discover the real user runs')
  const firstAbout = await (await fetch(`http://127.0.0.1:${port}/api/about`)).json()
  assert.equal(first.contentCurrent, true)
  assert.equal(first.contentId, firstAbout.contentId)
  // A origem segue o local onde o pacote servido está, e não a listagem da execução --global.
  const packageRoot = options.packageRoot
  const expectedOrigin = packageRoot.split(/[\\/]+/).includes('node_modules') ? 'global'
    : existsSync(join(packageRoot, '.git')) ? 'repository' : 'installed'
  assert.equal(firstAbout.origin, expectedOrigin)
  const root = join(env.PRUMO_HOME, 'fixture/.specs/graph/test')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'state.json'), JSON.stringify({ plan: { name: 'isolated', phases: [] }, tasks: {} }))
  writeFileSync(join(root, '../CURRENT'), 'test')
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()).runs.length, 1)
  const firstPid = preference().pid
  const restarted = await restartDashboard(options)
  if (preference().pid) pids.add(preference().pid)
  assert.equal(restarted.ok, true, JSON.stringify(restarted))
  assert.equal(restarted.contentCurrent, true)
  assert.equal(restarted.contentId, firstAbout.contentId)
  assert.notEqual(preference().pid, firstPid)
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()).runs.length, 1)
  // Invoque a entrada exata de login por usuário sem reiniciar nem tocar na pasta Startup real.
  const stoppedPid = preference().pid
  process.kill(stoppedPid)
  let stopped = false
  for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
    try { await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }) }
    catch { stopped = true }
    if (!stopped) await setTimeout(50)
  }
  assert.equal(stopped, true, 'wait for the previous server to release its port before simulating login')
  const entry = join(env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup/Prumo Dashboard.vbs')
  execFileSync('cscript.exe', ['//B', '//Nologo', entry], { env, windowsHide: true, timeout: 10000 })
  let loginReady = false
  for (let attempt = 0; attempt < 300 && !loginReady; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })
      const body = await response.json()
      if (body.pid && body.pid !== stoppedPid) { pids.add(body.pid); loginReady = response.ok }
    } catch {}
    if (!loginReady) await setTimeout(50)
  }
  assert.equal(loginReady, true, 'the login entry itself must launch the dashboard before enable repairs anything')
  const login = await enableDashboard(options)
  if (preference().pid) pids.add(preference().pid)
  assert.equal(login.ok, true, JSON.stringify(login))
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()).runs.length, 1)
  const disabled = await disableDashboard(options)
  assert.equal(disabled.ok, true, JSON.stringify(disabled))
  assert.equal(disabled.registered, false)
})

// Processos reais em uma porta isolada. O estado registrado reproduz `prumo update` no Windows depois que uma
// reinicialização anterior apagou `pid` de dashboard.json; a inspeção padrão do processo é exercitada.
const repo = fileURLToPath(new URL('..', import.meta.url))
async function freePort() {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}
async function isolatedPortAvailable(port) {
  // Consultar a porta sem reservá-la evita impedir a inicialização que o teste está aguardando.
  const socket = createConnection({ port, host: '127.0.0.1' })
  return await new Promise(resolve => {
    const finish = available => { socket.destroy(); resolve(available) }
    socket.once('connect', () => finish(false))
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'))
    socket.setTimeout(1200, () => finish(false))
  })
}
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
async function waitFor(check, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await check()
    if (value) return value
    await setTimeout(50)
  }
  return null
}
async function isolatedDashboard(t) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-restart-ownership-'))
  const port = await freePort()
  const target = join(home, 'target.txt')
  const script = join(home, 'dashboard.mjs')
  // A linha de comando gerenciada permanece `<node> <script> --global --port 4949`; o wrapper serve em outro local.
  writeFileSync(script, [
    "import { readFileSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    `process.argv[process.argv.indexOf('--port') + 1] = '${port}'`,
    `await import(pathToFileURL(readFileSync(${JSON.stringify(target)}, 'utf8').trim()).href)`, ''].join('\n'))
  writeFileSync(target, join(repo, 'scripts/serve.mjs'))
  const env = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'data'),
    APPDATA: join(home, 'AppData/Roaming'), CODEX_HOME: join(home, '.codex'), DSH_HOME: join(home, '.dsh'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), KIRO_HOME: join(home, '.kiro'), PRUMO_ROOT: '', GRAPH_ROOT: '', GRAPH_FOREMAN_HOME: '', PRUMO_LANG: 'en' }
  const pids = new Set(), killed = [], children = []
  const redirect = async (url, init) => {
    const response = await fetch(String(url).replace(':4949/', `:${port}/`), dashboardRequestInit(init))
    if (response.ok) try { const body = await response.clone().json(); if (body.pid) pids.add(body.pid) } catch {}
    return response
  }
  const options = { home, script, packageRoot: repo, env, readinessAttempts: 100, readinessInterval: 50,
    fetch: redirect, portAvailable: () => isolatedPortAvailable(port), kill: pid => { killed.push(pid); process.kill(pid) } }
  const file = join(home, '.local/share/prumo/dashboard.json')
  mkdirSync(dirname(file), { recursive: true })
  t.after(async () => {
    for (const pid of pids) try { process.kill(pid) } catch {}
    for (const child of children) if (child.exitCode === null) child.kill()
    await setTimeout(300)
    assert.ok(home.startsWith(join(tmpdir(), 'prumo-restart-ownership-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const health = async () => {
    try { return await (await redirect('http://127.0.0.1:4949/api/health', { signal: AbortSignal.timeout(1000) })).json() }
    catch { return null }
  }
  // `managed` inicia o dashboard com a linha de comando gerenciada; caso contrário, `args` são executados como fornecidos.
  const start = (args, managed = false) => {
    const child = spawn(process.execPath, managed ? [script, '--global', '--port', '4949'] : args,
      { env, detached: managed, stdio: 'ignore', windowsHide: true })
    children.push(child)
    return child
  }
  return { home, port, target, script, options, killed, health, start,
    preference: () => JSON.parse(readFileSync(file, 'utf8')),
    write: value => writeFileSync(file, JSON.stringify(value)) }
}
// A versão anterior é servida a partir de sua tag quando disponível, como estava para o usuário antes da atualização.
function previousRelease(home) {
  mkdirSync(join(home, 'previous'))
  const archive = spawnSync('git', ['archive', '--format=tar', '-o', join(home, 'previous.tar'), 'v2.0.0'], { cwd: repo, windowsHide: true, timeout: 60000 })
  if (archive.status !== 0) return null
  // Caminhos relativos impedem que o GNU tar interprete uma letra de unidade do Windows como um host remoto.
  const extract = spawnSync('tar', ['-xf', 'previous.tar', '-C', 'previous'], { cwd: home, windowsHide: true, timeout: 60000 })
  return extract.status === 0 ? join(home, 'previous') : null
}

for (const recorded of ['missing', 'stale', 'missing identity']) {
  test(`update restart replaces the running Prumo dashboard when the recorded pid is ${recorded}`, { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
    const f = await isolatedDashboard(t)
    const previous = previousRelease(f.home)
    if (previous) writeFileSync(f.target, join(previous, 'scripts/serve.mjs'))
    const old = f.start(null, true)
    const before = await waitFor(async () => { const body = await f.health(); return body?.pid === old.pid && body })
    assert.ok(before, 'the previous dashboard serves the isolated port')
    if (previous) assert.equal(before.version, '2.0.0')
    // Um `pid` obsoleto que agora pertence a um processo ativo não relacionado também não pode ser encerrado.
    const unrelated = f.start(['-e', 'setInterval(() => {}, 1000)'])
    f.write({ enabled: true, mechanism: 'windows-startup', ...(recorded === 'stale' && { pid: unrelated.pid }),
      ...(recorded !== 'missing identity' && { node: process.execPath, script: f.script }) })
    const savedPreference = f.preference()
    const paused = await stopDashboardForUpdate(f.options)
    assert.equal(paused.ok, true, JSON.stringify(paused))
    assert.equal(await waitFor(() => !alive(old.pid)), true)
    assert.equal(await f.health(), null, 'a porta esta livre antes de substituir a instalacao')
    assert.deepEqual(f.preference(), savedPreference, 'parar nao desabilita o dashboard escolhido pelo usuario')
    writeFileSync(f.target, join(repo, 'scripts/serve.mjs'))
    const restarted = await restartDashboard(f.options)
    assert.equal(restarted.ok, true, JSON.stringify(restarted))
    const after = await f.health()
    assert.equal(after.version, JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version)
    assert.notEqual(after.pid, old.pid)
    assert.equal(restarted.contentCurrent, true)
    assert.equal(f.preference().pid, after.pid, 'the new dashboard pid is recorded')
    assert.deepEqual(f.killed, [old.pid])
    assert.equal(await waitFor(() => !alive(old.pid)), true)
    assert.equal(alive(unrelated.pid), true, 'an unrelated process is never stopped')
  })
}

for (const command of ['update', '_update']) test(`${command} para antes do npm e restaura o dashboard quando a instalacao falha`, { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const f = await isolatedDashboard(t)
  const old = f.start(null, true)
  assert.ok(await waitFor(async () => (await f.health())?.pid === old.pid))
  f.write({ enabled: true, mechanism: 'windows-startup', node: process.execPath, script: f.script })
  const attempt = join(f.home, 'npm-attempt.json')
  const npm = join(f.home, 'fake-npm')
  mkdirSync(npm)
  const helper = join(npm, 'install.mjs')
  writeFileSync(helper, `import { writeFileSync } from 'node:fs';
let running = false;
try { running = (await fetch('http://127.0.0.1:${f.port}/api/health')).ok } catch {}
writeFileSync(${JSON.stringify(attempt)}, JSON.stringify({ running }));
process.exit(1);
`)
  const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
  const cli = process.env.PRUMO_TEST_UPDATE_CLI ?? join(repo, 'bin/prumo.mjs')
  writeFileSync(join(npm, 'npm.cmd'), `@echo off\r\nif "%~1"=="root" (\r\n echo ${join(f.home, 'node_modules')}\r\n exit /b 0\r\n)\r\nif "%~1"=="view" (\r\n echo "${version}"\r\n exit /b 0\r\n)\r\nif "%~1"=="exec" (\r\n "${process.execPath}" "${cli}" _update\r\n exit /b 1\r\n)\r\n"${process.execPath}" "${helper}"\r\nexit /b 1\r\n`)
  const env = { ...f.options.env }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
  const path = env[pathKey] ?? ''
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = `${npm};${path}`
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import="${pathToFileURL(join(repo, 'test/fixtures/dashboard-port.mjs')).href}"`.trim()
  env.PRUMO_TEST_DASHBOARD_PORT = String(f.port)
  env.PRUMO_UPDATE_REQUEST = JSON.stringify({ dryRun: false, cwd: f.home, projects: [], updateCli: true,
    sourceVersion: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version })
  const child = spawn(process.execPath, [cli, command], { env, cwd: f.home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.notEqual(code, 0, output)
  assert.match(output, /Global Prumo CLI update failed/)
  assert.deepEqual(JSON.parse(readFileSync(attempt, 'utf8')), { running: false }, 'o instalador nao pode receber o dashboard ainda rodando')
  const restored = await f.health()
  assert.ok(restored?.pid && restored.pid !== old.pid, output)
  assert.equal(f.preference().enabled, true)
  assert.equal(f.preference().pid, restored.pid)
  assert.equal(alive(old.pid), false)
  assert.equal(existsSync(join(f.home, '.local/share/prumo/update-pending.json')), true, 'a falha continua pendente para a proxima tentativa')
})

test('update restart never stops a port occupant that is not the managed Prumo dashboard', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const f = await isolatedDashboard(t)
  const pt = createTranslator(messages, 'pt-BR')
  const server = body => `require('node:http').createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(${body})) }).listen(${f.port}, '127.0.0.1')`
  const recordedPreference = { enabled: true, mechanism: 'windows-startup', pid: 424242, node: process.execPath, script: f.script }
  // Outro programa na porta representa um conflito.
  const foreign = f.start(['-e', server(`{ product: 'other' }`)])
  assert.ok(await waitFor(async () => (await f.health())?.product === 'other'))
  f.write(recordedPreference)
  const conflict = await restartDashboard(f.options)
  assert.equal(conflict.ok, false)
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.error, 'Port 4949 is used by another program that is not the Prumo dashboard, so it was not stopped. Close that program or free the port, then run prumo dashboard enable')
  assert.match(pt(conflict.error), /^A porta 4949 está ocupada por outro programa que não é o dashboard do Prumo, por isso ele não foi encerrado\. Feche esse programa/)
  assert.deepEqual(f.killed, [])
  assert.equal(alive(foreign.pid), true)
  foreign.kill()
  assert.ok(await waitFor(async () => !(await f.health())))
  // Um processo que afirma ser o dashboard do Prumo, mas não executa a linha de comando gerenciada.
  const impostor = f.start(['-e', server(`{ product: 'prumo', mode: 'global', readOnly: true, version: '2.0.0', pid: process.pid }`)])
  assert.ok(await waitFor(async () => (await f.health())?.pid === impostor.pid))
  const refused = await restartDashboard(f.options)
  assert.equal(refused.ok, false)
  assert.equal(refused.error, `Startup ownership verification failed: managed process not found; the dashboard on port 4949 (pid ${impostor.pid}) is not the Prumo process managed by this installation, so it was not stopped. Stop process ${impostor.pid}, then run prumo dashboard enable`)
  assert.equal(pt('Dashboard restart failed: {0}', pt(refused.error)), `Falha ao reiniciar o dashboard: Não foi possível confirmar a posse do dashboard: o processo gerenciado não foi encontrado; o dashboard na porta 4949 (pid ${impostor.pid}) não é o processo do Prumo gerenciado por esta instalação, por isso não foi encerrado. Encerre o processo ${impostor.pid} e depois execute prumo dashboard enable`)
  assert.deepEqual(f.killed, [])
  assert.equal(alive(impostor.pid), true)
  assert.deepEqual(f.preference(), recordedPreference, 'a refused restart keeps the recorded pid and command')
  const env = { ...f.options.env,
    NODE_OPTIONS: `${f.options.env.NODE_OPTIONS ?? ''} --import="${pathToFileURL(join(repo, 'test/fixtures/dashboard-port.mjs')).href}"`.trim(),
    PRUMO_TEST_DASHBOARD_PORT: String(f.port),
    PRUMO_UPDATE_REQUEST: JSON.stringify({ dryRun: false, cwd: f.home, projects: [], updateCli: false }),
  }
  const updater = spawn(process.execPath, [join(repo, 'bin/prumo.mjs'), '_update'], { env, cwd: f.home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  updater.stdout.on('data', chunk => { output += chunk })
  updater.stderr.on('data', chunk => { output += chunk })
  const code = await new Promise((resolve, reject) => { updater.once('error', reject); updater.once('close', resolve) })
  assert.notEqual(code, 0, output)
  assert.match(output, /ownership verification failed/)
  assert.equal(alive(impostor.pid), true)
  assert.equal(existsSync(join(f.home, '.local/share/prumo/update-pending.json')), false, 'a recusa acontece antes de gravar a atualizacao')
  assert.deepEqual(f.preference(), recordedPreference)
})
