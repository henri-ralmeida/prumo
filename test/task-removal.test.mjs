import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixtures/approved-graph.mjs'

test('remocao recusa escopo ambiguo, referencias e historico executado sem gravar alteracoes parciais', t => {
  const f = fixture(t, { tasks: [{ id: 'T1' }, { id: 'T2' }] })
  const original = f.state()
  f.plan.tasks.pop(); f.writePlan()
  for (const args of [
    ['--remove', 'T1'], ['--remove', 'T2,T2'], ['--remove', 'T2,'],
    ['--remove', 'T2', '--propose'], ['--remove', 'T2', '--reason', ' '],
    ['--reason', 'Sem lista explicita'],
  ]) {
    const before = f.state(), events = f.events()
    const options = args.includes('--reason') ? args : [...args, '--reason', 'Unificacao aprovada']
    f.rejects(/remove|reason|motivo/, 'sync-plan', '--plan', f.source, ...options)
    assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  }
  const imports = [
    state => { state.tasks.T2.notes = [{ text: 'Observacao preservada' }] },
    state => { state.tasks.T2.validations = [{ ok: false, evidence: 'Recibo historico' }] },
    state => { state.tasks.T1.deps = ['T2'] },
    state => { state.tasks.T1.taskPlan = { unresolvedInputs: [{ task: 'T2' }] } },
    state => { state.tasks.T1.taskPlan = { openQuestions: [{ question: 'Quando decidir?', decideBy: { beforeTask: 'T2' } }] } },
    state => { state.tasks.T2.discussionAttempts = [{ startedAt: new Date().toISOString() }] },
    state => { state.tasks.T2.planningAttempts = [{ startedAt: new Date().toISOString() }] },
  ]
  for (const change of imports) {
    const imported = structuredClone(original); change(imported); f.importState(imported)
    const events = f.events()
    f.rejects(/Cannot remove/, 'sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Unificacao aprovada')
    assert.deepEqual(f.state(), imported); assert.equal(f.events(), events)
  }
  f.importState(original)
  // O candidato nao pode esconder dependentes existentes apenas alterando o arquivo aprovado na mesma operacao.
  const withDependent = structuredClone(original); withDependent.tasks.T1.deps = ['T2']; f.importState(withDependent)
  f.rejects(/still references/, 'sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Unificacao aprovada')
  f.importState(original)
  f.plan.tasks.push({ id: 'T2', title: 'Entrega aprovada', validation: f.plan.tasks[0].validation }); f.writePlan()
  f.skipTaskPlan('T2'); f.ok('start', 'T2', '--agent', 'executor')
  f.plan.tasks.pop(); f.writePlan()
  const refuse = () => {
    const before = f.state(), events = f.events()
    f.rejects(/only pending tasks/, 'sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Unificacao aprovada')
    assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  }
  refuse(); f.ok('review', 'T2', '--agent', 'reviewer'); refuse()
  f.ok('fail', 'T2', '--reason', 'Entrega incompleta'); refuse()
  f.plan.tasks.push({ id: 'T2', title: 'Entrega aprovada', validation: f.plan.tasks[0].validation }); f.writePlan()
  f.ok('retry', 'T2')
  f.plan.tasks.pop(); f.writePlan(); refuse()
  f.ok('skip', 'T2', '--reason', 'Usuario dispensou a entrega restante'); refuse()
})

test('remocao recusa trabalho de fase aberto e reserva a numeracao para ampliacoes futuras', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }] })
  f.ok('begin-phase-discussion', 'F1')
  const full = structuredClone(f.plan)
  f.plan.tasks.pop(); f.writePlan()
  const before = f.state(), events = f.events()
  f.rejects(/still open/, 'sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Unificar tarefas sem execucao')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.plan.tasks = structuredClone(full.tasks); f.writePlan()
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.plan.tasks.pop(); f.writePlan()
  f.ok('sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Unificar tarefas sem execucao', '--confirm-invalidation')
  f.plan.phases.push({ id: 'F3', title: 'Continuacao aprovada' })
  f.plan.tasks.push({ ...full.tasks[1], id: 'T3', phase: 'F3' }); f.writePlan()
  f.ok('sync-plan', '--plan', f.source)
  assert.ok(f.state().removedTasks.T2)
  assert.equal(f.state().tasks.T3.state, 'pending')
  f.ok('status'); f.ok('ready')
})

for (const decideBy of [{ beforePhase: 'F2' }, { beforeTask: 'T3' }]) test(`remocao preserva pergunta sobre outro trabalho: ${JSON.stringify(decideBy)}`, t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3', phase: 'F2' }] })
  f.planPhase('F1', (value, id) => {
    if (id === 'T2') value.openQuestions = [{ question: 'Qual regra vale para a entrega seguinte?', blocking: false, decideBy }]
  })
  const full = structuredClone(f.plan), before = f.state(), question = before.tasks.T2.taskPlan.openQuestions[0]
  f.plan.tasks = f.plan.tasks.filter(task => task.id !== 'T2'); f.writePlan()
  const events = f.events()
  f.rejects(new RegExp(question.questionRef), 'sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Consolidacao aprovada')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.plan.tasks = full.tasks; f.writePlan()
  f.ok('begin-phase-discussion', 'F2')
  f.ok('finish-phase-discussion', 'F2', '--context', f.discovery('F2', [{
    question: question.question, answer: 'Manter a regra aprovada.', resolvesQuestion: question.questionRef,
  }]))
  const answered = f.state().questionResolutions
  f.plan.tasks = f.plan.tasks.filter(task => task.id !== 'T2'); f.writePlan()
  f.ok('sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Consolidacao aprovada', '--confirm-invalidation')
  assert.deepEqual(f.state().questionResolutions, answered)
  assert.equal(f.state().removedTasks.T2.task.taskPlan.openQuestions[0].questionRef, question.questionRef)
})

test('pergunta ja respondida e escolha do executor nao impedem remocao aprovada', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3', phase: 'F2' }] })
  f.planPhase('F1', (value, id) => {
    if (id === 'T2') value.openQuestions = [
      { question: 'Qual regra vale na fase seguinte?', blocking: false, decideBy: { beforePhase: 'F2' }, answer: 'Preservar a regra aprovada.' },
      { question: 'Qual implementacao interna usar?', blocking: false, decideBy: 'executor' },
    ]
  })
  const before = f.state()
  f.plan.tasks = f.plan.tasks.filter(task => task.id !== 'T2'); f.writePlan()
  f.ok('sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Consolidacao aprovada sem execucao', '--confirm-invalidation')
  assert.deepEqual(f.state().removedTasks.T2.task.taskPlan, before.tasks.T2.taskPlan)
  assert.deepEqual(f.state().tasks.T1, before.tasks.T1)
  f.ok('start', 'T1', '--agent', 'executor')
})

test('remocao aceita registros pendentes legados sem arrays opcionais e arquiva seus campos originais', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }] })
  const imported = f.state()
  delete imported.tasks.T2.discussionAttempts; delete imported.tasks.T2.planningAttempts
  for (const phase of Object.values(imported.phaseWorkflows)) {
    delete phase.discussionAttempts; delete phase.planningAttempts
  }
  f.importState(imported)
  f.plan.tasks.pop(); f.writePlan()
  f.ok('sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Consolidacao aprovada sem execucao')
  assert.deepEqual(f.state().removedTasks.T2.task, imported.tasks.T2)
  assert.deepEqual(f.state().tasks.T1, imported.tasks.T1)
})
