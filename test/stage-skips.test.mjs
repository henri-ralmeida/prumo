import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './fixtures/approved-graph.mjs'

const skip = (f, stages, id = 'T1') => f.ok('skip-stages', id, '--stages', stages, '--reason', 'Decisão explícita sobre esta tarefa', '--confirmed-by-user')
const graph = f => JSON.parse(f.ok('graph'))

for (const phase of [false, true]) for (let mask = 1; mask < 16; mask++) {
  const stages = ['discussion', 'planning', 'execution', 'review'].filter((stage, index) => mask & (1 << index))
  test(`combinação explícita avança somente pelas etapas dispensadas; fase=${phase}; ${stages.join(',')}`, t => {
    const f = fixture(t, { phase })
    skip(f, stages.join(','))
    const expected = !stages.includes('discussion') ? 'ready_for_discussion' : !stages.includes('planning') ? 'ready_to_plan' :
      !stages.includes('execution') ? 'ready' : !stages.includes('review') ? 'ready_for_review' : 'done'
    assert.equal(graph(f).derived.T1.effective, expected)
  })
}

for (const phase of [false, true]) for (const lang of ['en', 'pt-BR']) test(`dispensar quatro etapas conclui por decisão do usuário e libera dependentes; fase=${phase}; ${lang}`, t => {
  const f = fixture(t, { phase, lang, tasks: [{ id: 'T1' }, { id: 'T2', deps: ['T1'] }] })
  const dependent = f.state().tasks.T2
  const before = f.events()
  skip(f, 'discussion,planning,execution,review')
  const state = f.state(), view = graph(f)
  assert.equal(state.tasks.T1.state, 'done')
  assert.equal(state.tasks.T1.completionDecision.by, 'user')
  assert.deepEqual(state.tasks.T1.completionDecision.stages, ['discussion', 'planning', 'execution', 'review'])
  assert.equal(state.tasks.T1.attempts.length, 0)
  assert.equal(state.tasks.T1.validations.length, 0)
  assert.match(f.ok('status'), lang === 'en' ? /completed by user decision/ : /concluída por decisão do usuário/)
  assert.deepEqual(state.tasks.T2, dependent)
  assert.equal(view.derived.T2.effective, 'ready_for_discussion')
  assert.ok(f.events().startsWith(before))
  assert.match(f.events(), /task_stages_skipped/)
  const terminal = f.state(), events = f.events()
  f.rejects(/terminal|concluída/, 'skip-stages', 'T1', '--stages', 'review', '--reason', 'Repetição', '--confirmed-by-user')
  assert.deepEqual(f.state(), terminal); assert.equal(f.events(), events)
})

test('dispensa recusa ausência de confirmação, motivo e etapas inválidas sem gravar', t => {
  const f = fixture(t), before = f.state(), events = f.events()
  const cases = [
    ['--reason', 'Etapas ausentes', '--confirmed-by-user'],
    ['--stages', '', '--reason', 'Etapas vazias', '--confirmed-by-user'],
    ['--stages', 'execution', '--reason', 'Escolha ainda não confirmada'],
    ['--stages', 'execution', '--confirmed-by-user'],
    ['--stages', 'execution,unknown', '--reason', 'Inválido', '--confirmed-by-user'],
    ['--stages', 'execution,execution', '--reason', 'Duplicado', '--confirmed-by-user'],
    ['--stages', 'review', '--reason', 'Forçar não confirma', '--force'],
  ]
  for (const args of cases) {
    assert.notEqual(f.cli('skip-stages', 'T1', ...args).status, 0)
    assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  }
  assert.notEqual(f.cli('skip-stages', '--stages', 'execution', '--reason', 'Tarefa ausente', '--confirmed-by-user').status, 0)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
})

