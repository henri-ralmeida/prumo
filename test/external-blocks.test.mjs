import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/engine.mjs')
const validation = [{ kind: 'functional', run: 'node check.cjs', expect: 'behavior passes' }]

function fixture(t, { planningMode = 'phase', scopePolicy, tasks = [{ id: 'T1', title: 'Entrega T1', phase: 'F1' }], phases = [{ id: 'F1', title: 'Fase F' }] } = {}) {
  const home = mkdtempSync(join(resolve(tmpdir()), 'prumo-external-blocks-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const root = join(home, 'workspace'), project = join(home, 'project'), plans = join(root, 'plans')
  mkdirSync(root); mkdirSync(project); mkdirSync(plans)
  writeFileSync(join(project, 'check.cjs'), "process.stdout.write('behavior passes\\n')\\n")
  const plan = {
    name: 'Bloqueios externos', planningMode, ...(scopePolicy ? { scopePolicy } : {}), phases,
    tasks: tasks.map(task => ({ summary: 'Entregar o comportamento aprovado da tarefa.', validation, ...task })),
  }
  const planPath = join(root, 'plan.json')
  const writePlan = () => writeFileSync(planPath, JSON.stringify(plan))
  writePlan()
  const run = 'external-blocks'
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, GRAPH_ROOT: root, GRAPH_FOREMAN_HOME: home, PRUMO_LANG: 'en' }
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [engine, ...args], {
      cwd: project, env, encoding: 'utf8', timeout: 30000, windowsHide: true,
    })
    assert.ifError(result.error)
    return { ...result, output: result.stdout + result.stderr }
  }
  const ok = (...args) => {
    const result = cli(...args)
    assert.equal(result.status, 0, result.output)
    return result
  }
  const rejected = (pattern, ...args) => {
    const result = cli(...args)
    assert.notEqual(result.status, 0, result.output)
    assert.match(result.output, pattern)
    return result
  }
  const initialized = cli('init', '--plan', planPath, '--run', run)
  assert.equal(initialized.status, 0, initialized.output)
  const authorized = cli('authorize', '--scope', 'run', '--confirmed-by-user')
  assert.equal(authorized.status, 0, authorized.output)
  const statePath = join(root, '.specs', 'graph', run, 'state.json')
  const eventsPath = join(root, '.specs', 'graph', run, 'events.ndjson')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const save = value => writeFileSync(statePath, JSON.stringify(value))
  const events = () => readFileSync(eventsPath, 'utf8')
  const phase = phaseId => state().phaseWorkflows[phaseId]
  const taskDiscovery = id => {
    const round = state().tasks[id].discussionAttempts.at(-1)
    return {
      research: [{ source: 'check.cjs', findings: 'O comportamento atual foi inspecionado.' }],
      questions: [{ question: 'Preservar o comportamento aprovado?', answer: 'Sim.', channel: 'chat-fallback', round: 1, roundId: round.roundId }],
      coverage: {
        problem: 'O comportamento precisa seguir o contrato aprovado.', affected: 'Pessoas que usam a entrega.',
        outcome: 'A entrega mantém o comportamento aprovado.', currentBehavior: 'A implementação existente foi inspecionada.',
        desiredBehavior: 'O contrato aprovado continua válido.', rules: 'Preservar o contrato aprovado.',
        exceptions: 'Nenhuma exceção aprovada.', scope: `Tarefa ${id}.`, acceptance: 'A verificação funcional passa.',
      },
      decisions: [], deferred: [], executionBoundary: { deferredToExecutor: [id], prematureTaskWork: [] },
      closure: 'Não resta incerteza consequencial.', roundId: round.roundId, nonce: round.nonce,
    }
  }
  const finishTaskDiscussion = id => {
    const path = join(root, `discovery-${id}.json`)
    writeFileSync(path, JSON.stringify(taskDiscovery(id)))
    return ok('finish-discussion', id, '--context', path)
  }
  const taskArtifact = id => {
    const task = state().tasks[id]
    return {
      summary: 'Aplicar a abordagem pesquisada e verificar o contrato aprovado.',
      research: [{ source: join(project, 'check.cjs'), findings: 'A verificação funcional existente foi conferida.' }],
      decisions: [], steps: ['Aplicar o contrato aprovado.', 'Executar a verificação funcional.'],
      verification: task.validation.map((step, index) => ({ criterion: step.expect, check: index + 1 })),
      openQuestions: [],
    }
  }
  const finishTaskPlanning = id => {
    const path = join(root, `task-plan-${id}.json`)
    writeFileSync(path, JSON.stringify(taskArtifact(id)))
    return ok('finish-planning', id, '--plan', path)
  }
  const phaseDiscovery = phaseId => {
    const round = phase(phaseId).discussionAttempts.at(-1)
    return {
      research: [{ source: 'check.cjs', findings: 'Os contratos atuais da fase foram inspecionados.' }],
      questions: [{ question: 'Preservar os contratos da fase?', answer: 'Sim.', channel: 'chat-fallback', round: 1, roundId: round.roundId }],
      coverage: {
        problem: 'A fase precisa manter o comportamento aprovado.', affected: 'Pessoas que recebem a entrega da fase.',
        outcome: 'Os contratos da fase são entregues com verificação.', currentBehavior: 'Os contratos atuais foram inspecionados.',
        desiredBehavior: 'A fase segue o plano aprovado.', rules: 'Preservar contratos e dependências.',
        exceptions: 'Tarefas bloqueadas externamente aguardam fora da rodada.', scope: `Fase ${phaseId}.`,
        acceptance: 'Cada tarefa incluída possui um plano verificável.',
      },
      decisions: [], deferred: [], executionBoundary: { deferredToExecutor: [...round.targets], prematureTaskWork: [] },
      closure: 'Não resta incerteza consequencial na fase.', roundId: round.roundId, nonce: round.nonce,
    }
  }
  const finishPhaseDiscussion = phaseId => {
    const path = join(root, `discovery-${phaseId}.json`)
    writeFileSync(path, JSON.stringify(phaseDiscovery(phaseId)))
    return ok('finish-phase-discussion', phaseId, '--context', path)
  }
  const phaseArtifact = (phaseId, id) => {
    const workflow = phase(phaseId), round = workflow.planningAttempts.at(-1)
    const task = state().tasks[id]
    return {
      summary: 'Aplicar a abordagem pesquisada e verificar o contrato aprovado.',
      research: [{ source: join(project, 'check.cjs'), findings: 'A verificação funcional da tarefa foi conferida.' }],
      decisions: [], steps: ['Aplicar o contrato aprovado.', 'Executar a verificação funcional.'],
      verification: task.validation.map((step, index) => ({ criterion: step.expect, check: index + 1 })),
      openQuestions: [], phaseBinding: { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n },
      unresolvedInputs: round.requiredInputs?.[id] ?? [],
    }
  }
  const finishPhasePlanning = (phaseId, ids = phase(phaseId).planningAttempts.at(-1).targets) => {
    const round = phase(phaseId).planningAttempts.at(-1)
    for (const id of ids) writeFileSync(join(plans, `task-plan-${id}.json`), JSON.stringify(phaseArtifact(phaseId, id)))
    return ok('finish-phase-planning', phaseId, '--plan-dir', plans)
  }
  return {
    root, project, plans, planPath, plan, writePlan, cli, ok, rejected, state, save, events, phase,
    finishTaskDiscussion, finishTaskPlanning, finishPhaseDiscussion, finishPhasePlanning,
  }
}

