import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { planInstall, applyInstall } from '../lib/install.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repository, 'bin', 'prumo.mjs')
const packageVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version

function temporaryHome(t, prefix) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), prefix))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return home
}

function environment(home, extra = {}) {
  const base = { ...process.env }
  for (const key of Object.keys(base)) if (/^path$/i.test(key)) delete base[key]
  const { NODE_OPTIONS: preloads, ...extraEnvironment } = extra
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    PRUMO_HOME: join(home, 'data'),
    PRUMO_ROOT: '',
    GRAPH_ROOT: '',
    GRAPH_FOREMAN_HOME: '',
    PRUMO_LANG: 'en',
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    KIRO_HOME: join(home, '.kiro'),
    CODEX_HOME: join(home, '.codex'),
    DSH_HOME: join(home, '.dsh'),
    PATH: home,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./fixtures/dashboard-absent.mjs', import.meta.url).href} ${preloads ?? ''}`.trim(),
    ...extraEnvironment,
  }
}

function runCli(home, args, extra = {}, cwd = home) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: environment(home, extra),
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  })
  assert.ifError(result.error)
  return { ...result, output: result.stdout + result.stderr }
}

function detectedClaude(t, prefix) {
  return detectedHome(t, prefix, ['claude'])
}

function detectedHome(t, prefix, harnesses) {
  const home = temporaryHome(t, prefix)
  const project = join(home, 'project')
  mkdirSync(join(project, '.git'), { recursive: true })
  if (harnesses.includes('claude')) {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), '{}\n')
  }
  if (harnesses.includes('kiro')) {
    mkdirSync(join(home, '.kiro', 'settings'), { recursive: true })
    writeFileSync(join(home, '.kiro', 'settings', 'cli.json'), '{}\n')
  }
  return { home, project, env: environment(home) }
}

function installHarness(f, harness) {
  const applied = applyInstall(planInstall({ harness, home: f.home, cwd: f.project, env: f.env, lang: 'en' }))
  assert.ok(applied.groups.every(group => group.status !== 'conflict'), JSON.stringify(applied))
  return applied
}

function disableDashboard(home) {
  const preference = join(home, '.local', 'share', 'prumo', 'dashboard.json')
  mkdirSync(dirname(preference), { recursive: true })
  writeFileSync(preference, JSON.stringify({ enabled: false }) + '\n')
}

function preloadEnvironment(home, { tty = false, methods = false, noColor = false, dashboard = false, nodeVersion, subprocessResult, readFailure, readFailureAfterRefresh = false, omitPackageJson = false, afterStyleWrite } = {}) {
  const preload = join(home, `cli-preload-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`)
  const source = []
  if (nodeVersion) source.push(`Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} })`)
  if (tty) {
    source.push('process.stdin.isTTY = true')
    source.push('process.stdout.isTTY = true')
    source.push('process.stderr.isTTY = true')
    if (methods) {
      source.push('process.stdout.clearLine = () => true')
      source.push('process.stdout.cursorTo = () => true')
    } else {
      source.push('process.stdout.clearLine = undefined')
      source.push('process.stdout.cursorTo = undefined')
    }
  }
  source.push(noColor ? "process.env.NO_COLOR = '1'" : 'delete process.env.NO_COLOR')
  if (dashboard) source.push(`await import(${JSON.stringify(new URL('./fixtures/dashboard-absent.mjs', import.meta.url).href)})`)
  if (subprocessResult) source.push(`import childProcess from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (file, args, options) => /(?:engine|serve)\\.mjs$/.test(args?.[0] ?? '')
  ? ${JSON.stringify(subprocessResult)}.error ? { error: new Error(${JSON.stringify(subprocessResult.error ?? '')}) } : ${JSON.stringify(subprocessResult)}
  : originalSpawnSync(file, args, options);
syncBuiltinESMExports()`)
  if (omitPackageJson) source.push('delete process.env.npm_package_json')
  if (readFailure) source.push(`import filesystem from 'node:fs'; import { syncBuiltinESMExports as syncFilesystemExports } from 'node:module';
const originalRead = filesystem.readFileSync;
filesystem.readFileSync = (path, ...args) => {
  if (String(path) === ${JSON.stringify(readFailure)} && ${readFailureAfterRefresh ? "process.env.PRUMO_TEST_READ_FAILURE_ACTIVE === '1'" : 'true'}) throw new Error('leitura indisponível');
  return originalRead(path, ...args);
}; syncFilesystemExports()`)
  if (afterStyleWrite) source.push(`import mutationFilesystem from 'node:fs'; import { dirname as mutationDirectory } from 'node:path'; import { syncBuiltinESMExports as syncMutationExports } from 'node:module';
const originalRename = mutationFilesystem.renameSync; let edited = false;
mutationFilesystem.renameSync = (from, to, ...args) => {
  const result = originalRename(from, to, ...args);
  if (!edited && String(to) === ${JSON.stringify(afterStyleWrite.when)}) {
    edited = true; mutationFilesystem.mkdirSync(mutationDirectory(${JSON.stringify(afterStyleWrite.target)}), { recursive: true });
    mutationFilesystem.writeFileSync(${JSON.stringify(afterStyleWrite.target)}, '{"outputStyle":"personalizado"}\\n');
  }
  return result;
}; syncMutationExports()`)
  writeFileSync(preload, `${source.join(';')}\n`)
  return {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim(),
    ...(noColor ? { NO_COLOR: '1' } : {}),
  }
}

test('migrate encaminha --check e --run e propaga a migração do subprocesso', t => {
  const home = temporaryHome(t, 'prumo-cli-migrate-')
  const workspace = join(home, 'workspace')
  const graph = join(workspace, '.specs', 'graph')
  const target = join(graph, 'target')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(graph, 'CURRENT'), 'other')
  writeFileSync(join(target, 'events.ndjson'), '')
  const statePath = join(target, 'state.json')
  const before = { schemaVersion: 0, run: 'target', plan: { name: 'Plano antigo' }, tasks: {} }
  writeFileSync(statePath, JSON.stringify(before))

  const preview = runCli(home, ['migrate', '--check', '--run', 'target'], { PRUMO_ROOT: workspace })
  assert.equal(preview.status, 0, preview.output)
  assert.match(preview.stdout, /run "target" needs schema migration/)
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), before, 'a prévia não deve gravar o estado')

  const migrated = runCli(home, ['migrate', '--run', 'target'], { PRUMO_ROOT: workspace })
  assert.equal(migrated.status, 0, migrated.output)
  assert.match(migrated.stdout, /run "target" migrated to schema v1/)
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(state.schemaVersion, 1)
  assert.equal(state.plan.planningMode, 'task')
  assert.equal(existsSync(join(target, 'state.pre-migrate-v1.json')), true)
  assert.match(readFileSync(join(target, 'events.ndjson'), 'utf8'), /"type":"schema_migrate"/)

  const failed = runCli(home, ['migrate', '--check', '--run', 'missing'], { PRUMO_ROOT: workspace })
  assert.equal(failed.status, 1, failed.output)
  assert.match(failed.output, /run "missing" has no state\.json/)
})

