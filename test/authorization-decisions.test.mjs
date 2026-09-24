import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertTaskPlan } from '../scripts/validation.mjs'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/engine.mjs')
const validation = [{ kind: 'functional', run: 'node check.cjs', expect: 'behavior passes' }]

function fixture(t, { tasks = [{ id: 'A', title: 'Source' }, { id: 'B', title: 'Target' }],
  phases, planningMode, requireReview = false, authorize = true, run = 'feature', lang = 'en' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-auth-decision-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const root = join(home, 'workspace'), project = join(home, 'project')
  mkdirSync(root); mkdirSync(project)
  writeFileSync(join(project, 'check.cjs'), "require('node:assert/strict').ok(true)\n")
  const plan = { name: 'Authorization and decisions', planningMode: planningMode ?? (phases ? 'phase' : 'task'), requireReview,
    ...(phases ? { phases } : {}), tasks: tasks.map(task => ({ validation, ...task })) }
  const planPath = join(root, 'plan.json')
  writeFileSync(planPath, JSON.stringify(plan))
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: lang }
  const cli = (...args) => spawnSync(process.execPath, [engine, ...args], { cwd: project, env, encoding: 'utf8', timeout: 20000, windowsHide: true })
  const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.stdout + result.stderr); return result }
  const rejects = (pattern, ...args) => { const result = cli(...args); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, pattern); return result }
  const statePath = join(root, '.specs', 'graph', run, 'state.json')
  const eventPath = join(root, '.specs', 'graph', run, 'events.ndjson')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const stateBytes = () => readFileSync(statePath)
  const saveState = value => writeFileSync(statePath, JSON.stringify(value))
  const savePlan = next => { writeFileSync(planPath, JSON.stringify(next)); return next }
  const eventBytes = () => readFileSync(eventPath)
  const events = () => eventBytes().toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  const basePlan = (id, fields = {}) => ({ research: [{ source: `${id}.md`, findings: 'The current behavior and contract were inspected.' }],
    decisions: [], steps: [`Deliver ${id} within its approved contract.`],
    verification: [{ criterion: 'behavior passes', check: 1 }], openQuestions: [], ...fields })
  const discoveryValue = (id, round, decisions = []) => ({
    research: [{ source: `${id}.md`, findings: 'Current context inspected.' }],
    questions: [{ question: `Preserve ${id}'s approved scope?`, answer: 'Yes.', channel: 'chat-fallback', round: 1, roundId: round.roundId }],
    coverage: { problem: 'The approved change must be delivered.', affected: 'Users of this behavior.', outcome: 'The approved behavior works.',
      currentBehavior: 'The current result was checked.', desiredBehavior: 'The approved result is delivered.', rules: 'Keep the approved scope.',
      exceptions: 'No exception was approved.', scope: id, acceptance: 'The recorded check passes.' },
    decisions, deferred: [], executionBoundary: { deferredToExecutor: [id], prematureTaskWork: [] },
    closure: 'No other consequential question remains.', roundId: round.roundId, nonce: round.nonce,
  })
  const discuss = (id, decisions = []) => {
    const output = ok('begin-discussion', id)
    const round = state().tasks[id].discussionAttempts.at(-1)
    const path = join(root, `${id}-discovery.json`)
    writeFileSync(path, JSON.stringify(discoveryValue(id, round, decisions)))
    ok('finish-discussion', id, '--context', path)
    return output
  }
  const planTaskAfterDiscussion = (id, { openQuestions = [], decisions = [] } = {}) => {
    ok('plan-task', id, '--agent', `planner-${id}`)
    const path = join(root, `${id}-task-plan.json`)
    writeFileSync(path, JSON.stringify(basePlan(id, { openQuestions, decisions })))
    ok('finish-planning', id, '--plan', path)
  }
  const planTask = (id, { openQuestions = [], decisions = [], discoveryDecisions = [] } = {}) => {
    const discussion = discuss(id, discoveryDecisions)
    planTaskAfterDiscussion(id, { openQuestions, decisions })
    return discussion
  }
  const authorizeRun = () => ok('authorize', '--scope', 'run', '--confirmed-by-user')
  ok('init', '--plan', planPath, '--run', run)
  if (authorize) authorizeRun()
  return { root, project, plan, planPath, savePlan, cli, ok, rejects, state, stateBytes, saveState, eventBytes, events, basePlan,
    discoveryValue, discuss, planTaskAfterDiscussion, planTask, authorizeRun }
}

function addLegacyOverdueQuestion(f, decideBy) {
  const state = f.state()
  state.tasks.A.taskPlan.openQuestions.push({ questionRef: 'A:legacy:overdue',
    question: 'Which decision was required before this task started?', blocking: false, decideBy })
  f.saveState(state)
}

function phaseDiscoveryValue(phaseId, discussion, decisions = []) {
  return {
    research: [{ source: `${phaseId}.md`, findings: 'Phase context inspected.' }],
    questions: [{ question: 'Is this phase scope approved?', answer: 'Yes.', channel: 'chat-fallback', round: 1, roundId: discussion.roundId }],
    coverage: { problem: 'Deliver the approved phase.', affected: 'Users of the phase behavior.', outcome: 'The behavior works.',
      currentBehavior: 'The implementation was inspected.', desiredBehavior: 'The approved outcome is delivered.', rules: 'Keep phase scope.',
      exceptions: 'None approved.', scope: phaseId, acceptance: 'The task checks pass.' },
    decisions, deferred: [], executionBoundary: { deferredToExecutor: discussion.targets, prematureTaskWork: [] },
    closure: 'The phase has no further consequential question.', roundId: discussion.roundId, nonce: discussion.nonce,
  }
}

