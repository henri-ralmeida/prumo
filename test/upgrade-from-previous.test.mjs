import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { downloadPublishedFile } from './fixtures/published-download.mjs'
import { publishedSelection } from './fixtures/ci-published-selection.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const smoke = join(repo, 'scripts/published-update-smoke.mjs')
// O registro fornece os tarballs publicados; tags Git não representam instalações disponíveis no npm.
// Cada versão executa vários comandos; o prazo por cenário evita interromper uma atualização válida em runners lentos.
const workers = process.platform === 'win32' ? 1 : 2
const publishedMetadata = JSON.parse((await downloadPublishedFile('https://registry.npmjs.org/@henri-ralmeida%2fprumo')).toString('utf8'))
const publishedMatrixTimeout = Math.ceil(publishedSelection(publishedMetadata.versions, process.env).length / workers) * 180000 + 120000

test('versões publicadas no npm atualizam para o candidato e preservam seus dados', { timeout: publishedMatrixTimeout }, async () => {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [smoke], {
      cwd: repo, env: { ...process.env }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], timeout: publishedMatrixTimeout - 1000,
    })
    let output = ''
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { output += value })
    child.once('error', reject)
    child.once('close', (status, signal) => resolveResult({ status, signal, output }))
  })
  assert.equal(result.status, 0, result.output + (result.signal ? '\nInterrompido por ' + result.signal : ''))
  process.stdout.write(result.output)
})
