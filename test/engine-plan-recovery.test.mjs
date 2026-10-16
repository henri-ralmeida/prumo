import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { fixture, check } from './fixtures/approved-graph.mjs'
import { verifyTaskScope } from '../scripts/task-scope.mjs'

test('commit de varios arquivos preserva fingerprint ordenado e done sem aceitar conteudo ou modo alterado', t => {
  const f = fixture(t, { git: true, tasks: [{ id: 'T1', writeScope: 'files', touches: ['a.txt', 'z.txt'] }] })
  f.plan.scopePolicy = 'explicit'; f.writePlan(); f.ok('sync-plan', '--plan', f.source)
  f.skipTaskPlan(); f.ok('authorize', '--scope', 'run', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
  for (const name of ['a.txt', 'z.txt']) writeFileSync(join(f.project, name), 'Conteudo aprovado\n')
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('validate', 'T1', '--ok', '--evidence', 'Arquivos e permissoes conferidos', '--cwd', f.project)
  const approved = f.state().tasks.T1, receipt = approved.validations.at(-1).scopeCheck
  f.gitCommand('add', '.'); f.gitCommand('commit', '-m', 'Entrega')
  const afterCommit = verifyTaskScope(approved, approved.attempts.at(-1).scopeBaseline)
  assert.equal(afterCommit.fingerprint, receipt.fingerprint)
  const path = join(f.project, 'a.txt'), mode = statSync(path).mode
  try {
    chmodSync(path, mode & ~0o222)
    f.rejects(/Delivery changed after scope validation; validate again/, 'done', 'T1')
  } finally { chmodSync(path, mode) }
  writeFileSync(path, 'Conteudo diferente\n')
  f.rejects(/Delivery changed after scope validation; validate again/, 'done', 'T1')
  writeFileSync(path, 'Conteudo aprovado\n')
  f.ok('done', 'T1')
  assert.equal(f.state().tasks.T1.state, 'done')
  assert.deepEqual(f.state().tasks.T1.validations, approved.validations)
})

for (const legacy of [false, true]) test(`commit do conteudo ja revisado preserva aprovacao e permissoes, recibo legado ${legacy}`, t => {
  const f = fixture(t, { git: true, tasks: [{ id: 'T1', writeScope: 'files', touches: ['z.txt'] }] })
  f.plan.scopePolicy = 'explicit'; f.writePlan(); f.ok('sync-plan', '--plan', f.source)
  f.skipTaskPlan(); f.ok('authorize', '--scope', 'run', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
  writeFileSync(join(f.project, 'z.txt'), 'Comportamento aprovado\n')
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('validate', 'T1', '--ok', '--evidence', 'Arquivo entregue e comportamento conferidos', '--cwd', f.project)
  if (legacy) {
    const imported = f.state(), receipt = imported.tasks.T1.validations.at(-1).scopeCheck
    receipt.fingerprint = receipt.legacyFingerprint
    delete receipt.legacyFingerprint
    delete receipt.baselineOrderFingerprint
    delete receipt.newFilesFirstFingerprint
    f.importState(imported)
  }
  const approved = f.state().tasks.T1
  f.gitCommand('add', '.'); f.gitCommand('commit', '-m', 'Entrega')
  const file = join(f.project, 'z.txt'), mode = statSync(file).mode
  try {
    chmodSync(file, mode & ~0o222)
    f.rejects(/changed after.*validation|mudou.*valida/, 'done', 'T1')
  } finally { chmodSync(file, mode) }
  writeFileSync(join(f.project, 'z.txt'), 'Comportamento diferente\n')
  f.rejects(/changed after.*validation|mudou.*valida/, 'done', 'T1')
  writeFileSync(join(f.project, 'z.txt'), 'Comportamento aprovado\n')
  f.ok('done', 'T1')
  assert.deepEqual(f.state().tasks.T1.validations, approved.validations)
  assert.equal(f.state().tasks.T1.attempts.length, 1)
})

test('refresh de comando preserva a dispensa explicita do planejamento de fase', t => {
  const f = fixture(t, { phase: true })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Contrato aprovado', '--confirmed-by-user')
  f.ok('skip-phase-planning', 'F1', '--reason', 'Contrato suficiente', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  const before = f.state()
  f.plan.tasks[0].validation = [{ ...check, run: 'node check.cjs --atualizado' }]; f.writePlan()
  f.ok('refresh-contract', 'T1', '--plan', f.source)
  f.ok('validate', 'T1', '--ok', '--evidence', 'Comando atual e entrega conferidos pelo revisor', '--cwd', f.project)
  f.ok('done', 'T1')
  assert.deepEqual(f.state().tasks.T1.planningSkips, before.tasks.T1.planningSkips)
  assert.deepEqual(f.state().phaseWorkflows, before.phaseWorkflows)
  assert.equal(f.state().tasks.T1.attempts.length, 1)
})

test('criterio alterado exige planejamento atual mesmo com dispensa anterior confirmada', t => {
  const f = fixture(t, { phase: true })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Contrato aprovado', '--confirmed-by-user')
  f.ok('skip-phase-planning', 'F1', '--reason', 'Contrato suficiente', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  const original = f.state().tasks.T1
  f.plan.tasks[0].validation = [{ ...check, expect: 'Novo comportamento material aprovado' }]; f.writePlan()
  f.ok('refresh-contract', 'T1', '--plan', f.source)
  const before = f.state(), events = f.events()
  f.rejects(/planning|planejamento/, 'validate', 'T1', '--ok', '--evidence', 'Dispensa antiga nao aprova criterio novo', '--cwd', f.project)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  assert.deepEqual(f.state().tasks.T1.planningSkips, original.planningSkips)
  assert.deepEqual(f.state().tasks.T1.attempts, original.attempts)
})

test('discussao nao encerra com pergunta vencida sem resposta e aceita a resolucao correspondente', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2', phase: 'F2' }] })
  f.planPhase('F1', value => { value.openQuestions = [{ question: 'Qual regra usar na entrega?', blocking: false, decideBy: { beforePhase: 'F2' } }] })
  const question = f.state().tasks.T1.taskPlan.openQuestions[0]
  f.ok('skip', 'T1', '--reason', 'Preparacao dispensada pelo usuario')
  f.ok('begin-phase-discussion', 'F2')
  const before = f.state(), events = f.events()
  f.rejects(new RegExp(question.questionRef), 'finish-phase-discussion', 'F2', '--context', f.discovery('F2'))
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('finish-phase-discussion', 'F2', '--context', f.discovery('F2', [
    { question: question.question, answer: 'Preservar a regra aprovada.', resolvesQuestion: question.questionRef },
  ]))
  f.ok('plan-phase', 'F2', '--agent', 'planner', '--plan-dir', f.plans)
  f.artifacts('F2'); f.ok('finish-phase-planning', 'F2', '--plan-dir', f.plans)
  assert.equal(f.state().questionResolutions[0].questionRef, question.questionRef)
})

test('alterar tarefa em execucao orienta pausa sem substituir seu plano pela tentativa seguinte', t => {
  const f = fixture(t, { phase: true })
  f.planPhase(); f.ok('start', 'T1', '--agent', 'executor')
  const before = f.state().tasks.T1
  f.plan.tasks[0].title = 'Entrega com novo criterio de escopo'; f.writePlan()
  assert.match(f.ok('sync-plan', '--plan', f.source), /pause-replanning T1/)
  const after = f.state(), events = f.events()
  f.rejects(/pause-replanning T1/, 'begin-phase-discussion', 'F1')
  assert.deepEqual(f.state(), after); assert.equal(f.events(), events)
  assert.deepEqual(f.state().tasks.T1.taskPlan, before.taskPlan)
  assert.deepEqual(f.state().tasks.T1.attempts, before.attempts)
})

test('registros antigos com plano de fase na tentativa errada mostram recuperacao sem quebrar leituras', t => {
  const f = fixture(t, { phase: true })
  f.planPhase(); f.ok('start', 'T1', '--agent', 'executor')
  const imported = f.state()
  imported.tasks.T1.taskPlan.attempt = 2
  imported.tasks.T1.unavailable = ['manual-inspection']
  delete imported.tasks.T1.retryPlan
  f.importState(imported)
  const events = f.events()
  for (const command of ['ready', 'status']) {
    const output = f.ok(command)
    assert.match(output, /pause-replanning T1/)
    assert.doesNotMatch(output, /TypeError/)
    assert.deepEqual(f.state(), imported); assert.equal(f.events(), events)
  }
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.rejects(/planning|planejamento/, 'validate', 'T1', '--ok', '--evidence', 'Nao aprovar plano de outra tentativa')
})

test('retry corretivo conserva o plano de fase e a nova validacao permanece independente', t => {
  const f = fixture(t, { phase: true })
  f.planPhase(); f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  const original = f.state().tasks.T1.taskPlan
  f.ok('fail', 'T1', '--reason', 'A entrega precisa de correcao dentro do contrato aprovado')
  f.ok('retry', 'T1'); f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  assert.deepEqual(f.state().tasks.T1.taskPlan, original)
  f.ok('validate', 'T1', '--ok', '--evidence', 'Revisor conferiu a correcao no contrato aprovado', '--cwd', f.project)
  f.ok('done', 'T1')
  assert.equal(f.state().tasks.T1.attempts.length, 2)
  assert.equal(f.state().tasks.T1.attempts[0].result, 'failed')
})

for (const reviewing of [false, true]) test(`planejamento de fase legado nao substitui plano de tentativa ativa, revisao ${reviewing}`, t => {
  const f = fixture(t, { phase: true })
  f.planPhase(); f.ok('start', 'T1', '--agent', 'executor')
  if (reviewing) f.ok('review', 'T1', '--agent', 'reviewer')
  const original = f.state(), imported = structuredClone(original), phase = imported.phaseWorkflows.F1
  // Um registro antigo pode ter mantido um alvo ativo numa rodada de planejamento de fase.
  imported.tasks.T1.phasePlanDefect = true
  phase.state = 'pending'; f.importState(imported)
  for (const command of ['plan-phase', 'skip-phase-planning']) {
    const args = command === 'plan-phase' ? ['--agent', 'planner'] : ['--reason', 'Escolha explicita', '--confirmed-by-user']
    const before = f.state(), events = f.events()
    f.rejects(/pause-replanning T1/, command, 'F1', ...args)
    assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  }
  const round = structuredClone(phase.planningAttempts[0])
  delete round.endedAt; delete round.result
  round.n = 2
  phase.planningAttempts.push(round); phase.state = 'planning'; f.importState(imported)
  const events = f.events()
  f.rejects(/pause-replanning T1/, 'finish-phase-planning', 'F1', '--plan-dir', f.plans)
  assert.deepEqual(f.state(), imported); assert.equal(f.events(), events)
  assert.deepEqual(f.state().tasks.T1.taskPlan, original.tasks.T1.taskPlan)
})

test('planejamento nao fecha uma rodada legada com pergunta vencida e aceita a resposta no artefato atual', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2', phase: 'F2' }] })
  f.planPhase('F1'); f.ok('skip', 'T1', '--reason', 'Preparacao dispensada')
  f.ok('begin-phase-discussion', 'F2'); f.ok('finish-phase-discussion', 'F2', '--context', f.discovery('F2'))
  f.ok('plan-phase', 'F2', '--agent', 'planner', '--plan-dir', f.plans); f.artifacts('F2')
  const imported = f.state(), questionRef = 'T1:plan:decisao-historica'
  // Versoes anteriores podiam encerrar a discussao sem cobrar uma decisao que ja estava vencida.
  delete imported.phaseWorkflows.F2.planningAttempts.at(-1).workers
  imported.tasks.T1.taskPlan.openQuestions = [{ question: 'Qual regra vale para a entrega?', blocking: false,
    decideBy: { beforePhase: 'F2' }, questionRef }]
  f.importState(imported)
  const events = f.events()
  f.rejects(new RegExp(questionRef), 'finish-phase-planning', 'F2', '--plan-dir', f.plans)
  assert.deepEqual(f.state(), imported); assert.equal(f.events(), events)
  f.artifacts('F2', value => { value.decisions = [{ question: 'Qual regra vale para a entrega?', answer: 'Preservar a regra aprovada.', resolvesQuestion: questionRef }] })
  f.ok('finish-phase-planning', 'F2', '--plan-dir', f.plans)
  assert.equal(f.state().questionResolutions.at(-1).questionRef, questionRef)
})

test('lotes de planejamento avancam sem encerrar a fase antes da resposta do ultimo agente', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2', phase: 'F2' }, { id: 'T3', phase: 'F2' }] })
  f.ok('set-agent-limit', '--max', '1', '--actor', 'usuario', '--confirmed-by-user')
  f.planPhase('F1', value => { value.openQuestions = [{ question: 'Qual regra vale na entrega?', blocking: false,
    decideBy: { beforePhase: 'F2' } }] })
  const question = f.state().tasks.T1.taskPlan.openQuestions[0]
  f.ok('skip', 'T1', '--reason', 'Preparacao dispensada pelo usuario')
  f.ok('skip-phase-discussion', 'F2', '--reason', 'Usuario confirmou a discussao dispensada', '--confirmed-by-user')
  f.ok('plan-phase', 'F2', '--agent', 'planner', '--plan-dir', f.plans)
  f.artifacts('F2'); f.ok('finish-phase-planning', 'F2', '--plan-dir', f.plans)
  const staged = f.state()
  assert.equal(staged.phaseWorkflows.F2.state, 'planning')
  assert.deepEqual(staged.phaseWorkflows.F2.planningAttempts.at(-1).activeTargets, ['T3'])
  assert.equal(staged.tasks.T2.taskPlan, undefined)
  f.artifacts('F2')
  const events = f.events()
  f.rejects(new RegExp(question.questionRef), 'finish-phase-planning', 'F2', '--plan-dir', f.plans)
  assert.deepEqual(f.state(), staged); assert.equal(f.events(), events)
  f.artifacts('F2', value => { value.decisions = [{ question: question.question, answer: 'Preservar a regra aprovada.',
    resolvesQuestion: question.questionRef }] })
  f.ok('finish-phase-planning', 'F2', '--plan-dir', f.plans)
  assert.equal(f.state().phaseWorkflows.F2.state, 'planned')
  assert.ok(f.state().tasks.T2.taskPlan); assert.ok(f.state().tasks.T3.taskPlan)
  assert.equal(f.state().questionResolutions.at(-1).questionRef, question.questionRef)
  assert.equal(f.state().tasks.T2.attempts.length, 0); assert.equal(f.state().tasks.T3.attempts.length, 0)
})