function finishPhaseDiscussion(f, phaseId, decisions = []) {
  const discussion = f.state().phaseWorkflows[phaseId].discussionAttempts.at(-1)
  const discoveryPath = join(f.root, `${phaseId}-discovery.json`)
  writeFileSync(discoveryPath, JSON.stringify(phaseDiscoveryValue(phaseId, discussion, decisions)))
  f.ok('finish-phase-discussion', phaseId, '--context', discoveryPath)
}

function planPhase(f, phaseId, openQuestionsByTask = {}) {
  f.ok('plan-phase', phaseId, '--agent', `planner-${phaseId}`)
  const current = f.state(), round = current.phaseWorkflows[phaseId].planningAttempts.at(-1)
  const planDir = join(f.root, `${phaseId}-plans`)
  mkdirSync(planDir)
  for (const id of round.targets) {
    const binding = { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n }
    writeFileSync(join(planDir, `task-plan-${id}.json`), JSON.stringify(f.basePlan(id, {
      phaseBinding: binding, unresolvedInputs: [], openQuestions: openQuestionsByTask[id] ?? [],
    })))
  }
  f.ok('finish-phase-planning', phaseId, '--plan-dir', planDir)
}

function phasePlan(f, phaseId, openQuestionsByTask = {}) {
  const workflow = f.state().phaseWorkflows[phaseId]
  let phaseDiscovery
  if (workflow.state === 'discussing') finishPhaseDiscussion(f, phaseId)
  else if (!(workflow.discussionAttempts?.length ?? 0) && !(workflow.discussionSkips?.length ?? 0)) {
    phaseDiscovery = f.ok('begin-phase-discussion', phaseId)
    finishPhaseDiscussion(f, phaseId)
  }
  planPhase(f, phaseId, openQuestionsByTask)
  return { phaseDiscovery, workflow }
}

test('task plan validation accepts each decideBy form and rejects ambiguous deadlines', () => {
  const task = { id: 'A', title: 'Source', validation }
  for (const decideBy of ['executor', 'user-now', { beforeTask: 'B' }, { beforePhase: 'F2' }]) {
    assert.doesNotThrow(() => assertTaskPlan(task, {
      research: [{ source: 'scope.md', findings: 'The approved scope was inspected.' }], decisions: [], steps: ['Deliver the contract.'],
      verification: [{ criterion: 'behavior passes', check: 1 }], openQuestions: [{ question: 'A future question?', blocking: false, decideBy }],
    }))
  }
  assert.throws(() => assertTaskPlan(task, {
    research: [{ source: 'scope.md', findings: 'The approved scope was inspected.' }], decisions: [], steps: ['Deliver the contract.'],
    verification: [{ criterion: 'behavior passes', check: 1 }],
    openQuestions: [{ question: 'An ambiguous question?', blocking: false, decideBy: { beforeTask: 'B', beforePhase: 'F2' } }],
  }), /valid optional decideBy/)
})

test('open questions respect deadlines, resurface on their target, and resolve by their source reference', t => {
  const f = fixture(t)
  f.planTask('A', { openQuestions: [{ question: 'Which protocol should B use?', blocking: false,
    decideBy: { beforeTask: 'B' } }] })
  f.planTask('B')
  const question = f.state().tasks.A.taskPlan.openQuestions[0]
  assert.match(question.questionRef, /^A:plan:[a-f0-9]{12}$/)

  f.ok('start', 'A', '--agent', 'executor-A')
  const begin = f.planTask('B', { discoveryDecisions: [{ question: question.question, answer: 'Use the existing client.', resolvesQuestion: question.questionRef }] })
  assert.ok((begin.stdout + begin.stderr).includes(question.questionRef), 'the target discussion surfaces the source question')
  assert.equal(f.state().questionResolutions[0].questionRef, question.questionRef)
  assert.equal(f.state().questionResolutions[0].byTask, 'B')
  f.ok('start', 'B', '--agent', 'executor-B')
})

test('a future question from a completed task survives a global plan sync until answered', t => {
  const f = fixture(t)
  f.planTask('A', { openQuestions: [{ question: 'Which protocol should B use?', blocking: false,
    decideBy: { beforeTask: 'B' } }] })
  const questionRef = f.state().tasks.A.taskPlan.openQuestions[0].questionRef
  f.ok('start', 'A', '--agent', 'executor-A')
  f.ok('validate', 'A', '--ok', '--evidence', 'Source behavior passed.', '--cwd', f.project)
  f.ok('done', 'A')
  const completed = f.state().tasks.A
  assert.match(f.ok('status').stdout, new RegExp(`open question ${questionRef}`))

  f.plan.description = 'The approved run description changed after A finished.'
  f.savePlan(f.plan)
  f.ok('sync-plan', '--plan', f.planPath)
  assert.deepEqual(f.state().tasks.A, completed, 'sync keeps the completed source immutable')
  assert.match(f.ok('status').stdout, new RegExp(`open question ${questionRef}`),
    'a global planning revision cannot hide a still-open future decision')

  f.ok('authorize', '--scope', 'tasks:B', '--confirmed-by-user')
  const discussion = f.planTask('B')
  assert.match(discussion.stdout, new RegExp(questionRef), 'the target discussion resurfaces the question')
  f.rejects(/unresolved questions due before it starts/, 'start', 'B', '--agent', 'executor-B')
  assert.equal(f.state().tasks.B.state, 'pending')
})

