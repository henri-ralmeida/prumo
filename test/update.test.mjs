import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { planInstall, applyInstall, discoverInstallations } from '../lib/install.mjs'
import { assertUpdateVersion, globalCliState, installationsCurrent, isGlobalCli, launchUpdate, npmLatestVersion, npmProcess, reconcileDashboardUpdate, updateRequest } from '../lib/update.mjs'
import { inside } from '../scripts/storage.mjs'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(path, 'utf8')
const version = JSON.parse(read(join(source, 'package.json'))).version
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }

test('update exits before npm only when Claude, Kiro, Codex and DSH are all already latest', async t => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'prumo-current-test-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const installations = ['claude', 'kiro', 'codex', 'dsh'].map(harness => {
    const root = join(home, harness, 'skills')
    put(join(root, 'prumo', '.prumo-install.json'), { product: 'prumo', harness, version })
    return { harness, roots: [root] }
  })
  let launched = 0
  let reported
  const request = { dryRun: false, cwd: home, projects: [], updateCli: true, sourceVersion: version, globalVersion: version }
  const current = await launchUpdate(request, {
    discover: () => installations, latestVersion: () => version,
    onCurrent: value => { reported = value }, run: () => { throw new Error('npm must not run') }, filesCurrent: () => true,
    status: async () => ({ enabled: true, process: 'running', registered: true, version }),
  })
  assert.equal(current, 0)
  assert.equal(reported, version)
  assert.equal(installationsCurrent(installations, version, { filesCurrent: () => true }), true)

  const runUpdater = () => {
    launched++
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0, null))
    return child
  }
  await launchUpdate({ ...request, globalVersion: '0.0.9' }, {
    discover: () => installations, latestVersion: () => version, run: runUpdater,
  })
  assert.equal(launched, 1, 'an older global CLI must still launch the updater')

  put(join(home, 'dsh', 'skills', 'prumo', '.prumo-install.json'), { product: 'prumo', harness: 'dsh', version: '0.0.9' })
  const stale = await launchUpdate(request, {
    discover: () => installations, latestVersion: () => version,
    run: runUpdater,
  })
  assert.equal(stale, 0)
  assert.equal(launched, 2, 'one stale harness must still launch the updater')

  await launchUpdate({ ...request, pendingUpdate: true }, {
    discover: () => installations, latestVersion: () => version, run: runUpdater, filesCurrent: () => true,
  })
  assert.equal(launched, 3, 'a pending checkpoint must prevent the current-version shortcut')
})

test('update na versão atual recupera dashboard parado e respeita prévia e desativação', async t => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'prumo-dashboard-current-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'skills')
  put(join(root, 'prumo/.prumo-install.json'), { product: 'prumo', harness: 'claude', version })
  const request = { dryRun: false, cwd: home, projects: [], sourceVersion: version, globalVersion: version }
  let repairs = 0, current = 0
  const notices = []
  const deps = {
    discover: () => [{ harness: 'claude', roots: [root] }], latestVersion: () => version,
    filesCurrent: () => true, run: () => assert.fail('Não deve baixar ou reescrever o pacote atual'),
    status: async () => ({ enabled: true, process: 'stopped', registered: true, version }),
    repair: async () => { repairs++; return { ok: true, process: 'running' } },
    onCurrent: () => { current++ }, onDashboardRepair: preview => notices.push(preview),
  }
  assert.equal(await launchUpdate(request, deps), 0)
  assert.equal(repairs, 1)
  assert.equal(current, 1)
  assert.deepEqual(notices, [false])
  await launchUpdate({ ...request, dryRun: true }, deps)
  assert.equal(repairs, 1)
  assert.deepEqual(notices, [false, true])
  await launchUpdate(request, { ...deps, status: async () => ({ enabled: false, disabled: true, process: 'stopped' }) })
  assert.equal(repairs, 1)
  await assert.rejects(launchUpdate(request, { ...deps, repair: async () => ({ ok: false, error: 'port conflict' }) }), /Dashboard restart failed: port conflict/)
  assert.equal(current, 2, 'Não informar sucesso quando o reparo falha')
})

