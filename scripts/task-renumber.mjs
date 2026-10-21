import { join } from 'node:path'
import { lstatSync } from 'node:fs'
import { discoveryDigest, taskPlanDigest, phasePlanningContext, planningContext, executionInputReceipt, hasCurrentTaskPlan, hasCurrentTaskScope } from './validation.mjs'

const references = new Set(['id', 'task', 'taskId', 'taskIds', 'tasks', 'targets', 'originalTargets', 'activeTargets', 'queuedTargets', 'contextTargets', 'members', 'deps', 'blockedBy', 'planningBlockedBy', 'beforeTask', 'byTask', 'sourceTask', 'freedBy', 'next', 'added', 'updated', 'preserved', 'metadataUpdated', 'revokedAuthorizationTasks', 'deferredToExecutor'])
const dictionaries = new Set(['tasks', 'workers', 'requiredInputs', 'assignments'])
const questionKeys = new Set(['questionRef', 'questionRefs', 'resolvesQuestion', 'ref'])
const bindingKey = key => /digest|context|scope/i.test(key)

export class RenumberError extends Error {
  constructor(message, ...params) {
    super(message)
    this.name = 'RenumberError'
    this.code = 'PRUMO_RENUMBER'
    this.params = params
  }
}

function requireRenumber(condition, message, ...params) {
  if (!condition) throw new RenumberError(message, ...params)
}

// Tentativas antigas continuam históricas; só a tentativa atual de trabalho não terminal pode estar aberta.
export function renumberBlockers(state) {
  const blockers = []
  for (const [ownerType, owners] of [['task', state.tasks], ['phase', state.phaseWorkflows]]) {
    for (const [id, owner] of Object.entries(owners ?? {})) {
      const detail = { owner: owner.id ?? id, ownerType, state: owner.state }
      if (['running', 'reviewing', 'planning', 'discussing'].includes(owner.state))
        blockers.push({ ...detail, kind: 'active-state' })
      for (const kind of ['discussion', 'planning']) {
        for (const [index, round] of (owner[`${kind}Attempts`] ?? []).entries()) {
          if (!round.endedAt) blockers.push({ ...detail, kind, round: round.n ?? index + 1 })
        }
      }
      const attempts = owner.attempts ?? [], attempt = attempts.at(-1)
      if (!['done', 'skipped'].includes(owner.state) && attempt && !attempt.endedAt)
        blockers.push({ ...detail, kind: 'attempt', attempt: attempt.n ?? attempts.length })
    }
  }
  return blockers
}

export function eventLogPath(directory, state) {
  if (!state.eventLog) return join(directory, 'events.ndjson')
  requireRenumber(/^task-id-backups\/[a-f0-9-]{36}\/events\.ndjson$/.test(state.eventLog), 'The event history path is invalid')
  let path = directory
  for (const part of state.eventLog.split('/')) {
    path = join(path, part)
    requireRenumber(!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink(), 'The event history does not accept linked paths')
  }
  return join(directory, state.eventLog)
}

function referenceText(value, key, mapping) {
  const remap = id => Object.hasOwn(mapping, id) ? mapping[id] : id
  if (references.has(key)) return remap(value)
  if (questionKeys.has(key)) {
    const separator = value.indexOf(':')
    return separator < 0 ? value : remap(value.slice(0, separator)) + value.slice(separator)
  }
  if (key === 'scope' && value.startsWith('tasks:')) return 'tasks:' + value.slice(6).split(',').map(remap).join(',')
  return value
}

export function renumberEventHistory(events, mapping) {
  const visit = (value, key = '') => {
    if (typeof value === 'string') return referenceText(value, key, mapping)
    if (Array.isArray(value)) return value.map(item => visit(item, key))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name,
      visit(item, ['before', 'after'].includes(name) && typeof value.field === 'string' ? value.field : name)]))
  }
  return events.map(event => ({ ...visit(event), ...(event.task && Object.hasOwn(mapping, event.task)
    ? { originalTask: event.originalTask ?? event.task } : {}) }))
}

export function parseTaskMapping(value) {
  requireRenumber(typeof value === 'string', 'Provide --map T1=T2,T2=T1')
  const mapping = {}
  for (const item of value.split(',')) {
    const match = /^(T[1-9]\d*[a-z]?)=(T[1-9]\d*[a-z]?)$/.exec(item.trim())
    requireRenumber(match, 'The mapping must contain comma-separated T1=T2 pairs')
    requireRenumber(!Object.hasOwn(mapping, match[1]), 'Repeated source identifier: {0}', match[1])
    mapping[match[1]] = match[2]
  }
  requireRenumber(Object.entries(mapping).some(([from, to]) => from !== to), 'The mapping does not change identifiers')
  return mapping
}

