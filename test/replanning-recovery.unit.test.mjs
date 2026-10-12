import test from 'node:test'
import assert from 'node:assert/strict'
import { replanningRecovery } from '../scripts/replanning-recovery.mjs'

function evidence() {
  return {
    task: { id: 'T1', state: 'blocked', planningRequired: true, agent: 'executor', reviewer: 'reviewer',
      planningReturn: { blockKind: 'replan', stateBeforeBlock: 'reviewing', blockReason: 'Approved revision' },
      attempts: [{ agent: 'executor', reviewer: 'reviewer' }],
      discussionAttempts: [{ endedAt: 'closed', result: 'discussed', context: 'current', attempt: 1, roundId: 'discussion' }],
      planningAttempts: [{ n: 2, result: 'superseded', attempt: 1, agent: 'planner' }],
      blockHistory: [{ reason: 'Test scope', question: 'Include test?', answer: 'Yes' }] },
    events: [
      { task: 'T1', type: 'task_review', attempt: 1, reviewer: 'reviewer' },
      { task: 'T1', type: 'task_block', blockKind: 'replan', reason: 'Approved revision' },
      { task: 'T1', type: 'task_planning' },
      { task: 'T1', type: 'task_block', blockKind: 'external', reason: 'Test scope', question: 'Include test?' },
      { task: 'T1', type: 'task_unblock', state: 'planning', attempt: 1, agent: 'planner', answer: 'Yes' },
      { task: 'T1', type: 'task_discussion', roundId: 'discussion', attempt: 1, superseded: [{ workflow: 'planning', round: 2 }] },
      { task: 'T1', type: 'task_discussed', roundId: 'discussion', state: 'blocked' },
    ],
  }
}

test('recovery proves the original pause without mutating supplied history or task', () => {
  const { task, events } = evidence(), before = structuredClone({ task, events })
  assert.deepEqual(replanningRecovery(task, events, 'current', true), {
    blockKind: 'replan', stateBeforeBlock: 'reviewing', blockReason: 'Approved revision', roundId: 'discussion', attempt: 1,
  })
  assert.deepEqual({ task, events }, before)
})

test('recovery accepts an execution pause and an externally approved scope converted to replanning', () => {
  const { task, events } = evidence()
  task.planningReturn.stateBeforeBlock = 'running'
  task.planningReturn.blockReason = 'approved scope needs current planning'
  events[0] = { task: 'T1', type: 'task_start', attempt: 1, agent: 'executor' }
  events[1] = { task: 'T1', type: 'task_unblock', state: 'blocked' }
  events.push({ type: 'plan_sync', updated: ['T2'] }, { type: 'task_block', task: 'T2' })
  assert.equal(replanningRecovery(task, events, 'current', true).stateBeforeBlock, 'running')
})

test('recovery refuses missing or contradictory evidence rather than clearing an external decision or guessing a return state', () => {
  const mutations = [
    t => { t.state = 'pending' },
    ...['blockKind', 'blockReason', 'blockQuestion', 'blockOptions', 'stateBeforeBlock'].map(key => t => { t[key] = 'external' }),
    t => { t.planningRequired = false }, t => { delete t.planningReturn },
    t => { t.planningReturn.blockKind = 'external' }, t => { t.planningReturn.stateBeforeBlock = 'pending' },
    t => { delete t.planningReturn.blockReason }, t => { t.planningReturn.blockReason = ' ' },
    t => { delete t.attempts }, t => { t.attempts = [] }, t => { t.attempts[0].endedAt = 'closed' },
    t => { t.attempts[0].result = 'failed' }, t => { t.attempts[0].agent = 'other' },
    t => { delete t.reviewer }, t => { t.attempts[0].reviewer = 'other' },
    t => { t.reviewer = t.agent; t.attempts[0].reviewer = t.agent },
    t => { delete t.discussionAttempts }, t => { t.discussionAttempts = [] },
    t => { delete t.discussionAttempts[0].endedAt }, t => { t.discussionAttempts[0].result = 'superseded' },
    t => { t.discussionAttempts[0].context = 'stale' }, t => { t.discussionAttempts[0].attempt = 2 },
    t => { delete t.planningAttempts }, t => { t.planningAttempts = [] },
    t => { t.planningAttempts[0].result = 'blocked' }, t => { t.planningAttempts[0].attempt = 2 },
    t => { delete t.blockHistory }, t => { t.blockHistory = [] },
    t => { t.blockHistory[0].question = 'Other?' }, t => { t.blockHistory[0].answer = 'No' },
    t => { t.blockHistory[0].reason = 'Other reason' },
  ]
  for (const mutate of mutations) {
    const { task, events } = evidence()
    mutate(task)
    assert.throws(() => replanningRecovery(task, events, 'current', true), /requires matching/)
  }
  const eventMutations = [
    e => e.splice(0), e => { e[3].type = 'task_block_updated' }, e => { e[3].blockKind = 'replan' },
    e => { delete e[3].question }, e => { e[4].type = 'task_fail' }, e => { e[4].state = 'running' },
    e => { e[4].attempt = 2 }, e => { e[4].agent = 'other' }, e => { delete e[4].answer },
    e => { e[5].type = 'task_planning' }, e => { e[5].roundId = 'other' }, e => { e[5].attempt = 2 },
    e => { delete e[5].superseded }, e => { e[5].superseded = [{ workflow: 'discussion', round: 2 }] },
    e => { e[5].superseded[0].round = 1 }, e => { e[6].type = 'task_skip' },
    e => { e[6].state = 'pending' }, e => { e[6].roundId = 'other' },
    e => e.push({ type: 'plan_sync', updated: ['T1'] }), e => { e[0].type = 'task_start' },
    e => { e[0].attempt = 2 }, e => { e[0].reviewer = 'other' }, e => { e[1].type = 'task_note' },
    e => { e[1].reason = 'Other reason' }, e => { e[1].type = 'task_unblock'; e[1].state = 'blocked' },
    e => { [e[0], e[1]] = [e[1], e[0]] },
  ]
  for (const mutate of eventMutations) {
    const { task, events } = evidence()
    mutate(events)
    assert.throws(() => replanningRecovery(task, events, 'current', true), /requires matching/)
  }
  const { task, events } = evidence()
  assert.throws(() => replanningRecovery(task, events, 'current', false), /requires matching/)
  task.planningReturn.stateBeforeBlock = 'running'
  events[0] = { task: 'T1', type: 'task_start', attempt: 1, agent: 'other' }
  assert.throws(() => replanningRecovery(task, events, 'current', true), /requires matching/)
})
