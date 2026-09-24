import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { setTimeout } from 'node:timers/promises'
import { contentId } from '../lib/install.mjs'

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
  writeFileSync(source, JSON.stringify({ name: 'planning fixture',
    phases: ['PLAN', 'ACTIVE', 'EXEC', 'WAIT'].map(id => ({ id: `F_${id}`, title: id })),
    tasks: ['PLAN', 'ACTIVE', 'EXEC', 'WAIT'].map(id => ({
    phase: `F_${id}`,
    id, title: id, deps: id === 'WAIT' ? ['PLAN'] : [], validationMode: 'inspection',
    inspectionReason: 'Server fixture contains no runtime changes', validation: 'Inspect fixture states',
  })) }))
  const command = (...args) => execFileSync(process.execPath, [engine, ...args], { cwd: root, env: environment, windowsHide: true, encoding: 'utf8' })
  command('init', '--plan', source, '--run', 'planning-demo')
  const planningState = () => JSON.parse(readFileSync(join(root, '.specs', 'graph', 'planning-demo', 'state.json'), 'utf8'))
  const discuss = phaseId => {
    command('begin-phase-discussion', phaseId)
    const round = planningState().phaseWorkflows[phaseId].discussionAttempts.at(-1)
    const discovery = join(home, `discovery-${phaseId}.json`)
    writeFileSync(discovery, JSON.stringify({
      research: [{ source, findings: 'Fixture phase context inspected' }],
      questions: [{ question: 'Show these fixture states?', answer: 'Yes.', channel: 'chat-fallback', round: 1, roundId: round.roundId }],
      coverage: { problem: 'Show states', affected: 'Dashboard viewer', outcome: 'Visible states', currentBehavior: 'Fixture exists',
        desiredBehavior: 'Fixture remains visible', rules: 'Inspection only', exceptions: 'None', scope: phaseId, acceptance: 'States render' },
      decisions: [], deferred: [], executionBoundary: { deferredToExecutor: round.targets, prematureTaskWork: [] },
      closure: 'The fixture behavior is fully specified.', roundId: round.roundId, nonce: round.nonce,
    }))
    command('finish-phase-discussion', phaseId, '--context', discovery)
  }
  const beginPlanning = (phaseId, agent) => {
    discuss(phaseId)
    command('plan-phase', phaseId, '--agent', agent)
  }
  const finishPlanning = phaseId => {
    const round = planningState().phaseWorkflows[phaseId].planningAttempts.at(-1)
    const id = round.targets[0]
    writeFileSync(join(home, `task-plan-${id}.json`), JSON.stringify({
      research: [{ source, findings: 'Fixture states confirmed' }], decisions: [], steps: ['Inspect fixture states'],
      verification: [{ criterion: 'States are visible', check: 'inspection' }], openQuestions: [],
      phaseBinding: { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n },
      unresolvedInputs: round.requiredInputs[id],
    }))
    command('finish-phase-planning', phaseId, '--plan-dir', home)
  }
  beginPlanning('F_EXEC', 'planner')
  finishPlanning('F_EXEC')
  beginPlanning('F_ACTIVE', 'planner-active')
  command('begin-phase-discussion', 'F_PLAN')
  const waiting = planningState()
  waiting.tasks.WAIT.taskPlan = { phaseId: 'F_WAIT', unresolvedInputs: [{ task: 'PLAN', contract: 'fixture input' }] }
  writeFileSync(join(root, '.specs', 'graph', 'planning-demo', 'state.json'), JSON.stringify(waiting))
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
  const health = await (await get('/api/health')).json()
  assert.equal(health.product, 'prumo')
  assert.equal(health.mode, 'workspace')
  assert.equal(health.readOnly, true)
  const about = await (await get('/api/about')).json()
  assert.equal(about.product, 'prumo')
  assert.equal(about.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  assert.equal(about.origin, 'workspace')
  assert.equal(about.contentId, contentId('pt-BR'))
  assert.equal(about.path, dirname(dirname(fileURLToPath(import.meta.url))))
  assert.match(about.contentId, /^[a-f0-9]{12}$/)
  const runs = await (await get('/api/runs')).json()
  assert.equal(runs.currentRoot, 'work')
  assert.equal(runs.runs.length, 3)
  const selected = await (await get('/api/state?root=work&run=demo')).json()
  assert.equal(selected.tasks.T1.title, 'done')
  assert.equal(selected.derived.T1.effective, 'blocked')
  assert.equal(selected.derived.LEGACY.effective, 'pending')
  assert.equal(selected.derived.LEGACY.planningStatus, 'awaiting_migration')
  const planned = await (await get('/api/state?root=work&run=planning-demo')).json()
  assert.deepEqual(Object.fromEntries(Object.entries(planned.derived).map(([id, task]) => [id, task.effective])),
    { PLAN: 'discussing', ACTIVE: 'planning', EXEC: 'ready', WAIT: 'waiting' })
  assert.deepEqual(Object.fromEntries(Object.entries(planned.derived).map(([id, task]) => [id, task.planningStatus])),
    { PLAN: 'phase_discussing', ACTIVE: 'phase_planning', EXEC: 'planned', WAIT: 'awaiting_phase_plan' })
  assert.equal(planned.derived.WAIT.inputStatus, 'unresolved_later_phase_input')
  assert.deepEqual(planned.derived.WAIT.planningBlockedBy, ['F_PLAN'])
  const engineDerived = JSON.parse(command('graph', '--run', 'planning-demo')).derived
  for (const [id, fields] of Object.entries(planned.derived)) {
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(value, engineDerived[id][key], `${id}.${key}: dashboard and engine agree`)
  }
  assert.equal(planned.tasks.EXEC.taskPlan.research[0].findings, 'Fixture states confirmed')
  assert.equal(planned.phaseWorkflows.F_ACTIVE.state, 'planning')
  assert.equal(planned.phaseWorkflows.F_ACTIVE.planner, 'planner-active')
  const other = runs.runs.find(run => run.root !== 'work')
  assert.equal((await (await get(`/api/state?root=${other.root}&run=demo`)).json()).tasks.T1.title, 'central task')
  assert.equal((await get('/api/state?run=..%2Fdemo')).status, 404)
  const page = await get('/')
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/)
  assert.match(await page.text(), /"pt-BR"/)
  assert.equal((await (await get('/api/events')).json()).events[0].reason, 'done')
  for (const [file, content] of files) assert.equal(readFileSync(file, 'utf8'), content)
  const planningPath = join(root, '.specs', 'graph', 'planning-demo', 'state.json')
  const terminal = JSON.parse(readFileSync(planningPath, 'utf8'))
  terminal.tasks.EXEC.state = 'done'
  writeFileSync(planningPath, JSON.stringify(terminal))
  assert.equal((await (await get('/api/state?root=work&run=planning-demo')).json()).derived.EXEC.planningStatus, undefined)
})