test('bloqueio externo antes da discussão exclui a tarefa e fecha o planejamento sem seu artefato', t => {
  const f = fixture(t, { tasks: [
    { id: 'T1', title: 'Aguardando entrada externa', phase: 'F1' },
    { id: 'T2', title: 'Entrega independente', phase: 'F1' },
  ] })
  f.ok('block', 'T1', '--reason', 'Entrada externa ainda não disponível')
  const begun = f.ok('begin-phase-discussion', 'F1')
  assert.match(begun.output, /Outside this round \(blocked\): T1/)
  assert.deepEqual(f.phase('F1').discussionAttempts.at(-1).targets, ['T2'])
  f.finishPhaseDiscussion('F1')
  f.ok('plan-phase', 'F1', '--agent', 'planner-F1')
  assert.deepEqual(f.phase('F1').planningAttempts.at(-1).targets, ['T2'])
  f.finishPhasePlanning('F1')
  const current = f.state()
  assert.equal(current.phaseWorkflows.F1.state, 'planned')
  assert.equal(current.tasks.T1.state, 'blocked')
  assert.equal(current.tasks.T1.blockKind, 'external')
  assert.equal(current.tasks.T1.taskPlan, undefined)
  assert.ok(current.tasks.T1.individualPlanning)
  assert.ok(current.tasks.T2.taskPlan)
  assert.equal(current.tasks.T2.phase, 'F1')
})

