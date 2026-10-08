import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { planningContext, phasePlanningContext, discoveryDigest } from '../scripts/validation.mjs'

const engine = fileURLToPath(new URL('../scripts/engine.mjs', import.meta.url))
const planTask = (id, fields = {}) => ({ id, title: `Contrato ${id}`, deps: [], validationMode: 'inspection',
  inspectionReason: 'Conferir o contrato sem executar mudanças', validation: 'Inspecionar', ...fields })
function fixture(t, mode = 'task') {
  const base = realpathSync(tmpdir()), home = mkdtempSync(join(base, 'prumo-sync-final-'))
  const root = join(home, 'central', 'project'), graph = join(root, '.specs', 'graph'), run = join(graph, 'sync')
  mkdirSync(root, { recursive: true })
  const source = join(home, 'approved.plan.json'), path = join(run, 'state.json'), events = join(run, 'events.ndjson')
  const plan = { name: 'Sync', description: '', planningMode: mode, phases: mode === 'phase' ? [{ id: 'F1', title: 'Contrato' }] : [],
    tasks: ['T1', 'T2'].map(id => planTask(id, mode === 'phase' ? { phase: 'F1' } : {})) }
  const writePlan = value => writeFileSync(source, JSON.stringify(value))
  writePlan(plan)
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [engine, ...args], { cwd: home, windowsHide: true, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: dirname(root), PRUMO_ROOT: root, GRAPH_ROOT: root,
        GRAPH_FOREMAN_HOME: join(home, 'legacy'), PRUMO_LANG: 'en' } })
    assert.ifError(result.error)
    return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }
  const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.output); return result }
  const state = () => JSON.parse(readFileSync(path, 'utf8'))
  const save = value => writeFileSync(path, JSON.stringify(value, null, 1))
  const bytes = () => [path, events, join(graph, 'CURRENT')].map(file => existsSync(file) ? readFileSync(file, 'utf8') : null)
  const rejects = (pattern, ...args) => {
    const before = bytes(), result = cli(...args)
    assert.equal(result.status, 1, result.output); assert.match(result.output, pattern)
    assert.deepEqual(bytes(), before, 'a recusa preserva estado, eventos e seleção byte a byte')
    return result
  }
  ok('init', '--plan', source, '--run', 'sync')
  const initial = state(); initial.unknown = { keep: 'preservado' }; initial.tasks.T1.unknown = { keep: true }; save(initial)
  t.after(() => { assert.equal(dirname(home), base); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { home, graph, run, path, source, events, plan, cli, ok, state, save, bytes, rejects, writePlan }
}
const phaseContext = (s, ids = ['T1', 'T2']) => JSON.stringify([s.plan.name, s.plan.description, s.plan.planningRevision ?? 0,
  'F1', ids.map(id => [id, phasePlanningContext(s, s.tasks[id])]).sort()])

test('fonte explícita permite sincronizar nome humano legado sem caminho armazenado e conserva os dados', t => {
  for (const name of ['Plano do checkout', 'Revisão do contrato']) {
    const f = fixture(t), s = f.state()
    s.plan.name = name; delete s.plan.source; f.save(s)
    f.plan.name = name; f.writePlan(f.plan)
    f.rejects(/invalid plan/, 'sync-plan')
    const before = f.bytes()
    f.ok('sync-plan', '--plan', f.source)
    const current = f.state()
    assert.equal(current.plan.source, f.source)
    assert.equal(current.plan.name, name)
    assert.deepEqual(current.unknown, s.unknown)
    assert.deepEqual(current.tasks.T1.unknown, s.tasks.T1.unknown)
    assert.equal(current.tasks.T1.state, s.tasks.T1.state)
    assert.equal(f.bytes()[2], before[2])
    f.writePlan({ ...f.plan, tasks: [] })
    f.rejects(/tasks|removed/, 'sync-plan', '--plan', f.source)
  }
})
function taskPlanning(f) {
  const s = f.state(); s.tasks.T1.discussionRequired = false; s.tasks.T1.discoveryRequired = false; f.save(s)
  f.ok('plan-task', 'T1', '--agent', 'planner')
  return f.state()
}

test('sync localiza fonte central legada e recusa fonte ausente ou remoção de tarefa sem alterar dados', t => {
  for (const stored of [true, false]) {
    const f = fixture(t), s = f.state(), central = join(f.graph, 'plans')
    mkdirSync(central)
    const fallback = join(central, stored ? basename(f.source) : 'Sync.plan.json')
    writeFileSync(fallback, JSON.stringify(f.plan)); rmSync(f.source)
    if (!stored) delete s.plan.source
    f.save(s)
    const before = f.bytes()[0]
    f.ok('sync-plan')
    assert.equal(f.state().plan.source, fallback)
    assert.equal(readFileSync(join(f.run, 'state.pre-sync.json'), 'utf8'), before)
    assert.deepEqual(f.state().unknown, { keep: 'preservado' })
    rmSync(fallback)
    f.rejects(/sync-plan needs --plan/, 'sync-plan')
    f.writePlan({ ...f.plan, tasks: [f.plan.tasks[0]] })
    f.rejects(/sync-plan is additive: plan removed T2/, 'sync-plan', '--plan', f.source)
  }
})

test('metadados e contrato terminal mantêm rodada corrente; alteração ativa limita histórico a vinte contratos', t => {
  const f = fixture(t), initial = f.state()
  initial.tasks.T2.state = 'done'; initial.plan.planningRevision = 2
  initial.tasks.T2.planningAttempts = [{ n: 1, agent: 'historical', context: planningContext(initial, initial.tasks.T2) }]
  initial.tasks.T1.contractHistory = Array.from({ length: 21 }, (_, index) => ({ at: `histórico ${index}`, fields: [], unknown: index }))
  f.save(initial)
  const planned = taskPlanning(f), originalRound = structuredClone(planned.tasks.T1.planningAttempts[0])
  f.plan.tasks[0].summary = 'Descrição visível'; f.plan.tasks[1].title = 'Contrato terminal proposto'
  f.writePlan(f.plan); f.ok('sync-plan')
  assert.deepEqual(f.state().tasks.T1.planningAttempts[0], originalRound)
  assert.equal(f.state().tasks.T1.contractConfirmationRequired, undefined)
  assert.equal(f.state().tasks.T2.title, 'Contrato T2')
  assert.equal(f.state().plan.planningRevision, 2)
  f.plan.tasks[0].title = 'Contrato ativo alterado'; f.plan.description = 'Decisão alterada'; f.writePlan(f.plan)
  const before = f.bytes()[0]; f.ok('sync-plan')
  const current = f.state()
  assert.equal(current.tasks.T1.contractHistory.length, 20)
  assert.equal(current.tasks.T1.contractHistory[0].unknown, 2)
  assert.ok(current.tasks.T1.contractConfirmationRequired)
  assert.equal(current.tasks.T2.contractHistory, undefined)
  assert.equal(current.tasks.T2.contractConfirmationRequired, undefined)
  assert.deepEqual(current.tasks.T2.planningAttempts, initial.tasks.T2.planningAttempts)
  assert.equal(readFileSync(join(f.run, 'state.pre-sync.json'), 'utf8'), before)
  assert.deepEqual(current.tasks.T1.unknown, { keep: true })
})

test('snapshots representam dependências legadas ausentes sem perder campos históricos', t => {
  for (const mode of ['task', 'phase']) {
    const f = fixture(t, mode), s = f.state()
    s.tasks.T1.deps = ['T2']; s.tasks.T2.state = 'done'; s.tasks.T2.deps = ['missing']
    delete s.plan.description
    for (const field of ['validation', 'tags', 'touches']) delete s.tasks.T2[field]
    if (mode === 'task') { s.tasks.T1.discussionRequired = false; s.tasks.T1.discoveryRequired = false }
    f.save(s)
    const before = structuredClone(s.tasks.T2)
    f.ok(...(mode === 'task' ? ['plan-task', 'T1', '--agent', 'planner'] : ['begin-phase-discussion', 'F1']))
    const current = f.state(), round = mode === 'task' ? current.tasks.T1.planningAttempts.at(-1) : current.phaseWorkflows.F1.discussionAttempts.at(-1)
    const missing = round.contextSnapshot.tasks.find(item => item.task === 'missing')
    assert.ok(missing?.contextDigest)
    assert.equal(missing.contextDigest, missing.inputDigest)
    assert.equal(missing.contextDigest, missing.outputDigest)
    for (const item of round.contextSnapshot.tasks)
      for (const key of ['contextDigest', 'inputDigest', 'outputDigest']) assert.equal(typeof item[key], 'string')
    assert.deepEqual(current.tasks.T2, before)
    assert.deepEqual(current.unknown, { keep: 'preservado' })
  }
})

test('rodada de tarefa legada sem identificação é substituída e evento ausente não bloqueia recuperação', t => {
  for (const round of [{ context: 'obsoleto', contextSnapshot: { plan: {} } }, {},
    { context: 'obsoleto', startedAt: '2026-01-01', contextSnapshot: { plan: {}, tasks: [{ task: 'T1' }] } }]) {
    const f = fixture(t), s = f.state()
    s.tasks.T1.state = 'planning'; s.tasks.T1.planner = 'planner'
    s.tasks.T1.discussionRequired = false; s.tasks.T1.discoveryRequired = false
    s.tasks.T1.planningAttempts = [{ agent: 'planner', ...round }]
    f.save(s); rmSync(f.events)
    const recovered = f.ok('plan-task', 'T1', '--agent', 'planner')
    assert.match(recovered.output, /previous planning round \? of T1 closed as superseded/)
    const current = f.state()
    assert.equal(current.tasks.T1.planningAttempts[0].result, 'superseded')
    assert.equal(current.tasks.T1.planningAttempts.length, 2)
    assert.deepEqual(current.unknown, { keep: 'preservado' })
  }
})

test('auditoria incompleta informa mudanças reais de dependência e mantém eventos antigos como prefixo', t => {
  const f = fixture(t), s = taskPlanning(f), owner = s.tasks.T1
  owner.planningAttempts[0].startedAt = '2026-01-01'
  owner.planningAttempts[0].contextSnapshot = { plan: { name: s.plan.name, description: s.plan.description, planningRevision: 0 }, tasks: [{ task: 'T1' }] }
  f.save(s)
  const events = [
    { type: 'plan_sync', at: '2026-01-02' },
    { type: 'plan_sync', at: '2026-01-02', changes: [{}, { task: 'T1' }, { task: 'T1', fields: [{}] }, { task: 'T1', fields: [{ field: 'title' }] }] },
    { type: 'plan_sync_audit', at: '2026-01-03' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n'
  writeFileSync(f.events, events)
  f.plan.tasks[0].deps = ['T2']; const dep = f.state(); dep.tasks.T2.state = 'done'; f.save(dep)
  f.writePlan(f.plan); const output = f.ok('sync-plan').output
  const current = f.state()
  assert.ok(current.tasks.T1.contractConfirmationRequired)
  assert.match(current.tasks.T1.contractConfirmationRequired.invalidated[0].cause, /missing/)
  assert.match(current.tasks.T1.contractConfirmationRequired.invalidated[0].cause, /last plan_sync_audit: 2026-01-03/)
  assert.ok(readFileSync(f.events, 'utf8').startsWith(events))
  assert.match(output, /synced/)
})

test('fase retirada conserva seu histórico e rodada antiga sem alvos exige nova discussão', t => {
  const f = fixture(t, 'phase'), s = f.state(), phase = s.phaseWorkflows.F1
  phase.state = 'planning'; phase.planner = 'planner'
  phase.planningAttempts = [{ n: 1, agent: 'planner', context: 'antigo' }]
  phase.discussionAttempts = [{ roundId: 'antiga', context: 'antigo' }]
  s.plan.phases.push({ id: 'F2', title: 'Fase histórica sem tarefas' })
  s.phaseWorkflows.F2 = { id: 'F2', state: 'planning', planner: 'historical', discussionAttempts: [], planningHistory: [],
    planningAttempts: [{ n: 1, agent: 'historical', context: 'legado' }] }
  f.plan.phases.push({ id: 'F2', title: 'Fase histórica sem tarefas' })
  f.save(s)
  f.plan.tasks.forEach(task => { task.title += ' alterado' }); f.writePlan(f.plan)
  f.ok('sync-plan')
  assert.ok(f.state().phaseWorkflows.F1.contractConfirmationRequired)
  assert.deepEqual(f.state().phaseWorkflows.F1.planningAttempts, phase.planningAttempts)
  const repaired = f.state(); repaired.tasks.T1.state = 'done'; repaired.tasks.T2.state = 'done'; f.save(repaired)
  f.plan.phases = [{ id: 'F1', title: 'Contrato' }]; f.writePlan(f.plan)
  f.ok('sync-plan')
  assert.ok(f.state().phaseWorkflows.F1)
  assert.deepEqual(f.state().phaseWorkflows.F1.discussionAttempts, phase.discussionAttempts)
  assert.deepEqual(f.state().phaseWorkflows.F2.planningAttempts, s.phaseWorkflows.F2.planningAttempts)
  assert.equal(f.state().phaseWorkflows.F2.contractConfirmationRequired, undefined)
})

test('decisão de fase sem alvos é recusada antes de gravar e planejamento sem tentativa permanece consultável', t => {
  const f = fixture(t, 'phase'), s = f.state()
  s.phaseWorkflows.F1.discussionSkips = [{ decision: 'skipped', confirmedByUser: true }]
  f.save(s)
  f.rejects(/targets|undefined|length/, 'graph')
  s.phaseWorkflows.F1.discussionSkips = []; s.phaseWorkflows.F1.state = 'planning'; f.save(s)
  const before = f.bytes(); const graph = JSON.parse(f.ok('graph').stdout)
  assert.equal(graph.derived.T1.effective, 'ready_for_discussion')
  assert.deepEqual(f.bytes(), before)
})

test('decisão confirmada mais recente prevalece sobre discussão concluída na tarefa e na fase', t => {
  for (const mode of ['task', 'phase']) {
    const f = fixture(t, mode), s = f.state(), owner = mode === 'phase' ? s.phaseWorkflows.F1 : s.tasks.T1
    const context = mode === 'phase' ? phaseContext(s) : planningContext(s, owner)
    owner.discovery = { roundId: 'discussed', nonce: 'nonce', context, closure: 'Contrato confirmado' }
    owner.discovery.digest = discoveryDigest(owner.discovery)
    owner.discussionAttempts = [{ result: 'discussed', roundId: 'discussed', nonce: 'nonce', context,
      discoveryDigest: owner.discovery.digest, attempt: 1, targets: ['T1', 'T2'], endedAt: '2026-01-01' }]
    if (mode === 'task') delete owner.discussionAttempts[0].endedAt
    owner.discussionSkips = [{ decision: 'skipped', confirmedByUser: true, decisionId: 'newest', digest: 'latest',
      at: '2026-01-02', context, scope: mode === 'task' ? phasePlanningContext(s, owner) : undefined, targets: ['T1', 'T2'] }]
    f.save(s)
    f.ok(...(mode === 'task' ? ['plan-task', 'T1', '--agent', 'planner'] : ['plan-phase', 'F1', '--agent', 'planner']))
    const planned = f.state(), round = mode === 'phase' ? planned.phaseWorkflows.F1.planningAttempts.at(-1) : planned.tasks.T1.planningAttempts.at(-1)
    assert.equal(mode === 'phase' ? round.discussionRoundId : round.discoveryDigest, mode === 'phase' ? 'newest' : 'latest')
    const persisted = (mode === 'phase' ? planned.phaseWorkflows.F1 : planned.tasks.T1).discussionAttempts
    if (mode === 'phase') {
      const { discoveryArtifact, ...metadata } = persisted[0]
      assert.deepEqual([metadata], owner.discussionAttempts)
      const archived = JSON.parse(readFileSync(join(f.run, discoveryArtifact), 'utf8'))
      assert.deepEqual(archived.discovery, owner.discovery)
    } else assert.deepEqual(persisted, owner.discussionAttempts)
    if (mode === 'phase') {
      delete planned.phaseWorkflows.F1.planningAttempts.at(-1).requiredInputs; f.save(planned)
      const before = f.bytes(), output = f.ok('plan-phase', 'F1', '--agent', 'planner').output
      assert.match(output, /"unresolvedInputs": \[\]/)
      assert.deepEqual(f.bytes(), before)
    }
  }
})

test('dependência histórica sem lista de dependências é recusada antes de abrir rodada ou gravar snapshot', t => {
  for (const mode of ['task', 'phase']) {
    const f = fixture(t, mode), s = f.state()
    s.tasks.T1.deps = ['T2']; s.tasks.T2.state = 'done'; delete s.tasks.T2.deps
    if (mode === 'task') { s.tasks.T1.discussionRequired = false; s.tasks.T1.discoveryRequired = false }
    f.save(s)
    f.rejects(/forEach|undefined/, ...(mode === 'task' ? ['plan-task', 'T1', '--agent', 'planner'] : ['begin-phase-discussion', 'F1']))
  }
})

test('valor não padronizado de fase não é apagado e objeto nulo conserva os dados após recusa', t => {
  for (const marker of [false, null]) {
    const f = fixture(t), s = f.state()
    s.phaseWorkflows = { legacy: marker }; f.save(s)
    f.plan.tasks[0].title = 'Contrato ativo atualizado'; f.writePlan(f.plan)
    if (marker === null) f.rejects(/Cannot read properties|state/, 'sync-plan')
    else f.ok('sync-plan')
    assert.equal(f.state().phaseWorkflows.legacy, marker)
    assert.deepEqual(f.state().unknown, { keep: 'preservado' })
  }
})

test('fase ausente de contrato terminal e decisões concluídas sem alvos não autorizam sincronização implícita', t => {
  const f = fixture(t, 'phase'), original = f.state()
  const missingPhase = structuredClone(original)
  missingPhase.tasks.T2.state = 'done'; missingPhase.tasks.T2.phase = null; f.save(missingPhase)
  f.plan.tasks[0].title = 'Contrato ativo alterado'; f.writePlan(f.plan)
  f.rejects(/task T2 needs a declared phase/, 'sync-plan')
  for (const field of ['discussionAttempts', 'discussionSkips', 'planningSkips']) {
    const state = structuredClone(original), phase = state.phaseWorkflows.F1
    phase[field] = [field === 'discussionAttempts' ? { result: 'discussed', roundId: 'legacy' }
      : { decision: 'skipped', confirmedByUser: true, decisionId: 'legacy' }]
    f.save(state)
    f.rejects(/undefined|length/, 'sync-plan')
  }
})

test('fonte com modo divergente não pode dispensar a fase obrigatória do estado preservado', t => {
  const observed = []
  for (const incomingMode of ['phase', 'task']) {
    const f = fixture(t, 'phase'), state = f.state()
    state.tasks.T2.state = 'done'; state.tasks.T2.phase = null; f.save(state)
    f.plan.planningMode = incomingMode
    f.plan.tasks[0].title = 'Contrato ativo alterado'; f.writePlan(f.plan)
    const before = f.bytes(), response = f.cli('sync-plan'), after = f.bytes(), current = f.state()
    observed.push({ incomingMode, status: response.status, preservedMode: current.plan.planningMode,
      terminalPhase: current.tasks.T2.phase, stateChanged: before[0] !== after[0], eventsChanged: before[1] !== after[1],
      currentChanged: before[2] !== after[2], output: response.output })
    if (response.status !== 0) assert.deepEqual(after, before)
  }
  assert.deepEqual(observed.map(item => item.status), [1, 1], JSON.stringify(observed, null, 2))
})

test('dispensa legada sem contexto completo é invalidada pelo contrato novo, sem apagar sua decisão histórica', t => {
  const f = fixture(t), s = f.state()
  const decision = { decision: 'skipped', confirmedByUser: true, decisionId: 'legacy', scope: phasePlanningContext(s, s.tasks.T1) }
  s.tasks.T1.planningSkips = [decision]; f.save(s)
  f.plan.tasks[0].title = 'Contrato atualizado'; f.writePlan(f.plan)
  f.ok('sync-plan')
  const current = f.state()
  assert.deepEqual(current.tasks.T1.planningSkips, [decision])
  assert.ok(current.tasks.T1.contractConfirmationRequired)
  assert.equal(current.tasks.T1.contractConfirmationRequired.invalidated[0].workflow, 'planning skip')
})
