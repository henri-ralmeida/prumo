import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, renameSync, unlinkSync, rmdirSync, rmSync, copyFileSync, statSync, accessSync, constants, readlinkSync, symlinkSync, realpathSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname, join, relative, sep, isAbsolute, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { inside } from '../scripts/storage.mjs'
import { language } from '../scripts/i18n.mjs'
import { dashboardStatus, enableDashboard, restartDashboard } from './autostart.mjs'
import { installationBundle, bundleIdentity, packageIdentity, contentId } from '../scripts/installation-bundle.mjs'

export { contentId, packageIdentity }

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')).version
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bytesAt = path => existsSync(path) ? readFileSync(path) : null
const linkTarget = path => readlinkSync(path).replace(/^\\\\\?\\/, '')
function entryBytes(file, link) {
  const stat = lstatSync(file, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink() !== Boolean(link)) throw new Error(`File type changed during installation: ${file}`)
  return link ? Buffer.from(linkTarget(file)) : bytesAt(file)
}
const same = (a, b) => a === null || b === null ? a === b : a.equals(b)
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))

function ancestors(path) {
  const paths = []
  for (let current = resolve(path); ; current = dirname(current)) {
    paths.push(current)
    if (dirname(current) === current) return paths
  }
}

function projectAncestors(path) {
  const paths = ancestors(path)
  const boundary = paths.find(root => existsSync(join(root, '.git'))) ?? paths.find(root => existsSync(join(root, 'package.json')) || existsSync(join(root, '.specs', 'graph'))) ?? paths[0]
  return paths.slice(0, paths.indexOf(boundary) + 1)
}

function noLinks(path) {
  for (const parent of ancestors(path)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error(`Linked path requires an explicit installation at its real location: ${parent}`)
  }
}

function walk(path, base = path, links = false) {
  if (!existsSync(path)) return []
  const result = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      if (!links) throw new Error(`Linked file cannot be replaced automatically: ${file}`)
      result.push(relative(base, file))
    }
    else if (entry.isDirectory()) result.push(...walk(file, base, links))
    else if (entry.isFile()) result.push(relative(base, file))
  }
  return result
}