test('a future question survives while its source task awaits replanning', t => {
  const f = fixture(t)
  f.planTask('A', { openQuestions: [{ question: 'Which policy should B follow?', blocking: false,
    decideBy: { beforeTask: 'B' } }] })
  const questionRef = f.state().tasks.A.taskPlan.openQuestions[0].questionRef
  f.plan.description = 'Global description changed before A started.'
  f.savePlan(f.plan)
  f.ok('sync-plan', '--plan', f.planPath)
  assert.equal(f.state().tasks.A.state, 'pending')
  assert.match(f.ok('status').stdout, new RegExp(`open question ${questionRef}`))

  f.ok('authorize', '--scope', 'tasks:B', '--confirmed-by-user')
  const discussion = f.planTask('B')
  assert.match(discussion.stdout, new RegExp(questionRef))
  f.rejects(/unresolved questions due before it starts/, 'start', 'B', '--agent', 'executor-B')
  assert.equal(f.state().tasks.B.state, 'pending')
})

test('discussion discovery rejects conflicting duplicate question resolutions atomically in task and phase modes', t => {
  const duplicateDiscovery = (ref, question) => [
    { question, answer: 'Use policy X.', resolvesQuestion: ref },
    { question, answer: 'Use policy Y.', resolvesQuestion: ref },
  ]

  const task = fixture(t, { run: 'duplicate-task-discovery' })
  task.planTask('A', { openQuestions: [{ question: 'Which policy applies to B?', blocking: false,
    decideBy: { beforeTask: 'B' } }] })
  const taskQuestion = task.state().tasks.A.taskPlan.openQuestions[0]
  task.ok('begin-discussion', 'B')
  const taskRound = task.state().tasks.B.discussionAttempts.at(-1)
  const taskDiscoveryPath = join(task.root, 'duplicate-task-discovery.json')
  writeFileSync(taskDiscoveryPath, JSON.stringify(task.discoveryValue('B', taskRound,
    duplicateDiscovery(taskQuestion.questionRef, taskQuestion.question))))
  const beforeTaskFinish = task.state(), taskEvents = task.events()
  task.rejects(/decisions cannot resolve the same open question more than once/,
    'finish-discussion', 'B', '--context', taskDiscoveryPath)
  assert.deepEqual(task.state(), beforeTaskFinish)
  assert.deepEqual(task.events(), taskEvents)

  const phase = fixture(t, { run: 'duplicate-phase-discovery', phases: [
    { id: 'F1', title: 'Source' }, { id: 'F2', title: 'Target' },
  ], tasks: [{ id: 'A', title: 'Source', phase: 'F1' }, { id: 'B', title: 'Target', phase: 'F2' }] })
  phasePlan(phase, 'F1', { A: [{ question: 'Which policy applies to F2?', blocking: false,
    decideBy: { beforePhase: 'F2' } }] })
  const phaseQuestion = phase.state().tasks.A.taskPlan.openQuestions[0]
  phase.ok('begin-phase-discussion', 'F2')
  const phaseRound = phase.state().phaseWorkflows.F2.discussionAttempts.at(-1)
  const phaseDiscoveryPath = join(phase.root, 'duplicate-phase-discovery.json')
  writeFileSync(phaseDiscoveryPath, JSON.stringify(phaseDiscoveryValue('F2', phaseRound,
    duplicateDiscovery(phaseQuestion.questionRef, phaseQuestion.question))))
  const beforePhaseFinish = phase.state(), phaseEvents = phase.events()
  phase.rejects(/decisions cannot resolve the same open question more than once/,
    'finish-phase-discussion', 'F2', '--context', phaseDiscoveryPath)
  assert.deepEqual(phase.state(), beforePhaseFinish)
  assert.deepEqual(phase.events(), phaseEvents)
})

test('task and phase planning reject duplicate question resolutions before persisting plans', t => {
  const task = fixture(t, { run: 'duplicate-task-planning' })
  task.planTask('A', { openQuestions: [{ question: 'Which policy applies to B?', blocking: false,
    decideBy: { beforeTask: 'B' } }] })
  const taskQuestion = task.state().tasks.A.taskPlan.openQuestions[0]
  task.discuss('B')
  task.ok('plan-task', 'B', '--agent', 'planner-B')
  const taskPlanPath = join(task.root, 'duplicate-task-plan.json')
  writeFileSync(taskPlanPath, JSON.stringify(task.basePlan('B', { decisions: [
    { question: taskQuestion.question, answer: 'Use policy X.', resolvesQuestion: taskQuestion.questionRef },
    { question: taskQuestion.question, answer: 'Use policy Y.', resolvesQuestion: taskQuestion.questionRef },
  ] })))
  const beforeTaskPlan = task.state(), taskEvents = task.events()
  task.rejects(/decisions cannot resolve the same open question more than once/,
    'finish-planning', 'B', '--plan', taskPlanPath)
  assert.deepEqual(task.state(), beforeTaskPlan)
  assert.deepEqual(task.events(), taskEvents)

  const phase = fixture(t, { run: 'duplicate-phase-planning', phases: [
    { id: 'F1', title: 'Source' }, { id: 'F2', title: 'Targets' },
  ], tasks: [{ id: 'A', title: 'Source', phase: 'F1' }, { id: 'B', title: 'Target one', phase: 'F2' },
    { id: 'C', title: 'Target two', phase: 'F2' }] })
  phasePlan(phase, 'F1', { A: [{ question: 'Which policy applies to F2?', blocking: false,
    decideBy: { beforePhase: 'F2' } }] })
  const phaseQuestion = phase.state().tasks.A.taskPlan.openQuestions[0]
  phase.ok('begin-phase-discussion', 'F2')
  finishPhaseDiscussion(phase, 'F2')
  phase.ok('plan-phase', 'F2', '--agent', 'planner-F2')
  const phaseState = phase.state(), round = phaseState.phaseWorkflows.F2.planningAttempts.at(-1)
  const planDir = join(phase.root, 'duplicate-phase-plans')
  mkdirSync(planDir)
  for (const [id, answer] of [['B', 'Use policy X.'], ['C', 'Use policy Y.']]) {
    const binding = { phaseId: 'F2', discussionRoundId: round.discussionRoundId, plannerRound: round.n }
    writeFileSync(join(planDir, `task-plan-${id}.json`), JSON.stringify(phase.basePlan(id, {
      phaseBinding: binding, unresolvedInputs: [],
      decisions: [{ question: phaseQuestion.question, answer, resolvesQuestion: phaseQuestion.questionRef }],
    })))
  }
  const beforePhasePlan = phase.state(), phaseEvents = phase.events()
  phase.rejects(/phase planning cannot resolve the same open question more than once/,
    'finish-phase-planning', 'F2', '--plan-dir', planDir)
  assert.deepEqual(phase.state(), beforePhasePlan)
  assert.deepEqual(phase.events(), phaseEvents)
  assert.equal(phase.state().tasks.B.taskPlan, undefined)
  assert.equal(phase.state().tasks.C.taskPlan, undefined)
})

