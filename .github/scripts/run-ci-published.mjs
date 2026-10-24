import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCoverage } from '../../tools/run-coverage.mjs'
import { sharedCandidate } from './ci-candidate.mjs'

export function runCiPublished({ root = process.cwd(), env = process.env, run = spawnSync } = {}) {
  if (!sharedCandidate(root, env)) throw new Error('O job histórico exige o candidato da preparação')
  return runCoverage({ root, collect: true, env: { ...env, PRUMO_TEST_SUITE: 'published' },
    run(executable, args, options) {
      return run(executable, [args[0], '--reporter=json', '--reporter=json-summary', ...args.slice(1)], options)
    } })
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = runCiPublished()