function removeEmptyTree(path) {
  if (!existsSync(path)) return
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Legacy skill changed during installation: ${file}`)
    removeEmptyTree(file)
  }
  rmdirSync(path)
}

function copySnapshot(source, destination) {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) {
    symlinkSync(linkTarget(source), destination, statSync(source, { throwIfNoEntry: false })?.isDirectory() ? 'junction' : 'file')
  } else if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const name of readdirSync(source)) copySnapshot(join(source, name), join(destination, name))
  } else {
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination, constants.COPYFILE_EXCL)
  }
}

function treeStamp(root) {
  const digest = createHash('sha256')
  for (const name of walk(root, root, true).sort()) {
    const file = join(root, name)
    const stat = lstatSync(file)
    digest.update(name.replace(/\\/g, '/')).update('\0')
    if (stat.isSymbolicLink()) digest.update('link\0').update(linkTarget(file))
    else digest.update(`file\0${stat.size}\0`).update(fileHash(file))
  }
  return digest.digest('hex')
}

function relocatedTarget(target, source, destination, original, relocated) {
  if (!isAbsolute(target)) {
    const absolute = resolve(dirname(original), target)
    return inside(source, absolute) ? target : relative(dirname(relocated), absolute)
  }
  return inside(source, resolve(target)) ? join(destination, relative(source, resolve(target))) : target
}

function ensureMigratedLinkTarget(original, targetPath, sourceRoot, relocating, relocatedRoot) {
  const absolute = resolve(dirname(original), targetPath)
  if (!inside(sourceRoot, absolute) || absolute === sourceRoot) return
  const stat = lstatSync(absolute, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) return
  // A realocação integral de .specs recria recursivamente os diretórios vazios.
  if (relocating && inside(relocatedRoot, absolute)) return
  if (walk(absolute, absolute, true).length) return
  throw new Error(`Legacy graph link targets a directory that migration cannot recreate: ${original}`)
}

function copyRelocatedTree(current, relocated, backupRoot, originalRoot, destinationRoot, links = [], mappingSource = originalRoot, mappingDestination = destinationRoot) {
  const root = current === backupRoot
  const stat = lstatSync(current)
  const original = join(originalRoot, relative(backupRoot, current))
  if (stat.isSymbolicLink()) {
    const savedTarget = linkTarget(current)
    const absoluteTarget = resolve(dirname(original), savedTarget)
    const targetStat = inside(originalRoot, absoluteTarget)
      ? statSync(join(backupRoot, relative(originalRoot, absoluteTarget)), { throwIfNoEntry: false })
      : statSync(current, { throwIfNoEntry: false })
    const target = relocatedTarget(savedTarget, mappingSource, mappingDestination, original, relocated)
    links.push({ target, relocated, type: targetStat?.isDirectory() ? 'junction' : 'file' })
  } else if (stat.isDirectory()) {
    mkdirSync(relocated, { recursive: true })
    for (const name of readdirSync(current)) copyRelocatedTree(join(current, name), join(relocated, name), backupRoot, originalRoot, destinationRoot, links, mappingSource, mappingDestination)
  } else {
    mkdirSync(dirname(relocated), { recursive: true })
    copyFileSync(current, relocated, constants.COPYFILE_EXCL)
  }
  if (root) for (const link of links) symlinkSync(link.target, link.relocated, link.type)
}

function fileHash(file) {
  const digest = createHash('sha256')
  const descriptor = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null)
      if (!bytes) break
      digest.update(buffer.subarray(0, bytes))
    }
  } finally { closeSync(descriptor) }
  return digest.digest('hex')
}

function verifyRelocatedTree(backupRoot, destinationRoot, originalRoot, mappingSource = originalRoot, mappingDestination = destinationRoot) {
  const before = walk(backupRoot, backupRoot, true).sort()
  const after = walk(destinationRoot, destinationRoot, true).sort()
  if (before.length !== after.length || before.some((name, index) => name !== after[index])) return false
  return before.every(name => {
    const source = join(backupRoot, name)
    const destination = join(destinationRoot, name)
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) {
      const original = join(originalRoot, name)
      return linkTarget(destination) === relocatedTarget(linkTarget(source), mappingSource, mappingDestination, original, destination)
    }
    return lstatSync(destination).isFile() && stat.size === lstatSync(destination).size && fileHash(source) === fileHash(destination)
  })
}

function verifyExactTree(sourceRoot, destinationRoot) {
  const before = walk(sourceRoot, sourceRoot, true).sort()
  const after = walk(destinationRoot, destinationRoot, true).sort()
  if (before.length !== after.length || before.some((name, index) => name !== after[index])) return false
  return before.every(name => {
    const source = join(sourceRoot, name)
    const destination = join(destinationRoot, name)
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) return lstatSync(destination).isSymbolicLink() && linkTarget(source) === linkTarget(destination)
    return lstatSync(destination).isFile() && stat.size === lstatSync(destination).size && fileHash(source) === fileHash(destination)
  })
}

export function installedContentId(root, lang = 'en') {
  try {
    const files = installationBundle(lang).map(([name]) => {
      const file = join(root, 'prumo', name)
      noLinks(file)
      return [name, readFileSync(file)]
    })
    return bundleIdentity(files)
  } catch { return null }
}

export function inspectInstallation(root, marker = readInstallationMarker(root), { packageRoot = PACKAGE } = {}) {
  const lang = ['en', 'pt-BR'].includes(marker.lang) ? marker.lang : 'en'
  const expected = packageIdentity(lang, { packageRoot })
  const currentContentId = installedContentId(root, lang)
  let currentEngineHash = null
  try {
    const file = join(root, 'prumo', 'scripts', 'engine.mjs')
    noLinks(file)
    currentEngineHash = hash(readFileSync(file))
  } catch { /* incomplete or older install */ }
  return {
    root, harness: marker.harness, version: marker.version, lang,
    contentId: currentContentId ?? marker.contentId ?? null,
    markerContentId: marker.contentId ?? null,
    expectedContentId: expected.contentId,
    engineHash: currentEngineHash,
    markerEngineHash: marker.engineHash ?? null,
    expectedEngineHash: expected.engineHash,
    legacyMarker: !marker.contentId || !marker.engineHash,
    markerContentCurrent: Boolean(marker.contentId && currentContentId && marker.contentId === currentContentId),
    markerEngineCurrent: Boolean(marker.engineHash && currentEngineHash && marker.engineHash === currentEngineHash),
    packageEngineCurrent: currentEngineHash === expected.engineHash,
    packageContentCurrent: currentContentId === expected.contentId,
    filesCurrent: installationFilesCurrent(root, marker),
  }
}

function change(group, file, content, link) {
  file = resolve(file)
  noLinks(link ? dirname(file) : file)
  const before = entryBytes(file, link)
  const after = content === null ? null : Buffer.isBuffer(content) ? content : Buffer.from(content)
  if (!same(before, after)) group.changes.push({ file, before, after, ...(link && { link }) })
}

function instructionBlock(text, body) {
  const start = '<!-- po-first:start -->'
  const end = '<!-- po-first:end -->'
  const starts = text.split(start).length - 1
  const ends = text.split(end).length - 1
  if (starts !== ends || /<!-- po-first:end -->[\s\S]*<!-- po-first:start -->/.test(text) && starts === 1) throw new Error('Malformed PO First block; repair its markers before installing')
  const block = `${start}\n${body.trim()}\n${end}`
  if (!starts) return `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${block}\n`
  let replaced = false
  return text.replace(/<!-- po-first:start -->[\s\S]*?<!-- po-first:end -->/g, () => {
    if (replaced) return ''
    replaced = true
    return block
  })
}

function settingsChange(group, file, mutate) {
  const settings = existsSync(file) ? json(file) : {}
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error(`Expected a settings object: ${file}`)
  const before = JSON.stringify(settings)
  mutate(settings)
  if (JSON.stringify(settings) !== before || !existsSync(file)) change(group, file, JSON.stringify(settings, null, 2) + '\n')
}

function resourceCovers(resource, wanted) {
  if (typeof resource !== 'string') return false
  const pattern = resource.replace(/\\/g, '/').split(/(\*\*\/|\*\*|\*)/).map(part =>
    part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^${pattern}$`, process.platform === 'win32' ? 'i' : '').test(wanted)
}

const registryFile = home => join(home, '.local', 'share', 'prumo', 'installations.json')
const HARNESSES = ['claude', 'kiro', 'codex', 'dsh']
const dshHome = (home, env) => {
  const configured = env.DSH_HOME?.trim() ? env.DSH_HOME : join(home, '.dsh')
  return configured === '~' ? home : /^[~][\\/]/.test(configured) ? join(home, configured.slice(2)) : configured
}
const configFor = (harness, home, env) => harness === 'claude' ? resolve(env.CLAUDE_CONFIG_DIR || join(home, '.claude'))
  : harness === 'codex' ? resolve(env.CODEX_HOME || join(home, '.codex'))
    : harness === 'dsh' ? resolve(dshHome(home, env))
      : resolve(env.KIRO_HOME || join(home, '.kiro'))

function validDshProfile(root) {
  try {
    const profile = json(join(root, 'package.json'))?.dsh?.profile
    return Boolean(profile && Array.isArray(profile.bundles) && profile.bundles.every(bundle => typeof bundle === 'string' && bundle.trim()))
  } catch { return false }
}

function dshGlobalStructure(config, managedSkill) {
  for (const name of ['cordis.patch.yml', 'AGENTS.md', '.credentials.yaml']) {
    try { if (statSync(join(config, name)).isFile()) return true } catch { /* absent or unreadable */ }
  }
  try {
    if (readdirSync(join(config, 'profiles'), { withFileTypes: true }).some(entry => entry.isDirectory() && validDshProfile(join(config, 'profiles', entry.name)))) return true
  } catch { /* no profiles */ }
  const skills = join(config, 'skills')
  return managedSkill(skills, 'dsh', false)
}