test('update recusa downgrade da CLI global mesmo iniciado por uma versão local antiga', async () => {
  let launched = false
  await assert.rejects(launchUpdate({ dryRun: false, cwd: source, projects: [], updateCli: true,
    sourceVersion: '1.3.14', globalVersion: '1.3.15' }, {
    discover: () => [], latestVersion: () => '1.3.14',
    run: () => { launched = true; throw new Error('updater iniciado indevidamente') },
  }), /Installed Prumo 1\.3\.15 is newer than npm latest 1\.3\.14/)
  assert.equal(launched, false)
})

test('update does not treat an empty discovery or an absent global CLI as current', async t => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'prumo-current-boundary-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const root = join(home, 'claude', 'skills')
  put(join(root, 'prumo', '.prumo-install.json'), { product: 'prumo', harness: 'claude', version })
  const installations = [{ harness: 'claude', roots: [root] }]
  let launched = 0
  let current = 0
  const runUpdater = () => {
    launched++
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0, null))
    return child
  }
  const request = { dryRun: false, cwd: home, projects: [], updateCli: true, sourceVersion: version }
  assert.equal(await launchUpdate({ ...request, globalVersion: version }, {
    discover: () => [], latestVersion: () => version, run: runUpdater, onCurrent: () => { current++ },
  }), 0)
  assert.equal(launched, 1, 'an empty discovery must not satisfy every()')
  assert.equal(current, 0)
  assert.equal(await launchUpdate({ ...request, globalVersion: null }, {
    discover: () => installations, latestVersion: () => version, run: runUpdater, onCurrent: () => { current++ },
  }), 0)
  assert.equal(launched, 2, 'null means that the global CLI is absent, not current')
  assert.equal(current, 0)
})

