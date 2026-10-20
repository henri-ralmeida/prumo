import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { contractDrift } from '../scripts/contract-drift.mjs'
import { hasCurrentTaskPlan, hasCurrentTaskScope, executionInputReceipt } from '../scripts/validation.mjs'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/engine.mjs')
const mapping = 'T1=T3,T2=T4,T3=T1,T4=T2'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-renumber-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'workspace'), project = join(home, 'project'), plans = join(root, 'plans')
  mkdirSync(root); mkdirSync(project); mkdirSync(plans)
  writeFileSync(join(project, 'check.cjs'), "require('node:assert/strict').equal(1, 1)\n")
  const planPath = join(root, 'plan.json')
  const validation = [{ kind: 'functional', run: 'node check.cjs', expect: 'A entrega mantém o comportamento aprovado' }]
  writeFileSync(planPath, JSON.stringify({ name: 'Renumeração sem alterar entregas', planningMode: 'phase', maxAgents: 4,
    phases: [{ id: 'F1', title: 'Verificar qualidade' }, { id: 'F2', title: 'Publicar' }], tasks: [
      { id: 'T1', title: 'Publicar artefatos', phase: 'F2', validation },
      { id: 'T2', title: 'Conferir publicação', phase: 'F2', validation },
      { id: 'T3', title: 'Corrigir qualidade', phase: 'F1', validation },
      { id: 'T4', title: 'Conferir qualidade', phase: 'F1', deps: ['T3'], validation },
    ] }))
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: 'en' }
  const cliWithEnv = (overrides, ...args) => spawnSync(process.execPath, [engine, ...args], { cwd: project, env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true })
  const cli = (...args) => cliWithEnv({}, ...args)
  const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.stdout + result.stderr); return result }
  const rejects = (pattern, ...args) => { const result = cli(...args); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, pattern); return result }
  ok('init', '--plan', planPath, '--run', 'renumber')
  ok('authorize', '--scope', 'run', '--confirmed-by-user')
  const runDir = join(root, '.specs', 'graph', 'renumber'), statePath = join(runDir, 'state.json')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const save = value => writeFileSync(statePath, JSON.stringify(value))
  const snapshot = () => [readFileSync(statePath, 'utf8'), readFileSync(join(runDir, state().eventLog ?? 'events.ndjson'), 'utf8')]
  const planPhase = () => {
    ok('begin-phase-discussion', 'F1')
    const round = state().phaseWorkflows.F1.discussionAttempts.at(-1)
    const discovery = { research: [{ source: 'Contrato aprovado', findings: 'Critérios da qualidade conferidos' }],
      questions: [{ question: 'Preservar os critérios aprovados?', answer: 'Sim.', channel: 'chat-fallback', round: 1,
        roundId: round.roundId, ...(round.confirmsContract ? { confirmsContract: round.confirmsContract } : {}) }],
      coverage: { problem: 'Qualidade precisa de verificação', affected: 'Usuários', outcome: 'Entrega aprovada',
        currentBehavior: 'Conferido', desiredBehavior: 'Critérios atendidos', rules: 'Revisão independente', exceptions: 'Nenhuma',
        scope: 'Qualidade', acceptance: 'A entrega mantém o comportamento aprovado' }, decisions: [], deferred: [],
      executionBoundary: { deferredToExecutor: round.targets, prematureTaskWork: [] }, closure: 'Sem dúvida pendente',
      roundId: round.roundId, nonce: round.nonce }
    const discoveryPath = join(root, 'discovery.json'); writeFileSync(discoveryPath, JSON.stringify(discovery))
    ok('finish-phase-discussion', 'F1', '--context', discoveryPath)
    ok('plan-phase', 'F1', '--agent', 'planner')
    const planning = state().phaseWorkflows.F1.planningAttempts.at(-1)
    for (const id of planning.targets) writeFileSync(join(plans, `task-plan-${id}.json`), JSON.stringify({
      research: [{ source: 'Contrato aprovado', findings: 'Critérios conferidos' }], decisions: [],
      steps: ['Preservar o comportamento aprovado e executar sua verificação'],
      verification: [{ criterion: 'A entrega mantém o comportamento aprovado', check: 1 }], openQuestions: [],
      phaseBinding: { phaseId: 'F1', discussionRoundId: planning.discussionRoundId, plannerRound: planning.n },
      unresolvedInputs: planning.requiredInputs[id],
    }))
    ok('finish-phase-planning', 'F1', '--plan-dir', plans)
  }
  return { root, project, runDir, planPath, ok, rejects, state, save, snapshot, planPhase, cliWithEnv }
}

