import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mergeReports, readReports, runCoverageCommand, sourceManifest } from '../tools/coverage.mjs'

test('importar ferramentas sem argumentos não dispara coleta nem instalação', t => {
  const root = mkdtempSync(join(tmpdir(), 'prumo-tool-import-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }) })
  const urls = ['../tools/coverage.mjs', '../tools/run-coverage.mjs', '../scripts/postinstall.mjs']
    .map(path => new URL(path, import.meta.url).href)
  const code = `for (const url of ${JSON.stringify(urls)}) await import(url); console.log('imports ready')`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stdout.trim(), 'imports ready')
  assert.deepEqual(readdirSync(root), [])
})

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'prumo-coverage-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'lib/nested'), { recursive: true })
  writeFileSync(join(root, 'lib/nested/app.mjs'), 'export const valor = true\r\n')
  writeFileSync(join(root, 'lib/ignored.test.mjs'), '// teste')
  writeFileSync(join(root, 'lib/ignored-smoke.mjs'), '// smoke')
  writeFileSync(join(root, 'lib/readme.md'), '# documento')
  return root
}
const position = { start: { line: 1, column: 0 }, end: { line: 1, column: 25 } }
function file(path, counts = [1, 1]) {
  return { path, statementMap: { 0: position }, fnMap: { 0: { name: 'valor', decl: position, loc: position, line: 1 } },
    branchMap: { 0: { loc: position, type: 'if', locations: [position, position], line: 1 } },
    s: { 0: 1 }, f: { 0: 1 }, b: { 0: counts } }
}

test('cobertura combina plataformas e exige todos os ramos dos mesmos fontes', t => {
  const root = fixture(t), manifest = sourceManifest(root)
  assert.deepEqual(Object.keys(manifest), ['lib/nested/app.mjs'])
  const windows = 'D:\\a\\prumo\\prumo\\lib\\nested\\app.mjs'
  const linux = '/home/runner/work/prumo/prumo/lib/nested/app.mjs'
  const first = { manifest, data: { [windows]: file(windows, [1, 0]) } }
  const incomplete = mergeReports(root, [first])
  assert.deepEqual(incomplete.failures, ['lib/nested/app.mjs: branches 50%'])
  const result = mergeReports(root, [first, { manifest, data: { [linux]: file(linux, [0, 1]) } }])
  assert.deepEqual(result.failures, [])
  assert.equal(result.summary.branches.pct, 100)
  assert.deepEqual(Object.keys(result.data), ['lib/nested/app.mjs'])
  const relative = mergeReports(root, [{ manifest, data: { 'lib/nested/app.mjs': file('lib/nested/app.mjs') } }])
  assert.deepEqual(relative.failures, [])
})

test('cobertura nao aceita denominador vazio, relatorio antigo, fonte ausente nem fonte externo', t => {
  const root = fixture(t), manifest = sourceManifest(root)
  assert.throws(() => mergeReports(root, []), /Nenhum relatorio/)
  assert.throws(() => mergeReports(join(root, 'empty'), [{ manifest: {}, data: {} }]), /Nenhum fonte/)
  assert.throws(() => mergeReports(root, [{ manifest: {}, data: {} }]), /fontes atuais/)
  assert.throws(() => mergeReports(root, [{ manifest, data: {} }]), /sem medicao/)
  assert.throws(() => mergeReports(root, [{ manifest, data: { 'external.mjs': file('external.mjs') } }]), /fora do escopo/)
  const empty = { path: 'lib/nested/app.mjs', statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} }
  assert.throws(() => mergeReports(root, [{ manifest, data: { 'lib/nested/app.mjs': empty } }]), /sem instrucoes medidas/)
  writeFileSync(join(root, 'lib/nested/app.mjs'), 'export const valor = false\n')
  assert.throws(() => mergeReports(root, [{ manifest, data: {} }]), /fontes atuais/)
})

