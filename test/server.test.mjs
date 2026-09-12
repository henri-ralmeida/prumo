import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
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
    const state = { plan: { name: title }, tasks: {
      T1: { id: 'T1', title, state: 'blocked', deps: [], attempts: [{ agent: 'executor' }], validations: [] },
      LEGACY: { id: 'LEGACY', state: 'pending', deps: [], attempts: [], validations: [] },
    } }
    for (const [name, content] of [['CURRENT', 'demo'], ['demo/state.json', JSON.stringify(state)], ['demo/events.ndjson', '{"type":"task_block","task":"T1","reason":"done"}\n']]) {
      const file = join(graph, name)
      writeFileSync(file, content)
      files.push([file, content])
    }
  }
  const environment = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_ROOT: root, PRUMO_HOME: central, PRUMO_LANG: 'en' }
  const engine = fileURLToPath(new URL('../scripts/engine.mjs', import.meta.url))
  const source = join(home, 'planning.json')
  writeFileSync(source, JSON.stringify({ name: 'planning fixture', tasks: ['PLAN', 'ACTIVE', 'EXEC', 'WAIT'].map(id => ({
    id, title: id, deps: id === 'WAIT' ? ['PLAN'] : [], validationMode: 'inspection',
    inspectionReason: 'Server fixture contains no runtime changes', validation: 'Inspect fixture states',
  })) }))
  const artifact = join(home, 'task-plan.json')
  writeFileSync(artifact, JSON.stringify({ research: [{ source, findings: 'Fixture states confirmed' }],
    decisions: [], steps: ['Inspect fixture states'], verification: [{ criterion: 'States are visible', check: 'inspection' }], openQuestions: [] }))
  const discovery = join(home, 'discovery.json')
  writeFileSync(discovery, JSON.stringify({
    research: [{ source, findings: 'Fixture task context inspected' }],
    questions: [{ question: 'Show these fixture states?', answer: 'Yes.', channel: 'chat-fallback', round: 1 }],
    coverage: { problem: 'Show states', affected: 'Dashboard viewer', outcome: 'Visible states', currentBehavior: 'Fixture exists',
      desiredBehavior: 'Fixture remains visible', rules: 'Inspection only', exceptions: 'None', scope: 'Server fixture', acceptance: 'States render' },
    decisions: [], deferred: [], closure: 'The fixture behavior is fully specified.',
  }))
  const command = (...args) => execFileSync(process.execPath, [engine, ...args], { cwd: root, env: environment, windowsHide: true, encoding: 'utf8' })
  command('init', '--plan', source, '--run', 'planning-demo')
  command('plan-task', 'EXEC', '--agent', 'planner', '--context', discovery)
  command('finish-planning', 'EXEC', '--plan', artifact)
  command('plan-task', 'ACTIVE', '--agent', 'planner-active', '--context', discovery)
  writeFileSync(join(root, '.specs', 'graph', 'CURRENT'), 'demo')
  for (const name of ['state.json', 'events.ndjson']) {
    const file = join(root, '.specs', 'graph', 'planning-demo', name)
    files.push([file, readFileSync(file, 'utf8')])
  }
  const script = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))
  const child = spawn(process.execPath, [script, '--port', '0', '--lang', 'pt-BR'], {
    cwd: root, env: environment,
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
  assert.equal(runs.runs.length, 3)
  const selected = await (await get('/api/state?root=work&run=demo')).json()
  assert.equal(selected.tasks.T1.title, 'done')
  assert.equal(selected.derived.T1.effective, 'blocked')
  assert.equal(selected.derived.LEGACY.effective, 'ready')
  const planned = await (await get('/api/state?root=work&run=planning-demo')).json()
  assert.deepEqual(Object.fromEntries(Object.entries(planned.derived).map(([id, task]) => [id, task.effective])),
    { PLAN: 'ready_to_plan', ACTIVE: 'planning', EXEC: 'ready', WAIT: 'waiting' })
  assert.equal(planned.tasks.EXEC.taskPlan.research[0].findings, 'Fixture states confirmed')
  assert.equal(planned.tasks.ACTIVE.planner, 'planner-active')
  const other = runs.runs.find(run => run.root !== 'work')
  assert.equal((await (await get(`/api/state?root=${other.root}&run=demo`)).json()).tasks.T1.title, 'central task')
  assert.equal((await get('/api/state?run=..%2Fdemo')).status, 404)
  const page = await get('/')
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/)
  assert.match(await page.text(), /"pt-BR"/)
  assert.equal((await (await get('/api/events')).json()).events[0].reason, 'done')
  for (const [file, content] of files) assert.equal(readFileSync(file, 'utf8'), content)
})