test('restore restaura um backup válido pelo wrapper e rejeita caminho ausente', t => {
  const home = temporaryHome(t, 'prumo-cli-restore-')
  const project = join(home, 'project')
  mkdirSync(join(project, '.git'), { recursive: true })
  const env = environment(home)
  const plan = planInstall({ harness: 'claude', home, cwd: project, env, lang: 'en' })
  const applied = applyInstall(plan)
  assert.ok(applied.backup, 'a instalação do fixture precisa produzir um backup')
  assert.equal(existsSync(join(plan.config, 'output-styles', 'po-first.md')), true)

  const restored = runCli(home, ['restore', applied.backup], {}, project)
  assert.equal(restored.status, 0, restored.output)
  assert.match(restored.stdout, /Restored \d+ files; run data was not changed/)
  assert.equal(existsSync(join(plan.config, 'output-styles', 'po-first.md')), false)
  assert.equal(existsSync(join(plan.config, 'skills', 'prumo', 'SKILL.md')), false)

  const missing = join(home, '.local', 'share', 'prumo', 'backups', 'does-not-exist')
  const rejected = runCli(home, ['restore', missing], {}, project)
  assert.equal(rejected.status, 1, rejected.output)
  assert.match(rejected.output, /ENOENT|no such file/i)
})

test('status informa ausência de instalações e falha de descoberta de forma observável', t => {
  const home = temporaryHome(t, 'prumo-cli-status-')
  const empty = runCli(home, ['status'])
  assert.equal(empty.status, 2, empty.output)
  assert.match(empty.stdout, /No Prumo installations found/)

  const registry = join(home, '.local', 'share', 'prumo', 'installations.json')
  mkdirSync(dirname(registry), { recursive: true })
  writeFileSync(registry, JSON.stringify([{ harness: 'unknown' }]))
  const broken = runCli(home, ['status'])
  assert.equal(broken.status, 1, broken.output)
  assert.match(broken.stderr, /Invalid Prumo installation registry/)
})

test('install --all separa instalação atual, pendente e conflito em prévia isolada', t => {
  const current = detectedClaude(t, 'prumo-cli-install-current-')
  installHarness(current, 'claude')
  const currentRun = runCli(current.home, ['install', '--all', '--dry-run'], {}, current.project)
  assert.equal(currentRun.status, 0, currentRun.output)
  assert.match(currentRun.output, /already installed in claude/i)

  const pending = detectedClaude(t, 'prumo-cli-install-pending-')
  const pendingRun = runCli(pending.home, ['install', '--all', '--dry-run', '--project', pending.project])
  assert.equal(pendingRun.status, 0, pendingRun.output)
  assert.match(pendingRun.output, /Changes \/|Dry run: no files changed/)
  assert.equal(existsSync(join(pending.home, '.claude', 'skills', 'prumo', 'SKILL.md')), false)
  assert.equal(readFileSync(join(pending.home, '.claude', 'settings.json'), 'utf8'), '{}\n')

  const conflict = detectedClaude(t, 'prumo-cli-install-conflict-')
  writeFileSync(join(conflict.home, '.claude', 'settings.json'), '[]\n')
  const conflictRun = runCli(conflict.home, ['install', '--all', '--dry-run'], {}, conflict.project)
  assert.equal(conflictRun.status, 2, conflictRun.output)
  assert.match(conflictRun.output, /conflict|Expected a settings object/i)
  assert.equal(readFileSync(join(conflict.home, '.claude', 'settings.json'), 'utf8'), '[]\n')
})

test('doctor reporta conteúdo divergente e instalação incompleta sem reescrever arquivos', t => {
  const f = detectedClaude(t, 'prumo-cli-doctor-content-')
  installHarness(f, 'claude')
  disableDashboard(f.home)
  const engine = join(f.home, '.claude', 'skills', 'prumo', 'scripts', 'engine.mjs')
  const original = readFileSync(engine, 'utf8')
  writeFileSync(engine, original + '\n// alteração controlada\n')

  const changed = runCli(f.home, ['doctor', '--claude'], {}, f.project)
  assert.equal(changed.status, 2, changed.output)
  assert.match(changed.output, /installed engine\.mjs differs from the hash|installed package content differs/i)
  assert.match(readFileSync(engine, 'utf8'), /alteração controlada/)

  rmSync(engine)
  const incomplete = runCli(f.home, ['doctor', '--claude'], {}, f.project)
  assert.equal(incomplete.status, 2, incomplete.output)
  assert.match(incomplete.output, /incomplete or differs|installed package content differs/i)
  assert.equal(existsSync(engine), false)
})

test('status --verify-install confirma instalação íntegra e rejeita pacote incompleto', t => {
  const f = detectedClaude(t, 'prumo-cli-status-verify-')
  installHarness(f, 'claude')

  const healthy = runCli(f.home, ['status', '--verify-install'], {}, f.project)
  assert.equal(healthy.status, 0, healthy.output)
  assert.match(healthy.output, /Installation files match the current package/)

  const engine = join(f.home, '.claude', 'skills', 'prumo', 'scripts', 'engine.mjs')
  rmSync(engine)
  const incomplete = runCli(f.home, ['status', '--verify-install'], {}, f.project)
  assert.equal(incomplete.status, 2, incomplete.output)
  assert.match(incomplete.output, /incomplete or differs|installed package content differs/i)
})

