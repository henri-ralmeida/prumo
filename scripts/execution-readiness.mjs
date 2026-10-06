import { createHash } from 'node:crypto'
import { hasCurrentTaskPlan, usesCurrentPlanning } from './validation.mjs'
import { scopeConflicts } from './task-scope.mjs'

const digestValue = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function executionReadiness(state, task, derived) {
  const reasons = []
  const add = (code, message, details = {}) => reasons.push({ code, message, ...details })
  if (task.state !== 'pending') add('state', 'Task is not pending execution')
  if (state.plan.scopePolicy === 'explicit' && (!task.writeScope || task.writeScope === 'unknown')) add('scope_unknown', 'Write scope must be resolved before execution')
  if (derived.blockedBy.length) add('dependencies', 'Dependencies are not complete', { taskIds: derived.blockedBy })
  if (usesCurrentPlanning(state, task) && (!hasCurrentTaskPlan(state, task) || !['phase', 'task'].includes(state.plan.planningMode))) add('planning', 'Current planning is required before execution')
  if (derived.effective === 'ready_for_discussion' || derived.effective === 'discussing') add('discussion', 'Current discussion is required before execution')
  if (!taskAuthorization(task) && (task.authorizationHistory?.length || runHasAuthorizationScope(state))) add('authorization', 'Execution authorization is required')
  if (taskAuthorization(task)?.mode === 'manual') add('manual_confirmation', 'User confirmation is required for dispatch')
  if (overdueQuestions(state, task.id, task.phase).length) add('questions', 'Due questions require answers before execution')
  const occ = occupancy(state)
  if (occ.executors.length >= occ.maxExec || occ.busy.filter(value => value.id !== task.id).length >= occ.cap) add('capacity', 'Execution capacity is occupied')
  if (state.plan.scopePolicy === 'explicit') for (const other of occ.busy.filter(other => other.id !== task.id && other.touches)) {
    const { paths, resources } = scopeConflicts(task, other)
    if (paths.length) add('path_conflict', 'An active task owns overlapping paths', { taskIds: [other.id], paths })
    if (resources.length) add('shared_resource_conflict', 'An active task owns a conflicting shared resource', { taskIds: [other.id], resources })
  }
  return { ready: !reasons.length, reasons }
}

export function planQuestionRef(task, plan, index) {
  const fingerprint = digestValue([task.id, plan?.startedAt ?? '', index + 1, plan?.openQuestions?.[index]?.question])
  return plan?.openQuestions?.[index]?.questionRef ?? `${task.id}:plan:${fingerprint.slice(0, 12)}`
}

export function openQuestionRecords(state) {
  const out = []
  for (const task of Object.values(state.tasks)) {
    const plan = task.taskPlan
    // A pergunta persiste enquanto este taskPlan for o atual, inclusive durante
    // replanejamento; só um novo plano ou uma decisão pode substituí-la.
    if (!plan) continue
    for (const [index, question] of (plan?.openQuestions ?? []).entries()) {
      if (!question || typeof question.question !== 'string') continue
      const decideBy = question.blocking ? 'user-now' : (question.decideBy ?? 'executor')
      out.push({ ref: planQuestionRef(task, plan, index), sourceTask: task.id, question,
        decideBy, planAt: plan.completedAt ?? plan.startedAt ?? '' })
    }
  }
  return out
}

export function questionResolutionMap(state) {
  const out = new Map()
  for (const entry of state.questionResolutions ?? [])
    if (entry.questionRef) out.set(entry.questionRef, entry)
  for (const task of Object.values(state.tasks)) {
    const decisions = [
      ...(task.taskPlan?.decisions ?? []),
      ...(task.discovery?.decisions ?? []),
      ...(task.planningHistory ?? []).flatMap(plan => plan.decisions ?? []),
      ...(task.discussionAttempts ?? []).flatMap(round => round.discovery?.decisions ?? []),
    ]
    for (const decision of decisions) if (decision?.resolvesQuestion)
      out.set(decision.resolvesQuestion, { questionRef: decision.resolvesQuestion, byTask: task.id,
        answer: decision.answer, at: task.taskPlan?.completedAt ?? task.discovery?.recordedAt ?? null })
  }
  for (const phase of Object.values(state.phaseWorkflows ?? {})) {
    const decisions = [
      ...(phase.discovery?.decisions ?? []),
      ...(phase.discussionAttempts ?? []).flatMap(round => round.discovery?.decisions ?? []),
    ]
    for (const decision of decisions) if (decision?.resolvesQuestion)
      out.set(decision.resolvesQuestion, { questionRef: decision.resolvesQuestion, byPhase: phase.id,
        answer: decision.answer, at: phase.discovery?.recordedAt ?? null })
  }
  return out
}

