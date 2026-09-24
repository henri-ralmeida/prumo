import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, cpSync, realpathSync, chmodSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { planInstall, applyInstall, restoreInstall, installationStatus, detectHarnesses, discoverInstallations, reconcileDashboardInstall } from '../lib/install.mjs'
import { runPostinstall } from '../scripts/postinstall.mjs'
import { inside, findRoot, storageHome, graphRoots } from '../scripts/storage.mjs'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }
const read = path => readFileSync(path, 'utf8')
const packageVersion = JSON.parse(read(join(source, 'package.json'))).version

function fixture(t, harness = 'claude') {
  const parent = realpathSync(tmpdir())
  const home = mkdtempSync(join(parent, 'prumo-install-'))
  const cwd = join(home, 'project with spaces')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  t.after(() => { assert.equal(dirname(home), parent); assert.ok(home.startsWith(join(parent, 'prumo-install-'))); rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }) })
  const options = { harness, home, cwd, env: {}, lang: 'en' }
  const config = join(home, `.${harness}`)
  const skillRoot = harness === 'codex' ? join(home, '.agents', 'skills') : join(config, 'skills')
  function plan(extra = {}) {
    const result = planInstall({ ...options, ...extra })
    // Fail before applying if a fixture accidentally discovers any real user installation.
    for (const item of result.groups.flatMap(group => group.changes)) assert.ok(inside(home, item.file), item.file)
    return result
  }
  const install = () => { const result = applyInstall(plan()); assert.ok(result.groups.every(group => group.status !== 'conflict'), JSON.stringify(result)); return result }
  return { home, cwd, options, config, skillRoot, plan, install }
}

test('dashboard root names keep the selected legacy workspace unambiguous', t => {
  const f = fixture(t)
  const root = join(f.home, 'project', 'work')
  const central = join(f.home, 'data')
  for (const path of [root, join(central, 'work'), join(central, 'work-2')]) mkdirSync(join(path, '.specs', 'graph'), { recursive: true })
  const roots = graphRoots(root, central)
  assert.equal(roots.find(item => item.name === 'work').path, root)
  assert.equal(new Set(roots.map(item => item.name)).size, 3)
  assert.equal(new Set(roots.map(item => item.path)).size, 3)
  assert.deepEqual(graphRoots(root, central), roots)
})

function isolatedCli(f) {
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), CODEX_HOME: join(f.home, '.codex'), DSH_HOME: join(f.home, '.dsh'), PRUMO_HOME: join(f.home, 'data'), PRUMO_LANG: 'en' }
  for (const key of Object.keys(env)) if (/^path$/i.test(key) || ['GRAPH_ROOT', 'PRUMO_ROOT', 'GRAPH_FOREMAN_HOME'].includes(key)) delete env[key]
  const commands = join(f.home, 'test-commands')
  const commandLog = join(f.home, 'npm-commands')
  const npm = join(commands, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  put(npm, process.platform === 'win32' ? `@echo %*>>"${commandLog}"\r\n@exit /b 0\r\n` : `#!/bin/sh\nprintf '%s\\n' "$*" >> '${commandLog}'\n`)
  chmodSync(npm, 0o755)
  env.PATH = commands
  if (process.platform === 'win32') env.PATHEXT = '.CMD;.EXE'
  const invoke = (args, extraEnv = {}) => spawnSync(process.execPath, [join(source, 'bin', 'prumo.mjs'), ...args], { cwd: f.cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 20000, windowsHide: true })
  invoke.commandLog = commandLog
  return invoke
}

function snapshotTree(root) {
  const entries = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      const name = relative(root, path)
      if (entry.isDirectory()) {
        entries.push({ name, type: 'directory' })
        visit(path)
      } else if (entry.isFile()) entries.push({ name, type: 'file', bytes: readFileSync(path).toString('hex') })
      else entries.push({ name, type: 'other' })
    }
  }
  visit(root)
  return entries
}

test('automatic detection uses existing configuration, local legacy skills and executable paths without running them', t => {
  const f = fixture(t)
  const options = { home: f.home, cwd: f.cwd, env: {} }
  put(join(f.home, '.agents', 'skills', 'shared', 'SKILL.md'), 'Shared skills do not identify a harness')
  for (const name of ['.claude', '.kiro', '.codex']) mkdirSync(join(f.home, name), { recursive: true })
  assert.deepEqual(detectHarnesses(options), [], 'empty harness directories are not installations')
  const claudeSettings = join(f.home, '.claude', 'settings.json')
  const kiroSettings = join(f.home, '.kiro', 'settings', 'cli.json')
  const codexSettings = join(f.home, '.codex', 'config.toml')
  put(claudeSettings, {})
  put(kiroSettings, {})
  assert.deepEqual(detectHarnesses(options), ['claude', 'kiro'])
  put(codexSettings, 'model = "gpt"')
  assert.deepEqual(detectHarnesses(options), ['claude', 'kiro', 'codex'])
  for (const file of [claudeSettings, kiroSettings, codexSettings]) rmSync(file)
  put(join(f.home, '.agents', 'skills', 'graph-foreman', 'SKILL.md'), 'A shared legacy skill does not identify Codex')
  assert.deepEqual(detectHarnesses(options), [])
  const customKiro = join(f.home, 'custom-kiro')
  mkdirSync(customKiro)
  options.env.KIRO_HOME = customKiro
  assert.deepEqual(detectHarnesses(options), [], 'an empty KIRO_HOME is not an installation')
  put(join(customKiro, 'settings', 'cli.json'), {})
  assert.deepEqual(detectHarnesses(options), ['kiro'])
  delete options.env.KIRO_HOME
  const custom = join(f.home, 'custom-codex')
  mkdirSync(custom)
  options.env.CODEX_HOME = custom
  put(join(f.cwd, '.claude', 'skills', 'graph-foreman', 'SKILL.md'), 'old skill')
  assert.deepEqual(detectHarnesses(options), ['claude', 'codex'])
  const commands = join(f.home, 'commands with spaces')
  const binary = join(commands, process.platform === 'win32' ? 'kiro.cmd' : 'kiro')
  put(binary, 'THIS IS NOT AN EXECUTABLE PROGRAM AND MUST NEVER BE RUN')
  chmodSync(binary, 0o755)
  options.env.PATH = commands
  options.env.PATHEXT = '.EXE;.CMD'
  assert.deepEqual(detectHarnesses(options), ['claude', 'kiro', 'codex'])
  if (process.platform !== 'win32') {
    chmodSync(binary, 0o644)
    assert.deepEqual(detectHarnesses(options), ['claude', 'codex'])
  }
})