test('doctor compara identidades entre instalações e status exibe avisos de marcadores', t => {
  const f = detectedHome(t, 'prumo-cli-doctor-identities-', ['claude', 'kiro'])
  installHarness(f, 'claude')
  installHarness(f, 'kiro')
  disableDashboard(f.home)

  const same = runCli(f.home, ['doctor', '--claude'], {}, f.project)
  assert.equal(same.status, 0, same.output)
  assert.match(same.output, /Registered en installations share content/i)
  assert.match(same.output, /claude: version|kiro: version/i)

  const kiroEngine = join(f.home, '.kiro', 'skills', 'prumo', 'scripts', 'engine.mjs')
  writeFileSync(kiroEngine, readFileSync(kiroEngine, 'utf8') + '\n// conteúdo divergente controlado\n')
  const different = runCli(f.home, ['doctor', '--claude'], {}, f.project)
  assert.equal(different.status, 0, different.output)
  assert.match(different.output, /Registered en installations have different contents:/i)
  assert.match(different.output, /marker content ID differs|installed engine\.mjs differs/i)

  const markerFile = join(f.home, '.claude', 'skills', 'prumo', '.prumo-install.json')
  const marker = JSON.parse(readFileSync(markerFile, 'utf8'))
  marker.contentId = '000000000000'
  marker.engineHash = '0'.repeat(64)
  writeFileSync(markerFile, JSON.stringify(marker, null, 2) + '\n')
  const markerWarnings = runCli(f.home, ['status', '--project', f.project])
  assert.equal(markerWarnings.status, 0, markerWarnings.output)
  assert.match(markerWarnings.output, /marker content ID differs from its files/i)
  assert.match(markerWarnings.output, /engine\.mjs differs from the hash in the installation marker/i)

  delete marker.contentId
  delete marker.engineHash
  writeFileSync(markerFile, JSON.stringify(marker, null, 2) + '\n')
  const legacy = runCli(f.home, ['status'])
  assert.equal(legacy.status, 0, legacy.output)
  assert.match(legacy.output, /installation marker is old and has no content identity/i)
})

test('install --all conclui a instalação no ciclo de postinstall sem iniciar dashboard desabilitado', t => {
  const f = detectedClaude(t, 'prumo-cli-install-lifecycle-')
  disableDashboard(f.home)
  const result = runCli(f.home, ['install', '--all'], {
    PRUMO_POSTINSTALL_LIFECYCLE: '1',
    npm_lifecycle_event: 'postinstall',
    npm_package_json: join(repository, 'package.json'),
  }, f.project)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /Prumo installed successfully|Dashboard remains disabled by user preference/i)
  assert.equal(existsSync(join(f.home, '.claude', 'skills', 'prumo', 'SKILL.md')), true)
  assert.equal(existsSync(join(f.home, '.local', 'share', 'prumo', 'installations.json')), true)
})

test('wrappers rejeitam combinações de opções incompatíveis com mensagens verificáveis', t => {
  const home = temporaryHome(t, 'prumo-cli-invalid-options-')
  const cases = [
    { args: ['status', '--claude'], pattern: /does not accept --claude|Status accepts only/ },
    { args: ['doctor'], pattern: /Choose exactly one/ },
    { args: ['install', '--all', '--claude'], pattern: /Use --all only with install/ },
    { args: ['install', '--claude'], pattern: /Claude Code.*not installed or configured/ },
    { args: ['install', '--verify-install'], pattern: /Use --verify-install with status/ },
    { args: ['migrate', '--lang', 'en'], pattern: /does not accept --lang|Migrate accepts only/ },
    { args: ['restore'], pattern: /Restore needs a backup directory/ },
  ]
  for (const item of cases) {
    const result = runCli(home, item.args)
    assert.equal(result.status, 1, `${item.args.join(' ')}\n${result.output}`)
    assert.match(result.output, item.pattern, item.args.join(' '))
  }
})

test('CLI rejeita argumentos posicionais excedentes antes de alterar o ambiente', t => {
  const home = temporaryHome(t, 'prumo-cli-extra-positionals-')
  for (const args of [['status', 'extra'], ['dashboard', 'status', 'extra'], ['dashboard', 'desconhecido'], ['update', 'extra'], ['migrate', 'extra'], ['install', 'extra']]) {
    const result = runCli(home, args, preloadEnvironment(home, { dashboard: true }))
    assert.equal(result.status, 1, result.output)
    assert.equal(existsSync(join(home, '.local', 'share', 'prumo', 'update-pending.json')), false)
    assert.equal(existsSync(join(home, '.claude')), false)
  }
})

test('dispatcher recusa comando futuro mesmo se o parser parcialmente atualizado o aceitar', t => {
  const f = detectedClaude(t, 'prumo-cli-parser-dispatch-boundary-')
  const settings = join(f.home, '.claude', 'settings.json'), before = readFileSync(settings, 'utf8')
  const response = runCli(f.home, ['comando-futuro', '--all'], {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./fixtures/cli-args-double.mjs', import.meta.url).href}`.trim(),
  }, f.project)
  assert.equal(response.status, 1, response.output)
  assert.match(response.stderr, /Unknown command: comando-futuro/)
  assert.equal(readFileSync(settings, 'utf8'), before)
  assert.equal(existsSync(join(f.home, '.claude', 'skills')), false)
  assert.equal(existsSync(join(f.home, '.local', 'share', 'prumo')), false)
})

test('CLI informa falha de subprocesso e saída ausente sem declarar execução bem-sucedida', t => {
  const home = temporaryHome(t, 'prumo-cli-child-result-')
  for (const [command, result, expected] of [['migrate', { error: 'processo indisponível' }, 1], ['migrate', { status: null }, 1], ['dashboard', { status: 3 }, 3]]) {
    const response = runCli(home, [command], preloadEnvironment(home, { dashboard: true, subprocessResult: result }))
    assert.equal(response.status, expected, response.output)
    if (result.error) assert.match(response.stderr, /processo indisponível/)
  }
})

function dashboardDouble(status, result = status) {
  return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./fixtures/autostart-double.mjs', import.meta.url).href}`.trim(),
    PRUMO_TEST_DASHBOARD_STATUS: JSON.stringify(status), PRUMO_TEST_DASHBOARD_RESULT: JSON.stringify(result), PRUMO_TEST_DASHBOARD_REPAIR: '0' }
}

