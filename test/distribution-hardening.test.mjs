import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dashboardWithCatalog } from '../scripts/build-dashboard.mjs'
import { runPostinstall } from '../scripts/postinstall.mjs'
import { packageDistributionFiles } from '../scripts/package-content.mjs'

test('instalação local não ativa instalação global nem altera arquivos no diretório', t => {
  const root = mkdtempSync(join(tmpdir(), 'prumo-local-postinstall-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }) })
  assert.equal(runPostinstall(), 0)
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/postinstall.mjs', import.meta.url))], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('verificação pública aceita o pacote atual e inspeciona arquivos distribuídos em subpastas', t => {
  const repository = fileURLToPath(new URL('..', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'prumo-package-check-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }) })
  const invoke = base => spawnSync(process.execPath, [join(base, 'scripts/check-package.mjs')], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  const current = invoke(repository)
  assert.ifError(current.error)
  assert.equal(current.status, 0, current.stdout + current.stderr)
  assert.match(current.stdout, /package, skill, translations and source checks passed/)
  for (const name of packageDistributionFiles(repository)) {
    const target = join(root, name)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(repository, name), target)
  }
  // A referência de release é usada pela preparação do pacote, sem entrar na distribuição.
  cpSync(join(repository, 'scripts/release-baseline.json'), join(root, 'scripts/release-baseline.json'))
  const nested = join(root, 'references/nested')
  mkdirSync(nested)
  writeFileSync(join(nested, 'example.txt'), 'C:/Users/example/project')
  const ignored = invoke(root)
  assert.ifError(ignored.error)
  assert.equal(ignored.status, 0, ignored.stdout + ignored.stderr)
  writeFileSync(join(nested, 'example.md'), 'C:/Users/example/project')
  const rejected = invoke(root)
  assert.ifError(rejected.error)
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr)
  assert.match(rejected.stderr, /personal path.*example\.md/)
})

test('dashboard não pode ser distribuído sem entidades ou marcadores de comportamento', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.throws(() => dashboardWithCatalog(html.replace('id="orchNode"', 'id="removed"')), /Entidade.*orchNode/)
  for (const [marker, message] of [['I18N', /translation marker/], ['GAIN_HELPERS', /gain-helper marker/], ['GUIDE', /onboarding marker/]]) {
    assert.throws(() => dashboardWithCatalog(html.replace(`/*PRUMO_${marker}_START*/`, '')), message)
  }
  assert.equal(dashboardWithCatalog(html), html)
})

test('instalação automática propaga falha de início e não trata processo interrompido como sucesso', () => {
  const error = new Error('processo indisponível')
  assert.throws(() => runPostinstall({ global: true, run: () => ({ error }) }), error)
  assert.equal(runPostinstall({ global: true, run: () => ({ status: null }) }), 1)
  assert.equal(runPostinstall({ global: true, run: () => ({ status: 0 }) }), 0)
})

test('gerador detecta catálogo antigo e só o substitui mediante opção explícita', t => {
  const root = mkdtempSync(join(tmpdir(), 'prumo-build-catalog-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }) })
  cpSync(fileURLToPath(new URL('../scripts', import.meta.url)), join(root, 'scripts'), { recursive: true })
  const htmlPath = join(root, 'scripts/dashboard.html'), script = join(root, 'scripts/build-dashboard.mjs')
  const current = readFileSync(htmlPath, 'utf8')
  const old = current.replace(/const PRUMO_MESSAGES = [^\n]+/, 'const PRUMO_MESSAGES = {}')
  assert.notEqual(old, current)
  writeFileSync(htmlPath, old)
  const check = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true })
  assert.equal(check.status, 1, check.stdout + check.stderr)
  assert.match(check.stderr, /--write after editing translations/)
  assert.equal(readFileSync(htmlPath, 'utf8'), old)
  const build = spawnSync(process.execPath, [script, '--write'], { encoding: 'utf8', windowsHide: true })
  assert.equal(build.status, 0, build.stdout + build.stderr)
  assert.equal(readFileSync(htmlPath, 'utf8'), current)
  const verified = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true })
  assert.equal(verified.status, 0, verified.stdout + verified.stderr)
})
