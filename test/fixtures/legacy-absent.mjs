// A porta legada (4950) nunca deve ser consultada de verdade, porque o dashboard real do usuário pode estar nela.
// Estes testes simulam apenas a porta atual; as migrações têm testes próprios que controlam a porta legada.
const LEGACY_PORT = 4950
const WRAPPED = ['dashboardHealth', 'dashboardStatus', 'disableDashboard', 'enableDashboard', 'restartDashboard', 'stopDashboardForUpdate']

export function legacyAbsent(options = {}) {
  const fetch = options.fetch ?? globalThis.fetch
  const portAvailable = options.portAvailable
  return {
    ...options,
    fetch: (url, init) => String(url).includes(`:${LEGACY_PORT}/`) ? Promise.reject(new Error('dashboard legado isolado ausente')) : fetch(url, init),
    ...(portAvailable ? { portAvailable: port => port === LEGACY_PORT ? Promise.resolve(true) : portAvailable(port) } : {}),
  }
}

export function legacyAbsentApi(autostart) {
  return Object.fromEntries(WRAPPED.map(name => [name, (options, ...rest) => autostart[name](legacyAbsent(options), ...rest)]))
}
