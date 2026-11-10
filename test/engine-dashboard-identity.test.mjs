import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installationBundle, contentId, engineDashboardMismatch, registeredDashboardIdentity, registeredDashboardDiagnostics } from '../scripts/installation-bundle.mjs'
import { packageDistributionFiles } from '../scripts/package-content.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
test('cache do diagnóstico preserva identidade textual e fallback sem novas consultas de rede', async t => {
  const f = fixture(t)
  f.save({ enabled: true, script: join(root, 'scripts/serve.mjs') })
  const fetch = () => { throw new Error('O diagnóstico já consultou os endpoints') }
  for (const diagnostic of [null, {}, { about: { contentId: 12 } }, { about: { contentId: '' } }, { about: { contentId: 'known' } }]) {
    const value = diagnostic?.about?.contentId
    assert.equal(await registeredDashboardIdentity({ home: f.home, fetch, diagnostic }), typeof value === 'string' ? value : contentId('en'))
  }
})
test('diagnóstico verifica catálogo e versão com prazo único sem exigir dashboard configurado', async t => {
  const f = fixture(t)
  const unexpected = () => { throw new Error('Não deve consultar rede sem registro habilitado') }
  assert.equal(await registeredDashboardDiagnostics({ home: f.home, fetch: unexpected }), null)
  f.save({ enabled: false }); assert.equal(await registeredDashboardDiagnostics({ home: f.home, fetch: unexpected }), null)
  f.save({ enabled: true, script: 'relative' }); assert.equal(await registeredDashboardDiagnostics({ home: f.home, fetch: unexpected }), null)
  f.save({ enabled: true, script: join(root, 'scripts/serve.mjs') })
  const health = { product: 'prumo', mode: 'global', readOnly: true, version: '2.0.0' }
  for (const mode of ['healthy', 'catalog', 'foreign', 'http', 'invalid', 'timeout']) {
    const start = performance.now(), signals = new Set()
    const result = await registeredDashboardDiagnostics({ home: f.home, timeout: 20, fetch: async (url, { signal }) => {
      signals.add(signal)
      if (mode === 'timeout') return new Promise(() => {})
      if (mode === 'invalid') throw new Error('Resposta inválida')
      if (url.endsWith('/runs') && mode === 'catalog') return new Promise(() => {})
      return { ok: mode !== 'http', json: async () => url.endsWith('/runs') ? [] : mode === 'foreign' ? { product: 'outro' } : health }
    } })
    assert.equal(result.available, mode === 'healthy')
    assert.equal(result.version, ['healthy', 'catalog'].includes(mode) ? '2.0.0' : null)
    assert.equal(signals.size, 1)
    assert.ok(performance.now() - start < 1000, 'o catálogo não pode bloquear o comando')
  }
})
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-dashboard-identity-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }))
  const path = join(home, '.local/share/prumo/dashboard.json')
  mkdirSync(dirname(path), { recursive: true })
  const save = value => writeFileSync(path, JSON.stringify(value))
  return { home, save }
}
test('comparação usa bytes atuais e aceita ambos os idiomas sem depender da versão', t => {
  for (const lang of ['en', 'pt-BR']) assert.equal(engineDashboardMismatch(root, contentId(lang)), null)
  assert.equal(engineDashboardMismatch(root, null), null)
  assert.equal(engineDashboardMismatch(root, ''), null)
  assert.equal(engineDashboardMismatch(root, 1), null)
  const f = fixture(t)
  assert.equal(engineDashboardMismatch(f.home, 'known'), null)
  const localized = join(f.home, 'localized')
  for (const installedLang of ['en', 'pt-BR']) {
    for (const [name, bytes] of installationBundle(installedLang)) {
      mkdirSync(dirname(join(localized, name)), { recursive: true })
      writeFileSync(join(localized, name), bytes)
    }
    for (const dashboardLang of ['en', 'pt-BR'])
      assert.equal(engineDashboardMismatch(localized, contentId(dashboardLang)), null)
  }
  const mismatch = engineDashboardMismatch(root, 'outdated')
  assert.equal(mismatch.dashboardContentId, 'outdated')
  assert.equal(mismatch.engineContentId, contentId('en'))
  const copy = join(f.home, 'package')
  for (const name of packageDistributionFiles(root)) {
    mkdirSync(dirname(join(copy, name)), { recursive: true })
    copyFileSync(join(root, name), join(copy, name))
  }
  const before = contentId('en', { packageRoot: copy })
  assert.equal(before, contentId('en'))
  appendFileSync(join(copy, 'scripts/engine.mjs'), '\n// Alteração local do motor.\n')
  assert.ok(engineDashboardMismatch(copy, before))
})
test('identidade do dashboard exige registro e saúde confiável ou bytes registrados', async t => {
  const f = fixture(t)
  const unreachable = async () => { throw new Error('Indisponível') }
  assert.equal(await registeredDashboardIdentity({ home: f.home, fetch: unreachable }), null)
  f.save({ enabled: false, script: join(root, 'scripts/serve.mjs') })
  assert.equal(await registeredDashboardIdentity({ home: f.home, fetch: unreachable }), null)
  f.save({ enabled: true })
  assert.equal(await registeredDashboardIdentity({ home: f.home, fetch: unreachable }), null)
  f.save({ enabled: true, script: 'serve.mjs' })
  assert.equal(await registeredDashboardIdentity({ home: f.home, fetch: unreachable }), null)
  for (const lang of ['en', 'pt-BR', 'unknown']) {
    f.save({ enabled: true, script: join(root, 'scripts/serve.mjs'), lang })
    assert.equal(await registeredDashboardIdentity({ home: f.home, fetch: unreachable }), contentId(lang === 'pt-BR' ? lang : 'en'))
  }
  const health = { product: 'prumo', mode: 'global', readOnly: true }
  for (const invalid of [null, {}, { ...health, product: 'other' }, { ...health, mode: 'workspace' }, { ...health, readOnly: false }]) {
    assert.equal(await registeredDashboardIdentity({ home: f.home, fetch: async () => ({ ok: true, json: async () => invalid }) }), null)
  }
  assert.equal(await registeredDashboardIdentity({ home: f.home, fetch: async () => ({ ok: false }) }), null)
  for (const about of [null, {}, { product: 'other', contentId: 'x' }, { product: 'prumo', contentId: null }, { product: 'prumo', contentId: 'healthy' }]) {
    const fetch = async url => ({ ok: true, json: async () => url.endsWith('/health') ? health : about })
    assert.equal(await registeredDashboardIdentity({ home: f.home, fetch }), about?.contentId === 'healthy' ? 'healthy' : null)
  }
  assert.equal(await registeredDashboardIdentity({ home: f.home, fetch: async url => ({ ok: url.endsWith('/health'), json: async () => health }) }), null)
  f.save({ enabled: true, script: join(f.home, 'missing/scripts/serve.mjs') })
  assert.equal(await registeredDashboardIdentity({ home: f.home, fetch: unreachable }), null)
})
