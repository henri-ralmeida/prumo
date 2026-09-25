import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installationBundle, packageIdentity } from '../scripts/installation-bundle.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version

function workspace(t) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-identity-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const root = join(home, 'workspace')
  mkdirSync(root)
  const planPath = join(root, 'plan.json')
  writeFileSync(planPath, JSON.stringify({ name: 'identity', planningMode: 'task', tasks: [
    { id: 'T1', title: 'Delivery', validation: [{ kind: 'functional', run: 'node -e 0', expect: 'the check passes' }] }] }))
  const env = { ...process.env, PRUMO_HOME: home, PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  const run = (engine, ...args) => {
    const result = spawnSync(process.execPath, [engine, ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000, windowsHide: true })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }
  return { home, planPath, run }
}

function install(home, marker) {
  const skill = join(home, 'skills', 'prumo')
  for (const [name, bytes] of installationBundle('en')) {
    mkdirSync(dirname(join(skill, name)), { recursive: true })
    writeFileSync(join(skill, name), bytes)
  }
  writeFileSync(join(skill, '.prumo-install.json'), JSON.stringify(marker))
  return join(skill, 'scripts', 'engine.mjs')
}

test('status starts by identifying a source checkout with its computed content ID', t => {
  const w = workspace(t)
  const engine = join(packageRoot, 'scripts', 'engine.mjs')
  w.run(engine, 'init', '--plan', w.planPath, '--run', 'identity-01')
  const first = w.run(engine, 'status').split(/\r?\n/)[0]
  assert.equal(first, `[prumo] Prumo ${version} (${packageIdentity('en').contentId}) — source checkout without an installation marker; harness not recorded`)
})

test('status reads version, content ID and harness from the installation marker and warns on a changed engine', t => {
  const w = workspace(t)
  const identity = packageIdentity('en')
  const engine = install(w.home, { product: 'prumo', version, harness: 'dsh', lang: 'en', ...identity })
  w.run(engine, 'init', '--plan', w.planPath, '--run', 'identity-01')
  const clean = w.run(engine, 'status', '--verify-install')
  const lines = clean.split(/\r?\n/)
  assert.equal(lines[0], `[prumo] Prumo ${version} (${identity.contentId}) — dsh`)
  assert.equal(lines[1], `[prumo] installed files match the installation marker (${identity.contentId})`)
  assert.doesNotMatch(clean, /WARNING/)

  appendFileSync(engine, '\n// local edit\n')
  const changed = w.run(engine, 'status', '--verify-install')
  assert.match(changed, /WARNING: the running engine\.mjs differs from the installation marker/)
  assert.match(changed, /run prumo status --verify-install, then prumo update/)
  assert.match(changed, new RegExp(`WARNING: installed files differ from the installation marker \\(marker ${identity.contentId}, files [0-9a-f]{12}\\)`))
})

test('status keeps old markers readable and asks for an update when the content ID is missing', t => {
  const w = workspace(t)
  const engine = install(w.home, { product: 'prumo', version: '1.3.17', harness: 'claude', lang: 'en' })
  w.run(engine, 'init', '--plan', w.planPath, '--run', 'identity-01')
  const output = w.run(engine, 'status')
  assert.equal(output.split(/\r?\n/)[0], '[prumo] Prumo 1.3.17 (content identifier missing — run prumo update) — claude')
  assert.doesNotMatch(output, /engine\.mjs differs/)
})