test('dispensar execução avança para revisão real sem inventar executor', t => {
  const f = fixture(t)
  skip(f, 'discussion,planning')
  assert.equal(graph(f).derived.T1.effective, 'ready')
  f.ok('skip-execution', 'T1', '--reason', 'Entrega realizada fora do Prumo', '--confirmed-by-user')
  assert.equal(graph(f).derived.T1.effective, 'ready_for_review')
  assert.equal(f.state().tasks.T1.attempts.length, 0)
  f.rejects(/dispensed|dispensada/, 'start', 'T1', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'reviewer')
  assert.equal(f.state().tasks.T1.state, 'reviewing')
  assert.equal(f.state().tasks.T1.attempts[0].agent, null)
  assert.deepEqual(f.state().tasks.T1.attempts[0].modelDispatches.map(item => item.role), ['review'])
  assert.doesNotMatch(f.events(), /"type":"task_start"/)
  f.ok('validate', 'T1', '--ok', '--cwd', f.project, '--evidence', 'Revisão independente da entrega existente')
  f.ok('done', 'T1')
  assert.equal(f.state().tasks.T1.state, 'done')
  assert.equal(f.state().tasks.T1.validations[0].by, 'review')
  assert.equal(f.state().tasks.T1.completionDecision, undefined)
})

test('dispensar revisão aguarda execução e conclui após o trabalho parar', t => {
  const f = fixture(t)
  f.skipTaskPlan()
  f.ok('skip-review', 'T1', '--reason', 'Aceite explícito sem revisão', '--confirmed-by-user')
  assert.equal(f.state().tasks.T1.state, 'pending')
  f.rejects(/Review is dispensed/, 'review', 'T1', '--agent', 'reviewer')
  f.ok('start', 'T1', '--agent', 'executor')
  assert.equal(f.state().tasks.T1.state, 'running')
  f.ok('activity-start', 'T1', '--role', 'execution', '--agent', 'executor')
  assert.equal(f.state().tasks.T1.state, 'running')
  f.ok('activity-stop', 'T1', '--role', 'execution', '--agent', 'executor')
  const task = f.state().tasks.T1
  assert.equal(task.state, 'done')
  assert.equal(task.completionDecision.by, 'user')
  assert.deepEqual(task.completionDecision.stages, ['discussion', 'planning', 'review'])
  assert.equal(task.validations.length, 0)
})

test('dispensar execução mantém discussão e planejamento que ainda não foram dispensados', t => {
  const f = fixture(t)
  f.ok('skip-execution', 'T1', '--reason', 'Somente execução dispensada', '--confirmed-by-user')
  f.rejects(/still requires discussion and planning/, 'review', 'T1', '--agent', 'reviewer')
  f.ok('skip-discussion', 'T1', '--reason', 'Discussão dispensada depois', '--confirmed-by-user')
  f.rejects(/still requires discussion and planning/, 'review', 'T1', '--agent', 'reviewer')
  f.ok('skip-planning', 'T1', '--reason', 'Planejamento dispensado depois', '--confirmed-by-user')
  f.ok('review', 'T1', '--agent', 'reviewer')
  assert.equal(f.state().tasks.T1.state, 'reviewing')
})

test('dispensar nova execução preserva a independência diante do último autor conhecido', t => {
  const f = fixture(t)
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'author')
  f.ok('fail', 'T1', '--reason', 'A entrega existente precisa de revisão')
  skip(f, 'discussion,planning,execution')
  const before = f.state(), events = f.events()
  f.rejects(/different agent|agente diferente/, 'review', 'T1', '--agent', 'author')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('review', 'T1', '--agent', 'reviewer')
  assert.equal(f.state().tasks.T1.agent, 'author')
  assert.equal(f.state().tasks.T1.attempts.at(-1).kind, 'review-only')
  assert.equal(f.state().tasks.T1.attempts.at(-1).agent, null)
  f.ok('fail', 'T1', '--reason', 'Outra rodada de revisão da mesma entrega')
  skip(f, 'discussion,planning,execution')
  f.rejects(/different agent|agente diferente/, 'review', 'T1', '--agent', 'author')
  f.ok('review', 'T1', '--agent', 'another-reviewer')
})

