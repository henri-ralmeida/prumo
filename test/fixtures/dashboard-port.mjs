// Preloaded with NODE_OPTIONS=--import by the upgrade smoke: every Prumo process of the scenario
// (old CLI, npm exec updater and the dashboard it launches) uses an isolated port in place of the
// fixed dashboard port, so the user's real dashboard on 4949 is never contacted.
import net from 'node:net'

const DASHBOARD_PORT = 4949
const port = Number(process.env.PRUMO_TEST_DASHBOARD_PORT)
if (Number.isInteger(port) && port > 0 && port !== DASHBOARD_PORT) {
  const listen = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    if (Number(args[0]) === DASHBOARD_PORT && typeof args[0] !== 'object') args[0] = port
    else if (args[0] && typeof args[0] === 'object' && Number(args[0].port) === DASHBOARD_PORT) args[0] = { ...args[0], port }
    return listen.apply(this, args)
  }
  const fetch = globalThis.fetch
  globalThis.fetch = (input, init) => fetch(typeof input === 'string' || input instanceof URL
    ? String(input).replace(/^(http:\/\/(?:127\.0\.0\.1|localhost)):4949(?=[/?#]|$)/, `$1:${port}`) : input, init)
}
