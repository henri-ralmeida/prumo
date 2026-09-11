import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  npm_config_cache: join(home, 'npm-cache'), npm_config_userconfig: join(home, 'npmrc'), npm_config_prefix: globalPrefix, BUN_INSTALL_CACHE_DIR: join(home, 'bun-cache') }
delete env.PRUMO_ROOT
delete env.GRAPH_ROOT
delete env.GRAPH_FOREMAN_HOME
const evidence = []
let registry
function run(executable, args, success = true) {
  // npm.cmd needs cmd.exe on Windows. Arguments here are fixed test literals.
  const command = process.platform === 'win32' && (executable === 'npm' || executable.endsWith('.cmd'))
    ? { executable: process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', executable, ...args] }
    : { executable, args }
  const result = spawnSync(command.executable, command.args, { cwd, env, encoding: 'utf8', timeout: 120000, windowsHide: true })
  evidence.push({ command: [executable, ...args], status: result.status, stdout: result.stdout, stderr: result.stderr })
  assert.ifError(result.error)
  if (success) assert.equal(result.status, 0, result.stdout + result.stderr)
  else assert.notEqual(result.status, 0, 'Registry failure must not report success')
  return result.stdout
}
try {
  run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'])
  assert.match(run('npm', ['exec', '--offline', '--', 'prumo', '--version']), new RegExp(version.replaceAll('.', '\\.')))
  assert.match(run('bun', ['x', '--no-install', 'prumo', '--version']), new RegExp(version.replaceAll('.', '\\.')))
  const requestFile = join(home, 'registry-requests')
  const failureFile = join(home, 'registry-failure')
  registry = fork(join(root, 'test', 'fixtures', 'update-registry.mjs'), [], { silent: true, env: { ...env, PRUMO_TEST_PACKAGE: join(root, 'package.json'), PRUMO_TEST_ARCHIVE: archive, PRUMO_TEST_REQUESTS: requestFile, PRUMO_TEST_FAILURE: failureFile } })
  const address = await new Promise((resolve, reject) => { registry.once('message', resolve); registry.once('error', reject); registry.once('exit', () => reject(new Error('Test registry exited before startup'))) })
  env.npm_config_registry = address.url
  env.npm_config_fetch_retries = '0'
  for (const harness of ['claude', 'kiro', 'codex']) mkdirSync(join(home, `.${harness}`), { recursive: true })
  assert.match(run('npm', ['exec', '--offline', '--', 'prumo', 'install', '--dry-run']), /Detected environments: claude, kiro, codex/)
  assert.equal(existsSync(join(home, '.local', 'share', 'prumo')), false)
  run('bun', ['x', '--no-install', 'prumo', 'install', '--all', '--lang', 'pt-BR'])
  assert.equal(JSON.parse(readFileSync(join(globalPackage, 'package.json'), 'utf8')).version, version)
  assert.match(run(globalExecutable, ['-v']), new RegExp(version.replaceAll('.', '\\.')))
  assert.doesNotMatch(evidence.at(-1).stderr, /DEP0190/)
  run('npm', ['exec', '--offline', '--', 'prumo', 'install', '--claude', '--lang', 'pt-BR'])
  assert.equal(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).outputStyle, 'PO First')
  assert.match(readFileSync(join(home, '.kiro', 'steering', 'po-first.md'), 'utf8'), /inclusion: always/)
  assert.match(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), /<!-- po-first:start -->/)
  for (const harness of ['.claude', '.kiro', '.agents']) {
    const skill = join(home, harness, 'skills', 'prumo')
    for (const file of ['SKILL.md', 'scripts/engine.mjs', 'scripts/serve.mjs', 'scripts/validation.mjs', 'scripts/storage.mjs', 'scripts/dashboard.html']) {
      assert.ok(existsSync(join(skill, file)), `${harness} installation must contain ${file}`)
    }
  }
  const reinstallBackups = readdirSync(join(home, '.local', 'share', 'prumo', 'backups')).length
  assert.match(run(globalExecutable, ['install', '--all']), new RegExp(`Prumo v${version.replaceAll('.', '\\.')} is already installed`))
  assert.equal(readdirSync(join(home, '.local', 'share', 'prumo', 'backups')).length, reinstallBackups)
  console.log('Packaged npm and Bun entrypoints previewed automatic detection and installed all three adapters into an isolated home')
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
  assert.doesNotMatch(updateOutput, /Changes \/|Existing data stays|Backup:/)
  assert.doesNotMatch(evidence.at(-1).stderr, /DEP0190/)
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
