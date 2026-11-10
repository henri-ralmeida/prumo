import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharedCandidate } from './ci-candidate.mjs'

export function runCiPublished({ root = process.cwd(), env = process.env, run = spawnSync } = {}) {
  if (!sharedCandidate(root, env)) throw new Error('O job histórico exige o candidato da preparação')
  const childEnv = { ...env, PRUMO_TEST_SUITE: 'published' }
  // A compatibilidade histórica valida atualizações reais; a suíte regular mede cobertura.
  delete childEnv.NODE_V8_COVERAGE
  delete childEnv.PRUMO_TEST_COVERAGE_FLUSH
  const result = run(process.execPath, ['--test', '--test-concurrency=1', 'test/upgrade-from-previous.test.mjs'],
    { cwd: root, env: childEnv, windowsHide: true, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`Verificação histórica interrompida: ${result.signal}`)
  return result.status ?? 1
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = runCiPublished()
