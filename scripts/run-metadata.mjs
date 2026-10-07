export const agentRoles = ['discussion', 'planning', 'execution', 'review']
/** Literal overlap is an advisory: it cannot decide whether the question is semantically settled. */
export function repeatedPlanQuestions(task, plan, phaseDiscovery) {
  const normalize = text => typeof text === 'string' ? text.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US') : ''
  const answered = new Set([task.discovery, phaseDiscovery, plan].filter(Boolean).flatMap(context => [...(context.questions ?? []), ...(context.decisions ?? [])]).filter(item => typeof item?.answer === 'string' && item.answer.trim()).map(item => normalize(item.question)).filter(Boolean))
  return (plan.openQuestions ?? []).flatMap((item, index) => answered.has(normalize(item?.question)) ? [index + 1] : [])
}
export function recordedPlanIdentity(task) {
  const plan = task.taskPlan
  if (!plan) return null
  return { digest: plan.digest ?? null, sourcePath: plan.sourcePath ?? null, plannerRound: plan.phaseBinding?.plannerRound ?? null, sourceAttempt: plan.attempt ?? null, embeddedInState: true }
}
export function assertRolePreferences(preferences) {
  if (preferences === undefined) return
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new Error('rolePreferences must be an object')
  for (const [role, preference] of Object.entries(preferences)) {
    if (!agentRoles.includes(role) || !preference || typeof preference !== 'object' || Array.isArray(preference) || Object.keys(preference).some(key => !['model', 'effort'].includes(key)) || !Object.keys(preference).length || Object.values(preference).some(value => typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f]/.test(value))) throw new Error('Role preference requires a known role and nonempty bounded model/effort')
  }
}
export function dispatchOwners(state) {
  const owners = []
  for (const [scope, targets] of [['task', state.tasks ?? {}], ['phase', state.phaseWorkflows ?? {}]]) {
    for (const [id, target] of Object.entries(targets)) {
      for (const role of ['discussion', 'planning']) (target[`${role}Attempts`] ?? []).forEach((round, index) => {
        if (round.workers) {
          for (const [task, worker] of Object.entries(round.workers)) owners.push({ key: `${scope}:${id}:${role}:${index}:${task}`, task, role, owner: worker, agent: worker.agent, startedAt: worker.startedAt })
        } else owners.push({ key: `${scope}:${id}:${role}:${index}`, task: scope === 'task' ? id : null, role, owner: round, agent: round.agent ?? round.activityAgent, startedAt: round.startedAt })
      })
      if (scope === 'task') (target.attempts ?? []).forEach((attempt, index) => {
        owners.push({ key: `${scope}:${id}:execution:${index}`, task: id, role: 'execution', owner: attempt, agent: attempt.agent, startedAt: attempt.startedAt })
        if (attempt.reviewStartedAt) owners.push({ key: `${scope}:${id}:review:${index}`, task: id, role: 'review', owner: attempt, agent: attempt.reviewer, startedAt: attempt.reviewStartedAt })
      })
    }
  }
  return owners
}
export function recordDispatchMetadata(before, state, reported = {}, redispatchTask) {
  const old = new Map(dispatchOwners(before).map(item => [item.key, item]))
  const records = []
  for (const item of dispatchOwners(state)) {
    const previous = old.get(item.key)
    const unchanged = previous?.agent === item.agent && previous?.startedAt === item.startedAt
    const task = state.tasks?.[redispatchTask]
    const resumedRole = { running: 'execution', reviewing: 'review' }[task?.state]
    const hasDispatchValues = reported.model !== undefined || reported.effort !== undefined || state.plan.rolePreferences?.[resumedRole] !== undefined
    const redispatched = hasDispatchValues && item.task === redispatchTask && item.role === resumedRole && item.owner === task?.attempts?.at(-1)
    if (unchanged && !redispatched) continue
    if (item.role === 'review' && previous?.startedAt && !unchanged) {
      ;(item.owner.reviewHistory ??= []).push({ reviewer: previous.agent, reviewStartedAt: previous.startedAt, reviewEndedAt: item.startedAt, activityIntervals: (previous.owner.activityIntervals ?? []).filter(interval => interval.role === 'review').map(interval => ({ ...interval, endedAt: interval.endedAt ?? item.startedAt })) })
      item.owner.activityIntervals = (item.owner.activityIntervals ?? []).filter(interval => interval.role !== 'review')
      delete item.owner.reviewEndedAt
    }
    const preference = state.plan.rolePreferences?.[item.role]
    const supplied = Object.fromEntries(['model', 'effort'].filter(key => reported[key] !== undefined).map(key => [key, reported[key]]))
    assertRolePreferences({ [item.role]: { ...(preference ?? {}), ...(Object.keys(supplied).length ? supplied : { model: 'unspecified' }) } })
    const record = { role: item.role, agent: item.agent ?? null, startedAt: item.startedAt, dispatchedAt: new Date().toISOString(), requested: preference ? { ...preference } : null, reported: Object.keys(supplied).length ? supplied : null, selfReported: true }
    ;(item.owner.modelDispatches ??= []).push(record)
    records.push(record)
  }
  return records
}
export function reportedUsageTotals(state) {
  const tasks = Object.create(null), run = { tokens: 0, tools: 0, receipts: 0, selfReported: true }
  for (const item of dispatchOwners(state)) {
    // Execution and review share an owner; its receipts must only be visited once.
    if (item.role === 'review') continue
    for (const receipt of item.owner.usageReports ?? []) {
      const total = tasks[receipt.task] ??= { tokens: 0, tools: 0, receipts: 0, selfReported: true }
      for (const key of ['tokens', 'tools']) {
        total[key] += receipt[key] ?? 0; run[key] += receipt[key] ?? 0
        if (!Number.isSafeInteger(total[key]) || !Number.isSafeInteger(run[key])) throw new Error('Reported usage totals exceed safe integer limits')
      }
      total.receipts++; run.receipts++
    }
  }
  return { tasks, run }
}
export function pauseRun(state, reason, until, at) {
  if (state.runPause && !state.runPause.endedAt) throw new Error('Run is already paused; resume-run explicitly first')
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('pause-run requires a reason')
  if (until !== undefined && (!/^\d{4}-\d{2}-\d{2}T/.test(until) || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.parse(at))) throw new Error('--until must be a future ISO timestamp; it is only a forecast')
  state.runPause = { reason, startedAt: at, ...(until === undefined ? {} : { until }) }
  ;(state.runPauseHistory ??= []).push(state.runPause)
  const roleStates = { discussing: 'discussion', planning: 'planning', running: 'execution', reviewing: 'review' }
  for (const target of [...Object.values(state.tasks), ...Object.values(state.phaseWorkflows ?? {})]) {
    const role = roleStates[target.state]
    if (!role) continue
    const round = ['execution', 'review'].includes(role) ? target.attempts?.at(-1) : target[`${role}Attempts`]?.at(-1)
    if (!round || round.endedAt) continue
    for (const owner of round.workers ? Object.values(round.workers) : [round]) {
      if (owner.endedAt) continue
      for (const interval of owner.activityIntervals ?? []) if (interval.role === role && !interval.endedAt) { interval.endedAt = at; interval.closedBy = 'run-pause' }
    }
  }
  // Invalidates in-flight validation without rewriting states, attempts or phase queues.
  for (const task of Object.values(state.tasks)) if (['running', 'reviewing'].includes(task.state)) task.stateRevision = (task.stateRevision ?? 0) + 1
}
export function resumeRun(state, at) {
  if (!state.runPause || state.runPause.endedAt) throw new Error('Run is not paused')
  state.runPause.endedAt = at
  const history = state.runPauseHistory?.at(-1)
  if (history?.startedAt === state.runPause.startedAt) history.endedAt = at
}
export function shellCommand(tokens, powershell = process.platform === 'win32' && !process.env.MSYSTEM && !process.env.SHELL) {
  const quote = value => "'" + String(value).replaceAll("'", powershell ? "''" : "'\\''") + "'"
  return (powershell ? '& ' : '') + tokens.map(quote).join(' ')
}
export function taskBrief(state, task, role, command) {
  if (!['executor', 'reviewer'].includes(role)) throw new Error('brief requires --role executor|reviewer')
  const attempt = task.attempts?.at(-1)
  const verdict = task.validations?.findLast(receipt => receipt.by === 'review' && !receipt.ok && (!receipt.token || Object.hasOwn(receipt, 'error')))
  const failure = task.attempts?.findLast(item => item.result === 'failed')
  const phase = Object.hasOwn(state.phaseWorkflows ?? {}, task.phase) ? state.phaseWorkflows[task.phase] : null
  return {
    role, run: state.run, task: task.id, state: task.state, runPause: state.runPause ?? null,
    context: { name: state.plan.name, description: state.plan.description },
    contract: Object.fromEntries(['title', 'deps', 'touches', 'writeScope', 'sharedResources', 'unavailable', 'validation', 'validationMode', 'inspectionReason', 'textRules', 'deliveries', 'numericProvenance'].filter(key => task[key] !== undefined).map(key => [key, task[key]])),
    taskPlan: task.taskPlan ?? null, planIdentity: recordedPlanIdentity(task), planningSkips: task.planningSkips ?? [], discussionSkips: task.discussionSkips ?? [],
    discovery: task.discovery ?? null,
    phaseContext: phase ? { phase: task.phase, discovery: phase.discovery ?? null, discussionSkips: phase.discussionSkips ?? [], planningSkips: phase.planningSkips ?? [] } : null,
    dependencyDeliveries: (task.deps ?? []).map(id => ({ task: id, state: state.tasks[id]?.state, deliveries: state.tasks[id]?.deliveries ?? [], terminalReceipt: state.tasks[id]?.state === 'done' ? state.tasks[id].validations?.at(-1) ?? null : null, skipReason: state.tasks[id]?.skipReason ?? null })),
    baseline: attempt?.deliveryBaseline ? { paths: Object.keys(attempt.deliveryBaseline.files), limitation: attempt.deliveryBaseline.limitation ?? null } : null,
    scopeBaseline: attempt?.scopeBaseline ? { method: attempt.scopeBaseline.method, cwd: attempt.scopeBaseline.cwd, limitation: attempt.scopeBaseline.limitation } : null,
    receipts: task.validations ?? [], inputReceipt: attempt?.inputReceipt ?? null,
    lastRejection: verdict ? { agent: verdict.agent ?? null, by: verdict.by, attempt: verdict.attempt, at: verdict.at, summary: verdict.summary, evidence: verdict.evidence, error: verdict.error } : failure ? { reason: failure.reason, attempt: failure.n, reviewer: failure.reviewer ?? null, executor: failure.agent ?? null } : null,
    modelPreference: state.plan.rolePreferences?.[role === 'executor' ? 'execution' : 'review'] ?? null,
    rolePreferences: state.plan.rolePreferences ?? {},
    planningAndDiscussionDispatches: dispatchOwners(state).filter(item => item.task === task.id && ['discussion', 'planning'].includes(item.role)).flatMap(item => item.owner.modelDispatches ?? []),
    modelDispatches: attempt?.modelDispatches ?? [], modelNotice: 'Preferences and dispatch values are reported; the engine does not call or verify models.',
    rules: ['Keep internal identifiers out of new product text; apply approved literal patterns and specific exceptions.', 'Inspect the current delivery and validate every applicable criterion independently; previous receipts are historical evidence, not a new reviewer verdict.', 'Check sources, exact locations, declared values and calculation rules for numeric summaries. Dependency receipts do not prove counts.'],
    commands: [command(['show-contract', task.id]), command(['show-check', task.id]), ...(role === 'reviewer' ? [command(['validate', task.id, '--ok', '--evidence', '<independent observations>', ...(state.plan.cwd ? ['--cwd', state.plan.cwd] : [])])] : [])],
  }
}
