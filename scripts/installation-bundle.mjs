import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localizeDashboard } from './i18n.mjs'

const PACKAGE = dirname(dirname(fileURLToPath(import.meta.url)))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function walk(path, base = path) {
  let entries
  try { entries = readdirSync(path, { withFileTypes: true }) } catch { return [] }
  const result = []
  for (const entry of entries) {
    const file = join(path, entry.name)
    if (entry.isDirectory()) result.push(...walk(file, base))
    else if (entry.isFile()) result.push(relative(base, file))
  }
  return result
}

export function installationBundle(lang, packageRoot = PACKAGE) {
  const files = ['README.md', 'README.pt-BR.md', 'LICENSE', ...walk(join(packageRoot, 'references')).map(path => join('references', path))]
  files.push(join('lib', 'release-notes.mjs'), join('scripts', 'release-notes.json'))
  // Primeiro as dependências, depois os pontos de entrada e por último a descoberta. Clientes ativos concluem o trabalho sem reiniciar.
  for (const name of ['messages.json', 'region.mjs', 'i18n.mjs', 'storage.mjs', 'atomic-state.mjs', 'task-scope.mjs', 'delivery-evidence.mjs', 'run-metadata.mjs', 'recorded-timing.mjs', 'validation.mjs', 'execution-readiness.mjs', 'contract-drift.mjs', 'sync-plan-audit.mjs', 'task-identifiers.mjs', 'dashboard-diagnostics.mjs', 'dashboard-update.mjs', 'dashboard.html', 'installation-bundle.mjs', 'engine-args.mjs', 'command-metrics.mjs', 'review-readiness.mjs', 'engine.mjs', 'serve-args.mjs', 'serve.mjs']) files.push(join('scripts', name))
  files.push('SKILL.md')
  return files.map(name => [name, name === join('scripts', 'dashboard.html') ? Buffer.from(localizeDashboard(readFileSync(join(packageRoot, name), 'utf8'), lang)) : readFileSync(join(packageRoot, name))])
}

export function bundleIdentity(files) {
  const pairs = files.map(([name, bytes]) => [name.replace(/\\/g, '/'), sha256(bytes)])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex').slice(0, 12)
}

export function packageIdentity(lang = 'en', { packageRoot = PACKAGE } = {}) {
  const files = installationBundle(lang, packageRoot)
  return {
    contentId: bundleIdentity(files),
    engineHash: sha256(files.find(([name]) => name === join('scripts', 'engine.mjs'))[1]),
  }
}

export function contentId(lang = 'en', options) {
  return packageIdentity(lang, options).contentId
}

// O dashboard tem bytes localizados; compare os arquivos executados nos dois idiomas, sem confiar no marcador.
export function engineDashboardMismatch(engineRoot, dashboardContentId) {
  if (typeof dashboardContentId !== 'string' || !dashboardContentId) return null
  try {
    const identities = ['en', 'pt-BR'].map(lang => bundleIdentity(installationBundle(lang, engineRoot).map(([name, bytes]) =>
      [name, name === join('scripts', 'dashboard.html')
        ? Buffer.from(bytes.toString().replace(/(const defaultLanguage = )"(?:en|pt-BR)"/, (_, prefix) => prefix + JSON.stringify(lang)))
        : bytes])))
    return identities.includes(dashboardContentId) ? null : { engineContentId: identities[0], dashboardContentId }
  } catch { return null }
}

export async function registeredDashboardIdentity({ home, fetch = globalThis.fetch }) {
  let preference
  try { preference = JSON.parse(readFileSync(join(home, '.local', 'share', 'prumo', 'dashboard.json'), 'utf8')) }
  catch { return null }
  if (preference.enabled !== true || typeof preference.script !== 'string' || !isAbsolute(preference.script)) return null
  try {
    const response = await fetch('http://127.0.0.1:4949/api/health', { signal: AbortSignal.timeout(1200) })
    const health = response.ok ? await response.json() : null
    if (health?.product !== 'prumo' || health.mode !== 'global' || health.readOnly !== true) return null
    const details = await fetch('http://127.0.0.1:4949/api/about', { signal: AbortSignal.timeout(1200) })
    const about = details.ok ? await details.json() : null
    return about?.product === 'prumo' && typeof about.contentId === 'string' ? about.contentId : null
  } catch {
    // Sem resposta saudável, a cópia registrada ainda permite comparar o próximo dashboard usado.
    try { return contentId(preference.lang === 'pt-BR' ? 'pt-BR' : 'en', { packageRoot: dirname(dirname(preference.script)) }) }
    catch { return null }
  }
}