test('DSH detection separates global configuration from project markers', async t => {
  const f = fixture(t, 'dsh')
  let sequence = 0
  const scenario = () => {
    const home = join(f.home, `dsh-detection-${++sequence}`)
    const cwd = join(home, 'project')
    const config = join(home, '.dsh')
    mkdirSync(join(cwd, '.git'), { recursive: true })
    return {
      home,
      cwd,
      config,
      detect: (env = {}) => detectHarnesses({ home, cwd, env }),
    }
  }
  const managedMarker = { product: 'prumo', harness: 'dsh', version: packageVersion }
  const arbitrarySkills = [
    ['valid skill', '---\nname: valid-skill\ndescription: Valid DSH skill\n---\n'],
    ['missing frontmatter', 'name: missing-frontmatter'],
    ['invalid YAML', '---\nname: [unterminated\ndescription: Invalid YAML\n---\n'],
    ['invalid name', '---\nname: Not-Kebab-Case\ndescription: Invalid official skill name\n---\n'],
    ['duplicate YAML key', '---\nname: valid-name\ndescription: Looks valid\nmetadata:\n  owner: first\nmetadata:\n  owner: duplicate\n---\n'],
  ]

  await t.test('recognizes a PATH sentinel without executing it', () => {
    const s = scenario()
    const commands = join(s.home, 'commands')
    const executionMarker = join(s.home, 'sentinel-was-executed')
    const binary = join(commands, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    put(binary, process.platform === 'win32' ? `@echo executed>"${executionMarker}"\r\n` : `#!/bin/sh\nprintf executed > '${executionMarker}'\n`)
    chmodSync(binary, 0o755)
    assert.deepEqual(s.detect({ PATH: commands, PATHEXT: '.CMD;.EXE' }), ['dsh'])
    assert.equal(existsSync(executionMarker), false)
  })

  await t.test('uses a custom DSH_HOME as the only global root', () => {
    const s = scenario()
    const custom = join(s.home, 'custom-dsh')
    put(join(s.config, 'AGENTS.md'), 'default root must be hidden\n')
    mkdirSync(custom)
    assert.deepEqual(s.detect({ DSH_HOME: custom }), [], 'the populated default root must not leak through')
    put(join(custom, 'cordis.patch.yml'), 'plugins: []\n')
    assert.deepEqual(s.detect({ DSH_HOME: custom }), ['dsh'])
  })

  await t.test('treats blank DSH_HOME as absent and expands a home-relative root', () => {
    const blank = scenario()
    put(join(blank.config, 'AGENTS.md'), 'global instructions\n')
    assert.deepEqual(blank.detect({ DSH_HOME: '   ' }), ['dsh'])
    const relativeHome = scenario()
    put(join(relativeHome.home, 'custom-dsh', '.credentials.yaml'), 'providers: {}\n')
    assert.deepEqual(relativeHome.detect({ DSH_HOME: '~/custom-dsh' }), ['dsh'])
  })

  await t.test('rejects an empty DSH_HOME', () => {
    const s = scenario()
    mkdirSync(s.config)
    assert.deepEqual(s.detect({}), [])
  })

  for (const [name, relativePath, value] of [
    ['cordis patch', 'cordis.patch.yml', 'plugins: []\n'],
    ['global instructions', 'AGENTS.md', 'Global DSH instructions\n'],
    ['credentials', '.credentials.yaml', 'providers: {}\n'],
  ]) await t.test(`recognizes the global ${name} file`, () => {
    const s = scenario()
    put(join(s.config, relativePath), value)
    assert.deepEqual(s.detect({}), ['dsh'])
  })

  for (const [name, bundles] of [
    ['nonempty profile bundles', ['@deepseek-ai/dsh-bundle-standard']],
    ['explicitly empty profile bundles', []],
  ]) await t.test(`recognizes ${name}`, () => {
    const s = scenario()
    put(join(s.config, 'profiles', 'standard', 'package.json'), { dsh: { profile: { bundles } } })
    assert.deepEqual(s.detect({}), ['dsh'])
  })

  for (const [name, value] of [
    ['invalid JSON', '{broken'],
    ['missing dsh profile', {}],
    ['non-array bundles', { dsh: { profile: { bundles: 'standard' } } }],
    ['non-string bundle', { dsh: { profile: { bundles: [3] } } }],
    ['empty bundle name', { dsh: { profile: { bundles: ['  '] } } }],
  ]) await t.test(`rejects a profile with ${name}`, () => {
    const s = scenario()
    put(join(s.config, 'profiles', 'broken', 'package.json'), value)
    assert.deepEqual(s.detect({}), [])
  })

  await t.test('recognizes an authentic managed global skill marker', () => {
    const s = scenario()
    put(join(s.config, 'skills', 'prumo', '.prumo-install.json'), managedMarker)
    assert.deepEqual(s.detect({}), ['dsh'])
  })

  for (const [name, skill] of arbitrarySkills) await t.test(`rejects an arbitrary global skill with ${name}`, () => {
    const s = scenario()
    put(join(s.config, 'skills', 'other', 'SKILL.md'), skill)
    assert.deepEqual(s.detect({}), [])
  })

  await t.test('recognizes only an authentic managed project skill marker', () => {
    const s = scenario()
    const global = join(s.home, 'empty-global-dsh')
    put(join(s.cwd, '.dsh', 'skills', 'prumo', '.prumo-install.json'), managedMarker)
    assert.deepEqual(s.detect({ DSH_HOME: global }), ['dsh'])
  })

  for (const [name, relativePath, value] of [
    ['empty directory', '.', null],
    ['AGENTS.md', 'AGENTS.md', 'Project-local instructions\n'],
    ['cordis.patch.yml', 'cordis.patch.yml', 'plugins: []\n'],
    ['credentials', '.credentials.yaml', 'providers: {}\n'],
    ['valid profile', join('profiles', 'standard', 'package.json'), { dsh: { profile: { bundles: [] } } }],
    ['invalid profile', join('profiles', 'broken', 'package.json'), '{broken'],
    ...arbitrarySkills.map(([label, value]) => [`skill with ${label}`, join('skills', 'other', 'SKILL.md'), value]),
    ['invalid managed marker', join('skills', 'prumo', '.prumo-install.json'), { product: 'other', harness: 'dsh', version: packageVersion }],
  ]) await t.test(`rejects project-local ${name}`, () => {
    const s = scenario()
    const local = join(s.cwd, '.dsh')
    if (value === null) mkdirSync(local, { recursive: true })
    else put(join(local, relativePath), value)
    assert.deepEqual(s.detect({ DSH_HOME: join(s.home, 'empty-global-dsh') }), [])
  })
})

test('Codex uses one personal skill root while preserving a legacy installation', t => {
  const f = fixture(t, 'codex')
  const legacyRoot = join(f.config, 'skills')
  put(join(legacyRoot, 'graph-foreman', 'SKILL.md'), 'old skill')
  assert.deepEqual(f.plan().groups.filter(group => group.name.startsWith('skill:')).map(group => group.name), [`skill:${legacyRoot}`])

  const installed = applyInstall(planInstall({ ...f.options, skillRoots: [f.skillRoot, legacyRoot] }))
  assert.ok(installed.groups.every(group => group.status !== 'conflict'))
  assert.deepEqual(discoverInstallations({ home: f.home, cwd: f.cwd, env: {} }).find(entry => entry.harness === 'codex').roots, [f.skillRoot])
  assert.deepEqual(f.plan().groups.filter(group => group.name.startsWith('skill:')).map(group => group.name), [`skill:${f.skillRoot}`])
})

test('installation accepts a home reached through an operating-system path alias', t => {
  if (process.platform === 'win32') return t.skip('POSIX path aliases resolve differently from Windows junctions')
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'prumo-home-alias-'))
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const home = join(base, 'home')
  const alias = join(base, 'alias')
  mkdirSync(join(home, '.claude'), { recursive: true })
  symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const plan = planInstall({ harness: 'claude', home: alias, cwd: home, env: {}, lang: 'en' })
  assert.equal(plan.home, realpathSync(home))
  assert.ok(plan.groups.every(group => group.conflicts.length === 0), JSON.stringify(plan.groups))
  assert.ok(applyInstall(plan).groups.every(group => group.status !== 'conflict'))
  assert.ok(existsSync(join(home, '.claude', 'skills', 'prumo', 'SKILL.md')))
})

