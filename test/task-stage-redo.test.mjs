import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixture, check } from './fixtures/approved-graph.mjs'

function planned(t, { phase = true, lang = 'en', maxAttempts } = {}) {
  const f = fixture(t, { phase, lang, tasks: [{ id: 'T1', ...(maxAttempts ? { maxAttempts } : {}) }, { id: 'T2' }] })
  if (phase) f.planPhase('F1')
  else {
    f.ok('skip-discussion', 'T1', '--reason', 'Contrato aprovado suficiente', '--confirmed-by-user')
    f.ok('plan-task', 'T1', '--agent', 'planner')
    const path = join(f.plans, 'task-plan.json')
    writeFileSync(path, JSON.stringify({ research: [{ source: 'Contrato', findings: 'Critério conferido' }], decisions: [],
      steps: ['Entregar e verificar o comportamento'], verification: [{ criterion: check.expect, check: 1 }], openQuestions: [] }))
    f.ok('finish-planning', 'T1', '--plan', path)
  }
  f.ok('start', 'T1', '--agent', 'executor')
  return f
}

function approve(f, reviewer = 'reviewer') {
  if (f.state().tasks.T1.state === 'running') f.ok('review', 'T1', '--agent', reviewer)
  const total = f.state().tasks.T1.attempts.at(-1).reviewProgress.total
  for (let step = 1; step <= total; step++) f.ok('review-progress', 'T1', '--step', String(step), '--agent', reviewer)
  f.ok('validate', 'T1', '--ok', '--evidence', 'Revisor independente conferiu a entrega', '--cwd', f.project)
}

