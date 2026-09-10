import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, renameSync, unlinkSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname, join, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { inside } from '../scripts/storage.mjs'
import { language } from '../scripts/i18n.mjs'

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')).version
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bytesAt = path => existsSync(path) ? readFileSync(path) : null
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

function walk(path, base = path) {
  if (!existsSync(path)) return []
  const result = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Linked file cannot be replaced automatically: ${file}`)
    if (entry.isDirectory()) result.push(...walk(file, base))
    else if (entry.isFile()) result.push(relative(base, file))
  }
  return result
}

function bundle() {
  const files = ['README.md', 'README.pt-BR.md', 'LICENSE', ...walk(join(PACKAGE, 'references')).map(p => join('references', p))]
  // Dependencies first, entrypoints next, discovery last. Live clients need no restart to finish their current work.
  for (const name of ['messages.json', 'i18n.mjs', 'storage.mjs', 'validation.mjs', 'dashboard.html', 'engine.mjs', 'serve.mjs']) files.push(join('scripts', name))
  files.push('SKILL.md')
  return files.map(name => [name, readFileSync(join(PACKAGE, name))])
}

function change(group, file, content) {
  file = resolve(file)
  noLinks(file)
  const before = bytesAt(file)
  const after = content === null ? null : Buffer.isBuffer(content) ? content : Buffer.from(content)
  if (!same(before, after)) group.changes.push({ file, before, after })
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
const configFor = (harness, home, env) => harness === 'claude' ? resolve(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')) : harness === 'codex' ? resolve(env.CODEX_HOME ?? join(home, '.codex')) : join(home, '.kiro')
function registeredInstallations(home) {
  const file = registryFile(home)
  if (!existsSync(file)) return []
  const entries = json(file)
  if (!Array.isArray(entries) || entries.some(entry => !['claude', 'kiro', 'codex'].includes(entry.harness) || typeof entry.config !== 'string' || !isAbsolute(entry.config) || !Array.isArray(entry.roots) || entry.roots.some(root => typeof root !== 'string' || !isAbsolute(root)) || !Array.isArray(entry.projects) || entry.projects.some(root => typeof root !== 'string' || !isAbsolute(root)))) throw new Error('Invalid PRUMO installation registry; existing installations were not changed')
  return entries
}
function managed(root, harness) {
  try { const marker = json(join(root, 'prumo', '.prumo-install.json')); return marker.product === 'prumo' && marker.harness === harness } catch { return false }
}

export function discoverInstallations({ home = homedir(), cwd = process.cwd(), env = process.env, projects = [] } = {}) {
  home = resolve(home)
  const entries = registeredInstallations(home)
  const search = [...new Set([cwd, ...projects].flatMap(projectAncestors))]
  for (const harness of ['claude', 'kiro', 'codex']) {
    const config = configFor(harness, home, env)
    const roots = [harness === 'codex' ? join(home, '.agents', 'skills') : join(config, 'skills'), ...(harness === 'codex' ? [join(config, 'skills')] : []), ...search.map(root => join(root, harness === 'codex' ? '.agents' : `.${harness}`, 'skills'))]
    const entry = entries.find(item => item.harness === harness && item.config === config)
    if (entry) { entry.roots.push(...roots); entry.projects.push(...search) }
    else entries.push({ harness, config, roots, projects: search })
  }
  const claimed = new Set()
  return entries.map(entry => ({ ...entry, projects: [...new Set(entry.projects)], roots: [...new Set(entry.roots)].filter(root => {
    if (claimed.has(root) || !managed(root, entry.harness)) return false
    claimed.add(root)
    return true
  }) })).filter(entry => entry.roots.length)
}

export function planInstall({ harness, home = homedir(), cwd = process.cwd(), env = process.env, lang, projects = [], configRoot, skillRoots, onlyInstalled = false }) {
  if (!['claude', 'kiro', 'codex'].includes(harness)) throw new Error('Choose exactly one of --claude, --kiro or --codex')
  home = resolve(home)
  const config = configRoot ? resolve(configRoot) : configFor(harness, home, env)
  const globalSkills = harness === 'codex' ? join(home, '.agents', 'skills') : join(config, 'skills')
  const search = [...new Set([cwd, ...projects].flatMap(projectAncestors))]
  const candidates = new Set([globalSkills])
  if (harness === 'codex') candidates.add(join(config, 'skills'))
  for (const root of search) candidates.add(join(root, harness === 'codex' ? '.agents' : `.${harness}`, 'skills'))
  const existing = [...candidates].filter(root => existsSync(join(root, 'graph-foreman')) || existsSync(join(root, 'prumo')))
  const targets = [...new Set(skillRoots ?? [globalSkills, ...existing])].filter(root => !onlyInstalled || managed(root, harness))
  if (!targets.length) throw new Error('No PRUMO installations found; install an environment first')
  if (lang === undefined) for (const root of targets) {
    try { const saved = json(join(root, 'prumo', '.prumo-install.json')).lang; if (['en', 'pt-BR'].includes(saved)) { lang = saved; break } } catch { /* no saved preference */ }
  }
  lang ??= language(undefined, env)
  const result = { version: VERSION, harness, home, config, lang, groups: [], data: [], warnings: [], allowedRoots: [...new Set([config, ...targets])] }

  function group(name, snapshots, build) {
    const item = { name, snapshots, changes: [], conflicts: [] }
    result.groups.push(item)
    try { build(item) } catch (error) { item.changes = []; item.conflicts.push(error.message) }
  }

  const payload = bundle()
  for (const root of targets) {
    const destination = join(root, 'prumo')
    const legacy = join(root, 'graph-foreman')
    group(`skill:${root}`, [destination, legacy], item => {
      // Inspect full old directories before changing anything, including user-added files.
      for (const folder of [destination, legacy]) { noLinks(folder); walk(folder) }
      for (const [name, content] of payload) change(item, join(destination, name), content)
      change(item, join(destination, '.prumo-install.json'), JSON.stringify({ product: 'prumo', version: VERSION, harness, lang }, null, 2) + '\n')
      if (existsSync(legacy)) {
        for (const name of ['engine.mjs', 'serve.mjs']) change(item, join(legacy, 'scripts', name), `#!/usr/bin/env node\n// Compatibility entrypoint. Run data and arguments stay unchanged.\nawait import(new URL('../../prumo/scripts/${name}', import.meta.url))\n`)
        change(item, join(legacy, 'scripts', 'validation.mjs'), "export * from '../../prumo/scripts/validation.mjs'\n")
        // An already-running legacy server still reads its original HTML path.
        change(item, join(legacy, 'scripts', 'dashboard.html'), readFileSync(join(PACKAGE, 'scripts', 'dashboard.html')))
        change(item, join(legacy, 'README.md'), '# PRUMO\n\nThis directory preserves existing script paths. Use the adjacent `prumo` skill. Run data was not moved.\n')
        change(item, join(legacy, 'SKILL.md'), '---\nname: graph-foreman\ndescription: Compatibility alias for existing graph-foreman invocations. New work uses the prumo skill.\n---\n\n# PRUMO compatibility alias\n\nRead and follow [PRUMO](../prumo/SKILL.md). Preserve the selected workspace, run, approved contract and current attempt. The scripts in this directory forward to PRUMO. Do not initialize or migrate an existing run just because the product name changed.\n')
      }
    })
  }

  const po = readFileSync(join(PACKAGE, 'references', 'po-first.md'), 'utf8')
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

  const homes = new Set([env.PRUMO_HOME, env.GRAPH_FOREMAN_HOME, join(home, '.local', 'share', 'graph-foreman'), join(home, '.local', 'share', 'prumo')].filter(Boolean).map(resolvePath => resolve(resolvePath)))
  const roots = new Set(search.filter(root => existsSync(join(root, '.specs', 'graph'))))
  for (const central of homes) if (existsSync(central)) for (const entry of readdirSync(central, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(central, entry.name, '.specs', 'graph'))) roots.add(join(central, entry.name))
  }
  result.data = [...roots].map(root => ({ root, action: 'preserve-in-place' }))
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