test('bloqueio externo durante a discussão remove o alvo e mantém o lote fechável', t => {
  const f = fixture(t, { tasks: [
    { id: 'T1', title: 'Bloqueada durante descoberta', phase: 'F1' },
    { id: 'T2', title: 'Continua na fase', phase: 'F1' },
  ] })
  f.ok('begin-phase-discussion', 'F1')
  f.ok('block', 'T1', '--reason', 'Dependência externa interrompeu T1')
  const round = f.phase('F1').discussionAttempts.at(-1)
  assert.deepEqual(round.originalTargets, ['T1', 'T2'])
  assert.deepEqual(round.targets, ['T2'])
  assert.deepEqual(round.excludedTargets.map(item => item.task), ['T1'])
  f.finishPhaseDiscussion('F1')
  f.ok('plan-phase', 'F1', '--agent', 'planner-F1')
  f.finishPhasePlanning('F1')
  const current = f.state()
  assert.equal(current.phaseWorkflows.F1.state, 'planned')
  assert.equal(current.tasks.T1.taskPlan, undefined)
  assert.ok(current.tasks.T2.taskPlan)
})

test('bloqueio externo durante o planejamento remove o alvo sem tornar o lote stale', t => {
  const f = fixture(t, { tasks: [
    { id: 'T1', title: 'Bloqueada durante planejamento', phase: 'F1' },
    { id: 'T2', title: 'Plano restante', phase: 'F1' },
  ] })
  f.ok('begin-phase-discussion', 'F1')
  f.finishPhaseDiscussion('F1')
  f.ok('plan-phase', 'F1', '--agent', 'planner-F1')
  f.ok('block', 'T1', '--reason', 'Entrada externa interrompeu o planejamento de T1')
  const round = f.phase('F1').planningAttempts.at(-1)
  assert.deepEqual(round.originalTargets, ['T1', 'T2'])
  assert.deepEqual(round.targets, ['T2'])
  assert.deepEqual(round.excludedTargets.map(item => item.task), ['T1'])
  f.finishPhasePlanning('F1', ['T2'])
  const current = f.state()
  assert.equal(current.phaseWorkflows.F1.state, 'planned')
  assert.equal(current.tasks.T1.taskPlan, undefined)
  assert.ok(current.tasks.T2.taskPlan)
})

test('comandos diretos não mutam uma tarefa bloqueada externamente e orientam o unblock', t => {
  const f = fixture(t, { tasks: [{ id: 'T1', title: 'Bloqueada', phase: 'F1' }] })
  f.ok('block', 'T1', '--reason', 'Aguardando decisão externa')
  const commands = [
    ['begin-discussion', 'T1'],
    ['finish-discussion', 'T1', '--context', join(f.root, 'missing-discovery.json')],
    ['plan-task', 'T1', '--agent', 'planner-T1'],
    ['finish-planning', 'T1', '--plan', join(f.root, 'missing-plan.json')],
    ['start', 'T1', '--agent', 'executor-T1'],
    ['review', 'T1', '--agent', 'reviewer-T1'],
    ['validate', 'T1', '--failed', '--evidence', 'blocked'],
    ['done', 'T1'],
    ['fail', 'T1', '--reason', 'blocked'],
    ['retry', 'T1'],
    ['skip', 'T1', '--reason', 'blocked'],
  ]
  for (const command of commands) {
    const before = f.state(), events = f.events()
    f.rejected(/T1 is blocked:[\s\S]*unblock/, ...command)
    assert.deepEqual(f.state(), before, command[0])
    assert.equal(f.events(), events, command[0])
  }
})

test('pause-replanning recusa bloqueio externo antes de qualquer mutação', t => {
  const f = fixture(t, { tasks: [{ id: 'T1', title: 'Bloqueada externamente', phase: 'F1' }] })
  f.ok('block', 'T1', '--reason', 'Aguardando uma decisão externa')
  const before = f.state(), events = f.events()
  f.rejected(/T1 is blocked:[\s\S]*unblock/, 'pause-replanning', 'T1', '--reason', 'Tentar replanejar sem desbloquear')
  assert.deepEqual(f.state(), before)
  assert.equal(f.events(), events)
})