function updateDouble(extra = {}) {
  return { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./fixtures/update-double.mjs', import.meta.url).href}`.trim(),
    PRUMO_TEST_GLOBAL_STATE: JSON.stringify({ running: true, version: packageVersion, packageRoot: repository }),
    PRUMO_TEST_UPDATE_FAILURE: '', PRUMO_TEST_MARKER_REMOVED: '', PRUMO_TEST_LAUNCH_MODE: 'repair',
    PRUMO_TEST_REFRESH_READ_FAILURE: '', PRUMO_TEST_READ_FAILURE_ACTIVE: '', PRUMO_TEST_REPORT_REFRESH: '', ...extra }
}

test('instalação concluída informa ativação, reinício e falha do dashboard sem perder configuração', t => {
  for (const scenario of ['enable', 'restart', 'error', 'conflict', 'unknown', 'configuration-conflict']) {
    const f = detectedClaude(t, `prumo-cli-install-dashboard-${scenario}-`)
    const settings = join(f.home, '.claude', 'settings.json')
    if (scenario === 'configuration-conflict') writeFileSync(settings, '[]\n')
    const before = readFileSync(settings, 'utf8')
    const failed = !['enable', 'restart'].includes(scenario)
    const status = { enabled: scenario === 'restart', process: 'stopped', registered: scenario === 'restart' }
    const result = { ok: !failed, process: 'stopped', url: 'http://localhost/isolado',
      ...(scenario === 'error' ? { error: 'serviço negado' } : scenario === 'conflict' ? { conflict: true, port: 4949 } : {}) }
    const update = updateDouble(), dashboard = dashboardDouble(status, result)
    const response = runCli(f.home, ['install', '--claude'], { ...update, ...dashboard, NODE_OPTIONS: `${update.NODE_OPTIONS} ${dashboard.NODE_OPTIONS}` }, f.project)
    assert.equal(response.status, failed ? 2 : 0, response.output)
    assert.ok(existsSync(join(f.home, '.claude/skills/prumo/.prumo-install.json')))
    if (scenario === 'configuration-conflict') assert.equal(readFileSync(settings, 'utf8'), before)
    if (failed) assert.match(response.stderr, /Dashboard setup failed/)
    else assert.match(response.stdout, scenario === 'enable' ? /Dashboard enabled:/ : /Dashboard restarted:/)
  }
})

test('falha global ou refresh interrompe instalação antes de mudar arquivos do ambiente', t => {
  for (const failure of ['install', 'refresh']) {
    const f = detectedClaude(t, `prumo-cli-global-${failure}-`)
    const update = updateDouble({ PRUMO_TEST_UPDATE_FAILURE: failure,
      ...(failure === 'install' && { PRUMO_TEST_GLOBAL_STATE: JSON.stringify({ running: false, version: null, packageRoot: null }) }) })
    const response = runCli(f.home, ['install', '--claude'], update, f.project)
    assert.equal(response.status, 1, response.output)
    assert.match(response.stderr, failure === 'install' ? /Global Prumo CLI installation failed/ : /refresh negado/)
    assert.equal(existsSync(join(f.home, '.claude', 'skills')), false)
    assert.equal(readFileSync(join(f.home, '.claude/settings.json'), 'utf8'), '{}\n')
  }
})

test('update informa ausência e reparo enquanto worker preserva checkpoint em falha global ou remoção concorrente', t => {
  const f = detectedClaude(t, 'prumo-cli-update-boundaries-')
  for (const mode of ['absent', 'repair']) {
    const response = runCli(f.home, ['update'], updateDouble({ PRUMO_TEST_LAUNCH_MODE: mode }), f.project)
    assert.equal(response.status, 0, response.output)
    assert.match(response.stdout, mode === 'absent' ? /No Prumo installations found/ : /Dashboard restarted:/)
  }
  for (const mode of ['error', 'repair-error']) {
    const failed = runCli(f.home, ['update'], updateDouble({ PRUMO_TEST_LAUNCH_MODE: mode }), f.project)
    assert.equal(failed.status, 1, failed.output)
    assert.match(failed.stderr, mode === 'error' ? /verificação externa indisponível/ : /Dashboard restart failed: serviço negado/)
    assert.equal(existsSync(join(f.home, '.claude', 'skills')), false)
  }
  installHarness(f, 'claude')
  const marker = join(f.home, '.claude/skills/prumo/.prumo-install.json')
  const request = { dryRun: false, cwd: f.project, projects: [], updateCli: true }
  for (const failure of ['install', 'removed']) {
    const update = updateDouble(failure === 'install' ? { PRUMO_TEST_UPDATE_FAILURE: failure } : { PRUMO_TEST_MARKER_REMOVED: marker })
    const dashboard = dashboardDouble({ enabled: true, process: 'running' }, { ok: true })
    const response = runCli(f.home, ['_update'], { ...update, ...dashboard, NODE_OPTIONS: `${update.NODE_OPTIONS} ${dashboard.NODE_OPTIONS}`,
      PRUMO_UPDATE_REQUEST: JSON.stringify(request) }, f.project)
    assert.notEqual(response.status, 0, response.output)
    assert.ok(existsSync(join(f.home, '.local/share/prumo/update-pending.json')))
    assert.doesNotMatch(response.stdout, /Prumo updated successfully/)
  }
})

test('doctor e status distinguem identidade desconhecida, erro de inspeção e necessidade de reparo', t => {
  const f = detectedHome(t, 'prumo-cli-inspection-boundaries-', ['claude', 'kiro'])
  installHarness(f, 'claude'); installHarness(f, 'kiro')
  const claude = join(f.home, '.claude/skills/prumo'), markerPath = join(claude, '.prumo-install.json')
  const before = readFileSync(join(f.home, '.claude/settings.json'), 'utf8')
  rmSync(join(claude, 'README.md'))
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  delete marker.contentId; delete marker.engineHash
  writeFileSync(markerPath, JSON.stringify(marker))
  const incomplete = runCli(f.home, ['status'], {}, f.project)
  assert.match(incomplete.stdout, /content unknown|files unknown|installed unknown/)
  for (const status of [{ enabled: true, registered: true }, { enabled: false, disabled: true, registered: false }, { enabled: false, registered: false }]) {
    const response = runCli(f.home, ['doctor', '--claude'], dashboardDouble({ ...status, process: 'stopped' }), f.project)
    assert.match(response.stdout, /unknown content IDs/)
    assert.equal(existsSync(join(claude, 'README.md')), false)
  }
  writeFileSync(join(f.home, '.kiro/skills/prumo/.prumo-install.json'), '{inválido')
  const repair = runCli(f.home, ['doctor', '--claude'], { ...dashboardDouble({ enabled: true, registered: true, process: 'stopped' }), PRUMO_TEST_DASHBOARD_REPAIR: '1' }, f.project)
  assert.equal(repair.status, 2)
  assert.match(repair.stderr, /Invalid Prumo installation marker/)
  const unreadable = runCli(f.home, ['status'], preloadEnvironment(f.home, { readFailure: join(repository, 'README.md') }), f.project)
  assert.equal(unreadable.status, 2, unreadable.output)
  assert.match(unreadable.stderr, /Could not inspect installation/)
  assert.equal(readFileSync(join(f.home, '.claude/settings.json'), 'utf8'), before)
})