test('update detects installed harnesses and custom paths, preserves preferences, previews and skips legacy-only environments', t => {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, 'prumo-update-test-'))
  t.after(() => { assert.equal(dirname(home), base); assert.ok(home.startsWith(join(base, 'prumo-update-test-'))); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const cwd = join(home, 'project')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  const customCodex = join(home, 'custom-codex')
  const customDsh = join(home, 'custom-dsh')
  put(join(home, '.claude', 'settings.json'), { theme: 'dark' })
  put(join(customCodex, 'AGENTS.md'), 'Keep this user instruction.\n')
  put(join(customDsh, 'AGENTS.md'), 'Keep this DSH user instruction.\n')
  const legacy = join(home, '.kiro', 'skills', 'graph-foreman', 'SKILL.md')
  put(legacy, 'Keep the active legacy installation.')
  for (const harness of ['claude', 'codex', 'dsh']) {
    const plan = planInstall({ harness, home, cwd, env: { CODEX_HOME: customCodex, DSH_HOME: customDsh }, lang: harness === 'codex' ? 'en' : 'pt-BR' })
    for (const item of plan.groups.flatMap(group => group.changes)) assert.ok(inside(home, item.file))
    assert.ok(applyInstall(plan).groups.every(group => group.status !== 'conflict'))
  }
  const projectSkill = join(cwd, '.claude', 'skills', 'prumo')
  cpSync(join(home, '.claude', 'skills', 'prumo'), projectSkill, { recursive: true })
  const projectMarker = join(projectSkill, '.prumo-install.json')
  put(projectMarker, { ...JSON.parse(read(projectMarker)), lang: 'en' })
  const installed = discoverInstallations({ home, cwd, env: {} })
  assert.deepEqual(installed.map(entry => entry.harness).sort(), ['claude', 'codex', 'dsh'])
  assert.equal(installed.find(entry => entry.harness === 'codex').config, customCodex)
  assert.equal(installed.find(entry => entry.harness === 'dsh').config, customDsh)
  const markers = installed.flatMap(entry => entry.roots.map(root => join(root, 'prumo', '.prumo-install.json')))
  for (const marker of markers) { const value = JSON.parse(read(marker)); value.version = '0.0.9'; put(marker, value); put(join(dirname(marker), 'scripts', 'engine.mjs'), '// older installed engine\n') }
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), DSH_HOME: join(home, '.dsh'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PRUMO_HOME: join(home, 'data'), PRUMO_LANG: 'en' }
  delete env.GRAPH_ROOT; delete env.PRUMO_ROOT; delete env.GRAPH_FOREMAN_HOME
  put(join(home, '.local', 'share', 'prumo', 'dashboard.json'), { enabled: false, mechanism: process.platform === 'win32' ? 'schtasks' : process.platform === 'darwin' ? 'launchd' : 'xdg' })
  const run = dryRun => spawnSync(process.execPath, [join(source, 'bin', 'prumo.mjs'), '_update'], { cwd, env: { ...env, PRUMO_UPDATE_REQUEST: JSON.stringify({ dryRun, cwd, projects: [], updateCli: false }) }, encoding: 'utf8', timeout: 120000, windowsHide: true })
  const before = markers.map(read)
  const preview = run(true)
  assert.equal(preview.status, 0, preview.stdout + preview.stderr)
  assert.deepEqual(markers.map(read), before)
  const updated = run(false)
  assert.equal(updated.status, 0, updated.stdout + updated.stderr)
  assert.match(updated.stdout, /Prumo updated successfully/)
  assert.match(updated.stdout, /Prumo v1\.0\.9/)
  assert.match(updated.stdout, /Fixed — Global updates and Codex skill roots/)
  assert.match(updated.stdout, new RegExp(`Prumo v${version.replaceAll('.', '\\.')}`))
  assert.match(updated.stdout, /Fixed — Complete update history/)
  for (const marker of markers) {
    assert.equal(JSON.parse(read(marker)).version, version)
    assert.equal(read(join(dirname(marker), 'scripts', 'engine.mjs')), read(join(source, 'scripts', 'engine.mjs')))
  }
  assert.deepEqual(markers.map(marker => JSON.parse(read(marker)).lang), ['pt-BR', 'en', 'en', 'pt-BR'])
  assert.equal(JSON.parse(read(join(home, '.claude', 'settings.json'))).theme, 'dark')
  assert.match(read(join(customCodex, 'AGENTS.md')), /Keep this user instruction/)
  assert.match(read(join(customDsh, 'AGENTS.md')), /Keep this DSH user instruction/)
  assert.equal(existsSync(join(customDsh, 'skills', 'prumo', 'SKILL.md')), true)
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

test('update recupera marcadores nulos dos quatro ambientes por meio de backups integros', t => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'prumo-recover-update-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
    KIRO_HOME: join(home, '.kiro'), CODEX_HOME: join(home, '.codex'), DSH_HOME: join(home, '.dsh'), PRUMO_HOME: join(home, 'data'),
    GRAPH_ROOT: '', PRUMO_ROOT: '', GRAPH_FOREMAN_HOME: '', PRUMO_LANG: 'en' }
  const markers = []
  for (const harness of ['claude', 'kiro', 'codex', 'dsh']) {
    const first = planInstall({ harness, home, cwd: home, env })
    assert.ok(applyInstall(first).groups.every(group => group.status !== 'conflict'))
    const marker = join(first.groups.find(group => group.name.startsWith('skill:')).snapshots[0], '.prumo-install.json')
    markers.push(marker)
    put(marker, { ...JSON.parse(read(marker)), version: '1.0.8' })
    const second = planInstall({ harness, home, cwd: home, env })
    const applied = applyInstall(second)
    assert.ok(applied.backup)
    writeFileSync(marker, Buffer.alloc(90))
  }
  put(join(home, '.local/share/prumo/dashboard.json'), { enabled: false, mechanism: process.platform === 'win32' ? 'schtasks' : process.platform === 'darwin' ? 'launchd' : 'xdg' })
  const result = spawnSync(process.execPath, [join(source, 'bin/prumo.mjs'), '_update'], {
    cwd: home, env: { ...env, PRUMO_UPDATE_REQUEST: JSON.stringify({ dryRun: false, cwd: home, projects: [], updateCli: false }) },
    encoding: 'utf8', windowsHide: true, timeout: 120000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /Prumo updated successfully/)
  assert.match(result.stdout, /Prumo v1\.0\.9/)
  assert.doesNotMatch(result.stderr, /Invalid Prumo installation marker/)
  for (const marker of markers) assert.equal(JSON.parse(read(marker)).version, version)
})

