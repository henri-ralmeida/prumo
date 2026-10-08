import test from 'node:test'
import assert from 'node:assert/strict'
import { shardConfig, selectShard, selectBalancedShard } from '../tools/ci-shards.mjs'

test('duracoes medidas equilibram arquivos pesados sem eliminar arquivos novos', () => {
  const weights = { a: 100, b: 80, c: 20, d: 10 }
  const items = ['a', 'b', 'c', 'd', 'novo']
  const batches = [0, 1].map(index => selectBalancedShard(items, { index, count: 2 }, item => weights[item] ?? 10))
  assert.deepEqual(batches.flat().sort(), items.sort())
  assert.deepEqual(batches.map(batch => batch.reduce((total, item) => total + (weights[item] ?? 10), 0)), [110, 110])
  assert.deepEqual(selectBalancedShard([], { index: 0, count: 1 }, () => 1), [])
})

test('lotes preservam todos os cenarios uma vez mesmo com quantidade impar', () => {
  assert.deepEqual(shardConfig(), { index: 0, count: 1 })
  const versions = Array.from({ length: 33 }, (_, index) => `versao-${index}`)
  assert.deepEqual(selectShard(versions, shardConfig()), versions)
  for (const count of [2, 3, 4]) {
    const batches = Array.from({ length: count }, (_, index) => selectShard(versions, { index, count }))
    assert.deepEqual(batches.flat().sort(), [...versions].sort())
    assert.equal(new Set(batches.flat()).size, versions.length)
    assert.ok(Math.max(...batches.map(batch => batch.length)) - Math.min(...batches.map(batch => batch.length)) <= 1)
  }
  assert.deepEqual(shardConfig({ HISTORY_INDEX: '1', HISTORY_COUNT: '2' }, 'HISTORY'), { index: 1, count: 2 })
})

test('configuracao malformada recusa lotes que omitiriam cenarios', () => {
  for (const [index, count] of [['-1', '2'], ['x', '2'], ['0', 'x'], ['0', '0'], ['0', '5'], ['2', '2'], ['1.5', '2'], ['0', '1.5']])
    assert.throws(() => shardConfig({ PRUMO_TEST_SHARD_INDEX: index, PRUMO_TEST_SHARD_COUNT: count }), /invalido/)
  assert.throws(() => selectShard(['cenario'], { index: 2, count: 2 }), /invalido/)
})
