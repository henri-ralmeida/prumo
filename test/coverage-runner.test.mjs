import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runCoverage, coverageBatches } from '../tools/run-coverage.mjs'

test('importacao como biblioteca sem caminho de CLI nao dispara testes', async () => {
  const original = process.argv[1]
  try {
    delete process.argv[1]
    const imported = await import('../tools/run-coverage.mjs?library')
    assert.equal(typeof imported.runCoverage, 'function')
  } finally { process.argv[1] = original }
})

test('runners separados cobrem cada arquivo regular uma vez e conservam as plataformas', () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const all = coverageBatches(repo, 1, true, 'regular').flatMap(batch => batch.files).sort()
  const shards = [0, 1].flatMap(index => coverageBatches(repo, 1, true, 'regular', { index, count: 2 }).flatMap(batch => batch.files))
  assert.deepEqual(shards.sort(), all)
  assert.equal(new Set(shards).size, all.length)
  assert.deepEqual(coverageBatches(repo, 4, false, 'regular', { index: 0, count: 2 }).flatMap(batch => batch.files).sort(), coverageBatches(repo, 1, true, 'regular', { index: 0, count: 2 }).flatMap(batch => batch.files).sort())
  assert.equal(coverageBatches(repo, 4, false, 'all', { index: 0, count: 2 }).length, 1)
  const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest, macos-latest\]/)
  assert.match(workflow, /shard: \[0, 1\]/)
  assert.match(workflow, /PRUMO_TEST_PUBLISHED_SHARD_COUNT: 2/)
  assert.match(workflow, /needs: \[test, published-windows\]/)
})

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'prumo-coverage-runner-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'lib/app.mjs'), 'export const app = 1\n')
  return root
}

test('coleta preserva preloads, exige manifesto e propaga falhas dos testes', t => {
  const root = fixture(t), calls = []
  assert.equal(runCoverage({ root, collect: true, env: { NODE_OPTIONS: '--trace-warnings', PRUMO_TEST_CONCURRENCY: '4' },
    run: (...args) => { calls.push(args); return { status: 7 } } }), 7)
  const [command, args, options] = calls[0]
  assert.equal(command, process.execPath)
  assert.ok(args.includes('--check-coverage=false'))
  assert.ok(args.includes('--test-concurrency=4'))
  assert.match(options.env.NODE_OPTIONS, /^--trace-warnings --import=/)
  assert.equal(options.env.PRUMO_TEST_COVERAGE_FLUSH, '1')
  assert.equal(options.cwd, root)
  assert.equal(Object.keys(JSON.parse(readFileSync(join(root, '.test-output/coverage/source-manifest.json'), 'utf8'))).length, 1)
  const normal = []
  assert.equal(runCoverage({ root, env: {}, run: (...args) => { normal.push(args); return { status: 0 } } }), 0)
  assert.ok(normal[0][1].includes('--test-concurrency=1'))
  assert.ok(!normal[0][1].includes('--check-coverage=false'))
})

test('coleta recusa concorrencia invalida e conserva erro ou sinal do subprocesso', t => {
  const root = fixture(t)
  for (const value of ['0', '5', '1.5', 'invalid'])
    assert.throws(() => runCoverage({ root, env: { PRUMO_TEST_CONCURRENCY: value }, run: () => { throw new Error('nao deve iniciar') } }), /Concorrencia/)
  const error = new Error('spawn indisponivel')
  assert.throws(() => runCoverage({ root, env: {}, run: () => ({ error }) }), error)
  assert.throws(() => runCoverage({ root, env: {}, run: () => ({ signal: 'SIGTERM' }) }), /interrompida/)
  assert.equal(runCoverage({ root, env: {}, run: () => ({ status: null }) }), 1)
})

test('entrada publica de cobertura recusa configuracao invalida antes da suite', () => {
  const runner = fileURLToPath(new URL('../tools/run-coverage.mjs', import.meta.url))
  for (const args of [[], ['--collect']]) {
    const result = spawnSync(process.execPath, [runner, ...args], { env: { ...process.env, PRUMO_TEST_CONCURRENCY: '0' }, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Concorrencia/)
  }
})

function batchFixture(t, files) {
  const root = fixture(t)
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'test'))
  for (const file of files) writeFileSync(join(root, file), '')
  writeFileSync(join(root, 'test/notes.md'), 'Nao e um teste')
  mkdirSync(join(root, 'test/directory.test.mjs'))
  return root
}

