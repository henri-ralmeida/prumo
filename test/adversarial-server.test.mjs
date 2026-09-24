import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
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

test('event history paging resets replacements and waits for complete NDJSON lines', async t => {
  const f = await fixture(t)
  const log = join(f.graph, 'demo', 'events.ndjson')
  const encode = (count, base = 0) => Array.from({ length: count }, (_, index) => JSON.stringify({ type: 'task_note', id: base + index }) + '\n').join('')
  const missing = await (await f.get('/api/events?root=healthy&run=demo&after=0&limit=10')).json()
  assert.equal(missing.complete, false, 'a missing event log does not prove that pause history is complete')
  f.put(log, encode(5105))

  const firstResponse = await f.get('/api/events?root=healthy&run=demo&after=0&limit=5001')
  assert.equal(firstResponse.status, 200)
  const first = await firstResponse.json()
  assert.equal(first.events.length, 5000, 'the requested page is bounded to 5000 records')
  assert.equal(first.next, 5000)
  assert.equal(first.total, 5105)
  assert.equal(first.complete, false)
  assert.equal(typeof first.revision, 'string')
  assert.doesNotMatch(JSON.stringify(first), /events\.ndjson|healthy/)

  const revision = encodeURIComponent(first.revision)
  const second = await (await f.get(`/api/events?root=healthy&run=demo&after=5000&limit=5000&revision=${revision}`)).json()
  assert.equal(second.events.length, 105)
  assert.equal(second.next, 5105)
  assert.equal(second.complete, true)
  assert.equal(second.revision, first.revision)

  const cursorReset = await (await f.get(`/api/events?root=healthy&run=demo&after=9999&limit=2&revision=${revision}`)).json()
  assert.equal(cursorReset.reset, true)
  assert.equal(cursorReset.next, 2)
  assert.equal(cursorReset.events[0].id, 0)

  assert.equal((await f.get('/api/events?root=healthy&run=demo&after=-1')).status, 400)
  assert.equal((await f.get('/api/events?root=healthy&run=demo&after=')).status, 400)
  assert.equal((await f.get('/api/events?root=healthy&run=demo&after=9007199254740992')).status, 400)
  assert.equal((await f.get('/api/events?root=healthy&run=demo&after=0&limit=9007199254740992')).status, 400)
  assert.equal((await f.get('/api/events?root=healthy&run=demo&limit=0')).status, 400)

  appendFileSync(log, JSON.stringify({ type: 'task_note', id: 'append' }) + '\n')
  const appended = await (await f.get(`/api/events?root=healthy&run=demo&after=5105&limit=10&revision=${revision}`)).json()
  assert.equal(appended.events[0].id, 'append')
  assert.equal(appended.next, 5106)
  assert.equal(appended.complete, true)
  assert.equal(appended.revision, first.revision)

  appendFileSync(log, '{"type":"task_note","id":"partial"')
  const partial = await (await f.get(`/api/events?root=healthy&run=demo&after=5106&limit=10&revision=${revision}`)).json()
  assert.deepEqual(partial.events, [])
  assert.equal(partial.complete, false, 'a partial final JSON line does not certify a complete history')
  appendFileSync(log, '}\n')
  const completed = await (await f.get(`/api/events?root=healthy&run=demo&after=5106&limit=10&revision=${revision}`)).json()
  assert.equal(completed.events[0].id, 'partial')
  assert.equal(completed.complete, true)

  f.put(log, encode(2))
  const truncated = await (await f.get(`/api/events?root=healthy&run=demo&after=5107&limit=10&revision=${revision}`)).json()
  assert.equal(truncated.reset, true)
  assert.equal(truncated.total, 2)
  assert.notEqual(truncated.revision, first.revision)
  assert.equal(truncated.events.length, 2)

  const oldRevision = encodeURIComponent(truncated.revision)
  rmSync(log)
  f.put(log, encode(4))
  const replaced = await (await f.get(`/api/events?root=healthy&run=demo&after=2&limit=10&revision=${oldRevision}`)).json()
  assert.equal(replaced.reset, true)
  assert.equal(replaced.total, 4)
  assert.notEqual(replaced.revision, truncated.revision)
  assert.equal(replaced.events[0].id, 0)

  const beforeRewriteRevision = encodeURIComponent(replaced.revision)
  f.put(log, encode(8, 10000))
  const largerRewrite = await (await f.get(`/api/events?root=healthy&run=demo&after=4&limit=10&revision=${beforeRewriteRevision}`)).json()
  assert.equal(largerRewrite.reset, true, 'rewriting in place with a longer file starts a new history')
  assert.equal(largerRewrite.total, 8)
  assert.notEqual(largerRewrite.revision, replaced.revision)
  assert.equal(largerRewrite.events[0].id, 10000)
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
