// Porta padrão do dashboard; instalações anteriores registravam a porta legada, que só a migração reconhece.
export const DEFAULT_DASHBOARD_PORT = 4950
export const LEGACY_DASHBOARD_PORT = 4949
// Chrome, Edge e Firefox resolvem *.localhost para loopback sem arquivo hosts; somente este nome exato é aceito além de loopback.
export const DASHBOARD_ALIAS_HOST = 'prumo.localhost'

// Opções inválidas falham antes de abrir o dashboard ou sincronizar um plano.
export function parseServeArgs(tokens) {
  const values = {}
  const strings = new Set(['port', 'run', 'lang'])
  const booleans = new Set(['global', 'sync-plan'])
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], key = token.slice(2)
    if (!token.startsWith('--') || !strings.has(key) && !booleans.has(key)) throw new Error(`Unknown dashboard option: ${token}`)
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate option --${key}`)
    if (booleans.has(key)) { values[key] = true; continue }
    const value = tokens[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`Option --${key} requires a value`)
    values[key] = value
  }
  const port = values.port === undefined ? DEFAULT_DASHBOARD_PORT : Number(values.port)
  if (values.port !== undefined && !/^\d+$/.test(values.port) || !Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('--port must be an integer from 0 to 65535')
  if (values.run !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values.run)) throw new Error('--run must be a safe run name')
  if (values.lang !== undefined && !['en', 'pt-BR'].includes(values.lang)) throw new Error('Language must be en or pt-BR')
  if (values.global && values['sync-plan']) throw new Error('--global is read-only and cannot be combined with --sync-plan')
  return { port, run: values.run ?? null, syncPlan: values['sync-plan'] === true, global: values.global === true,
    ...(values.lang === undefined ? {} : { lang: values.lang }) }
}
