// Cada item pertence a um unico runner; a uniao dos lotes preserva a suite completa.
export function shardConfig(env = {}, prefix = 'PRUMO_TEST_SHARD') {
  const index = env[`${prefix}_INDEX`] ?? '0', count = env[`${prefix}_COUNT`] ?? '1'
  if (!/^\d+$/.test(index) || !/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 4 || Number(index) >= Number(count))
    throw new Error('Lote de CI invalido: indice deve estar entre zero e quantidade menos um; quantidade de 1 a 4')
  return { index: Number(index), count: Number(count) }
}

export function selectShard(items, { index, count }) {
  shardConfig({ PRUMO_TEST_SHARD_INDEX: String(index), PRUMO_TEST_SHARD_COUNT: String(count) })
  return items.filter((_, position) => position % count === index)
}

export function selectBalancedShard(items, shard, weight) {
  selectShard([], shard)
  const batches = Array.from({ length: shard.count }, () => ({ load: 0, items: [] }))
  for (const item of [...items].sort((a, b) => weight(b) - weight(a))) {
    const batch = batches.reduce((best, next) => next.load < best.load ? next : best)
    batch.items.push(item)
    batch.load += weight(item)
  }
  return batches[shard.index].items
}
