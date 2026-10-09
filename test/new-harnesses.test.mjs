import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { HARNESSES, planInstall, applyInstall, restoreInstall, detectHarnesses, discoverInstallations, installationStatus, installedPoFirstLanguage, installationFilesCurrent } from '../lib/install.mjs'
import { inside } from '../scripts/storage.mjs'

const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const read = file => readFileSync(file, 'utf8')

test('Copilot valida idioma legado e denuncia marcador removido sem perder arquivos', t => {
  const f = fixture(t, 'copilot'), root = join(f.home, '.copilot', 'skills')
  applyInstall(f.plan({ lang: 'en' }))
  assert.equal(installationFilesCurrent(root, {}), true)
  rmSync(join(root, 'prumo', '.prumo-install.json'))
  const errors = []
  assert.deepEqual(discoverInstallations({ ...f.options, onError: error => errors.push(error.message) }), [])
  assert.ok(errors.some(error => error.includes('Invalid Prumo installation marker')))
  assert.ok(existsSync(join(root, 'prumo', 'SKILL.md')))
})

test('Copilot instala skills para CLI e VS Code e preserva instrucoes, configuracao e dados', t => {
  const f = fixture(t, 'copilot'), config = join(f.home, '.copilot')
  const globalRules = join(config, 'copilot-instructions.md'), projectRules = join(f.cwd, '.github', 'copilot-instructions.md')
  put(globalRules, 'Preferencias pessoais.\n'); put(projectRules, 'Regras existentes do projeto.\n')
  put(join(config, 'settings.json'), '{"model":"modelo-existente"}\n')
  put(join(f.cwd, '.specs', 'graph', 'run', 'state.json'), '{"historico":"preservar"}\n')
  const plan = f.plan(), before = read(globalRules)
  assert.equal(applyInstall(plan, { dryRun: true }).backup, null)
  assert.equal(read(globalRules), before)
  const result = applyInstall(plan)
  assert.ok(result.groups.every(group => group.status !== 'conflict'), JSON.stringify(result))
  assert.match(read(join(config, 'skills', 'prumo', 'SKILL.md')), /name: prumo/)
  assert.ok(read(globalRules).startsWith(before)); assert.ok(read(projectRules).startsWith('Regras existentes do projeto.\n'))
  assert.equal(read(projectRules).split('<!-- po-first:start -->').length, 2)
  assert.equal(read(join(config, 'settings.json')), '{"model":"modelo-existente"}\n')
  assert.equal(read(join(f.cwd, '.specs', 'graph', 'run', 'state.json')), '{"historico":"preservar"}\n')
  assert.equal(installedPoFirstLanguage('copilot', config), 'pt-BR')
  assert.equal(installationStatus(f.plan()).configured, true)
  assert.equal(applyInstall(f.plan()).backup, null)
  assert.deepEqual(discoverInstallations(f.options).map(entry => entry.harness), ['copilot'])
  assert.ok(restoreInstall(result.backup, { home: f.home, env: {} }) > 0)
  assert.equal(read(globalRules), before)
  assert.equal(read(projectRules), 'Regras existentes do projeto.\n')
})

test('Copilot detecta extensao nativa e configuracao, mas nao pastas vazias nem regras apenas gerenciadas', t => {
  const f = fixture(t, 'copilot')
  mkdirSync(join(f.home, '.copilot'), { recursive: true })
  assert.deepEqual(detectHarnesses(f.options), [])
  const extension = join(f.home, '.vscode', 'extensions', 'github.copilot-chat-1.0.0')
  mkdirSync(extension, { recursive: true })
  assert.deepEqual(detectHarnesses(f.options), ['copilot'])
  rmSync(join(f.home, '.vscode'), { recursive: true })
  put(join(f.home, '.vscode-insiders', 'extensions', 'github.copilot-1.0.0', 'package.json'), '{}')
  assert.deepEqual(detectHarnesses(f.options), ['copilot'])
  rmSync(join(f.home, '.vscode-insiders'), { recursive: true })
  put(join(f.home, '.copilot', 'config.json'), '{}')
  assert.deepEqual(detectHarnesses(f.options), ['copilot'])
  rmSync(join(f.home, '.copilot', 'config.json'))
  applyInstall(f.plan())
  assert.deepEqual(detectHarnesses({ ...f.options, includeManaged: false }), [])
  assert.deepEqual(detectHarnesses(f.options), ['copilot'])
  put(join(f.cwd, '.github', 'copilot-instructions.md'), 'Regra pessoal do projeto.\n')
  assert.deepEqual(detectHarnesses({ ...f.options, includeManaged: false }), ['copilot'])
})

