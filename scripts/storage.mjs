import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute, sep, basename } from 'node:path'

export function inside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function storageHome(env = process.env, home = homedir()) {
  // Keep an existing installation's data in place. New installations use PRUMO.
  const legacy = join(home, '.local', 'share', 'graph-foreman')
  return resolve(env.PRUMO_HOME ?? env.GRAPH_FOREMAN_HOME ??
    (existsSync(legacy) ? legacy : join(home, '.local', 'share', 'prumo')))
}

export function findRoot(env = process.env, cwd = process.cwd(), home = homedir()) {
  const central = storageHome(env, home)
  const explicit = env.PRUMO_ROOT ?? env.GRAPH_ROOT
  if (explicit) {
    const root = resolve(explicit)
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
