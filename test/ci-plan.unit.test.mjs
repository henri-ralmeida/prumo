import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { planCi } from '../.github/scripts/ci-plan.mjs'

const planner = new URL('../.github/scripts/ci-plan.mjs', import.meta.url)
const platforms = ['ubuntu-latest', 'windows-latest', 'macos-latest']

test('tempos medidos reduzem preparação repetida sem omitir testes ou versões', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const versions = Array.from({ length: 59 }, (_, index) => `3.${index}.0`)
  const plan = planCi({ root, versions })
  assert.ok(plan.regular.include.length + plan.published.include.length < 100)
  const files = ['scripts', 'test'].flatMap(directory => readdirSync(join(root, directory))
    .filter(name => name.endsWith('.test.mjs') && name !== 'upgrade-from-previous.test.mjs').map(name => `${directory}/${name}`))
  assertMatrix(plan.regular, 'files', files)
  assertMatrix(plan.published, 'versions', versions)
})
function fixture(t, count = 27) {
  const root = mkdtempSync(join(tmpdir(), 'prumo-ci-plan-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'test'))
  const files = Array.from({ length: count }, (_, index) => `${index % 2 ? 'test' : 'scripts'}/case-${index}.test.mjs`)
  for (const file of [...files, 'test/upgrade-from-previous.test.mjs', 'scripts/not-a-test.mjs']) writeFileSync(join(root, file), '')
  return { root, files }
}
function assertMatrix(matrix, key, expected) {
  assert.ok(matrix.include.length <= 256)
  assert.deepEqual(matrix.include.slice(0, 6).map(job => `${job.os}:${job.node}`).sort(),
    platforms.flatMap(os => [22, 24].map(node => `${os}:${node}`)).sort())
  for (const os of platforms) for (const node of [22, 24]) {
    const jobs = matrix.include.filter(job => job.os === os && job.node === node)
    assert.ok(jobs.length)
    assert.equal(new Set(jobs.map(job => job.label)).size, jobs.length)
    assert.ok(jobs.every(job => job[key].length > 0))
    const items = jobs.flatMap(job => job[key])
    assert.deepEqual([...items].sort(), [...expected].sort())
    assert.equal(new Set(items).size, expected.length)
  }
}

test('lotes balanceados preservam todos os testes nas seis combinações', t => {
  const { root, files } = fixture(t)
  const versions = Array.from({ length: 13 }, (_, index) => `2.11.${index}`)
  const before = JSON.stringify(versions)
  const plan = planCi({ root, versions })
  assert.ok(plan.regular.include.length < 48)
  assertMatrix(plan.regular, 'files', files)
  assertMatrix(plan.published, 'versions', versions)
  assert.ok([...plan.regular.include, ...plan.published.include].every(job => Number.isFinite(job.estimatedSeconds) && job.estimatedSeconds > 0))
  assert.equal(JSON.stringify(versions), before)
  assert.deepEqual(planCi({ root, versions }), plan)
  writeFileSync(join(root, 'test/future.test.mjs'), '')
  assertMatrix(planCi({ root, versions }).regular, 'files', [...files, 'test/future.test.mjs'])
})

test('catálogo npm futuro preserva a união exata e o limite da matriz', t => {
  const { root } = fixture(t, 8)
  for (const count of [1, 2, 3, 59, 64, 65, 84, 85, 1000]) {
    const versions = Array.from({ length: count }, (_, index) => `3.${index}.0`)
    const plan = planCi({ root, versions })
    assertMatrix(plan.published, 'versions', versions)
    assert.ok(plan.published.include.every(job => job.estimatedSeconds > 0))
    if (count === 59) assert.ok(plan.published.include.length < 60)
  }
})

test('inventário desequilibrado continua com grupos não vazios e sem duplicação', t => {
  const { root, files } = fixture(t, 7)
  writeFileSync(join(root, 'test/engine-planning.test.mjs'), '')
  const plan = planCi({ root, versions: ['2.11.8'] })
  assert.ok(plan.regular.include.length <= 48)
  assertMatrix(plan.regular, 'files', [...files, 'test/engine-planning.test.mjs'])
})

test('projetos pequenos usam somente grupos não vazios e preservam todos os arquivos', t => {
  for (const count of [1, 2, 3, 4, 5, 6, 7]) {
    const { root, files } = fixture(t, count)
    const plan = planCi({ root, versions: ['2.11.8'] })
    assert.ok(plan.regular.include.length <= count * 6)
    assertMatrix(plan.regular, 'files', files)
  }
})

test('entradas inválidas recusam planejamento em vez de omitir cenários', t => {
  const { root } = fixture(t)
  for (const versions of [null, {}, [], [''], ['latest'], ['2.11.8', '2.11.8'], [24], [' 2.11.8'], ['2.11.8\n']])
    assert.throws(() => planCi({ root, versions }), /versões/)
  assert.throws(() => planCi({ root: '', versions: ['2.11.8'] }), /raiz/)
  assert.throws(() => planCi({ root: 1, versions: ['2.11.8'] }), /raiz/)
  const empty = fixture(t, 0)
  assert.throws(() => planCi({ root: empty.root, versions: ['2.11.8'] }), /Nenhum teste/)
  assertMatrix(planCi({ root, versions: ['3.0.0-rc.1', '3.0.0+build.1'] }).published, 'versions', ['3.0.0-rc.1', '3.0.0+build.1'])
})

test('importar o planejador não consulta npm nem grava artefatos', t => {
  const { root } = fixture(t)
  const before = readdirSync(root)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `globalThis.fetch = () => { throw new Error('rede indevida') }; await import(${JSON.stringify(planner.href)});`], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readdirSync(root), before)
})

test('CLI gera o mesmo plano em arquivo e nos outputs sem consultar serviço externo no teste', t => {
  const { root, files } = fixture(t)
  const versions = ['2.11.7', '2.11.8', '2.11.9']
  const preload = join(root, 'registry-fixture.mjs'), output = join(root, 'github-output')
  writeFileSync(preload, `globalThis.fetch = async url => { if (url !== 'https://registry.npmjs.org/@henri-ralmeida%2fprumo') throw new Error('URL inesperada'); return new Response(JSON.stringify({ versions: ${JSON.stringify(Object.fromEntries(versions.map(version => [version, {}])))} }), { status: 200 }); };`)
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(planner)], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(readFileSync(join(root, '.test-output/ci-plan.json'), 'utf8'))
  assertMatrix(plan.regular, 'files', files)
  assertMatrix(plan.published, 'versions', versions)
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => { const split = line.indexOf('='); return [line.slice(0, split), JSON.parse(line.slice(split + 1))] }))
  assert.deepEqual(outputs, plan)
})