test('automatic CLI installs only detected harnesses, preserves runs and backups, and keeps explicit selection', t => {
  const f = fixture(t)
  const cli = isolatedCli(f)
  const legacy = join(f.home, '.claude', 'skills', 'graph-foreman', 'SKILL.md')
  put(legacy, 'original legacy skill')
  put(join(f.home, '.kiro', 'steering', 'existing.md'), 'Keep this instruction')
  put(join(f.home, '.dsh', 'profiles', 'standard', 'package.json'), { dsh: { profile: { bundles: ['@deepseek-ai/dsh-bundle-standard'] } } })
  const state = join(f.home, '.local', 'share', 'graph-foreman', 'work', '.specs', 'graph', 'active', 'state.json')
  const migratedState = join(f.home, 'data', 'work', '.specs', 'graph', 'active', 'state.json')
  put(state, { state: 'blocked', attempts: [1], evidence: 'keep', contract: 'approved' })
  const before = read(state)
  const marker = harness => join(f.home, harness === 'codex' ? '.agents' : `.${harness}`, 'skills', 'prumo', '.prumo-install.json')
  const preview = cli(['install', '--lang', 'pt-BR', '--dry-run'])
  assert.equal(preview.status, 0, preview.stdout + preview.stderr)
  assert.match(preview.stdout, /Ambientes detectados: claude, kiro, dsh/)
  assert.equal(existsSync(marker('claude')), false)
  assert.equal(existsSync(join(f.home, '.local', 'share', 'prumo')), false)
  const blocked = cli(['install'])
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /Interactive selection needs a terminal/)
  assert.equal(existsSync(marker('claude')), false)
  put(join(f.home, '.local', 'share', 'prumo', 'dashboard.json'), { enabled: false, mechanism: process.platform === 'win32' ? 'schtasks' : process.platform === 'darwin' ? 'launchd' : 'xdg' })
  const installed = cli(['install', '--all', '--lang', 'pt-BR'])
  assert.equal(installed.status, 0, installed.stdout + installed.stderr)
  assert.match(installed.stdout, /Prumo instalado com sucesso/)
  assert.ok(installed.stdout.includes('Prumo v' + packageVersion))
  assert.doesNotMatch(installed.stdout, /Alterações \/|gravar:|Backup:/)
  for (const harness of ['claude', 'kiro', 'dsh']) assert.equal(JSON.parse(read(marker(harness))).lang, 'pt-BR')
  assert.equal(read(join(f.home, '.dsh', 'AGENTS.md')).split('<!-- po-first:start -->').length - 1, 1)
  const doctor = cli(['doctor', '--claude'])
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr)
  assert.match(doctor.stdout, /dashboard: .*; .*; disabled/)
  assert.equal(existsSync(marker('codex')), false)
  assert.equal(existsSync(join(f.home, '.codex')), false)
  assert.equal(read(migratedState), before)
  assert.equal(existsSync(state), false)
  assert.equal(existsSync(legacy), false)
  const backups = join(f.home, '.local', 'share', 'prumo', 'backups')
  const count = readdirSync(backups).length
  assert.equal(count, 3)
  const repeated = cli(['install'])
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr)
  assert.match(repeated.stdout, new RegExp(`Prumo v${packageVersion.replaceAll('.', '\\.')} is already installed in claude, kiro, dsh`))
  assert.equal(readdirSync(backups).length, count)
  put(join(f.home, '.codex', 'config.toml'), 'model = "gpt"\n')
  const explicit = cli(['install', '--codex'])
  assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr)
  assert.ok(existsSync(marker('codex')))
  assert.equal(read(migratedState), before)
})

test('explicit install refuses each absent harness before writing anything', async t => {
  for (const [harness, label] of [
    ['claude', 'Claude Code'],
    ['kiro', 'Kiro'],
    ['codex', 'Codex'],
    ['dsh', 'DeepSeek Harness'],
  ]) await t.test(`${harness} absent`, t => {
    const f = fixture(t)
    const cli = isolatedCli(f)
    const emptyRoots = {
      CLAUDE_CONFIG_DIR: join(f.home, 'absent-claude'),
      KIRO_HOME: join(f.home, 'absent-kiro'),
      CODEX_HOME: join(f.home, 'absent-codex'),
      DSH_HOME: join(f.home, 'absent-dsh'),
    }
    const before = snapshotTree(f.home)
    const result = cli(['install', `--${harness}`], emptyRoots)
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stderr, new RegExp(label))
    assert.match(result.stderr, new RegExp(`--${harness}`))
    assert.deepEqual(snapshotTree(f.home), before, `${harness} must not change names, types or file bytes`)
    for (const path of [
      cli.commandLog,
      join(f.home, 'data'),
      join(f.home, '.local', 'share', 'prumo'),
      join(f.home, '.claude'),
      join(f.home, '.kiro'),
      join(f.home, '.codex'),
      join(f.home, '.dsh'),
      join(f.home, '.agents'),
    ]) assert.equal(existsSync(path), false, `${harness} unexpectedly created ${path}`)
  })
})

test('CLI install --dsh and doctor --dsh use custom DSH_HOME without extra orchestration config', t => {
  const f = fixture(t, 'dsh')
  const cli = isolatedCli(f)
  const custom = join(f.home, 'custom dsh home')
  put(join(f.home, '.local', 'share', 'prumo', 'dashboard.json'), { enabled: false, mechanism: process.platform === 'win32' ? 'schtasks' : process.platform === 'darwin' ? 'launchd' : 'xdg' })
  put(join(custom, 'AGENTS.md'), 'Keep user instructions\n')
  const installed = cli(['install', '--dsh'], { DSH_HOME: custom })
  assert.equal(installed.status, 0, installed.stdout + installed.stderr)
  assert.ok(existsSync(join(custom, 'skills', 'prumo', 'SKILL.md')))
  const instructions = read(join(custom, 'AGENTS.md'))
  assert.match(instructions, /^Keep user instructions/)
  assert.equal(instructions.split('<!-- po-first:start -->').length - 1, 1)
  assert.equal(existsSync(join(custom, 'cordis.patch.yml')), false)
  assert.equal(existsSync(join(custom, 'profiles')), false)
  const doctor = cli(['doctor', '--dsh'], { DSH_HOME: custom })
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr)
  assert.match(doctor.stdout, /installed: yes; configured: yes/)
  const repeated = cli(['install', '--dsh'], { DSH_HOME: custom })
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr)
  assert.match(repeated.stdout, /already installed in dsh/)
  assert.equal(read(join(custom, 'AGENTS.md')).split('<!-- po-first:start -->').length - 1, 1)
})

test('custom DSH_HOME is used consistently by registry discovery and restore', t => {
  const f = fixture(t, 'dsh')
  const custom = join(f.home, 'custom-dsh')
  const env = { DSH_HOME: '~/custom-dsh' }
  put(join(custom, 'AGENTS.md'), 'Keep original DSH instructions\n')
  const plan = f.plan({ env })
  assert.equal(plan.config, custom)
  const installed = applyInstall(plan)
  assert.ok(installed.groups.every(group => group.status !== 'conflict'), JSON.stringify(installed))
  const discovered = discoverInstallations({ home: f.home, cwd: f.cwd, env })
  assert.equal(discovered.length, 1)
  assert.equal(discovered[0].harness, 'dsh')
  assert.equal(discovered[0].config, custom)
  assert.deepEqual(discovered[0].roots, [join(custom, 'skills')])
  assert.ok(restoreInstall(installed.backup, { home: f.home, env }) > 0)
  assert.equal(read(join(custom, 'AGENTS.md')), 'Keep original DSH instructions\n')
  assert.equal(existsSync(join(custom, 'skills', 'prumo', 'SKILL.md')), false)
})

test('automatic CLI reports no detection and continues independent harnesses after a configuration conflict', t => {
  const f = fixture(t)
  const cli = isolatedCli(f)
  const before = readdirSync(f.home)
  const empty = cli(['install'])
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /No supported environments detected/)
  assert.deepEqual(readdirSync(f.home), before)
  assert.equal(cli(['doctor']).status, 1)
  assert.equal(cli(['install', '--claude', '--kiro']).status, 1)
  assert.equal(cli(['install', '--codex', '--dsh']).status, 1)
  assert.equal(cli(['install', '--all', '--claude']).status, 1)
  put(join(f.home, '.local', 'share', 'prumo', 'dashboard.json'), { enabled: false, mechanism: process.platform === 'win32' ? 'schtasks' : process.platform === 'darwin' ? 'launchd' : 'xdg' })
  put(join(f.home, '.claude', 'settings.json'), '{broken')
  put(join(f.home, '.kiro', 'settings', 'cli.json'), {})
  const conflict = cli(['install', '--all'])
  assert.equal(conflict.status, 2, conflict.stdout + conflict.stderr)
  assert.equal(read(join(f.home, '.claude', 'settings.json')), '{broken')
  assert.ok(existsSync(join(f.home, '.kiro', 'skills', 'prumo', 'SKILL.md')))
  assert.match(read(join(f.home, '.kiro', 'steering', 'po-first.md')), /inclusion: always/)
})