test('coleta e consolidacao escrevem evidencias e falham com cobertura incompleta', t => {
  const root = fixture(t)
  assert.equal(runCoverageCommand('manifest', undefined, root), 0)
  const reports = join(root, '.test-output/coverage')
  const manifest = JSON.parse(readFileSync(join(reports, 'source-manifest.json'), 'utf8'))
  writeFileSync(join(reports, 'coverage-final.json'), JSON.stringify({ 'lib/nested/app.mjs': file('lib/nested/app.mjs', [1, 0]) }))
  assert.equal(readReports(join(root, '.test-output')).length, 1)
  assert.equal(runCoverageCommand('merge', reports, root), 1)
  assert.equal(JSON.parse(readFileSync(join(root, '.test-output/coverage-merged/coverage-summary.json'), 'utf8')).branches.pct, 50)
  writeFileSync(join(reports, 'coverage-final.json'), JSON.stringify({ 'lib/nested/app.mjs': file('lib/nested/app.mjs') }))
  assert.equal(runCoverageCommand('merge', reports, root), 0)
  assert.throws(() => runCoverageCommand('unknown', undefined, root), /Use coverage/)
  assert.throws(() => runCoverageCommand('merge', undefined, root), /Use coverage/)
  assert.deepEqual(manifest, sourceManifest(root))
})

test('cobertura nao percorre links para fontes ou relatorios fora do diretorio', t => {
  const root = fixture(t)
  symlinkSync(join(root, 'lib'), join(root, 'reports-link'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => readReports(join(root, 'reports-link')), /ligado/)
  symlinkSync(join(root, 'lib/nested'), join(root, 'lib/linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => sourceManifest(root), /ligado/)
  const linkedRoot = fixture(t)
  symlinkSync(join(root, 'lib/nested'), join(linkedRoot, 'tools'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => sourceManifest(linkedRoot), /ligado/)
  const artifacts = join(root, 'artifacts')
  mkdirSync(artifacts)
  symlinkSync(join(root, 'lib/nested'), join(artifacts, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => readReports(artifacts), /ligado/)
})

test('comando de cobertura coleta manifesto e recusa acao invalida', () => {
  const tool = fileURLToPath(new URL('../tools/coverage.mjs', import.meta.url))
  const collected = spawnSync(process.execPath, [tool, 'manifest'], { encoding: 'utf8', windowsHide: true })
  assert.equal(collected.status, 0, collected.stdout + collected.stderr)
  const invalid = spawnSync(process.execPath, [tool, 'unknown'], { encoding: 'utf8', windowsHide: true })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /Use coverage/)
})

test('manifesto inclui o JavaScript entregue pelo dashboard antes da coleta', t => {
  const root = fixture(t)
  mkdirSync(join(root, 'scripts'))
  const html = '<html><script>globalThis.example = 1\r\n</script></html>'
  writeFileSync(join(root, 'scripts/dashboard.html'), html)
  const manifest = sourceManifest(root)
  const relative = '.test-output/coverage-sources/dashboard-inline.mjs'
  assert.ok(manifest[relative])
  assert.equal(readFileSync(join(root, relative), 'utf8'), 'globalThis.example = 1\n')
  assert.throws(() => mergeReports(root, [{ manifest, data: { 'lib/nested/app.mjs': file('lib/nested/app.mjs') } }]), /Fonte sem medicao/)
  writeFileSync(join(root, 'scripts/dashboard.html'), '<html>sem script</html>')
  assert.throws(() => sourceManifest(root), /Script inline.*ausente/)
  writeFileSync(join(root, 'scripts/dashboard.html'), '<script>const first = 1</script><script>const missed = 2</script>')
  assert.throws(() => sourceManifest(root), /medir todos os scripts/)
})

test('preparação da cobertura não escreve através de diretório ligado', t => {
  const root = fixture(t), outside = fixture(t)
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts/dashboard.html'), '<script>throw new Error("não executar")</script>')
  symlinkSync(outside, join(root, '.test-output'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => sourceManifest(root), /ligado/)
  assert.equal(readFileSync(join(outside, 'lib/nested/app.mjs'), 'utf8'), 'export const valor = true\r\n')
})

test('manifesto recusa dashboard ligado antes de criar fontes derivados', t => {
  const root = fixture(t), outside = fixture(t)
  mkdirSync(join(root, 'scripts'))
  const html = join(outside, 'dashboard.html')
  writeFileSync(html, '<script>globalThis.example = 1</script>')
  try {
    symlinkSync(html, join(root, 'scripts/dashboard.html'), 'file')
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('A criação de link de arquivo exige privilégio neste Windows')
      return
    }
    throw error
  }
  assert.throws(() => sourceManifest(root), /Fonte ligado.*dashboard\.html/)
  assert.equal(readFileSync(html, 'utf8'), '<script>globalThis.example = 1</script>')
  assert.equal(readdirSync(root).includes('.test-output'), false)
})
