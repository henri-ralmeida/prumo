import assert from 'node:assert/strict'
import { join } from 'node:path'
import { lstatSync } from 'node:fs'
import { discoveryDigest, taskPlanDigest, phasePlanningContext, planningContext, executionInputReceipt, hasCurrentTaskPlan, hasCurrentTaskScope } from './validation.mjs'

const references = new Set(['id', 'task', 'taskId', 'taskIds', 'tasks', 'targets', 'originalTargets', 'activeTargets', 'queuedTargets', 'contextTargets', 'members', 'deps', 'blockedBy', 'planningBlockedBy', 'beforeTask', 'byTask', 'sourceTask', 'freedBy', 'next', 'added', 'updated', 'preserved', 'metadataUpdated', 'revokedAuthorizationTasks', 'deferredToExecutor'])
const dictionaries = new Set(['tasks', 'workers', 'requiredInputs', 'assignments'])
const questionKeys = new Set(['questionRef', 'questionRefs', 'resolvesQuestion', 'ref'])
const bindingKey = key => /digest|context|scope/i.test(key)

export function eventLogPath(directory, state) {
  if (!state.eventLog) return join(directory, 'events.ndjson')
  assert.match(state.eventLog, /^task-id-backups\/[a-f0-9-]{36}\/events\.ndjson$/)
  let path = directory
  for (const part of state.eventLog.split('/')) {
    path = join(path, part)
    assert.ok(!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink(), 'O histórico não aceita caminhos ligados')
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
  assert.equal(typeof value, 'string', 'Informe --map T1=T2,T2=T1')
  const mapping = {}
  for (const item of value.split(',')) {
    const match = /^(T[1-9]\d*[a-z]?)=(T[1-9]\d*[a-z]?)$/.exec(item.trim())
    assert.ok(match, 'O mapa deve conter pares T1=T2 separados por vírgulas')
    assert.ok(!Object.hasOwn(mapping, match[1]), `Origem repetida: ${match[1]}`)
    mapping[match[1]] = match[2]
  }
  assert.ok(Object.entries(mapping).some(([from, to]) => from !== to), 'O mapa não altera identificadores')
  return mapping
}

// Somente referências tipadas mudam; texto livre e artefatos de origem permanecem históricos.
export function renumberTasks(original, originalPlan, mapping, { contextDigests = () => [] } = {}) {
  const remap = id => Object.hasOwn(mapping, id) ? mapping[id] : id
  const ids = Object.keys(original.tasks)
  for (const [from, to] of Object.entries(mapping)) {
    assert.ok(ids.includes(from), `Tarefa ausente: ${from}`)
    assert.match(to, /^T[1-9]\d*[a-z]?$/)
    assert.ok(!Object.hasOwn(original.removedTasks ?? {}, to), `Identificador removido não pode ser reutilizado: ${to}`)
  }
  assert.equal(new Set(ids.map(remap)).size, ids.length, 'A renumeração não pode unir tarefas')
  assert.deepEqual(new Set(originalPlan.tasks.map(task => task.id)), new Set(ids), 'O plano de origem deve conter as mesmas tarefas')
  for (const owner of [...Object.values(original.tasks), ...Object.values(original.phaseWorkflows ?? {})]) {
    assert.ok(!['running', 'reviewing', 'planning', 'discussing'].includes(owner.state), 'Encerre o trabalho ativo antes de renumerar')
    assert.ok(![...(owner.discussionAttempts ?? []), ...(owner.planningAttempts ?? [])].some(round => !round.endedAt), 'Existe uma rodada aberta')
    assert.ok(!(owner.attempts ?? []).some(attempt => !attempt.endedAt), 'Existe uma tentativa aberta')
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
  const bind = (before, compute) => { if (typeof before === 'string') bindings.push([before, compute]) }
  for (const [before, after] of pairs) {
    if (before.digest && before.steps && before.digest === taskPlanDigest(before)) bind(before.digest, () => taskPlanDigest(after))
    if (before.digest && before.coverage && before.digest === discoveryDigest(before)) bind(before.digest, () => discoveryDigest(after))
    // Arquivos de descoberta são recompactados pelo gravador após a migração.
    if (before.discoveryArtifact) {
      assert.ok(before.discovery || before.discoveries, 'A descoberta arquivada está indisponível; restaure a evidência antes de renumerar')
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
    for (const phasePlanning of [false, true]) {
      const oldValues = contextDigests(original, [before], { phasePlanning })
      for (const item of oldValues) for (const key of ['contextDigest', 'inputDigest', 'outputDigest'])
        bind(item[key], () => contextDigests(state, [after], { phasePlanning }).find(value => value.task === remap(item.task))[key])
    }
  }
  let digests = new Map()
  // Recalcule os vínculos transitivos até estabilizar, sem tornar atual uma prova antes inválida.
  for (let pass = 0; ; pass++) {
    const next = new Map()
    for (const [before, compute] of bindings) {
      const value = compute()
      assert.ok(!next.has(before) || next.get(before) === value, 'Vínculo ambíguo; renumeração recusada')
      next.set(before, value)
    }
    if (JSON.stringify([...next]) === JSON.stringify([...digests])) break
    assert.ok(pass < ids.length * 4 + 20, 'Os vínculos da renumeração não estabilizaram')
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
    assert.equal(hasCurrentTaskPlan(state, after), hasCurrentTaskPlan(original, before), `A prontidão do plano de ${id} mudou`)
    assert.equal(hasCurrentTaskScope(state, after), hasCurrentTaskScope(original, before), `O aceite do contrato de ${id} mudou`)
    if (remap(id) !== id) after.previousTaskId = id
  }
  return { state, plan }
}
