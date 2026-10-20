import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeLegacyPlanFixture } from './fixtures/legacy-plan-init.mjs'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/engine.mjs')
const validation = [{ kind: 'functional', run: 'node check.cjs', expect: 'delivery behavior passes' }]

function phaseFixture(t, tasks, { planningMode = 'phase', maxAgents, lang = 'en' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-phase-negative-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(home, 'workspace'), project = join(home, 'project'), plans = join(root, 'plans')
  mkdirSync(root); mkdirSync(project); mkdirSync(plans)
  writeFileSync(join(project, 'check.cjs'), "require('node:assert/strict').equal(1, 1)\n")
  const planPath = join(root, 'plan.json')
  const plan = { name: 'Phase negative cases', planningMode, ...(maxAgents === undefined ? {} : { maxAgents }),
    phases: [{ id: 'F1', title: 'First' }, { id: 'F2', title: 'Second' }],
    tasks: tasks.map(task => ({ validation, ...task })) }
  writeFileSync(planPath, JSON.stringify(plan))
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: lang }
  const cli = (...args) => spawnSync(process.execPath, [engine, ...args], { cwd: project, env, encoding: 'utf8', windowsHide: true })
  const ok = (...args) => {
    if (args[0] === 'start' && !JSON.parse(readFileSync(join(root, '.specs/graph/phase-negative/state.json'), 'utf8')).tasks[args[1]]?.executionAuthorization) {
      const authorization = cli('authorize', '--scope', `tasks:${args[1]}`, '--confirmed-by-user')
      assert.equal(authorization.status, 0, authorization.stdout + authorization.stderr)
    }
    const result = cli(...args); assert.equal(result.status, 0, result.stdout + result.stderr)
    if (args[0] === 'init') {
      const authorization = cli('authorize', '--scope', 'run', '--confirmed-by-user')
      assert.equal(authorization.status, 0, authorization.stdout + authorization.stderr)
    }
    return result
  }
  const rejects = (pattern, ...args) => { const result = cli(...args); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, pattern); return result }
  const statePath = join(root, '.specs/graph/phase-negative/state.json')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const save = value => writeFileSync(statePath, JSON.stringify(value))
  const events = () => readFileSync(join(root, '.specs/graph/phase-negative/events.ndjson'), 'utf8')
  const discovery = phaseId => {
    const round = state().phaseWorkflows[phaseId].discussionAttempts.at(-1)
    const value = { research: [{ source: 'fixture', findings: 'Current phase contracts inspected.' }],
      questions: [{ question: 'Keep the approved phase behavior?', answer: 'Yes.', channel: 'chat-fallback', round: 1, roundId: round.roundId,
        ...(round.confirmsContract ? { confirmsContract: round.confirmsContract } : {}) }],
      coverage: { problem: 'A phase needs planning.', affected: 'Graph users.', outcome: 'Stable phase plans.', currentBehavior: 'Inspected.',
        desiredBehavior: 'Approved.', rules: 'Keep task bindings.', exceptions: 'None.', scope: phaseId, acceptance: 'Current receipts only.' },
      decisions: [], deferred: [], executionBoundary: { deferredToExecutor: round.targets, prematureTaskWork: [] },
      closure: 'No gray area remains.', roundId: round.roundId, nonce: round.nonce }
    const path = join(root, `discovery-${phaseId}.json`); writeFileSync(path, JSON.stringify(value)); return path
  }
  const writeArtifacts = phaseId => {
    const current = state(), round = current.phaseWorkflows[phaseId].planningAttempts.at(-1)
    const binding = { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n }
    for (const id of round.targets) writeFileSync(join(plans, `task-plan-${id}.json`), JSON.stringify({
      research: [{ source: 'fixture', findings: `${id} inspected.` }], decisions: [], steps: [`Deliver ${id}.`],
      verification: [{ criterion: 'delivery behavior passes', check: 1 }], openQuestions: [], phaseBinding: binding,
      unresolvedInputs: round.requiredInputs[id],
    }))
  }
  const initialized = initializeLegacyPlanFixture(cli, planPath, root, 'phase-negative')
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr)
  ok('authorize', '--scope', 'run', '--confirmed-by-user')
  return { root, project, plans, plan, planPath, ok, rejects, state, save, events, discovery, writeArtifacts }
}


