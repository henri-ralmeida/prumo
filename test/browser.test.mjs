import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { BOARD_URL, openDashboardBrowser } from '../lib/browser.mjs'
import { reconcileDashboardInstall } from '../lib/install.mjs'

test('a instalação usa o navegador padrão de Windows, macOS e Linux sem shell', async () => {
  for (const [platform, file, args] of [
    ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler', BOARD_URL]],
    ['darwin', 'open', [BOARD_URL]],
    ['linux', 'xdg-open', [BOARD_URL]],
  ]) {
    await openDashboardBrowser({ platform, run(actual, values, options, callback) {
      assert.equal(actual, file)
      assert.deepEqual(values, args)
      assert.deepEqual(options, { cwd: tmpdir(), windowsHide: true, timeout: 10000 })
      callback(null)
    } })
  }
  await openDashboardBrowser({ run(file, args, options, callback) { callback(null) } })
  await assert.rejects(openDashboardBrowser({ run(file, args, options, callback) { callback(new Error('sem navegador')) } }), /sem navegador/)
  await assert.rejects(openDashboardBrowser({ run() { throw new Error('falha ao iniciar') } }), /falha ao iniciar/)
})

test('a atualização histórica não lança o navegador real nem retém seu diretório temporário', () => {
  const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/dashboard-port.mjs', import.meta.url).href,
    '--input-type=module', '-e', `import { openDashboardBrowser } from ${JSON.stringify(new URL('../lib/browser.mjs', import.meta.url).href)};
      try { await openDashboardBrowser(); process.exitCode = 1 } catch (error) { console.log(error.message) }`],
  { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /navegador isolado indisponível/)
})

test('abre somente após o dashboard iniciar; prévia, opt-out e falha não abrem abas', async () => {
  const calls = []
  const openBrowser = async () => { calls.push('browser') }
  const enable = async () => { calls.push('start'); return { ok: true } }
  const status = async () => ({ enabled: false })
  for (const options of [{}, { dryRun: true }, { status: async () => ({ disabled: true }) }, { enable: async () => ({ ok: false }) }]) {
    await reconcileDashboardInstall(Object.keys(options).length ? 1 : 0, { status, enable, openBrowser, ...options })
  }
  assert.deepEqual(calls, [])
  const result = await reconcileDashboardInstall(1, { status, enable, openBrowser })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ['start', 'browser'])
  const failed = await reconcileDashboardInstall(1, { status, enable, openBrowser: async () => { throw new Error('sem GUI') } })
  assert.equal(failed.ok, true, 'A falta de navegador não desfaz a instalação concluída.')
  assert.equal(failed.browserFailed, true)
})
