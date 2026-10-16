// Recria o dashboard após uma saída inesperada, com espera progressiva e limite de tentativas por janela de tempo.
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { readDashboardEvents } from './dashboard-diagnostics.mjs'

export const RESTART_BASE_DELAY_MS = 1000
export const RESTART_MAX_DELAY_MS = 30000
export const RESTART_LIMIT = 5
export const RESTART_WINDOW_MS = 10 * 60 * 1000
// Sinais enviados por quem encerra o serviço de propósito; nunca indicam queda.
const STOP_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK'])
// Pedidos registrados pelos comandos que param o dashboard de propósito.
const STOP_REQUESTS = new Set(['disable-requested', 'restart-requested', 'stop-requested'])

// O restart interno vale somente enquanto o dashboard continua habilitado.
export function dashboardDisabled(home) {
  try { return JSON.parse(readFileSync(join(home, '.local', 'share', 'prumo', 'dashboard.json'), 'utf8')).enabled === false }
  catch { return false }
}

// disable, restart e update gravam o pedido antes de encerrar o processo; um pedido posterior ao início do filho é parada intencional.
export function stopRequestedSince(home, since) {
  return readDashboardEvents({ home, limit: 50 }).some(event => STOP_REQUESTS.has(event.event) && Date.parse(event.at) >= since)
}

export function dashboardPortServed(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = served => { socket.destroy(); resolve(served) }
    socket.setTimeout(500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export function serverPort(args) {
  const index = args.indexOf('--port')
  const port = index === -1 ? NaN : Number(args[index + 1])
  return Number.isInteger(port) && port > 0 ? port : null
}

// Executa o filho até uma saída que não deva ser reiniciada e devolve o último resultado.
export async function superviseDashboard({ launch, record, disabled, stopRequested, portServed, port, now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), limit = RESTART_LIMIT }) {
  const restarts = []
  for (;;) {
    const startedAt = now()
    const result = await launch()
    const unexpected = !result.error && (result.signal ? !STOP_SIGNALS.has(result.signal) : result.code !== 0)
    if (!unexpected || limit < 1) return result
    if (disabled() || stopRequested(startedAt)) return result
    const current = now()
    while (restarts.length && current - restarts[0] >= RESTART_WINDOW_MS) restarts.shift()
    if (restarts.length >= limit) {
      record('restart-limit', { code: result.code, signal: result.signal,
        message: `Giving up after ${limit} restarts within ${RESTART_WINDOW_MS / 60000} minutes` })
      return result
    }
    const delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** restarts.length, RESTART_MAX_DELAY_MS)
    record('restart-scheduled', { attempt: restarts.length + 1, delayMs: delay, code: result.code, signal: result.signal,
      message: `Restart ${restarts.length + 1} of ${limit} in ${delay} ms` })
    await sleep(delay)
    if (disabled() || stopRequested(startedAt)) return result
    if (port !== null && await portServed(port)) {
      record('restart-skipped', { message: `Port ${port} is already served by another dashboard` })
      return result
    }
    restarts.push(now())
    record('process-restart', { attempt: restarts.length, message: `Restarting the dashboard (attempt ${restarts.length} of ${limit})` })
  }
}
