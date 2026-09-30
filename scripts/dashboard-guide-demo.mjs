// O guia usa apenas um plano em memoria; os mesmos renderizadores recebem dados ficticios.
export function createGuideDemoData(mode = 'board') {
  const at = minutes => new Date(Date.UTC(2026, 0, 1, 9) + minutes * 60_000).toISOString()
  const states = ['done', 'done', 'ready_for_discussion', 'discussing', 'ready_to_plan', 'planning', 'ready', 'running', 'reviewing', 'waiting', 'blocked', 'failed', 'skipped']
  const titles = ['orders schema', 'API contracts', 'Scope agreement', 'Checkout discussion', 'Implementation plan', 'Payment planning', 'feature flags', 'payment service', 'event queue', 'end-to-end tests', 'gradual rollout', 'gateway webhooks', 'Legacy integration']
  const tasks = Object.fromEntries(states.map((state, i) => {
    const id = `T${i + 1}`
    const base = i < 2 ? 0 : (Math.floor((i - 2) / 3) + 1) * 25
    const attempt = { n: 1, agent: `executor-${i % 3 + 1}`, reviewer: `reviewer-${i % 3 + 1}`, startedAt: at(base + 5), endedAt: at(base + 15), reviewStartedAt: at(base + 15), reviewEndedAt: at(base + 20), activityTiming: 'explicit',
      activityIntervals: [{ role: 'execution', startedAt: at(base + 5), endedAt: at(base + 15) }, { role: 'review', startedAt: at(base + 15), endedAt: at(base + 20) }], result: 'done' }
    if (mode === 'board' && ['running', 'reviewing'].includes(state)) {
      attempt.endedAt = null
      attempt.result = 'running'
    }
    if (mode === 'board' && state === 'failed') attempt.result = 'failed'
    return [id, { id, title: titles[i], state: mode === 'results' ? 'done' : state, phase: `F${i < 4 ? 1 : i < 9 ? 2 : 3}`, deps: i > 1 ? ['T1'] : [],
      summary: 'The task records its scope, dependencies and validation evidence.', validationSummary: 'The Reviewer verifies the result before completion.', validation: 'echo validation', notes: [],
      attempts: mode === 'results' || ['done', 'running', 'reviewing', 'failed'].includes(state) ? [attempt] : [],
      validations: mode === 'results' || state === 'done' ? [{ by: 'review', ok: true, at: at(base + 20), summary: 'Reviewed and approved.', agent: attempt.reviewer }] : [],
      planningAttempts: [{ n: 1, agent: `planner-${i % 3 + 1}`, startedAt: at(base), endedAt: at(base + 5), activityTiming: 'explicit', activityIntervals: [{ role: 'planning', startedAt: at(base), endedAt: at(base + 5) }] }],
      discussionAttempts: (mode === 'results' && i === 0) || (mode === 'board' && state === 'discussing') ? [{ n: 1, agent: 'orchestrator', startedAt: at(-5), endedAt: at(0), activityTiming: 'explicit', activityIntervals: [{ role: 'discussion', startedAt: at(-5), endedAt: at(0) }] }] : [],
      blockReason: state === 'blocked' ? 'awaiting your decision' : '', blockQuestion: state === 'blocked' ? 'Approve the gradual rollout?' : '', skipReason: state === 'skipped' ? 'This integration is outside the approved scope.' : '',
    }]
  }))
  if (mode === 'board') tasks.T14 = { id: 'T14', title: 'Review handoff', state: 'running', phase: 'F3', deps: ['T2'], agent: 'executor-1', summary: 'Execution is complete; the independent Reviewer is next.', validation: 'echo validation', notes: [], validations: [], planningAttempts: [], attempts: [{ n: 1, agent: 'executor-1', startedAt: at(120), activityTiming: 'explicit', activityIntervals: [{ role: 'execution', agent: 'executor-1', startedAt: at(120), endedAt: at(130) }] }] }
  const derived = Object.fromEntries(Object.values(tasks).map(task => [task.id, { effective: task.state }]))
  return { run: 'checkout', createdAt: at(0), plan: { name: 'Checkout', description: 'An approved checkout plan.', maxParallel: 3, phases: [{ id: 'F1', title: 'Scope and contracts' }, { id: 'F2', title: 'Implementation and review' }, { id: 'F3', title: 'Validation and release' }] }, tasks, derived,
    events: mode === 'board' ? [{type:'task_review',task:'T1',at:at(15)}, {type:'task_note',task:'T14',at:at(130),text:'T1 → T14'}] : [],
    commandMetrics: { total: 39, complete: true, byCommand: { 'plan-task': 13, start: 13, review: 13 } },
  }
}
