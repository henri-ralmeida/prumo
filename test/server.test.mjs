import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { setTimeout } from 'node:timers/promises'
import { contentId } from '../lib/install.mjs'
import { readDashboardEvents } from '../scripts/dashboard-diagnostics.mjs'
import { initializeLegacyPlanFixture } from './fixtures/legacy-plan-init.mjs'
import { releaseHistory } from '../lib/release-notes.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('histórico do changelog atende sem plano ou npm e ordena todas as versões do pacote', async t => {
  const home = dashboardHome(t, 'prumo-changelog-')
  const request = await startDashboard(t, join(packageRoot, 'scripts/serve.mjs'), ['--global'], {
    ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'central'),
  })
  const about = await (await request('/api/about')).json()
  const response = await request('/api/changelog')
  assert.equal(response.status, 200)
  const history = await response.json()
  assert.deepEqual(history, releaseHistory(['0.0.0'], about.version))
  assert.equal(history[0].version, about.version)
  assert.ok(history.length > 1)
  assert.match(await (await request('/')).text(), /onclick="openChangelog\(\)"/)
})

test('consulta de atualização informa a versão e não bloqueia o servidor quando o npm falha', async t => {
  for (const latest of ['99.0.0', 'offline']) {
    const home = dashboardHome(t, 'prumo-update-notice-')
    const preload = pathToFileURL(join(packageRoot, 'test/fixtures/dashboard-update-registry.mjs')).href
    const request = await startDashboard(t, join(packageRoot, 'scripts/serve.mjs'), ['--global'], {
      ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'central'),
      PRUMO_TEST_UPDATE_RESULT: latest, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import="${preload}"`,
    })
    const result = await (await request('/api/update')).json()
    const about = await (await request('/api/about')).json()
    assert.deepEqual(result, latest === 'offline' ? { available: false }
      : { available: true, current: about.version, latest })
    assert.equal((await request('/api/health')).status, 200)
  }
})

test('catálogo usa ações efetivas, prioridades e bloqueios sem alterar planos', async t => {
  const home = dashboardHome(t, 'prumo-catalog-status-')
  const root = join(home, 'project'), graph = join(root, '.specs', 'graph')
  const cases = [
    ['execute', ['pending'], 'working', 'ready'],
    ['plan', ['pending'], 'working', 'ready_to_plan'],
    ['discuss', ['pending'], 'working', 'ready_for_discussion'],
    ...['reviewing', 'running', 'planning', 'discussing', 'ready_for_review'].map(state => [state, [state], 'working', state]),
    ['blocked', ['blocked', 'waiting'], 'blocked', 'blocked'],
    ['failed', ['failed', 'waiting'], 'failed', 'failed'],
    ['waiting', ['waiting', 'done'], 'idle', null],
    ['available-blocked', ['blocked', 'ready'], 'working', 'ready'],
    ['active-available', ['planning', 'ready_for_review'], 'working', 'planning'],
    ['unknown', ['pending'], null, null],
    ['unrecognized', ['unknown'], null, null],
    ['empty', [], 'idle', null],
    ['missing', [], 'idle', null],
    ['missing-deps', ['pending'], 'working', 'ready'],
    ['review-rejected', ['reviewing'], 'failed', 'failed'],
    ['review-validating', ['reviewing'], 'working', 'reviewing'],
  ]
  const originals = []
  for (const [name, states] of cases) {
    const directory = join(graph, name)
    mkdirSync(directory, { recursive: true })
    const state = { plan: { name, planningMode: name === 'unknown' ? undefined : 'task' },
      tasks: Object.fromEntries(states.map((status, index) => {
        const id = `T${index + 1}`
        return [id, { id, state: status, deps: [], phase: 'F1',
          planningRequired: ['plan', 'discuss', 'unknown'].includes(name), discussionRequired: name === 'discuss' }]
      })) }
    if (name === 'missing') { delete state.plan; delete state.tasks }
    if (name === 'missing-deps') delete state.tasks.T1.deps
    if (name.startsWith('review-')) {
      state.tasks.T1.attempts = [{ n: 1, startedAt: '2026-01-01T09:00:00Z' }]
      state.tasks.T1.validations = [{ by: 'review', attempt: 1, ok: false, token: 'verdict', at: '2026-01-01T09:10:00Z',
        ...(name === 'review-rejected' ? { error: null } : {}) }]
    }
    const file = join(directory, 'state.json'), content = JSON.stringify(state)
    writeFileSync(file, content)
    originals.push([file, content])
  }
  writeFileSync(join(graph, 'CURRENT'), 'execute')
  const request = await startDashboard(t, join(packageRoot, 'scripts/serve.mjs'), [], {
    ...process.env, HOME: home, USERPROFILE: home, PRUMO_ROOT: root, PRUMO_HOME: join(home, 'central'),
  })
  const catalog = await (await request('/api/runs')).json()
  for (const [name, , activity, activityState] of cases) {
    const run = catalog.runs.find(run => run.run === name)
    assert.equal(run.activity, activity, name)
    assert.equal(run.activityState, activityState, name)
  }
  for (const [file, content] of originals) assert.equal(readFileSync(file, 'utf8'), content)
  assert.equal((await request('/api/health')).status, 200, 'o servidor continua disponível após listar os planos')
})
/** O commit curto que o git informa para este checkout, ou undefined quando o git não consegue responder. */
function checkoutCommit(root = packageRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch { return undefined }
}

const dashboardFixtures = new WeakMap()

function dashboardHome(t, prefix, remove = home => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })) {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, prefix))
  const stops = []
  dashboardFixtures.set(t, stops)
  t.after(async () => {
    const closed = await Promise.allSettled(stops.map(stop => stop()))
    const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason)
    // Os arquivos só podem ser removidos depois de todos os servidores encerrarem.
    if (failures.length) throw new AggregateError(failures, 'Falha ao encerrar servidores do teste')
    assert.equal(dirname(home), base)
    await remove(home)
  })
  return home
}

/** Inicia o servidor isolado e vincula seu encerramento à limpeza dos arquivos. */
async function startDashboard(t, script, args, env) {
  const stops = dashboardFixtures.get(t)
  assert.ok(stops, 'o servidor precisa de uma fixture responsável pela limpeza')
  const child = spawn(process.execPath, [script, ...args, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const closed = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  const stop = async () => { if (child.exitCode === null) child.kill(); await closed }
  stops.push(stop)
  const deadline = Date.now() + 15000
  while (!/localhost:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await setTimeout(30)
  const port = output.match(/localhost:(\d+)/)?.[1]
  assert.ok(port && port !== '0', output)
  const request = path => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(10000) })
  request.pid = child.pid
  request.readOutput = () => output
  return request
}

test('limpeza do dashboard encerra filhos mesmo após falha de asserção ou remoção', { timeout: 30000 }, async t => {
  for (const failure of ['assertion', 'cleanup']) {
    let cleanup
    const context = { after: callback => { cleanup = callback } }
    const original = new Error(`falha simulada de ${failure}`)
    const home = dashboardHome(context, 'prumo-server-cleanup-', failure === 'cleanup'
      ? () => { throw original }
      : undefined)
    t.after(async () => {
      await cleanup().catch(() => {})
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const request = await startDashboard(context, join(packageRoot, 'scripts/serve.mjs'), ['--global'], {
      ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'central'),
    })
    assert.equal((await request('/api/health')).status, 200)
    if (failure === 'assertion') {
      await assert.rejects(async () => {
        try { throw original }
        finally { await cleanup() }
      }, error => error === original, 'o encerramento não substitui o diagnóstico da asserção')
    } else {
      await assert.rejects(cleanup(), error => error === original, 'a falha da remoção continua observável')
    }
    assert.throws(() => process.kill(request.pid, 0), error => error.code === 'ESRCH',
      'nenhum servidor filho pode permanecer vivo depois da limpeza')
  }
})

test('falha inesperada ao iniciar servidor produz diagnóstico e saída de erro', t => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'prumo-listen-failure-'))
  t.after(() => { assert.equal(dirname(home), realpathSync(tmpdir())); rmSync(home, { recursive: true, force: true }) })
  const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/server-listen-failure.mjs', import.meta.url).href,
    join(packageRoot, 'scripts/serve.mjs'), '--global', '--port', '0'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'central') },
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /falha de inicialização simulada/)
  const events = readDashboardEvents({ home })
  assert.ok(events.some(event => event.event === 'server-error' && event.code === 'EIO'))
  assert.ok(events.some(event => event.event === 'fatal'))
})

test('sincronização opcional recupera plano inválido sem perder estado nem parar o dashboard', { timeout: 30000 }, async t => {
  const home = dashboardHome(t, 'prumo-sync-server-')
  const root = join(home, 'central', 'project')
  mkdirSync(root, { recursive: true })
  const env = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_ROOT: root, PRUMO_HOME: join(home, 'central'), PRUMO_LANG: 'en' }
  const source = join(home, 'plan.json')
  const plan = { name: 'Sincronização', tasks: [{ id: 'T1', title: 'Original', deps: [], validationMode: 'inspection',
    inspectionReason: 'Plano de teste sem alteração executável', validation: 'Inspecionar o título' }] }
  writeFileSync(source, JSON.stringify(plan))
  execFileSync(process.execPath, [join(packageRoot, 'scripts/engine.mjs'), 'init', '--plan', source, '--run', 'sync'], { cwd: root, env, windowsHide: true })
  const request = await startDashboard(t, join(packageRoot, 'scripts/serve.mjs'), ['--sync-plan'], env)
  await setTimeout(1300)
  const before = await (await request('/api/state')).json()
  writeFileSync(source, '{')
  await setTimeout(1300)
  const failed = await (await request('/api/state')).json()
  assert.equal(failed.tasks.T1.title, before.tasks.T1.title)
  assert.equal((await request('/api/health')).status, 200)
  plan.tasks[0].title = 'Atualizado'
  writeFileSync(source, JSON.stringify(plan))
  const deadline = Date.now() + 10000
  let state
  do {
    await setTimeout(100)
    state = await (await request('/api/state')).json()
  } while (state.tasks.T1.title !== 'Atualizado' && Date.now() < deadline)
  assert.equal(state.tasks.T1.title, 'Atualizado')
  assert.equal(state.tasks.T1.state, before.tasks.T1.state)
  // O estado pode ficar visível antes do processo de sincronização encerrar; seu callback confirma a conclusão.
  const finished = /run "sync" synced:.*updated 1,/
  const finishDeadline = Date.now() + 10000
  while (!finished.test(request.readOutput()) && Date.now() < finishDeadline) await setTimeout(50)
  assert.match(request.readOutput(), finished, 'a limpeza aguarda o processo de sincronização concluir, sem interromper a gravação')
})

test('histórico vazio, parcial e muitos planos mantêm paginação consistente', { timeout: 30000 }, async t => {
  const home = dashboardHome(t, 'prumo-history-cache-')
  const root = join(home, 'central', 'project'), graph = join(root, '.specs', 'graph')
  for (let index = 0; index < 34; index++) {
    const run = join(graph, `run${index}`)
    mkdirSync(run, { recursive: true })
    writeFileSync(join(run, 'state.json'), JSON.stringify({ plan: { name: `run${index}` }, tasks: {} }))
    writeFileSync(join(run, 'events.ndjson'), index === 0 ? '' : JSON.stringify({ type: 'note', task: `T${index}` }) + '\n')
  }
  writeFileSync(join(graph, 'CURRENT'), 'run0')
  const env = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_ROOT: root, PRUMO_HOME: join(home, 'central') }
  const request = await startDashboard(t, join(packageRoot, 'scripts/serve.mjs'), [], env)
  const empty = await (await request('/api/events?run=run0&after=0')).json()
  assert.equal(empty.complete, true)
  assert.equal(empty.total, 0)
  const file = join(graph, 'run0/events.ndjson')
  writeFileSync(file, '{"type":"note"')
  const partial = await (await request('/api/events?run=run0&after=0')).json()
  assert.equal(partial.complete, false)
  assert.equal(partial.total, 0)
  writeFileSync(file, '{"type":"note","task":"T0"}\n')
  const complete = await (await request('/api/events?run=run0&after=0')).json()
  assert.equal(complete.complete, true)
  assert.deepEqual(complete.events, [{ type: 'note', task: 'T0' }])
  for (let index = 1; index < 34; index++) {
    const page = await (await request(`/api/events?run=run${index}&after=0`)).json()
    assert.deepEqual(page.events, [{ type: 'note', task: `T${index}` }])
  }
  const returned = await (await request('/api/events?run=run0&after=0')).json()
  assert.deepEqual(returned.events, complete.events)
})

test('guia carrega apenas quadros locais e preserva dados existentes', async t => {
  const home = dashboardHome(t, 'prumo-guia-')
  const graph = join(home, 'project', '.specs', 'graph')
  mkdirSync(join(graph, 'real'), { recursive: true })
  const statePath = join(graph, 'real', 'state.json')
  const original = JSON.stringify({ run: 'real', plan: { name: 'Plano existente' }, tasks: {} })
  writeFileSync(statePath, original)
  writeFileSync(join(graph, 'CURRENT'), 'real')
  const request = await startDashboard(t, join(packageRoot, 'scripts', 'serve.mjs'), [], { ...process.env, PRUMO_ROOT: join(home, 'project'), PRUMO_HOME: join(home, 'central') })
  for (const mode of ['board', 'results']) {
    const response = await request('/?guide-demo=' + mode)
    assert.equal(response.status, 200)
    const csp = response.headers.get('content-security-policy')
    assert.match(csp, /frame-src 'self'/)
    assert.match(csp, /default-src 'none'/)
    assert.doesNotMatch(csp, /frame-src \*/)
    assert.match(await response.text(), /createGuideDemoData/)
  }
  assert.equal(readFileSync(statePath, 'utf8'), original)
  assert.equal(readFileSync(join(graph, 'CURRENT'), 'utf8'), 'real')
})

test('/api/about reports where the package lives, not the --global serving mode', async t => {
  const home = dashboardHome(t, 'prumo-origin-')
  const env = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'central'), PRUMO_LANG: 'en' }

  // O checkout de código-fonte servido com --global ainda é o repositório
  const fromCheckout = await startDashboard(t, join(packageRoot, 'scripts', 'serve.mjs'), ['--global'], env)
  const checkout = await (await fromCheckout('/api/about')).json()
  assert.equal(checkout.origin, 'repository')
  assert.equal(checkout.commit, checkoutCommit())
  assert.equal(checkout.path, packageRoot)

  // Os mesmos arquivos instalados em node_modules são o pacote global, sem commit
  const installed = join(home, 'npm', 'node_modules', '@henri-ralmeida', 'prumo')
  for (const entry of ['bin', 'lib', 'scripts', 'references', 'SKILL.md', 'package.json'])
    cpSync(join(packageRoot, entry), join(installed, entry), { recursive: true })
  const fromNpm = await startDashboard(t, join(installed, 'scripts', 'serve.mjs'), ['--global'], env)
  const npm = await (await fromNpm('/api/about')).json()
  assert.equal(npm.origin, 'global')
  assert.equal(npm.commit, undefined)
  assert.equal(npm.path, installed)
})

test('identidade informa ausência de metadados sem inventar versão ou revisão Git', async t => {
  const home = dashboardHome(t, 'prumo-partial-server-')
  const env = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'central'), PRUMO_LANG: 'en' }
  for (const origin of ['unknown', 'repository', 'installed']) {
    const root = join(home, origin)
    for (const entry of ['bin', 'lib', 'scripts', 'references', 'SKILL.md']) cpSync(join(packageRoot, entry), join(root, entry), { recursive: true })
    if (origin === 'repository') mkdirSync(join(root, '.git'))
    if (origin === 'installed') writeFileSync(join(root, '.prumo-install.json'), JSON.stringify({ version: '2.0.0' }))
    else writeFileSync(join(root, 'package.json'), '{}')
    const request = await startDashboard(t, join(root, 'scripts/serve.mjs'), ['--global'], env)
    const about = await (await request('/api/about')).json()
    assert.equal(about.origin, origin)
    assert.equal(about.version, origin === 'installed' ? '2.0.0' : 'unknown')
    assert.equal(about.commit, undefined)
    assert.equal(about.contentId, null)
  }
})

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
  const initialized = initializeLegacyPlanFixture((...args) => spawnSync(process.execPath, [engine, ...args], {
    cwd: root, env: environment, encoding: 'utf8', windowsHide: true,
  }), source, root, 'planning-demo')
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr)
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
  assert.equal(about.origin, 'repository', 'a source checkout reports the repository, whatever the serving mode')
  assert.equal(about.commit, checkoutCommit())
  assert.equal(about.contentId, contentId('pt-BR'))
  assert.equal(about.path, dirname(dirname(fileURLToPath(import.meta.url))))
  assert.match(about.contentId, /^[a-f0-9]{12}$/)
  const runs = await (await get('/api/runs')).json()
  assert.equal(runs.currentRoot, 'work')
  assert.equal(runs.runs.length, 3)
  const planningRun = runs.runs.find(run => run.root === 'work' && run.run === 'planning-demo')
  assert.equal(planningRun.activity, 'working')
  assert.equal(planningRun.complete, false)
  const graph = join(root, '.specs', 'graph')
  // Uma execução cuja tarefa restante foi ignorada por decisão do usuário é concluída, como indicam o cabeçalho e o cartão de ganho;
  // somente uma execução com trabalho pendente, ou sem nada concluído, fica fora de "in prumo".
  for (const [name, states] of [['complete-demo', ['done', 'done']], ['skipped-demo', ['done', 'skipped']],
    ['all-skipped-demo', ['skipped', 'skipped']], ['almost-demo', ['done', 'pending']]]) {
    const directory = join(graph, name)
    mkdirSync(directory)
    writeFileSync(join(directory, 'state.json'), JSON.stringify({ plan: { name }, tasks: Object.fromEntries(states.map((state, index) =>
      [`T${index + 1}`, { id: `T${index + 1}`, state, deps: [], planningRequired: false }])) }))
  }
  const refreshed = (await (await get('/api/runs')).json()).runs
  assert.equal(refreshed.find(run => run.run === 'complete-demo')?.complete, true)
  assert.equal(refreshed.find(run => run.run === 'complete-demo')?.doneCount, 2)
  const skippedRun = refreshed.find(run => run.run === 'skipped-demo')
  assert.equal(skippedRun?.complete, true, 'done + skipped por decisao do usuario conta como no prumo')
  assert.equal(skippedRun?.doneCount, 1)
  assert.equal(skippedRun?.skippedCount, 1)
  assert.equal(refreshed.find(run => run.run === 'all-skipped-demo')?.complete, false, 'sem nenhuma tarefa done nao ha plano entregue')
  assert.equal(refreshed.find(run => run.run === 'almost-demo')?.complete, false,
    'trabalho pendente mantem o plano em andamento')
  assert.equal(refreshed.find(run => run.run === 'almost-demo')?.activity, 'working')
  assert.equal(refreshed.find(run => run.run === 'almost-demo')?.activityState, 'ready')
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
  assert.deepEqual(await (await get('/api/state')).json(), { plan: { name: '', phases: [] }, tasks: {}, derived: {}, empty: true, commandMetrics: { byCommand: {}, total: 0, startedAt: null, complete: false } })
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
    id: 'T1', title: 'Discuss', deps: [], validationMode: 'inspection',
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
  assert.equal(payload.derived.T1.effective, 'ready_for_discussion')
})