test('particionamento preserva todos os testes uma vez e mantem integracoes sequenciais', t => {
  const files = ['scripts/validation.test.mjs', 'test/install.test.mjs', 'test/upgrade-from-previous.test.mjs', 'test/new-feature.test.mjs', 'test/engine-args.unit.test.mjs', 'test/dashboard-planning.test.mjs', 'test/dashboard-gains.test.mjs', 'test/dashboard-diagnostics.test.mjs']
  const root = batchFixture(t, files)
  const batches = coverageBatches(root, 4, true)
  assert.equal(batches.length, 2)
  assert.equal(batches[0].concurrency, 4)
  assert.deepEqual(batches[0].files, files.filter(file => file.includes('dashboard-') || file.endsWith('.unit.test.mjs')).sort())
  assert.equal(batches[1].concurrency, 1)
  assert.ok(batches[1].files.includes('test/upgrade-from-previous.test.mjs'))
  assert.ok(batches[1].files.includes('test/new-feature.test.mjs'))
  const all = batches.flatMap(batch => batch.files)
  assert.deepEqual(all.sort(), files.sort())
  assert.equal(new Set(all).size, files.length)
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const inventory = coverageBatches(repo, 1, true).flatMap(batch => batch.files)
  assert.equal(new Set(inventory).size, inventory.length)
})

test('lotes preservam falhas e acumulam c8 sem exigir cobertura parcial de cem por cento', t => {
  const root = batchFixture(t, ['test/one.unit.test.mjs', 'test/integration.test.mjs'])
  const calls = []
  assert.equal(runCoverage({ root, env: { PRUMO_TEST_PARTITIONED: '1' }, run: (...args) => {
    calls.push(args); return { status: calls.length === 1 ? 7 : 0 }
  } }), 7)
  assert.equal(calls.length, 2)
  assert.ok(calls[0][1].includes('--check-coverage=false'))
  assert.ok(!calls[0][1].includes('--clean=false'))
  assert.ok(calls[1][1].includes('--clean=false'))
  assert.ok(!calls[1][1].includes('--check-coverage=false'))
  const failedLast = []
  assert.equal(runCoverage({ root, collect: true, env: { PRUMO_TEST_PARTITIONED: '1' }, run: (...args) => {
    failedLast.push(args); return { status: failedLast.length === 2 ? null : 0 }
  } }), 1)
  assert.ok(failedLast.every(([, args]) => args.includes('--check-coverage=false')))
})

test('particionamento aceita lotes unicos e recusa configuracao invalida ou suite vazia', t => {
  const independent = batchFixture(t, ['test/one.unit.test.mjs'])
  assert.deepEqual(coverageBatches(independent, 1, true), [{ files: ['test/one.unit.test.mjs'], concurrency: 4 }])
  const serial = batchFixture(t, ['test/integration.test.mjs'])
  assert.deepEqual(coverageBatches(serial, 4, true), [{ files: ['test/integration.test.mjs'], concurrency: 1 }])
  const empty = batchFixture(t, [])
  assert.throws(() => coverageBatches(empty, 1, true), /Nenhum teste/)
  for (const value of ['', '2', 'true']) assert.throws(() => runCoverage({ root: empty, env: { PRUMO_TEST_PARTITIONED: value } }), /Particionamento/)
})