function atomicWrite(file, bytes) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.prumo-${randomUUID()}.tmp`
  try { writeFileSync(temporary, bytes); renameSync(temporary, file) } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

function rollback(changes) {
  const errors = []
  for (const item of [...changes].reverse()) {
    try {
      if (!same(bytesAt(item.file), item.after)) throw new Error(`File changed after installation; manual recovery required: ${item.file}`)
      if (item.before === null) { if (existsSync(item.file)) unlinkSync(item.file) }
      else atomicWrite(item.file, item.before)
    } catch (error) { errors.push(error.message) }
  }
  return errors
}

export function applyInstall(plan, { dryRun = false } = {}) {
  if (dryRun) return { backup: null, groups: plan.groups.map(group => ({ name: group.name, status: group.conflicts.length ? 'conflict' : 'preview', errors: group.conflicts })) }
  const actionable = plan.groups.filter(group => !group.conflicts.length && group.changes.length)
  let backup = null
  const manifest = { product: 'prumo', version: VERSION, home: plan.home, allowedRoots: plan.allowedRoots, snapshots: [], files: [] }
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
        cpSync(path, join(backup, destination), { recursive: true, errorOnExist: true, force: false })
        manifest.snapshots.push({ path, backup: destination })
      } } catch (error) { group.conflicts.push(error.message); group.changes = [] }
    }
    for (const group of actionable.filter(group => !group.conflicts.length)) for (const item of group.changes) {
      const index = manifest.files.length
      const original = item.before === null ? null : `files/${index}`
      if (original) { mkdirSync(join(backup, 'files'), { recursive: true }); writeFileSync(join(backup, original), item.before) }
      manifest.files.push({ file: item.file, original, beforeHash: item.before === null ? null : hash(item.before), afterHash: item.after === null ? null : hash(item.after), group: group.name, applied: false })
    }
    atomicWrite(join(backup, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
    writeFileSync(join(backup, 'RESTORE.md'), `# Restore / Restaurar\n\nRun / Execute:\n\n\`npx @henri-ralmeida/prumo@${VERSION} restore "${backup}"\`\n\nOnly installed files and configuration are restored. Run data is never reverted.\nSomente arquivos instalados e configurações são restaurados. Dados das execuções não são revertidos.\n`)
  }
  const results = []
  for (const group of plan.groups) {
    if (group.conflicts.length) { results.push({ name: group.name, status: 'conflict', errors: group.conflicts }); continue }
    const applied = []
    try {
      // Verify the complete group again before committing any file.
      for (const item of group.changes) if (!same(bytesAt(item.file), item.before)) throw new Error(`File changed during installation: ${item.file}`)
      for (const item of group.changes) {
        noLinks(item.file)
        if (!same(bytesAt(item.file), item.before)) throw new Error(`File changed during installation: ${item.file}`)
        if (item.after === null) unlinkSync(item.file)
        else atomicWrite(item.file, item.after)
        applied.push(item)
        if (!same(bytesAt(item.file), item.after)) throw new Error(`Integrity check failed: ${item.file}`)
      }
      for (const entry of manifest.files) if (entry.group === group.name) entry.applied = true
      results.push({ name: group.name, status: group.changes.length ? 'installed' : 'unchanged', errors: [] })
    } catch (error) {
      const recovery = rollback(applied)
      results.push({ name: group.name, status: 'conflict', errors: [error.message, ...recovery] })
    }
    if (backup) atomicWrite(join(backup, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
  }
  return { backup, groups: results }
}

export function restoreInstall(backup, { home = homedir(), env = process.env } = {}) {
  backup = resolve(backup)
  const directory = join(resolve(home), '.local', 'share', 'prumo', 'backups')
  if (!inside(directory, backup) || backup === directory) throw new Error('Choose a PRUMO backup inside your home directory')
  noLinks(backup)
  const manifest = json(join(backup, 'manifest.json'))
  if (manifest.product !== 'prumo' || resolve(manifest.home) !== resolve(home) || !Array.isArray(manifest.files)) throw new Error('Invalid PRUMO backup')
  const savedRoots = manifest.allowedRoots ?? []
  if (!Array.isArray(savedRoots) || savedRoots.some(value => typeof value !== 'string' || !isAbsolute(value) || dirname(value) === value)) throw new Error('Invalid PRUMO backup')
  // Project installations may live on another drive. The transaction records their
  // exact installation directories; hashes and link checks still guard every file.
  const roots = [home, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, ...savedRoots].filter(Boolean).map(value => resolve(value))
  const changes = manifest.files.map(entry => {
    if (!roots.some(root => inside(root, resolve(entry.file)))) throw new Error(`Backup target is outside the configured locations: ${entry.file}`)
    noLinks(entry.file)
    const current = bytesAt(entry.file)
    const currentHash = current === null ? null : hash(current)
    // Also recover an interruption between the file replacement and manifest commit.
    if (currentHash === entry.beforeHash && !entry.applied) return null
    if (currentHash !== entry.afterHash) throw new Error(`File changed since this backup; restore manually: ${entry.file}`)
    if (entry.original !== null && (!/^files\/\d+$/.test(entry.original) || !inside(backup, resolve(backup, entry.original)))) throw new Error('Invalid backup file path')
    const before = entry.original === null ? null : readFileSync(join(backup, entry.original))
    if ((before === null ? null : hash(before)) !== entry.beforeHash) throw new Error(`Backup integrity check failed: ${entry.file}`)
    return { file: entry.file, before, after: current }
  }).filter(Boolean)
  const errors = rollback(changes)
  if (errors.length) throw new Error(errors.join('\n'))
  for (const entry of manifest.files) entry.applied = false
  atomicWrite(join(backup, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)))
  return changes.length
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
