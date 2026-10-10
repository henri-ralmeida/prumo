import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { occupancy } from '../scripts/execution-readiness.mjs'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/engine.mjs')
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const validation = [{ kind: 'functional', run: 'node check.cjs', expect: 'o comportamento aprovado passa' }]

function fixture(t, { tasks = ['T1', 'T2', 'T3', 'T4'], run = 'agent-limit', plan = {} } = {}) {
  const home = mkdtempSync(join(repoRoot, '.test-agent-limit-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const root = join(home, 'workspace')
  const project = join(home, 'project')
  mkdirSync(root)
  mkdirSync(project)
  writeFileSync(join(project, 'check.cjs'), "require('node:assert/strict').ok(true)\n")
  const planPath = join(root, 'plan.json')
  writeFileSync(planPath, JSON.stringify({
    name: 'Limite de agentes',
    description: 'O limite compartilhado protege a capacidade de trabalho ativo.',
    planningMode: 'task',
    ...plan,
    tasks: tasks.map(id => ({ id, title: `Tarefa ${id}`, validation, ...(plan.tasks?.find(task => task.id === id) ?? {}) })),
  }))
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: 'en' }
  const cli = (...args) => spawnSync(process.execPath, [engine, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 20000, windowsHide: true,
  })
  const ok = (...args) => {
    const result = cli(...args)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result
  }
  const statePath = join(root, '.specs', 'graph', run, 'state.json')
  const eventsPath = join(root, '.specs', 'graph', run, 'events.ndjson')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const stateBytes = () => readFileSync(statePath)
  const saveState = value => writeFileSync(statePath, JSON.stringify(value, null, 2))
  const eventsBytes = () => readFileSync(eventsPath)
  const events = () => eventsBytes().toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const initialized = cli('init', '--plan', planPath, '--run', run)
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr)
  return { root, project, planPath, run, cli, ok, state, saveState, stateBytes, events, eventsBytes }
}

function phaseFixture(t, { run = 'phase-agent-limit', maxAgents = 3 } = {}) {
  const home = mkdtempSync(join(repoRoot, '.test-agent-limit-phase-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const root = join(home, 'workspace')
  const project = join(home, 'project')
  const plans = join(root, 'plans')
  mkdirSync(root)
  mkdirSync(project)
  mkdirSync(plans)
  writeFileSync(join(project, 'check.cjs'), "require('node:assert/strict').ok(true)\n")
  const planPath = join(root, 'plan.json')
  writeFileSync(planPath, JSON.stringify({
    name: 'Planejamento de fase com limite compartilhado',
    description: 'Cada tarefa elegível recebe seu agente individual quando há capacidade.',
    planningMode: 'phase',
    maxAgents,
    phases: [{ id: 'F1', title: 'Fase de entrega' }],
    tasks: ['T1', 'T2', 'T3', 'T4'].map(id => ({
      id, phase: 'F1', title: `Entrega ${id}`, summary: `Entregar o resultado aprovado de ${id}.`, validation,
    })),
  }))
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: 'en' }
  const cli = (...args) => spawnSync(process.execPath, [engine, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 30000, windowsHide: true,
  })
  const ok = (...args) => {
    const result = cli(...args)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result
  }
  const statePath = join(root, '.specs', 'graph', run, 'state.json')
  const eventsPath = join(root, '.specs', 'graph', run, 'events.ndjson')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const phase = () => state().phaseWorkflows.F1
  const events = () => readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const discoveryPath = activeIds => {
    const round = phase().discussionAttempts.at(-1)
    const discovery = {
      research: [{ source: join(project, 'check.cjs'), findings: 'Os contratos da onda atual foram inspecionados.' }],
      questions: [{ question: `Preservar os contratos de ${activeIds.join(', ')}?`, answer: 'Sim.',
        channel: 'chat-fallback', round: 1, roundId: round.roundId }],
      coverage: {
        problem: 'A fase precisa entregar os contratos aprovados.', affected: 'Pessoas que recebem a entrega da fase.',
        outcome: 'Cada tarefa incluída mantém seu comportamento aprovado.', currentBehavior: 'Os contratos atuais foram inspecionados.',
        desiredBehavior: 'A fase segue o plano aprovado.', rules: 'Preservar contratos e dependências.',
        exceptions: 'A onda considera somente os agentes ativos.', scope: 'Fase F1.', acceptance: 'As verificações funcionais passam.',
      },
      decisions: [], deferred: [], executionBoundary: { deferredToExecutor: [...activeIds], prematureTaskWork: [] },
      closure: 'Não resta incerteza consequencial na onda atual.', roundId: round.roundId, nonce: round.nonce,
    }
    const path = join(root, `discovery-${round.roundId}-${activeIds.join('-')}.json`)
    writeFileSync(path, JSON.stringify(discovery))
    return path
  }
  const finishPhaseDiscussion = activeIds => ok('finish-phase-discussion', 'F1', '--context', discoveryPath(activeIds))
  const planPathFor = id => {
    return join(plans, `task-plan-${id}.json`)
  }
  const writePhasePlans = ids => {
    const round = phase().planningAttempts.at(-1)
    for (const id of ids) {
      const task = state().tasks[id]
      const artifact = {
        summary: `Aplicar o contrato aprovado de ${id}.`,
        research: [{ source: join(project, 'check.cjs'), findings: `A verificação funcional de ${id} foi conferida.` }],
        decisions: [], steps: [`Entregar ${id}.`, `Executar a verificação de ${id}.`],
        verification: task.validation.map((step, index) => ({ criterion: step.expect, check: index + 1 })),
        openQuestions: [], phaseBinding: { phaseId: 'F1', discussionRoundId: round.discussionRoundId, plannerRound: round.n },
        unresolvedInputs: round.requiredInputs?.[id] ?? [],
      }
      writeFileSync(planPathFor(id), JSON.stringify(artifact))
    }
  }
  const finishPhasePlanning = ids => {
    writePhasePlans(ids)
    return ok('finish-phase-planning', 'F1', '--plan-dir', plans)
  }
  const initialized = cli('init', '--plan', planPath, '--run', run)
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr)
  return {
    root, project, plans, planPath, run, cli, ok, state, phase, events,
    saveState: value => writeFileSync(statePath, JSON.stringify(value)),
    finishPhaseDiscussion, finishPhasePlanning, writePhasePlans, planPathFor,
  }
}