test('an unresolved question gates only its named target after its deadline', t => {
  const f = fixture(t)
  f.planTask('A', { openQuestions: [{ question: 'Which behavior should B use?', blocking: false,
    decideBy: { beforeTask: 'B' } }] })
  f.planTask('B')
  f.ok('start', 'A', '--agent', 'executor-A')
  const begin = f.planTask('B')
  assert.ok((begin.stdout + begin.stderr).includes('Which behavior should B use?'))
  f.rejects(/unresolved questions due before it starts/, 'start', 'B', '--agent', 'executor-B')
  assert.equal(f.state().tasks.A.state, 'running', 'the source task proceeds while the question is scheduled for later')
})

test('beforePhase deadlines become overdue when any task in that phase starts planning in task mode', t => {
  const f = fixture(t, { run: 'task-phase-deadline', planningMode: 'task',
    phases: [{ id: 'F0', title: 'Source' }, { id: 'F1', title: 'First target' }, { id: 'F2', title: 'Second target' }],
    tasks: [{ id: 'A', title: 'Source', phase: 'F0' }, { id: 'B', title: 'Same phase target', phase: 'F1' },
      { id: 'C', title: 'Other phase', phase: 'F2' }] })
  f.planTask('A', { openQuestions: [{ question: 'Which policy applies before F1 planning?', blocking: false,
    decideBy: { beforePhase: 'F1' } }] })
  f.planTask('B')
  assert.match(f.ok('status').stdout, /open question A:plan:[a-f0-9]{12} \(overdue, before phase F1\)/)
  f.rejects(/unresolved questions due before it starts/, 'start', 'B', '--agent', 'executor-B')
  f.planTask('C')
  f.ok('start', 'C', '--agent', 'executor-C')
  assert.equal(f.state().tasks.C.state, 'running', 'a deadline for F1 does not gate work in F2')
})

test('future deadlines gate starts after normal or skipped discussion and planning across task/phase modes', t => {
  for (const deadlineKind of ['beforeTask', 'beforePhase']) {
    for (const planningMode of ['task', 'phase']) {
      for (const gate of ['discussion', 'planning']) {
        for (const outcome of ['normal', 'skipped']) {
          const run = `deadline-${deadlineKind}-${planningMode}-${gate}-${outcome}`
          const phases = [{ id: 'F1', title: 'Source' }, { id: 'F2', title: 'Target' }]
          const f = fixture(t, { run, planningMode, phases,
            tasks: [{ id: 'A', title: 'Source', phase: 'F1' }, { id: 'B', title: 'Target', phase: 'F2' }] })
          const decideBy = deadlineKind === 'beforeTask' ? { beforeTask: 'B' } : { beforePhase: 'F2' }
          const openQuestion = { question: `${run} needs a decision before dispatch`, blocking: false, decideBy }
          if (planningMode === 'task') f.planTask('A', { openQuestions: [openQuestion] })
          else phasePlan(f, 'F1', { A: [openQuestion] })
          const questionRef = f.state().tasks.A.taskPlan.openQuestions[0].questionRef

          if (planningMode === 'task') {
            if (gate === 'discussion' && outcome === 'skipped')
              f.ok('skip-discussion', 'B', '--reason', 'The approved decision skips discussion', '--confirmed-by-user')
            else if (gate === 'discussion' || (gate === 'planning' && outcome === 'skipped'))
              f.discuss('B')
            if (gate === 'discussion' && outcome === 'normal') {
              assert.match(f.ok('status').stdout, new RegExp(`open question ${questionRef} \\(overdue`))
              f.planTaskAfterDiscussion('B')
            } else if (gate === 'discussion' && outcome === 'skipped') {
              assert.match(f.ok('status').stdout, new RegExp(`open question ${questionRef} \\(overdue`))
              f.planTaskAfterDiscussion('B')
            } else if (gate === 'planning' && outcome === 'normal') {
              f.planTask('B')
            } else {
              assert.match(f.ok('status').stdout, new RegExp(`open question ${questionRef} \\(overdue`))
              f.ok('skip-planning', 'B', '--reason', 'The approved decision skips planning', '--confirmed-by-user')
            }
          } else {
            if (gate === 'discussion' && outcome === 'skipped')
              f.ok('skip-phase-discussion', 'F2', '--reason', 'The approved decision skips phase discussion', '--confirmed-by-user')
            else {
              f.ok('begin-phase-discussion', 'F2')
              finishPhaseDiscussion(f, 'F2')
            }
            if (gate === 'discussion' && outcome === 'normal') {
              assert.match(f.ok('status').stdout, new RegExp(`open question ${questionRef} \\(overdue`))
              planPhase(f, 'F2')
            } else if (gate === 'discussion' && outcome === 'skipped') {
              assert.match(f.ok('status').stdout, new RegExp(`open question ${questionRef} \\(overdue`))
              planPhase(f, 'F2')
            } else if (gate === 'planning' && outcome === 'normal') {
              planPhase(f, 'F2')
            } else {
              assert.match(f.ok('status').stdout, new RegExp(`open question ${questionRef} \\(overdue`))
              f.ok('skip-phase-planning', 'F2', '--reason', 'The approved decision skips phase planning', '--confirmed-by-user')
            }
          }

          assert.match(f.ok('status').stdout, new RegExp(`open question ${questionRef} \\(overdue`),
            `${deadlineKind}/${planningMode}/${gate}/${outcome} should report the question as overdue`)
          f.rejects(/unresolved questions due before it starts/, 'start', 'B', '--agent', `executor-${run}`)
          assert.notEqual(f.state().tasks.B.state, 'running')
        }
      }
    }
  }
})