test('jobs regulares e historicos preservam a suite completa sem duplicar o historico Windows', t => {
  const files = ['test/upgrade-from-previous.test.mjs', 'test/one.unit.test.mjs', 'test/install.test.mjs', 'scripts/validation.test.mjs']
  const root = batchFixture(t, files)
  const regular = coverageBatches(root, 1, true, 'regular')
  const published = coverageBatches(root, 4, true, 'published')
  assert.equal(published.length, 1)
  assert.equal(published[0].concurrency, 1)
  assert.deepEqual(published[0].files, ['test/upgrade-from-previous.test.mjs'])
  assert.equal(regular.flatMap(batch => batch.files).includes('test/upgrade-from-previous.test.mjs'), false)
  assert.deepEqual([...regular, ...published].flatMap(batch => batch.files).sort(), files.sort())
  assert.deepEqual(coverageBatches(root, 4, false, 'regular'), [{ concurrency: 4, files: files.filter(file => !file.includes('upgrade-from-previous')).sort() }])
  assert.throws(() => coverageBatches(root, 1, true, 'unknown'), /Suite de cobertura/)
  const calls = []
  assert.equal(runCoverage({ root, collect: true, env: { PRUMO_TEST_SUITE: 'published', PRUMO_TEST_CONCURRENCY: '4' }, run: (...args) => { calls.push(args); return { status: 0 } } }), 0)
  assert.equal(calls.length, 1)
  assert.ok(calls[0][1].includes('--test-concurrency=1'))
  assert.equal(calls[0][1].at(-1), 'test/upgrade-from-previous.test.mjs')
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const actual = coverageBatches(repo, 1, true).flatMap(batch => batch.files).sort()
  const separated = [...coverageBatches(repo, 1, true, 'regular'), ...coverageBatches(repo, 1, false, 'published')].flatMap(batch => batch.files).sort()
  assert.deepEqual(separated, actual)
  const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')
  assert.match(workflow, /published-windows:[\s\S]*node: \[22, 24\][\s\S]*runs-on: windows-latest/)
  assert.match(workflow, /needs: \[test, published-windows\]/)
})

test('execucao real paraleliza os unitarios e preserva a cobertura conjunta antes das integracoes', t => {
  const root = batchFixture(t, ['test/one.unit.test.mjs', 'test/two.unit.test.mjs', 'test/integration.test.mjs'])
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  mkdirSync(join(root, 'test/fixtures'))
  copyFileSync(join(repo, 'test/fixtures/coverage-flush.mjs'), join(root, 'test/fixtures/coverage-flush.mjs'))
  copyFileSync(join(repo, 'test/fixtures/coverage-alias.mjs'), join(root, 'test/fixtures/coverage-alias.mjs'))
  writeFileSync(join(root, 'lib/app.mjs'), 'export function select(value) { return value ? 1 : 2 }\n')
  writeFileSync(join(root, '.c8rc.json'), JSON.stringify({ all: true, include: ['lib/*.mjs'], reporter: ['json', 'json-summary'], 'reports-dir': '.test-output/coverage', 'temp-directory': '.test-output/coverage/tmp', 'check-coverage': true, lines: 100, statements: 100, branches: 100, functions: 100 }))
  for (const [name, sibling] of [['one', 'two'], ['two', 'one']]) {
    writeFileSync(join(root, `test/${name}.unit.test.mjs`), `import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { select } from '../lib/app.mjs'
test('unitario aguarda o outro processo independente', async () => {
  writeFileSync('${name}-started', '')
  const deadline = Date.now() + 10000
  while (!existsSync('${sibling}-started') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(existsSync('${sibling}-started'))
  assert.equal(select(true), 1)
  writeFileSync('${name}-done', '')
})
`)
  }
  writeFileSync(join(root, 'test/integration.test.mjs'), `import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { select } from '../lib/app.mjs'
test('integracao comeca depois dos unitarios', () => {
  assert.ok(existsSync('one-done') && existsSync('two-done'))
  assert.equal(select(false), 2)
})
`)
  const env = { ...process.env, PRUMO_TEST_PARTITIONED: '1', PRUMO_TEST_CONCURRENCY: '1',
    PRUMO_TEST_SUITE: 'all', PRUMO_TEST_SHARD_INDEX: '0', PRUMO_TEST_SHARD_COUNT: '1' }
  // A CLI externa nao herda o marcador interno do node:test que executa esta regressao.
  delete env.NODE_TEST_CONTEXT
  assert.equal(runCoverage({ root, env }), 0)
  const summary = JSON.parse(readFileSync(join(root, '.test-output/coverage/coverage-summary.json'), 'utf8'))
  for (const metric of ['lines', 'functions', 'statements', 'branches']) assert.equal(summary.total[metric].pct, 100)
})
