import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import { fixture } from './fixtures/approved-graph.mjs'
import {
  DASHBOARD_ALIAS_URL, DASHBOARD_PORT, DASHBOARD_URL, dashboardNeedsRepair, dashboardStatus, enableDashboard, restartDashboard, stopDashboardForUpdate,
} from '../lib/autostart.mjs'
import { BOARD_URL } from '../lib/browser.mjs'
import { DASHBOARD_ALIAS_HOST, DEFAULT_DASHBOARD_PORT, LEGACY_DASHBOARD_PORT, parseServeArgs } from '../scripts/serve-args.mjs'

const LEGACY_PID = 4242
const NEW_PID = 5151

test('dashboard aceita controle por Host prumo.localhost e recusa nomes semelhantes', { timeout: 30000 }, async t => {
  let server, closed
  t.after(async () => { if (server?.exitCode === null) server.kill(); await closed })
  const f = fixture(t)
  server = spawn(process.execPath, [fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url)), '--port', '0'], {
    cwd: f.project, windowsHide: true, env: { ...process.env, PRUMO_HOME: f.home, PRUMO_ROOT: f.root },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  closed = new Promise(resolve => server.once('close', resolve))
  let output = ''
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 15000)
    const collect = chunk => {
      output += chunk
      const match = output.match(/localhost:(\d+)/)
      if (match && match[1] !== '0') { clearTimeout(timer); resolve(Number(match[1])) }
    }
    server.stdout.on('data', collect); server.stderr.on('data', collect)
    server.once('error', error => { clearTimeout(timer); reject(error) })
    server.once('exit', () => { clearTimeout(timer); reject(new Error(output)) })
  })
  const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`)
  assert.equal(stateResponse.status, 200)
  const { agentControlToken: token } = await stateResponse.json()
  assert.ok(token)
  const post = host => new Promise((resolve, reject) => {
    const body = JSON.stringify({ maxAgents: 2 })
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/agent-limit', method: 'POST', headers: {
      Host: host, Origin: `http://${host}`, 'X-Prumo-Control': token,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
    req.on('error', reject); req.end(body)
  })
  const before = f.state(), events = f.events()
  for (const host of [`prumo.localhost.evil.invalid:${port}`, `evil.prumo.localhost:${port}`])
    assert.equal(await post(host), 403, host)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  assert.equal(await post(`prumo.localhost:${port}`), 200)
  assert.equal(f.state().plan.maxAgents, 2)
})