test('task planning rejects unanswered deadlines after targets start without changing state or events', t => {
  for (const deadlineKind of ['beforeTask', 'beforePhase']) {
    for (const targetState of ['running', 'done']) {
      const run = `late-${deadlineKind}-${targetState}`
      const f = fixture(t, { run, planningMode: 'task',
        phases: [{ id: 'F1', title: 'Source' }, { id: 'F2', title: 'Target' }],
        tasks: [{ id: 'A', title: 'Source', phase: 'F1' }, { id: 'B', title: 'Target', phase: 'F2' }] })
      f.planTask('B')
      f.ok('start', 'B', '--agent', 'executor-B')
      if (targetState === 'done') {
        f.ok('validate', 'B', '--ok', '--evidence', 'The approved check passed.', '--cwd', f.project)
        f.ok('done', 'B')
      }
      f.discuss('A')
      f.ok('plan-task', 'A', '--agent', 'planner-A')
      const planPath = join(f.root, `${run}-late-plan.json`)
      const decideBy = deadlineKind === 'beforeTask' ? { beforeTask: 'B' } : { beforePhase: 'F2' }
      writeFileSync(planPath, JSON.stringify(f.basePlan('A', { openQuestions: [
        { question: `${run} was not answered before its target began`, blocking: false, decideBy },
      ] })))
      const stateBefore = f.stateBytes(), eventsBefore = f.eventBytes()
      f.rejects(/has an expired deadline/, 'finish-planning', 'A', '--plan', planPath)
      assert.deepEqual(f.stateBytes(), stateBefore, `${run}: rejection must leave state bytes unchanged`)
      assert.deepEqual(f.eventBytes(), eventsBefore, `${run}: rejection must leave event bytes unchanged`)
    }
  }
})

test('phase planning atomically rejects a late beforePhase question before saving any task plan', t => {
  const f = fixture(t, { run: 'late-phase-batch', planningMode: 'phase', phases: [
    { id: 'P1', title: 'Source' }, { id: 'P2', title: 'Target' },
  ], tasks: [{ id: 'A', title: 'Source one', phase: 'P1' }, { id: 'C', title: 'Source two', phase: 'P1' },
    { id: 'B', title: 'Target', phase: 'P2' }] })
  phasePlan(f, 'P2')
  f.ok('start', 'B', '--agent', 'executor-B')
  f.ok('begin-phase-discussion', 'P1')
  finishPhaseDiscussion(f, 'P1')
  f.ok('plan-phase', 'P1', '--agent', 'planner-P1')
  const round = f.state().phaseWorkflows.P1.planningAttempts.at(-1)
  const planDir = join(f.root, 'late-phase-plans')
  mkdirSync(planDir)
  for (const id of round.targets) {
    const binding = { phaseId: 'P1', discussionRoundId: round.discussionRoundId, plannerRound: round.n }
    const openQuestions = id === 'A' ? [{ question: 'What did P2 need before starting?', blocking: false,
      decideBy: { beforePhase: 'P2' } }] : []
    writeFileSync(join(planDir, `task-plan-${id}.json`), JSON.stringify(f.basePlan(id, {
      phaseBinding: binding, unresolvedInputs: [], openQuestions,
    })))
  }
  const stateBefore = f.stateBytes(), eventsBefore = f.eventBytes()
  f.rejects(/has an expired deadline/, 'finish-phase-planning', 'P1', '--plan-dir', planDir)
  assert.deepEqual(f.stateBytes(), stateBefore, 'the rejected phase batch must leave state bytes unchanged')
  assert.deepEqual(f.eventBytes(), eventsBefore, 'the rejected phase batch must leave event bytes unchanged')
  assert.equal(f.state().tasks.A.taskPlan, undefined)
  assert.equal(f.state().tasks.C.taskPlan, undefined)
})

