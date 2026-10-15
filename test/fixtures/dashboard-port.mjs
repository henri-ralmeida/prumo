// Pré-carregado com NODE_OPTIONS=--import pelo teste de atualização: cada processo Prumo do cenário
// (CLI antiga, atualizador npm exec e o dashboard que ele inicia) usa uma porta isolada em vez da
// portas fixas do dashboard, para que o dashboard real do usuário (4950, ou 4949 em instalações anteriores) nunca seja contatado.
// PRUMO_TEST_DASHBOARD_PORT isola a porta atual; PRUMO_TEST_LEGACY_DASHBOARD_PORT isola a porta legada das versões publicadas
// antigas e, quando ausente, a porta legada usa o mesmo destino da porta atual.
import net from 'node:net'
import { appendFileSync } from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

// As atualizações históricas exercitam a instalação real sem abrir abas ou prender a pasta temporária.
const execFile = childProcess.execFile
childProcess.execFile = (file, args, options, callback) => {
  if (!['rundll32.exe', 'open', 'xdg-open'].includes(file)) return execFile(file, args, options, callback)
  callback(new Error('navegador isolado indisponível'))
}
syncBuiltinESMExports()

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

const DASHBOARD_PORT = 4950
const LEGACY_PORT = 4949
const port = Number(process.env.PRUMO_TEST_DASHBOARD_PORT)
const legacyTarget = Number(process.env.PRUMO_TEST_LEGACY_DASHBOARD_PORT)
const legacyPort = Number.isInteger(legacyTarget) && legacyTarget > 0 ? legacyTarget : port
const isolated = value => Number(value) === DASHBOARD_PORT ? port : Number(value) === LEGACY_PORT ? legacyPort : undefined
const shutdownToken = process.env.PRUMO_TEST_DASHBOARD_SHUTDOWN_TOKEN
if (Number.isInteger(port) && port > 0 && port !== DASHBOARD_PORT && port !== LEGACY_PORT) {
  const connect = net.createConnection
  net.createConnection = function (options, ...args) {
    if (options && typeof options === 'object' && isolated(options.port) !== undefined)
      options = { ...options, port: isolated(options.port) }
    return connect.call(this, options, ...args)
  }
  const listen = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    const requested = typeof args[0] === 'object' ? args[0]?.port : args[0]
    const target = isolated(requested)
    const redirected = target !== undefined
    if (redirected) this.once('listening', () => recordDashboard({ event: 'ouvindo', address: this.address() }))
    if (redirected && shutdownToken) {
      const emit = this.emit
      this.emit = function (event, ...values) {
        if (event === 'request' && values[0]?.method === 'POST'
          && values[0]?.url === `/__prumo_test_dashboard_shutdown/${shutdownToken}`
          && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(values[0]?.socket.remoteAddress)) {
          // Aguarde a resposta e o fechamento das conexoes para nao interromper a confirmacao de desligamento.
          values[1].writeHead(200, { Connection: 'close' })
          values[1].end('stopping')
          this.close(() => process.exit(0))
          return true
        }
        return emit.call(this, event, ...values)
      }
    }
    if (redirected && typeof args[0] !== 'object') args[0] = target
    else if (redirected) args[0] = { ...args[0], port: target }
    return listen.apply(this, args)
  }
  const fetch = globalThis.fetch
  globalThis.fetch = (input, init) => fetch(typeof input === 'string' || input instanceof URL
    ? String(input).replace(/^(http:\/\/(?:127\.0\.0\.1|localhost)):(4949|4950)(?=[/?#]|$)/, (_, host, original) => `${host}:${isolated(original)}`) : input, init)
}
