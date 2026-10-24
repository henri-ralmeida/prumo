import { shardConfig, selectShard } from '../../tools/ci-shards.mjs'

export function publishedSelection(versions, env = {}) {
  let entries = Object.entries(versions).sort(([a], [b]) => a.localeCompare(b, 'en'))
  const raw = env.PRUMO_CI_PUBLISHED_VERSIONS
  if (raw !== undefined) {
    let names
    try { names = JSON.parse(raw) } catch { throw new Error('Selecao de versoes publicadas deve ser uma lista JSON') }
    if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string') || new Set(names).size !== names.length)
      throw new Error('Selecao de versoes publicadas exige nomes unicos e ao menos uma versao')
    if (names.some(name => !Object.hasOwn(versions, name))) throw new Error('Selecao contem versao ausente do registro npm')
    const selected = new Set(names)
    entries = entries.filter(([name]) => selected.has(name))
  }
  return selectShard(entries, shardConfig(env, 'PRUMO_TEST_PUBLISHED_SHARD'))
}