test('COPILOT_HOME atende CLI personalizado e conserva a skill pessoal padrao do VS Code', t => {
  const f = fixture(t, 'copilot'), config = join(f.home, 'copilot personalizado'), env = { COPILOT_HOME: config }
  put(join(config, 'settings.json'), '{}')
  assert.deepEqual(detectHarnesses({ ...f.options, env }), ['copilot'])
  applyInstall(f.plan({ env }))
  for (const root of [config, join(f.home, '.copilot')]) assert.ok(existsSync(join(root, 'skills', 'prumo', 'SKILL.md')))
  assert.equal(discoverInstallations({ ...f.options, env })[0].config, config)
})
function fixture(t, harness, env = {}) {
  const parent = realpathSync(tmpdir())
  const home = mkdtempSync(join(parent, 'prumo-new-harness-'))
  const cwd = join(home, 'projeto com espacos')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  t.after(() => {
    assert.equal(dirname(home), parent)
    assert.ok(home.startsWith(join(parent, 'prumo-new-harness-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  })
  const options = { harness, home, cwd, env, lang: 'pt-BR' }
  const plan = (extra = {}) => {
    const value = planInstall({ ...options, ...extra })
    for (const change of value.groups.flatMap(group => group.changes)) assert.ok(inside(home, change.file), change.file)
    return value
  }
  return { home, cwd, options, plan }
}

for (const harness of ['antigravity', 'opencode', 'grok']) test(`${harness}: instalação reversível preserva regras, modelos e planos`, t => {
  const f = fixture(t, harness)
  const initial = f.plan()
  const rules = join(initial.config, 'AGENTS.md')
  const settings = join(initial.config, harness === 'opencode' ? 'opencode.json' : 'config.toml')
  const preferences = harness === 'opencode' ? '{"model":"meu-modelo","permission":{"edit":"ask"}}\n' : 'modelo_do_usuario = "preservar"\n'
  put(rules, 'Regras pessoais que devem permanecer.\n')
  put(settings, preferences)
  const state = join(f.cwd, '.specs', 'graph', 'run', 'state.json')
  put(state, '{"history":["evidencia existente"]}\n')
  const before = readdirSync(f.home)
  assert.equal(applyInstall(f.plan(), { dryRun: true }).backup, null)
  assert.deepEqual(readdirSync(f.home), before)
  assert.equal(read(rules), 'Regras pessoais que devem permanecer.\n')
  const result = applyInstall(f.plan())
  assert.ok(result.groups.every(group => group.status !== 'conflict'), JSON.stringify(result))
  const roots = initial.groups.filter(group => group.name.startsWith('skill:')).map(group => group.name.slice(6))
  assert.equal(roots.length, harness === 'antigravity' ? 2 : 1)
  for (const root of roots) {
    assert.match(read(join(root, 'prumo', 'SKILL.md')), /name: prumo/)
    assert.ok(existsSync(join(root, 'prumo', 'references', 'planning.md')))
    assert.ok(existsSync(join(root, 'prumo', 'scripts', 'engine.mjs')))
    assert.equal(JSON.parse(read(join(root, 'prumo', '.prumo-install.json'))).harness, harness)
  }
  assert.ok(read(rules).startsWith('Regras pessoais que devem permanecer.\n'))
  assert.equal(read(rules).split('<!-- po-first:start -->').length, 2)
  assert.equal(installedPoFirstLanguage(harness, initial.config), 'pt-BR')
  assert.equal(installationStatus(f.plan()).configured, true)
  assert.equal(applyInstall(f.plan()).backup, null)
  assert.deepEqual(detectHarnesses(f.options), [harness])
  assert.deepEqual(discoverInstallations(f.options).map(entry => entry.harness), [harness])
  assert.equal(read(settings), preferences)
  assert.equal(read(state), '{"history":["evidencia existente"]}\n')
  assert.ok(restoreInstall(result.backup, { home: f.home, env: {} }) > 0)
  assert.equal(read(rules), 'Regras pessoais que devem permanecer.\n')
  for (const root of roots) assert.equal(existsSync(join(root, 'prumo', 'SKILL.md')), false)
})

test('pastas vazias e configuração genérica do Gemini não detectam novos harnesses', t => {
  const f = fixture(t, 'grok')
  for (const folder of ['.grok', '.gemini', '.opencode', '.config/opencode']) mkdirSync(join(f.home, folder), { recursive: true })
  put(join(f.home, '.gemini', 'settings.json'), '{"model":"gemini"}')
  assert.deepEqual(detectHarnesses(f.options), [])
  assert.deepEqual(discoverInstallations(f.options), [])
})

for (const [harness, executable] of [['antigravity', 'agy'], ['antigravity', 'antigravity'], ['opencode', 'opencode'], ['grok', 'grok'], ['copilot', 'copilot'], ['hermes', 'hermes'], ['openclaw', 'openclaw']])
  test(`${harness}: detecta o executável ${executable} sem criar configuração`, t => {
    const f = fixture(t, harness)
    const folder = join(f.home, 'bin')
    const file = join(folder, executable + (process.platform === 'win32' ? '.cmd' : ''))
    put(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
    assert.deepEqual(detectHarnesses({ ...f.options, env: { PATH: folder, PATHEXT: '.CMD' } }), [harness])
    assert.equal(existsSync(join(f.home, '.gemini')), false)
  })

test('Antigravity detecta configuração do CLI ou IDE, sem confundir skills do Codex', t => {
  const f = fixture(t, 'antigravity')
  put(join(f.home, '.gemini', 'antigravity-cli', 'config.json'), '{}')
  assert.deepEqual(detectHarnesses(f.options), ['antigravity'])
  rmSync(join(f.home, '.gemini', 'antigravity-cli'), { recursive: true })
  put(join(f.home, '.gemini', 'antigravity', 'settings.json'), '{}')
  assert.deepEqual(detectHarnesses(f.options), ['antigravity'])
  rmSync(join(f.home, '.gemini', 'antigravity'), { recursive: true })
  put(join(f.home, '.gemini', 'config', 'settings.json'), '{}')
  assert.deepEqual(detectHarnesses({ ...f.options, includeManaged: false }), ['antigravity'])
  rmSync(join(f.home, '.gemini', 'config'), { recursive: true })
  applyInstall(planInstall({ ...f.options, harness: 'codex' }))
  assert.deepEqual(detectHarnesses(f.options), ['codex'])
})

test('OpenCode e Grok detectam configurações de projeto no limite do repositório', t => {
  const f = fixture(t, 'opencode')
  put(join(f.cwd, 'opencode.jsonc'), '{ /* preferências */ }')
  put(join(f.cwd, '.grok', 'config.toml'), '[models]\n')
  assert.deepEqual(detectHarnesses(f.options), ['opencode', 'grok'])
  rmSync(join(f.cwd, 'opencode.jsonc'))
  put(join(f.cwd, '.opencode', 'opencode.json'), '{}')
  assert.deepEqual(detectHarnesses(f.options), ['opencode', 'grok'])
})

test('OpenCode instala skills no diretório personalizado e mantém PO First global', t => {
  const f = fixture(t, 'opencode')
  const env = { XDG_CONFIG_HOME: join(f.home, 'configuracoes'), OPENCODE_CONFIG_DIR: join(f.home, 'opencode-personalizado') }
  put(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), '{}')
  const options = { ...f.options, env }
  assert.deepEqual(detectHarnesses(options), ['opencode'])
  const plan = f.plan({ env })
  assert.equal(plan.config, join(env.XDG_CONFIG_HOME, 'opencode'))
  applyInstall(plan)
  assert.ok(existsSync(join(env.OPENCODE_CONFIG_DIR, 'skills', 'prumo', 'SKILL.md')))
  assert.ok(existsSync(join(plan.config, 'AGENTS.md')))
  assert.equal(discoverInstallations(options)[0].roots.length, 2)
})

test('GROK_HOME direciona descoberta, instalação e diagnóstico para o mesmo local', t => {
  const f = fixture(t, 'grok')
  const env = { GROK_HOME: join(f.home, 'grok personalizado') }
  put(join(env.GROK_HOME, 'config.toml'), '[models]\n')
  assert.deepEqual(detectHarnesses({ ...f.options, env }), ['grok'])
  const plan = f.plan({ env })
  applyInstall(plan)
  assert.ok(existsSync(join(env.GROK_HOME, 'skills', 'prumo', 'SKILL.md')))
  assert.equal(discoverInstallations({ ...f.options, env })[0].config, env.GROK_HOME)
  assert.equal(existsSync(join(f.home, '.grok')), false)
})

test('Codex e Antigravity preservam a instalação compartilhada que pertence ao outro', t => {
  const f = fixture(t, 'antigravity')
  const root = join(f.cwd, '.agents', 'skills')
  applyInstall(f.plan({ skillRoots: [root] }))
  const original = read(join(root, 'prumo', '.prumo-install.json'))
  const codex = planInstall({ ...f.options, harness: 'codex' })
  assert.equal(codex.groups.some(group => group.name === `skill:${root}`), false)
  applyInstall(codex)
  assert.equal(read(join(root, 'prumo', '.prumo-install.json')), original)
  assert.deepEqual(discoverInstallations(f.options).map(entry => entry.harness).sort(), ['antigravity', 'codex'])
  assert.deepEqual(detectHarnesses(f.options), ['codex', 'antigravity'])
})

test('instalar Antigravity preserva a skill Codex do projeto e configura seus dois destinos globais', t => {
  const f = fixture(t, 'antigravity')
  const root = join(f.cwd, '.agents', 'skills')
  applyInstall(planInstall({ ...f.options, harness: 'codex', skillRoots: [root] }))
  const marker = read(join(root, 'prumo', '.prumo-install.json'))
  const plan = f.plan()
  assert.equal(plan.groups.some(group => group.name === `skill:${root}`), false)
  applyInstall(plan)
  assert.equal(read(join(root, 'prumo', '.prumo-install.json')), marker)
  assert.ok(existsSync(join(f.home, '.gemini', 'config', 'skills', 'prumo', 'SKILL.md')))
  assert.ok(existsSync(join(f.home, '.gemini', 'antigravity-cli', 'skills', 'prumo', 'SKILL.md')))
})

test('Grok atualiza idioma gerenciado sem duplicar PO First nem alterar instruções pessoais', t => {
  const f = fixture(t, 'grok')
  const rules = join(f.home, '.grok', 'AGENTS.md')
  put(rules, 'Instruções pessoais antes da instalação.\n')
  applyInstall(f.plan({ lang: 'en' }))
  assert.equal(installedPoFirstLanguage('grok', join(f.home, '.grok')), 'en')
  applyInstall(f.plan({ lang: 'pt-BR' }))
  assert.equal(installedPoFirstLanguage('grok', join(f.home, '.grok')), 'pt-BR')
  assert.equal(read(rules).split('<!-- po-first:start -->').length, 2)
  assert.ok(read(rules).startsWith('Instruções pessoais antes da instalação.\n'))
  assert.deepEqual(discoverInstallations(f.options).map(entry => entry.harness), ['grok'])
})

test('arquivos criados apenas pelo Prumo permitem reparo sem anunciar aplicativos inexistentes', t => {
  const f = fixture(t, 'grok')
  const env = { CODEX_HOME: join(f.home, '.codex') }
  for (const harness of HARNESSES) {
    const result = applyInstall(f.plan({ harness, env }))
    assert.ok(result.groups.every(group => group.status !== 'conflict'), JSON.stringify(result))
  }
  assert.deepEqual(detectHarnesses({ ...f.options, env }), HARNESSES)
  assert.deepEqual(detectHarnesses({ ...f.options, env, includeManaged: false }), [])
  assert.equal(discoverInstallations({ ...f.options, env }).length, HARNESSES.length)
  put(join(f.home, '.claude', 'settings.json'), '{"outputStyle":"PO First","model":"modelo-do-usuario"}')
  assert.deepEqual(detectHarnesses({ ...f.options, env, includeManaged: false }), ['claude'])
  put(join(f.home, '.claude', 'settings.json'), '{invalido')
  assert.deepEqual(detectHarnesses({ ...f.options, env, includeManaged: false }), [])
  put(join(f.cwd, '.claude', 'settings.local.json'), '{"permissions":{}}')
  put(join(f.home, '.kiro', 'steering', 'regra-do-usuario.md'), 'Regra própria do Kiro.')
  put(join(f.home, '.dsh', 'AGENTS.md'), 'Instrução própria do DSH.\n')
  assert.deepEqual(detectHarnesses({ ...f.options, env, includeManaged: false }), ['claude', 'kiro', 'dsh'])
})

for (const harness of ['hermes', 'openclaw']) test(harness + ': instalação preserva perfil, instruções e permite restauração', t => {
  const f = fixture(t, harness)
  const config = join(f.home, 'perfil')
  const workspace = join(f.home, 'workspace-agente')
  const env = harness === 'hermes' ? { HERMES_HOME: config } : { OPENCLAW_STATE_DIR: config, OPENCLAW_WORKSPACE_DIR: workspace }
  const rules = join(harness === 'hermes' ? f.cwd : workspace, 'AGENTS.md')
  const settings = join(config, harness === 'hermes' ? 'config.yaml' : 'openclaw.json')
  const personal = harness === 'hermes' ? 'model: modelo-pessoal\n' : '{"model":"modelo-pessoal"}\n'
  put(settings, personal)
  put(rules, 'Instruções pessoais.\n')
  assert.deepEqual(detectHarnesses({ ...f.options, env }), [harness])
  const plan = f.plan({ env })
  applyInstall(plan, { dryRun: true })
  assert.equal(read(rules), 'Instruções pessoais.\n')
  const result = applyInstall(plan)
  assert.ok(result.groups.every(group => group.status !== 'conflict'), JSON.stringify(result))
  const root = join(config, 'skills', 'prumo')
  for (const file of ['SKILL.md', 'scripts/engine.mjs', 'scripts/storage.mjs', 'references/dispatch.md']) assert.ok(existsSync(join(root, file)))
  assert.equal(JSON.parse(read(join(root, '.prumo-install.json'))).harness, harness)
  mkdirSync(join(f.cwd, '.specs', 'graph'), { recursive: true })
  const planFile = join(f.cwd, 'runtime-plan.json')
  put(planFile, JSON.stringify({ name: 'Runtime instalado', tasks: [{ id: 'T1', title: 'Conferir runtime', validation: [{ kind: 'functional', run: 'node --version', expect: 'Runtime disponível' }] }] }))
  const runtime = spawnSync(process.execPath, [join(root, 'scripts', 'engine.mjs'), 'init', '--plan', planFile, '--run', 'installed-runtime'], { cwd: f.cwd, env: { ...process.env, PRUMO_ROOT: f.cwd, PRUMO_HOME: join(f.home, 'data'), PRUMO_LANG: 'en' }, encoding: 'utf8', windowsHide: true, timeout: 20000 })
  assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr)
  assert.ok(existsSync(join(f.cwd, '.specs', 'graph', 'installed-runtime', 'state.json')))
  assert.ok(read(rules).startsWith('Instruções pessoais.\n'))
  assert.equal(read(rules).split('<!-- po-first:start -->').length, 2)
  assert.equal(read(settings), personal)
  assert.equal(applyInstall(f.plan({ env })).backup, null)
  assert.deepEqual(discoverInstallations({ ...f.options, env }).map(value => value.harness), [harness])
  assert.ok(restoreInstall(result.backup, { home: f.home, env }) > 0)
  assert.equal(read(rules), 'Instruções pessoais.\n')
  assert.equal(existsSync(join(root, 'SKILL.md')), false)
})

test('Hermes respeita instruções prioritárias do projeto sem alterar personalidade', t => {
  const f = fixture(t, 'hermes')
  put(join(f.cwd, '.hermes.md'), 'Regra prioritária.\n')
  put(join(f.cwd, 'AGENTS.md'), 'Regra secundária.\n')
  const config = join(f.home, 'hermes-perfil')
  put(join(config, 'SOUL.md'), 'Personalidade pessoal.\n')
  applyInstall(f.plan({ env: { HERMES_HOME: config } }))
  assert.match(read(join(f.cwd, '.hermes.md')), /po-first:start/)
  assert.equal(read(join(f.cwd, 'AGENTS.md')), 'Regra secundária.\n')
  assert.equal(read(join(config, 'SOUL.md')), 'Personalidade pessoal.\n')
})

test('OpenClaw usa workspaces configurados e recusa configuração ambígua sem escrita', t => {
  const f = fixture(t, 'openclaw'), config = join(f.home, '.openclaw')
  const one = join(f.home, 'agente-um'), two = join(f.home, 'agente-dois')
  put(join(config, 'openclaw.json'), JSON.stringify({ agents: { entries: { one: { workspace: one }, two: { workspace: two } } } }))
  const plan = f.plan()
  assert.ok(plan.groups.some(group => group.snapshots.includes(join(one, 'AGENTS.md'))))
  assert.ok(plan.groups.some(group => group.snapshots.includes(join(two, 'AGENTS.md'))))
  applyInstall(plan)
  for (const root of [one, two]) assert.match(read(join(root, 'AGENTS.md')), /po-first:start/)
  put(join(config, 'openclaw.json'), '{ agents: { defaults: { workspace: "custom" } } }')
  assert.throws(() => f.plan(), /use --project/)
  const explicit = f.plan({ projects: [one] })
  assert.ok(explicit.groups.some(group => group.snapshots.includes(join(one, 'AGENTS.md'))))
  assert.equal(explicit.groups.some(group => group.snapshots.includes(join(two, 'AGENTS.md'))), false)
})

test('Hermes e OpenClaw não são detectados por pastas vazias', t => {
  const f = fixture(t, 'hermes')
  const env = { HERMES_HOME: join(f.home, 'hermes-vazio'), OPENCLAW_STATE_DIR: join(f.home, 'openclaw-vazio') }
  mkdirSync(env.HERMES_HOME)
  mkdirSync(env.OPENCLAW_STATE_DIR)
  assert.deepEqual(detectHarnesses({ ...f.options, env }), [])
})

test('OpenClaw mantém o workspace registrado ao atualizar de outro diretório', t => {
  const f = fixture(t, 'openclaw'), workspace = join(f.home, 'workspace-correto')
  applyInstall(f.plan({ env: { OPENCLAW_WORKSPACE_DIR: workspace } }))
  const installations = discoverInstallations(f.options)
  assert.deepEqual(installations[0].projects, [workspace])
  const update = f.plan({ projects: installations[0].projects, onlyInstalled: true })
  assert.ok(update.groups.some(group => group.snapshots.includes(join(workspace, 'AGENTS.md'))))
  assert.equal(update.groups.some(group => group.snapshots.includes(join(f.cwd, 'AGENTS.md'))), false)
})

test('OpenClaw resolve defaults, perfis, múltiplos agentes e caminhos pessoais', t => {
  const f = fixture(t, 'openclaw'), config = join(f.home, '.openclaw')
  const inspect = (settings, expected, env = {}) => {
    put(join(config, 'openclaw.json'), JSON.stringify(settings))
    const value = f.plan({ env })
    for (const path of expected) assert.ok(value.groups.some(group => group.snapshots.includes(join(path, 'AGENTS.md'))), path)
  }
  inspect({}, [join(config, 'workspace')])
  inspect({ agents: { defaults: { workspace: '~/personal' } } }, [join(f.home, 'personal')])
  inspect({ agents: { list: [{ id: 'main' }] } }, [join(config, 'workspace')])
  inspect({ agents: { defaults: { workspace: join(f.home, 'base') }, list: [{ id: 'main' }] } }, [join(f.home, 'base')])
  inspect({ agents: { list: [{ id: 'one' }, { id: 'two' }] } }, [join(config, 'workspace-one'), join(config, 'workspace-two')])
  inspect({ agents: { defaults: { workspace: join(f.home, 'base') }, list: [{ id: 'one' }, { id: 'two' }] } }, [join(f.home, 'base', 'one'), join(f.home, 'base', 'two')])
  put(join(config, 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: '../outside' }, { id: 'two' }] } }))
  assert.throws(() => f.plan(), /Invalid OpenClaw agent identifier/)
  const profile = f.plan({ env: { OPENCLAW_PROFILE: 'work' } })
  assert.equal(profile.config, join(f.home, '.openclaw-work'))
  assert.ok(profile.groups.some(group => group.snapshots.includes(join(f.home, '.openclaw-work', 'workspace', 'AGENTS.md'))))
})