test('dispensa da próxima tentativa usa sua própria rodada após revisão refeita e falha', t => {
  const f = fixture(t)
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'author'); f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('redo-review', 'T1', '--agent', 'reviewer-2', '--reason', 'Nova conferência solicitada', '--confirmed-by-user')
  f.ok('fail', 'T1', '--reason', 'Revisão interrompida')
  skip(f, 'discussion,planning,execution')
  f.ok('review', 'T1', '--agent', 'reviewer-3')
  assert.ok(graph(f).derived.T1.currentStageSkips.some(decision => decision.stages.includes('execution')))
})

for (const stage of ['discussion', 'planning']) test(`dispensa encerra somente a etapa individual ativa de ${stage} e preserva o histórico`, t => {
  const f = fixture(t)
  if (stage === 'planning') f.ok('skip-discussion', 'T1', '--reason', 'Escopo já discutido', '--confirmed-by-user')
  f.ok(stage === 'discussion' ? 'begin-discussion' : 'plan-task', 'T1', '--agent', 'worker')
  skip(f, stage === 'discussion' ? 'discussion,planning,execution,review' : 'planning,execution,review')
  const task = f.state().tasks.T1, history = task[stage === 'discussion' ? 'discussionAttempts' : 'planningAttempts']
  assert.equal(task.state, 'done'); assert.equal(task.completionDecision.by, 'user')
  assert.equal(history.length, 1); assert.equal(history[0].result, 'skipped'); assert.ok(history[0].endedAt)
  assert.equal(task.attempts.length, 0)
})

test('dispensar execução ativa encerra sua atividade e entrega a mesma tentativa à revisão', t => {
  const f = fixture(t)
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor')
  f.ok('activity-start', 'T1', '--role', 'execution', '--agent', 'executor')
  f.ok('skip-execution', 'T1', '--reason', 'Usuário encerrou a implementação atual', '--confirmed-by-user')
  assert.equal(graph(f).derived.T1.effective, 'ready_for_review')
  assert.ok(f.state().tasks.T1.attempts[0].activityIntervals[0].endedAt)
  f.ok('review', 'T1', '--agent', 'reviewer')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
  assert.equal(f.state().tasks.T1.attempts[0].agent, 'executor')
  assert.equal(f.state().tasks.T1.attempts[0].kind, undefined)
})

test('dispensa futura de planejamento aguarda e aproveita a discussão normal da fase', t => {
  const f = fixture(t, { phase: true })
  f.ok('begin-phase-discussion', 'F1')
  skip(f, 'planning')
  assert.equal(f.state().phaseWorkflows.F1.state, 'discussing')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  assert.equal(graph(f).derived.T1.effective, 'ready')
  assert.equal(f.state().tasks.T1.planningSkips.length, 1)
  assert.equal(f.state().tasks.T1.discussionSkips.length, 0)
})

test('dispensa futura de execução preserva o planejador ativo até entregar seu plano', t => {
  const f = fixture(t, { phase: true })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Escopo aprovado pelo usuário', '--confirmed-by-user')
  f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans)
  const round = f.state().phaseWorkflows.F1.planningAttempts.at(-1)
  skip(f, 'execution')
  assert.equal(f.state().phaseWorkflows.F1.state, 'planning')
  assert.deepEqual(f.state().phaseWorkflows.F1.planningAttempts.at(-1), round)
  f.artifacts('F1'); f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  assert.equal(graph(f).derived.T1.effective, 'ready_for_review')
})

test('dispensa aguarda a confirmação da fase da tarefa sem bloquear outra tarefa autorizada', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2', deps: ['T1'] }] })
  skip(f, 'discussion,planning,execution,review', 'T2')
  const state = f.state()
  state.phaseWorkflows.F1.contractConfirmationRequired = { tasks: ['T2'] }
  f.importState(state)
  skip(f, 'discussion,planning,execution,review', 'T1')
  assert.equal(f.state().tasks.T1.state, 'done')
  assert.equal(f.state().tasks.T2.state, 'pending')
  assert.equal(f.state().tasks.T2.completionDecision, undefined)
  assert.equal(f.state().tasks.T2.stageSkips.length, 1)
})