test('legacy overdue questions block validate --ok and done in task and phase deadline modes', t => {
  for (const deadlineKind of ['beforeTask', 'beforePhase']) {
    const phases = [{ id: 'F1', title: 'Source' }, { id: 'F2', title: 'Target' }]
    const tasks = [{ id: 'A', title: 'Source', phase: 'F1' }, { id: 'B', title: 'Target', phase: 'F2' }]
    const decideBy = deadlineKind === 'beforeTask' ? { beforeTask: 'B' } : { beforePhase: 'F2' }
    const validate = fixture(t, { run: `legacy-overdue-validate-${deadlineKind}`, planningMode: 'task', phases, tasks })
    validate.planTask('A')
    validate.planTask('B')
    validate.ok('start', 'B', '--agent', 'executor-B')
    addLegacyOverdueQuestion(validate, decideBy)
    const validateState = validate.stateBytes(), validateEvents = validate.eventBytes()
    validate.rejects(/unresolved questions due before it starts/, 'validate', 'B', '--ok', '--evidence', 'The approved check passed.')
    assert.deepEqual(validate.stateBytes(), validateState, `${deadlineKind}: rejected validate must not change state`)
    assert.deepEqual(validate.eventBytes(), validateEvents, `${deadlineKind}: rejected validate must not append events`)

    const done = fixture(t, { run: `legacy-overdue-done-${deadlineKind}`, planningMode: 'task', phases, tasks })
    done.planTask('A')
    done.planTask('B')
    done.ok('start', 'B', '--agent', 'executor-B')
    done.ok('validate', 'B', '--ok', '--evidence', 'The approved check passed.', '--cwd', done.project)
    addLegacyOverdueQuestion(done, decideBy)
    const doneState = done.stateBytes(), doneEvents = done.eventBytes()
    done.rejects(/unresolved questions due before it starts/, 'done', 'B')
    assert.deepEqual(done.stateBytes(), doneState, `${deadlineKind}: rejected done must not change state`)
    assert.deepEqual(done.eventBytes(), doneEvents, `${deadlineKind}: rejected done must not append events`)
  }
})

test('execution authorization records scope and mode, gates only selected tasks, and sync-plan revokes changed contracts', t => {
  const f = fixture(t, { authorize: false })
  f.planTask('A')
  f.planTask('B')
  const before = f.state(), eventCount = f.events().length
  f.rejects(/requires --confirmed-by-user/, 'authorize', '--scope', 'tasks:A')
  f.rejects(/no execution authorization/, 'start', 'A', '--agent', 'executor-A')
  assert.deepEqual(f.state(), before)
  assert.equal(f.events().length, eventCount)

  f.ok('authorize', '--scope', 'tasks:A', '--channel', 'chat', '--confirmed-by-user')
  const authorization = f.state().tasks.A.executionAuthorization
  assert.equal(authorization.scope, 'tasks:A')
  assert.equal(authorization.mode, 'auto')
  assert.equal(authorization.channel, 'chat')
  assert.ok(authorization.at)
  const readyAuto = f.ok('ready').stdout
  assert.match(readyAuto, /A  Source  \[ready · authorized auto\].*start A --agent <executor>/)
  assert.match(readyAuto, /B  Target  \[ready · authorization required\].*ask user to authorize/)
  f.rejects(/no execution authorization/, 'start', 'B', '--agent', 'executor-B')
  f.ok('authorize', '--scope', 'tasks:B', '--mode', 'manual', '--confirmed-by-user')
  assert.equal(f.state().tasks.B.executionAuthorization.mode, 'manual')
  assert.match(f.ok('status').stdout, /B.*authorized manual.*ask user before dispatching B/)

  f.ok('authorize', '--scope', 'run', '--confirmed-by-user')
  const changed = structuredClone(f.plan)
  changed.tasks.find(task => task.id === 'A').title = 'Source contract changed'
  f.savePlan(changed)
  f.ok('sync-plan', '--plan', f.planPath)
  assert.equal(f.state().tasks.A.executionAuthorization, undefined)
  assert.ok(f.state().tasks.B.executionAuthorization)
  f.rejects(/no execution authorization/, 'start', 'A', '--agent', 'executor-A')
  f.ok('start', 'B', '--agent', 'executor-B')
})

test('refresh-contract revokes only the changed task authorization and preserves its acceptance history', t => {
  const f = fixture(t, { run: 'refresh-auth', tasks: [{ id: 'A', title: 'Delivery' }] })
  f.planTask('A')
  const accepted = f.state().tasks.A.executionAuthorization
  const changed = structuredClone(f.plan)
  changed.tasks[0].validation = [{ ...validation[0], expect: 'the updated behavior passes' }]
  f.savePlan(changed)
  const refresh = f.ok('refresh-contract', 'A', '--plan', f.planPath)
  assert.match(refresh.stdout, /execution authorization revoked for A/)
  const task = f.state().tasks.A
  assert.equal(task.executionAuthorization, undefined)
  assert.deepEqual(task.authorizationHistory.at(-1), { ...accepted, revokedAt: task.authorizationHistory.at(-1).revokedAt,
    revokeReason: 'refresh-contract changed this task validation contract' })
  assert.ok(task.authorizationHistory.at(-1).revokedAt)
  assert.equal(f.events().at(-1).type, 'task_contract_refreshed')
  assert.equal(f.events().at(-1).authorizationRevoked, true)
  f.rejects(/no execution authorization/, 'start', 'A', '--agent', 'executor-A')
  f.ok('authorize', '--scope', 'tasks:A', '--confirmed-by-user')
  f.ok('start', 'A', '--agent', 'executor-A')
})