export function taskHasStarted(state, task) {
  return Boolean(task && ((task.discussionAttempts?.length ?? 0) || (task.planningAttempts?.length ?? 0) ||
    (task.discussionSkips?.length ?? 0) || (task.planningSkips?.length ?? 0) ||
    (task.attempts?.length ?? 0) || ['running', 'reviewing', 'done', 'skipped'].includes(task.state)))
}

export function phaseWorkflowHasStarted(state, phaseId, taskId = null) {
  const workflow = state.phaseWorkflows?.[phaseId]
  if (!workflow) return false
  const records = [
    ...(workflow.discussionAttempts ?? []).map(item => ({ item, targets: item.targets })),
    ...(workflow.planningAttempts ?? []).map(item => ({ item, targets: [...(item.targets ?? []), ...(item.contextTargets ?? [])] })),
    ...(workflow.discussionSkips ?? []).map(item => ({ item, targets: item.targets })),
    ...(workflow.planningSkips ?? []).map(item => ({ item, targets: item.targets })),
  ]
  return records.some(({ item, targets }) => Boolean(item) && (taskId === null || targets?.includes(taskId)))
}

export function targetHasStarted(state, decideBy) {
  if (!decideBy || typeof decideBy !== 'object') return false
  if (decideBy.beforeTask) {
    const target = state.tasks[decideBy.beforeTask]
    if (taskHasStarted(state, target)) return true
    return Boolean(state.plan.planningMode === 'phase' && target?.phase &&
      phaseWorkflowHasStarted(state, target.phase, target.id))
  }
  const phaseId = decideBy.beforePhase
  return phaseWorkflowHasStarted(state, phaseId) || Object.values(state.tasks).some(task =>
    task.phase === phaseId && taskHasStarted(state, task))
}

export function overdueQuestions(state, taskId = null, phaseId = null) {
  const resolved = questionResolutionMap(state)
  return openQuestionRecords(state).filter(item => {
    if (item.question.answer || resolved.has(item.ref)) return false
    if (!questionIsOverdue(state, item)) return false
    if (item.decideBy === 'user-now') return !taskId || item.sourceTask === taskId
    if (item.decideBy?.beforeTask) return item.decideBy.beforeTask === taskId
    if (item.decideBy?.beforePhase) return item.decideBy.beforePhase === phaseId
    return false
  })
}

export function questionIsOverdue(state, item) {
  if (item.decideBy === 'user-now') return true
  if (item.decideBy === 'executor') return false
  return targetHasStarted(state, item.decideBy)
}

export function taskAuthorization(task) { return task.executionAuthorization ?? null }

export function runHasAuthorizationScope(state) {
  return (state.authorizations?.length ?? 0) > 0 || Object.values(state.tasks).some(task =>
    task.executionAuthorization || task.authorizationHistory?.length)
}

export function occupancy(state) {
  const all = Object.values(state.tasks)
  const executors = all.filter((t) => t.state === 'running')
  const reviewers = all.filter((t) => t.state === 'reviewing')
  const planners = all.filter((t) => t.state === 'planning')
  const phasePlanners = Object.values(state.phaseWorkflows ?? {}).filter(phase => phase.state === 'planning')
  return {
    executors,
    reviewers,
    planners: [...planners, ...phasePlanners],
    phasePlanners,
    busy: [...executors, ...reviewers, ...planners, ...phasePlanners],
    maxExec: state.plan.maxExecutors ?? 3,
    cap: state.plan.maxParallel ?? 4,
  }
}
