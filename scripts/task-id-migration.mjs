import assert from 'node:assert/strict'

// Renomear uma entrega concluída altera suas referências, mas não suas provas nem artefatos assinados.
export function renameHistoricalTasks(originalState, originalPlan, originalEvents, mapping) {
  const state = structuredClone(originalState)
  const plan = structuredClone(originalPlan)
  const remap = id => Object.hasOwn(mapping, id) ? mapping[id] : id
  const destinations = new Set()
  for (const [from, to] of Object.entries(mapping)) {
    const task = state.tasks[from]
    assert.ok(task, `Tarefa ausente: ${from}`)
    assert.ok(['done', 'skipped'].includes(task.state), `A tarefa ${from} ainda está ativa; não pode ser renomeada`)
    assert.match(to, /^T[1-9]\d*[a-z]$/)
    assert.ok(!state.tasks[to] && !destinations.has(to), `Identificador já utilizado: ${to}`)
    assert.ok(state.tasks[to.slice(0, -1)], `Tarefa original ausente: ${to.slice(0, -1)}`)
    assert.ok(!Object.hasOwn(mapping, to.slice(0, -1)), `A tarefa original ${to.slice(0, -1)} precisa manter seu identificador`)
    assert.ok(plan.tasks.some(t => t.id === from), `Tarefa ausente do plano: ${from}`)
    destinations.add(to)
  }
  for (const task of Object.values(state.tasks)) {
    const openWorkflow = [...(task.discussionAttempts ?? []), ...(task.planningAttempts ?? [])].some(round => !round.endedAt)
    if (!['done', 'skipped'].includes(task.state) && (openWorkflow || task.taskPlan || task.executionAuthorization))
      assert.ok(!(task.deps ?? []).some(dep => Object.hasOwn(mapping, dep)), `A tarefa ${task.id} tem um contrato ativo assinado que referencia IDs antigos`)
  }
  for (const phase of Object.values(state.phaseWorkflows ?? {}))
    for (const round of [...(phase.discussionAttempts ?? []), ...(phase.planningAttempts ?? [])])
      if (!round.endedAt) assert.ok(!(round.targets ?? []).some(id => Object.hasOwn(mapping, id)), `A fase ${phase.id} tem uma rodada aberta que referencia IDs antigos`)

  state.tasks = Object.fromEntries(Object.values(state.tasks).map(task => {
    task.id = remap(task.id)
    task.deps = (task.deps ?? []).map(remap)
    return [task.id, task]
  }))
  state.taskIdAliases = Object.fromEntries(Object.entries({ ...(state.taskIdAliases ?? {}), ...mapping }).map(([from, to]) => [from, remap(to)]))
  for (const [from, to] of Object.entries(state.taskIdAliases)) {
    assert.ok(!state.tasks[from], `Alias conflita com uma tarefa existente: ${from}`)
    assert.ok(state.tasks[to], `Alias aponta para uma tarefa ausente: ${to}`)
  }
  // Rodadas fechadas preservam o contrato assinado; seus alvos históricos continuam resolvíveis por alias.
  for (const phase of Object.values(state.phaseWorkflows ?? {}))
    for (const round of [...(phase.discussionAttempts ?? []), ...(phase.planningAttempts ?? [])])
      for (const id of round.targets ?? [])
        assert.ok(state.tasks[Object.hasOwn(state.taskIdAliases, id) ? state.taskIdAliases[id] : id], `Alvo histórico ausente: ${id}`)
  plan.tasks = plan.tasks.map(task => ({ ...task, id: remap(task.id), deps: (task.deps ?? []).map(remap) }))

  const referenceKeys = new Set(['task', 'taskId', 'tasks', 'targets', 'members', 'deps', 'blockedBy', 'planningBlockedBy', 'added', 'updated', 'preserved', 'metadataUpdated', 'revokedAuthorizationTasks'])
  const eventReferences = (value, key = '') => {
    if (typeof value === 'string') return referenceKeys.has(key) ? remap(value) : value
    if (Array.isArray(value)) return value.map(item => eventReferences(item, key))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, eventReferences(item, name)]))
  }
  const events = originalEvents.map(event => ({ ...eventReferences(event),
    ...(event.task && remap(event.task) !== event.task ? { originalTask: event.originalTask ?? event.task } : {}) }))

  assert.equal(Object.keys(state.tasks).length, Object.keys(originalState.tasks).length)
  for (const [id, task] of Object.entries(originalState.tasks)) {
    const next = state.tasks[remap(id)]
    assert.deepEqual(next, { ...task, id: remap(id), deps: (task.deps ?? []).map(remap) })
    for (const dep of next.deps) assert.ok(state.tasks[dep], `Dependência ausente: ${dep}`)
  }
  return { state, plan, events }
}