test('dashboard reconciliation is partial-safe, resumable, dry-run inert and respects opt-out', async () => {
  const calls = []
  const enable = async options => { calls.push(['enable', options]); return { ok: true, url: 'http://localhost:4949' } }
  const restart = async options => { calls.push(['restart', options]); return { ok: true, url: 'http://localhost:4949' } }
  const none = await reconcileDashboardInstall(0, { status: async () => { throw new Error('must not inspect') }, enable, restart })
  assert.deepEqual(none, { ok: false, action: 'none' })
  const disabled = await reconcileDashboardInstall(2, { status: async () => ({ disabled: true }), enable, restart })
  assert.equal(disabled.action, 'disabled')
  const preview = await reconcileDashboardInstall(1, { dryRun: true, status: async () => ({ enabled: false, disabled: false }), enable, restart })
  assert.equal(preview.action, 'enable')
  assert.deepEqual(calls, [])
  assert.equal((await reconcileDashboardInstall(1, { dashboardOptions: { packageRoot: '/global/prumo' }, status: async () => ({ enabled: false }), enable, restart })).action, 'enable')
  assert.equal((await reconcileDashboardInstall(3, { dashboardOptions: { packageRoot: '/global/prumo' }, status: async () => ({ enabled: true }), enable, restart })).action, 'restart')
  assert.deepEqual(calls.map(([action]) => action), ['enable', 'restart'])
})

test('postinstall is inert locally and delegates global setup to the current absolute CLI', () => {
  const calls = []
  const root = resolve(source)
  const env = { EXISTING: 'kept', npm_lifecycle_event: 'postinstall', npm_package_json: join(root, 'package.json') }
  assert.equal(runPostinstall({ global: false, run: () => { throw new Error('must stay inert') } }), 0)
  const code = runPostinstall({ root, env, global: true, execPath: process.execPath, run(file, args, options) { calls.push([file, args, options]); return { status: 2 } } })
  assert.equal(code, 2)
  assert.equal(calls[0][0], process.execPath)
  assert.deepEqual(calls[0][1], [join(root, 'bin', 'prumo.mjs'), 'install', '--all'])
  assert.equal(calls[0][2].stdio, 'inherit')
  assert.deepEqual(calls[0][2].env, { ...env, PRUMO_POSTINSTALL_LIFECYCLE: '1' })
  assert.equal(env.PRUMO_POSTINSTALL_LIFECYCLE, undefined)
})

test('only an authentic postinstall child skips the recursive global CLI update', t => {
  const f = fixture(t, 'codex')
  put(join(f.home, '.codex', 'config.toml'), '')
  put(join(f.home, '.local', 'share', 'prumo', 'dashboard.json'), { enabled: false, mechanism: 'xdg' })
  const cli = isolatedCli(f)
  const markerOnly = cli(['install', '--all'], { PRUMO_POSTINSTALL_LIFECYCLE: '1' })
  assert.equal(markerOnly.status, 0, markerOnly.stdout + markerOnly.stderr)
  assert.match(read(cli.commandLog), /install --global --ignore-scripts/)
  rmSync(cli.commandLog, { force: true })
  const lifecycle = cli(['install', '--all'], {
    PRUMO_POSTINSTALL_LIFECYCLE: '1', npm_lifecycle_event: 'postinstall', npm_package_json: join(source, 'package.json'),
  })
  assert.equal(lifecycle.status, 0, lifecycle.stdout + lifecycle.stderr)
  assert.equal(existsSync(join(f.home, '.agents', 'skills', 'prumo', 'SKILL.md')), true)
  assert.equal(existsSync(cli.commandLog), false, 'authentic lifecycle must not resolve or replace its own global package')
  assert.equal(JSON.parse(read(join(f.home, '.local', 'share', 'prumo', 'dashboard.json'))).enabled, false, 'dashboard opt-out remains respected')
})

for (const harness of ['claude', 'kiro', 'codex', 'dsh']) test(`${harness}: persistent install, activation, idempotence and restore`, t => {
  const f = fixture(t, harness)
  const before = readdirSync(f.home)
  const preview = applyInstall(f.plan(), { dryRun: true })
  assert.equal(preview.backup, null)
  assert.deepEqual(readdirSync(f.home), before)
  assert.equal(existsSync(join(f.skillRoot, 'prumo')), false)
  const result = f.install()
  const version = JSON.parse(read(join(source, 'package.json'))).version
  assert.ok(read(join(result.backup, 'RESTORE.md')).includes(`bunx @henri-ralmeida/prumo@${version} restore`))
  const skill = join(f.skillRoot, 'prumo')
  assert.equal(existsSync(join(f.skillRoot, 'graph-foreman')), false)
  assert.match(read(join(skill, 'SKILL.md')), /name: prumo/)
  assert.match(read(join(skill, 'README.md')), /prumo migrate --check/)
  assert.match(read(join(skill, 'README.pt-BR.md')), /prumo migrate --check/)
  assert.match(read(join(skill, 'references', 'po-first.md')), /senior product partner/)
  assert.match(read(join(skill, 'references', 'po-first.pt-BR.md')), /parceiro sênior de produto/)
  assert.match(read(join(skill, 'references', 'runtime.md')), /refreshes the CLI, skill, both READMEs, references, scripts and PO First/)
  assert.match(read(join(skill, 'references', 'runtime.pt-BR.md')), /atualiza a CLI, a skill, os dois READMEs, as referências, os scripts e a configuração PO First/)
  assert.ok(existsSync(join(skill, 'scripts', 'engine.mjs')))
  const configured = installationStatus(f.plan())
  assert.equal(configured.installed, true)
  assert.equal(configured.configured, true)
  assert.deepEqual(configured.pendingActivation, [])
  const repeated = f.install()
  assert.equal(repeated.backup, null)
  assert.ok(repeated.groups.every(group => group.status === 'unchanged'))
  if (harness === 'claude') assert.equal(JSON.parse(read(join(f.config, 'settings.json'))).outputStyle, 'PO First')
  if (harness === 'kiro') assert.match(read(join(f.config, 'steering', 'po-first.md')), /inclusion: always/)
  if (harness === 'codex') assert.equal(read(join(f.config, 'AGENTS.md')).split('<!-- po-first:start -->').length - 1, 1)
  if (harness === 'dsh') assert.equal(read(join(f.config, 'AGENTS.md')).split('<!-- po-first:start -->').length - 1, 1)
  const installedPoFirst = harness === 'claude' ? read(join(f.config, 'output-styles', 'po-first.md')) :
    harness === 'kiro' ? read(join(f.config, 'steering', 'po-first.md')) : read(join(f.config, 'AGENTS.md'))
  assert.match(installedPoFirst, /workflow metadata/)
  assert.ok(restoreInstall(result.backup, { home: f.home, env: {} }) > 0)
  assert.equal(existsSync(join(skill, 'SKILL.md')), false)
})

test('restore supports an explicitly selected project outside the user home', t => {
  const f = fixture(t)
  const base = realpathSync(tmpdir())
  const project = mkdtempSync(join(base, 'prumo-project-'))
  t.after(() => { assert.equal(dirname(project), base); assert.ok(project.startsWith(join(base, 'prumo-project-'))); rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const legacy = join(project, '.claude', 'skills', 'graph-foreman', 'SKILL.md')
  put(legacy, 'existing project skill')
  mkdirSync(join(project, '.git'))
  const plan = planInstall({ ...f.options, projects: [project] })
  for (const item of plan.groups.flatMap(group => group.changes)) assert.ok(inside(f.home, item.file) || inside(project, item.file))
  const installed = applyInstall(plan)
  assert.ok(installed.groups.every(group => group.status !== 'conflict'))
  assert.equal(existsSync(legacy), false)
  restoreInstall(installed.backup, { home: f.home, env: {} })
  assert.equal(read(legacy), 'existing project skill')
  assert.equal(existsSync(join(project, '.claude', 'skills', 'prumo', 'SKILL.md')), false)
})

test('update recupera marcador nulo por backup integro e preserva idioma e dados', t => {
  for (const harness of ['claude', 'kiro', 'codex', 'dsh']) {
    const f = fixture(t, harness)
    f.install()
    const marker = join(f.skillRoot, 'prumo', '.prumo-install.json')
    put(marker, { product: 'prumo', harness, version: '1.0.8', lang: 'pt-BR' })
    f.install()
    const damaged = Buffer.alloc(90)
    writeFileSync(marker, damaged)
    const state = join(f.home, '.local', 'share', 'prumo', 'example', '.specs', 'graph', 'run', 'state.json')
    put(state, '{"tasks":{"T1":{"state":"done"}}}')
    const before = read(state)
    const entries = discoverInstallations({ home: f.home, cwd: f.cwd, env: {} })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].harness, harness)
    assert.deepEqual(readFileSync(marker), damaged, 'descoberta nao modifica arquivos')
    const plan = f.plan({ onlyInstalled: true, lang: undefined })
    assert.equal(plan.lang, 'pt-BR')
    const result = applyInstall(plan)
    assert.ok(result.groups.every(group => group.status !== 'conflict'))
    assert.deepEqual(JSON.parse(read(marker)), { product: 'prumo', harness, version: packageVersion, lang: 'pt-BR' })
    assert.equal(read(state), before)
    const manifest = JSON.parse(read(join(result.backup, 'manifest.json')))
    const saved = manifest.files.find(entry => entry.file === marker)
    assert.deepEqual(readFileSync(join(result.backup, saved.original)), damaged)
  }
})