const ids = values => values.map(value => value.id).sort()

test('atribuições inválidas de fase não abrem rodada nem alteram tarefas', t => {
  const f = phaseFixture(t, { run: 'invalid-phase-assignments' })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Contrato confirmado', '--confirmed-by-user')
  for (const values of [[' '], ['=planner'], ['T1='], ['X=planner'], ['T1=a', 'bad'],
    ['T1=a', 'T1=b', 'T3=c', 'T4=d'], ['T1=a', 'T2=a', 'T3=c', 'T4=d']]) {
    const before = f.state(), events = f.events()
    const result = f.cli('plan-phase', 'F1', ...values.flatMap(value => ['--agent', value]))
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /phase agent/)
    assert.deepEqual(f.state(), before)
    assert.deepEqual(f.events(), events)
  }
})

test('limite legado sem maxAgents registra origem desconhecida e revisor não ocupa duas tarefas', t => {
  const f = fixture(t, { tasks: ['T1', 'T2'], run: 'legacy-limit-reviewer' })
  const legacy = f.state()
  delete legacy.plan.maxAgents
  for (const task of Object.values(legacy.tasks)) task.planningRequired = false
  f.saveState(legacy)
  f.ok('set-agent-limit', '--max', '3', '--actor', 'usuario', '--confirmed-by-user')
  assert.equal(f.state().agentLimitHistory.at(-1).previous, null)
  f.ok('authorize', '--scope', 'run', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'one')
  f.ok('start', 'T2', '--agent', 'two')
  const before = f.state(), events = f.events()
  const result = f.cli('review', 'T1', '--agent', 'two')
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /already on T2/)
  assert.deepEqual(f.state(), before)
  assert.deepEqual(f.events(), events)
})

test('repetir planejamento após aumentar limite ativa somente os alvos que aguardavam vaga', t => {
  const f = phaseFixture(t, { run: 'phase-resume-capacity', maxAgents: 1 })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Contrato confirmado', '--confirmed-by-user')
  f.ok('plan-phase', 'F1', '--agent', 'planner')
  const round = f.phase().planningAttempts.at(-1)
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.T2.agentQueued, true)
  f.ok('plan-phase', 'F1', '--agent', 'planner')
  assert.deepEqual(f.phase().planningAttempts.at(-1).activeTargets, ['T1'])
  f.ok('set-agent-limit', '--max', '4', '--actor', 'usuario', '--confirmed-by-user')
  f.ok('plan-phase', 'F1', '--agent', 'planner')
  const resumed = f.phase().planningAttempts.at(-1)
  assert.equal(f.phase().planningAttempts.length, 1)
  assert.equal(resumed.startedAt, round.startedAt)
  assert.deepEqual(resumed.activeTargets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(resumed.queuedTargets, [])
  assert.equal(resumed.workers.T1.startedAt, round.workers.T1.startedAt)
  assert.equal(occupancy(f.state()).busy.length, 4)
})

test('atividade de fase recusa agente errado, alvo em fila e worker encerrado sem mutação', t => {
  const f = phaseFixture(t, { run: 'phase-activity-refusal' })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Contrato confirmado', '--confirmed-by-user')
  f.ok('plan-phase', 'F1', '--agent', 'planner')
  for (const [id, scope, agent] of [['F1', 'phase', 'other'], ['T4', 'task', 'planner:T4'], ['T1', 'task', 'other']]) {
    const before = f.state()
    const result = f.cli('activity-start', id, '--scope', scope, '--role', 'planning', '--agent', agent)
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /assigned phase worker|belongs to/)
    assert.deepEqual(f.state(), before)
  }
  f.finishPhasePlanning(['T1', 'T2', 'T3'])
  const result = f.cli('activity-start', 'T1', '--scope', 'task', '--role', 'planning', '--agent', 'planner:T1')
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /assigned phase worker/)
})

test('discussão de fase respeita ocupação de outros papéis e nomes já em uso', t => {
  const f = phaseFixture(t, { run: 'phase-occupied' })
  const state = f.state()
  state.tasks.extra = { ...structuredClone(state.tasks.T1), id: 'extra', phase: null, state: 'running', agent: 'orchestrator:T1', attempts: [{ n: 1, agent: 'orchestrator:T1' }] }
  state.plan.maxAgents = 1
  f.saveState(state)
  const full = f.cli('begin-phase-discussion', 'F1')
  assert.notEqual(full.status, 0)
  assert.match(full.stdout + full.stderr, /1 agents busy \(cap 1\)/)
  state.plan.maxAgents = 3
  f.saveState(state)
  const busy = f.cli('begin-phase-discussion', 'F1')
  assert.notEqual(busy.status, 0)
  assert.match(busy.stdout + busy.stderr, /already busy/)
  assert.deepEqual(f.state(), state)
})

test('planejamento histórico sem listas de workers usa alvos originais sem perder artefatos', t => {
  const f = phaseFixture(t, { run: 'legacy-phase-workers', maxAgents: 4 })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Contrato confirmado', '--confirmed-by-user')
  f.ok('plan-phase', 'F1', '--agent', 'planner')
  const state = f.state(), round = state.phaseWorkflows.F1.planningAttempts.at(-1)
  delete round.activeTargets
  round.workers = {}
  f.saveState(state)
  const output = f.ok('plan-phase', 'F1', '--agent', 'planner').stdout
  assert.match(output, /0 of 4 targets active/)
  assert.match(output, /task-plan-T4.json/)
  f.finishPhasePlanning(['T1', 'T2', 'T3', 'T4'])
  assert.equal(f.phase().state, 'planned')
  for (const task of Object.values(f.state().tasks)) assert.ok(task.taskPlan)
})