test('dispensas futuras aguardam dependências sem dispensar outras tarefas', t => {
  const f = fixture(t, { tasks: [{ id: 'T1' }, { id: 'T2', deps: ['T1'] }] })
  skip(f, 'discussion,planning,execution,review', 'T2')
  assert.equal(f.state().tasks.T1.state, 'pending')
  assert.equal(f.state().tasks.T2.state, 'pending')
  skip(f, 'discussion,planning,execution,review', 'T1')
  assert.equal(f.state().tasks.T1.state, 'done')
  assert.equal(f.state().tasks.T2.state, 'done')
})

test('dependente executa com entrada aceita pelo usuário sem recibo de revisão fictício', t => {
  const f = fixture(t, { tasks: [{ id: 'T1' }, { id: 'T2', deps: ['T1'] }] })
  skip(f, 'discussion,planning,execution,review')
  f.skipTaskPlan('T2'); f.ok('start', 'T2', '--agent', 'executor')
  const receipt = f.state().tasks.T2.attempts[0].inputReceipt[0]
  assert.equal(receipt.result, 'user-accepted')
  assert.deepEqual(receipt.stages, ['discussion', 'planning', 'execution', 'review'])
  const brief = JSON.parse(f.ok('brief', 'T2', '--role', 'executor'))
  assert.equal(brief.dependencyDeliveries[0].completionDecision.by, 'user')
  assert.equal(brief.dependencyDeliveries[0].terminalReceipt, null)
})

test('dispensas futuras concluem depois das decisões de discussão e planejamento', t => {
  const f = fixture(t)
  skip(f, 'execution,review')
  assert.equal(graph(f).derived.T1.effective, 'ready_for_discussion')
  f.ok('skip-discussion', 'T1', '--reason', 'Escopo já discutido', '--confirmed-by-user')
  assert.equal(graph(f).derived.T1.effective, 'ready_to_plan')
  f.ok('skip-planning', 'T1', '--reason', 'Procedimento já conhecido', '--confirmed-by-user')
  assert.equal(f.state().tasks.T1.state, 'done')
  assert.deepEqual(f.state().tasks.T1.completionDecision.stages, ['discussion', 'planning', 'execution', 'review'])
})

test('decisão explícita de dispensar revisão preserva a reprovação anterior', t => {
  const f = fixture(t)
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('validate', 'T1', '--failed', '--evidence', 'Critério não atendido')
  const receipts = f.state().tasks.T1.validations
  f.ok('skip-review', 'T1', '--reason', 'Usuário aceitou a entrega sem nova revisão', '--confirmed-by-user')
  assert.equal(f.state().tasks.T1.state, 'done')
  assert.deepEqual(f.state().tasks.T1.validations, receipts)
  assert.equal(f.state().tasks.T1.validations.at(-1).ok, false)
})

test('dispensar quatro etapas depois de falha preserva a tentativa sem criar outra execução', t => {
  const f = fixture(t)
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor'); f.ok('fail', 'T1', '--reason', 'Trabalho interrompido')
  const attempts = f.state().tasks.T1.attempts
  skip(f, 'discussion,planning,execution,review')
  assert.equal(f.state().tasks.T1.state, 'done')
  assert.deepEqual(f.state().tasks.T1.attempts, attempts)
})