// Mundo simulado: um dashboard Prumo antigo na porta legada e, opcionalmente, ocupantes alheios nas duas portas.
// Nada consulta a rede real, nem o dashboard do usuário.
function world(t, platform, mechanism, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prumo migration-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const node = join(home, 'Node JS', platform === 'win32' ? 'node.exe' : 'node')
  const script = join(home, 'Prumo Package', 'scripts', 'serve.mjs')
  const state = {
    legacy: extra.legacy ?? 'prumo', // prumo | unprovable | alien | none
    legacyRunning: (extra.legacy ?? 'prumo') !== 'none', newRunning: false, newAlien: extra.newAlien === true,
    task: mechanism === 'schtasks' && extra.task !== false, killed: [], calls: [], created: [], spawned: 0, stubborn: extra.stubborn === true,
  }
  const legacyArgs = [node, script, '--global', '--port', String(LEGACY_DASHBOARD_PORT)]
  const newArgs = [node, script, '--global', '--port', String(DEFAULT_DASHBOARD_PORT), '--lang', 'en']
  const describe = args => platform === 'win32' ? { executable: node, commandLine: args.map(value => `"${value}"`).join(' ') } : args
  const stopLegacy = () => { if (!state.stubborn) state.legacyRunning = false }
  const home_ = join(home, '.local', 'share', 'prumo')
  mkdirSync(home_, { recursive: true })
  const preference = { enabled: true, mechanism, node, script, pid: LEGACY_PID, ...(extra.preference ?? {}) }
  writeFileSync(join(home_, 'dashboard.json'), JSON.stringify(preference))
  const options = {
    platform, home, node, script, version: '2.10.0', contentId: 'content-new', lang: 'en', env: {}, uid: () => 1234,
    delay: async () => {}, readinessAttempts: 3, listProcessIds: () => [],
    fetch: async url => {
      const [, port, path] = String(url).match(/:(\d+)(\/api\/\w+)$/)
      const prumo = version => ({ ok: true, json: async () => path === '/api/health'
        ? { product: 'prumo', mode: 'global', readOnly: true, version, pid: version === '2.10.0' ? NEW_PID : LEGACY_PID }
        : { product: 'prumo', version, origin: 'global', contentId: version === '2.10.0' ? 'content-new' : 'content-old', path: home } })
      if (Number(port) === LEGACY_DASHBOARD_PORT) {
        if (state.legacy === 'alien') return { ok: true, json: async () => ({ product: 'other' }) }
        if (state.legacyRunning) return prumo('2.9.0')
        throw new Error('not running')
      }
      assert.equal(Number(port), DEFAULT_DASHBOARD_PORT)
      if (state.newAlien) return { ok: true, json: async () => ({ product: 'other' }) }
      if (state.newRunning) return prumo('2.10.0')
      throw new Error('not running')
    },
    portAvailable: async port => port === LEGACY_DASHBOARD_PORT ? !state.legacyRunning && state.legacy !== 'alien' : !state.newRunning && !state.newAlien,
    exec(file, args) {
      state.calls.push([file, ...args])
      const joined = args.join(' ')
      if (file === 'schtasks' && args[0] === '/Query') return { status: state.task ? 0 : 1, stdout: '' }
      if (file === 'schtasks' && args[0] === '/Create') { state.task = true; state.created.push(args.at(-1)) }
      if (file === 'schtasks' && args[0] === '/End') stopLegacy()
      if (file === 'schtasks' && args[0] === '/Run') state.newRunning = true
      if (file === 'launchctl' && args[0] === 'bootout') { if (extra.failStop) return { status: 5, stdout: '', stderr: 'denied' }; stopLegacy() }
      if (file === 'launchctl' && args[0] === 'kickstart') state.newRunning = true
      if (file === 'systemctl' && args[1] === 'show-environment') return { status: 0, stdout: '' }
      if (file === 'systemctl' && joined === '--user stop prumo-dashboard.service') { if (extra.failStop) return { status: 5, stdout: '', stderr: 'denied' }; stopLegacy() }
      if (file === 'systemctl' && /--user (enable --now|restart) prumo-dashboard.service/.test(joined)) state.newRunning = true
      return { status: 0, stdout: '' }
    },
    spawn: () => { state.spawned += 1; state.newRunning = true; return { pid: NEW_PID } },
    kill: pid => { state.killed.push(pid); if (pid === LEGACY_PID) stopLegacy() },
    readProcessCommand: pid => {
      if (pid === LEGACY_PID) return describe(state.legacy === 'unprovable' ? [node, join(home, 'other', 'serve.mjs'), '--global', '--port', '4950'] : legacyArgs)
      if (pid === NEW_PID) return describe(newArgs)
      throw new Error('process not found')
    },
  }
  return { home, node, script, state, options, preference: () => JSON.parse(readFileSync(join(home_, 'dashboard.json'), 'utf8')) }
}

