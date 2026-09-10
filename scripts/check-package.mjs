import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import { dashboardWithCatalog } from './build-dashboard.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'prumo')
assert.equal(pkg.version, '0.1.0')
assert.equal(pkg.bin.prumo, 'bin/prumo.mjs')
assert.equal(pkg.engines.node, '>=22')
assert.equal(pkg.dependencies, undefined)
for (const file of ['SKILL.md', 'README.md', 'README.pt-BR.md', 'CHANGELOG.md', 'LICENSE', 'references/po-first.md', 'references/runtime.md', 'references/runtime.pt-BR.md']) assert.ok(existsSync(join(root, file)), file)
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8')
assert.match(skill, /^---\nname: prumo\n/)
assert.doesNotMatch(skill, /\u0000/)
assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /JrSantiaggo/)
const html = readFileSync(join(root, 'scripts/dashboard.html'), 'utf8')
assert.equal(dashboardWithCatalog(html), html, 'rebuild dashboard catalog')
new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1])
function inspect(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name)
    if (entry.isDirectory()) inspect(file)
    else if (/\.(md|mjs|json|html)$/.test(file)) {
      const text = readFileSync(file, 'utf8')
      assert.doesNotMatch(text, /[A-Za-z]:[\\/]Users[\\/][a-zA-Z]/, `personal path in ${file}`)
      assert.doesNotMatch(text, /(?:npm_|ghp_)[A-Za-z0-9]{25,}/, `credential-like value in ${file}`)
    }
  }
}
for (const dir of ['bin', 'lib', 'scripts', 'references']) inspect(join(root, dir))
console.log(`PRUMO ${pkg.version}: package, skill, translations and source checks passed`)
