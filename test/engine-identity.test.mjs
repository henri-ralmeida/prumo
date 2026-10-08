import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installationBundle, packageIdentity } from '../scripts/installation-bundle.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version

function workspace(t) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-identity-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const root = join(home, 'workspace')
  mkdirSync(root)
  const planPath = join(root, 'plan.json')
  writeFileSync(planPath, JSON.stringify({ name: 'identity', planningMode: 'task', tasks: [
    { id: 'T1', title: 'Delivery', validation: [{ kind: 'functional', run: 'node -e 0', expect: 'the check passes' }] }] }))
  const env = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: home, PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  const run = (engine, ...args) => {
    const result = spawnSync(process.execPath, [engine, ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000, windowsHide: true })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }
  return { home, planPath, run, env }
}

function install(home, marker) {
  const skill = join(home, 'skills', 'prumo')
  for (const [name, bytes] of installationBundle(marker.lang ?? 'en')) {
    mkdirSync(dirname(join(skill, name)), { recursive: true })
    writeFileSync(join(skill, name), bytes)
  }
  writeFileSync(join(skill, '.prumo-install.json'), JSON.stringify(marker))
  return join(skill, 'scripts', 'engine.mjs')
}

test('status starts by identifying a source checkout with its computed content ID', t => {
  const w = workspace(t)
  const engine = join(packageRoot, 'scripts', 'engine.mjs')
  w.run(engine, 'init', '--plan', w.planPath, '--run', 'identity-01')
  const first = w.run(engine, 'status').split(/\r?\n/)[0]
  assert.equal(first, `[prumo] Prumo ${version} (${packageIdentity('en').contentId}) — source checkout without an installation marker; harness not recorded`)
})

test('status reads version, content ID and harness from the installation marker and warns on a changed engine', t => {
  const w = workspace(t)
  const identity = packageIdentity('en')
  const engine = install(w.home, { product: 'prumo', version, harness: 'dsh', lang: 'en', ...identity })
  w.run(engine, 'init', '--plan', w.planPath, '--run', 'identity-01')
  const clean = w.run(engine, 'status', '--verify-install')
  const lines = clean.split(/\r?\n/)
  assert.equal(lines[0], `[prumo] Prumo ${version} (${identity.contentId}) — dsh`)
  assert.equal(lines[1], `[prumo] installed files match the installation marker (${identity.contentId})`)
  assert.doesNotMatch(clean, /WARNING/)

  appendFileSync(engine, '\n// local edit\n')
  const changed = w.run(engine, 'status', '--verify-install')
  assert.match(changed, /WARNING: the running engine\.mjs differs from the installation marker/)
  assert.match(changed, /run prumo status --verify-install, then prumo update/)
  assert.match(changed, new RegExp(`WARNING: installed files differ from the installation marker \\(marker ${identity.contentId}, files [0-9a-f]{12}\\)`))
})

test('status keeps old markers readable and asks for an update when the content ID is missing', t => {
  const w = workspace(t)
  const engine = install(w.home, { product: 'prumo', version: '1.3.17', harness: 'claude', lang: 'en' })
  w.run(engine, 'init', '--plan', w.planPath, '--run', 'identity-01')
  const output = w.run(engine, 'status')
  assert.equal(output.split(/\r?\n/)[0], '[prumo] Prumo 1.3.17 (content identifier missing — run prumo update) — claude')
  assert.doesNotMatch(output, /engine\.mjs differs/)
})

test('status compara motor executado e dashboard saudável em ambos os idiomas sem confiar no marcador', t => {
  for (const lang of ['en', 'pt-BR']) {
    const w = workspace(t)
    w.env.PRUMO_LANG = lang
    w.env.HOME = w.env.USERPROFILE = w.home
    const identity = packageIdentity(lang)
    const engine = install(w.home, { product: 'prumo', harness: 'codex', lang, ...identity })
    w.run(engine, 'init', '--plan', w.planPath, '--run', 'identity-01')
    const preference = join(w.home, '.local/share/prumo/dashboard.json')
    mkdirSync(dirname(preference), { recursive: true })
    writeFileSync(preference, JSON.stringify({ enabled: true, script: join(packageRoot, 'scripts/serve.mjs'), lang }))
    const preload = join(w.home, 'dashboard-health.mjs')
    writeFileSync(preload, 'globalThis.fetch = async url => ({ ok: true, json: async () => String(url).endsWith("/health") ? { product: "prumo", mode: "global", readOnly: true } : { product: "prumo", contentId: ' + JSON.stringify(identity.contentId) + ' } })')
    w.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? '') + ' --import=' + pathToFileURL(preload).href
    const clean = w.run(engine, 'status')
    assert.doesNotMatch(clean, /undefined|differs from dashboard|difere.*dashboard/)
    appendFileSync(join(dirname(dirname(engine)), 'README.md'), '\nAlteração local.\n')
    const changed = w.run(engine, 'status')
    assert.match(changed, lang === 'en' ? /engine content.*differs from dashboard content.*run prumo update/ : /conteúdo.*motor difere.*dashboard.*execute prumo update/)
    assert.doesNotMatch(changed, /running engine.mjs differs/)
    appendFileSync(engine, '\n// Alteração local do motor.\n')
    assert.doesNotMatch(w.run(engine, 'status'), /undefined/)
  }
})

test('status não acusa divergência quando dependência de identidade da cópia instalada está ausente', t => {
  const w = workspace(t)
  const engine = install(w.home, { product: 'prumo', version, harness: 'codex', lang: 'en', ...packageIdentity('en') })
  w.run(engine, 'init', '--plan', w.planPath, '--run', 'identity-01')
  rmSync(join(dirname(engine), 'installation-bundle.mjs'))
  const output = w.run(engine, 'status')
  assert.doesNotMatch(output, /differs from dashboard|undefined/)
})