function registrationContent(w, mechanism) {
  if (mechanism === 'schtasks') return w.state.created.at(-1)
  const file = {
    launchd: join(w.home, 'Library', 'LaunchAgents', 'dev.prumo.dashboard.plist'),
    systemd: join(w.home, '.config', 'systemd', 'user', 'prumo-dashboard.service'),
    xdg: join(w.home, '.config', 'autostart', 'prumo-dashboard.desktop'),
    'windows-startup': join(w.home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Prumo Dashboard.vbs'),
  }[mechanism]
  return readFileSync(file, 'utf8')
}

function stageLegacyRegistration(w, mechanism) {
  // O registro antigo carrega `--port 4950`; a migração precisa regravá-lo com a porta atual.
  const files = {
    launchd: join(w.home, 'Library', 'LaunchAgents', 'dev.prumo.dashboard.plist'),
    systemd: join(w.home, '.config', 'systemd', 'user', 'prumo-dashboard.service'),
    xdg: join(w.home, '.config', 'autostart', 'prumo-dashboard.desktop'),
    'windows-startup': join(w.home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Prumo Dashboard.vbs'),
  }
  if (files[mechanism]) {
    mkdirSync(dirname(files[mechanism]), { recursive: true })
    writeFileSync(files[mechanism], `--global --port ${LEGACY_DASHBOARD_PORT}`)
  }
}

const SCENARIOS = [
  ['win32', 'schtasks'], ['win32', 'windows-startup'], ['darwin', 'launchd'], ['linux', 'systemd'], ['linux', 'xdg'],
]

test('a porta padrão é 4949 em todos os pontos e --port continua valendo', () => {
  assert.equal(DEFAULT_DASHBOARD_PORT, 4949)
  assert.equal(LEGACY_DASHBOARD_PORT, 4950)
  assert.equal(DASHBOARD_PORT, 4949)
  assert.equal(DASHBOARD_URL, 'http://localhost:4949')
  assert.equal(BOARD_URL, 'http://localhost:4949', 'o navegador continua abrindo localhost')
  assert.equal(DASHBOARD_ALIAS_HOST, 'prumo.localhost')
  assert.equal(DASHBOARD_ALIAS_URL, 'http://prumo.localhost:4949')
  assert.equal(parseServeArgs([]).port, 4949)
  assert.equal(parseServeArgs(['--port', '4950']).port, 4950)
  assert.equal(parseServeArgs(['--port', '4951']).port, 4951)
})

for (const action of [enableDashboard, restartDashboard]) for (const [platform, mechanism] of SCENARIOS) {
  test(`${action.name} em ${platform}/${mechanism} migra o registro 4950 para 4949 e para somente o Prumo comprovado`, async t => {
    const w = world(t, platform, mechanism)
    stageLegacyRegistration(w, mechanism)
    const result = await action(w.options)
    assert.equal(result.ok, true, result.error)
    assert.equal(w.state.legacyRunning, false, 'o dashboard antigo na 4950 foi parado')
    assert.equal(w.state.newRunning, true, 'o dashboard novo responde na 4949')
    assert.equal(result.port, 4949)
    assert.equal(result.legacy, false)
    const content = registrationContent(w, mechanism)
    assert.match(content, /4949/)
    assert.doesNotMatch(content, /4950/, 'o registro não mantém a porta legada')
    if (['windows-startup', 'xdg'].includes(mechanism)) assert.deepEqual(w.state.killed, [LEGACY_PID], 'apenas o processo comprovado foi encerrado')
    else assert.deepEqual(w.state.killed, [], 'o gerenciador do sistema parou o processo, sem kill direto')
  })
}

for (const action of [enableDashboard, restartDashboard]) for (const [platform, mechanism] of [['win32', 'schtasks'], ['linux', 'xdg']]) {
  test(`${action.name} em ${mechanism} não encerra processo alheio na porta legada`, async t => {
    const w = world(t, platform, mechanism, { legacy: 'alien' })
    stageLegacyRegistration(w, mechanism)
    const result = await action(w.options)
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(w.state.killed, [])
    assert.equal(w.state.calls.some(call => call[0] === 'schtasks' && call[1] === '/End'), false)
    assert.equal(w.state.legacyRunning, true, 'o ocupante alheio continua intocado')
    assert.equal(w.state.newRunning, true)
  })

  test(`${action.name} em ${mechanism} recusa Prumo na porta legada sem comando comprovado e não regrava o registro`, async t => {
    const w = world(t, platform, mechanism === 'schtasks' ? 'windows-startup' : mechanism, { legacy: 'unprovable' })
    const effective = mechanism === 'schtasks' ? 'windows-startup' : mechanism
    stageLegacyRegistration(w, effective)
    const before = registrationContent(w, effective)
    const result = await action(w.options)
    assert.equal(result.ok, false)
    assert.match(result.error, /Startup ownership verification failed: managed process not found; the dashboard on port 4950 \(pid 4242\) is not the Prumo process managed by this installation, so it was not stopped/)
    assert.deepEqual(w.state.killed, [])
    assert.equal(w.state.newRunning, false, 'nenhum segundo dashboard é iniciado')
    assert.equal(registrationContent(w, effective), before)
  })
}

for (const action of [enableDashboard, restartDashboard]) {
  test(`${action.name} com a 4949 ocupada por processo alheio informa o conflito e não encerra o dashboard antigo`, async t => {
    const w = world(t, 'linux', 'xdg', { newAlien: true })
    const result = await action(w.options)
    assert.equal(result.ok, false)
    assert.equal(result.conflict, true)
    assert.match(result.error, /^Port 4949 is used by another program that is not the Prumo dashboard, so it was not stopped/)
    assert.deepEqual(w.state.killed, [])
    assert.equal(w.state.legacyRunning, true)
  })
}

test('falhas ao parar o dashboard antigo são informadas sem regravar o registro', async t => {
  for (const [platform, mechanism] of [['darwin', 'launchd'], ['linux', 'systemd']]) {
    const w = world(t, platform, mechanism, { failStop: true })
    stageLegacyRegistration(w, mechanism)
    const before = registrationContent(w, mechanism)
    const result = await enableDashboard(w.options)
    assert.equal(result.ok, false)
    assert.match(result.error, /^Startup process stop failed: .* failed$/)
    assert.equal(registrationContent(w, mechanism), before)
    assert.equal(w.state.legacyRunning, true)
  }
  for (const [platform, mechanism, extra] of [['win32', 'schtasks', {}], ['linux', 'xdg', {}]]) {
    // O processo continua respondendo depois da parada solicitada: a migração falha sem matar nada além do solicitado.
    const w = world(t, platform, mechanism, { ...extra, stubborn: true })
    const result = await enableDashboard(w.options)
    assert.equal(result.ok, false)
    assert.match(result.error, /the dashboard on port 4950 \(pid 4242\) is not the Prumo process managed by this installation/)
    assert.equal(w.state.newRunning, false)
  }
})

test('schtasks sem tarefa registrada recorre ao processo comprovado na porta legada', async t => {
  const w = world(t, 'win32', 'schtasks', { task: false })
  const result = await enableDashboard(w.options)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(w.state.killed, [LEGACY_PID])
  assert.equal(w.state.calls.some(call => call[1] === '/End'), false)
  assert.match(w.state.created.at(-1), /4949/)
  assert.doesNotMatch(w.state.created.at(-1), /4950/)
})

test('stopDashboardForUpdate reconhece e para o dashboard antigo na 4950, sem tocar em ocupante alheio', async t => {
  const legacy = world(t, 'linux', 'xdg')
  assert.deepEqual(await stopDashboardForUpdate(legacy.options), { ok: true, stopped: true })
  assert.deepEqual(legacy.state.killed, [LEGACY_PID])
  assert.equal(legacy.state.legacyRunning, false)

  const alien = world(t, 'linux', 'xdg', { legacy: 'alien' })
  assert.deepEqual(await stopDashboardForUpdate(alien.options), { ok: true, stopped: false })
  assert.deepEqual(alien.state.killed, [])

  const none = world(t, 'linux', 'xdg', { legacy: 'none' })
  assert.deepEqual(await stopDashboardForUpdate(none.options), { ok: true, stopped: false })

  const unprovable = world(t, 'linux', 'xdg', { legacy: 'unprovable' })
  const refused = await stopDashboardForUpdate(unprovable.options)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /port 4950/)
  assert.deepEqual(unprovable.state.killed, [])
})

test('status reconhece o dashboard antigo na 4950 como pendente de migração', async t => {
  const legacy = world(t, 'linux', 'xdg')
  const pending = await dashboardStatus(legacy.options)
  assert.equal(pending.process, 'stopped')
  assert.equal(pending.legacy, true)
  assert.equal(pending.port, 4949)
  assert.equal(dashboardNeedsRepair(pending), true)

  for (const kind of ['alien', 'none']) {
    const other = world(t, 'linux', 'xdg', { legacy: kind })
    assert.equal((await dashboardStatus(other.options)).legacy, false, kind)
  }

  const migrated = world(t, 'linux', 'xdg')
  assert.equal((await enableDashboard(migrated.options)).ok, true)
  assert.equal((await dashboardStatus(migrated.options)).legacy, false)
  assert.equal(existsSync(join(migrated.home, '.config', 'autostart', 'prumo-dashboard.desktop')), true)
})

test('migração usa o Node e o script desta instalação quando a preferência antiga não os registrou', async t => {
  const w = world(t, 'linux', 'xdg', { preference: { node: undefined, script: undefined } })
  assert.equal('node' in w.preference(), false)
  const result = await enableDashboard(w.options)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(w.state.killed, [LEGACY_PID])
})
