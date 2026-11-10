import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture, check } from './fixtures/approved-graph.mjs'

for (const lang of ['en', 'pt-BR']) test(`pulo individual preserva a discussão das outras tarefas da fase em ${lang}`, t => {
  const f = fixture(t, { phase: true, lang, tasks: [{ id: 'T1' }, { id: 'T2' }] })
  const before = f.state(), events = f.events()
  f.rejects(/confirmed-by-user/, 'skip-discussion', 'T1', '--reason', 'Fluxo operacional já aprovado')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('skip-discussion', 'T1', '--reason', 'Fluxo operacional já aprovado', '--confirmed-by-user')
  f.ok('skip-planning', 'T1', '--reason', 'Procedimento existente suficiente', '--confirmed-by-user')
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user'); f.ok('start', 'T1', '--agent', 'executor')
  const selected = f.state().tasks.T1
  f.ok('begin-phase-discussion', 'F1')
  assert.deepEqual(f.state().phaseWorkflows.F1.discussionAttempts.at(-1).targets, ['T2'])
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  assert.deepEqual(f.state().tasks.T1, selected)
  assert.equal(f.state().tasks.T2.planningSkips.length, 0)
})

test('pulo individual não altera rodada ativa nem dispensa confirmação de contrato', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }] })
  f.ok('begin-phase-discussion', 'F1')
  const before = f.state(), events = f.events()
  f.rejects(/active|ativa/, 'skip-discussion', 'T1', '--reason', 'Ainda há trabalho atribuído', '--confirmed-by-user')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
})

test('adiar uma tarefa libera os outros planos e retoma somente a tarefa adiada', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] })
  f.ok('begin-phase-discussion', 'F1'); f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans)
  f.ok('defer', 'T3', '--reason', 'Publicação externa ainda indisponível')
  f.artifacts('F1'); f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  const preserved = structuredClone(f.state().tasks.T1.taskPlan)
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user'); f.ok('start', 'T1', '--agent', 'executor')
  f.ok('unblock', 'T3')
  f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans)
  assert.deepEqual(f.state().phaseWorkflows.F1.planningAttempts.at(-1).targets, ['T3'])
  f.artifacts('F1'); f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  assert.deepEqual(f.state().tasks.T1.taskPlan, preserved)
})

test('descartar plano mantém histórico e exige planejamento novo somente da tarefa escolhida', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }] })
  f.planPhase('F1')
  const before = f.state(), events = f.events()
  f.rejects(/confirmed-by-user/, 'discard-plan', 'T2', '--reason', 'Entrega externa mudou')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('discard-plan', 'T2', '--reason', 'Entrega externa mudou', '--confirmed-by-user')
  assert.equal(f.state().tasks.T2.taskPlan, undefined)
  assert.deepEqual(f.state().tasks.T2.planningDiscardHistory.at(-1).plan, before.tasks.T2.taskPlan)
  assert.deepEqual(f.state().tasks.T1, before.tasks.T1)
  f.rejects(/planning|planejamento/, 'start', 'T2', '--agent', 'executor')
  f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans)
  assert.deepEqual(f.state().phaseWorkflows.F1.planningAttempts.at(-1).targets, ['T2'])
})

test('fase anexada preserva aliases e usa o próximo identificador disponível', t => {
  const f = fixture(t, { phase: true })
  const state = f.state(); state.taskIdAliases = { T2: 'T1' }; f.importState(state)
  const before = f.state(), events = f.events()
  f.plan.tasks.push({ ...f.plan.tasks[0], id: 'T3', phase: 'F2' }); f.writePlan()
  f.ok('sync-plan', '--plan', f.source, '--dry-run')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.plan.tasks.at(-1).id = 'T2'; f.writePlan()
  f.rejects(/alias.*T2|T2.*alias/, 'sync-plan', '--plan', f.source, '--dry-run')
})

