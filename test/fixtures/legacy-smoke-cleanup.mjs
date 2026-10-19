import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'

export async function removeLegacySmokeHome(home) {
  assert.equal(dirname(home), realpathSync(tmpdir()))
  assert.ok(basename(home).startsWith('prumo-legacy-smoke-'))
  // A remocao assincrona relista arquivos tardios; erros persistentes continuam recusados.
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