test('occupancy aplica default 3 e conta cada papel de tarefa uma vez', () => {
  const state = {
    plan: { maxParallel: 99, maxExecutors: 99 },
    tasks: {
      discussing: { id: 'discussing', state: 'discussing', agent: 'actor-discussion' },
      planning: { id: 'planning', state: 'planning', planner: 'actor-planning' },
      running: { id: 'running', state: 'running', agent: 'actor-running' },
      reviewing: { id: 'reviewing', state: 'reviewing', reviewer: 'actor-review' },
      queued: { id: 'queued', state: 'pending' },
    },
  }

  const result = occupancy(state)

  assert.equal(result.cap, 3, 'o limite novo usa 3 quando o estado legado não o possui')
  assert.equal(result.maxExec, 3, 'a capacidade de execução acompanha o limite compartilhado')
  assert.deepEqual(ids(result.executors), ['running'])
  assert.deepEqual(ids(result.reviewers), ['reviewing'])
  assert.deepEqual(ids(result.planners), ['planning'])
  assert.deepEqual(ids(result.discussers), ['discussing'])
  assert.deepEqual(ids(result.busy), ['discussing', 'planning', 'reviewing', 'running'])
})

test('occupancy inclui workers ativos de fase e exclui targets enfileirados ou encerrados', () => {
  const state = {
    plan: { maxAgents: 6 },
    tasks: {
      phasePlanActive: { id: 'phasePlanActive', state: 'pending' },
      phasePlanEnded: { id: 'phasePlanEnded', state: 'pending' },
      phasePlanQueued: { id: 'phasePlanQueued', state: 'pending' },
      phaseDiscussionActive: { id: 'phaseDiscussionActive', state: 'pending' },
      phaseDiscussionQueued: { id: 'phaseDiscussionQueued', state: 'pending' },
    },
    phaseWorkflows: {
      F1: {
        id: 'F1',
        state: 'planning',
        planningAttempts: [{
          targets: ['phasePlanActive', 'phasePlanEnded', 'phasePlanQueued'],
          activeTargets: ['phasePlanActive'],
          queuedTargets: ['phasePlanQueued'],
          workers: {
            phasePlanActive: { agent: 'planner-1', role: 'planning', startedAt: '2026-10-06T10:00:00.000Z' },
            phasePlanEnded: { agent: 'planner-2', role: 'planning', startedAt: '2026-10-06T09:00:00.000Z', endedAt: '2026-10-06T09:30:00.000Z' },
          },
        }],
        discussionAttempts: [],
      },
      F2: {
        id: 'F2',
        state: 'discussing',
        discussionAttempts: [{
          targets: ['phaseDiscussionActive', 'phaseDiscussionQueued'],
          activeTargets: ['phaseDiscussionActive'],
          queuedTargets: ['phaseDiscussionQueued'],
          workers: {
            phaseDiscussionActive: { agent: 'orchestrator-1', role: 'discussion', startedAt: '2026-10-06T10:01:00.000Z' },
          },
        }],
        planningAttempts: [],
      },
    },
  }

  const result = occupancy(state)

  assert.equal(result.cap, 6)
  assert.deepEqual(ids(result.phasePlanners), ['phasePlanActive'])
  assert.deepEqual(ids(result.discussers), ['phaseDiscussionActive'])
  assert.deepEqual(ids(result.busy), ['phaseDiscussionActive', 'phasePlanActive'])
  assert.equal(result.busy.some(item => item.id === 'phasePlanQueued'), false)
  assert.equal(result.busy.some(item => item.id === 'phasePlanEnded'), false)
  assert.equal(result.busy.some(item => item.id === 'phaseDiscussionQueued'), false)
})

test('init grava maxAgents 3 e migrate preserva limite, histórico e tentativas existentes', t => {
  const f = fixture(t, { tasks: ['T1'], run: 'migration-limit' })
  assert.equal(f.state().plan.maxAgents, 3)

  const changed = f.state()
  delete changed.plan.maxAgents
  changed.tasks.T1.state = 'running'
  changed.tasks.T1.agent = 'executor-legado'
  changed.tasks.T1.attempts = [{ n: 1, agent: 'executor-legado', startedAt: '2026-10-06T10:00:00.000Z' }]
  f.saveState(changed)
  const beforeMigration = f.state()
  const attempts = structuredClone(beforeMigration.tasks.T1.attempts)
  const migrated = beforeMigration
  delete migrated.schemaVersion
  delete migrated.plan.planningMode
  f.saveState(migrated)

  f.ok('migrate', '--run', f.run)
  const after = f.state()
  assert.equal(after.schemaVersion, 1)
  assert.equal(after.plan.maxAgents, 3, 'a migração preenche o limite padrão em estado legado')
  assert.deepEqual(
    (({ previous, maxAgents, actor, previousLimits }) => ({ previous, maxAgents, actor, previousLimits }))(after.agentLimitHistory.at(-1)),
    { previous: null, maxAgents: 3, actor: 'migration', previousLimits: { maxParallel: 4, maxExecutors: 3 } },
  )
  assert.deepEqual(after.tasks.T1.attempts, attempts, 'a migração preserva tentativas já registradas')
  assert.ok(f.events().some(event => event.type === 'schema_migrate'))
})

