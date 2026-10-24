import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCiBatch } from '../.github/scripts/run-ci-batch.mjs'
import { publishedSelection } from './fixtures/ci-published-selection.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'prumo-ci-batch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['lib', 'test', 'scripts']) mkdirSync(join(root, dir))
  writeFileSync(join(root, 'lib/source.mjs'), 'export const approved = true\n')
  for (const file of ['test/fast.unit.test.mjs', 'test/integration.test.mjs', 'test/upgrade-from-previous.test.mjs']) writeFileSync(join(root, file), '')
  return root
}

test('lote regular executa apenas arquivos selecionados e limpa a primeira coleta real', t => {
  const root = fixture(t)
  for (const files of [['test/fast.unit.test.mjs'], ['test/integration.test.mjs'], ['test/fast.unit.test.mjs', 'test/integration.test.mjs']]) {
    const calls = []
    assert.equal(runCiBatch({ root, env: { PRUMO_CI_TEST_FILES: JSON.stringify(files), PRUMO_TEST_PARTITIONED: '1' },
      run(executable, args, options) { calls.push({ args, options }); return { status: 0 } } }), 0)
    assert.deepEqual(calls.flatMap(call => call.args.filter(arg => files.includes(arg))).sort(), [...files].sort())
    assert.equal(calls[0].args.includes('--clean=false'), false)
    if (calls.length > 1) assert.equal(calls[1].args.includes('--clean=false'), true)
    assert.ok(calls.every(call => call.args.includes('--check-coverage=false')))
  }
})

test('lote regular preserva falha e recusa selecao malformada antes de preparar cobertura', t => {
  const root = fixture(t)
  for (const raw of [undefined, '{', '{}', '[]', '[1]', '["test/fast.unit.test.mjs","test/fast.unit.test.mjs"]', '["../outside.test.mjs"]', '["test/upgrade-from-previous.test.mjs"]']) {
    assert.throws(() => runCiBatch({ root, env: { PRUMO_CI_TEST_FILES: raw }, run() { assert.fail('Nao deve iniciar processo') } }), /Lote regular/)
    assert.equal(existsSync(join(root, '.test-output')), false)
  }
  assert.equal(runCiBatch({ root, env: { PRUMO_CI_TEST_FILES: '["test/integration.test.mjs"]' }, run() { return { status: 7 } } }), 7)
})

test('grupos historicos preservam selecao por lote e recusam versoes inexistentes ou repetidas', () => {
  const versions = { '1.0.0': {}, '2.0.0': {}, '2.1.0': {}, '3.0.0': {} }
  assert.deepEqual(publishedSelection(versions).map(([name]) => name), Object.keys(versions))
  assert.deepEqual(publishedSelection(versions, { PRUMO_TEST_PUBLISHED_SHARD_INDEX: '1', PRUMO_TEST_PUBLISHED_SHARD_COUNT: '2' }).map(([name]) => name), ['2.0.0', '3.0.0'])
  assert.deepEqual(publishedSelection(versions, { PRUMO_CI_PUBLISHED_VERSIONS: '["3.0.0","1.0.0"]' }).map(([name]) => name), ['1.0.0', '3.0.0'])
  for (const raw of ['{', '{}', '[]', '[1]', '["missing"]', '["1.0.0","1.0.0"]'])
    assert.throws(() => publishedSelection(versions, { PRUMO_CI_PUBLISHED_VERSIONS: raw }), /Selecao/)
})
