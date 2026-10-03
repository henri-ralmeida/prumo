import assert from 'node:assert/strict'
import { phasePlanningContext, taskPlanDigest } from './validation.mjs'

// A padronização explícita preserva as provas fechadas e recusa contratos ainda em execução.
export function normalizeLegacyPlanIdentifiers(originalState, originalPlan, originalEvents, taskMapping = {}, phaseMapping = {}) {
  const taskId = id => Object.hasOwn(taskMapping, id) ? taskMapping[id] : id
  const phaseId = id => Object.hasOwn(phaseMapping, id) ? phaseMapping[id] : id
  const taskIds = Object.keys(originalState.tasks)
  const phaseIds = (originalState.plan.phases ?? []).map(phase => phase.id)
  for (const [mapping, ids, pattern] of [[taskMapping, taskIds, /^T[1-9]\d*[a-z]?$/], [phaseMapping, phaseIds, /^F[1-9]\d*$/]]) {
    for (const [from, to] of Object.entries(mapping)) {
      assert.ok(ids.includes(from), `Identificador ausente: ${from}`)
      assert.match(to, pattern)
    }
    const renamed = ids.map(id => Object.hasOwn(mapping, id) ? mapping[id] : id)
    assert.equal(new Set(renamed).size, ids.length, 'A migração não pode unir identificadores')
  }
  for (const task of Object.values(originalState.tasks)) {
    assert.ok(![...(task.discussionAttempts ?? []), ...(task.planningAttempts ?? [])].some(round => !round.endedAt), 'Existe uma rodada de tarefa aberta')
    const affected = taskId(task.id) !== task.id || phaseId(task.phase) !== task.phase || (task.deps ?? []).some(id => taskId(id) !== id)
    if (affected && !['done', 'skipped'].includes(task.state))
      assert.ok(['pending', 'blocked'].includes(task.state) && !task.taskPlan && !task.executionAuthorization &&
        (task.state === 'blocked' || !(task.attempts ?? []).length),
        `A tarefa ${task.id} já tem trabalho ou contrato ativo`)
  }
  for (const phase of Object.values(originalState.phaseWorkflows ?? {}))
    assert.ok(![...(phase.discussionAttempts ?? []), ...(phase.planningAttempts ?? [])].some(round => !round.endedAt), 'Existe uma rodada de fase aberta')

  const taskKeys = new Set(['task', 'taskId', 'tasks', 'targets', 'members', 'deps', 'blockedBy', 'planningBlockedBy', 'added', 'updated', 'preserved', 'metadataUpdated', 'revokedAuthorizationTasks', 'beforeTask'])
  const phaseKeys = new Set(['phase', 'phaseId', 'beforePhase'])
  const proofs = new Set(['taskPlan', 'planningHistory', 'contextSnapshot', 'requiredInputs', 'taskDigests', 'discovery', 'inputReceipt'])
  const references = (value, key = '') => {
    if (typeof value === 'string') return taskKeys.has(key) ? taskId(value) : phaseKeys.has(key) ? phaseId(value) : value
    if (Array.isArray(value)) return value.map(item => references(item, key))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, proofs.has(name) ? structuredClone(item) : references(item, name)]))
  }
  const state = references(originalState)
  state.tasks = Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [taskId(id), { ...task, id: taskId(id) }]))
  state.plan.phases = (state.plan.phases ?? []).map(phase => ({ ...phase, id: phaseId(phase.id) }))
  if (state.phaseWorkflows) state.phaseWorkflows = Object.fromEntries(Object.entries(state.phaseWorkflows).map(([id, phase]) =>
    [phaseId(id), { ...phase, id: phaseId(id) }]))
  for (const [id, original] of Object.entries(originalState.tasks)) {
    const task = state.tasks[taskId(id)]
    if (task.taskPlan?.phaseId) {
      // Só os metadados de localização mudam; binding, pesquisa, verificações e digest continuam intactos.
      task.taskPlan.phaseId = phaseId(task.taskPlan.phaseId)
      if (original.taskPlan.scope === phasePlanningContext(originalState, original))
        task.taskPlan.scope = phasePlanningContext(state, task)
      assert.equal(taskPlanDigest(task.taskPlan), taskPlanDigest(original.taskPlan), 'O conteúdo assinado não pode mudar')
    }
  }
  // Um número reutilizado passa a identificar a tarefa atual; o backup conserva o mapa histórico completo.
  const aliases = Object.fromEntries(Object.entries(originalState.taskIdAliases ?? {})
    .filter(([from]) => !Object.hasOwn(state.tasks, from)).map(([from, to]) => [from, taskId(to)]))
  for (const [from, to] of Object.entries(taskMapping)) if (!Object.hasOwn(state.tasks, from)) aliases[from] = to
  if (Object.keys(aliases).length) state.taskIdAliases = aliases
  const plan = references(originalPlan)
  plan.tasks = plan.tasks.map(task => ({ ...task, id: taskId(task.id) }))
  plan.phases = (plan.phases ?? []).map(phase => ({ ...phase, id: phaseId(phase.id) }))
  const events = originalEvents.map(event => ({ ...references(event),
    ...(event.task && taskId(event.task) !== event.task ? { originalTask: event.originalTask ?? event.task } : {}),
    ...(event.phase && phaseId(event.phase) !== event.phase ? { originalPhase: event.originalPhase ?? event.phase } : {}) }))
  for (const task of Object.values(state.tasks)) {
    for (const dep of task.deps ?? []) assert.ok(state.tasks[dep], `Dependência ausente: ${dep}`)
    if (task.phase) assert.ok(state.plan.phases.some(phase => phase.id === task.phase), `Fase ausente: ${task.phase}`)
  }
  for (const [from, to] of Object.entries(aliases)) {
    assert.ok(!state.tasks[from], `Alias conflita com uma tarefa existente: ${from}`)
    assert.ok(state.tasks[to], `Alias aponta para uma tarefa ausente: ${to}`)
  }
  return { state, plan, events }
}

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
