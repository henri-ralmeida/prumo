// Preloaded with NODE_OPTIONS=--import by the upgrade smoke: every Prumo process of the scenario
// (old CLI, npm exec updater and the dashboard it launches) uses an isolated port in place of the
// fixed dashboard port, so the user's real dashboard on 4949 is never contacted.
import net from 'node:net'
import { appendFileSync } from 'node:fs'

// Registre o encerramento do servidor isolado para distinguir falha de lançamento de falha de prontidão.
const diagnostics = process.env.PRUMO_TEST_DASHBOARD_DIAGNOSTICS
let recordDashboard = () => {}
if (diagnostics && process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/serve.mjs')) {
  const record = detail => { try { appendFileSync(diagnostics, `${JSON.stringify({ pid: process.pid, time: Date.now(), ...detail })}\n`) } catch {} }
  record({ event: 'inicio', port: process.env.PRUMO_TEST_DASHBOARD_PORT, script: process.argv[1] })
  process.on('uncaughtExceptionMonitor', error => record({ event: 'erro', error: error.stack }))
  process.on('exit', code => record({ event: 'saida', code }))
  recordDashboard = record
}

const DASHBOARD_PORT = 4949
const port = Number(process.env.PRUMO_TEST_DASHBOARD_PORT)
const shutdownToken = process.env.PRUMO_TEST_DASHBOARD_SHUTDOWN_TOKEN
if (Number.isInteger(port) && port > 0 && port !== DASHBOARD_PORT) {
  const listen = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    const legacyPort = Number(args[0]) === DASHBOARD_PORT && typeof args[0] !== 'object'
      || args[0] && typeof args[0] === 'object' && Number(args[0].port) === DASHBOARD_PORT
    if (legacyPort) this.once('listening', () => recordDashboard({ event: 'ouvindo', address: this.address() }))
    if (legacyPort && shutdownToken) {
      const emit = this.emit
      this.emit = function (event, ...values) {
        if (event === 'request' && values[0]?.method === 'POST'
          && values[0]?.url === `/__prumo_test_dashboard_shutdown/${shutdownToken}`
          && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(values[0]?.socket.remoteAddress)) {
          values[1].writeHead(200)
          values[1].end('stopping')
          setTimeout(() => process.exit(0), 10).unref()
          return true
        }
        return emit.call(this, event, ...values)
      }
    }
    if (legacyPort && typeof args[0] !== 'object') args[0] = port
    else if (legacyPort) args[0] = { ...args[0], port }
    return listen.apply(this, args)
  }
  const fetch = globalThis.fetch
  globalThis.fetch = (input, init) => fetch(typeof input === 'string' || input instanceof URL
    ? String(input).replace(/^(http:\/\/(?:127\.0\.0\.1|localhost)):4949(?=[/?#]|$)/, `$1:${port}`) : input, init)
}
