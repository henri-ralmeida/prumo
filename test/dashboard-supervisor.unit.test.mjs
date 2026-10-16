import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastDashboardExit, recordDashboardEvent } from '../scripts/dashboard-diagnostics.mjs'
import {
  RESTART_BASE_DELAY_MS, RESTART_LIMIT, RESTART_MAX_DELAY_MS, RESTART_WINDOW_MS,
  dashboardDisabled, dashboardPortServed, serverPort, stopRequestedSince, superviseDashboard,
} from '../scripts/dashboard-supervisor.mjs'

const crash = { code: 3221226505, signal: null }
const clean = { code: 0, signal: null }

// Relogio e espera simulados: o tempo só avança quando o supervisor "dorme", sem esperar tempo real.
function harness(results, overrides = {}) {
  const queue = [...results], events = [], sleeps = []
  let clock = 1_000_000
  const supervise = () => superviseDashboard({
    launch: async () => { assert.ok(queue.length, 'lançamento além do previsto'); return queue.shift() },
    record: (event, fields) => events.push({ event, ...fields }),
    disabled: () => false, stopRequested: () => false, portServed: async () => false, port: 4949,
    now: () => clock, sleep: async milliseconds => { sleeps.push(milliseconds); clock += milliseconds },
    ...overrides,
  })
  return { supervise, events, sleeps, advance: milliseconds => { clock += milliseconds }, remaining: () => queue.length }
}

test('queda inesperada recria o processo com espera e registra cada reinício', async () => {
  const h = harness([crash, { code: null, signal: 'SIGKILL' }, clean])
  assert.deepEqual(await h.supervise(), clean)
  assert.equal(h.remaining(), 0)
  assert.deepEqual(h.sleeps, [RESTART_BASE_DELAY_MS, RESTART_BASE_DELAY_MS * 2])
  assert.deepEqual(h.events.map(event => event.event), ['restart-scheduled', 'process-restart', 'restart-scheduled', 'process-restart'])
  assert.equal(h.events[0].code, crash.code)
  assert.equal(h.events[2].signal, 'SIGKILL')
  assert.deepEqual(h.events.filter(event => event.event === 'process-restart').map(event => event.attempt), [1, 2])
})

test('a espera cresce até o máximo e o limite por janela encerra as tentativas', async () => {
  const h = harness(Array(9).fill(crash), { limit: 8 })
  assert.deepEqual(await h.supervise(), crash)
  assert.deepEqual(h.sleeps, [1000, 2000, 4000, 8000, 16000, RESTART_MAX_DELAY_MS, RESTART_MAX_DELAY_MS, RESTART_MAX_DELAY_MS])
  assert.equal(h.remaining(), 0, 'o nono lançamento acontece e o décimo não é tentado')
  const last = h.events.at(-1)
  assert.equal(last.event, 'restart-limit')
  assert.match(last.message, /Giving up after 8 restarts within 10 minutes/)
  const defaults = harness(Array(RESTART_LIMIT + 1).fill(crash))
  await defaults.supervise()
  assert.equal(defaults.events.filter(event => event.event === 'process-restart').length, RESTART_LIMIT)
  assert.equal(defaults.events.at(-1).event, 'restart-limit')
})

test('tentativas antigas saem da janela e não contam para o limite', async () => {
  const results = [crash, crash, crash, crash, clean], events = []
  let clock = 0, launches = 0
  const outcome = await superviseDashboard({
    launch: async () => { launches++; clock += RESTART_WINDOW_MS; return results.shift() },
    record: (event, fields) => events.push({ event, ...fields }),
    disabled: () => false, stopRequested: () => false, portServed: async () => false, port: null,
    now: () => clock, sleep: async () => {}, limit: 2,
  })
  assert.deepEqual(outcome, clean)
  assert.equal(launches, 5)
  assert.ok(!events.some(event => event.event === 'restart-limit'))
  assert.deepEqual(events.filter(event => event.event === 'restart-scheduled').map(event => event.attempt), [1, 1, 1, 1])
})