for (const lang of ['en', 'pt-BR']) test('planejamento encerra atividades por lote e STOP repetido preserva histórico em ' + lang, t => {
  const f = phaseFixture(t, [{ id: 'T1', phase: 'F1', title: 'Primeira' }, { id: 'T2', phase: 'F1', title: 'Segunda' }], { maxAgents: 1, lang })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Escopo aceito', '--confirmed-by-user')
  f.ok('plan-phase', 'F1', '--agent', 'planner')
  f.writeArtifacts('F1')
  for (const id of ['T1', 'T2']) {
    const round = f.state().phaseWorkflows.F1.planningAttempts.at(-1)
    const agent = round.workers[id].agent
    f.ok('activity-start', id, '--role', 'planning', '--agent', agent)
    const finished = f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
    const after = f.state(), closed = after.phaseWorkflows.F1.planningAttempts.at(-1).workers[id].activityIntervals.at(-1)
    assert.ok(closed.endedAt)
    assert.ok(finished.stdout.includes(id) && finished.stdout.includes(agent) && finished.stdout.includes(closed.endedAt))
    assert.match(finished.stdout, lang === 'en' ? /planning activity by .* ended at/ : /Atividade de planejamento .* encerrada em/)
    const before = JSON.stringify(after), events = f.events()
    for (const [target, scope] of [[id, 'task'], ['F1', 'phase']]) {
      const stopped = f.ok('activity-stop', target, '--scope', scope, '--role', 'planning', '--agent', agent)
      assert.match(stopped.stdout, lang === 'en' ? /already ended at/ : /já encerrada em/)
      assert.ok(stopped.stdout.includes(closed.endedAt))
    }
    assert.equal(JSON.stringify(f.state()), before)
    assert.equal(f.events(), events)
    f.rejects(/activity|atividade|work|trabalho/, 'activity-stop', id, '--role', 'planning', '--agent', 'intruso')
    f.rejects(/activity|atividade|work|trabalho/, 'activity-stop', 'F1', '--scope', 'phase', '--role', 'planning', '--agent', 'intruso')
    f.rejects(/activity|atividade|work|trabalho/, 'activity-stop', id, '--role', 'inválido', '--agent', agent)
    f.rejects(/activity|atividade|work|trabalho/, 'activity-stop', id, '--role', 'discussion', '--agent', agent)
  }
})

test('rodada concluída sem atividade e agente inválido continuam recusados', t => {
  const f = phaseFixture(t, [{ id: 'T1', phase: 'F1', title: 'Entrega' }])
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Escopo aceito', '--confirmed-by-user')
  f.ok('plan-phase', 'F1', '--agent', 'planner')
  f.writeArtifacts('F1')
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  const worker = f.state().phaseWorkflows.F1.planningAttempts.at(-1).workers.T1
  const before = JSON.stringify(f.state()), events = f.events()
  f.rejects(/no active/, 'activity-stop', 'T1', '--role', 'planning', '--agent', worker.agent)
  f.rejects(/no active/, 'activity-stop', 'F1', '--scope', 'phase', '--role', 'planning', '--agent', worker.agent)
  assert.equal(JSON.stringify(f.state()), before)
  assert.equal(f.events(), events)
})