test('marcador danificado sem backup integro nao e adotado automaticamente', t => {
  const f = fixture(t)
  f.install()
  const marker = join(f.skillRoot, 'prumo', '.prumo-install.json')
  put(marker, { product: 'prumo', harness: 'claude', version: '1.0.8', lang: 'en' })
  const installed = f.install()
  const manifest = JSON.parse(read(join(installed.backup, 'manifest.json')))
  const saved = manifest.files.find(entry => entry.file === marker)
  put(join(installed.backup, saved.original), '{"product":"prumo","harness":"claude","version":"0.0.1"}')
  writeFileSync(marker, Buffer.alloc(90))
  assert.throws(() => discoverInstallations({ home: f.home, cwd: f.cwd, env: {} }), /Invalid Prumo installation marker/)
  assert.deepEqual(readFileSync(marker), Buffer.alloc(90))
})

test('overlay migrates the legacy skill, preserves run data and supports complete restore', t => {
  const f = fixture(t)
  const legacy = join(f.skillRoot, 'graph-foreman')
  const prumo = join(f.skillRoot, 'prumo')
  put(join(legacy, 'SKILL.md'), 'old skill instructions')
  put(join(legacy, 'scripts', 'engine.mjs'), '// old engine')
  put(join(legacy, 'custom.bin'), 'custom bytes preserved')
  const central = join(f.home, '.local', 'share', 'graph-foreman')
  const root = join(central, 'work')
  const migratedRoot = join(f.home, '.local', 'share', 'prumo', 'work')
  mkdirSync(root, { recursive: true })
  const planPath = join(root, 'approved.json')
  put(planPath, { name: 'legacy', tasks: [{ id: 'T1', title: 'Keep my scope', validationMode: 'inspection', inspectionReason: 'Documentation', validation: 'Inspect document' }] })
  const env = { ...process.env, PRUMO_HOME: central, PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  const taskPlan = join(root, 'task-plan.json')
  put(taskPlan, {
    research: [{ source: 'approved.json', findings: 'Documentation-only task with an approved inspection contract.' }],
    decisions: [], steps: ['Inspect the document against its approved scope.'],
    verification: [{ criterion: 'Document matches the approved scope.', check: 'inspection' }], openQuestions: [],
  })
  const discovery = join(root, 'discovery.json')
  put(discovery, { research: [{ source: 'approved.json', findings: 'The documentation scope was inspected.' }],
    questions: [{ question: 'Preserve this documentation scope?', answer: 'Yes.', channel: 'chat-fallback', round: 1 }],
    coverage: { problem: 'Document scope', affected: 'Readers', outcome: 'Accurate document', currentBehavior: 'Scope exists',
      desiredBehavior: 'Preserve it', rules: 'Inspection only', exceptions: 'None', scope: 'Documentation', acceptance: 'Inspection passes' },
    decisions: [], deferred: [], executionBoundary: { deferredToExecutor: ['T1'], prematureTaskWork: [] },
    closure: 'The documentation task is fully specified.' })
  const statePath = join(root, '.specs', 'graph', 'legacy', 'state.json')
  for (const args of [['init', '--plan', planPath, '--run', 'legacy'], ['begin-discussion', 'T1']]) {
    const result = spawnSync(process.execPath, [join(source, 'scripts', 'engine.mjs'), ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const round = JSON.parse(read(statePath)).tasks.T1.discussionAttempts.at(-1)
  const context = JSON.parse(read(discovery))
  context.roundId = round.roundId
  context.nonce = round.nonce
  context.questions = context.questions.map(question => ({ ...question, roundId: round.roundId }))
  put(discovery, context)
  for (const args of [['finish-discussion', 'T1', '--context', discovery], ['plan-task', 'T1', '--agent', 'planner', '--context', discovery],
    ['finish-planning', 'T1', '--plan', taskPlan], ['start', 'T1', '--agent', 'original'], ['block', 'T1', '--reason', 'User pause']]) {
    const result = spawnSync(process.execPath, [join(source, 'scripts', 'engine.mjs'), ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const eventsPath = join(root, '.specs', 'graph', 'legacy', 'events.ndjson')
  const before = [read(statePath), read(eventsPath), read(planPath)]
  assert.ok(f.plan().data.some(data => data.source === root && data.root === migratedRoot))
  const result = f.install()
  const migratedState = join(migratedRoot, relative(root, statePath))
  const migratedEvents = join(migratedRoot, relative(root, eventsPath))
  const migratedPlan = join(migratedRoot, relative(root, planPath))
  assert.deepEqual([read(migratedState), read(migratedEvents), read(migratedPlan)], before)
  assert.equal(existsSync(root), false)
  assert.equal(existsSync(legacy), false)
  assert.equal(read(join(prumo, 'custom.bin')), 'custom bytes preserved')
  const migratedEnv = { ...env, PRUMO_HOME: dirname(migratedRoot), PRUMO_ROOT: migratedRoot }
  const prumoCall = spawnSync(process.execPath, [join(prumo, 'scripts', 'engine.mjs'), 'graph'], { env: migratedEnv, encoding: 'utf8' })
  assert.equal(prumoCall.status, 0, prumoCall.stderr)
  const task = JSON.parse(prumoCall.stdout).tasks.T1
  assert.equal(task.state, 'blocked')
  assert.equal(task.attempts.length, 1)
  assert.equal(task.blockReason, 'User pause')
  const snapshots = join(result.backup, 'snapshots')
  assert.ok(readdirSync(snapshots).some(name => existsSync(join(snapshots, name, 'custom.bin'))))
  restoreInstall(result.backup, { home: f.home, env: {} })
  assert.equal(read(join(legacy, 'scripts', 'engine.mjs')), '// old engine')
  assert.equal(read(join(legacy, 'custom.bin')), 'custom bytes preserved')
  assert.equal(existsSync(join(prumo, 'SKILL.md')), false)
  assert.deepEqual([read(statePath), read(eventsPath), read(planPath)], before)
})

test('central graph-foreman workspaces move to Prumo and restore without changing run bytes', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local', 'share', 'graph-foreman', 'work')
  const migrated = join(f.home, '.local', 'share', 'prumo', 'work')
  const relativeState = join('.specs', 'graph', 'run-1', 'state.json')
  const relativeEvents = join('.specs', 'graph', 'run-1', 'events.ndjson')
  put(join(legacy, relativeState), '{"state":"done","evidence":["kept"]}\n')
  put(join(legacy, relativeEvents), '{"type":"done"}\n')
  const before = [read(join(legacy, relativeState)), read(join(legacy, relativeEvents))]

  assert.equal(storageHome({}, f.home), dirname(migrated), 'new storage never falls back to the legacy store')
  assert.equal(storageHome({ GRAPH_FOREMAN_HOME: dirname(legacy) }, f.home), dirname(migrated))

  const result = f.install()
  assert.deepEqual([read(join(migrated, relativeState)), read(join(migrated, relativeEvents))], before)
  assert.equal(existsSync(legacy), false)
  for (const rootKey of ['GRAPH_ROOT', 'PRUMO_ROOT']) {
    assert.equal(findRoot({ [rootKey]: legacy, GRAPH_FOREMAN_HOME: dirname(legacy) }, f.cwd, f.home), migrated)
  }
  mkdirSync(legacy, { recursive: true })
  assert.equal(findRoot({ GRAPH_ROOT: legacy }, f.cwd, f.home), migrated, 'an empty locked legacy directory must not hide migrated runs')
  assert.throws(() => findRoot({ GRAPH_ROOT: join(dirname(legacy), 'missing') }, f.cwd, f.home), /does not exist/)

  restoreInstall(result.backup, { home: f.home, env: {} })
  assert.deepEqual([read(join(legacy, relativeState)), read(join(legacy, relativeEvents))], before)
  assert.equal(existsSync(join(migrated, relativeState)), false)
})

test('large workspace relocation keeps file payloads out of memory and rejects a concurrent edit', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local', 'share', 'graph-foreman', 'large')
  const destination = join(f.home, '.local', 'share', 'prumo', 'large')
  const payload = join(legacy, '.specs', 'graph', 'run', 'payload.bin')
  mkdirSync(dirname(payload), { recursive: true })
  writeFileSync(payload, Buffer.alloc(8 * 1024 * 1024, 7))
  const plan = f.plan()
  const migration = plan.groups.find(group => group.name === 'workspace:large')
  assert.ok(migration.relocation)
  assert.equal(migration.changes.length, 0)
  assert.ok(JSON.stringify(plan).length < 8 * 1024 * 1024, 'workspace bytes must not be retained in the plan')
  writeFileSync(payload, Buffer.alloc(8 * 1024 * 1024, 8))
  const result = applyInstall(plan)
  assert.equal(result.groups.find(group => group.name === 'workspace:large').status, 'conflict')
  assert.equal(existsSync(legacy), true)
  assert.equal(existsSync(destination), false)
})

test('legacy migration blocks conflicting custom files without changing either skill', t => {
  const f = fixture(t)
  const legacy = join(f.skillRoot, 'graph-foreman', 'custom.txt')
  const destination = join(f.skillRoot, 'prumo', 'custom.txt')
  put(legacy, 'legacy value')
  put(destination, 'Prumo value')
  const plan = f.plan()
  const group = plan.groups.find(item => item.name.startsWith('skill:'))
  assert.match(group.conflicts.join('\n'), /Legacy file conflicts with Prumo destination/)
  const result = applyInstall(plan)
  assert.equal(result.groups.find(item => item.name === group.name).status, 'conflict')
  assert.equal(read(legacy), 'legacy value')
  assert.equal(read(destination), 'Prumo value')
})

test('workspace migration keeps graph state, discards execution artifacts and can restore the state', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local/share/graph-foreman/retro-pass-ultimate')
  const destination = join(f.home, '.local/share/prumo/retro-pass-ultimate')
  put(join(legacy, '.specs/graph/run/state.json'), '{"history":"keep"}')
  put(join(legacy, 'attempt4/source/packages/desktop/value.txt'), 'internal')
  const external = join(f.home, 'external')
  put(join(external, 'value.txt'), 'external')
  const nodeModules = 'attempt4/source/node_modules/@retro-pass'
  mkdirSync(join(legacy, nodeModules), { recursive: true })
  symlinkSync(join(legacy, 'attempt4/source/packages/desktop'), join(legacy, nodeModules, 'desktop'), 'junction')
  symlinkSync(external, join(legacy, nodeModules, 'external'), 'junction')
  symlinkSync(legacy, join(legacy, 'self'), 'junction')
  const result = f.install()
  assert.equal(existsSync(legacy), false)
  assert.equal(read(join(destination, '.specs/graph/run/state.json')), '{"history":"keep"}')
  assert.equal(existsSync(join(destination, 'attempt4')), false)
  assert.equal(read(join(external, 'value.txt')), 'external')
  const nextHarness = planInstall({ ...f.options, harness: 'codex' })
  assert.equal(nextHarness.groups.some(group => group.name === 'workspace:retro-pass-ultimate'), false, 'another harness must not repeat the migration')
  assert.equal(f.install().backup, null, 'repeated migration is inert')
  restoreInstall(result.backup, { home: f.home, env: {} })
  assert.equal(read(join(legacy, '.specs/graph/run/state.json')), '{"history":"keep"}')
  assert.equal(existsSync(join(legacy, 'attempt4')), false, 'discarded execution artifacts are intentionally not restored')
  assert.equal(read(join(external, 'value.txt')), 'external')
})

test('workspace state conflicts preserve both graph copies', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local/share/graph-foreman/work')
  const destination = join(f.home, '.local/share/prumo/work')
  put(join(legacy, '.specs/graph/run/state.json'), 'run bytes')
  put(join(destination, '.specs/graph/run/state.json'), 'different run bytes')
  assert.ok(f.plan().groups.find(g => g.name === 'workspace:work').conflicts.length)
  const result = applyInstall(f.plan())
  assert.equal(result.groups.find(g => g.name === 'workspace:work').status, 'conflict')
  assert.equal(read(join(legacy, '.specs/graph/run/state.json')), 'run bytes')
  assert.equal(read(join(destination, '.specs/graph/run/state.json')), 'different run bytes')
})

test('migração recusa edição do estado entre o carimbo e a relocação', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local/share/graph-foreman/race')
  const destination = join(f.home, '.local/share/prumo/race')
  const state = join(legacy, '.specs/graph/run/state.json')
  put(state, 'before')
  const result = applyInstall(f.plan(), { onProgress: event => { if (event.name === 'race') writeFileSync(state, 'concurrent') } })
  const group = result.groups.find(item => item.name === 'workspace:race')
  assert.equal(group.status, 'conflict')
  assert.equal(read(state), 'concurrent')
  assert.equal(existsSync(join(destination, '.specs')), false)
})

test('falha posterior desfaz a relocação do estado antes de reportar conflito', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local/share/graph-foreman/partial')
  const destination = join(f.home, '.local/share/prumo/partial')
  put(join(legacy, '.specs/graph/run/state.json'), 'state')
  const planFile = join(legacy, 'approved.json')
  put(planFile, 'before')
  const result = applyInstall(f.plan(), { onProgress: event => { if (event.name === 'partial') writeFileSync(planFile, 'concurrent') } })
  const group = result.groups.find(item => item.name === 'workspace:partial')
  assert.equal(group.status, 'conflict')
  assert.equal(read(planFile), 'concurrent')
  assert.equal(read(join(legacy, '.specs/graph/run/state.json')), 'state')
  assert.equal(existsSync(join(destination, '.specs')), false)
})

test('migração recusa arquivo raiz criado durante a instalação e preserva a origem', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local/share/graph-foreman/late')
  const destination = join(f.home, '.local/share/prumo/late')
  put(join(legacy, '.specs/graph/run/state.json'), 'state')
  const latePlan = join(legacy, 'late.plan.json')
  const result = applyInstall(f.plan(), { onProgress: event => { if (event.name === 'late') put(latePlan, 'late plan') } })
  const group = result.groups.find(item => item.name === 'workspace:late')
  assert.equal(group.status, 'conflict')
  assert.equal(read(latePlan), 'late plan')
  assert.equal(read(join(legacy, '.specs/graph/run/state.json')), 'state')
  assert.equal(existsSync(join(destination, '.specs')), false)
})

