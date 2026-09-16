import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute, sep, basename } from 'node:path'

export function inside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

// Finish already-started legacy work before changing its planning lifecycle.
export function legacyExecutionPending(state) {
  return !['phase', 'task'].includes(state.plan?.planningMode) && Object.values(state.tasks ?? {}).some(task =>
    !['done', 'skipped'].includes(task.state) && (task.attempts?.length || !['pending', 'failed'].includes(task.state)))
}

export function storageHome(env = process.env, home = homedir()) {
  if (env.PRUMO_HOME) return resolve(env.PRUMO_HOME)
  return resolve(join(home, '.local', 'share', 'prumo'))
}

export function findRoot(env = process.env, cwd = process.cwd(), home = homedir()) {
  const central = storageHome(env, home)
  const explicit = env.PRUMO_ROOT || env.GRAPH_ROOT
  if (explicit) {
    const root = resolve(explicit)
    // Old sessions retain GRAPH_ROOT/PRUMO_ROOT after a verified installation move.
    const legacy = resolve(env.GRAPH_FOREMAN_HOME || join(home, '.local', 'share', 'graph-foreman'))
    const migrated = join(central, basename(root))
    if (!existsSync(join(root, '.specs', 'graph')) && dirname(root) === legacy && existsSync(join(migrated, '.specs', 'graph'))) return migrated
    if (!existsSync(root)) throw new Error(`PRUMO_ROOT points to "${root}", which does not exist`)
    if (dirname(root) === central || existsSync(join(root, '.specs', 'graph'))) return root
    throw new Error(`PRUMO_ROOT must be a central workspace inside "${central}" or an existing legacy workspace`)
  }
  cwd = resolve(cwd)
  if (cwd !== central && inside(central, cwd)) return join(central, relative(central, cwd).split(sep)[0])
  // Existing project-local runs remain usable; never create new project-local state.
  for (let current = cwd; ; current = dirname(current)) {
    if (existsSync(join(current, '.specs', 'graph'))) return current
    if (dirname(current) === current) break
  }
  throw new Error(`Select a workspace inside "${central}" with PRUMO_ROOT, or enter an existing legacy workspace`)
}

export function graphRoots(root, central) {
  // The selected legacy workspace owns its existing URL name even when a central
  // workspace has the same basename. Give the other root a stable display alias.
  const roots = new Map([[root, { name: basename(root), path: root, graphDir: join(root, '.specs', 'graph') }]])
  const names = new Set([basename(root)])
  if (existsSync(central)) for (const entry of readdirSync(central, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue
    const path = join(central, entry.name)
    if (roots.has(path) || !existsSync(join(path, '.specs', 'graph'))) continue
    let name = entry.name
    for (let suffix = 2; names.has(name); suffix++) name = `${entry.name}-${suffix}`
    names.add(name)
    roots.set(path, { name, path, graphDir: join(path, '.specs', 'graph') })
  }
  return [...roots.values()]
}

export function globalGraphRoots(env = process.env, home = homedir()) {
  const warnings = []
  const paths = new Map()
  const key = path => process.platform === 'win32' ? path.toLowerCase() : path
  const add = path => {
    if (typeof path !== 'string' || !isAbsolute(path)) return
    path = resolve(path)
    if (existsSync(join(path, '.specs', 'graph'))) paths.set(key(path), path)
  }

  const centrals = [...new Set([
    env.PRUMO_HOME,
    env.GRAPH_FOREMAN_HOME,
    join(home, '.local', 'share', 'prumo'),
    join(home, '.local', 'share', 'graph-foreman'),
  ].filter(Boolean).map(path => resolve(path)))]
  for (const central of centrals) {
    if (!existsSync(central)) continue
    try {
      for (const entry of readdirSync(central, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) add(join(central, entry.name))
      }
    } catch { warnings.push(`Could not read workspace directory: ${central}`) }
  }

  const registry = join(home, '.local', 'share', 'prumo', 'installations.json')
  if (existsSync(registry)) {
    try {
      const entries = JSON.parse(readFileSync(registry, 'utf8'))
      if (!Array.isArray(entries)) throw new Error('expected an array')
      for (const entry of entries) {
        if (!entry || !Array.isArray(entry.projects)) {
          warnings.push('Ignored an invalid installation registry entry')
          continue
        }
        for (const project of entry.projects) {
          if (typeof project !== 'string' || !isAbsolute(project) || !existsSync(join(resolve(project), '.specs', 'graph'))) {
            warnings.push(`Ignored unavailable registered project: ${String(project)}`)
            continue
          }
          add(project)
        }
      }
    } catch { warnings.push(`Could not read installation registry: ${registry}`) }
  }

  const names = new Set()
  const roots = [...paths.values()].sort((a, b) => a.localeCompare(b)).map(path => {
    const base = basename(path)
    let name = base
    for (let suffix = 2; names.has(name); suffix++) name = `${base}-${suffix}`
    names.add(name)
    return { name, path, graphDir: join(path, '.specs', 'graph') }
  })
  return { roots, warnings: [...new Set(warnings)] }
}