test('prévia exibe dados legados e avisos de ativação sem aplicar alterações', t => {
  const f = detectedClaude(t, 'prumo-cli-preview-migration-')
  installHarness(f, 'claude')
  const markerPath = join(f.home, '.claude/skills/prumo/.prumo-install.json')
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  delete marker.lang
  marker.version = '1.3.16'
  writeFileSync(markerPath, JSON.stringify(marker))
  rmSync(join(f.home, '.claude/output-styles/po-first.md'))
  const local = join(f.project, '.claude/settings.json')
  mkdirSync(dirname(local), { recursive: true }); writeFileSync(local, '{"outputStyle":"personalizado"}\n')
  const state = join(f.home, '.local/share/graph-foreman/preview/.specs/graph/run/state.json')
  mkdirSync(dirname(state), { recursive: true }); writeFileSync(state, 'histórico original')
  const active = join(f.home, 'data', 'current', '.specs', 'graph', 'current', 'state.json')
  mkdirSync(dirname(active), { recursive: true }); writeFileSync(active, 'execução atual')
  const request = { dryRun: true, cwd: f.project, projects: [], updateCli: false }
  const response = runCli(f.home, ['_update'], { ...dashboardDouble({ disabled: true, process: 'stopped' }), PRUMO_UPDATE_REQUEST: JSON.stringify(request) }, f.project)
  assert.equal(response.status, 2, response.output)
  assert.match(response.stdout, /Migrate existing data:/)
  assert.match(response.stdout, /Existing data stays in place:/)
  assert.match(response.stdout, /pending activation|Local outputStyle overrides/)
  assert.equal(readFileSync(state, 'utf8'), 'histórico original')
  assert.equal(readFileSync(active, 'utf8'), 'execução atual')
  assert.equal(existsSync(join(f.home, 'data', 'preview')), false)
  assert.equal(readFileSync(markerPath, 'utf8'), JSON.stringify(marker))
})

test('prévia de remoção fornecida por outro planner preserva o arquivo existente', t => {
  const f = detectedClaude(t, 'prumo-cli-preview-remove-'), file = join(f.home, 'preservar.txt')
  writeFileSync(file, 'dado do usuário')
  const update = updateDouble(), dashboard = dashboardDouble({ disabled: true, process: 'stopped' })
  const response = runCli(f.home, ['install', '--claude', '--dry-run'], { ...update, ...dashboard,
    NODE_OPTIONS: `${update.NODE_OPTIONS} ${dashboard.NODE_OPTIONS} --import=${new URL('./fixtures/install-plan-double.mjs', import.meta.url).href}`,
    PRUMO_TEST_REMOVE_PREVIEW: file,
  }, f.project)
  assert.equal(response.status, 0, response.output)
  assert.match(response.stdout, /remove: .*preservar\.txt/)
  assert.equal(readFileSync(file, 'utf8'), 'dado do usuário')
  assert.equal(existsSync(join(f.home, '.claude', 'skills')), false)
})

test('status aceita relatório legado sem conteúdo e doctor informa conflito sem reescrever configuração', t => {
  const f = detectedClaude(t, 'prumo-cli-legacy-report-')
  installHarness(f, 'claude')
  const status = runCli(f.home, ['status'], { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./fixtures/install-plan-double.mjs', import.meta.url).href}`,
    PRUMO_TEST_UNKNOWN_MARKER_CONTENT: '1', PRUMO_TEST_REMOVE_PREVIEW: '' }, f.project)
  assert.equal(status.status, 0, status.output)
  assert.match(status.stdout, /files unknown/)
  const settings = join(f.home, '.claude/settings.json')
  writeFileSync(settings, '[]\n')
  const doctor = runCli(f.home, ['doctor', '--claude'], dashboardDouble({ disabled: true, process: 'stopped' }), f.project)
  assert.equal(doctor.status, 2, doctor.output)
  assert.match(doctor.stdout, /pending activation|Expected a settings object/)
  assert.equal(readFileSync(settings, 'utf8'), '[]\n')
})

test('instalação automática continua diagnóstico por ambiente quando a leitura falha após refresh', t => {
  const f = detectedHome(t, 'prumo-cli-auto-read-race-', ['claude', 'kiro'])
  const update = updateDouble({ PRUMO_TEST_REFRESH_READ_FAILURE: '1' }), dashboard = dashboardDouble({ disabled: true, process: 'stopped' })
  const preload = preloadEnvironment(f.home, { readFailure: join(repository, 'README.md'), readFailureAfterRefresh: true })
  const result = runCli(f.home, ['install', '--all'], { ...update, ...dashboard,
    NODE_OPTIONS: `${update.NODE_OPTIONS} ${dashboard.NODE_OPTIONS} ${preload.NODE_OPTIONS}` }, f.project)
  assert.equal(result.status, 2, result.output)
  assert.match(result.stderr, /claude: leitura indisponível/)
  assert.match(result.stderr, /kiro: leitura indisponível/)
  assert.equal(existsSync(join(f.home, '.claude', 'skills')), false)
  assert.equal(existsSync(join(f.home, '.kiro', 'skills')), false)
  const selected = runCli(f.home, ['install', '--claude'], { ...update, ...dashboard,
    NODE_OPTIONS: `${update.NODE_OPTIONS} ${dashboard.NODE_OPTIONS} ${preload.NODE_OPTIONS}` }, f.project)
  assert.equal(selected.status, 1, selected.output)
  assert.match(selected.stderr, /leitura indisponível/)
  assert.equal(existsSync(join(f.home, '.claude', 'skills')), false)
})