test('migração recusa link do estado que aponta para execução descartada', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local/share/graph-foreman/linked-execution')
  const attempt = join(legacy, 'attempt4/source/packages/desktop')
  put(join(attempt, 'value.txt'), 'generated')
  put(join(legacy, '.specs/graph/run/state.json'), 'state')
  symlinkSync(attempt, join(legacy, '.specs/graph/run/artifact'), 'junction')
  const result = applyInstall(f.plan())
  const group = result.groups.find(item => item.name === 'workspace:linked-execution')
  assert.equal(group.status, 'conflict')
  assert.equal(read(join(attempt, 'value.txt')), 'generated')
  assert.equal(existsSync(join(f.home, '.local/share/prumo/linked-execution')), false)
})

test('migração preserva link interno do estado que também é migrado', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local/share/graph-foreman/linked-state')
  const target = join(legacy, '.specs/graph/run/target')
  const link = join(legacy, '.specs/graph/run/alias')
  put(join(target, 'value.txt'), 'state')
  symlinkSync(target, link, 'junction')
  const result = f.install()
  const group = result.groups.find(item => item.name === 'workspace:linked-state')
  const destination = join(f.home, '.local/share/prumo/linked-state')
  assert.equal(group.status, 'installed')
  assert.equal(realpathSync(join(destination, '.specs/graph/run/alias')), realpathSync(join(destination, '.specs/graph/run/target')))
  assert.equal(read(join(destination, '.specs/graph/run/alias/value.txt')), 'state')
})

