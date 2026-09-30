// STOP de execucao encerra o trabalho aferido; a espera pelo Revisor e um estado derivado.
export function isReadyForReview(task, plan = {}) {
  if (task?.state !== 'running' || (task.requireReview ?? plan.requireReview) === false) return false
  const attempt = task.attempts?.at(-1)
  if (attempt?.activityTiming !== 'explicit' || attempt.reviewStartedAt) return false
  const intervals = attempt.activityIntervals ?? []
  if (intervals.some(interval => !interval.endedAt)) return false
  const execution = intervals.filter(interval => interval.role === 'execution').at(-1)
  const start = Date.parse(execution?.startedAt ?? ''), stop = Date.parse(execution?.endedAt ?? '')
  return Number.isFinite(start) && Number.isFinite(stop) && stop >= start
}
