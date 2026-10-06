import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { setTimeout } from 'node:timers/promises'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const serverScript = join(packageRoot, 'scripts', 'serve.mjs')
const engineScript = join(packageRoot, 'scripts', 'engine.mjs')

function task(id, state = 'pending') {
  return {
    id, phase: null, title: id, deps: [], validation: 'Confirmar o resultado da tarefa',
    validationMode: 'inspection', inspectionReason: 'A tarefa exige uma inspeção manual',
    tags: [], touches: [], state, discussionRequired: false, discussionAttempts: [], discussionSkips: [],
    discoveryRequired: false, planningRequired: false, planner: null, planningAttempts: [], planningHistory: [],
    planningSkips: [], agent: state === 'running' ? 'worker-1' : null, reviewer: null,
    attempts: state === 'running' ? [{ n: 1, agent: 'worker-1', startedAt: '2026-01-01T00:00:00.000Z' }] : [],
    validations: [], notes: [],
  }
}

function fixture(t, prefix = 'prumo-agent-limit-') {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, prefix))
  const central = join(home, 'central')
  const root = join(central, 'project')
  const graph = join(root, '.specs', 'graph')
  const run = 'limit'
  const runDir = join(graph, run)
  const statePath = join(runDir, 'state.json')
  const eventsPath = join(runDir, 'events.ndjson')
  mkdirSync(runDir, { recursive: true })
  const state = {
    schemaVersion: 1,
    run,
    plan: {
      name: 'Limite de agentes', description: '', phases: [], maxParallel: 4, maxExecutors: 3,
      maxAgents: 3, requireReview: true, planningMode: 'task',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    authorizations: [],
    tasks: { T1: task('T1', 'running'), T2: task('T2') },
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2))
  writeFileSync(eventsPath, '')
  writeFileSync(join(graph, 'CURRENT'), run)
  return { base, home, central, root, graph, run, runDir, statePath, eventsPath, state }
}

