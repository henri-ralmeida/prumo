import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Query npm instead of keeping a hand-picked list that misses published releases.
const directory = new URL('../.test-output/npm-versions/', import.meta.url)
mkdirSync(directory, { recursive: true })
const response = await fetch('https://registry.npmjs.org/@henri-ralmeida%2fprumo')
assert.equal(response.status, 200)
const metadata = await response.json()
const results = []
async function checkVersion([version, pkg]) {
  const response = await fetch(pkg.dist.tarball)
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  const [algorithm, expected] = pkg.dist.integrity.split('-')
  assert.equal(createHash(algorithm).update(bytes).digest('base64'), expected)
  const archive = new URL(`${version}.tgz`, directory)
  writeFileSync(archive, bytes)
  const child = spawn(process.execPath, [fileURLToPath(new URL('./legacy-update-smoke.mjs', import.meta.url)), version, fileURLToPath(archive)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, PRUMO_TEST_PUBLISHED_VERSIONS: JSON.stringify(Object.keys(metadata.versions)) },
  })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  results.push({ version, status, output })
  writeFileSync(new URL('../published-update-results.json', directory), JSON.stringify(results, null, 2))
  console.log(`${version}: ${status === 0 ? 'PASS' : 'FAIL'}${status ? `\n${output}` : ''}`)
}
const pending = Object.entries(metadata.versions)
await Promise.all(Array.from({ length: 3 }, async () => {
  while (pending.length) await checkVersion(pending.shift())
}))
assert.ok(results.length > 0)
assert.ok(results.every(result => result.status === 0), 'See .test-output/published-update-results.json')
console.log(`All ${results.length} npm releases upgraded successfully`)
