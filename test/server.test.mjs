import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

test('dashboard selects legacy and central data without writes or translation of user content', async t => {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, 'prumo-server-'))
  const root = join(home, 'project', 'work')
  const central = join(home, 'central')
  const files = []
  for (const [path, title] of [[root, 'done'], [join(central, 'work'), 'central task']]) {
    const graph = join(path, '.specs', 'graph')
    mkdirSync(join(graph, 'demo'), { recursive: true })
    const state = { plan: { name: title }, tasks: { T1: { id: 'T1', title, state: 'blocked', deps: [], attempts: [{ agent: 'executor' }], validations: [] } } }
    for (const [name, content] of [['CURRENT', 'demo'], ['demo/state.json', JSON.stringify(state)], ['demo/events.ndjson', '{"type":"task_block","task":"T1","reason":"done"}\n']]) {
      const file = join(graph, name)
      writeFileSync(file, content)
      files.push([file, content])
    }
  }
  const script = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))
  const child = spawn(process.execPath, [script, '--port', '0', '--lang', 'pt-BR'], {
    cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_ROOT: root, PRUMO_HOME: central },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const closed = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await closed
    assert.equal(dirname(home), base)
    assert.ok(home.startsWith(join(base, 'prumo-server-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const deadline = Date.now() + 15000
  while (!/localhost:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await setTimeout(30)
  const port = output.match(/localhost:(\d+)/)?.[1]
  assert.ok(port && port !== '0', output)
  const get = path => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(10000) })
  const runs = await (await get('/api/runs')).json()
  assert.equal(runs.currentRoot, 'work')
  assert.equal(runs.runs.length, 2)
  const selected = await (await get('/api/state?root=work&run=demo')).json()
  assert.equal(selected.tasks.T1.title, 'done')
  assert.equal(selected.derived.T1.effective, 'blocked')
  const other = runs.runs.find(run => run.root !== 'work')
  assert.equal((await (await get(`/api/state?root=${other.root}&run=demo`)).json()).tasks.T1.title, 'central task')
  assert.equal((await get('/api/state?run=..%2Fdemo')).status, 404)
  const page = await get('/')
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/)
  assert.match(await page.text(), /"pt-BR"/)
  assert.equal((await (await get('/api/events')).json()).events[0].reason, 'done')
  for (const [file, content] of files) assert.equal(readFileSync(file, 'utf8'), content)
})