test('prévia interativa solicita seleção e postinstall incompleto não suprime refresh', t => {
  const f = detectedClaude(t, 'prumo-cli-selection-lifecycle-')
  const update = updateDouble(), dashboard = dashboardDouble({ disabled: true, process: 'stopped' }), tty = preloadEnvironment(f.home, { tty: true })
  const preview = runCli(f.home, ['install', '--dry-run'], { ...update, ...dashboard,
    NODE_OPTIONS: `${update.NODE_OPTIONS} ${dashboard.NODE_OPTIONS} ${tty.NODE_OPTIONS} --import=${new URL('./fixtures/prompt-double.mjs', import.meta.url).href}` }, f.project)
  assert.equal(preview.status, 0, preview.output)
  assert.match(preview.stdout, /seleção solicitada: claude/)
  assert.equal(existsSync(join(f.home, '.claude', 'skills')), false)
  const restartDashboard = dashboardDouble({ enabled: true, process: 'stopped' })
  const restartPreview = runCli(f.home, ['install', '--claude', '--dry-run'], { ...update, ...restartDashboard,
    NODE_OPTIONS: `${update.NODE_OPTIONS} ${restartDashboard.NODE_OPTIONS}` }, f.project)
  assert.equal(restartPreview.status, 0, restartPreview.output)
  assert.match(restartPreview.stdout, /Would restart the enabled Prumo dashboard/)
  assert.equal(existsSync(join(f.home, '.claude', 'skills')), false)
  const missingJson = preloadEnvironment(f.home, { omitPackageJson: true })
  const installed = runCli(f.home, ['install', '--all'], { ...update, ...dashboard, PRUMO_POSTINSTALL_LIFECYCLE: '1', npm_lifecycle_event: 'postinstall', PRUMO_TEST_REPORT_REFRESH: '1',
    NODE_OPTIONS: `${update.NODE_OPTIONS} ${dashboard.NODE_OPTIONS} ${missingJson.NODE_OPTIONS}` }, f.project)
  assert.equal(installed.status, 0, installed.output)
  assert.match(installed.stdout, /refresh solicitado/)
  assert.ok(existsSync(join(f.home, '.claude/skills/prumo/.prumo-install.json')))
  const project = runCli(f.home, ['install', '--all', '--project', f.project], { ...update, ...dashboard, PRUMO_POSTINSTALL_LIFECYCLE: '1', npm_lifecycle_event: 'postinstall',
    npm_package_json: join(repository, 'package.json'), PRUMO_TEST_REPORT_REFRESH: '1', NODE_OPTIONS: `${update.NODE_OPTIONS} ${dashboard.NODE_OPTIONS}` }, f.project)
  assert.equal(project.status, 0, project.output)
  assert.match(project.stdout, /refresh solicitado/)
})

test('aviso de configuração local criada durante instalação preserva a edição e pede ativação', t => {
  const f = detectedClaude(t, 'prumo-cli-concurrent-local-style-'), local = join(f.project, '.claude/settings.json')
  const update = updateDouble(), dashboard = dashboardDouble({ disabled: true, process: 'stopped' })
  const mutation = preloadEnvironment(f.home, { afterStyleWrite: { when: join(f.home, '.claude/output-styles/po-first.md'), target: local } })
  const result = runCli(f.home, ['install', '--claude'], { ...update, ...dashboard,
    NODE_OPTIONS: `${update.NODE_OPTIONS} ${dashboard.NODE_OPTIONS} ${mutation.NODE_OPTIONS}` }, f.project)
  assert.equal(result.status, 2, result.output)
  assert.match(result.stderr, /pending activation.*Local outputStyle overrides PO First/)
  assert.equal(readFileSync(local, 'utf8'), '{"outputStyle":"personalizado"}\n')
  assert.ok(existsSync(join(f.home, '.claude/skills/prumo/.prumo-install.json')))
})

test('CLI dashboard distingue configuração, conflito e falha sem alterar serviços reais', t => {
  const home = temporaryHome(t, 'prumo-cli-dashboard-states-')
  for (const [action, result, code] of [
    ['status', { process: 'stopped', registered: false, enabled: false }, 0],
    ['enable', { ok: false, process: 'stopped', registered: true, enabled: true, error: 'serviço negado', origin: 'global' }, 2],
    ['disable', { ok: true, process: 'stopped', registered: false, disabled: true, path: '/pacote' }, 0],
    ['status', { process: 'conflict', conflict: true, port: 4949, enabled: true }, 2],
  ]) {
    const response = runCli(home, ['dashboard', action], dashboardDouble(result))
    assert.equal(response.status, code, response.output)
    assert.match(response.stdout, /Dashboard:/)
    if (result.error) assert.match(response.stderr, /serviço negado/)
    if (result.conflict) assert.match(response.stderr, /used by another process/)
  }
  assert.match(runCli(home, ['dashboard', 'logs'], dashboardDouble({ process: 'stopped' })).stdout, /No dashboard events recorded/)
})

test('worker informa prévia de ativação ou reinício e preserva checkpoint quando o dashboard falha', t => {
  const home = temporaryHome(t, 'prumo-cli-dashboard-worker-')
  const request = { dryRun: true, cwd: home, projects: [], updateCli: false }
  for (const enabled of [false, true]) {
    const response = runCli(home, ['_update'], { ...dashboardDouble({ enabled, process: 'running' }), PRUMO_UPDATE_REQUEST: JSON.stringify(request) })
    assert.equal(response.status, 0, response.output)
    assert.match(response.stdout, enabled ? /Would restart/ : /Would enable/)
  }
  for (const status of [{ error: 'identidade antiga' }, { conflict: true, port: 4949 }, {}]) {
    const response = runCli(home, ['_update'], { ...dashboardDouble({ enabled: true, process: 'stopped' }, { ok: false, ...status }),
      PRUMO_UPDATE_REQUEST: JSON.stringify({ ...request, dryRun: false }) })
    assert.equal(response.status, 2, response.output)
    assert.match(response.stderr, /Dashboard restart failed/)
    assert.ok(existsSync(join(home, '.local/share/prumo/update-pending.json')))
  }
  const checkpoint = join(home, '.local/share/prumo/update-pending.json')
  rmSync(checkpoint)
  mkdirSync(checkpoint)
  const failed = runCli(home, ['_update'], { ...dashboardDouble({ enabled: true, process: 'running' }, { ok: false, process: 'stopped' }),
    PRUMO_UPDATE_REQUEST: JSON.stringify({ ...request, dryRun: false }) })
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /Dashboard restart failed/)
  assert.ok(existsSync(checkpoint), 'a recuperação não remove o checkpoint que mudou de tipo')
})

