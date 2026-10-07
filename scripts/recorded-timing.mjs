/** Recorded stage duration is a fallback, not proof of active work or measured savings. */
export function recordedAgentTiming(state, events = [], now = Date.now(), historyComplete = true) {
  const roles = Object.fromEntries(['discussion', 'planning', 'execution', 'review'].map(role => [role, { durationMs: 0, measuredMs: 0, stageMs: 0, partial: false }]))
  const agents = Object.create(null), ranges = [], stageRanges = [], globalPauses = (state.runPauseHistory ?? []).map(pause => [Date.parse(pause.startedAt), Date.parse(pause.endedAt ?? new Date(now).toISOString())])
  if (state.runPause && !state.runPauseHistory?.some(pause => pause.startedAt === state.runPause.startedAt)) globalPauses.push([Date.parse(state.runPause.startedAt), Date.parse(state.runPause.endedAt ?? new Date(now).toISOString())])
  const pauses = Object.create(null), pending = Object.create(null)
  for (const event of events) {
    if (event.type === 'task_block') pending[event.task] ??= Date.parse(event.at)
    else if (['task_unblock', 'task_done', 'task_skip', 'task_fail'].includes(event.type) && pending[event.task] !== undefined) {
      ;(pauses[event.task] ??= []).push([pending[event.task], Date.parse(event.at)])
      delete pending[event.task]
    }
  }
  for (const [id, start] of Object.entries(pending)) (pauses[id] ??= []).push([start, now])
  const segments = (start, end, excluded) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    let result = [[start, Math.min(end, now)]]
    for (const [from, to] of excluded) if (Number.isFinite(from) && Number.isFinite(to) && to > from) result = result.flatMap(([a, b]) => to <= a || from >= b ? [[a, b]] : [[a, Math.min(b, from)], [Math.max(a, to), b]].filter(([x, y]) => y > x))
    return result.filter(([a, b]) => b > a)
  }
  const union = values => {
    let total = 0, until = -Infinity
    for (const [start, end] of values.slice().sort((a, b) => a[0] - b[0])) { total += Math.max(0, end - Math.max(start, until)); until = Math.max(until, end) }
    return total
  }
  const visit = (round, role, active, id, fallbackAgent) => {
    const start = role === 'review' ? round.reviewStartedAt : round.startedAt
    const firstReview = [round.reviewStartedAt, ...(round.reviewHistory ?? []).map(review => review.reviewStartedAt)].filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
    const endedAt = role === 'execution' ? firstReview ?? round.endedAt : role === 'review' ? round.reviewEndedAt ?? round.endedAt : round.endedAt
    const end = endedAt ?? (active ? new Date(now).toISOString() : undefined)
    const excluded = [...globalPauses, ...(pauses[id] ?? [])]
    const stage = segments(Date.parse(start), Date.parse(end), excluded)
    const intervals = (round.activityIntervals ?? []).filter(interval => interval.role === role)
    // Resume advances recorded stage duration, without reopening measured activity.
    const resumed = globalPauses.filter(([from, to]) => Number.isFinite(to) && intervals.some(interval => interval.closedBy === 'run-pause' && Date.parse(interval.endedAt) === from)).flatMap(([, to]) => {
      const next = intervals.map(interval => Date.parse(interval.startedAt)).filter(value => value >= to).sort((a, b) => a - b)[0]
      return segments(Math.max(to, Date.parse(start)), Math.min(next ?? Infinity, Date.parse(end)), excluded)
    })
    const clockRanges = intervals.length ? [
      ...segments(Date.parse(start), Date.parse(intervals[0].startedAt), excluded),
      ...intervals.flatMap(interval => segments(Date.parse(interval.startedAt), Date.parse(interval.endedAt ?? endedAt ?? (active ? new Date(now).toISOString() : undefined)), excluded)),
      ...resumed,
    ] : stage
    stageRanges.push(...clockRanges)
    const selected = intervals.length ? intervals.flatMap(interval => segments(Date.parse(interval.startedAt), Date.parse(interval.endedAt ?? endedAt ?? (active ? new Date(now).toISOString() : undefined)), excluded).map(range => ({ range, agent: interval.agent ?? fallbackAgent, kind: 'measured' }))) : stage.map(range => ({ range, agent: fallbackAgent, kind: 'stage' }))
    selected.push(...resumed.map(range => ({ range, agent: fallbackAgent, kind: 'stage' })))
    if (!historyComplete || !selected.length || round.activityLegacy) roles[role].partial = true
    for (const item of selected) ranges.push({ ...item, role, agent: item.agent ?? `(unassigned:${id ?? 'phase'}:${role})` })
  }
  for (const [id, task] of Object.entries(state.tasks ?? {})) {
    const inRole = status => task.state === status || task.state === 'blocked' && task.stateBeforeBlock === status && pending[id] !== undefined
    const currentRole = { discussing: 'discussion', planning: 'planning', running: 'execution', reviewing: 'review' }[task.state]
    if (currentRole && (currentRole === 'execution' || currentRole === 'review' ? !task.attempts?.length : !task[`${currentRole}Attempts`]?.length)) roles[currentRole].partial = true
    for (const role of ['discussion', 'planning']) (task[`${role}Attempts`] ?? []).forEach((round, index, rounds) => {
      const phaseRounds = state.phaseWorkflows?.[task.phase]?.[`${role}Attempts`] ?? []
      if (Number.isFinite(Date.parse(round.startedAt)) && phaseRounds.some(phaseRound => phaseRound.workers?.[id]?.startedAt === round.startedAt)) return
      visit(round, role, index === rounds.length - 1 && inRole(role === 'discussion' ? 'discussing' : 'planning'), id, round.agent ?? round.activityAgent)
    })
    if (!task.planningAttempts?.length && task.taskPlan && !task.taskPlan.phaseBinding && !state.phaseWorkflows?.[task.phase]?.planningAttempts?.length) {
      visit({ startedAt: task.taskPlan.startedAt, endedAt: task.taskPlan.completedAt, activityLegacy: true }, 'planning', false, id, task.taskPlan.planner)
    }
    if (task.discovery && !task.discussionAttempts?.length) roles.discussion.partial = true
    ;(task.attempts ?? []).forEach((round, index, rounds) => {
      visit(round, 'execution', index === rounds.length - 1 && inRole('running'), id, round.agent)
      const reviews = round.reviewHistory?.length ? [...round.reviewHistory, { ...round, reviewHistory: undefined }] : [round]
      reviews.forEach((review, reviewIndex) => {
        const receiptEnd = (task.validations ?? []).findLast(receipt => receipt.by === 'review' && receipt.attempt === (round.n ?? index + 1) && (!review.reviewer || receipt.agent === review.reviewer))?.at
        if (review.reviewStartedAt || review.activityIntervals?.some(interval => interval.role === 'review')) visit({ ...review, reviewEndedAt: review.reviewEndedAt ?? receiptEnd }, 'review', index === rounds.length - 1 && reviewIndex === reviews.length - 1 && inRole('reviewing'), id, review.reviewer)
      })
    })
  }
  for (const phase of Object.values(state.phaseWorkflows ?? {})) for (const role of ['discussion', 'planning']) (phase[`${role}Attempts`] ?? []).forEach((round, index, rounds) => {
    const workers = round.workers ? Object.entries(round.workers) : [[phase.id, round]]
    for (const [id, worker] of workers) visit({ ...worker, endedAt: worker.endedAt ?? round.endedAt }, role, index === rounds.length - 1 && !worker.endedAt && phase.state === (role === 'discussion' ? 'discussing' : 'planning'), id, worker.agent ?? worker.activityAgent)
  })
  for (const role of Object.keys(roles)) {
    const selected = ranges.filter(item => item.role === role)
    for (const agent of new Set(selected.map(item => item.agent))) {
      const own = selected.filter(item => item.agent === agent)
      const measured = union(own.filter(item => item.kind === 'measured').map(item => item.range))
      const duration = union(own.map(item => item.range))
      ;(agents[agent] ??= {})[role] = { durationMs: duration, measuredMs: measured, stageMs: duration - measured }
      roles[role].durationMs += duration; roles[role].measuredMs += measured; roles[role].stageMs += duration - measured
    }
  }
  return { roles, agents, elapsedMs: union(stageRanges), partial: !historyComplete || Object.values(roles).some(role => role.partial), paused: Boolean(state.runPause && !state.runPause.endedAt) }
}