async function startDashboard(t, f, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: f.home,
    USERPROFILE: f.home,
    PRUMO_ROOT: f.root,
    PRUMO_HOME: f.central,
    PRUMO_LANG: 'en',
    ...extraEnv,
  }
  const child = spawn(process.execPath, [serverScript, '--port', '0'], {
    cwd: f.root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await closed
    rmSync(f.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const deadline = Date.now() + 15000
  while (!/localhost:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await setTimeout(30)
  const port = output.match(/localhost:(\d+)/)?.[1]
  assert.ok(port && port !== '0', output)
  const request = async (path, options) => {
    try {
      return await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(15000), ...options,
      })
    } catch (error) {
      error.message += `\nserver output:\n${output}`
      throw error
    }
  }
  request.port = port
  request.origin = `http://127.0.0.1:${port}`
  request.output = () => output
  return { request, env }
}

function controlHeaders(request, token, contentType = 'application/json') {
  return {
    Origin: request.origin,
    'X-Prumo-Control': token,
    'Content-Type': contentType,
  }
}

test('API distingue agentes ativos, alvos em fila e entregas que aguardam fechamento da fase', { timeout: 60000 }, async t => {
  const f = fixture(t)
  f.state.plan.planningMode = 'phase'
  f.state.plan.phases = [{ id: 'F1', title: 'Discussão da fase' }]
  f.state.tasks = Object.fromEntries(['T1', 'T2', 'T3', 'T4', 'T5'].map(id => [id, {
    ...task(id), phase: 'F1', discussionRequired: true, discoveryRequired: true, planningRequired: true,
  }]))
  f.state.tasks.T4.state = 'discussing'
  f.state.tasks.T4.discussionAttempts = [{ agent: 'discussor-individual' }]
  f.state.phaseWorkflows = { F1: { id: 'F1', state: 'discussing', planningAttempts: [], discussionAttempts: [{
    targets: ['T1', 'T2', 'T3', 'T5'], activeTargets: ['T1'], queuedTargets: ['T2'], workers: {
      T1: { agent: 'discussor-ativo', role: 'discussion' },
      T3: { agent: 'discussor-encerrado', role: 'discussion', endedAt: '2026-01-01T00:01:00Z' },
      T5: { agent: 'discussor-aguardando', role: 'discussion' },
    },
  }] } }
  writeFileSync(f.statePath, JSON.stringify(f.state))
  const { request } = await startDashboard(t, f)
  let derived = (await (await request('/api/state')).json()).derived
  assert.equal(derived.T1.effective, 'discussing')
  assert.equal(derived.T1.activeAgent, 'discussor-ativo')
  assert.equal(derived.T2.agentQueued, true)
  assert.equal(derived.T2.effective, 'waiting')
  assert.equal(derived.T2.activeAgent, undefined)
  assert.equal(derived.T3.phaseBatchPending, true)
  assert.equal(derived.T3.effective, 'waiting')
  assert.equal(derived.T3.activeAgent, undefined)
  assert.equal(derived.T4.activeAgent, 'discussor-individual')
  assert.equal(derived.T5.activeAgent, undefined, 'um worker fora dos alvos ativos não deve parecer em atividade')
  f.state.phaseWorkflows.F1.state = 'pending'
  writeFileSync(f.statePath, JSON.stringify(f.state))
  derived = (await (await request('/api/state')).json()).derived
  assert.equal(derived.T1.activeAgent, undefined)
  assert.equal(derived.T3.phaseBatchPending, undefined)
})

test('API real expõe limite e persiste alteração para a próxima operação CLI', { timeout: 60000 }, async t => {
  const f = fixture(t)
  const { request, env } = await startDashboard(t, f)
  const initialResponse = await request('/api/state')
  assert.equal(initialResponse.status, 200)
  const initial = await initialResponse.json()
  assert.deepEqual(initial.agentUsage, { used: 1, maxAgents: 3 })
  assert.match(initial.agentControlToken, /^[0-9a-f-]{36}$/)
  const originalTasks = structuredClone(initial.tasks)

  const changed = await request('/api/agent-limit', {
    method: 'POST', headers: controlHeaders(request, initial.agentControlToken),
    body: JSON.stringify({ maxAgents: 1 }),
  })
  const changedBody = await changed.text()
  assert.equal(changed.status, 200, changedBody)
  assert.deepEqual(JSON.parse(changedBody), { maxAgents: 1 })

  const persisted = JSON.parse(readFileSync(f.statePath, 'utf8'))
  assert.equal(persisted.plan.maxAgents, 1)
  assert.deepEqual(persisted.tasks, originalTasks)
  assert.deepEqual(persisted.agentLimitHistory.at(-1), {
    previous: 3, maxAgents: 1, actor: 'dashboard-user', at: persisted.agentLimitHistory.at(-1).at,
  })
  assert.equal(persisted.agentLimitHistory.length, 1)
  const events = readFileSync(f.eventsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  assert.equal(events.at(-1).type, 'agent_limit_changed')
  assert.equal(events.at(-1).actor, 'dashboard-user')
  assert.equal(events.at(-1).maxAgents, 1)

  const next = await request('/api/state')
  assert.equal(next.status, 200)
  const nextState = await next.json()
  assert.deepEqual(nextState.agentUsage, { used: 1, maxAgents: 1 })
  assert.equal(nextState.agentControlToken, initial.agentControlToken)

  const cli = spawnSync(process.execPath, [engineScript, 'graph', '--run', f.run], {
    cwd: f.root, env, encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
  assert.equal(cli.status, 0, cli.stdout + cli.stderr)
  assert.equal(JSON.parse(cli.stdout).plan.maxAgents, 1)
})

test('API de limite rejeita método, origem, identidade, corpo e seleção fora do catálogo sem gravação', { timeout: 60000 }, async t => {
  const f = fixture(t)
  const { request } = await startDashboard(t, f)
  const stateResponse = await request('/api/state')
  assert.equal(stateResponse.status, 200)
  const state = await stateResponse.json()
  const headers = controlHeaders(request, state.agentControlToken)
  const stateBefore = readFileSync(f.statePath, 'utf8')
  const eventsBefore = readFileSync(f.eventsPath, 'utf8')

  const assertUnchanged = () => {
    assert.equal(readFileSync(f.statePath, 'utf8'), stateBefore)
    assert.equal(readFileSync(f.eventsPath, 'utf8'), eventsBefore)
  }
  const send = (path, options = {}) => request(path, {
    method: 'POST', headers: { ...headers, ...options.headers },
    body: options.body ?? JSON.stringify({ maxAgents: 2 }),
  })
  const sendWithoutOrigin = () => {
    const noOrigin = { ...headers }
    delete noOrigin.Origin
    return request('/api/agent-limit', {
      method: 'POST', headers: noOrigin, body: JSON.stringify({ maxAgents: 2 }),
    })
  }

  assert.equal((await request('/api/agent-limit')).status, 405)
  assert.equal((await sendWithoutOrigin()).status, 403)
  assert.equal((await send('/api/agent-limit', { headers: { Origin: 'http://example.invalid' } })).status, 403)
  assert.equal((await send('/api/agent-limit', { headers: { Origin: 'not-a-url' } })).status, 403)
  assert.equal((await send('/api/agent-limit', { headers: { 'X-Prumo-Control': 'wrong-token' } })).status, 403)
  assert.equal((await send('/api/agent-limit', { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal((await send('/api/agent-limit', { body: '{' })).status, 400)
  assert.equal((await send('/api/agent-limit', { body: JSON.stringify({ maxAgents: 1.5 }) })).status, 400)
  assert.equal((await send('/api/agent-limit', { body: JSON.stringify({ maxAgents: '2' }) })).status, 400)
  assert.equal((await send('/api/agent-limit', { body: JSON.stringify({ maxAgents: 0 }) })).status, 400)
  assert.equal((await send('/api/agent-limit', { body: JSON.stringify({ maxAgents: -1 }) })).status, 400)
  assert.equal((await send('/api/agent-limit', { body: JSON.stringify({ maxAgents: null }) })).status, 400)
  assert.equal((await send('/api/agent-limit', {
    body: JSON.stringify({ maxAgents: 2, padding: 'x'.repeat(2050) }),
  })).status, 413)
  assert.equal((await send('/api/agent-limit?root=unknown-project&run=limit')).status, 404)
  assert.equal((await send('/api/agent-limit?root=..%2Foutside&run=limit')).status, 404)
  assert.equal((await send('/api/agent-limit?run=..%2Foutside')).status, 404)
  assertUnchanged()
})

test('controle não confirma alteração quando o motor falha e continua disponível após requisição interrompida', { timeout: 60000 }, async t => {
  const f = fixture(t)
  const { request } = await startDashboard(t, f)
  const initial = await (await request('/api/state')).json()
  const headers = controlHeaders(request, initial.agentControlToken)
  const original = readFileSync(f.statePath, 'utf8')
  const events = readFileSync(f.eventsPath, 'utf8')
  writeFileSync(f.statePath, '{malformed')
  const failed = await request('/api/agent-limit?root=project&run=limit', {
    method: 'POST', headers, body: JSON.stringify({ maxAgents: 1 }),
  })
  assert.equal(failed.status, 409)
  assert.ok((await failed.json()).error)
  assert.equal(readFileSync(f.statePath, 'utf8'), '{malformed')
  assert.equal(readFileSync(f.eventsPath, 'utf8'), events)
  writeFileSync(f.statePath, original)
  await new Promise(resolve => {
    const partial = httpRequest(`${request.origin}/api/agent-limit`, {
      method: 'POST', headers: { ...headers, 'Content-Length': '100' },
    })
    partial.on('error', resolve)
    partial.on('close', resolve)
    partial.write('{"maxAgents":')
    globalThis.setTimeout(() => partial.destroy(), 50)
  })
  const after = await (await request('/api/state')).json()
  assert.equal(after.plan.maxAgents, 3)
  assert.equal(readFileSync(f.statePath, 'utf8'), original)
  assert.equal(readFileSync(f.eventsPath, 'utf8'), events)
})

for (const mode of ['stdout', 'message']) test(`falha de processo mantém o limite e informa diagnóstico por ${mode}`, { timeout: 60000 }, async t => {
  const f = fixture(t)
  const preload = join(f.home, 'backend-failure.mjs')
  writeFileSync(preload, `
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const original = childProcess.execFile
childProcess.execFile = (file, args, options, callback) => {
  if (args?.[1] !== 'set-agent-limit') return original(file, args, options, callback)
  setImmediate(() => callback(new Error('falha de processo'), process.env.PRUMO_TEST_AGENT_FAILURE === 'stdout' ? 'diagnóstico do processo' : '', ''))
}
syncBuiltinESMExports()
`)
  const { request } = await startDashboard(t, f, {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import="${pathToFileURL(preload).href}"`,
    PRUMO_TEST_AGENT_FAILURE: mode,
  })
  const initial = await (await request('/api/state')).json()
  const before = readFileSync(f.statePath, 'utf8'), events = readFileSync(f.eventsPath, 'utf8')
  const failed = await request('/api/agent-limit', {
    method: 'POST', headers: controlHeaders(request, initial.agentControlToken), body: JSON.stringify({ maxAgents: 1 }),
  })
  assert.equal(failed.status, 409)
  assert.equal((await failed.json()).error, mode === 'stdout' ? 'diagnóstico do processo' : 'falha de processo')
  assert.equal(readFileSync(f.statePath, 'utf8'), before)
  assert.equal(readFileSync(f.eventsPath, 'utf8'), events)
  const recovered = await request('/api/state')
  assert.equal(recovered.status, 200, 'a falha do processo não pode derrubar o dashboard')
  assert.equal((await recovered.json()).plan.maxAgents, 3)
})