test('renumerar tarefas troca ciclos preservando três tentativas, revisão independente e plano dependente executável', t => {
  const f = fixture(t)
  f.planPhase()
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.ok('start', 'T3', '--agent', `executor-${attempt}`)
    f.ok('review', 'T3', '--agent', `reviewer-${attempt}`)
    f.ok('validate', 'T3', attempt < 3 ? '--failed' : '--ok', '--evidence', `Critérios conferidos na tentativa ${attempt}`, '--cwd', f.project)
    if (attempt < 3) {
      f.ok('fail', 'T3', '--reason', 'A correção ainda precisa atender ao critério aprovado')
      f.ok('retry', 'T3')
    } else f.ok('done', 'T3')
  }
  const before = f.state(), filesBefore = f.snapshot(), originalPlan = readFileSync(f.planPath, 'utf8')
  assert.equal(before.tasks.T3.state, 'done')
  assert.equal(before.tasks.T3.attempts.length, 3)
  assert.deepEqual(before.tasks.T4.taskPlan.unresolvedInputs.map(input => input.task), ['T3'])
  assert.ok(hasCurrentTaskPlan(before, before.tasks.T4))
  assert.ok(hasCurrentTaskScope(before, before.tasks.T4, 1))
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.T4.effective, 'ready')
  const preview = f.ok('renumber-tasks', '--map', mapping, '--dry-run')
  assert.match(preview.stdout, /T1/)
  assert.deepEqual(f.snapshot(), filesBefore)
  f.rejects(/confirmed-by-user/, 'renumber-tasks', '--map', mapping)
  assert.deepEqual(f.snapshot(), filesBefore)
  f.ok('renumber-tasks', '--map', mapping, '--confirmed-by-user')
  const after = f.state()
  assert.deepEqual(Object.values(after.tasks).filter(task => task.phase === 'F1').map(task => task.id).sort(), ['T1', 'T2'])
  assert.deepEqual(Object.values(after.tasks).filter(task => task.phase === 'F2').map(task => task.id).sort(), ['T3', 'T4'])
  assert.equal(after.tasks.T1.title, before.tasks.T3.title)
  assert.equal(after.tasks.T1.state, 'done')
  assert.equal(after.tasks.T1.previousTaskId, 'T3')
  assert.match(f.ok('status').stdout, /T3 → T1/)
  assert.deepEqual(after.tasks.T1.attempts.map(attempt => [attempt.n, attempt.agent, attempt.result, attempt.startedAt, attempt.endedAt]),
    before.tasks.T3.attempts.map(attempt => [attempt.n, attempt.agent, attempt.result, attempt.startedAt, attempt.endedAt]))
  assert.deepEqual(after.tasks.T1.validations.map(receipt => [receipt.ok, receipt.token, receipt.attempt, receipt.agent]),
    before.tasks.T3.validations.map(receipt => [receipt.ok, receipt.token, receipt.attempt, receipt.agent]))
  assert.deepEqual(after.tasks.T2.deps, ['T1'])
  assert.deepEqual(after.tasks.T2.taskPlan.unresolvedInputs.map(input => input.task), ['T1'])
  assert.deepEqual(after.phaseWorkflows.F1.planningAttempts.at(-1).targets, ['T1', 'T2'])
  assert.deepEqual(after.phaseWorkflows.F1.discovery.executionBoundary.deferredToExecutor, ['T1', 'T2'])
  assert.equal(after.phaseWorkflows.F1.state, before.phaseWorkflows.F1.state)
  assert.equal(after.phaseWorkflows.F1.discussionAttempts.length, before.phaseWorkflows.F1.discussionAttempts.length)
  assert.equal(after.phaseWorkflows.F1.planningAttempts.length, before.phaseWorkflows.F1.planningAttempts.length)
  assert.deepEqual(after.tasks.T2.executionAuthorization, before.tasks.T4.executionAuthorization)
  assert.ok(hasCurrentTaskPlan(after, after.tasks.T2))
  assert.ok(hasCurrentTaskScope(after, after.tasks.T2, 1))
  assert.equal(executionInputReceipt(after, after.tasks.T2).inputs[0].task, 'T1')
  assert.equal(JSON.parse(f.ok('graph').stdout).derived.T2.effective, 'ready')
  assert.deepEqual(contractDrift(after, { plan: JSON.parse(readFileSync(after.plan.source, 'utf8')) }), { available: true, planFields: [], tasks: [] })
  assert.equal(readFileSync(f.planPath, 'utf8'), originalPlan)
  const backup = after.taskIdMigrations.at(-1).backup
  assert.equal(readFileSync(join(backup, 'state.json'), 'utf8'), filesBefore[0])
  assert.equal(readFileSync(join(backup, 'original-events.ndjson'), 'utf8'), filesBefore[1])
  assert.equal(readFileSync(join(backup, 'original-plan.json'), 'utf8'), originalPlan)
  assert.deepEqual(JSON.parse(readFileSync(join(backup, 'mapping.json'), 'utf8')), { T1: 'T3', T2: 'T4', T3: 'T1', T4: 'T2' })
  assert.equal(readFileSync(join(f.runDir, 'events.ndjson'), 'utf8'), filesBefore[1])
  assert.equal(JSON.parse(f.snapshot()[1].trim().split('\n').at(-1)).type, 'task_renumbered')
  assert.equal(readdirSync(join(f.runDir, 'task-id-backups')).length, 1)
  f.ok('start', 'T2', '--agent', 'executor-dependente')
  assert.equal(f.state().tasks.T2.state, 'running')
  assert.equal(f.state().tasks.T2.attempts[0].inputReceipt[0].task, 'T1')
  f.ok('review', 'T2', '--agent', 'revisor-dependente')
  f.ok('validate', 'T2', '--ok', '--evidence', 'Recibo da dependência e comportamento aprovados após renumerar', '--cwd', f.project)
  f.ok('done', 'T2')
  const completed = f.state(), firstLog = f.snapshot()[1]
  f.ok('renumber-tasks', '--map', mapping, '--confirmed-by-user')
  const restored = f.state(), restoredEvents = f.snapshot()[1].trim().split('\n').map(line => JSON.parse(line))
  assert.equal(restored.taskIdMigrations.length, 2)
  assert.equal(restored.tasks.T3.state, 'done')
  assert.equal(restored.tasks.T3.attempts.length, 3)
  assert.equal(restored.tasks.T4.state, 'done')
  assert.deepEqual(restored.tasks.T3.attempts.map(attempt => [attempt.agent, attempt.startedAt, attempt.endedAt]),
    completed.tasks.T1.attempts.map(attempt => [attempt.agent, attempt.startedAt, attempt.endedAt]))
  assert.deepEqual(restored.tasks.T4.validations.map(receipt => [receipt.token, receipt.agent, receipt.at, receipt.ok]),
    completed.tasks.T2.validations.map(receipt => [receipt.token, receipt.agent, receipt.at, receipt.ok]))
  assert.equal(restored.tasks.T4.attempts[0].inputReceipt[0].task, 'T3')
  assert.equal(readFileSync(join(f.runDir, completed.eventLog), 'utf8'), firstLog)
  assert.equal(restoredEvents.length, firstLog.trim().split('\n').length + 1)
  assert.equal(restoredEvents.at(-1).type, 'task_renumbered')
  assert.equal(restoredEvents.filter(event => event.type === 'task_done' && event.task === 'T3').length, 1)
  assert.equal(restoredEvents.filter(event => event.type === 'task_done' && event.task === 'T4').length, 1)
  assert.deepEqual(contractDrift(restored, { plan: JSON.parse(readFileSync(restored.plan.source, 'utf8')) }), { available: true, planFields: [], tasks: [] })
})

