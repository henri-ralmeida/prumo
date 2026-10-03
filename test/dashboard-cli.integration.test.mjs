import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('CLI encaminha cada ação de dashboard e comunica sucesso, conflito e falha', async t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-dashboard-cli-')), copy = join(home, 'package')
  t.after(() => {
    assert.equal(dirname(home), resolve(tmpdir()))
    assert.ok(home.startsWith(join(resolve(tmpdir()), 'prumo-dashboard-cli-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  for (const name of ['bin', 'lib', 'scripts', 'references', 'package.json', 'SKILL.md', 'README.md', 'README.pt-BR.md', 'CHANGELOG.md', 'LICENSE'])
    cpSync(join(source, name), join(copy, name), { recursive: true, filter: path => !path.endsWith('.test.mjs') && !path.endsWith('-smoke.mjs') })
  const log = join(home, 'actions.json')
  // O serviço é substituído apenas na cópia temporária; os testes reais cobrem a posse do processo.
  writeFileSync(join(copy, 'lib/autostart.mjs'), `
import { appendFileSync } from 'node:fs'
function result(action) {
  appendFileSync(process.env.PRUMO_TEST_ACTION_LOG, JSON.stringify(action) + '\\n')
  if (process.env.PRUMO_TEST_DASHBOARD_THROW) throw new Error('Falha de serviço simulada')
  return JSON.parse(process.env.PRUMO_TEST_DASHBOARD_RESULT)
}
export const dashboardNeedsRepair = () => false
export const dashboardStatus = async () => result('status')
export const enableDashboard = async () => result('enable')
export const disableDashboard = async () => result('disable')
export const stopDashboardForUpdate = async () => result('stop')
export const restartDashboard = async () => result('restart')
export const runDashboardForeground = () => result('foreground').code
export const readDashboardEvents = () => result('logs').events
`)
  const base = { ok: true, process: 'running', registered: true, enabled: true,
    version: '2.1.1', port: 4949, url: 'http://localhost:4949', contentId: 'isolado', code: 0, events: [] }
  const run = (args, result = base, throws = false) => {
    rmSync(log, { force: true })
    const r = spawnSync(process.execPath, [join(copy, 'bin/prumo.mjs'), 'dashboard', ...args], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: home, PRUMO_LANG: 'en',
        PRUMO_TEST_ACTION_LOG: log, PRUMO_TEST_DASHBOARD_RESULT: JSON.stringify(result), PRUMO_TEST_DASHBOARD_THROW: throws ? '1' : '' },
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    })
    assert.ifError(r.error)
    const actions = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
    return { ...r, actions, output: r.stdout + r.stderr }
  }
  for (const action of ['enable', 'disable', 'status']) for (const kind of ['success', 'failure', 'conflict', 'throw']) {
    await t.test(`${action}: ${kind}`, () => {
      const result = { ...base, ...(kind === 'failure' ? { ok: false, error: 'Falha de serviço simulada' } : {}),
        ...(kind === 'conflict' ? { conflict: true } : {}) }
      const r = run([action], result, kind === 'throw')
      assert.equal(r.status, kind === 'success' ? 0 : kind === 'throw' ? 1 : 2, r.output)
      assert.deepEqual(r.actions, [action])
      if (['failure', 'throw'].includes(kind)) assert.match(r.stderr, /Falha de serviço simulada/)
      else assert.match(r.stdout, /Dashboard:/)
    })
  }
  for (const code of [0, 7]) await t.test(`execução em primeiro plano preserva saída ${code}`, () => {
    const r = run([], { ...base, code })
    assert.equal(r.status, code, r.output); assert.deepEqual(r.actions, ['foreground'])
  })
  for (const events of [[], [{ at: '2026-01-01T00:00:00Z', event: 'listening', pid: 4321 }]]) {
    await t.test(`logs mostra ${events.length} registro(s)`, () => {
      const r = run(['logs'], { ...base, events })
      assert.equal(r.status, 0, r.output); assert.deepEqual(r.actions, ['status', 'logs'])
      assert.match(r.stdout, events.length ? /listening.*pid=4321/ : /No dashboard events recorded/)
    })
  }
  for (const args of [['unknown'], ['enable', 'extra'], ['enable', '--dry-run']]) {
    await t.test(`entrada inválida ${args.join(' ')} não aciona serviço`, () => {
      const r = run(args); assert.equal(r.status, 1, r.output); assert.deepEqual(r.actions, [])
    })
  }
})