export function detectHarnesses({ home = homedir(), cwd = process.cwd(), env = process.env, projects = [] } = {}) {
  const search = [...new Set([cwd, ...projects].flatMap(projectAncestors))]
  const paths = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(path => path.replace(/^"(.*)"$/, '$1'))
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  const directory = path => { try { return statSync(path).isDirectory() } catch { return false } }
  const populated = path => { try { return readdirSync(path).length > 0 } catch { return false } }
  const executable = name => paths.some(path => extensions.some(extension => {
    const file = join(path, name + extension)
    try { if (!statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true } catch { return false }
  }))
  const managedSkill = (root, harness, legacy = true) => {
    if (legacy && existsSync(join(root, 'graph-foreman', 'SKILL.md'))) return true
    try {
      const marker = json(join(root, 'prumo', '.prumo-install.json'))
      return marker.product === 'prumo' && marker.harness === harness
    } catch { return false }
  }
  return HARNESSES.filter(harness => {
    if ((harness === 'kiro' ? ['kiro-cli', 'kiro'] : [harness]).some(executable)) return true
    const config = configFor(harness, home, env)
    if (harness === 'claude') {
      if (existsSync(join(home, '.claude.json')) || existsSync(join(config, 'settings.json')) || populated(join(config, 'projects')) || managedSkill(join(config, 'skills'), harness)) return true
      return search.some(root => existsSync(join(root, '.claude', 'settings.json')) || existsSync(join(root, '.claude', 'settings.local.json')) || managedSkill(join(root, '.claude', 'skills'), harness))
    }
    if (harness === 'kiro') {
      if (existsSync(join(config, 'settings', 'cli.json')) || existsSync(join(config, 'settings', 'mcp.json')) ||
          ['agents', 'steering', 'hooks', 'powers'].some(name => populated(join(config, name))) ||
          managedSkill(join(config, 'skills'), harness)) return true
      return search.some(root => existsSync(join(root, '.kiro', 'settings', 'mcp.json')) ||
        ['agents', 'steering', 'hooks', 'specs'].some(name => populated(join(root, '.kiro', name))) ||
        managedSkill(join(root, '.kiro', 'skills'), harness))
    }
    if (harness === 'dsh') {
      if (dshGlobalStructure(config, managedSkill)) return true
      return search.some(root => managedSkill(join(root, '.dsh', 'skills'), harness, false))
    }
    if (env.CODEX_HOME && directory(config)) return true
    if (existsSync(join(config, 'config.toml')) || managedSkill(join(config, 'skills'), harness) ||
        managedSkill(join(home, '.agents', 'skills'), harness, false)) return true
    return false
  })
}

export function dashboardPackageRoot(sourcePackageRoot, globalPackageRoot, lang = 'en') {
  const source = resolve(sourcePackageRoot ?? PACKAGE)
  if (!globalPackageRoot) throw new Error('Global Prumo CLI package is unavailable; refusing to start the dashboard from a transient checkout')
  const global = resolve(globalPackageRoot)
  if (source === global) return global
  try {
    const sourceId = packageIdentity(language(lang), { packageRoot: source }).contentId
    const globalId = packageIdentity(language(lang), { packageRoot: global }).contentId
    if (sourceId && sourceId === globalId) return global
  } catch { /* a partial package must not be used for autostart */ }
  throw new Error('Global Prumo CLI package content is incomplete or differs from this installation; dashboard was not restarted')
}

export async function reconcileDashboardInstall(successfulHarnesses, { dryRun = false, dashboardOptions = {}, sourcePackageRoot, globalPackageRoot, lang = dashboardOptions.lang ?? language(), status = dashboardStatus, enable = enableDashboard, restart = restartDashboard } = {}) {
  if (successfulHarnesses < 1) return { ok: false, action: 'none' }
  const options = sourcePackageRoot
    ? { ...dashboardOptions, packageRoot: dryRun ? resolve(sourcePackageRoot) : dashboardPackageRoot(sourcePackageRoot, globalPackageRoot ?? dashboardOptions.packageRoot, lang), lang }
    : dashboardOptions
  const before = await status(options)
  if (before.disabled) return { ok: true, action: 'disabled', status: before }
  const action = before.enabled ? 'restart' : 'enable'
  if (dryRun) return { ok: true, action, status: before }
  const result = await (action === 'restart' ? restart : enable)(options)
  return { ok: result.ok === true, action, status: result }
}

function registeredInstallations(home) {
  const file = registryFile(home)
  if (!existsSync(file)) return []
  const entries = json(file)
  if (!Array.isArray(entries) || entries.some(entry => !HARNESSES.includes(entry.harness) || typeof entry.config !== 'string' || !isAbsolute(entry.config) || !Array.isArray(entry.roots) || entry.roots.some(root => typeof root !== 'string' || !isAbsolute(root)) || !Array.isArray(entry.projects) || entry.projects.some(root => typeof root !== 'string' || !isAbsolute(root)))) throw new Error('Invalid Prumo installation registry; existing installations were not changed')
  return entries
}
export function readInstallationMarker(root, { home = homedir(), harness } = {}) {
  const file = join(root, 'prumo', '.prumo-install.json')
  try {
    const marker = json(file)
    if (!marker || marker.product !== 'prumo' || !HARNESSES.includes(marker.harness) || !/^\d+\.\d+\.\d+$/.test(marker.version)) throw new Error('invalid metadata')
    return marker
  } catch (error) {
    // Recupera somente uma instalação registrada com cópia íntegra do marcador.
    const registered = registeredInstallations(home).find(entry => entry.harness === harness && entry.roots.includes(root))
    if (!registered) throw error
    noLinks(file)
    const backups = join(home, '.local', 'share', 'prumo', 'backups')
    if (!existsSync(backups)) throw error
    noLinks(backups)
    for (const name of readdirSync(backups).sort().reverse()) {
      try {
        const directory = join(backups, name)
        noLinks(directory)
        const manifestFile = join(directory, 'manifest.json')
        noLinks(manifestFile)
        const manifest = json(manifestFile)
        if (manifest.product !== 'prumo' || resolve(manifest.home) !== resolve(home) || !Array.isArray(manifest.files)) continue
        const saved = manifest.files.find(entry => entry.file === file && /^files\/\d+$/.test(entry.original))
        if (!saved) continue
        const original = join(directory, saved.original)
        noLinks(original)
        const bytes = readFileSync(original)
        if (hash(bytes) !== saved.beforeHash) continue
        const marker = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
        if (marker?.product === 'prumo' && marker.harness === harness && /^\d+\.\d+\.\d+$/.test(marker.version)) return marker
      } catch { /* Um backup ilegível não autoriza inventar metadados. */ }
    }
    throw error
  }
}

export function installedPoFirstLanguage(harness, config) {
  if (!HARNESSES.includes(harness) || typeof config !== 'string') return undefined
  try {
    let file = harness === 'claude' ? join(config, 'output-styles', 'po-first.md') :
      harness === 'kiro' ? join(config, 'steering', 'po-first.md') : join(config, 'AGENTS.md')
    if (harness === 'codex') {
      const override = join(config, 'AGENTS.override.md')
      if (existsSync(override) && readFileSync(override, 'utf8').trim()) file = override
    }
    if (!existsSync(file)) return undefined
    let content = readFileSync(file, 'utf8')
    if (harness === 'codex' || harness === 'dsh')
      content = content.match(/<!-- po-first:start -->([\s\S]*?)<!-- po-first:end -->/)?.[1] ?? ''
    if (content.includes('## Text delivered with the product')) return 'en'
    if (content.includes('## Texto entregue junto ao produto')) return 'pt-BR'
  } catch { /* an unreadable or unmanaged block has no detectable language */ }
  return undefined
}

function managed(root, harness, home) {
  try { const marker = readInstallationMarker(root, { home, harness }); return marker.product === 'prumo' && marker.harness === harness } catch { return false }
}

export function installationFilesCurrent(root, marker) {
  try {
    const destination = join(root, 'prumo')
    noLinks(destination)
    return installationBundle(marker.lang ?? 'en').every(([name, expected]) => {
      const file = join(destination, name)
      noLinks(file)
      return same(bytesAt(file), expected)
    })
  } catch { return false }
}

export function discoverInstallations({ home = homedir(), cwd = process.cwd(), env = process.env, projects = [], onError = error => { throw error } } = {}) {
  home = realpathSync(resolve(home))
  const entries = registeredInstallations(home)
  const registeredRoots = new Set(entries.flatMap(entry => entry.roots))
  const search = [...new Set([cwd, ...projects].flatMap(projectAncestors))]
  for (const harness of HARNESSES) {
    const config = configFor(harness, home, env)
    const roots = [harness === 'codex' ? join(home, '.agents', 'skills') : join(config, 'skills'), ...(harness === 'codex' ? [join(config, 'skills')] : []), ...search.map(root => join(root, harness === 'codex' ? '.agents' : `.${harness}`, 'skills'))]
    const entry = entries.find(item => item.harness === harness && item.config === config)
    if (entry) { entry.roots.push(...roots); entry.projects.push(...search) }
    else entries.push({ harness, config, roots, projects: search })
  }
  const claimed = new Set()
  const invalid = new Set()
  return entries.map(entry => ({ ...entry, projects: [...new Set(entry.projects)], roots: [...new Set(entry.roots)].filter(root => {
    const sharedCodex = join(home, '.agents', 'skills')
    const legacyCodex = join(entry.config, 'skills')
    if (entry.harness === 'codex' && root === legacyCodex && root !== sharedCodex && managed(sharedCodex, 'codex', home)) return false
    if (claimed.has(root) || invalid.has(root)) return false
    const file = join(root, 'prumo', '.prumo-install.json')
    if (existsSync(file) || registeredRoots.has(root) && existsSync(join(root, 'prumo'))) {
      try {
        const marker = readInstallationMarker(root, { home, harness: entry.harness })
        if (!marker || marker.product !== 'prumo' || !HARNESSES.includes(marker.harness) || typeof marker.version !== 'string') throw new Error('invalid metadata')
      } catch (error) {
        invalid.add(root)
        onError(new Error(`Invalid Prumo installation marker: ${file}: ${error.message}`))
        return false
      }
    }
    if (!managed(root, entry.harness, home)) return false
    claimed.add(root)
    return true
  }) })).filter(entry => entry.roots.length)
}

export function planInstall({ harness, home = homedir(), cwd = process.cwd(), env = process.env, lang, poFirstLang, projects = [], configRoot, skillRoots, onlyInstalled = false }) {
  if (!HARNESSES.includes(harness)) throw new Error('Choose exactly one of --claude, --kiro, --codex or --dsh')
  home = realpathSync(resolve(home))
  const config = configRoot ? resolve(configRoot) : configFor(harness, home, env)
  const globalSkills = harness === 'codex' ? join(home, '.agents', 'skills') : join(config, 'skills')
  const legacyCodexSkills = join(config, 'skills')
  const primarySkills = harness === 'codex' && !['graph-foreman', 'prumo'].some(skill => existsSync(join(globalSkills, skill))) && ['graph-foreman', 'prumo'].some(skill => existsSync(join(legacyCodexSkills, skill))) ? legacyCodexSkills : globalSkills
  const search = [...new Set([cwd, ...projects].flatMap(projectAncestors))]
  const candidates = new Set([primarySkills])
  for (const root of search) candidates.add(join(root, harness === 'codex' ? '.agents' : `.${harness}`, 'skills'))
  const existing = [...candidates].filter(root => existsSync(join(root, 'graph-foreman')) || existsSync(join(root, 'prumo')))
  const targets = [...new Set(skillRoots ?? [primarySkills, ...existing])].filter(root => !onlyInstalled || managed(root, harness, home))
  if (!targets.length) throw new Error('No Prumo installations found; install an environment first')
  if (lang === undefined) for (const root of targets) {
    try { const saved = readInstallationMarker(root, { home, harness }).lang; if (['en', 'pt-BR'].includes(saved)) { lang = saved; break } } catch { /* no saved preference */ }
  }
  lang ??= language(undefined, env)
  const result = { version: VERSION, harness, home, config, lang, groups: [], data: [], warnings: [], allowedRoots: [...new Set([config, ...targets])] }

  function group(name, snapshots, build) {
    const item = { name, snapshots, changes: [], cleanup: [], conflicts: [] }
    result.groups.push(item)
    try { build(item) } catch (error) { item.changes = []; item.conflicts.push(error.message) }
    return item
  }

  const payload = installationBundle(lang)
  const identity = {
    contentId: bundleIdentity(payload),
    engineHash: hash(payload.find(([name]) => name === join('scripts', 'engine.mjs'))[1]),
  }
  for (const root of targets) {
    const destination = join(root, 'prumo')
    const legacy = join(root, 'graph-foreman')
    group(`skill:${root}`, [destination, legacy], item => {
      // Inspect both trees before changing anything. Preserve non-product files from legacy installs.
      const key = name => process.platform === 'win32' ? name.toLowerCase() : name
      const destinationFiles = new Set(walk(destination).map(key))
      const legacyFiles = walk(legacy)
      for (const folder of [destination, legacy]) noLinks(folder)
      const productFiles = new Set([...payload.map(([name]) => name), '.prumo-install.json'].map(key))
      for (const [name, content] of payload) change(item, join(destination, name), content)
      change(item, join(destination, '.prumo-install.json'), JSON.stringify({ product: 'prumo', version: VERSION, harness, lang, ...identity }, null, 2) + '\n')
      for (const name of legacyFiles.filter(name => !productFiles.has(key(name)))) {
        const target = join(destination, name)
        const content = readFileSync(join(legacy, name))
        if (destinationFiles.has(key(name)) && !same(bytesAt(target), content)) throw new Error(`Legacy file conflicts with Prumo destination: ${target}`)
        change(item, target, content)
      }
      for (const name of legacyFiles) change(item, join(legacy, name), null)
      if (existsSync(legacy)) item.cleanup.push(legacy)
    })
  }

  const poFile = (poFirstLang ?? lang) === 'pt-BR' ? 'po-first.pt-BR.md' : 'po-first.md'
  const po = readFileSync(join(PACKAGE, 'references', poFile), 'utf8')
  if (harness === 'claude') {
    const style = join(config, 'output-styles', 'po-first.md')
    const settings = join(config, 'settings.json')
    group('po-first:claude', [style, settings], item => {
      change(item, style, `---\nname: PO First\ndescription: Product outcomes, observable behavior and proportionate execution\nkeep-coding-instructions: true\n---\n\n${po}`)
      settingsChange(item, settings, value => { value.outputStyle = 'PO First' })
    })
    for (const root of search) for (const name of ['settings.json', 'settings.local.json']) {
      const file = join(root, '.claude', name)
      if (!existsSync(file) || file === settings) continue
      try { if (json(file).outputStyle && json(file).outputStyle !== 'PO First') result.warnings.push(`Local outputStyle overrides PO First: ${file}`) } catch { result.warnings.push(`Unreadable local settings: ${file}`) }
    }
  } else if (harness === 'codex') {
    const override = join(config, 'AGENTS.override.md')
    const instructions = existsSync(override) && readFileSync(override, 'utf8').trim() ? override : join(config, 'AGENTS.md')
    group('po-first:codex', [instructions], item => change(item, instructions, instructionBlock(existsSync(instructions) ? readFileSync(instructions, 'utf8') : '', po)))
    const settings = join(config, 'config.toml')
    if (existsSync(settings)) for (const block of readFileSync(settings, 'utf8').split(/(?=\[\[skills\.config\]\])/)) {
      if (/enabled\s*=\s*false/.test(block) && /(?:prumo|graph-foreman)/.test(block)) result.warnings.push(`Skill explicitly disabled; activation needs a settings change: ${settings}`)
    }
  } else if (harness === 'dsh') {
    const instructions = join(config, 'AGENTS.md')
    group('po-first:dsh', [instructions], item => change(item, instructions, instructionBlock(existsSync(instructions) ? readFileSync(instructions, 'utf8') : '', po)))
  } else {
    const steering = join(config, 'steering', 'po-first.md')
    group('po-first:kiro', [steering], item => change(item, steering, `---\ninclusion: always\n---\n\n${po}`))
    // Explicit resources also support older clients and opted-out custom agents.
    const agentDirs = [join(config, 'agents'), ...search.map(root => join(root, '.kiro', 'agents'))]
    for (const folder of new Set(agentDirs)) {
      let names
      try { names = walk(folder).filter(name => /\.(json|md)$/.test(name)) } catch (error) { result.warnings.push(error.message); continue }
      for (const name of names) {
        const file = join(folder, name)
        if (name.endsWith('.md')) { result.warnings.push(`Verify default resource inheritance for this Markdown agent: ${file}`); continue }
        result.allowedRoots.push(folder)
        group(`agent:${file}`, [file], item => settingsChange(item, file, value => {
          if (value.resources !== undefined && !Array.isArray(value.resources)) throw new Error(`Expected a resources array: ${file}`)
          value.resources ??= []
          const resources = [`file://${steering.replace(/\\/g, '/')}`, ...targets.map(root => `skill://${join(root, 'prumo', 'SKILL.md').replace(/\\/g, '/')}`)]
          for (const resource of resources) if (!value.resources.some(existing => resourceCovers(typeof existing === 'string' ? existing.replace('~/', home.replace(/\\/g, '/') + '/') : existing, resource))) value.resources.push(resource)
        }))
      }
    }
  }

  const prumoHome = resolve(env.PRUMO_HOME || join(home, '.local', 'share', 'prumo'))
  const legacyHome = resolve(env.GRAPH_FOREMAN_HOME || join(home, '.local', 'share', 'graph-foreman'))
  const sameHome = inside(prumoHome, legacyHome) && inside(legacyHome, prumoHome)
  if (!sameHome && (inside(prumoHome, legacyHome) || inside(legacyHome, prumoHome))) throw new Error('Prumo and graph-foreman storage directories cannot contain each other')
  const roots = new Set(search.filter(root => existsSync(join(root, '.specs', 'graph'))))
  if (existsSync(prumoHome)) for (const entry of readdirSync(prumoHome, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(prumoHome, entry.name, '.specs', 'graph'))) roots.add(join(prumoHome, entry.name))
  }
  result.data = [...roots].map(root => ({ root, action: 'preserve-in-place' }))
  if (!sameHome && existsSync(legacyHome)) for (const entry of readdirSync(legacyHome, { withFileTypes: true })) {
    const sourceRoot = join(legacyHome, entry.name)
    if (!entry.isDirectory() || !existsSync(join(sourceRoot, '.specs', 'graph'))) continue
    const destinationRoot = join(prumoHome, entry.name)
    const source = join(sourceRoot, '.specs')
    const destination = join(destinationRoot, '.specs')
    result.allowedRoots.push(sourceRoot, destinationRoot)
    const migration = group(`workspace:${entry.name}`, [], item => {
      noLinks(sourceRoot)
      noLinks(destinationRoot)
      const transfers = []
      const originalEntries = readdirSync(sourceRoot).sort()
      const retained = new Set(['.specs', 'backups', ...readdirSync(sourceRoot, { withFileTypes: true }).filter(entry => entry.isFile() || entry.isSymbolicLink()).map(entry => entry.name)])
      const relocating = !existsSync(destination)
      for (const area of ['.specs', 'backups']) {
        const folder = join(sourceRoot, area)
        for (const name of walk(folder, folder, true)) {
          const file = join(folder, name)
          if (!lstatSync(file).isSymbolicLink()) continue
          const target = resolve(dirname(file), linkTarget(file))
          ensureMigratedLinkTarget(file, linkTarget(file), sourceRoot, relocating, source)
          if (inside(sourceRoot, target) && target !== sourceRoot && !retained.has(relative(sourceRoot, target).split(sep)[0])) throw new Error(`Legacy graph references execution data; preserve it before migration: ${file}`)
        }
      }
      if (relocating) {
        item.relocation = { source, destination, stamp: treeStamp(source), workspaceSource: sourceRoot, workspaceDestination: destinationRoot }
      } else {
        for (const name of walk(source, source, true)) transfers.push({ name: join('.specs', name), original: join(source, name) })
      }
      const legacyBackups = join(sourceRoot, 'backups')
      if (existsSync(legacyBackups)) for (const name of walk(legacyBackups, legacyBackups, true)) transfers.push({ name: join('backups', name), original: join(legacyBackups, name) })
      for (const top of readdirSync(sourceRoot, { withFileTypes: true })) if (top.isFile() || top.isSymbolicLink()) transfers.push({ name: top.name, original: join(sourceRoot, top.name) })
      const destinationFiles = new Set(walk(destinationRoot, destinationRoot, true).map(name => process.platform === 'win32' ? name.toLowerCase() : name))
      for (const transfer of transfers) {
        const { name, original } = transfer
        const target = join(destinationRoot, name)
        const link = lstatSync(original).isSymbolicLink() ? (statSync(original, { throwIfNoEntry: false })?.isDirectory() ? 'junction' : 'file') : undefined
        let content = entryBytes(original, link)
        if (link) {
          const targetPath = content.toString()
          const absolute = resolve(dirname(original), targetPath)
          ensureMigratedLinkTarget(original, targetPath, sourceRoot, relocating, source)
          if (inside(sourceRoot, absolute) && absolute !== sourceRoot && !retained.has(relative(sourceRoot, absolute).split(sep)[0])) throw new Error(`Legacy graph references execution data; preserve it before migration: ${original}`)
          // Relative links move with the tree; internal absolute junctions must follow it.
          if (isAbsolute(targetPath) && inside(sourceRoot, absolute)) content = Buffer.from(join(destinationRoot, relative(sourceRoot, absolute)))
          else if (!isAbsolute(targetPath) && !inside(sourceRoot, absolute)) content = Buffer.from(relative(dirname(target), absolute))
        }
        const key = process.platform === 'win32' ? name.toLowerCase() : name
        if (destinationFiles.has(key) && !same(entryBytes(target, link), content)) throw new Error(`Legacy workspace conflicts with Prumo destination: ${target}`)
        change(item, target, content, link)
        change(item, original, null, link)
      }
      item.cleanup.push({ path: sourceRoot, discard: true, originalEntries })
    })
    if (!migration.changes.length && !migration.relocation && !migration.conflicts.length) continue
    result.data = result.data.filter(data => !(inside(data.root, destinationRoot) && inside(destinationRoot, data.root)))
    result.data.push({ root: destinationRoot, source: sourceRoot, action: 'migrate' })
  }
  const registry = registryFile(home)
  result.allowedRoots.push(dirname(registry))
  group('installation-registry', [registry], item => {
    const entries = registeredInstallations(home)
    const previous = entries.find(entry => entry.harness === harness && entry.config === config)
    const entry = { harness, config, roots: [...new Set([...(previous?.roots ?? []), ...targets])], projects: [...new Set([...(previous?.projects ?? []), ...search])] }
    if (previous) entries[entries.indexOf(previous)] = entry
    else entries.push(entry)
    change(item, registry, JSON.stringify(entries, null, 2) + '\n')
  })
  return result
}

