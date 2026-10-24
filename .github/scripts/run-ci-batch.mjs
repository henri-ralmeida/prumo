import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverageBatches, runCoverage } from '../../tools/run-coverage.mjs'

// Cada job executa somente seus arquivos aprovados na matriz; a uniao e conferida no planejamento do CI.
export function runCiBatch({ root = process.cwd(), env = process.env, run = spawnSync } = {}) {
  let files
  try { files = JSON.parse(env.PRUMO_CI_TEST_FILES) } catch { throw new Error('Lote regular exige uma lista JSON de arquivos') }
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string') || new Set(files).size !== files.length)
    throw new Error('Lote regular exige arquivos unicos e ao menos um teste')
  const inventory = new Set(coverageBatches(root, 1, true, 'regular').flatMap(batch => batch.files))
  if (files.some(file => !inventory.has(file))) throw new Error('Lote regular contem arquivo fora do inventario aprovado')
  const selection = new Set(files)
  const visited = new Set()
  let executed = false
  const status = runCoverage({ root, collect: true, env: { ...env, PRUMO_TEST_SUITE: 'regular',
    PRUMO_TEST_SHARD_INDEX: '0', PRUMO_TEST_SHARD_COUNT: '1' },
  run(executable, args, options) {
    const firstFile = args.findIndex(arg => arg.startsWith('scripts/') || arg.startsWith('test/'))
    const selected = args.slice(firstFile).filter(file => selection.has(file))
    if (!selected.length) return { status: 0 }
    for (const file of selected) visited.add(file)
    const command = args.slice(0, firstFile).filter(arg => executed || arg !== '--clean=false').concat(selected)
    executed = true
    return run(executable, command, options)
  } })
  if (files.some(file => !visited.has(file))) throw new Error('Lote regular nao executou todos os arquivos selecionados')
  return status
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = runCiBatch()
