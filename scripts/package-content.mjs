import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT_FILES = ['package.json', 'SKILL.md', 'README.md', 'README.pt-BR.md', 'CHANGELOG.md', 'LICENSE']
const SCRIPT_FILES = new Set(['messages.json', 'release-notes.json', 'dashboard.html'])

function type(path, expected, root) {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  const relative = path.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') || '.'
  if (!stat) throw new Error(`Distributed package is missing ${relative}`)
  if (stat.isSymbolicLink()) throw new Error(`Distributed package contains a linked path: ${relative}`)
  if (expected === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Distributed package contains an invalid path: ${relative}`)
  }
}

export function packageDistributionFiles(root) {
  const base = resolve(root)
  type(base, 'directory', base)
  const names = [...ROOT_FILES]
  const walk = directory => {
    type(directory, 'directory', base)
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      const stat = lstatSync(path)
      const relative = path.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      if (stat.isSymbolicLink()) throw new Error(`Distributed package contains a linked path: ${relative}`)
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) names.push(relative)
      else throw new Error(`Distributed package contains an invalid path: ${relative}`)
    }
  }

  for (const name of ROOT_FILES) type(join(base, name), 'file', base)
  for (const directory of ['bin', 'lib', 'references']) walk(join(base, directory))
  const scripts = join(base, 'scripts')
  type(scripts, 'directory', base)
  for (const entry of readdirSync(scripts)) {
    const path = join(scripts, entry)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`Distributed package contains a linked path: scripts/${entry}`)
    if (stat.isFile() && ((entry.endsWith('.mjs') && !entry.endsWith('.test.mjs') && !entry.endsWith('-smoke.mjs')) || SCRIPT_FILES.has(entry))) {
      names.push(`scripts/${entry}`)
    }
  }
  return [...new Set(names)].sort()
}

export function packageContentManifest(root) {
  return Object.fromEntries(packageDistributionFiles(root).map(name => [
    name,
    createHash('sha256').update(readFileSync(join(root, name))).digest('hex'),
  ]))
}