function atomicWrite(file, bytes, link) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.prumo-${randomUUID()}.tmp`
  try {
    if (link) symlinkSync(bytes.toString(), temporary, link)
    else writeFileSync(temporary, bytes, { flag: 'wx', flush: true })
    renameSync(temporary, file)
  } finally { if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary) }
}

function rollback(changes) {
  const errors = []
  for (const item of [...changes].reverse()) {
    try {
      noLinks(item.link ? dirname(item.file) : item.file)
      if (!same(entryBytes(item.file, item.link), item.after)) throw new Error(`File changed after installation; manual recovery required: ${item.file}`)
      if (item.before === null) { if (lstatSync(item.file, { throwIfNoEntry: false })) unlinkSync(item.file) }
      else atomicWrite(item.file, item.before, item.link)
    } catch (error) { errors.push(error.message) }
  }
  return errors
}

export function applyInstall(plan, { dryRun = false, onProgress = () => {} } = {}) {
  if (dryRun) return { backup: null, groups: plan.groups.map(group => ({ name: group.name, status: group.conflicts.length ? 'conflict' : 'preview', errors: group.conflicts })) }
  const actionable = plan.groups.filter(group => !group.conflicts.length && (group.changes.length || group.cleanup.length || group.relocation))
  let backup = null
  const manifest = { product: 'prumo', version: VERSION, home: plan.home, allowedRoots: plan.allowedRoots, snapshots: [], relocations: [], files: [] }
  if (actionable.length) {
    backup = join(plan.home, '.local', 'share', 'prumo', 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
    noLinks(backup)
    mkdirSync(backup, { recursive: true })
    // Complete snapshots of affected installations/configuration, before any mutation.
    // Live run data is outside this transaction: rollback must never erase ongoing work.
    let snapshot = 0
    for (const group of actionable) {
      try { for (const path of group.snapshots) if (existsSync(path)) {
        noLinks(path)
        const destination = `snapshots/${snapshot++}`
        copySnapshot(path, join(backup, destination))
        manifest.snapshots.push({ path, backup: destination })
      } } catch (error) { group.conflicts.push(error.message); group.changes = [] }
    }
    for (const group of actionable.filter(group => !group.conflicts.length)) for (const item of group.changes) {
      const index = manifest.files.length
      const original = item.before === null ? null : `files/${index}`
      if (original) { mkdirSync(join(backup, 'files'), { recursive: true }); writeFileSync(join(backup, original), item.before) }
      manifest.files.push({ file: item.file, original, beforeHash: item.before === null ? null : hash(item.before), afterHash: item.after === null ? null : hash(item.after), group: group.name, applied: false, ...(item.link && { link: item.link }) })
    }
    for (const group of actionable.filter(group => !group.conflicts.length && group.relocation)) {
      const index = manifest.relocations.length
      manifest.relocations.push({ ...group.relocation, backup: `relocations/${index}`, group: group.name, applied: false })
    }
    atomicWrite(join(backup, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
    writeFileSync(join(backup, 'RESTORE.md'), `# Restore / Restaurar\n\nRun / Execute:\n\n\`bunx @henri-ralmeida/prumo@${VERSION} restore "${backup}"\`\n\nOnly installed files and configuration are restored. Run data is never reverted.\nSomente arquivos instalados e configurações são restaurados. Dados das execuções não são revertidos.\n`)
  }
  const results = []
  for (const group of plan.groups) {
    if (group.conflicts.length) { results.push({ name: group.name, status: 'conflict', errors: group.conflicts }); continue }
    const applied = []
    try {
      if (group.relocation) {
        const entry = manifest.relocations.find(item => item.group === group.name)
        if (!entry || !existsSync(entry.source) || existsSync(entry.destination) || treeStamp(entry.source) !== entry.stamp) throw new Error(`Workspace changed during installation: ${entry?.source ?? group.relocation.source}`)
        const saved = join(backup, entry.backup)
        mkdirSync(dirname(saved), { recursive: true })
        onProgress({ kind: 'workspace', name: group.name.slice('workspace:'.length), source: entry.source, destination: entry.destination })
        if (existsSync(entry.destination) || treeStamp(entry.source) !== entry.stamp) throw new Error(`Workspace changed during installation: ${entry.source}`)
        let moved = false
        try { renameSync(entry.source, saved); moved = true }
        catch (error) {
          if (error.code !== 'EXDEV') throw error
          try {
            copySnapshot(entry.source, saved)
            if (!verifyExactTree(entry.source, saved)) throw new Error(`Workspace backup integrity check failed: ${entry.source}`)
          } catch (copyError) {
            rmSync(saved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
            throw copyError
          }
        }
        try {
          if (treeStamp(saved) !== entry.stamp) throw new Error(`Workspace changed during installation: ${entry.source}`)
          copyRelocatedTree(saved, entry.destination, saved, entry.source, entry.destination, [], entry.workspaceSource, entry.workspaceDestination)
          if (!verifyRelocatedTree(saved, entry.destination, entry.source, entry.workspaceSource, entry.workspaceDestination)) throw new Error(`Workspace integrity check failed: ${entry.destination}`)
          if (!moved) rmSync(entry.source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch (error) {
          rmSync(entry.destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
          if (moved) renameSync(saved, entry.source)
          else rmSync(saved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
          throw error
        }
        entry.applied = true
      }
      // Verify the complete group again before committing any file.
      for (const item of group.changes) if (!same(entryBytes(item.file, item.link), item.before)) throw new Error(`File changed during installation: ${item.file}`)
      for (const item of group.changes) {
        noLinks(item.link ? dirname(item.file) : item.file)
        if (!same(entryBytes(item.file, item.link), item.before)) throw new Error(`File changed during installation: ${item.file}`)
        if (item.after === null) unlinkSync(item.file)
        else atomicWrite(item.file, item.after, item.link)
        applied.push(item)
        if (!same(entryBytes(item.file, item.link), item.after)) throw new Error(`Integrity check failed: ${item.file}`)
      }
      for (const cleanup of group.cleanup) {
        const folder = typeof cleanup === 'string' ? cleanup : cleanup.path
        if (cleanup?.discard) {
          const unexpected = readdirSync(folder, { withFileTypes: true }).filter(entry => !cleanup.originalEntries.includes(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
          if (unexpected.length || ['.specs', 'backups'].some(name => walk(join(folder, name), join(folder, name), true).length)) throw new Error(`Legacy workspace changed during installation: ${folder}`)
          rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
          continue
        }
        try { removeEmptyTree(folder) }
        catch (error) {
          if (!cleanup.optionalWhenEmpty || walk(folder).length) throw error
        }
      }
      for (const entry of manifest.files) if (entry.group === group.name) entry.applied = true
      results.push({ name: group.name, status: group.changes.length || group.cleanup.length || group.relocation ? 'installed' : 'unchanged', errors: [] })
    } catch (error) {
      const recovery = rollback(applied)
      const relocation = manifest.relocations.find(entry => entry.group === group.name && entry.applied)
      if (relocation) {
        try {
          const saved = join(backup, relocation.backup)
          if (existsSync(relocation.source) || !verifyRelocatedTree(saved, relocation.destination, relocation.source, relocation.workspaceSource, relocation.workspaceDestination)) throw new Error(`Workspace changed since this backup; restore manually: ${relocation.destination}`)
          rmSync(relocation.destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
          mkdirSync(dirname(relocation.source), { recursive: true })
          renameSync(saved, relocation.source)
          relocation.applied = false
        } catch (restoreError) { recovery.push(restoreError.message) }
      }
      results.push({ name: group.name, status: 'conflict', errors: [error.message, ...recovery] })
    }
    if (backup) atomicWrite(join(backup, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
  }
  return { backup, groups: results }
}

export function restoreInstall(backup, { home = homedir(), env = process.env } = {}) {
  backup = resolve(backup)
  const directory = join(resolve(home), '.local', 'share', 'prumo', 'backups')
  if (!inside(directory, backup) || backup === directory) throw new Error('Choose a Prumo backup inside your home directory')
  noLinks(backup)
  const manifest = json(join(backup, 'manifest.json'))
  if (manifest.product !== 'prumo' || resolve(manifest.home) !== resolve(home) || !Array.isArray(manifest.files)) throw new Error('Invalid Prumo backup')
  const savedRoots = manifest.allowedRoots ?? []
  if (!Array.isArray(savedRoots) || savedRoots.some(value => typeof value !== 'string' || !isAbsolute(value) || dirname(value) === value)) throw new Error('Invalid Prumo backup')
  // Project installations may live on another drive. The transaction records their
  // exact installation directories; hashes and link checks still guard every file.
  const roots = [home, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.DSH_HOME?.trim() ? dshHome(resolve(home), env) : null, ...savedRoots].filter(Boolean).map(value => resolve(value))
  const relocations = manifest.relocations ?? []
  if (!Array.isArray(relocations)) throw new Error('Invalid Prumo backup')
  const pendingRelocations = relocations.filter(entry => {
    if (!entry || typeof entry.source !== 'string' || typeof entry.destination !== 'string' || typeof entry.backup !== 'string' || !roots.some(root => inside(root, resolve(entry.source))) || !roots.some(root => inside(root, resolve(entry.destination)))) throw new Error('Invalid Prumo workspace backup')
    const saved = resolve(backup, entry.backup)
    if (!inside(backup, saved)) throw new Error('Invalid Prumo workspace backup')
    const applied = entry.applied || !existsSync(entry.source) && existsSync(saved) && existsSync(entry.destination)
    if (!applied) return false
    if (!existsSync(saved) || !existsSync(entry.destination) || !verifyRelocatedTree(saved, entry.destination, entry.source, entry.workspaceSource, entry.workspaceDestination)) throw new Error(`Workspace changed since this backup; restore manually: ${entry.destination}`)
    if (existsSync(entry.source) && walk(entry.source).length) throw new Error(`Legacy workspace is no longer empty; restore manually: ${entry.source}`)
    return true
  })
  const changes = manifest.files.map(entry => {
    if (!roots.some(root => inside(root, resolve(entry.file)))) throw new Error(`Backup target is outside the configured locations: ${entry.file}`)
    if (entry.link && !['junction', 'file'].includes(entry.link)) throw new Error('Invalid backup link type')
    noLinks(entry.link ? dirname(entry.file) : entry.file)
    const current = entryBytes(entry.file, entry.link)
    const currentHash = current === null ? null : hash(current)
    // Also recover an interruption between the file replacement and manifest commit.
    if (currentHash === entry.beforeHash && !entry.applied) return null
    if (currentHash !== entry.afterHash) throw new Error(`File changed since this backup; restore manually: ${entry.file}`)
    if (entry.original !== null && (!/^files\/\d+$/.test(entry.original) || !inside(backup, resolve(backup, entry.original)))) throw new Error('Invalid backup file path')
    const before = entry.original === null ? null : readFileSync(join(backup, entry.original))
    if ((before === null ? null : hash(before)) !== entry.beforeHash) throw new Error(`Backup integrity check failed: ${entry.file}`)
    return { file: entry.file, before, after: current, ...(entry.link && { link: entry.link }) }
  }).filter(Boolean)
  const errors = rollback(changes)
  if (errors.length) throw new Error(errors.join('\n'))
  for (const entry of pendingRelocations.reverse()) {
    if (existsSync(entry.source)) removeEmptyTree(entry.source)
    rmSync(entry.destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    mkdirSync(dirname(entry.source), { recursive: true })
    renameSync(join(backup, entry.backup), entry.source)
    entry.applied = false
  }
  for (const entry of manifest.files) entry.applied = false
  atomicWrite(join(backup, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
  return changes.length + pendingRelocations.length
}

export function installationStatus(plan) {
  return {
    harness: plan.harness,
    version: plan.version,
    installed: plan.groups.filter(group => group.name.startsWith('skill:')).every(group => !group.conflicts.length && !group.changes.length),
    configured: plan.groups.every(group => !group.conflicts.length && !group.changes.length),
    pendingActivation: [...plan.warnings, ...plan.groups.flatMap(group => group.conflicts)],
    data: plan.data,
  }
}