test('install preserva progresso TTY com e sem métodos de limpeza e respeita NO_COLOR', t => {
  const f = detectedClaude(t, 'prumo-cli-tty-progress-')
  disableDashboard(f.home)
  const lifecycle = {
    PRUMO_POSTINSTALL_LIFECYCLE: '1',
    npm_lifecycle_event: 'postinstall',
    npm_package_json: join(repository, 'package.json'),
  }
  const colored = runCli(f.home, ['install', '--all'], {
    ...lifecycle,
    ...preloadEnvironment(f.home, { tty: true, methods: true, dashboard: true }),
  }, f.project)
  assert.equal(colored.status, 0, colored.output)
  assert.match(colored.output, /\x1b\[36m\[/)
  assert.match(colored.output, /\x1b\[32m.*Prumo installed successfully/)

  const noColor = runCli(f.home, ['install', '--all'], {
    ...lifecycle,
    ...preloadEnvironment(f.home, { tty: true, methods: false, noColor: true, dashboard: true }),
  }, f.project)
  assert.equal(noColor.status, 0, noColor.output)
  assert.doesNotMatch(noColor.output, /\x1b\[32m/)
  assert.match(noColor.output, /\r\x1b\[2K/)
})

test('worker _update preserva o fluxo local quando updateCli está desabilitado', t => {
  const f = detectedClaude(t, 'prumo-cli-worker-update-')
  installHarness(f, 'claude')
  disableDashboard(f.home)
  const request = {
    dryRun: false,
    cwd: f.project,
    projects: [],
    updateCli: false,
    sourceVersion: packageVersion,
    globalVersion: null,
  }
  const result = runCli(f.home, ['_update'], {
    ...preloadEnvironment(f.home, { dashboard: true }),
    PRUMO_UPDATE_REQUEST: JSON.stringify(request),
  }, f.project)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /Prumo updated successfully/)
  assert.equal(existsSync(join(f.home, '.local', 'share', 'prumo', 'update-pending.json')), false)

  const preview = runCli(f.home, ['_update'], {
    ...preloadEnvironment(f.home, { dashboard: true }),
    PRUMO_UPDATE_REQUEST: JSON.stringify({ ...request, dryRun: true }),
  }, f.project)
  assert.equal(preview.status, 0, preview.output)
  assert.match(preview.output, /Dashboard remains disabled by user preference/)
})

test('worker _update preserva idiomas e dados ao recuperar atualização interrompida', t => {
  const f = detectedHome(t, 'prumo-cli-worker-recovery-', ['claude', 'kiro'])
  installHarness(f, 'claude')
  const kiro = applyInstall(planInstall({ harness: 'kiro', home: f.home, cwd: f.project, env: f.env, lang: 'pt-BR' }))
  assert.ok(kiro.groups.every(group => group.status !== 'conflict'))
  disableDashboard(f.home)
  const data = join(f.home, 'data', 'estado-do-usuario.json')
  mkdirSync(dirname(data), { recursive: true })
  writeFileSync(data, '{"valor":"preservado"}\n')
  const legacyState = join(f.home, '.local', 'share', 'graph-foreman', 'resgate', '.specs', 'graph', 'resgate', 'state.json')
  mkdirSync(dirname(legacyState), { recursive: true })
  writeFileSync(legacyState, '{"historico":"preservado"}\n')
  const claudeMarker = join(f.home, '.claude', 'skills', 'prumo', '.prumo-install.json')
  writeFileSync(claudeMarker, JSON.stringify({ ...JSON.parse(readFileSync(claudeMarker, 'utf8')), version: '1.3.16' }))
  const checkpoint = join(f.home, '.local', 'share', 'prumo', 'update-pending.json')
  writeFileSync(checkpoint, JSON.stringify({ fromVersions: ['1.0.0'], toVersion: packageVersion }))
  const request = { dryRun: false, cwd: f.project, projects: [], updateCli: false, sourceVersion: packageVersion }
  const updated = runCli(f.home, ['_update'], {
    ...preloadEnvironment(f.home, { dashboard: true }),
    PRUMO_UPDATE_REQUEST: JSON.stringify(request),
  }, f.project)
  assert.equal(updated.status, 0, updated.output)
  assert.match(updated.output, /Prumo updated successfully/)
  for (const [harness, lang] of [['claude', 'en'], ['kiro', 'pt-BR']]) {
    const marker = JSON.parse(readFileSync(join(f.home, `.${harness}`, 'skills', 'prumo', '.prumo-install.json'), 'utf8'))
    assert.equal(marker.lang, lang, 'a atualização mantém o idioma salvo de cada instalação')
    assert.equal(marker.version, packageVersion)
  }
  assert.equal(readFileSync(data, 'utf8'), '{"valor":"preservado"}\n')
  assert.equal(readFileSync(join(f.home, 'data', 'resgate', '.specs', 'graph', 'resgate', 'state.json'), 'utf8'), '{"historico":"preservado"}\n')
  assert.equal(readFileSync(legacyState, 'utf8'), '{"historico":"preservado"}\n', 'a recuperação preserva também a origem que pode pertencer ao graph-foreman')
  assert.equal(existsSync(checkpoint), false, 'a recuperação concluída remove apenas seu checkpoint')
})

test('worker _update mantém checkpoint e configuração conflitante para nova tentativa', t => {
  const f = detectedClaude(t, 'prumo-cli-worker-conflict-')
  installHarness(f, 'claude')
  disableDashboard(f.home)
  const settings = join(f.home, '.claude', 'settings.json')
  writeFileSync(settings, '[]\n')
  const request = { dryRun: false, cwd: f.project, projects: [], updateCli: false, sourceVersion: packageVersion }
  const failed = runCli(f.home, ['_update'], {
    ...preloadEnvironment(f.home, { dashboard: true }),
    PRUMO_UPDATE_REQUEST: JSON.stringify(request),
  }, f.project)
  assert.equal(failed.status, 2, failed.output)
  assert.match(failed.output, /Expected a settings object/)
  assert.match(failed.output, /Update incomplete/)
  assert.doesNotMatch(failed.output, /Prumo updated successfully/)
  assert.equal(readFileSync(settings, 'utf8'), '[]\n')
  const checkpoint = JSON.parse(readFileSync(join(f.home, '.local', 'share', 'prumo', 'update-pending.json'), 'utf8'))
  assert.equal(checkpoint.toVersion, packageVersion)
  assert.ok(checkpoint.fromVersions.includes(packageVersion))
})

test('worker _update em prévia sem instalação informa ausência sem criar checkpoint', t => {
  const home = temporaryHome(t, 'prumo-cli-worker-empty-')
  disableDashboard(home)
  const result = runCli(home, ['_update'], {
    ...preloadEnvironment(home, { dashboard: true }),
    PRUMO_UPDATE_REQUEST: JSON.stringify({ dryRun: true, cwd: home, projects: [], updateCli: true, sourceVersion: packageVersion }),
  })
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /Would update global Prumo CLI/)
  assert.match(result.output, /No Prumo installations found/)
  assert.equal(existsSync(join(home, '.local', 'share', 'prumo', 'update-pending.json')), false)
})

test('CLI exibe versão e ajuda e recusa Node incompatível antes de alterar arquivos', t => {
  const home = temporaryHome(t, 'prumo-cli-entrypoint-')
  const version = runCli(home, ['--version'])
  assert.equal(version.status, 0, version.output)
  assert.equal(version.stdout.trim(), packageVersion)
  for (const args of [[], ['--help']]) {
    const help = runCli(home, args)
    assert.equal(help.status, 0, help.output)
    assert.match(help.stdout, /prumo install.*prumo update/s)
  }
  const unsupported = runCli(home, ['--version'], preloadEnvironment(home, { nodeVersion: '20.0.0' }))
  assert.equal(unsupported.status, 1, unsupported.output)
  assert.match(unsupported.stderr, /requires Node.js 22 or newer/)
  assert.equal(existsSync(join(home, '.local', 'share', 'prumo')), false)
})

test('dashboard logs mantém detalhes e valores ausentes sem escrever no log', t => {
  const home = temporaryHome(t, 'prumo-cli-dashboard-logs-')
  disableDashboard(home)
  const extra = preloadEnvironment(home, { dashboard: true })
  const empty = runCli(home, ['dashboard', 'logs'], extra)
  assert.equal(empty.status, 0, empty.output)
  assert.match(empty.stdout, /No dashboard events recorded/)
  const file = join(home, '.local', 'share', 'prumo', 'dashboard-events.ndjson')
  const events = [{ event: 'incomplete' }, { event: 'signal', at: 'instante', pid: 321, signal: 'SIGTERM' },
    { event: 'exit', code: 0 }, { event: 'warning', message: 'mensagem preservada' }]
  const bytes = events.map(event => JSON.stringify(event)).join('\n') + '\n'
  writeFileSync(file, bytes)
  const logged = runCli(home, ['dashboard', 'logs'], extra)
  assert.equal(logged.status, 0, logged.output)
  assert.match(logged.stdout, /unknown time  incomplete  pid=\?/)
  assert.match(logged.stdout, /instante  signal  pid=321  SIGTERM/)
  assert.match(logged.stdout, /exit  pid=\?  0/)
  assert.match(logged.stdout, /mensagem preservada/)
  assert.equal(readFileSync(file, 'utf8'), bytes)
})

test('status e worker reportam marcador inválido e continuam as instalações válidas', t => {
  const f = detectedHome(t, 'prumo-cli-invalid-marker-', ['claude', 'kiro'])
  installHarness(f, 'claude')
  installHarness(f, 'kiro')
  disableDashboard(f.home)
  const marker = join(f.home, '.claude', 'skills', 'prumo', '.prumo-install.json')
  writeFileSync(marker, '{')
  const status = runCli(f.home, ['status', '--verify-install'], {}, f.project)
  assert.equal(status.status, 2, status.output)
  assert.match(status.stderr, /Invalid Prumo installation marker/)
  assert.match(status.stdout, /kiro: version/)
  const updated = runCli(f.home, ['_update'], {
    ...preloadEnvironment(f.home, { dashboard: true }),
    PRUMO_UPDATE_REQUEST: JSON.stringify({ dryRun: false, cwd: f.project, projects: [], updateCli: false, sourceVersion: packageVersion }),
  }, f.project)
  assert.equal(updated.status, 2, updated.output)
  assert.match(updated.stderr, /Invalid Prumo installation marker/)
  assert.match(updated.stdout, /Update incomplete/)
  assert.equal(readFileSync(marker, 'utf8'), '{')
  assert.equal(JSON.parse(readFileSync(join(f.home, '.kiro', 'skills', 'prumo', '.prumo-install.json'), 'utf8')).version, packageVersion)
})

test('update atual informa versão corrente e prévia de reparo do dashboard sem lançar worker', t => {
  const f = detectedClaude(t, 'prumo-cli-update-current-')
  installHarness(f, 'claude')
  disableDashboard(f.home)
  const globalRoot = join(f.home, 'npm-global', 'node_modules')
  const metadata = join(globalRoot, '@henri-ralmeida', 'prumo', 'package.json')
  mkdirSync(dirname(metadata), { recursive: true })
  writeFileSync(metadata, JSON.stringify({ name: '@henri-ralmeida/prumo', version: packageVersion }))
  const preload = join(f.home, 'npm-current.mjs')
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (args.includes('root') && args.includes('--global')) return { status: 0, stdout: ${JSON.stringify(globalRoot)}, stderr: '' };
  if (args.includes('view')) return { status: 0, stdout: ${JSON.stringify(JSON.stringify(packageVersion))}, stderr: '' };
  return original(command, args, options);
};
childProcess.spawn = () => { throw new Error('a atualização corrente não pode lançar worker'); };
syncBuiltinESMExports();\n`)
  const extra = preloadEnvironment(f.home, { dashboard: true })
  extra.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`
  const current = runCli(f.home, ['update'], extra, f.project)
  assert.equal(current.status, 0, current.output)
  assert.match(current.stdout, new RegExp(`Prumo is already up to date v${packageVersion.replaceAll('.', '\\.')}`))
  const preference = join(f.home, '.local', 'share', 'prumo', 'dashboard.json')
  writeFileSync(preference, JSON.stringify({ enabled: true }))
  const repair = runCli(f.home, ['update', '--dry-run'], extra, f.project)
  assert.equal(repair.status, 0, repair.output)
  assert.match(repair.stdout, /Would restart the enabled Prumo dashboard/)
  assert.equal(JSON.parse(readFileSync(preference, 'utf8')).enabled, true)
})