test('EADDRINUSE identifies a Prumo dashboard through /api/about and leaves it running', async t => {
  const about = { product: 'prumo', version: '1.3.17', origin: 'global', contentId: 'abc123def456', path: 'C:/prumo/global' }
  const occupant = createServer((req, res) => {
    if (req.url === '/api/about') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(about))
    } else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => occupant.listen(0, '127.0.0.1', resolve))
  const port = occupant.address().port
  const script = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))
  const child = spawn(process.execPath, [script, '--global', '--port', String(port), '--lang', 'pt-BR'], {
    env: { ...process.env, PRUMO_LANG: 'pt-BR' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stderr.on('data', chunk => { output += chunk })
  child.stdout.on('data', chunk => { output += chunk })
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await new Promise(resolve => occupant.close(resolve))
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 1, output)
  assert.match(output, /Prumo 1\.3\.17 .*abc123def456.*C:\/prumo\/global/)
  assert.equal(occupant.listening, true, 'the existing server must not be stopped')
})

test('EADDRINUSE reports an unknown occupant when /api/about is unavailable', async t => {
  const occupant = createServer((_req, res) => { res.writeHead(404); res.end() })
  await new Promise(resolve => occupant.listen(0, '127.0.0.1', resolve))
  const port = occupant.address().port
  const script = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))
  const child = spawn(process.execPath, [script, '--global', '--port', String(port), '--lang', 'pt-BR'], {
    env: { ...process.env, PRUMO_LANG: 'pt-BR' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stderr.on('data', chunk => { output += chunk })
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await new Promise(resolve => occupant.close(resolve))
  })
  assert.equal(await closed, 1, output)
  assert.match(output, /processo não identificado/)
  assert.equal(occupant.listening, true)
})