test('limite ausente não faz consultas ou ações recusadas reescreverem um plano atual', t => {
  const f = fixture(t, { tasks: ['T1'], run: 'metadata-limit' })
  const legacy = f.state()
  delete legacy.plan.maxAgents
  f.saveState(legacy)
  const before = f.state(), events = f.events()
  const graph = JSON.parse(f.ok('graph', '--run', f.run).stdout)
  assert.equal(occupancy(graph).cap, 3)
  f.ok('status', '--run', f.run)
  assert.notEqual(f.cli('start', 'T1', '--run', f.run).status, 0)
  assert.deepEqual(f.state(), before)
  assert.deepEqual(f.events(), events)
  f.ok('migrate', '--run', f.run)
  assert.equal(f.state().plan.maxAgents, 3)
  assert.deepEqual(f.state().tasks, before.tasks)
})

test('set-agent-limit registra histórico e evento sem apagar tentativas', t => {
  const f = fixture(t, { tasks: ['T1'], run: 'mutable-limit' })
  const changed = f.state()
  changed.tasks.T1.state = 'running'
  changed.tasks.T1.agent = 'executor-1'
  changed.tasks.T1.attempts = [{ n: 1, agent: 'executor-1', startedAt: '2026-10-06T10:00:00.000Z' }]
  f.saveState(changed)
  const attempts = structuredClone(changed.tasks.T1.attempts)

  f.ok('set-agent-limit', '--max', '2', '--actor', 'usuario', '--confirmed-by-user', '--run', f.run)
  f.ok('set-agent-limit', '--max', '4', '--actor', 'outro-usuario', '--confirmed-by-user', '--run', f.run)
  const state = f.state()
  const history = state.agentLimitHistory
  const changes = f.events().filter(event => event.type === 'agent_limit_changed')

  assert.equal(state.plan.maxAgents, 4)
  assert.deepEqual(history.map(change => ({ previous: change.previous, maxAgents: change.maxAgents, actor: change.actor })), [
    { previous: 3, maxAgents: 2, actor: 'usuario' },
    { previous: 2, maxAgents: 4, actor: 'outro-usuario' },
  ])
  assert.equal(changes.length, 2)
  assert.deepEqual(changes.map(event => ({ previous: event.previous, maxAgents: event.maxAgents, actor: event.actor })), [
    { previous: 3, maxAgents: 2, actor: 'usuario' },
    { previous: 2, maxAgents: 4, actor: 'outro-usuario' },
  ])
  assert.ok(history.every(change => Number.isFinite(Date.parse(change.at))))
  assert.ok(changes.every(event => Number.isFinite(Date.parse(event.at))))
  assert.deepEqual(state.tasks.T1.attempts, attempts)
})

test('reduzir limite permite concluir tentativas atuais com revisão na mesma vaga e recusa tarefa extra', t => {
  const f = fixture(t, { run: 'handoff-reduced-limit' })
  const legacy = f.state()
  for (const task of Object.values(legacy.tasks)) task.planningRequired = false
  f.saveState(legacy)
  f.ok('authorize', '--scope', 'run', '--confirmed-by-user', '--run', f.run)
  for (const id of ['T1', 'T2', 'T3']) f.ok('start', id, '--agent', `executor-${id}`, '--run', f.run)
  f.ok('set-agent-limit', '--max', '2', '--actor', 'user', '--confirmed-by-user', '--run', f.run)
  f.ok('review', 'T1', '--agent', 'reviewer-T1', '--run', f.run)
  assert.equal(occupancy(f.state()).busy.length, 3)
  assert.equal(f.state().tasks.T1.attempts.length, 1)
  assert.notEqual(f.cli('start', 'T4', '--agent', 'executor-T4', '--run', f.run).status, 0)
  for (const id of ['T1', 'T2']) {
    if (id === 'T2') f.ok('review', id, '--agent', `reviewer-${id}`, '--run', f.run)
    f.ok('validate', id, '--ok', '--evidence', 'Verificação independente do comportamento aprovado', '--cwd', f.project, '--run', f.run)
    f.ok('done', id, '--run', f.run)
  }
  assert.equal(occupancy(f.state()).busy.length, 1)
  f.ok('start', 'T4', '--agent', 'executor-T4', '--run', f.run)
  assert.equal(occupancy(f.state()).busy.length, 2)
})

test('set-agent-limit recusa entradas inválidas ou sem confirmação sem alterar estado e eventos', t => {
  const f = fixture(t, { tasks: ['T1'], run: 'invalid-limit' })
  const invalid = [
    ['--max', '0', '--actor', 'usuario', '--confirmed-by-user'],
    ['--max', '-1', '--actor', 'usuario', '--confirmed-by-user'],
    ['--max', '2.5', '--actor', 'usuario', '--confirmed-by-user'],
    ['--max', 'abc', '--actor', 'usuario', '--confirmed-by-user'],
    ['--max', '2', '--actor', 'usuario'],
    ['--max', '2', '--actor', '   ', '--confirmed-by-user'],
    ['--max', '2', '--confirmed-by-user'],
  ]

  for (const args of invalid) {
    const beforeState = f.stateBytes()
    const beforeEvents = f.eventsBytes()
    const result = f.cli('set-agent-limit', ...args, '--run', f.run)
    assert.notEqual(result.status, 0, args.join(' '))
    assert.deepEqual(f.stateBytes(), beforeState, `estado alterado para ${args.join(' ')}`)
    assert.deepEqual(f.eventsBytes(), beforeEvents, `eventos alterados para ${args.join(' ')}`)
  }
})

function busyState(state, command) {
  Object.assign(state.tasks.T1, {
    state: 'running', agent: 'actor-running',
    attempts: [{ n: 1, agent: 'actor-running', startedAt: '2026-10-06T10:00:00.000Z' }],
  })
  Object.assign(state.tasks.T2, {
    state: 'reviewing', reviewer: 'actor-reviewing',
    attempts: [{ n: 1, agent: 'actor-executor', startedAt: '2026-10-06T10:00:00.000Z' }],
  })
  Object.assign(state.tasks.T3, {
    state: 'planning', planner: 'actor-planning',
    planningAttempts: [{ n: 1, agent: 'actor-planning', startedAt: '2026-10-06T10:00:00.000Z' }],
  })
  if (command === 'start') Object.assign(state.tasks.T4, {
    discussionRequired: false, discoveryRequired: false, planningRequired: false,
  })
  if (command === 'plan-task') Object.assign(state.tasks.T4, {
    discussionRequired: false, discoveryRequired: false,
  })
}