test('parada intencional, saída limpa e falha de lançamento não recriam o processo', async () => {
  for (const [label, result, overrides] of [
    ['saída limpa', clean, {}],
    ['SIGTERM', { code: null, signal: 'SIGTERM' }, {}],
    ['SIGINT', { code: null, signal: 'SIGINT' }, {}],
    ['falha ao lançar', { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, {}],
    ['dashboard desabilitado', crash, { disabled: () => true }],
    ['disable ou restart pedido', crash, { stopRequested: () => true }],
    ['recriação desligada', crash, { limit: 0 }],
  ]) {
    const h = harness([result], overrides)
    assert.deepEqual(await h.supervise(), result, label)
    assert.deepEqual(h.sleeps, [], label)
    assert.deepEqual(h.events, [], label)
  }
})

test('pedido de parada durante a espera cancela a recriação', async () => {
  for (const cancel of ['disabled', 'stopRequested']) {
    let calls = 0
    const h = harness([crash], { [cancel]: () => ++calls > 1 })
    assert.deepEqual(await h.supervise(), crash)
    assert.deepEqual(h.sleeps, [RESTART_BASE_DELAY_MS])
    assert.deepEqual(h.events.map(event => event.event), ['restart-scheduled'], cancel)
  }
})

test('outro dashboard já servindo a porta impede um segundo processo', async () => {
  const h = harness([crash], { portServed: async port => port === 4949 })
  assert.deepEqual(await h.supervise(), crash)
  assert.deepEqual(h.events.map(event => event.event), ['restart-scheduled', 'restart-skipped'])
  assert.match(h.events[1].message, /Port 4949 is already served/)
  const noPort = harness([crash, clean], { port: null, portServed: async () => { throw new Error('não deve consultar a porta') } })
  assert.deepEqual(await noPort.supervise(), clean)
})

test('serverPort lê somente uma porta válida dos argumentos do servidor', () => {
  assert.equal(serverPort(['serve.mjs', '--global', '--port', '4949', '--lang', 'en']), 4949)
  for (const args of [[], ['--port'], ['--port', 'abc'], ['--port', '0'], ['--port', '-4'], ['--port', '49.5']]) assert.equal(serverPort(args), null)
})

test('dashboardPortServed distingue porta atendida de porta livre', async () => {
  const server = net.createServer(socket => socket.end()).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const { port } = server.address()
  assert.equal(await dashboardPortServed(port), true)
  await new Promise(resolve => server.close(resolve))
  assert.equal(await dashboardPortServed(port), false)
  // Um ouvinte que aceita e nunca responde ainda conta como servido; só a ausência de conexão libera a porta.
  const sockets = new Set()
  const silent = net.createServer(socket => { sockets.add(socket) }).listen(0, '127.0.0.1')
  await new Promise(resolve => silent.once('listening', resolve))
  assert.equal(await dashboardPortServed(silent.address().port), true)
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => silent.close(resolve))
})

test('dashboardPortServed encerra a espera de uma conexão que não se completa', async () => {
  const original = net.connect
  net.connect = () => Object.assign(new EventEmitter(), { setTimeout(milliseconds, listener) { this.timer = setTimeout(listener, 5) }, destroy() { clearTimeout(this.timer) } })
  try { assert.equal(await dashboardPortServed(65000), false) } finally { net.connect = original }
})

test('estado persistido e pedidos de parada vêm do diretório do usuário', t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-supervisor-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  assert.equal(dashboardDisabled(home), false, 'sem preferência o dashboard segue habilitado')
  const directory = join(home, '.local', 'share', 'prumo')
  mkdirSync(directory, { recursive: true })
  for (const [content, expected] of [['{ inválido', false], [JSON.stringify({ enabled: true }), false], [JSON.stringify({ enabled: false }), true]]) {
    writeFileSync(join(directory, 'dashboard.json'), content)
    assert.equal(dashboardDisabled(home), expected, content)
  }
  const since = Date.now()
  assert.equal(stopRequestedSince(home, since), false)
  recordDashboardEvent('enable-requested', {}, { home })
  recordDashboardEvent('disable-requested', {}, { home })
  assert.equal(stopRequestedSince(home, since), true)
  assert.equal(stopRequestedSince(home, Date.now() + 60000), false, 'pedido anterior ao início do processo não conta')
  const second = mkdtempSync(join(tmpdir(), 'prumo-supervisor-restart-'))
  t.after(() => rmSync(second, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  recordDashboardEvent('restart-requested', {}, { home: second })
  assert.equal(stopRequestedSince(second, since), true)
})

test('a queda é a última saída depois do último início, mesmo com eventos de reinício depois dela', () => {
  const started = { event: 'process-started' }, exited = { event: 'process-exit', code: 3 }
  assert.equal(lastDashboardExit([started, exited, { event: 'restart-scheduled' }, { event: 'restart-limit' }]), exited)
  assert.equal(lastDashboardExit([exited, { event: 'process-restart' }, started]), null)
  assert.equal(lastDashboardExit([{ event: 'enable-requested' }]), null)
  assert.equal(lastDashboardExit([]), null)
})
