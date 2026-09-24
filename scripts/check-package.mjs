import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import { dashboardWithCatalog } from './build-dashboard.mjs'
import { packageContentManifest } from './package-content.mjs'
import { assertReleaseContentVersion } from './release-guard.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, '@henri-ralmeida/prumo')
assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
assert.equal(pkg.bin.prumo, 'bin/prumo.mjs')
assert.equal(pkg.engines.node, '>=22')
assert.equal(pkg.dependencies, undefined)
const releaseNotes = JSON.parse(readFileSync(join(root, 'scripts', 'release-notes.json'), 'utf8'))
assert.ok(Array.isArray(releaseNotes[pkg.version]?.en) && releaseNotes[pkg.version].en.length > 0, `missing English release notes for ${pkg.version}`)
assert.ok(releaseNotes[pkg.version].en.every(section => typeof section.title === 'string' && Array.isArray(section.items) && section.items.length > 0))
assert.equal(releaseNotes[pkg.version]?.['pt-BR'], undefined)
const releaseBaseline = JSON.parse(readFileSync(join(root, 'scripts', 'release-baseline.json'), 'utf8'))
assert.equal(releaseBaseline.source, `npm registry tarball @henri-ralmeida/prumo@${releaseBaseline.version}`)
assert.match(releaseBaseline.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/)
assertReleaseContentVersion(pkg.version, releaseBaseline, packageContentManifest(root))
for (const file of ['SKILL.md', 'README.md', 'README.pt-BR.md', 'CHANGELOG.md', 'LICENSE', 'references/po-first.md', 'references/po-first.pt-BR.md', 'references/runtime.md', 'references/runtime.pt-BR.md']) assert.ok(existsSync(join(root, file)), file)
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8')
assert.match(skill, /^---\nname: prumo\n/)
assert.match(skill, /Normalize every\s+nonterminal prose or obsolete validation/)
assert.match(skill, /every external dependency of every unfinished member is `done` or `skipped`/)
assert.match(skill, /A named task in the user's request is a hard scope boundary/)
assert.match(skill, /keep its internal work inside the one immutable task plan/)
assert.match(skill, /cachePaths/)
assert.match(skill, /one focused counterexample for the highest-risk applicable/)
assert.match(skill, /Once every applicable criterion has current evidence/)
assert.match(skill, /Inspect the actual tools and write permissions/)
assert.match(skill, /Você é o PLANEJADOR somente leitura/)
assert.ok(skill.includes('block opened with ' + String.fromCharCode(96).repeat(3) + 'json'))
assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /prumo migrate --check/)
assert.match(readFileSync(join(root, 'README.pt-BR.md'), 'utf8'), /prumo migrate --check/)
const poFirst = readFileSync(join(root, 'references', 'po-first.md'), 'utf8')
assert.match(poFirst, /Stop investigating when every material criterion has current evidence/)
assert.match(poFirst, /Judge suggestions by their usefulness/)
assert.match(poFirst, /workflow metadata/)
const poFirstPtBR = readFileSync(join(root, 'references', 'po-first.pt-BR.md'), 'utf8')
assert.match(poFirstPtBR, /metadados do fluxo de trabalho/)
assert.match(poFirstPtBR, /pergunte ao PO/)
assert.doesNotMatch(skill, /\u0000/)
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
console.log(`Prumo ${pkg.version}: package, skill, translations and source checks passed`)