for (const command of ['start', 'plan-task', 'begin-discussion']) {
  test(`${command} recusa o quarto agente quando três atores ocupam papéis diferentes, mesmo com --force`, t => {
    const f = fixture(t, { tasks: ['T1', 'T2', 'T3', 'T4'], run: `cap-${command}` })
    const state = f.state()
    busyState(state, command)
    f.saveState(state)
    const beforeState = f.stateBytes()
    const beforeEvents = f.eventsBytes()
    const args = command === 'start'
      ? [command, 'T4', '--agent', 'actor-four']
      : [command, 'T4', '--agent', 'actor-four']
    const result = f.cli(...args, '--force', '--run', f.run)

    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, /agents busy \(cap 3\)/)
    assert.deepEqual(f.stateBytes(), beforeState, 'a quarta operação não altera o estado')
    assert.deepEqual(f.eventsBytes(), beforeEvents, 'a recusa não cria evento de transição')
  })
}

function workerIds(round) {
  return Object.keys(round.workers ?? {}).sort()
}

function phaseTargetIds(round, field) {
  return [...(round[field] ?? [])].sort()
}

test('planejamento de fase executa ondas, preserva contexto dos quatro alvos e grava planners individuais', t => {
  const f = phaseFixture(t, { run: 'phase-planning-wave' })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Discussão já confirmada pelo usuário', '--confirmed-by-user')
  f.ok('plan-phase', 'F1',
    '--agent', 'T1=p1', '--agent', 'T2=p2', '--agent', 'T3=p3', '--agent', 'T4=p4')

  let current = f.state(), round = f.phase().planningAttempts.at(-1)
  assert.deepEqual(round.targets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.contextTargets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.assignments, { T1: 'p1', T2: 'p2', T3: 'p3', T4: 'p4' })
  assert.deepEqual(workerIds(round), ['T1', 'T2', 'T3'])
  assert.deepEqual(phaseTargetIds(round, 'activeTargets'), ['T1', 'T2', 'T3'])
  assert.deepEqual(round.queuedTargets, ['T4'])
  for (const [id, agent] of Object.entries(round.assignments)) {
    if (!round.workers[id]) continue
    assert.equal(round.workers[id].agent, agent)
    assert.equal(round.workers[id].role, 'planning')
    assert.equal(typeof round.workers[id].startedAt, 'string')
    assert.equal(round.workers[id].endedAt, undefined)
  }

  f.ok('activity-start', 'T1', '--scope', 'task', '--role', 'planning', '--agent', 'p1')
  f.ok('activity-stop', 'T1', '--scope', 'task', '--role', 'planning', '--agent', 'p1')
  f.ok('activity-start', 'F1', '--scope', 'phase', '--role', 'planning', '--agent', 'p2')
  f.ok('activity-stop', 'F1', '--scope', 'phase', '--role', 'planning', '--agent', 'p2')
  current = f.state()
  round = f.phase().planningAttempts.at(-1)
  for (const id of ['T1', 'T2']) {
    const interval = round.workers[id].activityIntervals.at(-1)
    assert.equal(interval.agent, id === 'T1' ? 'p1' : 'p2')
    assert.equal(typeof interval.endedAt, 'string')
  }
  const activityEvents = f.events().filter(event => event.type === 'activity_start')
  assert.deepEqual(activityEvents.slice(-2).map(event => ({ task: event.task, scope: event.scope, agent: event.agent })), [
    { task: 'T1', scope: 'task', agent: 'p1' },
    { task: 'F1', scope: 'phase', agent: 'p2' },
  ])

  const firstStartedAt = Object.fromEntries(Object.entries(round.workers).map(([id, worker]) => [id, worker.startedAt]))
  f.finishPhasePlanning(['T1', 'T2', 'T3'])
  current = f.state()
  round = f.phase().planningAttempts.at(-1)
  const derivedAfterFirstWave = JSON.parse(f.ok('graph').stdout).derived
  assert.equal(f.phase().state, 'planning')
  assert.equal(round.endedAt, undefined)
  assert.deepEqual(round.stagedPlans.map(item => item.task), ['T1', 'T2', 'T3'])
  assert.deepEqual(phaseTargetIds(round, 'activeTargets'), ['T4'])
  assert.deepEqual(round.queuedTargets, [])
  assert.deepEqual(workerIds(round), ['T1', 'T2', 'T3', 'T4'])
  for (const id of ['T1', 'T2', 'T3', 'T4']) assert.equal(current.tasks[id].taskPlan, undefined)
  for (const id of ['T1', 'T2', 'T3']) {
    assert.equal(round.workers[id].endedAt !== undefined, true)
    assert.equal(round.workers[id].startedAt, firstStartedAt[id])
    assert.equal(existsSync(f.planPathFor(id)), true)
    assert.equal(derivedAfterFirstWave[id].effective, 'waiting', `${id} aguarda a conclusão atômica da fase`)
    assert.equal(derivedAfterFirstWave[id].phaseBatchPending, true)
    assert.notEqual(derivedAfterFirstWave[id].effective, 'ready_to_plan')
  }
  assert.equal(existsSync(f.planPathFor('T4')), false)
  assert.equal(round.workers.T4.endedAt, undefined)
  assert.equal(occupancy(current).busy.length, 1, 'a capacidade liberada mantém somente T4 ativo')
  assert.deepEqual(round.targets, ['T1', 'T2', 'T3', 'T4'], 'as metas originais continuam persistidas')
  assert.deepEqual(round.contextTargets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.contextSnapshot.tasks.map(item => item.task).sort(), ['T1', 'T2', 'T3', 'T4'])

  f.finishPhasePlanning(['T4'])
  current = f.state()
  round = f.phase().planningAttempts.at(-1)
  assert.equal(f.phase().state, 'planned')
  assert.equal(round.result, 'planned')
  assert.equal(round.artifactCount, 4)
  assert.deepEqual(round.targets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.contextTargets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(f.phase().planningHistory.at(-1).members, ['T1', 'T2', 'T3', 'T4'])
  for (const [id, agent] of Object.entries(round.assignments)) {
    assert.equal(current.tasks[id].taskPlan.planner, agent)
    assert.equal(current.tasks[id].planner, agent)
    assert.equal(round.workers[id].endedAt !== undefined, true)
  }
  assert.equal(occupancy(current).busy.length, 0)
})

test('bloquear tarefa após planejamento preserva alvos e denominador da rodada concluída', t => {
  const f = phaseFixture(t, { run: 'historical-planning-block', maxAgents: 6 })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Discussão confirmada', '--confirmed-by-user')
  f.ok('plan-phase', 'F1', '--agent', 'T1=p1', '--agent', 'T2=p2', '--agent', 'T3=p3', '--agent', 'T4=p4')
  f.finishPhasePlanning(['T1', 'T2', 'T3', 'T4'])
  const round = f.phase().planningAttempts.at(-1)
  const approvedPlan = f.state().tasks.T1.taskPlan
  f.ok('block', 'T1', '--reason', 'Aguardando reparo do ambiente')
  assert.deepEqual(f.phase().planningAttempts.at(-1), round)
  assert.match(f.ok('status').stdout, /planning round F1.*artifacts 4\/4/)
  assert.match(f.ok('ready').stdout, /planning round F1.*artifacts 4\/4/)
  f.ok('unblock', 'T1')
  f.ok('start', 'T1', '--agent', 'executor-retomada')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
  assert.deepEqual(f.state().tasks.T1.taskPlan, approvedPlan)
  const legacy = f.state()
  const legacyRound = legacy.phaseWorkflows.F1.planningAttempts.at(-1)
  legacyRound.originalTargets = [...legacyRound.targets]
  legacyRound.targets = legacyRound.targets.filter(id => id !== 'T1')
  legacyRound.excludedTargets = [{ task: 'T1', at: new Date(Date.parse(legacyRound.endedAt) + 1).toISOString() }]
  f.saveState(legacy)
  assert.match(f.ok('status').stdout, /planning round F1.*artifacts 4\/4/,
    'histórico gravado pela versão anterior mantém o denominador sem reescrever a rodada')
  delete legacyRound.artifactCount
  f.saveState(legacy)
  assert.match(f.ok('status').stdout, /planning round F1.*artifacts 4\/4/,
    'histórico sem contador usa os artefatos vinculados aos alvos da rodada encerrada')
})

test('bloquear artefato recebido em rodada aberta preserva os planos das outras tarefas', t => {
  const f = phaseFixture(t, { run: 'block-staged-plan' })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Contratos confirmados', '--confirmed-by-user')
  f.ok('plan-phase', 'F1', '--agent', 'T1=p1', '--agent', 'T2=p2', '--agent', 'T3=p3', '--agent', 'T4=p4')
  f.finishPhasePlanning(['T1', 'T2', 'T3'])
  const before = f.phase().planningAttempts.at(-1).stagedPlans.filter(item => item.task !== 'T1')
  f.ok('block', 'T1', '--reason', 'Aguardar entrada externa antes de aceitar o artefato')
  assert.deepEqual(f.phase().planningAttempts.at(-1).stagedPlans, before)
  f.finishPhasePlanning(['T4'])
  assert.equal(f.state().tasks.T1.taskPlan, undefined)
  for (const id of ['T2', 'T3', 'T4']) assert.ok(f.state().tasks[id].taskPlan)
  assert.match(f.ok('status').stdout, /planning round F1.*artifacts 3\/3/)
})

test('bloqueio atualiza caches da discussão aberta sem alterar descobertas de outra rodada', t => {
  for (const matching of [true, false]) {
    const f = phaseFixture(t, { run: `block-discussion-cache-${matching}` })
    f.ok('begin-phase-discussion', 'F1')
    const state = f.state(), phase = state.phaseWorkflows.F1
    const round = phase.discussionAttempts.at(-1)
    round.contextTargets = [...round.targets]
    const discovery = { roundId: matching ? round.roundId : 'rodada-anterior', context: round.context }
    round.discovery = { ...discovery }
    phase.discovery = { ...discovery }
    f.saveState(state)
    f.ok('block', 'T1', '--reason', 'Entrada externa pendente')
    const current = f.phase(), active = current.discussionAttempts.at(-1)
    assert.deepEqual(active.contextTargets, ['T2', 'T3', 'T4'])
    assert.notEqual(active.context, round.context)
    assert.equal(active.discovery.context, matching ? active.context : discovery.context)
    assert.equal(current.discovery.context, matching ? active.context : discovery.context)
  }
})

test('bloqueio externo no meio da onda remove alvo ativo ou enfileirado e dispensa seus artefatos', t => {
  const active = phaseFixture(t, { run: 'phase-block-active' })
  active.ok('skip-phase-discussion', 'F1', '--reason', 'Discussão já confirmada', '--confirmed-by-user')
  active.ok('plan-phase', 'F1',
    '--agent', 'T1=p1', '--agent', 'T2=p2', '--agent', 'T3=p3', '--agent', 'T4=p4')
  active.ok('block', 'T2', '--reason', 'Entrada externa interrompeu T2')
  let current = active.state(), round = active.phase().planningAttempts.at(-1)
  assert.deepEqual(round.originalTargets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.targets, ['T1', 'T3', 'T4'])
  assert.deepEqual(round.activeTargets, ['T1', 'T3'])
  assert.deepEqual(round.queuedTargets, ['T4'])
  assert.equal(round.workers.T2.endedAt !== undefined, true)
  assert.equal(occupancy(current).busy.length, 2, 'a vaga do alvo bloqueado fica disponível')
  active.finishPhasePlanning(['T1', 'T3'])
  current = active.state(); round = active.phase().planningAttempts.at(-1)
  assert.equal(current.tasks.T2.taskPlan, undefined)
  assert.deepEqual(round.activeTargets, ['T4'])
  assert.deepEqual(round.queuedTargets, [])
  active.finishPhasePlanning(['T4'])
  current = active.state()
  assert.equal(current.phaseWorkflows.F1.state, 'planned')
  assert.ok(current.tasks.T1.taskPlan)
  assert.ok(current.tasks.T3.taskPlan)
  assert.ok(current.tasks.T4.taskPlan)
  assert.equal(current.tasks.T2.taskPlan, undefined)
  assert.equal(current.tasks.T2.state, 'blocked')

  const queued = phaseFixture(t, { run: 'phase-block-queued' })
  queued.ok('skip-phase-discussion', 'F1', '--reason', 'Discussão já confirmada', '--confirmed-by-user')
  queued.ok('plan-phase', 'F1',
    '--agent', 'T1=p1', '--agent', 'T2=p2', '--agent', 'T3=p3', '--agent', 'T4=p4')
  queued.ok('block', 'T4', '--reason', 'Entrada externa removeu T4 da fila')
  current = queued.state(); round = queued.phase().planningAttempts.at(-1)
  assert.deepEqual(round.originalTargets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.targets, ['T1', 'T2', 'T3'])
  assert.deepEqual(round.activeTargets, ['T1', 'T2', 'T3'])
  assert.deepEqual(round.queuedTargets, [])
  assert.equal(round.workers.T4, undefined)
  assert.equal(occupancy(current).busy.length, 3)
  queued.finishPhasePlanning(['T1', 'T2', 'T3'])
  current = queued.state()
  assert.equal(current.phaseWorkflows.F1.state, 'planned')
  for (const id of ['T1', 'T2', 'T3']) assert.ok(current.tasks[id].taskPlan)
  assert.equal(current.tasks.T4.taskPlan, undefined)
  assert.equal(current.tasks.T4.state, 'blocked')
})

test('discussão de fase executa ondas com discovery por alvo e o próximo plan-phase respeita o limite', t => {
  const f = phaseFixture(t, { run: 'phase-discussion-wave' })
  f.ok('begin-phase-discussion', 'F1',
    '--agent', 'T1=d1', '--agent', 'T2=d2', '--agent', 'T3=d3', '--agent', 'T4=d4')
  let current = f.state(), round = f.phase().discussionAttempts.at(-1)
  assert.deepEqual(round.targets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.assignments, { T1: 'd1', T2: 'd2', T3: 'd3', T4: 'd4' })
  assert.deepEqual(workerIds(round), ['T1', 'T2', 'T3'])
  assert.deepEqual(round.activeTargets, ['T1', 'T2', 'T3'])
  assert.deepEqual(round.queuedTargets, ['T4'])
  assert.deepEqual(Object.values(round.workers).map(worker => worker.role), ['discussion', 'discussion', 'discussion'])

  f.ok('activity-start', 'T1', '--scope', 'task', '--role', 'discussion', '--agent', 'd1')
  f.ok('activity-stop', 'T1', '--scope', 'task', '--role', 'discussion', '--agent', 'd1')
  f.ok('activity-start', 'F1', '--scope', 'phase', '--role', 'discussion', '--agent', 'd2')
  f.ok('activity-stop', 'F1', '--scope', 'phase', '--role', 'discussion', '--agent', 'd2')
  f.finishPhaseDiscussion(['T1', 'T2', 'T3'])
  current = f.state(); round = f.phase().discussionAttempts.at(-1)
  assert.equal(f.phase().state, 'discussing')
  assert.equal(round.endedAt, undefined)
  assert.equal(round.discoveries.length, 1)
  assert.deepEqual(round.activeTargets, ['T4'])
  assert.deepEqual(round.queuedTargets, [])
  assert.deepEqual(round.targets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.contextSnapshot.tasks.map(item => item.task).sort(), ['T1', 'T2', 'T3', 'T4'])
  assert.equal(occupancy(current).busy.length, 1)

  f.finishPhaseDiscussion(['T4'])
  current = f.state(); round = f.phase().discussionAttempts.at(-1)
  assert.equal(f.phase().state, 'pending')
  assert.equal(round.result, 'discussed')
  assert.equal(round.discoveries, undefined)
  const archived = JSON.parse(readFileSync(join(f.root, '.specs', 'graph', f.run, round.discoveryArtifact), 'utf8'))
  assert.equal(archived.discoveries.length, 2)
  assert.deepEqual(archived.discoveries.flatMap(piece => piece.executionBoundary.deferredToExecutor).sort(), ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.targets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.activeTargets, [])
  assert.deepEqual(Object.keys(round.workers).sort(), ['T1', 'T2', 'T3', 'T4'])
  for (const worker of Object.values(round.workers)) assert.equal(worker.endedAt !== undefined, true)
  assert.deepEqual(current.phaseWorkflows.F1.discovery.executionBoundary.deferredToExecutor.sort(), ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.contextSnapshot.tasks.map(item => item.task).sort(), ['T1', 'T2', 'T3', 'T4'])
  assert.equal(occupancy(current).busy.length, 0)

  f.ok('plan-phase', 'F1',
    '--agent', 'T1=p1', '--agent', 'T2=p2', '--agent', 'T3=p3', '--agent', 'T4=p4')
  current = f.state(); round = f.phase().planningAttempts.at(-1)
  assert.deepEqual(round.targets, ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(round.activeTargets, ['T1', 'T2', 'T3'])
  assert.deepEqual(round.queuedTargets, ['T4'])
  assert.deepEqual(Object.fromEntries(Object.entries(round.workers).map(([id, worker]) => [id, worker.agent])), {
    T1: 'p1', T2: 'p2', T3: 'p3',
  })
  assert.equal(occupancy(current).busy.length, 3)
})

test('rodada de discussão encerrada não ocupa capacidade ao abrir uma nova discussão', t => {
  const f = phaseFixture(t, { run: 'phase-reopen-after-wave' })
  const assignments = ['T1=d1', 'T2=d2', 'T3=d3', 'T4=d4']
  f.ok('begin-phase-discussion', 'F1', ...assignments.flatMap(value => ['--agent', value]))
  const firstRoundId = f.phase().discussionAttempts.at(-1).roundId
  f.finishPhaseDiscussion(['T1', 'T2', 'T3'])
  f.finishPhaseDiscussion(['T4'])
  let current = f.state()
  assert.equal(f.phase().state, 'pending')
  assert.equal(f.phase().discussionAttempts.at(-1).endedAt !== undefined, true)
  assert.equal(occupancy(current).busy.length, 0)

  f.ok('begin-phase-discussion', 'F1', ...assignments.flatMap(value => ['--agent', value]))
  current = f.state()
  const reopened = f.phase().discussionAttempts.at(-1)
  assert.notEqual(reopened.roundId, firstRoundId)
  assert.deepEqual(reopened.activeTargets, ['T1', 'T2', 'T3'])
  assert.deepEqual(reopened.queuedTargets, ['T4'])
  assert.deepEqual(workerIds(reopened), ['T1', 'T2', 'T3'])
  assert.equal(occupancy(current).busy.length, 3)
})

test('reduzir maxAgents abaixo da ocupação mantém agentes atuais e só libera novo despacho após vagas', t => {
  const f = fixture(t, { tasks: ['T1', 'T2', 'T3', 'T4'], run: 'reduced-agent-limit' })
  const state = f.state()
  busyState(state, 'none')
  Object.assign(state.tasks.T4, { state: 'pending', discussionRequired: true, discoveryRequired: true, planningRequired: true })
  f.saveState(state)
  assert.equal(occupancy(f.state()).busy.length, 3)

  f.ok('set-agent-limit', '--max', '2', '--actor', 'usuario', '--confirmed-by-user', '--run', f.run)
  let current = f.state()
  assert.equal(current.plan.maxAgents, 2)
  assert.equal(current.tasks.T1.state, 'running')
  assert.equal(current.tasks.T2.state, 'reviewing')
  assert.equal(current.tasks.T3.state, 'planning')
  assert.equal(occupancy(current).busy.length, 3)
  const beforeRefusal = f.stateBytes()
  const refused = f.cli('begin-discussion', 'T4', '--agent', 'actor-four', '--force', '--run', f.run)
  assert.notEqual(refused.status, 0)
  assert.deepEqual(f.stateBytes(), beforeRefusal)
  assert.match(refused.stdout + refused.stderr, /agents busy \(cap 2\)/)

  f.ok('skip', 'T1', '--reason', 'Execução atual concluída antes de admitir outro agente', '--run', f.run)
  current = f.state()
  assert.equal(occupancy(current).busy.length, 2)
  const refusedAfterFirst = f.cli('begin-discussion', 'T4', '--agent', 'actor-four', '--force', '--run', f.run)
  assert.notEqual(refusedAfterFirst.status, 0)
  assert.match(refusedAfterFirst.stdout + refusedAfterFirst.stderr, /agents busy \(cap 2\)/)

  f.ok('skip', 'T2', '--reason', 'Revisão atual concluída antes de admitir outro agente', '--run', f.run)
  current = f.state()
  assert.equal(occupancy(current).busy.length, 1)
  f.ok('begin-discussion', 'T4', '--agent', 'actor-four', '--force', '--run', f.run)
  assert.equal(f.state().tasks.T4.state, 'discussing')
  assert.equal(occupancy(f.state()).busy.length, 2)
})

test('preferência pessoal passa a novas execuções sem substituir limite explícito do plano', t => {
  const f = fixture(t)
  assert.equal(f.state().plan.maxAgents, 3)
  f.ok('set-agent-limit', '--max', '6', '--actor', 'usuario', '--confirmed-by-user', '--default')
  f.ok('init', '--plan', f.planPath, '--run', 'future')
  const future = JSON.parse(readFileSync(join(f.root, '.specs/graph/future/state.json'), 'utf8'))
  assert.equal(future.plan.maxAgents, 6)
  const plan = JSON.parse(readFileSync(f.planPath, 'utf8'))
  plan.maxAgents = 2
  writeFileSync(f.planPath, JSON.stringify(plan))
  f.ok('init', '--plan', f.planPath, '--run', 'explicit')
  assert.equal(JSON.parse(readFileSync(join(f.root, '.specs/graph/explicit/state.json'), 'utf8')).plan.maxAgents, 2)
})

test('alterar capacidade preserva identificadores e histórico de execução legada', t => {
  const f = fixture(t, { tasks: ['T1'], run: 'legacy-capacity-only' })
  const state = f.state()
  state.schemaVersion = 0
  delete state.plan.planningMode
  state.tasks.legacy = { ...state.tasks.T1, id: 'legacy', state: 'done', attempts: [{ n: 1, agent: 'executor', endedAt: '2026-01-01T00:00:00Z' }] }
  delete state.tasks.T1
  f.saveState(state)
  const before = structuredClone(state.tasks)
  f.ok('set-agent-limit', '--max', '6', '--actor', 'usuario', '--confirmed-by-user')
  const saved = f.state()
  assert.equal(saved.plan.maxAgents, 6)
  assert.equal(saved.schemaVersion, 0)
  assert.equal(saved.plan.planningMode, undefined)
  assert.deepEqual(saved.tasks, before)
  assert.equal(f.events().at(-1).type, 'agent_limit_changed')
})
