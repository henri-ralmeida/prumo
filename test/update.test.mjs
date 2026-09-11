import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { planInstall, applyInstall, discoverInstallations } from '../lib/install.mjs'
import { globalCliState, isGlobalCli, npmProcess, updateRequest } from '../lib/update.mjs'
import { inside } from '../scripts/storage.mjs'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(path, 'utf8')
const version = JSON.parse(read(join(source, 'package.json'))).version
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }

test('update detects installed harnesses and custom paths, preserves preferences, previews and skips legacy-only environments', t => {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, 'prumo-update-test-'))
  t.after(() => { assert.equal(dirname(home), base); assert.ok(home.startsWith(join(base, 'prumo-update-test-'))); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const cwd = join(home, 'project')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  const customCodex = join(home, 'custom-codex')
  put(join(home, '.claude', 'settings.json'), { theme: 'dark' })
  put(join(customCodex, 'AGENTS.md'), 'Keep this user instruction.\n')
  const legacy = join(home, '.kiro', 'skills', 'graph-foreman', 'SKILL.md')
  put(legacy, 'Keep the active legacy installation.')
  for (const harness of ['claude', 'codex']) {
    const plan = planInstall({ harness, home, cwd, env: { CODEX_HOME: customCodex }, lang: harness === 'claude' ? 'pt-BR' : 'en' })
    for (const item of plan.groups.flatMap(group => group.changes)) assert.ok(inside(home, item.file))
    assert.ok(applyInstall(plan).groups.every(group => group.status !== 'conflict'))
  }
  const projectSkill = join(cwd, '.claude', 'skills', 'prumo')
  cpSync(join(home, '.claude', 'skills', 'prumo'), projectSkill, { recursive: true })
  const projectMarker = join(projectSkill, '.prumo-install.json')
  put(projectMarker, { ...JSON.parse(read(projectMarker)), lang: 'en' })
  const installed = discoverInstallations({ home, cwd, env: {} })
  assert.deepEqual(installed.map(entry => entry.harness).sort(), ['claude', 'codex'])
  assert.equal(installed.find(entry => entry.harness === 'codex').config, customCodex)
  const markers = installed.flatMap(entry => entry.roots.map(root => join(root, 'prumo', '.prumo-install.json')))
  for (const marker of markers) { const value = JSON.parse(read(marker)); value.version = '0.0.9'; put(marker, value); put(join(dirname(marker), 'scripts', 'engine.mjs'), '// older installed engine\n') }
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PRUMO_HOME: join(home, 'data'), PRUMO_LANG: 'en' }
  delete env.GRAPH_ROOT; delete env.PRUMO_ROOT; delete env.GRAPH_FOREMAN_HOME
  const run = dryRun => spawnSync(process.execPath, [join(source, 'bin', 'prumo.mjs'), '_update'], { cwd, env: { ...env, PRUMO_UPDATE_REQUEST: JSON.stringify({ dryRun, cwd, projects: [], updateCli: false }) }, encoding: 'utf8', timeout: 120000, windowsHide: true })
  const before = markers.map(read)
  const preview = run(true)
  assert.equal(preview.status, 0, preview.stdout + preview.stderr)
  assert.deepEqual(markers.map(read), before)
  const updated = run(false)
  assert.equal(updated.status, 0, updated.stdout + updated.stderr)
  assert.match(updated.stdout, /Prumo updated successfully/)
  assert.match(updated.stdout, /Fixed/)
  assert.match(updated.stdout, /- Safe retry after approved contract changes/)
  for (const marker of markers) {
    assert.equal(JSON.parse(read(marker)).version, version)
    assert.equal(read(join(dirname(marker), 'scripts', 'engine.mjs')), read(join(source, 'scripts', 'engine.mjs')))
  }
  assert.deepEqual(markers.map(marker => JSON.parse(read(marker)).lang), ['pt-BR', 'en', 'en'])
  assert.equal(JSON.parse(read(join(home, '.claude', 'settings.json'))).theme, 'dark')
  assert.match(read(join(customCodex, 'AGENTS.md')), /Keep this user instruction/)
  assert.equal(existsSync(join(home, '.codex', 'AGENTS.md')), false)
  assert.equal(read(legacy), 'Keep the active legacy installation.')
  assert.equal(existsSync(join(home, '.kiro', 'skills', 'prumo')), false)
  const backups = join(home, '.local', 'share', 'prumo', 'backups')
  const count = readdirSync(backups).length
  const repeated = run(false)
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr)
  assert.equal(readdirSync(backups).length, count)
  put(join(home, '.local', 'share', 'prumo', 'installations.json'), '{broken')
  assert.throws(() => discoverInstallations({ home, cwd, env: {} }))
})

test('update rejects malformed requests before applying installations', () => {
  for (const value of [undefined, '{}', 'null', JSON.stringify({ dryRun: true, cwd: '.', projects: [] }), JSON.stringify({ dryRun: true, cwd: source, projects: [], lang: 'invalid' })]) assert.throws(() => updateRequest(value))
  assert.equal(updateRequest(JSON.stringify({ dryRun: false, cwd: source, projects: [] })).updateCli, true, 'legacy callers update the global CLI')
  assert.equal(updateRequest(JSON.stringify({ dryRun: false, cwd: source, projects: [], updateCli: false })).updateCli, false)
  assert.equal(isGlobalCli(join(source, 'package'), { platform: 'linux', run: () => ({ status: 0, stdout: source }) }), true)
  assert.equal(isGlobalCli(source, { platform: 'linux', run: () => ({ status: 0, stdout: join(source, 'elsewhere') }) }), false)
  const windows = npmProcess(['root', '--global'], { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } })
  assert.equal(windows.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(windows.args, ['/d', '/s', '/c', 'npm', 'root', '--global'])
  let options
  const state = globalCliState(source, {
    platform: 'win32', env: { ComSpec: 'cmd.exe' },
    run(command, args, received) { options = received; assert.equal(command, 'cmd.exe'); assert.deepEqual(args, ['/d', '/s', '/c', 'npm', 'root', '--global']); return { status: 0, stdout: source } },
    read: () => JSON.stringify({ version: '1.0.7' }),
  })
  assert.equal(options.shell, undefined, 'npm must not receive shell:true')
  assert.deepEqual(state, { running: false, version: '1.0.7' })
})