test('update rejects malformed requests before applying installations', () => {
  for (const value of [undefined, '{}', 'null', JSON.stringify({ dryRun: true, cwd: '.', projects: [] }), JSON.stringify({ dryRun: true, cwd: source, projects: [], lang: 'invalid' }), JSON.stringify({ dryRun: true, cwd: source, projects: [], sourceVersion: 'next' }), JSON.stringify({ dryRun: true, cwd: source, projects: [], globalVersion: 'next' }), JSON.stringify({ dryRun: true, cwd: source, projects: [], pendingUpdate: 'yes' })]) assert.throws(() => updateRequest(value))
  assert.equal(updateRequest(JSON.stringify({ dryRun: false, cwd: source, projects: [] })).updateCli, true, 'legacy callers update the global CLI')
  assert.equal(updateRequest(JSON.stringify({ dryRun: false, cwd: source, projects: [], updateCli: false })).updateCli, false)
  assert.equal(isGlobalCli(join(source, 'package'), { platform: 'linux', run: () => ({ status: 0, stdout: source }) }), true)
  assert.equal(isGlobalCli(source, { platform: 'linux', run: () => ({ status: 0, stdout: join(source, 'elsewhere') }) }), false)
  assert.equal(npmLatestVersion({ platform: 'linux', run: () => ({ status: 0, stdout: '"1.3.10"' }) }), '1.3.10')
  assert.equal(npmLatestVersion({ platform: 'linux', run: () => ({ status: 0, stdout: '["1.3.10"]' }) }), '1.3.10')
  assert.throws(() => assertUpdateVersion('1.3.11', '1.3.10'), /refused to prevent downgrade/)
  assert.doesNotThrow(() => assertUpdateVersion('1.3.10', '1.3.11'))
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
  assert.deepEqual(state, { running: false, version: '1.0.7', packageRoot: join(source, '@henri-ralmeida', 'prumo') })
})

test('update refuses to replace a newer local candidate with npm latest', t => {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, 'prumo-update-downgrade-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const newer = `${Number(version.split('.')[0]) + 1}.0.0`
  const result = spawnSync(process.execPath, [join(source, 'bin/prumo.mjs'), '_update'], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_UPDATE_REQUEST: JSON.stringify({ dryRun: false, cwd: home, projects: [], updateCli: false, sourceVersion: newer }) },
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`Installed Prumo ${newer.replaceAll('.', '\\.')} is newer than npm latest`))
})