for (const phase of [true, false]) test(`refazer execução preserva o plano aprovado e abre outra tentativa somente no start: fase=${phase}`, t => {
  const f = planned(t, { phase }), before = f.state()
  f.ok('redo-execution', 'T1', '--reason', 'Usuário quer repetir a execução', '--confirmed-by-user')
  const restarted = f.state().tasks.T1
  assert.equal(restarted.state, 'pending')
  assert.equal(restarted.attempts.length, 1)
  assert.equal(restarted.attempts[0].result, 'cancelled')
  assert.equal(restarted.attempts[0].redoRequest.confirmedByUser, true)
  assert.deepEqual(restarted.taskPlan, before.tasks.T1.taskPlan)
  assert.deepEqual(f.state().tasks.T2, before.tasks.T2)
  const history = structuredClone(restarted.attempts[0])
  f.ok('start', 'T1', '--agent', 'executor-2')
  assert.equal(f.state().tasks.T1.attempts[1].redoOf, 1)
  assert.equal(f.state().tasks.T1.attempts[1].planSourceAttempt, 1)
  assert.deepEqual(f.state().tasks.T1.attempts[0], history)
  f.ok('redo-execution', 'T1', '--reason', 'Outra repetição explicitamente solicitada', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor-3')
  assert.equal(f.state().tasks.T1.attempts[2].redoOf, 2)
  assert.equal(f.state().tasks.T1.attempts[2].planSourceAttempt, 1)
  assert.deepEqual(f.state().tasks.T1.attempts[0], history)
  assert.deepEqual(f.state().tasks.T2, before.tasks.T2)
  approve(f); f.ok('done', 'T1')
})

for (const lang of ['en', 'pt-BR']) test(`refazer revisão preserva entrega e parecer anterior, exigindo novo aceite: ${lang}`, t => {
  const f = planned(t, { lang }); approve(f)
  const before = f.state(), receipt = before.tasks.T1.validations.at(-1)
  f.ok('redo-review', 'T1', '--agent', 'reviewer-2', '--reason', 'Usuário pediu uma nova conferência', '--confirmed-by-user')
  const current = f.state().tasks.T1
  assert.equal(current.state, 'reviewing')
  assert.equal(current.attempts.length, 1)
  assert.equal(current.attempts[0].reviewRound, 2)
  assert.equal(current.attempts[0].reviewRoundHistory.length, 1)
  assert.equal(current.attempts[0].reviewProgress.traversed, 0)
  assert.equal(current.reviewer, 'reviewer-2')
  assert.deepEqual(current.validations.slice(0, before.tasks.T1.validations.length), before.tasks.T1.validations)
  assert.equal(current.validations.at(-1).ok, false)
  assert.equal(current.validations.at(-1).kind, 'review-reset')
  assert.equal(current.validations.at(-1).by, 'user')
  assert.equal(current.validations.at(-1).checks, undefined)
  assert.notEqual(current.validations.at(-1).token, receipt.token)
  assert.deepEqual(current.taskPlan, before.tasks.T1.taskPlan)
  assert.deepEqual(f.state().tasks.T2, before.tasks.T2)
  f.rejects(/review|revisão|validation|validação/, 'done', 'T1')
  approve(f, 'reviewer-2')
  assert.equal(f.state().tasks.T1.validations.at(-1).reviewRound, 2)
  f.ok('done', 'T1')
  const terminal = f.state(), events = f.events()
  for (const command of ['redo-execution', 'redo-review'])
    f.rejects(/active|andamento|running|reviewing|concluíd/, command, 'T1', '--reason', 'Histórico concluído é imutável', '--confirmed-by-user')
  assert.deepEqual(f.state(), terminal); assert.equal(f.events(), events)
})

test('refazer etapa exige motivo e confirmação, respeita limites e mantém revisão independente', t => {
  const f = planned(t)
  let before = f.state(), events = f.events()
  f.rejects(/reason/, 'redo-execution', 'T1', '--confirmed-by-user')
  f.rejects(/confirmed-by-user/, 'redo-execution', 'T1', '--reason', 'Sem confirmação')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('review', 'T1', '--agent', 'reviewer')
  before = f.state(); events = f.events()
  f.rejects(/reason/, 'redo-review', 'T1', '--confirmed-by-user')
  f.rejects(/confirmed-by-user/, 'redo-review', 'T1', '--reason', 'Sem confirmação')
  f.rejects(/independent|different|independente/, 'redo-review', 'T1', '--agent', 'executor', '--reason', 'Autor não aprova a própria entrega', '--confirmed-by-user', '--force')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  const limited = planned(t, { maxAttempts: 1 }), capped = limited.state(), cappedEvents = limited.events()
  limited.rejects(/cap|limite|attempt/, 'redo-execution', 'T1', '--reason', 'Limite continua válido', '--confirmed-by-user')
  assert.deepEqual(limited.state(), capped); assert.equal(limited.events(), cappedEvents)
})

test('refazer execução a partir de revisão não reaproveita o parecer anterior', t => {
  const f = planned(t); approve(f)
  const previous = f.state().tasks.T1.validations.at(-1)
  f.ok('redo-execution', 'T1', '--reason', 'Repetir a entrega por decisão do usuário', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor-2')
  assert.deepEqual(f.state().tasks.T1.validations.at(-1), previous)
  f.rejects(/current attempt|tentativa|validation|validação/, 'done', 'T1')
  approve(f, 'reviewer-2'); f.ok('done', 'T1')
})

test('refazer revisão executa os testes novamente sem reutilizar o cache da rodada anterior', t => {
  const cached = { kind: 'static', run: 'node counter.cjs', expect: 'Registrar a conferência estática', cacheable: true, cachePaths: ['counter.cjs'] }
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1', validation: [check, cached] }] })
  writeFileSync(join(f.project, 'counter.cjs'), "require('node:fs').appendFileSync('../checks-count', 'x')\n")
  f.planPhase('F1', artifact => artifact.verification.push({ criterion: cached.expect, check: 2 }))
  f.ok('start', 'T1', '--agent', 'executor'); approve(f)
  assert.equal(readFileSync(join(f.home, 'checks-count'), 'utf8'), 'x')
  f.ok('redo-review', 'T1', '--reason', 'Nova revisão precisa de nova evidência', '--confirmed-by-user')
  f.rejects(/restarted|revisão|validation/, 'done', 'T1')
  approve(f)
  assert.equal(readFileSync(join(f.home, 'checks-count'), 'utf8'), 'xx')
})

test('refazer execução preserva dispensa vigente e recusa vínculo de reuso sem a decisão do usuário', t => {
  const skipped = fixture(t, { phase: true })
  skipped.skipTaskPlan(); skipped.ok('start', 'T1', '--agent', 'executor')
  const waivers = skipped.state().tasks.T1.planningSkips
  skipped.ok('redo-execution', 'T1', '--reason', 'Repetir com o mesmo contrato', '--confirmed-by-user')
  skipped.ok('start', 'T1', '--agent', 'executor-2')
  assert.deepEqual(skipped.state().tasks.T1.planningSkips, waivers)
  assert.equal(skipped.state().tasks.T1.attempts[1].redoOf, 1)
  const f = planned(t)
  f.ok('redo-execution', 'T1', '--reason', 'Refazer uma entrega aprovada', '--confirmed-by-user')
  const state = f.state(); state.tasks.T1.attempts[0].redoRequest.confirmedByUser = false; f.importState(state)
  f.rejects(/planning|planejamento/, 'start', 'T1', '--agent', 'executor-2')
  assert.deepEqual(f.state(), state)
})

test('refazer etapas não contorna bloqueio externo, pausa da execução nem contrato proposto', t => {
  const f = planned(t)
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('block', 'T1', '--reason', 'Aguardando decisão externa')
  let before = f.state(), events = f.events()
  for (const command of ['redo-execution', 'redo-review'])
    f.rejects(/blocked|bloquead/, command, 'T1', '--reason', 'Manter controle externo', '--confirmed-by-user')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('unblock', 'T1'); f.ok('pause-run', '--reason', 'Pausa explícita do usuário')
  before = f.state(); events = f.events()
  for (const command of ['redo-execution', 'redo-review'])
    f.rejects(/paused|pausad/, command, 'T1', '--reason', 'Não retomar implicitamente', '--confirmed-by-user')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('resume-run')
  f.plan.tasks[0].title = 'Novo contrato ainda sem aceite'; f.writePlan()
  before = f.state(); events = f.events()
  f.rejects(/contract differs|contrato/, 'redo-execution', 'T1', '--reason', 'Fonte ainda não sincronizada', '--confirmed-by-user')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('sync-plan', '--plan', f.source, '--propose', '--confirm-invalidation')
  before = f.state(); events = f.events()
  f.rejects(/Proposed contract|contrato proposto/, 'redo-review', 'T1', '--reason', 'Refazer não aceita outro contrato', '--confirmed-by-user')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('redo-execution', 'T1', '--reason', 'Encerrar a tentativa anterior sem aceitar outro contrato', '--confirmed-by-user')
  const pending = f.state(), pendingEvents = f.events()
  assert.equal(pending.tasks.T1.state, 'pending')
  assert.deepEqual(pending.tasks.T1.contractConfirmationRequired, before.tasks.T1.contractConfirmationRequired)
  assert.deepEqual(pending.phaseWorkflows.F1.contractConfirmationRequired, before.phaseWorkflows.F1.contractConfirmationRequired)
  assert.deepEqual(pending.tasks.T2, before.tasks.T2)
  f.rejects(/Proposed contract|contrato proposto/, 'start', 'T1', '--agent', 'executor-2')
  assert.deepEqual(f.state(), pending); assert.equal(f.events(), pendingEvents)
})

test('refazer revisão recusa entrega alterada e não reverte seus arquivos', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1', touches: ['entrega.txt'] }] })
  const path = join(f.project, 'entrega.txt')
  writeFileSync(path, 'Entrega inicial')
  f.planPhase('F1'); f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  writeFileSync(path, 'Entrega alterada')
  const before = f.state(), events = f.events()
  f.rejects(/delivery changed|entrega.*mudou/, 'redo-review', 'T1', '--reason', 'Revisão não substitui nova execução', '--confirmed-by-user')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  assert.equal(readFileSync(path, 'utf8'), 'Entrega alterada')
})

test('nova rodada recusa validação que começou na rodada anterior, mesmo com o mesmo revisor', async t => {
  const f = fixture(t, { phase: true })
  writeFileSync(join(f.project, 'check.cjs'), "const fs=require('node:fs'); fs.writeFileSync('../validation-started','x'); const until=Date.now()+20000; while(!fs.existsSync('../validation-release') && Date.now()<until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25); if(!fs.existsSync('../validation-release')) process.exit(1)\n")
  f.planPhase('F1'); f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  const engine = fileURLToPath(new URL('../scripts/engine.mjs', import.meta.url))
  const child = spawn(process.execPath, [engine, 'validate', 'T1', '--ok', '--evidence', 'Validação da rodada anterior', '--cwd', f.project, '--run', 'audit'], {
    cwd: f.project, env: { ...process.env, HOME: f.home, USERPROFILE: f.home, PRUMO_HOME: f.home, PRUMO_ROOT: f.root, PRUMO_LANG: 'en' }, windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  try {
    const deadline = Date.now() + 15000
    while (!existsSync(join(f.home, 'validation-started')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.ok(existsSync(join(f.home, 'validation-started')), output)
    f.ok('redo-review', 'T1', '--reason', 'Usuário solicitou outra rodada', '--confirmed-by-user')
    writeFileSync(join(f.home, 'validation-release'), 'x')
    assert.notEqual(await finished, 0)
    assert.match(output, /task changed during validation/)
    assert.equal(f.state().tasks.T1.attempts[0].reviewRound, 2)
    assert.equal(f.state().tasks.T1.validations.some(receipt => receipt.ok), false)
    approve(f); f.ok('done', 'T1')
  } finally {
    writeFileSync(join(f.home, 'validation-release'), 'x')
    if (child.exitCode === null && child.signalCode === null) await finished
  }
})

test('refazer etapas preserva autorização manual e não despacha a tentativa seguinte implicitamente', t => {
  const f = fixture(t, { phase: true })
  f.planPhase('F1')
  f.ok('authorize', '--scope', 'tasks:T1', '--mode', 'manual', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor', '--confirmed-by-user')
  f.ok('review', 'T1', '--agent', 'reviewer', '--confirmed-by-user')
  const authorization = structuredClone(f.state().tasks.T1.executionAuthorization)
  f.ok('redo-review', 'T1', '--reason', 'Solicitação explícita de outra revisão', '--confirmed-by-user')
  assert.deepEqual(f.state().tasks.T1.executionAuthorization, authorization)
  f.ok('redo-execution', 'T1', '--reason', 'Solicitação explícita de outra execução', '--confirmed-by-user')
  const pending = f.state(), events = f.events()
  assert.equal(pending.tasks.T1.state, 'pending')
  assert.deepEqual(pending.tasks.T1.executionAuthorization, authorization)
  f.rejects(/manual authorization.*confirmed-by-user/, 'start', 'T1', '--agent', 'executor-2')
  assert.deepEqual(f.state(), pending); assert.equal(f.events(), events)
  f.ok('start', 'T1', '--agent', 'executor-2', '--confirmed-by-user')
  assert.equal(f.state().tasks.T1.attempts[1].redoOf, 1)
})

test('refazer etapas recusa metadados de tentativa que pertencem a outro executor', t => {
  const f = planned(t); f.ok('review', 'T1', '--agent', 'reviewer')
  const before = f.state(); before.tasks.T1.attempts[0].agent = 'outro-executor'; f.importState(before)
  const events = f.events()
  for (const command of ['redo-execution', 'redo-review'])
    f.rejects(/matching open execution|tentativa.*correspondente/, command, 'T1', '--reason', 'Inspecionar inconsistência sem apagar histórico', '--confirmed-by-user')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
})

test('nova revisão preserva histórico legado sem inventar identidade ou início ausentes', t => {
  const f = planned(t); f.ok('review', 'T1', '--agent', 'reviewer')
  const legacy = f.state(), attempt = legacy.tasks.T1.attempts[0]
  delete attempt.reviewStartedAt; delete attempt.reviewDelivery; delete attempt.reviewProgress
  f.importState(legacy)
  f.ok('redo-review', 'T1', '--reason', 'Nova conferência independente da entrega legada', '--confirmed-by-user')
  const history = f.state().tasks.T1.attempts[0].reviewRoundHistory[0]
  assert.equal(history.startedAt, null); assert.equal(history.progress, undefined)
  assert.ok(f.state().tasks.T1.attempts[0].reviewDelivery)
  const olderIdentity = f.state()
  delete olderIdentity.tasks.T1.attempts[0].reviewDelivery.contentFingerprint
  f.importState(olderIdentity)
  f.ok('redo-review', 'T1', '--reason', 'Outra conferência explicitamente solicitada', '--confirmed-by-user')
  const repeated = f.state().tasks.T1.attempts[0]
  assert.equal(repeated.reviewRound, 3)
  assert.deepEqual(repeated.reviewRoundHistory[0], history)
  assert.equal(repeated.reviewRoundHistory[1].startedAt, olderIdentity.tasks.T1.attempts[0].reviewRoundStartedAt)
  approve(f); f.ok('done', 'T1')
})

test('refazer execução legada não cria retroativamente exigência ou artefato de planejamento', t => {
  const f = planned(t), legacy = f.state()
  legacy.plan.source = null
  Object.assign(legacy.tasks.T1, { planningRequired: false, discussionRequired: false, discoveryRequired: false })
  delete legacy.tasks.T1.taskPlan
  f.importState(legacy)
  f.ok('redo-execution', 'T1', '--reason', 'Repetir o ciclo legado por decisão explícita', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor-2')
  assert.equal(f.state().tasks.T1.planningRequired, false)
  assert.equal(f.state().tasks.T1.taskPlan, undefined)
  assert.equal(f.state().tasks.T1.attempts[1].redoOf, 1)
})