test('migração e restauração preservam link do estado para backup durável', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local/share/graph-foreman/linked-backup')
  const durableBackup = join(legacy, 'backups/saved')
  const stateLink = join(legacy, '.specs/graph/run/archive')
  put(join(durableBackup, 'value.txt'), 'backup')
  put(join(legacy, '.specs/graph/run/state.json'), 'state')
  mkdirSync(dirname(stateLink), { recursive: true })
  symlinkSync(durableBackup, stateLink, 'junction')
  const result = f.install()
  const destination = join(f.home, '.local/share/prumo/linked-backup')
  assert.equal(realpathSync(join(destination, '.specs/graph/run/archive')), realpathSync(join(destination, 'backups/saved')))
  assert.equal(read(join(destination, '.specs/graph/run/archive/value.txt')), 'backup')
  restoreInstall(result.backup, { home: f.home, env: {} })
  assert.equal(realpathSync(stateLink), realpathSync(durableBackup))
  assert.equal(read(join(stateLink, 'value.txt')), 'backup')
  assert.equal(existsSync(join(destination, '.specs')), false)
})

test('migração recusa link para diretório durável vazio antes de mover a origem', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local/share/graph-foreman/empty-linked-backup')
  const destination = join(f.home, '.local/share/prumo/empty-linked-backup')
  const durableBackup = join(legacy, 'backups/saved')
  const stateLink = join(legacy, '.specs/graph/run/archive')
  mkdirSync(durableBackup, { recursive: true })
  put(join(legacy, '.specs/graph/run/state.json'), 'state')
  symlinkSync(durableBackup, stateLink, 'junction')
  const plan = f.plan()
  const planned = plan.groups.find(item => item.name === 'workspace:empty-linked-backup')
  assert.match(planned.conflicts.join('\n'), /directory that migration cannot recreate/)
  const result = applyInstall(plan)
  const group = result.groups.find(item => item.name === 'workspace:empty-linked-backup')
  assert.equal(group.status, 'conflict')
  assert.equal(read(join(legacy, '.specs/graph/run/state.json')), 'state')
  assert.equal(existsSync(durableBackup), true)
  assert.equal(existsSync(destination), false)
})

test('merge recusa link para diretório durável vazio mesmo com alvo no destino', t => {
  const f = fixture(t)
  const legacy = join(f.home, '.local/share/graph-foreman/empty-linked-merge')
  const destination = join(f.home, '.local/share/prumo/empty-linked-merge')
  const durableBackup = join(legacy, 'backups/saved')
  const stateLink = join(legacy, '.specs/graph/run/archive')
  mkdirSync(durableBackup, { recursive: true })
  put(join(legacy, '.specs/graph/run/state.json'), 'legacy state')
  put(join(destination, '.specs/graph/run/state.json'), 'destination state')
  mkdirSync(join(destination, 'backups/saved'), { recursive: true })
  symlinkSync(durableBackup, stateLink, 'junction')
  const plan = f.plan()
  const planned = plan.groups.find(item => item.name === 'workspace:empty-linked-merge')
  assert.match(planned.conflicts.join('\n'), /directory that migration cannot recreate/)
  const result = applyInstall(plan)
  const group = result.groups.find(item => item.name === 'workspace:empty-linked-merge')
  assert.equal(group.status, 'conflict')
  assert.equal(read(join(legacy, '.specs/graph/run/state.json')), 'legacy state')
  assert.equal(read(join(destination, '.specs/graph/run/state.json')), 'destination state')
  assert.equal(existsSync(durableBackup), true)
  assert.equal(existsSync(join(destination, 'backups/saved')), true)
})

test('configuration preserves unrelated settings and uses effective Codex override', t => {
  const claude = fixture(t)
  const original = { outputStyle: 'Explanatory', permissions: { deny: ['Read(secret)'] }, hooks: { custom: [{ command: 'keep me' }] } }
  put(join(claude.config, 'settings.json'), original)
  const installed = claude.install()
  assert.deepEqual(JSON.parse(read(join(claude.config, 'settings.json'))), { ...original, outputStyle: 'PO First' })
  restoreInstall(installed.backup, { home: claude.home, env: {} })
  assert.deepEqual(JSON.parse(read(join(claude.config, 'settings.json'))), original)
  const codex = fixture(t, 'codex')
  put(join(codex.config, 'AGENTS.md'), 'lower priority instructions')
  put(join(codex.config, 'AGENTS.override.md'), 'keep this prefix\n\n<!-- po-first:start -->\nold PO First\n<!-- po-first:end -->\nkeep this suffix\n')
  codex.install()
  const override = read(join(codex.config, 'AGENTS.override.md'))
  assert.match(override, /^keep this prefix/)
  assert.match(override, /keep this suffix\n$/)
  assert.doesNotMatch(override, /old PO First/)
  assert.equal(read(join(codex.config, 'AGENTS.md')), 'lower priority instructions')
  const dsh = fixture(t, 'dsh')
  put(join(dsh.config, 'AGENTS.md'), 'keep prefix\n\n<!-- po-first:start -->\nold PO First\n<!-- po-first:end -->\nkeep suffix\n')
  const dshInstalled = dsh.install()
  const dshInstructions = read(join(dsh.config, 'AGENTS.md'))
  assert.match(dshInstructions, /^keep prefix/)
  assert.match(dshInstructions, /keep suffix\n$/)
  assert.doesNotMatch(dshInstructions, /old PO First/)
  assert.equal(dshInstructions.split('<!-- po-first:start -->').length - 1, 1)
  restoreInstall(dshInstalled.backup, { home: dsh.home, env: {} })
  assert.match(read(join(dsh.config, 'AGENTS.md')), /old PO First/)
})

test('Kiro JSON agents retain tools and hooks while receiving only missing resources', t => {
  const f = fixture(t, 'kiro')
  const file = join(f.config, 'agents', 'custom.json')
  const agent = { name: 'custom', tools: ['read'], hooks: { existing: [] }, resources: ['file://~/.kiro/steering/**/*.md', 'skill://~/.kiro/skills/*/SKILL.md'] }
  put(file, agent)
  f.install()
  assert.deepEqual(JSON.parse(read(file)), agent)
  const specific = join(f.config, 'agents', 'specific.json')
  put(specific, { name: 'specific', allowedTools: ['read'], resources: [] })
  f.install()
  const updated = JSON.parse(read(specific))
  assert.deepEqual(updated.allowedTools, ['read'])
  assert.equal(updated.resources.length, 2)
  assert.ok(updated.resources.some(resource => resource.endsWith('/prumo/SKILL.md')))
  assert.ok(updated.resources.some(resource => resource.endsWith('/po-first.md')))
  assert.equal(f.install().backup, null)
})

test('conflicts block only their configuration group, with pending activation reported', t => {
  const f = fixture(t)
  const settings = join(f.config, 'settings.json')
  put(settings, '{ broken json')
  const result = applyInstall(f.plan())
  assert.equal(result.groups.find(group => group.name === 'po-first:claude').status, 'conflict')
  assert.equal(read(settings), '{ broken json')
  assert.ok(existsSync(join(f.skillRoot, 'prumo', 'SKILL.md')))
  const codex = fixture(t, 'codex')
  put(join(codex.config, 'AGENTS.md'), '<!-- po-first:start -->unfinished')
  const blocked = applyInstall(codex.plan())
  assert.equal(blocked.groups.find(group => group.name === 'po-first:codex').status, 'conflict')
  const dsh = fixture(t, 'dsh')
  put(join(dsh.config, 'AGENTS.md'), '<!-- po-first:start -->unfinished')
  const dshBlocked = applyInstall(dsh.plan())
  assert.equal(dshBlocked.groups.find(group => group.name === 'po-first:dsh').status, 'conflict')
})

test('explicit disabled skills and local output styles are not silently overridden', t => {
  const c = fixture(t, 'codex')
  put(join(c.config, 'config.toml'), '[[skills.config]]\npath = "prumo"\nenabled = false\n')
  c.install()
  assert.match(installationStatus(c.plan()).pendingActivation.join('\n'), /explicitly disabled/)
  assert.match(read(join(c.config, 'config.toml')), /enabled = false/)
  const f = fixture(t)
  put(join(f.cwd, '.claude', 'settings.local.json'), { outputStyle: 'Concise' })
  f.install()
  assert.match(installationStatus(f.plan()).pendingActivation.join('\n'), /overrides PO First/)
  assert.equal(JSON.parse(read(join(f.cwd, '.claude', 'settings.local.json'))).outputStyle, 'Concise')
})