test('manual authorization confirms every dispatch, retry and active resume, while auto stays unprompted', t => {
  const f = fixture(t, { run: 'manual-dispatch', tasks: [{ id: 'A', title: 'Delivery' }] })
  f.planTask('A')
  f.ok('authorize', '--scope', 'tasks:A', '--mode', 'manual', '--confirmed-by-user')
  const beforeStart = f.state(), beforeEvents = f.events()
  f.rejects(/requires --confirmed-by-user before dispatch/, 'start', 'A', '--agent', 'executor-1')
  assert.deepEqual(f.state(), beforeStart)
  assert.deepEqual(f.events(), beforeEvents)
  f.ok('start', 'A', '--agent', 'executor-1', '--confirmed-by-user')
  let task = f.state().tasks.A
  const dispatch = task.attempts[0].manualDispatchConfirmation
  assert.equal(dispatch.confirmedByUser, true)
  assert.equal(dispatch.authorizationId, task.executionAuthorization.authorizationId)
  assert.ok(dispatch.at)
  assert.equal(f.events().at(-1).manualDispatchConfirmation.confirmedByUser, true)

  f.ok('block', 'A', '--reason', 'Pause before resuming the executor')
  const beforeUnblock = f.state(), unblockEvents = f.events()
  f.rejects(/requires --confirmed-by-user to resume execution/, 'unblock', 'A')
  assert.deepEqual(f.state(), beforeUnblock)
  assert.deepEqual(f.events(), unblockEvents)
  f.ok('unblock', 'A', '--confirmed-by-user')
  task = f.state().tasks.A
  assert.equal(task.attempts[0].manualResumeConfirmation.confirmedByUser, true)
  assert.equal(f.events().at(-1).manualDispatchConfirmation.confirmedByUser, true)
  assert.equal(task.attempts[0].manualConfirmations.filter(entry => entry.action === 'resume').length, 1)

  const beforeReview = f.state(), reviewEvents = f.events()
  f.rejects(/requires --confirmed-by-user before dispatch/, 'review', 'A', '--agent', 'reviewer-A')
  assert.deepEqual(f.state(), beforeReview)
  assert.deepEqual(f.events(), reviewEvents)
  f.ok('review', 'A', '--agent', 'reviewer-A', '--confirmed-by-user')
  assert.equal(f.state().tasks.A.attempts[0].manualReviewConfirmation.confirmedByUser, true)
  assert.equal(f.events().at(-1).manualDispatchConfirmation.confirmedByUser, true)

  const olderState = f.state()
  delete olderState.tasks.A.attempts[0].manualConfirmations
  f.saveState(olderState)
  f.ok('block', 'A', '--reason', 'Pause after review before the second resume')
  f.ok('unblock', 'A', '--confirmed-by-user')
  task = f.state().tasks.A
  const confirmationHistory = task.attempts[0].manualConfirmations
  assert.deepEqual(confirmationHistory.map(entry => entry.action), ['dispatch', 'resume', 'review', 'resume'])
  const confirmationTimes = confirmationHistory.map(entry => Date.parse(entry.at))
  assert.ok(confirmationTimes.every((time, index) => index === 0 || confirmationTimes[index - 1] <= time),
    'legacy scalar confirmations merge into chronological order')
  assert.deepEqual(task.attempts[0].manualResumeConfirmation,
    (({ action, ...confirmation }) => confirmation)(confirmationHistory.filter(entry => entry.action === 'resume').at(-1)))
  assert.equal(f.events().filter(event => event.type === 'task_unblock' && event.manualDispatchConfirmation).length, 2)
  f.ok('fail', 'A', '--reason', 'The reviewer found a real defect')
  const beforeRetry = f.state(), retryEvents = f.events()
  f.rejects(/requires --confirmed-by-user before retry/, 'retry', 'A')
  assert.deepEqual(f.state(), beforeRetry)
  assert.deepEqual(f.events(), retryEvents)
  f.ok('retry', 'A', '--confirmed-by-user')
  task = f.state().tasks.A
  assert.equal(task.attempts[0].manualRetryConfirmation.confirmedByUser, true)
  assert.equal(f.events().at(-1).manualRetryConfirmation.confirmedByUser, true)
  const beforeSecondStart = f.state()
  f.rejects(/requires --confirmed-by-user before dispatch/, 'start', 'A', '--agent', 'executor-2')
  assert.deepEqual(f.state(), beforeSecondStart)
  f.ok('start', 'A', '--agent', 'executor-2', '--confirmed-by-user')
  assert.equal(f.state().tasks.A.attempts[1].manualDispatchConfirmation.confirmedByUser, true)

  const auto = fixture(t, { run: 'auto-dispatch', tasks: [{ id: 'A', title: 'Automatic' }] })
  auto.planTask('A')
  auto.ok('start', 'A', '--agent', 'executor-auto')
  assert.equal(auto.state().tasks.A.attempts[0].manualDispatchConfirmation, undefined)
})

test('manual confirmation backfill distinguishes same-time receipts by channel', t => {
  const f = fixture(t, { run: 'manual-confirmation-channel', tasks: [{ id: 'A', title: 'Delivery' }] })
  f.planTask('A')
  f.ok('authorize', '--scope', 'tasks:A', '--mode', 'manual', '--confirmed-by-user')
  f.ok('start', 'A', '--agent', 'executor-A', '--confirmed-by-user')
  const state = f.state(), attempt = state.tasks.A.attempts[0]
  const dispatch = attempt.manualDispatchConfirmation
  const sameTime = { authorizationId: dispatch.authorizationId, confirmedByUser: true, at: dispatch.at }
  attempt.manualConfirmations.push({ action: 'resume', ...sameTime, channel: 'chat' })
  attempt.manualResumeConfirmation = { ...sameTime, channel: 'cli' }
  f.saveState(state)
  f.ok('block', 'A', '--reason', 'Backfill legacy channel evidence')
  f.ok('unblock', 'A', '--confirmed-by-user', '--channel', 'web')
  const receipts = f.state().tasks.A.attempts[0].manualConfirmations
    .filter(entry => entry.action === 'resume' && entry.at === dispatch.at)
  assert.deepEqual(receipts.map(entry => entry.channel), ['chat', 'cli'])
})

