import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runCoverageCommand } from './coverage.mjs'

// Estes testes de dashboard usam calculos e DOM simulado, sem iniciar servidores ou instalar pacotes.
const independentDashboardTests = new Set(['test/dashboard-planning.test.mjs', 'test/dashboard-gains.test.mjs', 'test/dashboard-diagnostics.test.mjs'])

export function coverageBatches(root, concurrency, partitioned) {
  if (!partitioned) return [{ files: ['scripts/*.test.mjs', 'test/*.test.mjs'], concurrency }]
  const independent = [], integrations = []
  for (const directory of ['scripts', 'test']) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.test.mjs')) continue
      const file = `${directory}/${entry.name}`
      ;(entry.name.endsWith('.unit.test.mjs') || independentDashboardTests.has(file) ? independent : integrations).push(file)
    }
  }
  if (!independent.length && !integrations.length) throw new Error('Nenhum teste encontrado para a coleta')
  const batches = []
  if (independent.length) batches.push({ files: independent.sort(), concurrency: 4 })
  if (integrations.length) batches.push({ files: integrations.sort(), concurrency: 1 })
  return batches
}

export function runCoverage({ collect = false, root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), env = process.env, run = spawnSync } = {}) {
  const concurrency = Number(env.PRUMO_TEST_CONCURRENCY ?? 1)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Concorrencia de cobertura deve ser de 1 a 4')
  const partitioned = env.PRUMO_TEST_PARTITIONED ?? '0'
  if (!['0', '1'].includes(partitioned)) throw new Error('Particionamento de cobertura deve ser 0 ou 1')
  const batches = coverageBatches(root, concurrency, partitioned === '1')
  runCoverageCommand('manifest', undefined, root)
  const preload = pathToFileURL(join(root, 'test/fixtures/coverage-flush.mjs')).href
  let status = 0
  for (const [index, batch] of batches.entries()) {
    // O segundo lote reaproveita os dados do primeiro; o limite vale sobre a suite completa.
    const result = run(process.execPath, [join(root, 'node_modules/c8/bin/c8.js'),
      ...(index > 0 ? ['--clean=false'] : []),
      ...(collect || index < batches.length - 1 ? ['--check-coverage=false'] : []),
      process.execPath, '--test', `--test-concurrency=${batch.concurrency}`, ...batch.files], {
      cwd: root, windowsHide: true, stdio: 'inherit',
      env: { ...env, PRUMO_TEST_COVERAGE_FLUSH: '1', NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import="${preload}"`.trim() },
    })
    if (result.error) throw result.error
    if (result.signal) throw new Error(`Coleta de cobertura interrompida: ${result.signal}`)
    status ||= result.status ?? 1
  }
  return status
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  process.exitCode = runCoverage({ collect: process.argv.includes('--collect') })
