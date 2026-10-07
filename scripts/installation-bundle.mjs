import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
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
  for (const name of ['messages.json', 'region.mjs', 'i18n.mjs', 'storage.mjs', 'atomic-state.mjs', 'task-scope.mjs', 'validation.mjs', 'execution-readiness.mjs', 'contract-drift.mjs', 'sync-plan-audit.mjs', 'task-identifiers.mjs', 'dashboard-diagnostics.mjs', 'dashboard-update.mjs', 'dashboard.html', 'installation-bundle.mjs', 'engine-args.mjs', 'command-metrics.mjs', 'review-readiness.mjs', 'engine.mjs', 'serve-args.mjs', 'serve.mjs']) files.push(join('scripts', name))
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