test('dispensa não resolve bloqueio externo ou pausa nem aceita outro contrato', t => {
  const f = fixture(t)
  const args = ['skip-stages', 'T1', '--stages', 'discussion,planning,execution,review', '--reason', 'Decisão limitada às etapas', '--confirmed-by-user', '--force']
  f.ok('block', 'T1', '--reason', 'Decisão externa pendente')
  let before = f.state(), events = f.events()
  f.rejects(/blocked|bloqueada/, ...args)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('unblock', 'T1'); f.ok('pause-run', '--reason', 'Aguardar usuário')
  before = f.state(); events = f.events()
  f.rejects(/paused|pausada/, ...args)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('resume-run')
  f.plan.tasks[0].title = 'Outro contrato'; f.writePlan(); f.ok('sync-plan', '--plan', f.source, '--propose')
  before = f.state(); events = f.events()
  f.rejects(/contract confirmation|confirmação/, ...args)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
})

for (const stage of ['discussion', 'planning']) for (const count of [1, 2]) test(`dispensa de etapa ativa conserva os outros alvos da fase; ${stage}; ${count}`, t => {
  const f = fixture(t, { phase: true, tasks: count === 1 ? [{ id: 'T1' }] : [{ id: 'T1' }, { id: 'T2' }] })
  f.ok('begin-phase-discussion', 'F1')
  if (stage === 'planning') {
    f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
    f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans)
  }
  const other = f.state().tasks.T2
  skip(f, stage)
  const state = f.state(), round = state.phaseWorkflows.F1[stage === 'discussion' ? 'discussionAttempts' : 'planningAttempts'].at(-1)
  assert.deepEqual(round.targets, count === 1 ? [] : ['T2'])
  assert.ok(round.workers.T1.endedAt)
  assert.equal(round.workers.T1.result, 'skipped')
  assert.deepEqual(state.tasks.T2, other)
  if (count === 1) { assert.equal(round.result, 'superseded'); assert.equal(state.phaseWorkflows.F1.state, 'pending') }
  assert.equal(graph(f).derived.T1.effective, stage === 'discussion' ? 'ready_to_plan' : 'ready')
})

test('dispensar etapa futura não cancela o agente de outra etapa', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }] })
  f.ok('begin-phase-discussion', 'F1')
  const round = f.state().phaseWorkflows.F1.discussionAttempts.at(-1)
  skip(f, 'planning')
  assert.deepEqual(f.state().phaseWorkflows.F1.discussionAttempts.at(-1), round)
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  assert.equal(graph(f).derived.T1.effective, 'ready')
  assert.equal(graph(f).derived.T2.effective, 'ready_to_plan')
})

test('dispensa de revisão recusa alterações observadas fora do escopo aprovado', t => {
  const f = fixture(t, { git: true, tasks: [{ id: 'T1', writeScope: 'files', touches: ['approved.txt'] }] })
  f.plan.scopePolicy = 'explicit'; f.writePlan()
  const state = f.state(); state.plan.scopePolicy = 'explicit'; f.importState(state)
  f.skipTaskPlan(); f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('activity-start', 'T1', '--role', 'execution', '--agent', 'executor')
  f.ok('activity-stop', 'T1', '--role', 'execution', '--agent', 'executor')
  writeFileSync(join(f.project, 'outside.txt'), 'Alteração não autorizada')
  const before = f.state(), events = f.events()
  f.rejects(/outside approved touches/, 'skip-review', 'T1', '--reason', 'Dispensar revisão não amplia escopo', '--confirmed-by-user', '--force')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
})

for (const stage of ['discussion', 'planning']) test(`dispensa libera a vaga do alvo escolhido e mantém a fila dos outros agentes; ${stage}`, t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }] })
  if (stage === 'planning') {
    f.ok('begin-phase-discussion', 'F1')
    f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  }
  f.ok('set-agent-limit', '--max', '1', '--actor', 'user', '--confirmed-by-user')
  if (stage === 'discussion') f.ok('begin-phase-discussion', 'F1')
  else f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans)
  const key = stage === 'discussion' ? 'discussionAttempts' : 'planningAttempts'
  assert.deepEqual(f.state().phaseWorkflows.F1[key].at(-1).queuedTargets, ['T2'])
  skip(f, stage)
  const round = f.state().phaseWorkflows.F1[key].at(-1)
  assert.deepEqual(round.targets, ['T2'])
  assert.deepEqual(round.activeTargets, ['T2'])
  assert.deepEqual(round.queuedTargets, [])
  assert.ok(round.workers.T1.endedAt)
  assert.equal(round.workers.T2.endedAt, undefined)
})