test('renumeração recusa estados e rodadas abertos sem alterar estado ou eventos', t => {
  const f = fixture(t), initial = f.state()
  // Estados sintéticos isolam cada proteção sem iniciar processos ou modificar uma execução real.
  const cases = [
    value => { value.tasks.T3.state = 'running' },
    value => { value.tasks.T3.state = 'reviewing' },
    value => { value.tasks.T3.state = 'planning' },
    value => { value.tasks.T3.state = 'discussing' },
    value => { value.tasks.T3.attempts = [{ startedAt: '2026-01-01' }] },
    value => { value.tasks.T3.discussionAttempts = [{ startedAt: '2026-01-01' }] },
    value => { value.tasks.T3.planningAttempts = [{ startedAt: '2026-01-01' }] },
    value => { value.phaseWorkflows.F1.discussionAttempts = [{ startedAt: '2026-01-01' }] },
    value => { value.phaseWorkflows.F1.planningAttempts = [{ startedAt: '2026-01-01' }] },
  ]
  for (const change of cases) {
    const value = structuredClone(initial); change(value); f.save(value)
    const before = f.snapshot()
    f.rejects(/ativo|aberta/, 'renumber-tasks', '--map', mapping, '--confirmed-by-user')
    assert.deepEqual(f.snapshot(), before)
  }
})

