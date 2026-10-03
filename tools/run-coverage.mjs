import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runCoverageCommand } from './coverage.mjs'

export function runCoverage({ collect = false, root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), env = process.env, run = spawnSync } = {}) {
  const concurrency = Number(env.PRUMO_TEST_CONCURRENCY ?? 1)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Concorrencia de cobertura deve ser de 1 a 4')
  runCoverageCommand('manifest', undefined, root)
  const preload = pathToFileURL(join(root, 'test/fixtures/coverage-flush.mjs')).href
  const result = run(process.execPath, [join(root, 'node_modules/c8/bin/c8.js'),
    ...(collect ? ['--check-coverage=false'] : []), process.execPath, '--test', `--test-concurrency=${concurrency}`,
    'scripts/*.test.mjs', 'test/*.test.mjs'], {
    cwd: root, windowsHide: true, stdio: 'inherit',
    env: { ...env, PRUMO_TEST_COVERAGE_FLUSH: '1', NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import="${preload}"`.trim() },
  })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`Coleta de cobertura interrompida: ${result.signal}`)
  return result.status ?? 1
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  process.exitCode = runCoverage({ collect: process.argv.includes('--collect') })