test('após unblock, uma tarefa excluída usa discussão e planejamento individual preservando sua fase', t => {
  const f = fixture(t, { tasks: [{ id: 'T1', title: 'Retomada individual', phase: 'F1' }] })
  f.ok('block', 'T1', '--reason', 'Entrada externa pendente')
  f.ok('unblock', 'T1')
  assert.equal(f.state().tasks.T1.state, 'pending')
  assert.equal(f.state().tasks.T1.blockKind, undefined)
  assert.equal(f.state().tasks.T1.individualPlanning, true)
  f.ok('begin-discussion', 'T1')
  f.finishTaskDiscussion('T1')
  f.ok('plan-task', 'T1', '--agent', 'planner-T1')
  f.finishTaskPlanning('T1')
  const current = f.state()
  assert.equal(current.tasks.T1.state, 'pending')
  assert.equal(current.tasks.T1.phase, 'F1')
  assert.ok(current.tasks.T1.taskPlan)
  assert.equal(current.tasks.T1.taskPlan.phaseId, undefined)
  assert.equal(current.phaseWorkflows.F1.discussionAttempts.length, 0)
  assert.equal(current.phaseWorkflows.F1.planningAttempts.length, 0)
})

test('pause-replanning marca pausa interna, conserva tentativa e revisão e retoma após novo plano', t => {
  const f = fixture(t, { planningMode: 'task', tasks: [{ id: 'T1', title: 'Replanejamento interno', phase: 'F1' }] })
  f.ok('begin-discussion', 'T1')
  f.finishTaskDiscussion('T1')
  f.ok('plan-task', 'T1', '--agent', 'planner-T1')
  f.finishTaskPlanning('T1')
  f.ok('start', 'T1', '--agent', 'executor-T1')
  f.ok('review', 'T1', '--agent', 'reviewer-T1')
  const before = f.state().tasks.T1
  f.ok('pause-replanning', 'T1', '--reason', 'Escopo aprovado precisa de pesquisa adicional')
  let paused = f.state().tasks.T1
  assert.equal(paused.state, 'blocked')
  assert.equal(paused.blockKind, 'replan')
  assert.equal(paused.blockReason, 'Escopo aprovado precisa de pesquisa adicional')
  assert.equal(paused.stateBeforeBlock, 'reviewing')
  assert.equal(paused.individualPlanning, undefined)
  assert.deepEqual(paused.attempts, before.attempts)
  assert.equal(paused.reviewer, 'reviewer-T1')

  f.ok('plan-task', 'T1', '--agent', 'replanner-T1')
  f.finishTaskPlanning('T1')
  paused = f.state().tasks.T1
  assert.equal(paused.state, 'blocked')
  assert.equal(paused.blockKind, 'replan')
  assert.equal(paused.stateBeforeBlock, 'reviewing')
  assert.equal(paused.blockReason, 'Escopo aprovado precisa de pesquisa adicional')
  assert.deepEqual(paused.attempts, before.attempts)
  assert.deepEqual(paused.validations, before.validations)
  assert.equal(paused.reviewer, 'reviewer-T1')
  assert.equal(paused.planningHistory.length, 2)

  f.ok('unblock', 'T1')
  const resumed = f.state().tasks.T1
  assert.equal(resumed.state, 'reviewing')
  assert.equal(resumed.blockKind, undefined)
  assert.equal(resumed.blockReason, undefined)
  assert.equal(resumed.attempts.length, 1)
  assert.equal(resumed.attempts[0].startedAt, before.attempts[0].startedAt)
  assert.equal(resumed.reviewer, 'reviewer-T1')
  assert.equal(resumed.blockHistory.at(-1).reason, 'Escopo aprovado precisa de pesquisa adicional')
})