test('dashboard projection matches the engine for mixed legacy and current tasks', async t => {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, 'prumo-mixed-server-'))
  const root = join(home, 'workspace')
  const graph = join(root, '.specs', 'graph', 'mixed')
  mkdirSync(graph, { recursive: true })
  const state = {
    schemaVersion: 1,
    plan: { name: 'Mixed migration', planningMode: 'phase', phases: [{ id: 'F1', title: 'Mixed phase' }] },
    phaseWorkflows: { F1: { id: 'F1', title: 'Mixed phase', state: 'pending', discussionAttempts: [], planningAttempts: [] } },
    tasks: {
      LEGACY: { id: 'LEGACY', phase: 'F1', title: 'Legacy blocked', state: 'blocked', deps: [],
        planningRequired: false, attempts: [{ n: 1, agent: 'legacy-executor' }], validations: [] },
      CURRENT: { id: 'CURRENT', phase: 'F1', title: 'Current pending', state: 'pending', deps: [],
        planningRequired: true, discussionRequired: true, discoveryRequired: true,
        discussionAttempts: [], planningAttempts: [], planningHistory: [], attempts: [], validations: [] },
    },
  }
  const statePath = join(graph, 'state.json')
  writeFileSync(join(root, '.specs', 'graph', 'CURRENT'), 'mixed')
  writeFileSync(statePath, JSON.stringify(state))
  writeFileSync(join(graph, 'events.ndjson'), '')
  const environment = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'central'),
    PRUMO_ROOT: root, GRAPH_ROOT: '', GRAPH_FOREMAN_HOME: '', PRUMO_LANG: 'en' }
  const script = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))
  const engine = fileURLToPath(new URL('../scripts/engine.mjs', import.meta.url))
  const child = spawn(process.execPath, [script, '--port', '0'], {
    cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const closed = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await closed
    assert.equal(dirname(home), base)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const deadline = Date.now() + 15000
  while (!/localhost:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await setTimeout(30)
  const port = output.match(/localhost:(\d+)/)?.[1]
  assert.ok(port && child.exitCode === null, output)
  const before = readFileSync(statePath, 'utf8')
  const dashboard = await (await fetch('http://127.0.0.1:' + port + '/api/state?run=mixed')).json()
  assert.equal(dashboard.derived.LEGACY.effective, 'blocked')
  assert.equal(dashboard.derived.LEGACY.planningStatus, undefined)
  assert.equal(dashboard.derived.CURRENT.effective, 'ready_for_discussion')
  assert.equal(dashboard.derived.CURRENT.planningStatus, 'awaiting_phase_plan')
  const engineDerived = JSON.parse(execFileSync(process.execPath, [engine, 'graph', '--run', 'mixed'], {
    cwd: root, env: environment, windowsHide: true, encoding: 'utf8',
  })).derived
  for (const id of ['LEGACY', 'CURRENT']) {
    assert.equal(dashboard.derived[id].effective, engineDerived[id].effective, id + '.effective')
    assert.deepEqual(dashboard.derived[id].blockedBy, engineDerived[id].blockedBy, id + '.blockedBy')
    assert.equal(dashboard.derived[id].planningStatus, engineDerived[id].planningStatus, id + '.planningStatus')
  }
  assert.equal(readFileSync(statePath, 'utf8'), before)
})

test('global dashboard discovers only known roots, stays read-only, and refreshes without restart', async t => {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, 'prumo-global-server-'))
  const central = join(home, 'central')
  const registered = join(home, 'projects', 'work')
  const unknown = join(home, 'unknown', 'hidden')
  const script = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))
  const child = spawn(process.execPath, [script, '--global', '--port', '0'], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: central, PRUMO_ROOT: '', GRAPH_ROOT: '', GRAPH_FOREMAN_HOME: '', PRUMO_LANG: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const closed = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await closed
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const deadline = Date.now() + 15000
  while (!/localhost:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await setTimeout(30)
  const port = output.match(/localhost:(\d+)/)?.[1]
  assert.ok(port && port !== '0', output)
  const get = path => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(10000) })

  assert.deepEqual(await (await get('/api/runs')).json(), { currentRoot: null, current: null, runs: [], warnings: [] })
  assert.deepEqual(await (await get('/api/state')).json(), { plan: { name: '', phases: [] }, tasks: {}, derived: {}, empty: true })
  assert.deepEqual(await (await get('/api/events')).json(), { events: [] })
  const health = await (await get('/api/health')).json()
  assert.deepEqual({ product: health.product, mode: health.mode, readOnly: health.readOnly, host: health.host, port: health.port },
    { product: 'prumo', mode: 'global', readOnly: true, host: '127.0.0.1', port: Number(port) })
  assert.match(health.version, /^\d+\.\d+\.\d+$/)

  const makeRun = (root, run, title) => {
    const graph = join(root, '.specs', 'graph')
    mkdirSync(join(graph, run), { recursive: true })
    writeFileSync(join(graph, 'CURRENT'), run)
    writeFileSync(join(graph, run, 'state.json'), JSON.stringify({ plan: { name: title, phases: [] }, tasks: {} }))
    return [join(graph, 'CURRENT'), join(graph, run, 'state.json')]
  }
  const observed = []
  observed.push(...makeRun(join(central, 'work'), 'central-run', 'central'))
  observed.push(...makeRun(unknown, 'secret-run', 'not registered'))
  const invalidGraph = join(central, 'invalid-current', '.specs', 'graph')
  mkdirSync(join(invalidGraph, 'valid-run'), { recursive: true })
  writeFileSync(join(invalidGraph, 'CURRENT'), '../escape')
  writeFileSync(join(invalidGraph, 'valid-run', 'state.json'), JSON.stringify({ plan: { name: 'valid but not current', phases: [] }, tasks: {} }))
  observed.push(join(invalidGraph, 'CURRENT'), join(invalidGraph, 'valid-run', 'state.json'))
  const missingGraph = join(central, 'missing-state', '.specs', 'graph')
  mkdirSync(missingGraph, { recursive: true })
  writeFileSync(join(missingGraph, 'CURRENT'), 'missing-run')
  observed.push(join(missingGraph, 'CURRENT'))
  await setTimeout(30)
  observed.push(...makeRun(registered, 'registered-run', 'registered'))
  const registry = join(home, '.local', 'share', 'prumo', 'installations.json')
  mkdirSync(dirname(registry), { recursive: true })
  writeFileSync(registry, JSON.stringify([
    { harness: 'codex', config: join(home, '.codex'), roots: [], projects: [registered, join(home, 'missing')] },
    { broken: true },
  ]))
  observed.push(registry)
  const before = new Map(observed.map(file => [file, readFileSync(file, 'utf8')]))

  const runs = await (await get('/api/runs')).json()
  assert.equal(runs.runs.length, 3)
  assert.ok(!runs.runs.some(run => run.run === 'secret-run'))
  assert.equal(runs.current, 'registered-run')
  assert.equal(runs.currentRoot, 'work-2')
  assert.ok(runs.warnings.some(warning => warning.includes('missing')))
  assert.ok(runs.warnings.some(warning => warning.includes('invalid installation')))
  assert.ok(runs.warnings.some(warning => warning.includes('Ignored invalid CURRENT') && warning.includes('invalid-current')))
  assert.ok(runs.warnings.some(warning => warning.includes('Ignored CURRENT without state') && warning.includes('missing-state')))
  assert.equal((await (await get('/api/state')).json()).plan.name, 'registered')
  assert.equal((await get('/api/state?root=..%2Fwork&run=registered-run')).status, 404)
  assert.equal((await get('/api/state?root=work-2&run=..%2Fregistered-run')).status, 404)
  for (const [file, content] of before) assert.equal(readFileSync(file, 'utf8'), content)

  const corruptRegistry = '{not json'
  writeFileSync(registry, corruptRegistry)
  const withoutRegistry = await (await get('/api/runs')).json()
  assert.ok(withoutRegistry.warnings.some(warning => warning.includes('Could not read installation registry')))
  assert.equal(withoutRegistry.currentRoot, 'work')
  assert.equal(withoutRegistry.current, 'central-run')
  assert.equal((await (await get('/api/state')).json()).plan.name, 'central')
  assert.equal(readFileSync(registry, 'utf8'), corruptRegistry)
})