test('done announces a newly eligible phase once without starting its discussion', t => {
  const f = fixture(t, { run: 'phase-done', phases: [{ id: 'F1', title: 'First' }, { id: 'F2', title: 'Second' }],
    tasks: [{ id: 'A', title: 'First task', phase: 'F1' }, { id: 'B', title: 'Second task', phase: 'F2', deps: ['A'] }] })
  phasePlan(f, 'F1')
  f.ok('start', 'A', '--agent', 'executor-A')
  f.ok('validate', 'A', '--ok', '--evidence', 'Behavior passes', '--cwd', f.project)
  f.ok('done', 'A')
  const eligible = f.events().filter(event => event.type === 'phase_eligible')
  assert.deepEqual(eligible.map(({ phase, tasks, cause }) => ({ phase, tasks, cause })), [
    { phase: 'F2', tasks: ['B'], cause: 'done' },
  ])
  assert.equal(f.state().phaseWorkflows.F2.state, 'pending')
  assert.equal(f.state().phaseWorkflows.F2.discussionAttempts.length, 0)
  f.ok('status')
  assert.equal(f.events().filter(event => event.type === 'phase_eligible').length, 1)
})

test('skip announces a newly eligible phase', t => {
  const f = fixture(t, { run: 'phase-skip', phases: [{ id: 'F1', title: 'First' }, { id: 'F2', title: 'Second' }],
    tasks: [{ id: 'A', title: 'First task', phase: 'F1' }, { id: 'B', title: 'Second task', phase: 'F2', deps: ['A'] }] })
  f.ok('skip', 'A', '--reason', 'The approved plan waives this task')
  const eligible = f.events().filter(event => event.type === 'phase_eligible')
  assert.deepEqual(eligible.map(({ phase, tasks, cause }) => ({ phase, tasks, cause })), [
    { phase: 'F2', tasks: ['B'], cause: 'skip' },
  ])
  assert.equal(f.state().phaseWorkflows.F2.state, 'pending')
})

test('sync-plan announces a newly eligible phase once', t => {
  const f = fixture(t, { run: 'phase-sync', phases: [{ id: 'F1', title: 'First' }, { id: 'F2', title: 'Second' }],
    tasks: [{ id: 'A', title: 'First task', phase: 'F1' }, { id: 'B', title: 'Second task', phase: 'F2', deps: ['A'] }] })
  const changed = structuredClone(f.plan)
  changed.tasks.find(task => task.id === 'B').deps = []
  f.savePlan(changed)
  f.ok('sync-plan', '--plan', f.planPath)
  f.ok('sync-plan', '--plan', f.planPath)
  const eligible = f.events().filter(event => event.type === 'phase_eligible')
  assert.deepEqual(eligible.map(({ phase, tasks, cause }) => ({ phase, tasks, cause })), [
    { phase: 'F2', tasks: ['B'], cause: 'sync-plan' },
  ])
  assert.equal(f.state().phaseWorkflows.F2.state, 'pending')
})

test('block questions and repeated options are saved, answered into history, and clear on resume', t => {
  const f = fixture(t, { tasks: [{ id: 'A', title: 'Blocked task' }] })
  f.ok('block', 'A', '--reason', 'Needs a product decision', '--question', 'Which policy applies?',
    '--option', 'Keep current', '--option', 'Adopt proposed')
  const blocked = f.state().tasks.A
  assert.equal(blocked.blockQuestion, 'Which policy applies?')
  assert.deepEqual(blocked.blockOptions, ['Keep current', 'Adopt proposed'])
  const before = f.state(), events = f.events()
  f.rejects(/needs --answer/, 'unblock', 'A')
  assert.deepEqual(f.state(), before)
  assert.deepEqual(f.events(), events)
  f.ok('unblock', 'A', '--answer', 'Keep current')
  const resumed = f.state().tasks.A
  assert.equal(resumed.blockQuestion, undefined)
  assert.equal(resumed.blockOptions, undefined)
  assert.deepEqual(resumed.blockHistory[0], {
    reason: 'Needs a product decision', question: 'Which policy applies?', answer: 'Keep current', at: resumed.blockHistory[0].at,
  })
  assert.ok(resumed.blockHistory[0].at)

  f.ok('block', 'A', '--reason', 'Legacy style pause')
  f.ok('unblock', 'A')
  assert.equal(f.state().tasks.A.blockHistory.at(-1).reason, 'Legacy style pause')
})

test('new block and unblock validation errors are translated to pt-BR', t => {
  const f = fixture(t, { run: 'block-translation', lang: 'pt-BR', tasks: [{ id: 'A', title: 'Blocked task' }] })
  f.rejects(/block --option exige --question/, 'block', 'A', '--reason', 'Escolha necessária', '--option', 'Manter')
  f.ok('block', 'A', '--reason', 'Escolha necessária', '--question', 'Qual política?')
  f.rejects(/unblock exige --answer/, 'unblock', 'A')
})