test('renumeração recusa divergência do plano e identificador removido sem alterar a execução', t => {
  const f = fixture(t)
  const originalPlan = readFileSync(f.planPath, 'utf8'), changed = JSON.parse(originalPlan)
  changed.tasks[0].title = 'Contrato ainda não sincronizado'
  writeFileSync(f.planPath, JSON.stringify(changed))
  let before = f.snapshot()
  f.rejects(/Sincronize o plano/, 'renumber-tasks', '--map', mapping, '--confirmed-by-user')
  assert.deepEqual(f.snapshot(), before)
  assert.equal(readFileSync(f.planPath, 'utf8'), JSON.stringify(changed))
  writeFileSync(f.planPath, originalPlan)
  const state = f.state()
  state.removedTasks = { T5: { id: 'T5', title: 'Entrega removida', removedAt: '2026-01-01' } }
  f.save(state)
  before = f.snapshot()
  f.rejects(/removido.*T5/, 'renumber-tasks', '--map', 'T1=T5', '--confirmed-by-user')
  assert.deepEqual(f.snapshot(), before)
  assert.equal(readFileSync(f.planPath, 'utf8'), originalPlan)
})

test('prévia em estado legado não executa migração implícita e recusa formato futuro', t => {
  const f = fixture(t), initial = f.state()
  for (const schemaVersion of [0, 999]) {
    const value = { ...initial, schemaVersion }; f.save(value)
    const before = f.snapshot()
    f.rejects(/Migre o estado legado|newer schema/, 'renumber-tasks', '--map', mapping, '--dry-run')
    assert.deepEqual(f.snapshot(), before)
  }
})

test('renumeração preserva a recusa de um plano cujo contrato já estava obsoleto', t => {
  const f = fixture(t); f.planPhase()
  const state = f.state()
  state.tasks.T4.taskPlan.scope = 'contrato-anterior'
  f.save(state)
  assert.equal(hasCurrentTaskPlan(f.state(), f.state().tasks.T4), false)
  f.ok('renumber-tasks', '--map', mapping, '--confirmed-by-user')
  const after = f.state()
  assert.equal(after.tasks.T2.taskPlan.scope, 'contrato-anterior')
  assert.equal(hasCurrentTaskPlan(after, after.tasks.T2), false)
  assert.equal(hasCurrentTaskScope(after, after.tasks.T2, 1), false)
})

for (const directory of ['task-id-backups', 'plans']) test(`renumeração recusa diretório ligado em ${directory} sem escrever no destino`, t => {
  const f = fixture(t), target = join(f.root, 'destino-do-link')
  mkdirSync(target)
  const location = directory === 'plans' ? join(dirname(f.runDir), directory) : join(f.runDir, directory)
  symlinkSync(target, location, process.platform === 'win32' ? 'junction' : 'dir')
  const before = f.snapshot(), originalPlan = readFileSync(f.planPath, 'utf8')
  f.rejects(/diretórios ligados/, 'renumber-tasks', '--map', mapping, '--confirmed-by-user')
  assert.deepEqual(f.snapshot(), before)
  assert.equal(readFileSync(f.planPath, 'utf8'), originalPlan)
  assert.deepEqual(readdirSync(target), [])
})

test('falha na troca atômica mantém estado, fonte e log anteriores ativos e libera o próximo comando', t => {
  const f = fixture(t), before = f.snapshot(), originalPlan = readFileSync(f.planPath, 'utf8')
  const preload = join(f.root, 'falha-state.mjs')
  writeFileSync(preload, `import fs from 'node:fs';
    import { resolve } from 'node:path';
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (resolve(to) === ${JSON.stringify(join(f.runDir, 'state.json'))})
        throw Object.assign(new Error('Falha isolada na troca final do estado'), { code: 'EIO' });
      return rename(from, to);
    };
  `)
  const failure = f.cliWithEnv({ NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() },
    'renumber-tasks', '--map', mapping, '--confirmed-by-user')
  assert.notEqual(failure.status, 0)
  assert.match(failure.stdout + failure.stderr, /Falha isolada na troca final/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(readFileSync(f.planPath, 'utf8'), originalPlan)
  assert.equal(f.state().eventLog, undefined)
  assert.equal(f.state().plan.source, f.planPath)
  const preparedPlans = readdirSync(join(dirname(f.runDir), 'plans')).filter(file => file.includes('renumbered'))
  assert.equal(preparedPlans.length, 1)
  assert.equal(readdirSync(join(f.runDir, 'task-id-backups')).length, 1)
  const graph = JSON.parse(f.ok('graph').stdout)
  assert.equal(graph.tasks.T1.title, JSON.parse(originalPlan).tasks[0].title)
  f.ok('note', 'T3', '--text', 'A execução anterior permanece utilizável após a falha')
  assert.equal(f.state().plan.source, f.planPath)
  assert.ok(f.snapshot()[1].startsWith(before[1]))
  f.ok('renumber-tasks', '--map', mapping, '--confirmed-by-user')
  assert.equal(f.state().tasks.T1.previousTaskId, 'T3')
})
