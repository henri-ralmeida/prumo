import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, delimiter } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync, fork } from 'node:child_process'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const archive = join(root, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)
const base = realpathSync(tmpdir())
const home = mkdtempSync(join(base, 'prumo-package-'))
const cwd = join(home, 'project')
const globalPrefix = join(home, 'npm-global')
const globalPackage = join(globalPrefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@henri-ralmeida', 'prumo')
const globalExecutable = process.platform === 'win32' ? join(globalPrefix, 'prumo.cmd') : join(globalPrefix, 'bin', 'prumo')
mkdirSync(join(cwd, '.git'), { recursive: true })
writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'prumo-package-smoke', private: true, dependencies: { [name]: `file:${archive.replace(/\\/g, '/')}` } }))
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PRUMO_HOME: join(home, 'data'), PRUMO_LANG: 'en',
  APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  npm_config_cache: join(home, 'npm-cache'), npm_config_userconfig: join(home, 'npmrc'), npm_config_prefix: globalPrefix, BUN_INSTALL_CACHE_DIR: join(home, 'bun-cache') }
delete env.PRUMO_ROOT
delete env.GRAPH_ROOT
delete env.GRAPH_FOREMAN_HOME
const evidence = []
let registry
function run(executable, args, success = true, runEnv = env, runCwd = cwd) {
  // npm.cmd needs cmd.exe on Windows. Arguments here are fixed test literals.
  const command = process.platform === 'win32' && (executable === 'npm' || executable.endsWith('.cmd'))
    ? { executable: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', executable, ...args] }
    : { executable, args }
  const result = spawnSync(command.executable, command.args, { cwd: runCwd, env: runEnv, encoding: 'utf8', timeout: 120000, windowsHide: true })
  evidence.push({ command: [executable, ...args], status: result.status, stdout: result.stdout, stderr: result.stderr })
  assert.ifError(result.error)
  if (success) assert.equal(result.status, 0, result.stdout + result.stderr)
  else assert.notEqual(result.status, 0, 'Registry failure must not report success')
  return result.stdout
}
try {
  run('npm', ['install', '--offline', '--no-audit', '--no-fund'])
  assert.equal(existsSync(join(home, '.local', 'share', 'prumo')), false, 'local postinstall must be inert')
  assert.match(run('npm', ['exec', '--offline', '--', 'prumo', '--version']), new RegExp(version.replaceAll('.', '\\.')))
  assert.match(run('npm', ['exec', '--offline', '--', 'prumo', '--help']), /prumo migrate \[--check\] \[--run <name>\]/)
  assert.match(run('bun', ['x', '--no-install', 'prumo', '--version']), new RegExp(version.replaceAll('.', '\\.')))
  const requestFile = join(home, 'registry-requests')
  const failureFile = join(home, 'registry-failure')
  registry = fork(join(root, 'test', 'fixtures', 'update-registry.mjs'), [], { silent: true, env: { ...env, PRUMO_TEST_PACKAGE: join(root, 'package.json'), PRUMO_TEST_ARCHIVE: archive, PRUMO_TEST_REQUESTS: requestFile, PRUMO_TEST_FAILURE: failureFile } })
  const address = await new Promise((resolve, reject) => { registry.once('message', resolve); registry.once('error', reject); registry.once('exit', () => reject(new Error('Test registry exited before startup'))) })
  env.npm_config_registry = address.url
  env.npm_config_fetch_retries = '0'
  for (const harness of ['claude', 'kiro', 'codex']) mkdirSync(join(home, `.${harness}`), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  writeFileSync(join(home, '.codex', 'config.toml'), '')
  mkdirSync(join(home, '.kiro', 'steering'), { recursive: true })
  writeFileSync(join(home, '.kiro', 'steering', 'project.md'), '# Project guidance')
  assert.match(run('npm', ['exec', '--offline', '--', 'prumo', 'install', '--dry-run']), /Detected environments: claude, kiro, codex/)
  assert.equal(existsSync(join(home, '.local', 'share', 'prumo')), false)
  const autoHome = join(home, 'automatic-global')
  const autoPrefix = join(autoHome, 'npm-global')
  const autoPackage = join(autoPrefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@henri-ralmeida', 'prumo')
  const autoEvents = join(autoHome, 'autostart-events')
  const preload = join(autoHome, 'safe-autostart.mjs')
  mkdirSync(join(autoHome, '.codex'), { recursive: true })
  writeFileSync(join(autoHome, '.codex', 'config.toml'), '')
  writeFileSync(preload, `
import childProcess from 'node:child_process'
import net from 'node:net'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
if (process.argv[1]?.replaceAll('\\\\', '/').endsWith('/bin/prumo.mjs')) {
  let registered = false
  let running = false
  const original = childProcess.execFileSync
  const originalSpawn = childProcess.spawn
  childProcess.execFileSync = (file, args, options) => {
    const name = String(file).toLowerCase()
    if (name.endsWith('powershell.exe') && args.at(-1).includes("Name = 'node.exe'")) return '49490'
    if (name.endsWith('powershell.exe') && args.at(-1).includes('ProcessId = 49490')) {
      const script = join(dirname(process.argv[1]), '..', 'scripts', 'serve.mjs')
      return JSON.stringify({ executable: process.execPath, commandLine: [process.execPath, script, '--global', '--port', '4949'].map(value => '"' + value + '"').join(' ') })
    }
    if (!['schtasks', 'launchctl', 'systemctl'].includes(name)) return original(file, args, options)
    appendFileSync(${JSON.stringify(autoEvents)}, JSON.stringify([name, args]) + '\\n')
    if (name === 'schtasks' && args[0] === '/Query' && !registered) { const error = new Error('missing'); error.status = 1; throw error }
    if (name === 'schtasks' && args[0] === '/Create') { const error = new Error('simulated scheduler denial'); error.status = 5; error.stderr = Buffer.from('denied'); throw error }
    if ((name === 'schtasks' && args[0] === '/Run') || (name === 'launchctl' && args[0] === 'kickstart') ||
        (name === 'systemctl' && args.join(' ') === '--user enable --now prumo-dashboard.service')) running = true
    return ''
  }
  childProcess.spawn = (file, args, options) => {
    if (args?.some(value => String(value).includes('@henri-ralmeida/prumo@'))) throw new Error('recursive global update attempted during postinstall')
    if (String(args?.[0] ?? '').replaceAll('\\\\', '/').endsWith('/scripts/serve.mjs')) {
      appendFileSync(${JSON.stringify(autoEvents)}, JSON.stringify(['spawn', file, args, options?.cwd]) + '\\n')
      running = true
      return { pid: 49490, unref() {} }
    }
    return originalSpawn(file, args, options)
  }
  net.createServer = () => ({
    unref() { return this },
    once() { return this },
    listen(port, host, ready) { ready(); return this },
    close(done) { done() },
  })
  globalThis.fetch = async () => {
    if (!running) throw new Error('stopped')
    return { ok: true, json: async () => ({ product: 'prumo', version: '1.3.0', mode: 'global', readOnly: true }) }
  }
  syncBuiltinESMExports()
}
`)
  const autoEnv = { ...env, HOME: autoHome, USERPROFILE: autoHome, CODEX_HOME: join(autoHome, '.codex'),
    APPDATA: join(autoHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(autoHome, 'AppData', 'Local'),
    PRUMO_HOME: join(autoHome, 'data'), npm_config_prefix: autoPrefix,
    npm_config_cache: join(autoHome, 'npm-cache'), NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }
  delete autoEnv.CLAUDE_CONFIG_DIR
  for (const key of Object.keys(autoEnv)) if (/^path$/i.test(key)) delete autoEnv[key]
  autoEnv.PATH = [dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(delimiter)
  mkdirSync(autoPackage, { recursive: true })
  writeFileSync(join(autoPackage, 'package.json'), JSON.stringify({ name, version: '1.2.2' }))
  run('npm', ['install', '--global', '--force', '--offline', '--no-audit', '--no-fund', archive], true, autoEnv)
  assert.ok(existsSync(join(autoHome, '.agents', 'skills', 'prumo', 'SKILL.md')), 'global postinstall configures the detected harness')
  assert.equal(JSON.parse(readFileSync(join(autoHome, '.local', 'share', 'prumo', 'dashboard.json'), 'utf8')).enabled, true)
  const startupCalls = readFileSync(autoEvents, 'utf8')
  assert.ok(process.platform === 'win32' ? startupCalls.includes('"spawn"') :
    process.platform === 'darwin' ? startupCalls.includes('kickstart') : startupCalls.includes('enable","--now'))
  if (process.platform === 'win32') {
    const detached = startupCalls.trim().split('\n').map(line => JSON.parse(line)).find(call => call[0] === 'spawn')
    assert.equal(detached?.[3], join(autoHome, '.local', 'share', 'prumo'), 'detached dashboard uses stable user data cwd')
  }
  assert.equal(JSON.parse(readFileSync(join(autoPackage, 'package.json'), 'utf8')).version, version)
  mkdirSync(join(home, '.local', 'share', 'prumo'), { recursive: true })
  writeFileSync(join(home, '.local', 'share', 'prumo', 'dashboard.json'), JSON.stringify({ enabled: false, mechanism: process.platform === 'win32' ? 'schtasks' : process.platform === 'darwin' ? 'launchd' : 'xdg' }))
  const legacyCodex = join(home, '.agents', 'skills', 'prumo')
  mkdirSync(legacyCodex, { recursive: true })
  writeFileSync(join(legacyCodex, '.prumo-install.json'), JSON.stringify({ product: 'prumo', version: '0.0.9', harness: 'codex', lang: 'en' }))
  assert.match(run('npm', ['exec', '--', 'prumo', 'update', '--dry-run']), /Would update global Prumo CLI/)
  assert.equal(existsSync(globalPackage), false)
  run('npm', ['exec', '--', 'prumo', 'update'])
  assert.equal(JSON.parse(readFileSync(join(globalPackage, 'package.json'), 'utf8')).version, version)
  assert.equal(JSON.parse(readFileSync(join(legacyCodex, '.prumo-install.json'), 'utf8')).version, version)
  assert.equal(existsSync(join(home, '.claude', 'skills', 'prumo')), false, '--ignore-scripts leaves harness setup pending')
  run(globalExecutable, ['install', '--all', '--lang', 'pt-BR'])
  assert.equal(JSON.parse(readFileSync(join(globalPackage, 'package.json'), 'utf8')).version, version)
  assert.match(run(globalExecutable, ['-v']), new RegExp(version.replaceAll('.', '\\.')))
  assert.doesNotMatch(evidence.at(-1).stderr, /DEP0190/)
  run('npm', ['exec', '--offline', '--', 'prumo', 'install', '--claude', '--lang', 'pt-BR'])
  assert.equal(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).outputStyle, 'PO First')
  assert.match(readFileSync(join(home, '.kiro', 'steering', 'po-first.md'), 'utf8'), /inclusion: always/)
  assert.match(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), /<!-- po-first:start -->/)
  for (const harness of ['.claude', '.kiro', '.agents']) {
    const skill = join(home, harness, 'skills', 'prumo')
    for (const file of ['SKILL.md', 'scripts/engine.mjs', 'scripts/serve.mjs', 'scripts/validation.mjs', 'scripts/atomic-state.mjs', 'scripts/storage.mjs', 'scripts/dashboard.html']) {
      assert.ok(existsSync(join(skill, file)), `${harness} installation must contain ${file}`)
    }
  }
  rmSync(join(home, '.kiro', 'skills', 'prumo'), { recursive: true, force: true })
  run('npm', ['install', '--global', '--force', '--offline', '--no-audit', '--no-fund', archive])
  assert.ok(existsSync(join(home, '.kiro', 'skills', 'prumo', 'SKILL.md')), 'global postinstall configures detected harnesses')
  const reinstallBackups = readdirSync(join(home, '.local', 'share', 'prumo', 'backups')).length
  assert.match(run(globalExecutable, ['install', '--all']), new RegExp(`Prumo v${version.replaceAll('.', '\\.')} is already installed`))
  assert.equal(readdirSync(join(home, '.local', 'share', 'prumo', 'backups')).length, reinstallBackups)
  console.log('Packaged npm and Bun entrypoints configured all adapters and exercised safe automatic dashboard startup in an isolated home')
  const installedRoots = [join(home, '.claude', 'skills', 'prumo'), join(home, '.kiro', 'skills', 'prumo'), join(home, '.agents', 'skills', 'prumo')]
  for (const destination of installedRoots) {
    const markerPath = join(destination, '.prumo-install.json')
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    marker.version = '0.0.9'
    writeFileSync(markerPath, JSON.stringify(marker))
    writeFileSync(join(destination, 'scripts', 'engine.mjs'), '// previous engine\n')
    writeFileSync(join(destination, 'SKILL.md'), '# Previous instructions\n')
  }
  const globalPackageJson = join(globalPackage, 'package.json')
  const oldGlobal = JSON.parse(readFileSync(globalPackageJson, 'utf8'))
  writeFileSync(globalPackageJson, JSON.stringify({ ...oldGlobal, version: '0.0.9' }))
  run(globalExecutable, ['update', '--dry-run'])
  for (const destination of installedRoots) {
    assert.equal(JSON.parse(readFileSync(join(destination, '.prumo-install.json'), 'utf8')).version, '0.0.9')
    assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), '# Previous instructions\n')
  }
  assert.equal(JSON.parse(readFileSync(globalPackageJson, 'utf8')).version, '0.0.9')
  const updateOutput = run(globalExecutable, ['update'])
  assert.match(updateOutput, /Prumo updated successfully|Prumo atualizado com sucesso/)
  assert.match(updateOutput, new RegExp(`Prumo v${version.replaceAll('.', '\\.')}`))
  assert.doesNotMatch(updateOutput, /Changes \/|Existing data stays|Backup:/)
  assert.doesNotMatch(evidence.at(-1).stderr, /DEP0190|npm notice/)
  assert.ok(Number(readFileSync(requestFile, 'utf8')) > 0, 'Update must resolve the latest package from the registry')
  assert.equal(JSON.parse(readFileSync(globalPackageJson, 'utf8')).version, version)
  assert.match(run(globalExecutable, ['-v']), new RegExp(version.replaceAll('.', '\\.')))
  for (const destination of installedRoots) {
    assert.equal(JSON.parse(readFileSync(join(destination, '.prumo-install.json'), 'utf8')).version, version)
    assert.equal(readFileSync(join(destination, 'scripts', 'engine.mjs'), 'utf8'), readFileSync(join(root, 'scripts', 'engine.mjs'), 'utf8'))
    assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), readFileSync(join(root, 'SKILL.md'), 'utf8'))
  }
  const backupCount = readdirSync(join(home, '.local', 'share', 'prumo', 'backups')).length
  writeFileSync(failureFile, '503')
  run('bun', ['x', '--no-install', 'prumo', 'update'], false)
  assert.equal(readdirSync(join(home, '.local', 'share', 'prumo', 'backups')).length, backupCount)
  for (const destination of installedRoots) {
    assert.equal(readFileSync(join(destination, 'scripts', 'engine.mjs'), 'utf8'), readFileSync(join(root, 'scripts', 'engine.mjs'), 'utf8'))
    assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), readFileSync(join(root, 'SKILL.md'), 'utf8'))
  }
  console.log('Public update refreshed the global CLI and three installed adapters from an isolated registry; preview and registry failure preserved existing files')
} finally {
  if (registry && registry.exitCode === null && registry.signalCode === null) { const closed = new Promise(resolve => registry.once('exit', resolve)); registry.kill(); await closed }
  mkdirSync(join(root, '.test-output'), { recursive: true })
  // Paths in transient command output are local evidence, excluded from the published package.
  writeFileSync(join(root, '.test-output', 'package-smoke.json'), JSON.stringify({ platform: process.platform, node: process.version, evidence }, null, 2))
  assert.equal(dirname(home), base)
  assert.ok(home.startsWith(join(base, 'prumo-package-')))
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
