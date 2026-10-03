import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mergeReports, readReports, runCoverageCommand, sourceManifest } from '../tools/coverage.mjs'

test('merge incremental do c8 conserva contadores e arquivo nunca carregado dos mesmos perfis reais', t => {
  const parent = realpathSync(tmpdir())
  const root = mkdtempSync(join(parent, 'prumo-c8-merge-'))
  t.after(() => {
    assert.equal(dirname(realpathSync(root)), parent)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const sources = join(root, 'source'), profiles = join(root, 'profiles')
  mkdirSync(sources)
  mkdirSync(profiles)
  writeFileSync(join(sources, 'app.mjs'), 'export function choose(value) {\n  if (value) return "sim"\n  return "não"\n}\n')
  writeFileSync(join(sources, 'absent.mjs'), 'export function absent(value) {\n  if (value) return 1\n  return 0\n}\n')
  const runner = join(root, 'runner.mjs')
  writeFileSync(runner, 'import { choose } from "./source/app.mjs"; console.log(choose(process.argv[2] === "true"))\n')
  const run = (args, coverageDirectory) => {
    const result = spawnSync(process.execPath, args, {
      cwd: root, env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory },
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout.trim()
  }
  assert.equal(run([runner, 'true'], profiles), 'sim')
  assert.equal(run([runner, 'false'], profiles), 'não')
  const profileNames = readdirSync(profiles).sort()
  assert.equal(profileNames.length, 2)
  const before = profileNames.map(name => readFileSync(join(profiles, name), 'utf8'))
  const config = join(root, '.c8rc.json')
  writeFileSync(config, JSON.stringify({ all: true, include: ['source/**/*.mjs'], exclude: [], extension: ['.mjs'],
    'check-coverage': false, reporter: ['json', 'json-summary'], 'temp-directory': profiles }))
  const c8 = fileURLToPath(new URL('../node_modules/c8/bin/c8.js', import.meta.url))
  const reports = []
  for (const asynchronous of [false, true]) {
    const output = join(root, asynchronous ? 'incremental' : 'synchronous')
    // O próprio reporter conserva os preloads, mas não pode acrescentar perfis ao conjunto comparado.
    run([c8, 'report', '--config', config, `--merge-async=${asynchronous}`, '--reports-dir', output], join(root, `report-runtime-${asynchronous}`))
    reports.push({ data: JSON.parse(readFileSync(join(output, 'coverage-final.json'), 'utf8')),
      summary: JSON.parse(readFileSync(join(output, 'coverage-summary.json'), 'utf8')) })
  }
  assert.deepEqual(readdirSync(profiles).sort(), profileNames)
  assert.deepEqual(profileNames.map(name => readFileSync(join(profiles, name), 'utf8')), before)
  assert.deepEqual(reports[1], reports[0])
  assert.deepEqual(Object.keys(reports[0].data).sort(), [join(sources, 'absent.mjs'), join(sources, 'app.mjs')].sort())
  const loaded = reports[0].data[join(sources, 'app.mjs')]
  assert.ok(Object.values(loaded.b).flat().every(count => count > 0), 'os subprocessos reais exercitam ramos complementares')
  const absent = reports[0].data[join(sources, 'absent.mjs')]
  for (const counts of [Object.values(absent.s), Object.values(absent.f), Object.values(absent.b).flat()]) {
    assert.ok(counts.length > 0)
    assert.ok(counts.every(count => count === 0), 'fonte nunca carregado permanece no denominador com cobertura zero')
  }
  assert.equal(reports[0].summary[join(sources, 'absent.mjs')].lines.pct, 0)
  assert.equal(reports[0].summary[join(sources, 'app.mjs')].branches.pct, 100)
})

test('importar ferramentas sem argumentos não dispara coleta nem instalação', t => {
  const base = realpathSync(tmpdir())
  const root = mkdtempSync(join(base, 'prumo-tool-import-'))
  t.after(() => { assert.equal(dirname(root), base); rmSync(root, { recursive: true, force: true }) })
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
  const base = realpathSync(tmpdir())
  const root = mkdtempSync(join(base, 'prumo-coverage-'))
  t.after(() => { assert.equal(dirname(root), base); rmSync(root, { recursive: true, force: true }) })
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

test('manifesto recusa HTML trocado por link após capturar o diretório e preserva o arquivo externo', t => {
  const root = fixture(t), outside = fixture(t)
  const scripts = join(root, 'scripts'), dashboard = join(scripts, 'dashboard.html')
  const external = join(outside, 'dashboard.html')
  mkdirSync(scripts)
  writeFileSync(dashboard, '<script>globalThis.example = 1</script>')
  const bytes = Buffer.from('<script>globalThis.externo = "preservar"</script>\r\n')
  writeFileSync(external, bytes)
  const tool = new URL('../tools/coverage.mjs', import.meta.url).href
  const code = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    const { sourceManifest } = await import(${JSON.stringify(tool)});
    const scripts = ${JSON.stringify(scripts)}, dashboard = ${JSON.stringify(dashboard)};
    const original = fs.readdirSync;
    let capturedRegular = false, replacements = 0;
    fs.readdirSync = function (directory, options) {
      const entries = original.call(this, directory, options);
      if (directory === scripts && options?.withFileTypes && replacements === 0) {
        const entry = entries.find(item => item.name === 'dashboard.html');
        assert.ok(entry.isFile());
        assert.equal(entry.isSymbolicLink(), false);
        capturedRegular = true;
        fs.unlinkSync(dashboard);
        fs.symlinkSync(${JSON.stringify(external)}, dashboard, 'file');
        replacements++;
      }
      return entries;
    };
    syncBuiltinESMExports();
    try {
      let failure;
      try { sourceManifest(${JSON.stringify(root)}); } catch (error) { failure = error; }
      if (failure?.code === 'EPERM') throw failure;
      assert.equal(failure?.message, 'Fonte ligado nao e aceito: scripts/dashboard.html');
      assert.equal(capturedRegular, true);
      assert.equal(replacements, 1);
      assert.ok(fs.lstatSync(dashboard).isSymbolicLink());
      console.log('corrida recusada');
    } catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM' && error.syscall === 'symlink') console.log('link exige privilégio');
      else throw error;
    } finally {
      fs.readdirSync = original;
      syncBuiltinESMExports();
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(readFileSync(external), bytes)
  assert.equal(readdirSync(root).includes('.test-output'), false)
  if (process.platform === 'win32' && result.stdout.trim() === 'link exige privilégio') {
    t.skip('A criação de link de arquivo exige privilégio neste Windows')
    return
  }
  assert.equal(result.stdout.trim(), 'corrida recusada')
})
