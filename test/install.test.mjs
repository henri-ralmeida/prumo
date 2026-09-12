import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, cpSync, realpathSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { planInstall, applyInstall, restoreInstall, installationStatus, detectHarnesses, discoverInstallations } from '../lib/install.mjs'
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
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: join(f.home, '.claude'), CODEX_HOME: join(f.home, '.codex'), PRUMO_HOME: join(f.home, 'data'), PRUMO_LANG: 'en' }
  for (const key of Object.keys(env)) if (/^path$/i.test(key) || ['GRAPH_ROOT', 'PRUMO_ROOT', 'GRAPH_FOREMAN_HOME'].includes(key)) delete env[key]
  const commands = join(f.home, 'test-commands')
  const npm = join(commands, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  put(npm, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n')
  chmodSync(npm, 0o755)
  env.PATH = commands
  if (process.platform === 'win32') env.PATHEXT = '.CMD;.EXE'
  return args => spawnSync(process.execPath, [join(source, 'bin', 'prumo.mjs'), ...args], { cwd: f.cwd, env, encoding: 'utf8', timeout: 20000, windowsHide: true })
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

test('automatic CLI installs only detected harnesses, preserves runs and backups, and keeps explicit selection', t => {
  const f = fixture(t)
  const cli = isolatedCli(f)
  const legacy = join(f.home, '.claude', 'skills', 'graph-foreman', 'SKILL.md')
  put(legacy, 'original legacy skill')
  put(join(f.home, '.kiro', 'steering', 'existing.md'), 'Keep this instruction')
  const state = join(f.home, '.local', 'share', 'graph-foreman', 'work', '.specs', 'graph', 'active', 'state.json')
  put(state, { state: 'blocked', attempts: [1], evidence: 'keep', contract: 'approved' })
  const before = read(state)
  const marker = harness => join(f.home, harness === 'codex' ? '.agents' : `.${harness}`, 'skills', 'prumo', '.prumo-install.json')
  const preview = cli(['install', '--lang', 'pt-BR', '--dry-run'])
  assert.equal(preview.status, 0, preview.stdout + preview.stderr)
  assert.match(preview.stdout, /Ambientes detectados: claude, kiro/)
  assert.equal(existsSync(marker('claude')), false)
  assert.equal(existsSync(join(f.home, '.local', 'share', 'prumo')), false)
  const blocked = cli(['install'])
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /Interactive selection needs a terminal/)
  assert.equal(existsSync(marker('claude')), false)
  const installed = cli(['install', '--all', '--lang', 'pt-BR'])
  assert.equal(installed.status, 0, installed.stdout + installed.stderr)
  assert.match(installed.stdout, /Prumo instalado com sucesso/)
  assert.ok(installed.stdout.includes('Prumo v' + packageVersion))
  assert.doesNotMatch(installed.stdout, /Alterações \/|gravar:|Backup:/)
  for (const harness of ['claude', 'kiro']) assert.equal(JSON.parse(read(marker(harness))).lang, 'pt-BR')
  assert.equal(existsSync(marker('codex')), false)
  assert.equal(existsSync(join(f.home, '.codex')), false)
  assert.equal(read(state), before)
  assert.equal(existsSync(legacy), false)
  const backups = join(f.home, '.local', 'share', 'prumo', 'backups')
  const count = readdirSync(backups).length
  assert.equal(count, 2)
  const repeated = cli(['install'])
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr)
  assert.match(repeated.stdout, new RegExp(`Prumo v${packageVersion.replaceAll('.', '\\.')} is already installed in claude, kiro`))
  assert.equal(readdirSync(backups).length, count)
  const explicit = cli(['install', '--codex'])
  assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr)
  assert.ok(existsSync(marker('codex')))
  assert.equal(read(state), before)
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
  assert.equal(cli(['install', '--all', '--claude']).status, 1)
  put(join(f.home, '.claude', 'settings.json'), '{broken')
  put(join(f.home, '.kiro', 'settings', 'cli.json'), {})
  const conflict = cli(['install', '--all'])
  assert.equal(conflict.status, 2, conflict.stdout + conflict.stderr)
  assert.equal(read(join(f.home, '.claude', 'settings.json')), '{broken')
  assert.ok(existsSync(join(f.home, '.kiro', 'skills', 'prumo', 'SKILL.md')))
  assert.match(read(join(f.home, '.kiro', 'steering', 'po-first.md')), /inclusion: always/)
})

for (const harness of ['claude', 'kiro', 'codex']) test(`${harness}: persistent install, activation, idempotence and restore`, t => {
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
  assert.match(read(join(skill, 'references', 'po-first.md')), /senior product partner/)
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

test('overlay migrates the legacy skill, preserves run data and supports complete restore', t => {
  const f = fixture(t)
  const legacy = join(f.skillRoot, 'graph-foreman')
  const prumo = join(f.skillRoot, 'prumo')
  put(join(legacy, 'SKILL.md'), 'old skill instructions')
  put(join(legacy, 'scripts', 'engine.mjs'), '// old engine')
  put(join(legacy, 'custom.bin'), 'custom bytes preserved')
  const central = join(f.home, '.local', 'share', 'graph-foreman')
  const root = join(central, 'work')
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
    decisions: [], deferred: [], closure: 'The documentation task is fully specified.' })
  for (const args of [['init', '--plan', planPath, '--run', 'legacy'], ['plan-task', 'T1', '--agent', 'planner', '--context', discovery],
    ['finish-planning', 'T1', '--plan', taskPlan], ['start', 'T1', '--agent', 'original'], ['block', 'T1', '--reason', 'User pause']]) {
    const result = spawnSync(process.execPath, [join(source, 'scripts', 'engine.mjs'), ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const statePath = join(root, '.specs', 'graph', 'legacy', 'state.json')
  const eventsPath = join(root, '.specs', 'graph', 'legacy', 'events.ndjson')
  const before = [read(statePath), read(eventsPath), read(planPath)]
  assert.ok(f.plan().data.some(data => data.root === root))
  const result = f.install()
  assert.deepEqual([read(statePath), read(eventsPath), read(planPath)], before)
  assert.equal(existsSync(legacy), false)
  assert.equal(read(join(prumo, 'custom.bin')), 'custom bytes preserved')
  const prumoCall = spawnSync(process.execPath, [join(prumo, 'scripts', 'engine.mjs'), 'graph'], { env, encoding: 'utf8' })
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
    decisions: [], deferred: [], closure: 'The in-flight behavior is fully specified.' })
  for (const args of [['init', '--plan', plan, '--run', 'active'], ['plan-task', 'T1', '--agent', 'planner', '--context', discovery],
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
  const statePath = join(root, '.specs', 'graph', 'active', 'state.json')
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
