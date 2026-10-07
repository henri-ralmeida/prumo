// STOP de execucao encerra o trabalho aferido; a espera pelo Revisor e um estado derivado.
export function isReviewRejected(task) {
  if (task?.state !== 'reviewing') return false
  const attempt = task.attempts?.at(-1)
  if (!attempt) return false
  const start = Date.parse(attempt.startedAt ?? '')
  const number = attempt.n ?? task.attempts.length
  const receipt = (task.validations ?? []).filter(validation => validation.by === 'review' &&
    (validation.attempt == null || Number(validation.attempt) === Number(number)) &&
    Date.parse(validation.at ?? '') >= start).at(-1)
  // Durante a validação, ok=false apenas invalida o parecer anterior; error só existe no resultado concluído.
  if (receipt?.ok !== false || (receipt.token && !Object.hasOwn(receipt, 'error'))) return false
  return !(attempt.activityIntervals ?? []).some(interval => interval.role === 'review' && !interval.endedAt &&
    Date.parse(interval.startedAt ?? '') > Date.parse(receipt.at))
}

export function isReadyForReview(task, plan = {}) {
  if (task?.state !== 'running' || (task.requireReview ?? plan.requireReview) === false) return false
  const attempt = task.attempts?.at(-1)
  if (attempt?.activityTiming !== 'explicit' || attempt.reviewStartedAt) return false
  const intervals = attempt.activityIntervals ?? []
  if (intervals.some(interval => !interval.endedAt)) return false
  const execution = intervals.filter(interval => interval.role === 'execution').at(-1)
  if (execution?.closedBy === 'run-pause') return false
  const start = Date.parse(execution?.startedAt ?? ''), stop = Date.parse(execution?.endedAt ?? '')
  return Number.isFinite(start) && Number.isFinite(stop) && stop >= start
}
