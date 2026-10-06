import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installationBundle, bundleIdentity } from '../scripts/installation-bundle.mjs'
import { packageContentManifest, packageDistributionFiles } from '../scripts/package-content.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootFiles = ['package.json', 'SKILL.md', 'README.md', 'README.pt-BR.md', 'CHANGELOG.md', 'LICENSE']
const bundleScripts = ['messages.json', 'region.mjs', 'i18n.mjs', 'storage.mjs', 'atomic-state.mjs', 'validation.mjs', 'task-scope.mjs', 'execution-readiness.mjs', 'contract-drift.mjs', 'sync-plan-audit.mjs', 'task-identifiers.mjs', 'dashboard-diagnostics.mjs', 'dashboard-update.mjs', 'dashboard.html', 'installation-bundle.mjs', 'engine-args.mjs', 'command-metrics.mjs', 'review-readiness.mjs', 'engine.mjs', 'serve-args.mjs', 'serve.mjs']

function fixture(t, prefix) {
  const root = mkdtempSync(join(resolve(tmpdir()), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}

function distributionFixture(t, prefix) {
  const root = fixture(t, prefix)
  for (const name of rootFiles) copyFileSync(join(repository, name), join(root, name))
  for (const name of ['bin', 'lib', 'references', 'scripts']) cpSync(join(repository, name), join(root, name), { recursive: true })
  return root
}

function linkDirectory(target, destination) {
  symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

function bundleFixture(t) {
  const root = fixture(t, 'prumo-bundle-hardening-')
  for (const name of ['README.md', 'README.pt-BR.md', 'LICENSE', 'SKILL.md']) copyFileSync(join(repository, name), join(root, name))
  mkdirSync(join(root, 'references', 'nested'), { recursive: true })
  writeFileSync(join(root, 'references', 'guide.md'), 'guia')
  writeFileSync(join(root, 'references', 'nested', 'detail.md'), 'detalhe')
  mkdirSync(join(root, 'lib'), { recursive: true })
  copyFileSync(join(repository, 'lib', 'release-notes.mjs'), join(root, 'lib', 'release-notes.mjs'))
  for (const name of [...bundleScripts, 'release-notes.json']) {
    mkdirSync(dirname(join(root, 'scripts', name)), { recursive: true })
    copyFileSync(join(repository, 'scripts', name), join(root, 'scripts', name))
  }
  return root
}

test('manifesto de conteúdo inclui somente arquivos distribuídos e hashes verificáveis', t => {
  const names = packageDistributionFiles(repository)
  const manifest = packageContentManifest(repository)
  assert.deepEqual(Object.keys(manifest).sort(), names)
  assert.match(manifest['package.json'], /^[a-f0-9]{64}$/)
  assert.equal(names.some(name => name.endsWith('.test.mjs') || name.endsWith('-smoke.mjs')), false)

  const nested = distributionFixture(t, 'prumo-package-recursion-')
  mkdirSync(join(nested, 'references', 'nested'), { recursive: true })
  writeFileSync(join(nested, 'references', 'nested', 'guide.md'), 'guia aninhada')
  assert.ok(packageDistributionFiles(nested).includes('references/nested/guide.md'))
})

test('empacotamento rejeita arquivo ausente, link e tipo inválido na raiz', t => {
  const missing = distributionFixture(t, 'prumo-package-missing-')
  rmSync(join(missing, 'package.json'))
  assert.throws(() => packageDistributionFiles(missing), /Distributed package is missing package\.json/)

  const invalid = distributionFixture(t, 'prumo-package-invalid-')
  rmSync(join(invalid, 'package.json'))
  mkdirSync(join(invalid, 'package.json'))
  assert.throws(() => packageDistributionFiles(invalid), /Distributed package contains an invalid path: package\.json/)

  const linked = distributionFixture(t, 'prumo-package-linked-')
  const external = join(dirname(linked), 'prumo-package-linked-target')
  mkdirSync(external, { recursive: true })
  t.after(() => rmSync(external, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  rmSync(join(linked, 'package.json'))
  linkDirectory(external, join(linked, 'package.json'))
  assert.throws(() => packageDistributionFiles(linked), /Distributed package contains a linked path: package\.json/)
})

test('empacotamento rejeita links em árvores internas e em scripts', t => {
  const nested = distributionFixture(t, 'prumo-package-nested-link-')
  mkdirSync(join(nested, 'references', 'nested-package'), { recursive: true })
  writeFileSync(join(nested, 'references', 'nested-package', 'guide.md'), 'referência aninhada')
  const external = join(dirname(nested), 'prumo-package-nested-target')
  mkdirSync(external, { recursive: true })
  t.after(() => rmSync(external, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  linkDirectory(external, join(nested, 'lib', 'linked'))
  assert.throws(() => packageDistributionFiles(nested), /Distributed package contains a linked path: lib[\\/]linked/)

  const scripts = distributionFixture(t, 'prumo-package-scripts-link-')
  const scriptsTarget = join(dirname(scripts), 'prumo-package-scripts-target')
  mkdirSync(scriptsTarget, { recursive: true })
  t.after(() => rmSync(scriptsTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  linkDirectory(scriptsTarget, join(scripts, 'scripts', 'linked.mjs'))
  assert.throws(() => packageDistributionFiles(scripts), /Distributed package contains a linked path: scripts[\\/]linked\.mjs/)
})

test('empacotamento identifica tipo especial quando o sistema oferece socket no diretório', async t => {
  if (process.platform === 'win32') return t.skip('Windows não expõe socket Unix como entrada regular de diretório')
  const root = distributionFixture(t, 'prumo-package-special-')
  const socket = join(root, 'lib', 'special-entry')
  const server = createServer()
  t.after(() => { try { server.close() } catch {} })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  assert.throws(() => packageDistributionFiles(root), /Distributed package contains an invalid path: lib[\\/]special-entry/)
  await new Promise(resolve => server.close(resolve))
})

test('bundle percorre referências aninhadas, tolera referências ausentes e ordena nomes iguais', t => {
  const root = bundleFixture(t)
  const withReferences = installationBundle('pt-BR', root)
  assert.ok(withReferences.some(([name]) => name === join('references', 'nested', 'detail.md')))
  assert.notDeepEqual(installationBundle('en', root).find(([name]) => name === join('scripts', 'dashboard.html'))[1], withReferences.find(([name]) => name === join('scripts', 'dashboard.html'))[1])

  rmSync(join(root, 'references'), { recursive: true, force: true })
  const withoutReferences = installationBundle('en', root)
  assert.equal(withoutReferences.some(([name]) => name.startsWith('references')), false)
  assert.match(bundleIdentity([['mesmo', Buffer.from('a')], ['mesmo', Buffer.from('b')]]), /^[a-f0-9]{12}$/)
})
