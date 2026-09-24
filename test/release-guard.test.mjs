import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertReleaseContentVersion } from '../scripts/release-guard.mjs'
import { packageDistributionFiles } from '../scripts/package-content.mjs'
import { npmProcess } from '../lib/update.mjs'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('release guard requires a version bump when distributed bytes change', () => {
  const baseline = { version: '1.3.17', files: { 'lib/install.mjs': 'a'.repeat(64), 'package.json': 'b'.repeat(64) } }
  assert.doesNotThrow(() => assertReleaseContentVersion('1.3.17', baseline, baseline.files))
  assert.throws(() => assertReleaseContentVersion('1.3.17', baseline, {
    ...baseline.files,
    'lib/install.mjs': 'c'.repeat(64),
  }), /content changed without a version bump from 1\.3\.17: lib\/install\.mjs/)
  assert.doesNotThrow(() => assertReleaseContentVersion('2.0.0', baseline, {
    ...baseline.files,
    'lib/install.mjs': 'c'.repeat(64),
  }))
})

test('npm prepack rejects changed distributed bytes at the baseline version', t => {
  const base = tmpdir()
  const temporary = mkdtempSync(join(base, 'prumo-release-guard-'))
  t.after(() => {
    assert.equal(dirname(temporary), base)
    assert.ok(temporary.startsWith(join(base, 'prumo-release-guard-')))
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  for (const name of packageDistributionFiles(source)) {
    const destination = join(temporary, name)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(source, name), destination)
  }
  const baselinePath = join(source, 'scripts', 'release-baseline.json')
  const stagedBaseline = join(temporary, 'scripts', 'release-baseline.json')
  copyFileSync(baselinePath, stagedBaseline)
  const packageJsonPath = join(temporary, 'package.json')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  packageJson.version = '1.3.16'
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n')
  const changedFile = join(temporary, 'lib', 'install.mjs')
  writeFileSync(changedFile, `${readFileSync(changedFile, 'utf8')}\n// release guard counterexample\n`)

  const npm = npmProcess(['pack', '--no-audit', '--no-fund', '--json'])
  const result = spawnSync(npm.command, npm.args, { cwd: temporary, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.ifError(result.error)
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout + result.stderr, /Distributed package content changed without a version bump from 1\.3\.16/)
})
