import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { downloadPublishedFile } from '../test/fixtures/published-download.mjs'
import { shardConfig, selectShard } from '../tools/ci-shards.mjs'

// Consulte o npm para não manter uma lista manual que deixe versões publicadas de fora.
const directory = new URL('../.test-output/npm-versions/', import.meta.url)
mkdirSync(directory, { recursive: true })
const repo = fileURLToPath(new URL('../', import.meta.url))
const packageVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
const shard = shardConfig(process.env, 'PRUMO_TEST_PUBLISHED_SHARD')
const resultsPath = new URL(`../published-update-results${shard.count > 1 ? `-${shard.index}` : ''}.json`, directory)
const candidateDirectory = mkdtempSync(join(tmpdir(), 'prumo-published-candidate-'))
try {
const npm = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', 'pack', '--ignore-scripts', '--pack-destination', candidateDirectory, '--loglevel=error']]
  : ['npm', ['pack', '--ignore-scripts', '--pack-destination', candidateDirectory, '--loglevel=error']]
const packed = spawnSync(...npm, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120000 })
assert.ifError(packed.error)
assert.equal(packed.status, 0, packed.stdout + packed.stderr)
const candidates = readdirSync(candidateDirectory).filter(file => file.endsWith('.tgz'))
assert.deepEqual(candidates, [`henri-ralmeida-prumo-${packageVersion}.tgz`])
const candidate = resolve(candidateDirectory, candidates[0])
const candidateSha256 = createHash('sha256').update(readFileSync(candidate)).digest('hex')
const metadata = JSON.parse((await downloadPublishedFile('https://registry.npmjs.org/@henri-ralmeida%2fprumo')).toString('utf8'))
const results = []
async function checkVersion([version, pkg]) {
  const bytes = await downloadPublishedFile(pkg.dist.tarball)
  const [algorithm, expected] = pkg.dist.integrity.split('-')
  assert.equal(createHash(algorithm).update(bytes).digest('base64'), expected)
  const archive = new URL(`${version}.tgz`, directory)
  writeFileSync(archive, bytes)
  const child = spawn(process.execPath, [fileURLToPath(new URL('./legacy-update-smoke.mjs', import.meta.url)), version, fileURLToPath(archive)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, PRUMO_CANDIDATE_ARCHIVE: candidate,
      PRUMO_TEST_PUBLISHED_VERSIONS: JSON.stringify(Object.keys(metadata.versions)) },
  })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  results.push({ version, status, candidateVersion: packageVersion, candidateSha256, output })
  writeFileSync(resultsPath, JSON.stringify(results, null, 2))
  console.log(`${version}: ${status === 0 ? 'PASS' : 'FAIL'}${status ? `\n${output}` : ''}`)
}
const selected = selectShard(Object.entries(metadata.versions).sort(([a], [b]) => a.localeCompare(b, 'en')), shard)
const pending = [...selected]
writeFileSync(new URL(`../published-update-selection-${shard.index}.json`, directory), JSON.stringify({ shard, all: Object.keys(metadata.versions).sort(), selected: selected.map(([version]) => version) }, null, 2))
// As versões antigas consultam processos via PowerShell; serializar no Windows evita disputar a inicialização do dashboard.
const workers = process.platform === 'win32' ? 1 : 2
await Promise.all(Array.from({ length: workers }, async () => {
  while (pending.length) await checkVersion(pending.shift())
}))
assert.ok(results.length > 0)
assert.deepEqual(results.map(result => result.version).sort(), selected.map(([version]) => version).sort())
assert.ok(results.every(result => result.status === 0), `See ${fileURLToPath(resultsPath)}`)
console.log(`All ${results.length} selected npm releases upgraded successfully (shard ${shard.index + 1}/${shard.count})`)
} finally {
  assert.equal(dirname(realpathSync(candidateDirectory)), realpathSync(tmpdir()))
  assert.ok(basename(candidateDirectory).startsWith('prumo-published-candidate-'))
  rmSync(candidateDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