// Somente referências tipadas mudam; texto livre e artefatos de origem permanecem históricos.
export function renumberTasks(original, originalPlan, mapping, { contextDigests = () => [] } = {}) {
  const remap = id => Object.hasOwn(mapping, id) ? mapping[id] : id
  const ids = Object.keys(original.tasks)
  for (const [from, to] of Object.entries(mapping)) {
    requireRenumber(ids.includes(from), 'Missing task: {0}', from)
    requireRenumber(/^T[1-9]\d*[a-z]?$/.test(to), 'Invalid target identifier: {0}', to)
    requireRenumber(!Object.hasOwn(original.removedTasks ?? {}, to), 'A removed identifier cannot be reused: {0}', to)
  }
  requireRenumber(new Set(ids.map(remap)).size === ids.length, 'Renumbering cannot merge tasks')
  const planIds = new Set(originalPlan.tasks.map(task => task.id))
  requireRenumber(planIds.size === ids.length && ids.every(id => planIds.has(id)), 'The source plan must contain the same tasks')
  const blockers = renumberBlockers(original)
  if (blockers.length) {
    const error = new RenumberError('Renumbering is blocked by open work')
    error.blockers = blockers
    throw error
  }
  const pairs = []
  const text = (value, key) => referenceText(value, key, mapping)
  const copy = (value, key = '') => {
    if (typeof value === 'string') return text(value, key)
    if (!value || typeof value !== 'object') return value
    const result = Array.isArray(value) ? [] : {}
    pairs.push([value, result])
    for (const name of Object.getOwnPropertyNames(value)) {
      if (Array.isArray(value) && name === 'length') continue
      const target = dictionaries.has(key) ? remap(name) : name
      result[target] = copy(value[name], Array.isArray(value) ? key : name)
    }
    return result
  }
  const state = copy(original), plan = copy(originalPlan)
  // Aliases que voltaram a ser IDs reais não podem selecionar outra entrega por acidente.
  state.taskIdAliases = Object.fromEntries(Object.entries(original.taskIdAliases ?? {})
    .filter(([from]) => !Object.hasOwn(state.tasks, from)).map(([from, to]) => [from, remap(to)]))
  for (const [from, to] of Object.entries(mapping)) if (!Object.hasOwn(state.tasks, from)) state.taskIdAliases[from] = to
  const bindings = []
  let contextCache = new Map()
  // Todos os vínculos do passe leem o mesmo estado; não recalcule o histórico transitivo para cada campo.
  const currentContexts = phasePlanning => {
    if (!contextCache.has(phasePlanning)) contextCache.set(phasePlanning,
      new Map(contextDigests(state, Object.values(state.tasks), { phasePlanning }).map(item => [item.task, item])))
    return contextCache.get(phasePlanning)
  }
  const bind = (before, compute) => { if (typeof before === 'string') bindings.push([before, compute]) }
  for (const [before, after] of pairs) {
    if (before.digest && before.steps && before.digest === taskPlanDigest(before)) bind(before.digest, () => taskPlanDigest(after))
    if (before.digest && before.coverage && before.digest === discoveryDigest(before)) bind(before.digest, () => discoveryDigest(after))
    // Arquivos de descoberta são recompactados pelo gravador após a migração.
    if (before.discoveryArtifact) {
      requireRenumber(before.discovery || before.discoveries, 'The archived discovery is unavailable; restore the evidence before renumbering')
      delete after.discoveryArtifact
    }
  }
  for (const id of ids) {
    const before = original.tasks[id], after = state.tasks[remap(id)]
    bind(phasePlanningContext(original, before), () => phasePlanningContext(state, after))
    for (let attempt = 1; attempt <= before.attempts.length + 1; attempt++) for (const scopeOnly of [false, true])
      bind(planningContext(original, before, { attempt, scopeOnly }), () => planningContext(state, after, { attempt, scopeOnly }))
    try {
      const oldReceipt = executionInputReceipt(original, before)
      bind(oldReceipt.digest, () => executionInputReceipt(state, after).digest)
      for (const input of oldReceipt.inputs) if (input.validation)
        bind(input.validation, () => executionInputReceipt(state, after).inputs.find(value => value.task === remap(input.task)).validation)
    } catch { /* Uma entrada ainda indisponível não pode ganhar um recibo durante a migração. */ }
  }
  for (const phasePlanning of [false, true]) {
    const oldValues = contextDigests(original, Object.values(original.tasks), { phasePlanning })
    for (const item of oldValues) for (const key of ['contextDigest', 'inputDigest', 'outputDigest'])
      bind(item[key], () => currentContexts(phasePlanning).get(remap(item.task))[key])
  }
  let digests = new Map()
  // Recalcule os vínculos transitivos até estabilizar, sem tornar atual uma prova antes inválida.
  for (let pass = 0; ; pass++) {
    contextCache = new Map()
    const next = new Map()
    for (const [before, compute] of bindings) {
      const value = compute()
      requireRenumber(!next.has(before) || next.get(before) === value, 'Ambiguous binding; renumbering refused')
      next.set(before, value)
    }
    if (JSON.stringify([...next]) === JSON.stringify([...digests])) break
    requireRenumber(pass < ids.length * 4 + 20, 'Renumbering bindings did not stabilize')
    digests = next
    for (const [before, after] of pairs) for (const [key, value] of Object.entries(before)) {
      if (typeof value !== 'string' || !bindingKey(key) || key === 'discoveryArtifact') continue
      if (/context$/i.test(key) && value.startsWith('[')) {
        // Contextos de fase são tuplas JSON, não texto livre nem comandos.
        const context = JSON.parse(value)
        after[key] = JSON.stringify([context[0], context[1], context[2], context[3],
          context[4].map(([id, digest]) => [remap(id), digests.get(digest) ?? digest]).sort()])
      } else after[key] = digests.get(value) ?? text(value, key)
    }
  }
  for (const id of ids) {
    const before = original.tasks[id], after = state.tasks[remap(id)]
    requireRenumber(hasCurrentTaskPlan(state, after) === hasCurrentTaskPlan(original, before), 'The readiness of the task plan changed: {0}', id)
    requireRenumber(hasCurrentTaskScope(state, after) === hasCurrentTaskScope(original, before), 'The accepted task scope changed: {0}', id)
    if (remap(id) !== id) after.previousTaskId = id
  }
  return { state, plan }
}