test('unblock de bloqueio externo com escopo obsoleto vira replanejamento interno na mesma tentativa', t => {
  const f = fixture(t, { scopePolicy: 'explicit', tasks: [
    { id: 'T1', title: 'Escopo que muda', phase: 'F1', writeScope: 'files', touches: ['delivery.cjs'] },
  ] })
  f.ok('begin-phase-discussion', 'F1')
  f.finishPhaseDiscussion('F1')
  f.ok('plan-phase', 'F1', '--agent', 'planner-F1')
  f.finishPhasePlanning('F1')
  f.ok('start', 'T1', '--agent', 'executor-T1')
  f.ok('review', 'T1', '--agent', 'reviewer-T1')
  const original = f.state().tasks.T1
  f.plan.tasks[0].touches = ['delivery-next.cjs']
  f.writePlan()
  f.ok('sync-plan', '--plan', f.planPath)
  f.ok('block', 'T1', '--reason', 'Aguardando decisão sobre o novo escopo',
    '--question', 'Qual escopo deve valer?', '--option', 'Aplicar o escopo aprovado')
  const externallyBlocked = f.state().tasks.T1
  assert.equal(externallyBlocked.blockKind, 'external')
  assert.equal(externallyBlocked.stateBeforeBlock, 'reviewing')
  assert.equal(externallyBlocked.reviewer, 'reviewer-T1')
  assert.deepEqual(externallyBlocked.attempts, original.attempts)

  f.ok('unblock', 'T1', '--answer', 'Aplicar o escopo aprovado')
  let replanning = f.state().tasks.T1
  assert.equal(replanning.state, 'blocked')
  assert.equal(replanning.blockKind, 'replan')
  assert.equal(replanning.blockReason, 'approved scope needs current planning')
  assert.equal(replanning.stateBeforeBlock, 'reviewing')
  assert.equal(replanning.individualPlanning, true)
  assert.equal(replanning.blockQuestion, undefined)
  assert.equal(replanning.reviewer, 'reviewer-T1')
  assert.deepEqual(replanning.attempts, original.attempts)
  assert.equal(replanning.blockHistory.at(-1).question, 'Qual escopo deve valer?')
  assert.equal(replanning.blockHistory.at(-1).answer, 'Aplicar o escopo aprovado')

  f.ok('begin-discussion', 'T1')
  const discussionAgent = f.state().tasks.T1.discussionAttempts.at(-1).agent
  const beforeWrongActivity = f.state(), eventsBeforeWrongActivity = f.events()
  f.rejected(/discussion activity belongs to/, 'activity-start', 'T1', '--scope', 'task', '--role', 'discussion', '--agent', `${discussionAgent}-other`)
  assert.deepEqual(f.state(), beforeWrongActivity)
  assert.equal(f.events(), eventsBeforeWrongActivity)
  f.ok('activity-start', 'T1', '--scope', 'task', '--role', 'discussion', '--agent', discussionAgent)
  f.ok('activity-stop', 'T1', '--scope', 'task', '--role', 'discussion', '--agent', discussionAgent)
  f.finishTaskDiscussion('T1')
  f.ok('plan-task', 'T1', '--agent', 'replanner-T1')
  f.finishTaskPlanning('T1')
  replanning = f.state().tasks.T1
  assert.equal(replanning.state, 'blocked')
  assert.equal(replanning.blockKind, 'replan')
  assert.equal(replanning.stateBeforeBlock, 'reviewing')
  assert.equal(replanning.reviewer, 'reviewer-T1')
  assert.deepEqual(replanning.attempts, original.attempts)
  assert.equal(replanning.planningHistory.length, 2)

  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.ok('unblock', 'T1')
  const resumed = f.state().tasks.T1
  assert.equal(resumed.state, 'reviewing')
  assert.equal(resumed.blockKind, undefined)
  assert.equal(resumed.reviewer, 'reviewer-T1')
  assert.equal(resumed.attempts.length, 1)
  assert.equal(resumed.attempts[0].startedAt, original.attempts[0].startedAt)
})

test('bloqueio legado sem blockKind continua externo mesmo quando a razão menciona replanejamento', t => {
  const f = fixture(t, { tasks: [
    { id: 'T1', title: 'Bloqueio legado', phase: 'F1' },
    { id: 'T2', title: 'Alvo atual', phase: 'F1' },
  ] })
  const current = f.state()
  Object.assign(current.tasks.T1, {
    state: 'blocked', stateBeforeBlock: 'pending', blockReason: 'replanejamento solicitado após entrada externa',
  })
  delete current.tasks.T1.blockKind
  delete current.tasks.T1.individualPlanning
  f.save(current)
  f.ok('begin-phase-discussion', 'F1')
  assert.deepEqual(f.phase('F1').discussionAttempts.at(-1).targets, ['T2'])
  const before = f.state(), events = f.events()
  f.rejected(/T1 is blocked:[\s\S]*unblock/, 'start', 'T1', '--agent', 'executor-T1')
  assert.deepEqual(f.state(), before)
  assert.equal(f.events(), events)
})
