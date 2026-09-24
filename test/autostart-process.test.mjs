import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { enableDashboard, restartDashboard, disableDashboard } from '../lib/autostart.mjs'

test('Windows Startup launches and restarts a real isolated dashboard process', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo startup process-'))
  const reserve = createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const script = join(home, 'dashboard.mjs')
  // Keep the production command line for ownership checks, but serve on an isolated port.
  writeFileSync(script, `process.argv[process.argv.indexOf('--port') + 1] = '${port}';\nawait import(${JSON.stringify(new URL('../scripts/serve.mjs', import.meta.url).href)});\n`)
  const env = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'data'),
    APPDATA: join(home, 'AppData/Roaming'), PRUMO_ROOT: '', GRAPH_ROOT: '', GRAPH_FOREMAN_HOME: '', PRUMO_LANG: 'en' }
  // Exercise the default launcher with an existing fallback registration, no injected exec.
  const preferencePath = join(home, '.local/share/prumo/dashboard.json')
  mkdirSync(join(home, '.local/share/prumo'), { recursive: true })
  writeFileSync(preferencePath, JSON.stringify({ enabled: true, mechanism: 'windows-startup' }))
  const options = { home, script: script.replaceAll('\\', '/'), packageRoot: fileURLToPath(new URL('..', import.meta.url)), env,
    readinessAttempts: 100, readinessInterval: 50,
    fetch: (url, init) => fetch(String(url).replace(':4949/', `:${port}/`), init),
    portAvailable: async () => true }
  const pids = new Set()
  // Track even a process whose ownership registration fails, so failures cannot leak it.
  options.fetch = async (url, init) => {
    const response = await fetch(String(url).replace(':4949/', `:${port}/`), init)
    if (response.ok) { const body = await response.clone().json(); if (body.pid) pids.add(body.pid) }
    return response
  }
  t.after(() => {
    for (const pid of pids) try { process.kill(pid) } catch {}
    assert.ok(home.startsWith(join(tmpdir(), 'prumo startup process-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const preference = () => JSON.parse(readFileSync(join(home, '.local/share/prumo/dashboard.json'), 'utf8'))
  const first = await enableDashboard(options)
  if (preference().pid) pids.add(preference().pid)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.mechanism, 'windows-startup')
  const runs = await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()
  assert.deepEqual(runs.runs, [], 'isolated dashboard must not discover the real user runs')
  const firstAbout = await (await fetch(`http://127.0.0.1:${port}/api/about`)).json()
  assert.equal(first.contentCurrent, true)
  assert.equal(first.contentId, firstAbout.contentId)
  assert.equal(firstAbout.origin, 'global')
  const root = join(env.PRUMO_HOME, 'fixture/.specs/graph/test')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'state.json'), JSON.stringify({ plan: { name: 'isolated', phases: [] }, tasks: {} }))
  writeFileSync(join(root, '../CURRENT'), 'test')
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()).runs.length, 1)
  const firstPid = preference().pid
  const restarted = await restartDashboard(options)
  if (preference().pid) pids.add(preference().pid)
  assert.equal(restarted.ok, true, JSON.stringify(restarted))
  assert.equal(restarted.contentCurrent, true)
  assert.equal(restarted.contentId, firstAbout.contentId)
  assert.notEqual(preference().pid, firstPid)
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()).runs.length, 1)
  // Invoke the exact per-user login entry without rebooting or touching the real Startup folder.
  const stoppedPid = preference().pid
  process.kill(stoppedPid)
  let stopped = false
  for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
    try { await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }) }
    catch { stopped = true }
    if (!stopped) await setTimeout(50)
  }
  assert.equal(stopped, true, 'wait for the previous server to release its port before simulating login')
  const entry = join(env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup/Prumo Dashboard.vbs')
  execFileSync('cscript.exe', ['//B', '//Nologo', entry], { env, windowsHide: true, timeout: 10000 })
  let loginReady = false
  for (let attempt = 0; attempt < 100 && !loginReady; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })
      const body = await response.json()
      if (body.pid && body.pid !== stoppedPid) { pids.add(body.pid); loginReady = response.ok }
    } catch {}
    if (!loginReady) await setTimeout(50)
  }
  assert.equal(loginReady, true, 'the login entry itself must launch the dashboard before enable repairs anything')
  const login = await enableDashboard(options)
  if (preference().pid) pids.add(preference().pid)
  assert.equal(login.ok, true, JSON.stringify(login))
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()).runs.length, 1)
  const disabled = await disableDashboard(options)
  assert.equal(disabled.ok, true, JSON.stringify(disabled))
  assert.equal(disabled.registered, false)
})
