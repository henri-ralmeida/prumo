import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fixture, check } from './fixtures/approved-graph.mjs'

const changed = 'Novo comportamento material aprovado'

function reviewedWithSkippedPhasePlanning(t, options = {}) {
  const f = fixture(t, { phase: true, ...options })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Contrato aprovado', '--confirmed-by-user')
  f.ok('skip-phase-planning', 'F1', '--reason', 'Contrato suficiente', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  return f
}

function changeExpect(f, expect = changed) {
  f.plan.tasks[0].validation = [{ ...check, expect }]; f.writePlan()
  f.ok('refresh-contract', 'T1', '--plan', f.source)
}

// Executa a discussão e o planejamento individuais da tarefa pausada, como a recusa do validate orienta.
function discussAndPlanTask(f, expect = changed) {
  f.ok('begin-discussion', 'T1')
  const round = f.state().tasks.T1.discussionAttempts.at(-1), context = join(f.home, 'task-discovery.json')
  writeFileSync(context, JSON.stringify({ roundId: round.roundId, nonce: round.nonce,
    research: [{ source: 'Contrato aprovado', findings: 'Criterio alterado conferido.' }],
    questions: [{ question: 'Preservar o escopo?', answer: 'Sim.', channel: 'chat-fallback', round: 1, roundId: round.roundId }],
    coverage: Object.fromEntries(['problem', 'affected', 'outcome', 'currentBehavior', 'desiredBehavior', 'rules', 'exceptions', 'scope', 'acceptance']
      .map(key => [key, 'Preservar o comportamento aprovado e a revisao independente.'])),
    decisions: [], deferred: [], executionBoundary: { deferredToExecutor: ['T1'], prematureTaskWork: [] }, closure: 'Decisoes respondidas.' }))
  f.ok('finish-discussion', 'T1', '--context', context)
  f.ok('plan-task', 'T1', '--agent', 'planner')
  const plan = join(f.home, 'task-plan.json')
  writeFileSync(plan, JSON.stringify({ research: [{ source: 'Contrato', findings: 'Entrega e criterio conferidos.' }], decisions: [],
    steps: ['Entregar o comportamento e conferir o criterio aprovado.'], verification: [{ criterion: expect, check: 1 }], openQuestions: [] }))
  f.ok('finish-planning', 'T1', '--plan', plan)
}

for (const lang of ['en', 'pt-BR']) test(`validate recusa criterio alterado com a sequencia de comandos que de fato funciona em fase (${lang})`, t => {
  const f = reviewedWithSkippedPhasePlanning(t, { lang })
  changeExpect(f)
  const before = f.state(), events = f.events()
  const message = f.rejects(lang === 'en' ? /execution scope needs current planning/ : /exige planejamento atualizado/,
    'validate', 'T1', '--ok', '--evidence', 'Dispensa antiga nao aprova criterio novo', '--cwd', f.project)
  assert.match(message, lang === 'en'
    ? /phase planning: run pause-replanning T1 --reason <reason>, then begin-discussion, finish-discussion, plan-task and finish-planning for T1; ask the user to accept the changed contract \(authorize --scope tasks:T1 --confirmed-by-user\) and unblock T1 explicitly/
    : /planejamento por fase: execute pause-replanning T1 --reason <motivo>, depois begin-discussion, finish-discussion, plan-task e finish-planning de T1; peça ao usuário que aceite o contrato alterado \(authorize --scope tasks:T1 --confirmed-by-user\) e desbloqueie T1 explicitamente/)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  // O beco sem saida antigo: sem pause-replanning, os comandos individuais continuam recusados em fase.
  f.rejects(/use plan-phase/, 'plan-task', 'T1', '--agent', 'planner')

  f.ok('pause-replanning', 'T1', '--reason', 'O criterio de aceite mudou')
  discussAndPlanTask(f)
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.ok('unblock', 'T1')
  assert.equal(f.state().tasks.T1.state, 'reviewing')
  assert.equal(f.state().tasks.T1.reviewer, 'reviewer')
  f.ok('validate', 'T1', '--ok', '--evidence', 'Criterio atual conferido pelo revisor independente', '--cwd', f.project)
  f.ok('done', 'T1')
  const task = f.state().tasks.T1
  assert.equal(task.state, 'done')
  assert.equal(task.attempts.length, 1)
  assert.equal(task.validations.at(-1).ok, true)
})

test('a sequencia indicada nao libera validate nem unblock sem planejamento atual e aceite do contrato', t => {
  const f = reviewedWithSkippedPhasePlanning(t)
  changeExpect(f)
  f.ok('pause-replanning', 'T1', '--reason', 'O criterio de aceite mudou')
  f.rejects(/not running or reviewing/, 'validate', 'T1', '--ok', '--evidence', 'Nao valida bloqueada', '--cwd', f.project)
  f.rejects(/no execution authorization/, 'unblock', 'T1')
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  // Com o planejamento individual habilitado, a mensagem de tarefa continua correta e o unblock segue recusado.
  const before = f.state(), events = f.events()
  const message = f.rejects(/keep work blocked, run plan-task and finish-planning/, 'unblock', 'T1')
  assert.doesNotMatch(message, /pause-replanning/)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  discussAndPlanTask(f)
  f.ok('unblock', 'T1')
  assert.equal(f.state().tasks.T1.state, 'reviewing')
})

test('novo criterio alterado depois do replanejamento individual mantem a mensagem de tarefa', t => {
  const f = reviewedWithSkippedPhasePlanning(t)
  changeExpect(f)
  f.ok('pause-replanning', 'T1', '--reason', 'O criterio de aceite mudou')
  discussAndPlanTask(f)
  f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user'); f.ok('unblock', 'T1')
  f.plan.tasks[0].validation = [{ ...check, expect: changed }, { ...check, expect: 'Segundo criterio obrigatorio' }]; f.writePlan()
  f.ok('refresh-contract', 'T1', '--plan', f.source)
  const message = f.rejects(/execution scope needs current planning/, 'validate', 'T1', '--ok', '--evidence', 'Criterio antigo nao vale', '--cwd', f.project)
  assert.match(message, /keep work blocked, run plan-task and finish-planning, then unblock explicitly/)
  assert.doesNotMatch(message, /pause-replanning/)
})

test('execucao com planejamento por tarefa mantem a mensagem de plan-task', t => {
  const f = fixture(t)
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  changeExpect(f)
  const message = f.rejects(/execution scope needs current planning/, 'validate', 'T1', '--ok', '--evidence', 'Criterio antigo nao vale', '--cwd', f.project)
  assert.match(message, /keep work blocked, run plan-task and finish-planning, then unblock explicitly/)
  assert.doesNotMatch(message, /pause-replanning/)
})