test('update reports a corrupt harness marker and still updates the other installed harnesses', t => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'prumo-partial-update-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
    KIRO_HOME: join(home, '.kiro'), CODEX_HOME: join(home, '.codex'), DSH_HOME: join(home, '.dsh'), PRUMO_HOME: join(home, 'data'),
    GRAPH_ROOT: '', PRUMO_ROOT: '', GRAPH_FOREMAN_HOME: '', PRUMO_LANG: 'en' }
  const markers = []
  for (const harness of ['claude', 'kiro', 'codex', 'dsh']) {
    const plan = planInstall({ harness, home, cwd: home, env })
    assert.ok(applyInstall(plan).groups.every(g => g.status !== 'conflict'))
    const marker = join(plan.groups.find(g => g.name.startsWith('skill:')).snapshots[0], '.prumo-install.json')
    markers.push(marker)
    put(marker, { ...JSON.parse(read(marker)), version: '1.0.8' })
    put(join(dirname(marker), 'scripts/engine.mjs'), '// old version')
  }
  put(markers[0], '{broken marker')
  put(join(home, '.local/share/prumo/dashboard.json'), { enabled: false, mechanism: process.platform === 'win32' ? 'schtasks' : process.platform === 'darwin' ? 'launchd' : 'xdg' })
  const result = spawnSync(process.execPath, [join(source, 'bin/prumo.mjs'), '_update'], {
    cwd: home, env: { ...env, PRUMO_UPDATE_REQUEST: JSON.stringify({ dryRun: false, cwd: home, projects: [], updateCli: false }) },
    encoding: 'utf8', windowsHide: true, timeout: 120000,
  })
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /Invalid Prumo installation marker.*claude/)
  assert.doesNotMatch(result.stdout, /Prumo updated successfully/)
  assert.match(result.stdout, /Update incomplete/)
  assert.match(result.stdout, /Prumo v1\.0\.9/)
  assert.ok(existsSync(join(home, '.local/share/prumo/update-pending.json')))
  assert.equal(read(markers[0]), '{broken marker')
  for (const marker of markers.slice(1)) {
    assert.equal(JSON.parse(read(marker)).version, version)
    assert.equal(read(join(dirname(marker), 'scripts/engine.mjs')), read(join(source, 'scripts/engine.mjs')))
  }
  rmSync(markers[0])
  assert.throws(() => discoverInstallations({ home, cwd: home, env }), /Invalid Prumo installation marker/,
    'a missing marker in a registered installation must not silently remove that harness either')
  put(markers[0], { product: 'prumo', harness: 'claude', version, lang: 'en' })
  const retried = spawnSync(process.execPath, [join(source, 'bin/prumo.mjs'), '_update'], {
    cwd: home, env: { ...env, PRUMO_UPDATE_REQUEST: JSON.stringify({ dryRun: false, cwd: home, projects: [], updateCli: false }) },
    encoding: 'utf8', windowsHide: true, timeout: 120000,
  })
  assert.equal(retried.status, 0, retried.stdout + retried.stderr)
  assert.match(retried.stdout, /Prumo v1\.0\.9/, 'retry keeps missed history even after every marker advanced')
  assert.equal(existsSync(join(home, '.local/share/prumo/update-pending.json')), false)
  const legacyState = join(home, '.local/share/graph-foreman/conflict/.specs/graph/run/state.json')
  const destinationState = join(home, 'data/conflict/.specs/graph/run/state.json')
  put(legacyState, '{"original":true}')
  put(destinationState, '{"different":true}')
  for (const marker of markers) put(marker, { ...JSON.parse(read(marker)), version: '1.3.8' })
  const conflict = spawnSync(process.execPath, [join(source, 'bin/prumo.mjs'), '_update'], {
    cwd: home, env: { ...env, PRUMO_UPDATE_REQUEST: JSON.stringify({ dryRun: false, cwd: home, projects: [], updateCli: false }) },
    encoding: 'utf8', windowsHide: true, timeout: 120000,
  })
  assert.equal(conflict.status, 2)
  assert.equal(conflict.stderr.split('Legacy workspace conflicts with Prumo destination').length - 1, 1,
    'the same workspace conflict is reported once across all four harnesses')
  assert.match(conflict.stdout, /Update incomplete/)
  assert.ok(conflict.stdout.includes(`Prumo v${version}`))
  assert.match(conflict.stdout, /Fixed — Legacy workspace migration/)
  assert.equal(read(legacyState), '{"original":true}')
  assert.equal(read(destinationState), '{"different":true}')
})

test('update preserves dashboard preference and adopts a running unconfigured legacy dashboard', async () => {
  const calls = []
  const restart = async options => { calls.push(options); return { ok: true } }
  const enable = async options => { calls.push({ enable: options }); return { ok: true } }
  const disabled = await reconcileDashboardUpdate({}, { status: async () => ({ enabled: false, disabled: true }), restart })
  assert.equal(disabled.action, 'disabled')
  const absent = await reconcileDashboardUpdate({}, { status: async () => ({ enabled: false, disabled: false }), restart })
  assert.equal(absent.action, 'none')
  const adopted = await reconcileDashboardUpdate({ before: { enabled: false, disabled: false, process: 'running' }, dashboardOptions: { packageRoot: '/global/prumo' } }, { status: async () => ({ enabled: false, disabled: false }), enable, restart })
  assert.equal(adopted.action, 'enable')
  assert.deepEqual(calls, [{ enable: { packageRoot: '/global/prumo' } }])
  calls.length = 0
  const preview = await reconcileDashboardUpdate({ dryRun: true }, { status: async () => ({ enabled: true }), restart })
  assert.equal(preview.action, 'restart')
  assert.deepEqual(calls, [])
  const result = await reconcileDashboardUpdate({ dashboardOptions: { packageRoot: '/global/prumo' } }, { status: async () => ({ enabled: true }), restart })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{ packageRoot: '/global/prumo' }])
})
