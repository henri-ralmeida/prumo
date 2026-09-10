import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const archive = join(root, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)
const base = realpathSync(tmpdir())
const home = mkdtempSync(join(base, 'prumo-package-'))
const cwd = join(home, 'project')
mkdirSync(join(cwd, '.git'), { recursive: true })
writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'prumo-package-smoke', private: true, dependencies: { [name]: `file:${archive.replace(/\\/g, '/')}` } }))
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PRUMO_HOME: join(home, 'data'), PRUMO_LANG: 'en',
  npm_config_cache: join(home, 'npm-cache'), npm_config_userconfig: join(home, 'npmrc'), BUN_INSTALL_CACHE_DIR: join(home, 'bun-cache') }
delete env.PRUMO_ROOT
delete env.GRAPH_ROOT
delete env.GRAPH_FOREMAN_HOME
const evidence = []
function run(executable, args) {
  // npm.cmd needs cmd.exe on Windows. Arguments here are fixed literals, never user input.
  const result = spawnSync(executable, args, { cwd, env, shell: process.platform === 'win32' && executable === 'npm', encoding: 'utf8', timeout: 120000, windowsHide: true })
  evidence.push({ command: [executable, ...args], status: result.status, stdout: result.stdout, stderr: result.stderr })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  return result.stdout
}
try {
  run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'])
  assert.match(run('npm', ['exec', '--offline', '--', 'prumo', '--version']), new RegExp(version.replaceAll('.', '\\.')))
  assert.match(run('bun', ['x', '--no-install', 'prumo', '--version']), new RegExp(version.replaceAll('.', '\\.')))
  run('npm', ['exec', '--offline', '--', 'prumo', 'install', '--claude', '--lang', 'pt-BR'])
  run('bun', ['x', '--no-install', 'prumo', 'install', '--kiro'])
  run('npm', ['exec', '--offline', '--', 'prumo', 'install', '--codex'])
  assert.equal(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).outputStyle, 'PO First')
  assert.match(readFileSync(join(home, '.kiro', 'steering', 'po-first.md'), 'utf8'), /inclusion: always/)
  assert.match(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), /<!-- po-first:start -->/)
  console.log('Packaged npm and Bun entrypoints installed all three adapters into an isolated home')
} finally {
  mkdirSync(join(root, '.test-output'), { recursive: true })
  // Paths in transient command output are local evidence, excluded from the published package.
  writeFileSync(join(root, '.test-output', 'package-smoke.json'), JSON.stringify({ platform: process.platform, node: process.version, evidence }, null, 2))
  assert.equal(dirname(home), base)
  assert.ok(home.startsWith(join(base, 'prumo-package-')))
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