test('sem dispensa explícita a tarefa mantém execução, validação e revisão obrigatórias', t => {
  const f = fixture(t)
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor')
  const before = f.state(), events = f.events()
  f.rejects(/validate first/, 'done', 'T1', '--force')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('validate', 'T1', '--ok', '--cwd', f.project, '--evidence', 'Conferência independente do contrato')
  f.ok('done', 'T1')
  assert.equal(f.state().tasks.T1.state, 'done')
  assert.equal(f.state().tasks.T1.completionDecision, undefined)
})

test('planejamento de fase distingue entrada aceita pelo usuário de entrada validada', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2', deps: ['T1'] }] })
  f.planPhase('F1')
  skip(f, 'execution,review')
  assert.equal(graph(f).derived.T2.inputStatus, 'user_accepted_input')
  f.ok('start', 'T2', '--agent', 'executor')
  assert.equal(f.state().tasks.T2.attempts.at(-1).inputReceipt[0].result, 'user-accepted')
})

for (const lang of ['en', 'pt-BR']) test(`dispensa explica a confirmação obrigatória no idioma selecionado; ${lang}`, t => {
  const f = fixture(t, { lang }), before = f.state(), events = f.events()
  f.rejects(lang === 'en' ? /after the user explicitly chooses/ : /após o usuário escolher explicitamente/, 'skip-review', 'T1', '--reason', 'Ainda sem confirmação')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
})

test('revisão após dispensa respeita limite de agentes e confirmação manual', t => {
  const f = fixture(t, { tasks: [{ id: 'T1' }, { id: 'T2' }] })
  f.ok('set-agent-limit', '--max', '1', '--actor', 'user', '--confirmed-by-user')
  f.skipTaskPlan('T2'); f.ok('start', 'T2', '--agent', 'busy')
  skip(f, 'discussion,planning,execution')
  assert.match(f.ok('ready'), /Wait for an agent slot before reviewing T1/)
  const before = f.state(), events = f.events()
  assert.notEqual(f.cli('review', 'T1', '--agent', 'reviewer').status, 0)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('block', 'T2', '--reason', 'Pausa explícita do executor ocupado')
  f.ok('authorize', '--scope', 'tasks:T1', '--mode', 'manual', '--confirmed-by-user')
  assert.match(f.ok('ready'), /ask user before dispatching T1/)
  f.rejects(/confirmed-by-user/, 'review', 'T1', '--agent', 'reviewer')
  f.ok('review', 'T1', '--agent', 'reviewer', '--confirmed-by-user')
  assert.equal(f.state().tasks.T1.state, 'reviewing')
})

test('contrato alterado invalida a dispensa anterior e dispensar execução não autoriza a revisão', t => {
  const f = fixture(t)
  f.ok('skip-review', 'T1', '--reason', 'Aceite apenas do contrato anterior', '--confirmed-by-user')
  f.plan.tasks[0].validation = [{ ...f.plan.tasks[0].validation[0], run: 'node --version' }]
  f.writePlan(); f.ok('refresh-contract', 'T1', '--plan', f.source)
  assert.equal(graph(f).derived.T1.currentStageSkips.length, 0)
  skip(f, 'discussion,planning,execution')
  assert.match(f.ok('ready'), /ask user to authorize.*tasks:T1/)
  const before = f.state(), events = f.events()
  f.rejects(/authoriz/, 'review', 'T1', '--agent', 'reviewer', '--confirmed-by-user')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.ok('review', 'T1', '--agent', 'reviewer')
  assert.equal(f.state().tasks.T1.state, 'reviewing')
})
