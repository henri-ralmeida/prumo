import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

async function fixture(t, { sync = false, damagedRoot = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-adversarial-'))
  const pkg = join(home, 'package')
  cpSync(fileURLToPath(new URL('../scripts', import.meta.url)), join(pkg, 'scripts'), { recursive: true })
  const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
  put(join(pkg, 'package.json'), JSON.stringify({ version: '1.0.8', type: 'module' }))
  const central = join(home, 'data')
  const root = join(central, 'healthy')
  const graph = join(root, '.specs', 'graph')
  put(join(graph, 'CURRENT'), 'demo')
  const stateFile = join(graph, 'demo', 'state.json')
  const state = JSON.stringify({ plan: { name: 'Healthy', phases: [] }, tasks: {} })
  put(stateFile, sync ? '{partial write' : state)
  if (damagedRoot) put(join(central, 'broken', '.specs', 'graph'), 'not a directory')
  const child = spawn(process.execPath, [join(pkg, 'scripts', 'serve.mjs'), '--port', '0', ...(sync ? ['--sync-plan'] : ['--global'])], {
    cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: central,
      PRUMO_ROOT: root, GRAPH_ROOT: '', GRAPH_FOREMAN_HOME: '', PRUMO_LANG: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const closed = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await closed
    assert.equal(dirname(home), tmpdir())
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const deadline = Date.now() + 10000
  while (!/localhost:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await setTimeout(30)
  const port = output.match(/localhost:(\d+)/)?.[1]
  assert.ok(port && child.exitCode === null, output)
  const get = path => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000) })
  return { home, pkg, central, graph, stateFile, state, put, child, get, output: () => output }
}

test('one damaged workspace cannot prevent dashboard startup or hide healthy runs', async t => {
  const f = await fixture(t, { damagedRoot: true })
  const response = await f.get('/api/runs')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.runs.length, 1)
  assert.ok(body.warnings.some(w => w.includes('broken')))
  assert.equal((await f.get('/api/health')).status, 200)
})

test('missing dashboard asset during update returns an error and recovers without killing the server', async t => {
  const f = await fixture(t)
  const path = join(f.pkg, 'scripts', 'dashboard.html')
  const page = readFileSync(path)
  rmSync(path)
  const failed = await f.get('/')
  assert.equal(failed.status, 500)
  assert.equal((await f.get('/api/health')).status, 200)
  f.put(path, page)
  assert.equal((await f.get('/')).status, 200)
  assert.equal(f.child.exitCode, null, f.output())
})

test('health reports the loaded server version until a real restart', async t => {
  const f = await fixture(t)
  const before = await (await f.get('/api/health')).json()
  assert.equal(before.version, '1.0.8')
  f.put(join(f.pkg, 'package.json'), JSON.stringify({ version: '1.3.9', type: 'module' }))
  const after = await (await f.get('/api/health')).json()
  assert.equal(after.version, '1.0.8', 'replacing package files does not replace the running process')
  assert.equal(after.pid, f.child.pid)
})

test('workspace auto-sync tolerates incomplete state both at startup and during its timer', async t => {
  const f = await fixture(t, { sync: true })
  assert.equal((await f.get('/api/state')).status, 500)
  f.put(f.stateFile, f.state)
  assert.equal((await f.get('/api/state')).status, 200)
  f.put(f.stateFile, '{partial write again')
  await setTimeout(1300)
  assert.equal((await f.get('/api/health')).status, 200)
  f.put(f.stateFile, f.state)
  await setTimeout(1100)
  assert.equal((await f.get('/api/state')).status, 200)
  assert.equal(f.child.exitCode, null, f.output())
  assert.equal(readFileSync(f.stateFile, 'utf8'), f.state)
})

test('adversarial mixed migration state keeps legacy attempts out of current planning projection', async t => {
  const f = await fixture(t)
  const mixed = {
    schemaVersion: 1,
    plan: { name: 'Mixed', planningMode: 'phase', phases: [{ id: 'F1', title: 'Mixed' }] },
    phaseWorkflows: { F1: { id: 'F1', title: 'Mixed', state: 'pending', discussionAttempts: [], planningAttempts: [] } },
    tasks: {
      LEGACY: { id: 'LEGACY', phase: 'F1', title: 'Legacy attempt', state: 'blocked', deps: [],
        planningRequired: false, attempts: [{ n: 1, agent: 'executor' }], validations: [] },
      CURRENT: { id: 'CURRENT', phase: 'F1', title: 'New task', state: 'pending', deps: [],
        planningRequired: true, discussionRequired: true, discoveryRequired: true,
        discussionAttempts: [], planningAttempts: [], planningHistory: [], attempts: [], validations: [] },
    },
  }
  f.put(f.stateFile, JSON.stringify(mixed))
  const response = await f.get('/api/state')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.derived.LEGACY.effective, 'blocked')
  assert.equal(body.derived.LEGACY.planningStatus, undefined)
  assert.equal(body.derived.CURRENT.effective, 'ready_for_discussion')
  assert.equal(body.derived.CURRENT.planningStatus, 'awaiting_phase_plan')
  assert.equal(f.child.exitCode, null, f.output())
})
