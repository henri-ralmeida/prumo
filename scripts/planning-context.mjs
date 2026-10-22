// Propostas e notas dão contexto; não substituem contratos nem comprovam decisões do usuário.
export function questionAnswerOrigin(question, task, phaseDiscovery) {
  if (!question.answer) return 'proposal'
  const discoveries = [phaseDiscovery, task.discovery, ...(task.discussionAttempts ?? []).map(round => round.discovery)]
  return discoveries.some(discovery => discovery?.questions?.some(item =>
    item.question === question.question && item.answer === question.answer && item.channel))
    ? 'user-discussion' : 'unverified'
}

export function missingExecutionSteps(task) {
  const attempt = task.attempts.at(-1) ?? {}
  if (!Array.isArray(attempt.executionSteps)) return null
  const recorded = new Set(attempt.executionSteps)
  return task.taskPlan.steps.map((_, index) => index + 1).filter(index => !recorded.has(index))
}

// A ordem visual pode mudar sem inventar dependências ou reescrever trabalho já executado.
export function phaseOrderChange(state, plan) {
  const oldOrder = (state.plan.phases ?? []).map(phase => phase.id)
  const nextOrder = (plan.phases ?? []).map(phase => phase.id)
  const common = nextOrder.filter(id => oldOrder.includes(id))
  const previous = oldOrder.filter(id => common.includes(id))
  if (JSON.stringify(common) === JSON.stringify(previous)) return null
  const moved = common.filter((id, index) => id !== previous[index])
  const started = Object.values(state.tasks).filter(task => moved.includes(task.phase) &&
    ((task.attempts?.length ?? 0) > 0 || ['running', 'reviewing', 'done', 'skipped'].includes(task.state)))
  const positions = new Map(nextOrder.map((id, index) => [id, index]))
  const tasks = new Map(plan.tasks.map(task => [task.id, task]))
  const conflicts = plan.tasks.flatMap(task => (task.deps ?? []).filter(dep =>
    positions.get(tasks.get(dep)?.phase) > positions.get(task.phase))
    .map(dep => `${task.id} <- ${dep}`))
  return { previous: oldOrder, order: nextOrder, started: started.map(task => task.id), conflicts }
}
