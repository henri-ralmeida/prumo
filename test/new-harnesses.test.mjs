import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { HARNESSES, planInstall, applyInstall, restoreInstall, detectHarnesses, discoverInstallations, installationStatus, installedPoFirstLanguage } from '../lib/install.mjs'
import { inside } from '../scripts/storage.mjs'

const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const read = file => readFileSync(file, 'utf8')
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

for (const [harness, executable] of [['antigravity', 'agy'], ['antigravity', 'antigravity'], ['opencode', 'opencode'], ['grok', 'grok']])
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