test('decisões individuais preservam confirmação pendente, trabalho ativo e histórico bloqueado', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }] })
  const initial = f.state()
  initial.phaseWorkflows.F1.contractConfirmationRequired = { tasks: ['T1'], proposed: true }
  f.importState(initial)
  f.rejects(/pending contract confirmation/, 'skip-discussion', 'T1', '--reason', 'Não pode ignorar novo contrato', '--confirmed-by-user')
  delete initial.phaseWorkflows.F1.contractConfirmationRequired; f.importState(initial)
  f.planPhase('F1')
  f.ok('defer', 'T2', '--reason', 'Dependência externa')
  f.ok('discard-plan', 'T2', '--reason', 'Artefato externo mudou', '--confirmed-by-user')
  f.rejects(/no task plan/, 'discard-plan', 'T2', '--reason', 'Repetição', '--confirmed-by-user')
  f.ok('unblock', 'T2')
  f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans)
  f.artifacts('F1'); f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user'); f.ok('start', 'T1', '--agent', 'executor')
  const active = f.state(), events = f.events()
  f.rejects(/active or terminal/, 'discard-plan', 'T1', '--reason', 'Trabalho ativo', '--confirmed-by-user')
  f.rejects(/assigned work/, 'defer', 'T1', '--reason', 'Trabalho ativo')
  assert.deepEqual(f.state(), active); assert.equal(f.events(), events)
  f.ok('block', 'T1', '--reason', 'Pausa externa')
  f.rejects(/active or terminal/, 'discard-plan', 'T1', '--reason', 'Execução bloqueada', '--confirmed-by-user')
  f.rejects(/assigned work/, 'defer', 'T1', '--reason', 'Execução bloqueada')
})

test('descarte não reativa dispensa antiga e uma nova decisão explícita permanece possível', t => {
  const f = fixture(t)
  f.skipTaskPlan()
  f.ok('plan-task', 'T1', '--agent', 'planner')
  const path = join(f.plans, 'novo-plano.json')
  writeFileSync(path, JSON.stringify({ research: [{ source: 'Contrato', findings: 'Critério conferido' }], decisions: [],
    steps: ['Conferir o comportamento aprovado'], verification: [{ criterion: check.expect, check: 1 }], openQuestions: [] }))
  f.ok('finish-planning', 'T1', '--plan', path)
  f.ok('discard-plan', 'T1', '--reason', 'Plano precisa ser revisto', '--confirmed-by-user')
  f.rejects(/planning/, 'start', 'T1', '--agent', 'executor')
  f.ok('skip-planning', 'T1', '--reason', 'Nova decisão explícita após descarte', '--confirmed-by-user')
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
})

test('adiamento de tarefa falhada restaura a rota anterior e encerra o recibo de adiamento', t => {
  const f = fixture(t, { phase: true })
  f.planPhase('F1')
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('fail', 'T1', '--reason', 'Entrega precisa de correção')
  const previous = f.state().tasks.T1.individualPlanning === true
  f.ok('defer', 'T1', '--reason', 'Aguardando dependência externa antes da nova tentativa')
  f.ok('unblock', 'T1')
  assert.equal(f.state().tasks.T1.state, 'failed')
  assert.equal(f.state().tasks.T1.individualPlanning === true, previous)
  assert.equal(f.state().tasks.T1.phaseDeferred, undefined)
})

test('adiamento preserva a rota individual aprovada sem iniciar execução automaticamente', t => {
  const f = fixture(t, { phase: true })
  f.skipTaskPlan()
  const decision = structuredClone(f.state().tasks.T1.planningSkips.at(-1))
  f.ok('defer', 'T1', '--reason', 'Esperar dependência externa')
  f.ok('unblock', 'T1')
  assert.equal(f.state().tasks.T1.individualPlanning, true)
  assert.equal(f.state().tasks.T1.state, 'pending')
  assert.equal(f.state().tasks.T1.attempts.length, 0)
  assert.deepEqual(f.state().tasks.T1.planningSkips.at(-1), decision)
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
})