test('planejamento legado sem workers preserva intervalos medidos e ausencia de medicao', t => {
  for (const measured of [false, true]) {
    const f = phaseFixture(t, [{ id: 'T1', phase: 'F1', title: 'Entrega' }])
    f.ok('skip-phase-discussion', 'F1', '--reason', 'Escopo aceito', '--confirmed-by-user')
    f.ok('plan-phase', 'F1', '--agent', 'planner')
    f.writeArtifacts('F1')
    const legacy = f.state(), phase = legacy.phaseWorkflows.F1, round = phase.planningAttempts.at(-1)
    delete round.workers
    delete round.assignments
    delete round.activityIntervals
    f.save(legacy)
    if (measured) {
      f.ok('activity-start', 'F1', '--scope', 'phase', '--role', 'planning', '--agent', 'planner')
      f.ok('activity-stop', 'F1', '--scope', 'phase', '--role', 'planning', '--agent', 'planner')
      f.ok('activity-start', 'F1', '--scope', 'phase', '--role', 'planning', '--agent', 'planner')
    }
    const finished = f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
    const after = f.state(), events = f.events()
    if (measured) {
      const intervals = after.phaseWorkflows.F1.planningAttempts.at(-1).activityIntervals
      assert.equal(intervals.length, 2)
      assert.ok(intervals.every(interval => interval.endedAt))
      assert.ok(finished.stdout.includes(intervals[1].endedAt))
      assert.match(finished.stdout, /F1 planning activity by planner ended at/)
      assert.match(f.ok('activity-stop', 'F1', '--scope', 'phase', '--role', 'planning', '--agent', 'planner').stdout, /already ended at/)
    } else {
      assert.doesNotMatch(finished.stdout, /planning activity by/)
      f.rejects(/no active/, 'activity-stop', 'F1', '--scope', 'phase', '--role', 'planning', '--agent', 'planner')
    }
    assert.deepEqual(f.state(), after)
    assert.equal(f.events(), events)
  }
})

for (const lang of ['en', 'pt-BR']) test('revisão e execução encerradas aceitam STOP repetido sem alterar o histórico em ' + lang, t => {
  const f = phaseFixture(t, [{ id: 'T1', phase: 'F1', title: 'Entrega' }], { lang })
  f.ok('skip-phase-discussion', 'F1', '--reason', 'Escopo aceito', '--confirmed-by-user')
  f.ok('skip-phase-planning', 'F1', '--reason', 'Contrato suficiente para execução', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('activity-start', 'T1', '--role', 'execution', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'reviewer')
  let before = f.state(), events = f.events()
  const execution = before.tasks.T1.attempts.at(-1).activityIntervals.at(-1)
  assert.ok(execution.endedAt)
  const stopped = f.ok('activity-stop', 'T1', '--role', 'execution', '--agent', 'executor')
  assert.match(stopped.stdout, lang === 'en' ? /already ended at .* by review/ : /já encerrada em .* por review/)
  assert.ok(stopped.stdout.includes(execution.endedAt))
  assert.deepEqual(f.state(), before)
  assert.equal(f.events(), events)
  f.rejects(/activity|atividade|work|trabalho/, 'activity-stop', 'T1', '--role', 'review', '--agent', 'reviewer')
  for (const verdict of ['failed', 'ok']) {
    f.ok('activity-start', 'T1', '--role', 'review', '--agent', 'reviewer')
    f.ok('validate', 'T1', `--${verdict}`, '--evidence', 'Comportamento conferido por revisão independente', '--cwd', f.project)
    before = f.state(); events = f.events()
    const review = before.tasks.T1.attempts.at(-1).activityIntervals.at(-1)
    assert.ok(review.endedAt)
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = f.ok('activity-stop', 'T1', '--role', 'review', '--agent', 'reviewer')
      assert.match(result.stdout, lang === 'en' ? /already ended at .* by validate/ : /já encerrada em .* por validate/)
      assert.ok(result.stdout.includes(review.endedAt))
    }
    f.rejects(/activity|atividade|work|trabalho/, 'activity-stop', 'T1', '--role', 'review', '--agent', 'intruso')
    f.rejects(/activity|atividade|work|trabalho/, 'activity-stop', 'T1', '--role', 'planning', '--agent', 'reviewer')
    assert.deepEqual(f.state(), before)
    assert.equal(f.events(), events)
  }
  const legacy = f.state()
  delete legacy.tasks.T1.attempts.at(-1).activityIntervals.at(-1).endedBy
  f.save(legacy)
  const legacyStop = f.ok('activity-stop', 'T1', '--role', 'review', '--agent', 'reviewer')
  assert.match(legacyStop.stdout, lang === 'en' ? /already ended at/ : /já encerrada em/)
  assert.doesNotMatch(legacyStop.stdout, /validate/)
  assert.deepEqual(f.state(), legacy)
  assert.equal(f.events(), events)
})
