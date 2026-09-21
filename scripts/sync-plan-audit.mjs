/* Pure helpers for the sync-plan audit.  The engine owns state changes; this module only
 * describes contract differences and diagnostics for the event log and CLI output. */

export const CONTRACT_FIELDS = [
  'phase', 'title', 'deps', 'validation', 'validationMode', 'inspectionReason',
  'requireReview', 'maxAttempts', 'tags', 'touches',
]

const WAITING_CONTEXT = /\b(?:aguarda(?:ndo|r)?|espera(?:ndo|r)?|reabre\s+quando|wait(?:ing|s)?)\b/iu
const TASK_ID = /(?<![A-Za-z0-9._-])T\d+(?![A-Za-z0-9._-])/giu
const MAX_SUMMARY_TEXT = 160
const MAX_SUMMARY_ITEMS = 32
const MAX_SUMMARY_SIZE = 512
const MAX_DISPLAY_ID = 128

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function jsonLength(value) {
  try { return JSON.stringify(value)?.length ?? 0 } catch { return Number.MAX_SAFE_INTEGER }
}

function boundedString(value) {
  return value.length <= MAX_SUMMARY_TEXT ? value : { type: 'string', length: value.length }
}

function boundedValue(value) {
  if (typeof value === 'string') return boundedString(value)
  if (value === null || typeof value !== 'object') return value === undefined ? null : value
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_SUMMARY_ITEMS).map(boundedValue)
    if (value.length <= MAX_SUMMARY_ITEMS && jsonLength(items) <= MAX_SUMMARY_SIZE)
      return items
    return { type: 'array', count: value.length, items, truncated: value.length > MAX_SUMMARY_ITEMS || jsonLength(items) > MAX_SUMMARY_SIZE }
  }
  const entries = Object.entries(value)
  const mapped = Object.fromEntries(entries.slice(0, MAX_SUMMARY_ITEMS).map(([key, item]) => [boundedString(key), boundedValue(item)]))
  if (entries.length <= MAX_SUMMARY_ITEMS && jsonLength(mapped) <= MAX_SUMMARY_SIZE) return mapped
  return { type: 'object', count: entries.length, keys: entries.slice(0, MAX_SUMMARY_ITEMS).map(([key]) => boundedString(key)), truncated: true }
}

function validationSummary(value) {
  if (Array.isArray(value)) {
    const kinds = {}
    for (const step of value) {
      const kind = typeof step?.kind === 'string' ? boundedString(step.kind) : 'unknown'
      kinds[kind] = (kinds[kind] ?? 0) + 1
    }
    return { type: 'steps', count: value.length, kinds: boundedValue(kinds) }
  }
  if (typeof value === 'string') return { type: 'prose', length: value.length }
  if (value == null) return { type: 'empty', count: 0 }
  return { type: typeof value }
}

export function summarizeContractValue(field, value) {
  if (field === 'validation') return validationSummary(value)
  return boundedValue(value)
}

export function contractChanges(previous, next, fields = CONTRACT_FIELDS) {
  return fields.filter(field => !equal(previous?.[field], next?.[field])).map(field => ({
    field,
    before: summarizeContractValue(field, previous?.[field]),
    after: summarizeContractValue(field, next?.[field]),
  }))
}

function canonicalIds(knownIds) {
  const byKey = new Map()
  for (const id of knownIds) {
    if (typeof id !== 'string') continue
    const key = id.toLocaleLowerCase('en-US')
    if (!byKey.has(key)) byKey.set(key, id)
  }
  return byKey
}