test('saved language persists during a subsequent install or doctor without --lang', t => {
  const f = fixture(t)
  applyInstall(f.plan({ lang: 'pt-BR' }))
  const again = f.plan({ lang: undefined })
  assert.equal(again.lang, 'pt-BR')
  assert.equal(installationStatus(again).configured, true)
})

test('empty directory settings use the canonical defaults instead of the current directory', t => {
  for (const harness of ['claude', 'kiro', 'codex', 'dsh']) {
    const f = fixture(t, harness)
    const env = { PRUMO_HOME: '', GRAPH_FOREMAN_HOME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', KIRO_HOME: '', DSH_HOME: '   ' }
    const plan = f.plan({ env })
    assert.equal(plan.config, f.config)
    assert.equal(storageHome(env, f.home), join(f.home, '.local/share/prumo'))
    assert.ok(plan.groups.every(group => !group.conflicts.length))
    assert.ok(applyInstall(plan).groups.every(group => group.status !== 'conflict'))
    const migrated = join(f.home, '.local/share/prumo/work')
    put(join(migrated, '.specs/graph/CURRENT'), 'example')
    const old = join(f.home, '.local/share/graph-foreman/work')
    assert.equal(findRoot({ ...env, PRUMO_ROOT: '', GRAPH_ROOT: old }, f.cwd, f.home), migrated)
  }
})

test('rollback restores committed files when a later write fails; subsequent edits are protected', t => {
  const f = fixture(t)
  const first = join(f.home, 'first')
  const obstacle = join(f.home, 'not-a-directory')
  put(first, 'before')
  put(obstacle, 'file')
  const plan = { home: f.home, allowedRoots: [f.home], groups: [{ name: 'failure', conflicts: [], snapshots: [first], changes: [
    { file: first, before: Buffer.from('before'), after: Buffer.from('after') },
    { file: join(obstacle, 'child'), before: null, after: Buffer.from('cannot write') },
  ] }] }
  const result = applyInstall(plan)
  assert.equal(result.groups[0].status, 'conflict')
  assert.equal(read(first), 'before')
  const installed = f.install()
  put(join(f.config, 'settings.json'), '{"userEdit":true}')
  assert.throws(() => restoreInstall(installed.backup, { home: f.home, env: {} }), /changed since this backup/)
  assert.equal(read(join(f.config, 'settings.json')), '{"userEdit":true}')
})

test('existing project-local data and scripts are preserved, while new data requires central selection', t => {
  const f = fixture(t, 'kiro')
  const legacy = join(f.cwd, '.kiro', 'skills', 'graph-foreman')
  put(join(legacy, 'SKILL.md'), 'legacy project skill')
  const data = join(f.cwd, '.specs', 'graph', 'test', 'state.json')
  put(data, { task: 'unchanged', state: 'running', attempts: [1] })
  const before = read(data)
  f.install()
  assert.equal(read(data), before)
  assert.ok(existsSync(join(f.cwd, '.kiro', 'skills', 'prumo', 'SKILL.md')))
  assert.equal(findRoot({}, f.cwd, f.home), f.cwd)
  const empty = join(f.home, 'empty')
  mkdirSync(empty)
  assert.throws(() => findRoot({}, empty, f.home), /Select a workspace/)
  assert.equal(storageHome({}, f.home), join(f.home, '.local', 'share', 'prumo'))
})

test('an in-flight validation finishes across overlay without a new attempt or stale receipt', async t => {
  const f = fixture(t)
  const legacy = join(f.skillRoot, 'graph-foreman')
  mkdirSync(legacy, { recursive: true })
  cpSync(join(source, 'scripts'), join(legacy, 'scripts'), { recursive: true })
  put(join(legacy, 'SKILL.md'), 'legacy skill')
  const central = join(f.home, 'central')
  const root = join(central, 'work')
  mkdirSync(root, { recursive: true })
  const env = { ...process.env, PRUMO_HOME: central, PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  const engine = join(legacy, 'scripts', 'engine.mjs')
  const cli = args => spawnSync(process.execPath, [engine, ...args], { env, cwd: f.cwd, encoding: 'utf8', timeout: 20000 })
  put(join(f.cwd, 'verify.cjs'), "const fs=require('node:fs'); fs.writeFileSync('started','yes'); const timer=setInterval(()=>{if(fs.existsSync('continue')){clearInterval(timer); console.log('behavior verified');}},30); setTimeout(()=>process.exit(2),15000).unref();")
  const plan = join(root, 'plan.json')
  put(plan, { name: 'active', tasks: [{ id: 'T1', title: 'Active work', validation: [{ kind: 'functional', run: 'node verify.cjs', expect: 'behavior verified' }] }] })
  const taskPlan = join(root, 'task-plan.json')
  put(taskPlan, {
    research: [{ source: 'verify.cjs', findings: 'Signals startup and waits for the continuation file before reporting verification.' }],
    decisions: [], steps: ['Preserve the running verification while overlaying the installed skill.'],
    verification: [{ criterion: 'The verification completes across installation in the same attempt.', check: 1 }], openQuestions: [],
  })
  const discovery = join(root, 'discovery.json')
  put(discovery, { research: [{ source: 'verify.cjs', findings: 'The active validation flow was inspected.' }],
    questions: [{ question: 'Preserve the in-flight validation?', answer: 'Yes.', channel: 'chat-fallback', round: 1 }],
    coverage: { problem: 'Overlay during validation', affected: 'Active run', outcome: 'No lost attempt', currentBehavior: 'Validation is active',
      desiredBehavior: 'Complete same attempt', rules: 'Preserve state', exceptions: 'None', scope: 'Overlay', acceptance: 'Validation completes' },
    decisions: [], deferred: [], executionBoundary: { deferredToExecutor: ['T1'], prematureTaskWork: [] },
    closure: 'The in-flight behavior is fully specified.' })
  for (const args of [['init', '--plan', plan, '--run', 'active'], ['begin-discussion', 'T1']]) {
    const result = cli(args)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  const statePath = join(root, '.specs', 'graph', 'active', 'state.json')
  const round = JSON.parse(read(statePath)).tasks.T1.discussionAttempts.at(-1)
  const context = JSON.parse(read(discovery))
  context.roundId = round.roundId
  context.nonce = round.nonce
  context.questions = context.questions.map(question => ({ ...question, roundId: round.roundId }))
  put(discovery, context)
  for (const args of [['finish-discussion', 'T1', '--context', discovery], ['plan-task', 'T1', '--agent', 'planner', '--context', discovery],
    ['finish-planning', 'T1', '--plan', taskPlan], ['start', 'T1', '--agent', 'executor'], ['review', 'T1', '--agent', 'reviewer']]) {
    const result = cli(args)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  const child = spawn(process.execPath, [engine, 'validate', 'T1', '--ok', '--evidence', 'Executed observable verification', '--cwd', f.cwd], { env, cwd: f.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  const exit = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const deadline = Date.now() + 10000
  while (!existsSync(join(f.cwd, 'started')) && Date.now() < deadline) await setTimeout(30)
  assert.ok(existsSync(join(f.cwd, 'started')), output)
  const before = read(statePath)
  f.install()
  assert.equal(read(statePath), before)
  put(join(f.cwd, 'continue'), 'yes')
  assert.equal(await exit, 0, output)
  const done = spawnSync(process.execPath, [join(f.skillRoot, 'prumo', 'scripts', 'engine.mjs'), 'done', 'T1'], { env, cwd: f.cwd, encoding: 'utf8', timeout: 20000 })
  assert.equal(done.status, 0, done.stderr)
  const state = JSON.parse(read(statePath))
  assert.equal(state.tasks.T1.attempts.length, 1)
  assert.equal(state.tasks.T1.planningHistory.length, 1)
  assert.equal(state.tasks.T1.taskPlan.planner, 'planner')
  assert.equal(state.tasks.T1.state, 'done')
})