test('global dashboard rejects plan synchronization', () => {
  const script = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))
  assert.throws(() => execFileSync(process.execPath, [script, '--global', '--sync-plan'], {
    windowsHide: true, encoding: 'utf8', stdio: 'pipe',
  }), error => error.status === 1 && /read-only/.test(error.stderr))
})

test('task planning mode exposes discussion readiness from the real persisted workflow', async t => {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, 'prumo-task-server-'))
  const root = join(home, '.local', 'share', 'prumo', 'work')
  const run = 'task-mode'
  mkdirSync(root, { recursive: true })
  const source = join(home, 'task-plan.json')
  const environment = { ...process.env, HOME: home, USERPROFILE: home,
    PRUMO_HOME: join(home, '.local', 'share', 'prumo'), PRUMO_ROOT: root,
    GRAPH_ROOT: '', GRAPH_FOREMAN_HOME: '', PRUMO_LANG: 'en' }
  writeFileSync(source, JSON.stringify({ name: 'task fixture', planningMode: 'task', tasks: [{
    id: 'DISCUSS', title: 'Discuss', deps: [], validationMode: 'inspection',
    inspectionReason: 'Server fixture has no runtime change', validation: 'Inspect discussion state',
  }] }))
  const engine = fileURLToPath(new URL('../scripts/engine.mjs', import.meta.url))
  execFileSync(process.execPath, [engine, 'init', '--plan', source, '--run', run], {
    cwd: root, env: environment, windowsHide: true,
  })
  const script = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))
  const child = spawn(process.execPath, [script, '--port', '0'], {
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
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const deadline = Date.now() + 15000
  while (!/localhost:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await setTimeout(30)
  const port = output.match(/localhost:(\d+)/)?.[1]
  assert.ok(port, output)
  const payload = await (await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(10000) })).json()
  assert.equal(payload.derived.DISCUSS.effective, 'ready_for_discussion')
})