function taskIdsInSegment(segment, knownIds) {
  const found = new Set()
  const known = canonicalIds(knownIds)
  const entries = [...known.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [key, id] of entries) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?<![A-Za-z0-9._-])${escaped}(?![A-Za-z0-9._-])`, 'iu').test(segment)) found.add(key)
  }
  for (const match of segment.matchAll(TASK_ID)) {
    const key = match[0].toLocaleLowerCase('en-US')
    found.add(key)
  }
  return [...found].map(key => known.get(key) ?? key.replace(/^./u, char => char.toUpperCase()))
}

/** Extract only task IDs in a sentence/segment that explicitly expresses waiting. */
export function citedWaitingTasks(blockReason, knownIds = []) {
  if (typeof blockReason !== 'string' || !blockReason.trim()) return []
  const ids = new Set(knownIds)
  const result = new Set()
  // Keep punctuation as the boundary: a reason may contain several clauses, but a
  // free-standing task mention must not become a dependency merely because it is nearby.
  for (const segment of blockReason.split(/[.!?;\n]+/u)) {
    if (!WAITING_CONTEXT.test(segment)) continue
    for (const id of taskIdsInSegment(segment, ids)) result.add(id)
  }
  return [...result]
}

export function displayIdentifier(id) {
  if (typeof id !== 'string') return String(id)
  return id.length <= MAX_DISPLAY_ID ? id : `<task id length ${id.length}>`
}

function boundedIdentifiers(ids) {
  const displayed = [...new Set((ids ?? []).map(displayIdentifier))]
  if (jsonLength(displayed) <= MAX_SUMMARY_SIZE) return displayed
  return { type: 'identifiers', count: ids?.length ?? displayed.length, items: displayed.slice(0, MAX_SUMMARY_ITEMS), truncated: true }
}

export function sanitizeChanges(changes = []) {
  return changes.map(change => ({ ...change, task: displayIdentifier(change.task) }))
}

export function sanitizeDiagnostics(audit = {}) {
  return {
    blockReasonContradictions: (audit.blockReasonContradictions ?? []).map(finding => ({
      ...finding,
      task: displayIdentifier(finding.task),
      cited: boundedIdentifiers(finding.cited),
      missingDeps: boundedIdentifiers(finding.missingDeps),
      plannedMissingDeps: boundedIdentifiers(finding.plannedMissingDeps),
      backEdgesBefore: boundedIdentifiers(finding.backEdgesBefore),
      backEdgesAfter: boundedIdentifiers(finding.backEdgesAfter),
    })),
    newLeaves: (audit.newLeaves ?? []).map(leaf => ({
      ...leaf,
      task: displayIdentifier(leaf.task),
      dependents: boundedIdentifiers(leaf.dependents),
    })),
  }
}

export function sanitizeTaskIds(ids = []) {
  return boundedIdentifiers(ids)
}

function dependencyMap(tasks) {
  return Object.fromEntries(Object.entries(tasks ?? {}).map(([id, task]) => [id, {
    ...task,
    id: task?.id ?? id,
    deps: Array.isArray(task?.deps) ? task.deps : [],
  }]))
}

function reaches(byId, from, to, seen = new Set()) {
  if (from === to) return false
  if (seen.has(from)) return false
  seen.add(from)
  return (byId[from]?.deps ?? []).some(dep => dep === to || reaches(byId, dep, to, seen))
}

function planTaskMap(tasks) {
  return Object.fromEntries((tasks ?? []).map(task => [task.id, {
    ...task,
    deps: Array.isArray(task.deps) ? task.deps : [],
  }]))
}

/**
 * Audit the persisted graph before sync and the graph requested by the approved plan.
 * Missing dependencies are intentionally reported against the persisted graph: that is
 * the stale contract the sync is repairing. Back-edges are checked in both graphs so a
 * single sync cannot silently introduce the semantic cycle it is meant to reveal.
 */
export function auditSyncPlan({ stateTasks = {}, planTasks = [], added = [] } = {}) {
  const before = dependencyMap(stateTasks)
  const after = planTaskMap(planTasks)
  const ids = new Set([...Object.keys(before), ...Object.keys(after)])
  const blockReasonContradictions = []

  for (const [taskId, task] of Object.entries(before)) {
    if (typeof task.blockReason !== 'string' || !task.blockReason.trim()) continue
    const cited = citedWaitingTasks(task.blockReason, [...ids]).filter(id => id !== taskId)
    if (!cited.length) continue
    const missingDeps = cited.filter(id => !task.deps.includes(id))
    const plannedDeps = after[taskId]?.deps ?? []
    const plannedMissingDeps = cited.filter(id => !plannedDeps.includes(id))
    const backEdgesBefore = cited.filter(id => reaches(before, id, taskId))
    const backEdgesAfter = cited.filter(id => reaches(after, id, taskId))
    if (!missingDeps.length && !plannedMissingDeps.length && !backEdgesBefore.length && !backEdgesAfter.length) continue
    blockReasonContradictions.push({
      task: taskId,
      cited,
      missingDeps,
      plannedMissingDeps,
      backEdgesBefore,
      backEdgesAfter,
      severity: backEdgesBefore.length || backEdgesAfter.length ? 'strong' : 'warning',
    })
  }

  const seenLeaves = new Set()
  const newLeaves = []
  for (const value of added) {
    const task = taskIdFromAdded(value)
    const key = typeof task === 'string' ? task.toLocaleLowerCase('en-US') : String(task)
    if (seenLeaves.has(key) || Object.values(after).some(candidate => candidate.deps.includes(task))) continue
    seenLeaves.add(key)
    newLeaves.push({
      task,
      dependents: [],
      severity: blockReasonContradictions.some(item => item.cited.includes(task)) ? 'warning' : 'info',
    })
  }

  return { blockReasonContradictions, newLeaves }
}

// `added` is normally a list of IDs. Keep the helper tolerant of callers passing plan
// task objects, which makes it useful in focused tests without coupling it to the engine.
function taskIdFromAdded(value) {
  return typeof value === 'string' ? value : value?.id
}

export function formatValidationSummary(summary) {
  if (!summary || typeof summary !== 'object') return String(summary)
  if (summary.type === 'steps') {
    const kinds = Object.entries(summary.kinds ?? {}).map(([kind, count]) => `${kind}:${count}`).join(',')
    return `${summary.count} checks${kinds ? ` (${kinds})` : ''}`
  }
  if (summary.type === 'prose') return `prose (${summary.length} chars)`
  if (summary.type === 'empty') return 'empty'
  return summary.type ?? 'unknown'
}

export function formatContractChange(change) {
  const render = (value) => JSON.stringify(value)
  if (change.field === 'validation')
    return `${change.field} ${formatValidationSummary(change.before)} -> ${formatValidationSummary(change.after)}`
  return `${change.field} ${render(change.before)} -> ${render(change.after)}`
}
