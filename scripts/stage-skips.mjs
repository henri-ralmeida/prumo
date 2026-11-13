import { createHash } from 'node:crypto'
import { businessContract } from './contract-drift.mjs'

export const TASK_STAGES = ['discussion', 'planning', 'execution', 'review']

// Renumerar mantém a decisão; mudanças reais de contrato ou escopo exigem outro aceite.
export function stageSkipScope(state, task) {
  const contract = businessContract(state.plan, task)
  delete contract.task.id
  delete contract.task.phase
  delete contract.task.deps
  return createHash('sha256').update(JSON.stringify({ contract, identity: task.stageSkipIdentity, validation: task.validation,
    cwd: state.plan.cwd, contractRevision: task.contractRevision ?? 0,
    scopeRevision: task.scopeRevision ?? 0, planningRevision: task.planningRevision ?? 0 })).digest('hex')
}

export function stageSkipAttempt(task) {
  if (task.state === 'done') return task.completionDecision?.attempt ?? task.attempts.length
  return task.attempts.length + (['running', 'reviewing'].includes(task.state) ? 0 : 1)
}

export function stageSkipReviewRound(task) {
  return stageSkipAttempt(task) === task.attempts.length ? task.attempts.at(-1)?.reviewRound ?? 1 : 1
}

export function currentStageSkips(state, task) {
  const history = Array.isArray(task.stageSkips) ? task.stageSkips : []
  if (!history.length || !task.stageSkipIdentity) return []
  const scope = stageSkipScope(state, task), attempt = stageSkipAttempt(task)
  const round = stageSkipReviewRound(task)
  return history.filter(decision => decision?.decision === 'skipped' && decision.run === state.run && Array.isArray(decision.stages) && decision.confirmedByUser === true &&
    decision.scope === scope && decision.attempt === attempt && decision.reviewRound === round)
}

export function currentStageSkip(state, task, stage) {
  return currentStageSkips(state, task).findLast(decision => decision.stages.includes(stage)) ?? null
}
