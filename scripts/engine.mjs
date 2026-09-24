#!/usr/bin/env node
/**
 * Prumo — generic task-graph execution state for agent-driven plans.
 *
 * The ENGINE is reusable and knows nothing about any particular project. What changes
 * between projects is the PLAN (a JSON file: phases + tasks + deps + how to validate).
 * The orchestrator (a human or an agent) drives it through this CLI; the dashboard
 * (serve.mjs) only READS the same state — it is observability, never a second brain.
 *
 * State lives under ~/.local/share/prumo/<workspace>/.specs/graph/<run>/:
 *   state.json     — the single source of truth (plan snapshot + per-task state)
 *   events.ndjson  — append-only history of every transition (feeds the dashboard log)
 *
 * Task lifecycle (enforced):
 *   pending ─begin-discussion→ discussing ─finish-discussion→ pending (ready to plan)
 *   pending ─plan-task→ planning ─finish-planning→ pending (ready) ─start→ running
 *   running ─review→ reviewing ─validate(ok)→ ─done→ done
 *      │                │                  │└─validate(failed)→ stays reviewing
 *      │                │└─fail→ failed ─retry→ pending
 *      │                └─(done straight from running is refused when review is required)
 *      ├─block→ blocked ─unblock→ pending
 *      └─skip→ skipped (with reason)
 *
 * AUTHOR ≠ VERIFIER: the executor writes, a REVIEWER agent bangs the gavel. `done` demands a
 * passing validation recorded during review, by an agent other than the one that did the work.
 *
 * Readiness is DERIVED: satisfied deps → ready_to_plan; current task plan → ready.
 * Tasks without planningRequired (or explicitly marked false during migration)
 * retain their original lifecycle.
 *
 * Usage (ENGINE = path to this file, wherever the skill is installed):
 *   node $ENGINE init --plan <plan.json> --run <name>
 *   node $ENGINE sync-plan --plan <plan.json> [--run <name>]
 *   node $ENGINE migrate [--check] [--run <name>]
 *   node $ENGINE status|ready|graph [--run <name>]
 *   node $ENGINE show-contract <task> [--diff] [--run <name>]
 *   node $ENGINE begin-phase-discussion <phase> [--adopt-legacy]
 *   node $ENGINE skip-phase-discussion <phase> --reason <text> --confirmed-by-user
 *   node $ENGINE finish-phase-discussion <phase> --context <discovery.json> [--accept-premature-work]
 *   node $ENGINE plan-phase <phase> --agent <name>
 *   node $ENGINE skip-phase-planning <phase> --reason <text> --confirmed-by-user
 *   node $ENGINE finish-phase-planning <phase> --plan-dir <directory>
 *   node $ENGINE begin-discussion <task> [--adopt-legacy]
 *   node $ENGINE skip-discussion <task> --reason <text> --confirmed-by-user
 *   node $ENGINE finish-discussion <task> --context <discovery.json> [--accept-premature-work]
 *   node $ENGINE plan-task <task> --agent <name> [--context <legacy-discovery.json>]
 *   node $ENGINE skip-planning <task> --reason <text> --confirmed-by-user
 *   node $ENGINE finish-planning <task> --plan <task-plan.json>
 *   node $ENGINE start <task> --agent <name> [--confirmed-by-user]   (manual mode; max 3 executors)
 *   node $ENGINE progress <task> --step <1-based index> --agent <executor>
 *   node $ENGINE review <task> --agent <name> [--confirmed-by-user]  (manual mode; hands it to a reviewer)
 *   node $ENGINE review-progress <task> --step <1-based index> --agent <reviewer>
 *   node $ENGINE validate <task> --ok|--failed --evidence "<text>" [--cwd <project>] [--tail <lines>]
 *   node $ENGINE show-check <task> --check <1-based index> --attempt <number>
 *   node $ENGINE refresh-contract <task> --plan <approved-plan.json>
 *   node $ENGINE done <task>
 *   node $ENGINE fail <task> --reason "<text>" [--plan-defect]
 *   node $ENGINE retry <task> [--force] [--confirmed-by-user]   (manual mode)
 *   node $ENGINE authorize --scope run|phase:<phase>|tasks:<task,...> [--mode auto|manual] --confirmed-by-user
 *   node $ENGINE block <task> --reason [--question <text>] [--option <text>...]
 *   node $ENGINE unblock <task> [--answer <text>] [--reviewer <agent>] [--confirmed-by-user]   (manual active resume)
 *   node $ENGINE skip <task> --reason
 *   node $ENGINE note <task> --text "<text>"
 *   node $ENGINE runs
 */
import {
  mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync,
  rmSync, statSync, copyFileSync,
} from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { writeAtomicState } from './atomic-state.mjs'
import { runValidation, assertValidation, validationContract, validationDirectories, assertDiscovery, assertDiscussionBoundary, discoveryDigest, assertTaskPlan,
  assertUnavailableResources,
  planTaskFromState, planningContext, hasCurrentTaskPlan, hasCurrentTaskScope, currentPlanningScope, usesCurrentPlanning,
  phasePlanningContext, phaseRequiredInputs, assertPhaseTaskPlan, executionInputReceipt, currentPlanningSkip,
  taskPlanDigest } from './validation.mjs'

import { basename, dirname, join, resolve } from 'node:path'

import { findRoot } from './storage.mjs'
import { log, errorLog, tr } from './i18n.mjs'
import {
  auditSyncPlan, contractChanges, displayIdentifier, formatContractChange,
  sanitizeChanges, sanitizeDiagnostics, sanitizeTaskIds,
} from './sync-plan-audit.mjs'
import { businessContract, contractDrift, GLOBAL_PLAN_FIELDS, TASK_CONTRACT_FIELDS } from './contract-drift.mjs'

let ROOT
try { ROOT = findRoot() } catch (error) { errorLog('[prumo] ERROR: ' + error.message); process.exit(1) }
const GRAPH_DIR = join(ROOT, '.specs', 'graph')
const CURRENT_FILE = join(GRAPH_DIR, 'CURRENT')
const MAX_ATTEMPTS_SOFT = 3
const DEFAULT_MAX_PARALLEL = 4
const DEFAULT_MAX_EXECUTORS = 3   // the 4th slot is RESERVED for review
const STATE_SCHEMA_VERSION = 1
const LOCK_WAIT_MS = 5000         // how long a command waits for the run's lock
const LOCK_STALE_MS = 30000       // a lock older than this belonged to a process that died

// ---------- tiny arg parser ----------
const [, , cmd, ...rest] = process.argv
const args = { _: [] }
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = rest[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      if (key === 'option') (args[key] ??= []).push(next)
      else args[key] = next
      i++
    } else args[key] = true
  } else args._.push(a)
}

function die(msg) {
  errorLog(`[prumo] ERROR: ${msg}`)
  process.exit(1)
}

function readPlanningArtifact(path) {
  let source
  try { source = readFileSync(path, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(tr('task plan artifact does not exist'))
    throw error
  }
  if (source.charCodeAt(0) === 0xFEFF) source = source.slice(1)
  try { return JSON.parse(source) }
  catch (error) { throw new Error(tr('task plan artifact JSON is invalid: {0}', error.message)) }
}

function planningArtifactError(filename, error) {
  return tr('task plan artifact {0}: {1}', filename, tr(error.message))
}

function runName() {
  if (args.run) return args.run
  if (existsSync(CURRENT_FILE)) return readFileSync(CURRENT_FILE, 'utf8').trim()
  die('no run selected — pass --run <name> or init one')
}

/* The run name reaches join() as a path segment, so it is allowlisted, never trusted:
 * plain slug, no leading dot, no separators — same rule as serve.mjs, keep in sync.
 * Enforced HERE because runDir is the one chokepoint every filesystem use goes through
 * (state, events, lock, init) — a CURRENT edited to "../../x" must die, not traverse. */
function safeRun(name) {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    die(`invalid run name "${name}" — letters, digits, ".", "_" and "-" only (no leading dot, no path separators)`)
  return name
}

function safeId(id, kind = 'task') {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    die(`invalid ${kind} id "${id}" — letters, digits, ".", "_" and "-" only (no leading dot or path separators)`)
  return id
}

function runDir(name) {
  return join(GRAPH_DIR, safeRun(name))
}

function loadState(name) {
  const p = join(runDir(name), 'state.json')
  if (!existsSync(p)) die(`run "${name}" has no state.json`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function saveState(name, state) {
  state.updatedAt = new Date().toISOString()
  const dir = runDir(name)
  writeAtomicState(join(dir, 'state.json'), JSON.stringify(state, null, 2))
}

function migrationStatus(state) {
  if (Number(state.schemaVersion) > STATE_SCHEMA_VERSION)
    die(`run uses newer schema v${state.schemaVersion}; update Prumo before opening it`)
  const nonterminal = Object.values(state.tasks ?? {}).filter(task => !['done', 'skipped'].includes(task.state))
  const missingMode = !['phase', 'task'].includes(state.plan?.planningMode)
  const mode = missingMode ? ((state.plan?.phases?.length ?? 0) ? 'phase' : 'task') : state.plan.planningMode
  const missingWorkflows = mode === 'phase' && (state.plan?.phases ?? []).some(phase => !state.phaseWorkflows?.[phase.id])
  const structural = missingMode || missingWorkflows
  const blockers = []
  if (structural) {
    for (const task of nonterminal) {
      const reasons = []
      const openDiscussion = task.discussionAttempts?.some(round => !round.endedAt)
      const openPlanning = task.planningAttempts?.some(round => !round.endedAt)
      const executionStarted = (task.attempts?.length ?? 0) > 0
      // A task with an open current workflow cannot be moved between the task
      // and phase planners while that workflow is in flight. An already
      // started legacy attempt is safe to keep on its old lifecycle, however;
      // making it a migration blocker is what used to freeze unrelated work.
      const currentPlanning = task.planningRequired === true ||
        (!executionStarted && task.planningRequired !== false)
      if (currentPlanning && !['pending', 'failed', 'blocked'].includes(task.state)) reasons.push(`state ${task.state}`)
      if (currentPlanning && executionStarted) reasons.push(`${task.attempts.length} execution attempt(s)`)
      if (openDiscussion) reasons.push('open discussion')
      if (openPlanning) reasons.push('open planning')
      if (reasons.length) blockers.push(`${task.id}: ${reasons.join(', ')}`)
    }
    for (const phase of Object.values(state.phaseWorkflows ?? {})) {
      if (phase.discussionAttempts?.some(round => !round.endedAt)) blockers.push(`${phase.id}: open phase discussion`)
      if (phase.planningAttempts?.some(round => !round.endedAt)) blockers.push(`${phase.id}: open phase planning`)
    }
  }
  return { needed: state.schemaVersion !== STATE_SCHEMA_VERSION || structural, structural, mode, blockers }
}

function migrateState(name, { check = false, quiet = false } = {}) {
  const state = loadState(name)
  const status = migrationStatus(state)
  if (check) {
    log(status.needed ? `[prumo] run "${name}" needs schema migration to v${STATE_SCHEMA_VERSION}` :
      `[prumo] run "${name}" already uses schema v${STATE_SCHEMA_VERSION}`)
    if (status.blockers.length) log(`[prumo] migration blocked by ${status.blockers.join('; ')}`)
    return status
  }
  if (!status.needed) return status
  if (status.blockers.length) die(`run "${name}" needs migration, blocked by ${status.blockers.join('; ')}`)
  const dir = runDir(name)
  const backup = join(dir, `state.pre-migrate-v${STATE_SCHEMA_VERSION}.json`)
  if (!existsSync(backup)) copyFileSync(join(dir, 'state.json'), backup)
  const adoptingLegacy = !['phase', 'task'].includes(state.plan.planningMode)
  state.schemaVersion = STATE_SCHEMA_VERSION
  state.plan.planningMode = status.mode
  if (status.mode === 'phase') {
    state.phaseWorkflows ??= {}
    for (const phase of state.plan.phases ?? []) {
      state.phaseWorkflows[phase.id] ??= { id: phase.id, title: phase.title, state: 'pending', discussionAttempts: [], planningAttempts: [], planningHistory: [] }
      if (adoptingLegacy) state.phaseWorkflows[phase.id].adoptedLegacy = true
    }
    if (adoptingLegacy) delete state.legacyPhaseAdoption
  }
  for (const task of Object.values(state.tasks)) {
    if (['done', 'skipped'].includes(task.state)) continue
    const started = (task.attempts?.length ?? 0) > 0
    const openWorkflow = task.discussionAttempts?.some(round => !round.endedAt) ||
      task.planningAttempts?.some(round => !round.endedAt)
    const legacy = task.planningRequired === false || started ||
      (task.planningRequired === undefined && ['running', 'reviewing'].includes(task.state))
    if (legacy) {
      // This marker is the per-task compatibility boundary. It lets the
      // global run adopt the current graph structure without forcing an
      // existing attempt through a new discussion/planning round.
      if (adoptingLegacy && task.planningRequired === undefined) task.planningRequired = false
      continue
    }
    // A malformed open workflow is rejected by migrationStatus above. Keep
    // its fields untouched if a future caller reaches this branch anyway.
    if (openWorkflow) continue
    if (task.planningRequired === undefined) {
      task.discussionRequired = true
      task.discoveryRequired = true
      task.planningRequired = true
      task.discussionAttempts ??= []
      task.planningAttempts ??= []
      task.planningHistory ??= []
    } else if (adoptingLegacy) {
      task.discussionRequired = true
      task.discoveryRequired = true
      task.planningRequired = true
      task.discussionAttempts ??= []
      task.planningAttempts ??= []
      task.planningHistory ??= []
    }
  }
  saveState(name, state)
  emit(name, 'schema_migrate', null, { schemaVersion: STATE_SCHEMA_VERSION, planningMode: status.mode })
  if (!quiet) log(`[prumo] run "${name}" migrated to schema v${STATE_SCHEMA_VERSION}; backup: ${backup}`)
  return { ...status, migrated: true, backup }
}

/* Every mutating command is a read-modify-write of state.json from its OWN short-lived
 * process, and the orchestrator is told to dispatch several in the SAME message — so they
 * really do run at once. Unlocked, the last writer wins: a `start` prints "running" and
 * appends its event while its change to state.json is overwritten by a sibling, leaving a
 * task the graph thinks is pending and an agent already working on it. The atomic rename in
 * saveState prevents a torn file; only this prevents a lost one.
 *
 * The lock is a DIRECTORY: mkdir is atomic and fails loudly when it exists, on every
 * platform, with no O_EXCL caveats. One lock per run, so two runs never wait on each other.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

let heldLock = null
/* die() exits the process from INSIDE the locked section (a refused transition is the
   normal path, not an exception), and process.exit skips finally blocks — so the release
   must also live on the exit event or every refusal would strand its lock. */
process.on('exit', () => { if (heldLock) rmSync(heldLock, { recursive: true, force: true }) })

function withLock(name, fn) {
  const dir = runDir(name)
  mkdirSync(dir, { recursive: true })   // init locks before the run directory exists
  const lock = join(dir, '.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      heldLock = lock
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      /* A process killed mid-command leaves its lock behind. Age is the only evidence
         available, so an old one is presumed abandoned and broken — a run that can never
         write again would be a worse failure than the collision this guards against. */
      const age = Date.now() - statSync(lock).mtimeMs
      if (age > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) die(`run "${name}" is locked by another command (waited ${LOCK_WAIT_MS}ms) — retry`)
      sleepSync(25)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
    heldLock = null
  }
}

function emit(name, type, task, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), type, task, ...data })
  appendFileSync(join(runDir(name), 'events.ndjson'), line + '\n')
}

function getTask(state, id) {
  const t = state.tasks[id]
  if (!t) die(`unknown task "${id}"`)
  return t
}

function reviewDenominator(task) {
  let contract
  try { contract = validationContract(task) } catch { return null }
  const criteria = task.taskPlan?.verification
  if (contract.mode === 'inspection' && Array.isArray(criteria) && criteria.length)
    return { total: criteria.length, basis: 'inspection', inspection: true }
  if (contract.steps.length) return { total: contract.steps.length, basis: 'checks', inspection: contract.mode === 'inspection' }
  if (contract.mode !== 'inspection') return null
  return null
}

function reviewProgressRecord(task, agent, denominator) {
  const attempt = task.attempts.at(-1)
  if (!attempt) return null
  if (!denominator) {
    delete attempt.reviewProgress
    return null
  }
  const record = { current: 1, total: denominator.total, traversed: 0, basis: denominator.basis,
    agent, selfReported: false, contractRevision: task.contractRevision ?? 0,
    scopeRevision: task.scopeRevision ?? 0 }
  attempt.reviewProgress = record
  return record
}

function quoteCommandArg(value) {
  const text = String(value)
  return process.platform === 'win32'
    ? `'${text.replaceAll("'", "''")}'`
    : `'${text.replaceAll("'", "'\\''")}'`
}

function positiveIndex(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    die(`${label} must be a positive integer`)
  return Number(value)
}

function tailLineLimit(value) {
  if (value === undefined) return 15
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    die('validate --tail must be a nonnegative integer')
  return Number(value)
}

function checkPassed(check) {
  const expected = Array.isArray(check.expectedExitCodes) ? check.expectedExitCodes : [0]
  return expected.includes(check.exitCode) && !check.error && !check.signal
}

function checkOutput(check) {
  const stdout = typeof check.stdout === 'string' ? check.stdout : ''
  const stderr = typeof check.stderr === 'string' ? check.stderr : ''
  if (!stdout || !stderr) return stdout + stderr
  return stdout + (stdout.endsWith('\n') || stdout.endsWith('\r') ? '' : '\n') + stderr
}

function printValidationTail(checks, limit) {
  if (limit === 0) return
  for (const [index, check] of checks.entries()) {
    if (check.kind !== 'functional' && checkPassed(check)) continue
    const lines = checkOutput(check).split(/\r\n|\n|\r/)
    while (lines.at(-1) === '') lines.pop()
    if (!lines.length) continue
    const tail = lines.slice(-limit)
    log(`[prumo] check ${index + 1}/${checks.length} output tail (${tail.length} lines; exit ${check.exitCode ?? 'unknown'}; reused ${tr(check.reusedAt ? 'yes' : 'no')}; summary labels are textual only)`)
    for (const line of tail) {
      const visible = line.length > 1024 ? `…${line.slice(-1024)}` : line
      const summary = /\b(?:summary|results?|total|passed|failed|skipped|errors?)\b|\b\d+\s+(?:tests?|checks?|cases?|scenarios?)\b/i.test(visible)
      console.log(`  ${summary ? tr('SUMMARY') : '|'} ${visible}`)
    }
  }
}

/** Can `from` reach `to` through deps? Two tasks so related are ORDERED, never concurrent. */
function reaches(byId, from, to, seen = new Set()) {
  if (from === to) return true
  if (seen.has(from)) return false
  seen.add(from)
  return (byId[from]?.deps ?? []).some((d) => reaches(byId, d, to, seen))
}

/** Path prefixes collide when either contains the other. */
function pathsCollide(a, b) {
  return a.startsWith(b) || b.startsWith(a)
}

function touchPathSegments(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) return null
  return normalized.split('/').filter(part => part && part !== '.')
}

function validationRoots(task) {
  const steps = Array.isArray(task.validation) ? task.validation : []
  const roots = steps.length
    ? steps.map(step => typeof step?.cwd === 'string' && step.cwd.trim() ? resolve(step.cwd) : process.cwd())
    : [process.cwd()]
  return [...new Set(roots)]
}

function pathDistance(left, right) {
  const a = process.platform === 'win32' ? left.toLowerCase() : left
  const b = process.platform === 'win32' ? right.toLowerCase() : right
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

function closestTouchPath(root, parts) {
  let parent = root
  const found = []
  for (let index = 0; index < parts.length; index++) {
    let entries
    try { entries = readdirSync(parent, { withFileTypes: true }) } catch { return null }
    const wanted = parts[index]
    const equal = name => process.platform === 'win32' ? name.toLowerCase() === wanted.toLowerCase() : name === wanted
    const exact = entries.find(entry => equal(entry.name))
    if (exact) {
      found.push(exact.name)
      parent = join(parent, exact.name)
      if (index < parts.length - 1 && !exact.isDirectory()) return null
      continue
    }
    const candidates = entries.map(entry => ({ name: entry.name, distance: pathDistance(wanted, entry.name) }))
      .sort((a, b) => a.distance - b.distance)
    const best = candidates[0]
    if (!best || best.distance > Math.max(1, Math.floor(wanted.length / 3)) || candidates[1]?.distance === best.distance)
      return null
    const suggestion = [...found, best.name, ...parts.slice(index + 1)]
    try { statSync(resolve(root, ...suggestion)); return suggestion.join('/') } catch { return null }
  }
  return null
}

function warnPlanTouchPaths(plan) {
  for (const task of plan.tasks) {
    if (!Array.isArray(task.touches) || !task.touches.length) continue
    const roots = validationRoots(task)
    const accessible = roots.filter(root => {
      try { return statSync(root).isDirectory() } catch { return false }
    })
    const inaccessible = roots.filter(root => !accessible.includes(root))
    for (const touch of task.touches) {
      const parts = touchPathSegments(touch)
      if (!parts) {
        log('[prumo] ' + tr('touches check not run for task {0} path "{1}": only repository-relative paths can be checked',
          task.id, touch))
        continue
      }
      if (accessible.some(root => {
        try { statSync(resolve(root, ...parts)); return true } catch { return false }
      })) continue
      if (!accessible.length) {
        log('[prumo] ' + tr('touches check not run for task {0} path "{1}": validation repository/cwd is inaccessible ({2})',
          task.id, touch, roots.join(', ')))
        continue
      }
      const suggestion = accessible.map(root => closestTouchPath(root, parts)).find(Boolean)
      log('[prumo] ' + tr('touches warning: task {0} path "{1}" was not found in validation repository/cwd {2}{3}; a new file or folder is allowed, so confirm this is intentional',
        task.id, touch, accessible.join(', '), suggestion ? tr(' — closest existing path: {0}', suggestion) : ''))
      if (inaccessible.length)
        log('[prumo] ' + tr('touches check not run in inaccessible validation repository/cwd: {0}', inaccessible.join(', ')))
    }
  }
}

function warnTaskPlan(task, plan) {
  if (!plan.writes?.length)
    log('[prumo] ' + tr('task plan warning: {0} declares no writes; confirm the executor stays within approved touches', task.id))
  for (let index = 0; index < (plan.verification ?? []).length; index++) {
    const item = plan.verification[index]
    for (const resource of item.requires ?? []) {
      if (task.unavailable?.includes(resource))
        log('[prumo] ' + tr('planning warning: task {0} verification {1} requires unavailable resource {2}; keep it pending for the reviewer',
          task.id, index + 1, resource))
    }
  }
}

function printContractDriftWarnings(state) {
  const drift = contractDrift(state)
  if (!drift.available) {
    log('[prumo] ' + tr('approved plan source unavailable ({0}); contract drift was not checked', tr(drift.reason)))
    return
  }
  if (drift.planFields.length)
    log('[prumo] ' + tr('contract drift: approved plan fields: {0}', drift.planFields.join(', ')))
  for (const item of drift.tasks)
    log('[prumo] ' + tr('contract drift: task {0} fields: {1}', displayIdentifier(item.task), item.fields.join(', ')))
}

function ageLabel(startedAt) {
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000))
  if (!Number.isFinite(elapsed)) return tr('unknown age')
  if (elapsed < 60) return tr('{0}s', elapsed)
  if (elapsed < 3600) return tr('{0}m', Math.floor(elapsed / 60))
  return tr('{0}h', Math.floor(elapsed / 3600))
}

function printPlanningRoundProgress(state) {
  const line = (id, round, recorded, total) => round.endedAt
    ? tr('planning round {0} ({1}) completed for {2}; artifacts {3}/{4}',
      id, round.n, ageLabel(round.startedAt), recorded, total)
    : tr('planning round {0} ({1}) {2} for {3}; artifacts {4}/{5}',
      id, round.n, tr('open'), ageLabel(round.startedAt), recorded, total)
  for (const phase of Object.values(state.phaseWorkflows ?? {})) {
    const round = phase.planningAttempts?.at(-1)
    if (!round || (round.endedAt && round.result !== 'planned')) continue
    const total = round.targets?.length ?? 0
    const recorded = Number.isSafeInteger(round.artifactCount) ? round.artifactCount :
      (round.targets ?? []).filter(id => {
        const plan = state.tasks[id]?.taskPlan
        return plan?.phaseId === phase.id && plan.phaseBinding?.discussionRoundId === round.discussionRoundId &&
          plan.phaseBinding?.plannerRound === round.n
      }).length
    log('[prumo] ' + line(phase.id, round, recorded, total))
  }
  for (const task of Object.values(state.tasks ?? {})) {
    if (task.phase || state.plan.planningMode === 'phase') continue
    const round = task.planningAttempts?.at(-1)
    if (!round || (round.endedAt && round.result !== 'planned')) continue
    const recorded = Number.isSafeInteger(round.artifactCount) ? round.artifactCount :
      (task.taskPlan?.startedAt === round.startedAt && task.taskPlan?.context === round.context ? 1 : 0)
    log('[prumo] ' + line(task.id, round, recorded, 1))
  }
}

function printPendingContractConfirmations(state) {
  for (const phase of Object.values(state.phaseWorkflows ?? {})) {
    if (!phase.contractConfirmationRequired) continue
    const tasks = (phase.contractConfirmationRequired.tasks ?? []).map(displayIdentifier).join(', ')
    log('[prumo] ' + tr('contract confirmation required for phase {0}: {1}', phase.id, tasks || tr('current phase tasks')))
  }
  for (const task of Object.values(state.tasks)) {
    if (task.contractConfirmationRequired)
      log('[prumo] ' + tr('contract confirmation required for task {0}', displayIdentifier(task.id)))
  }
}

function manualInspectionPending(state, task) {
  const required = task.unavailable?.includes('manual-inspection') ||
    task.taskPlan?.verification?.some(item => item.requires?.includes('manual-inspection'))
  if (!required) return false
  const receipt = task.validations?.at(-1)
  const currentScope = !task.planningRequired || receipt?.planningScope === currentPlanningScope(state, task, receipt?.attempt)
  return !(receipt?.ok && receipt.by === 'review' && receipt.agent === task.reviewer && task.reviewer !== task.agent &&
    receipt.attempt === task.attempts?.length && currentScope)
}

function validatePlan(plan, allowOverlap = false, historical = new Set()) {
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) die('plan has no tasks')
  const ids = new Set()
  const planningMode = plan.planningMode ?? ((plan.phases?.length ?? 0) ? 'phase' : 'task')
  if (!['phase', 'task'].includes(planningMode)) die('planningMode must be phase or task')
  const phaseIds = new Set()
  for (const phase of plan.phases ?? []) {
    safeId(phase.id, 'phase')
    if (phaseIds.has(phase.id)) die(`duplicate phase id ${phase.id}`)
    phaseIds.add(phase.id)
  }
  for (const t of plan.tasks) {
    if (!t.id || !t.title) die('every task needs id and title')
    safeId(t.id)
    if (ids.has(t.id)) die(`duplicate task id ${t.id}`)
    for (const field of ['summary', 'validationSummary'])
      if (t[field] !== undefined && (typeof t[field] !== 'string' || !t[field].trim()))
        die(tr('task {0} {1} must be a nonempty string when present', t.id, field))
    if (t.label !== undefined) {
      const words = typeof t.label === 'string' && t.label.trim() ? t.label.trim().split(/\s+/u) : []
      if (!words.length || words.length > 3 || Array.from(t.label).length > 24)
        die(tr('task {0} label must have 1 to 3 words and no more than 24 characters', t.id))
    }
    if (planningMode === 'phase' && !phaseIds.has(t.phase)) die(`task ${t.id} needs a declared phase for phase planning`)
    try { assertUnavailableResources(t) } catch (error) { die(`task ${t.id}: ${error.message}`) }
    if (!historical.has(t.id))
      try { validationContract(t) } catch (error) { die(`task ${t.id}: ${error.message}`) }
    ids.add(t.id)
  }
  for (const t of plan.tasks)
    for (const d of t.deps ?? [])
      if (!ids.has(d)) die(`task ${t.id} depends on unknown task ${d}`)

  const depsOf = Object.fromEntries(plan.tasks.map((t) => [t.id, t.deps ?? []]))
  const visitState = {}
  const path = []
  const visit = (id) => {
    if (visitState[id] === 2) return null
    if (visitState[id] === 1) return [...path.slice(path.indexOf(id)), id]
    visitState[id] = 1
    path.push(id)
    for (const d of depsOf[id]) {
      const cycle = visit(d)
      if (cycle) return cycle
    }
    path.pop()
    visitState[id] = 2
    return null
  }
  for (const t of plan.tasks) {
    const cycle = visit(t.id)
    if (cycle) die(`plan has a dependency cycle: ${cycle.join(' → ')}`)
  }

  const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]))
  for (let i = 0; i < plan.tasks.length; i++) {
    for (let j = i + 1; j < plan.tasks.length; j++) {
      const a = plan.tasks[i]
      const b = plan.tasks[j]
      if (!a.touches?.length || !b.touches?.length) continue
      if (reaches(byId, a.id, b.id) || reaches(byId, b.id, a.id)) continue
      const clash = a.touches.find((pa) => b.touches.some((pb) => pathsCollide(pa, pb)))
      if (clash && !allowOverlap)
        die(
          `${a.id} and ${b.id} can run in parallel but both touch "${clash}" — ` +
            `add a dep between them (or --allow-overlap)`,
        )
    }
  }
}

function historicalTasks(state) {
  return new Set(Object.values(state?.tasks ?? {}).filter(t => ['done', 'skipped'].includes(t.state)).map(t => t.id))
}

function printSyncPlanAudit(changes, diagnostics) {
  // Applied changes are the actionable CLI result. Preserved terminal diffs stay
  // structured in the event and are summarized by task ID below, avoiding a wall
  // of historical fields when an old run contains many completed contracts.
  for (const change of changes.filter(item => !item.preserved)) {
    const details = change.fields.map(formatContractChange).join('; ')
    log('[prumo] ' + tr('sync-plan task {0} changed: {1}', displayIdentifier(change.task), details))
  }
  for (const finding of diagnostics.blockReasonContradictions) {
    if (finding.missingDeps.length)
      log('[prumo] ' + tr(
        'sync-plan warning: {0} blockReason cites {1}, absent from persisted deps',
        displayIdentifier(finding.task), finding.missingDeps.map(displayIdentifier).join(', '),
      ))
    if (finding.plannedMissingDeps.length)
      log('[prumo] ' + tr(
        'sync-plan warning: {0} blockReason cites {1}, absent from planned deps',
        displayIdentifier(finding.task), finding.plannedMissingDeps.map(displayIdentifier).join(', '),
      ))
    const backEdges = [...new Set([...finding.backEdgesBefore, ...finding.backEdgesAfter])]
    if (backEdges.length)
      log('[prumo] ' + tr(
        'sync-plan strong warning: {0} blockReason cites {1}, and cited tasks depend on it',
        displayIdentifier(finding.task), backEdges.map(displayIdentifier).join(', '),
      ))
  }
  for (const leaf of diagnostics.newLeaves) {
    if (leaf.severity === 'warning') {
      const blocker = diagnostics.blockReasonContradictions.find(item => item.cited.includes(leaf.task))?.task
      log('[prumo] ' + tr(
        'sync-plan warning: new leaf task {0} is cited by blocked task {1}',
        displayIdentifier(leaf.task), displayIdentifier(blocker ?? '?'),
      ))
    } else {
      log('[prumo] ' + tr('sync-plan info: new leaf task {0} has no dependents', displayIdentifier(leaf.task)))
    }
  }
  for (const finding of diagnostics.preDiscussionFunctionalContracts) {
    const unit = finding.count === 1 ? 'functional check' : 'functional checks'
    const indexLabel = finding.indices.length === 1 ? 'new index' : 'new indices'
    const indices = finding.indices.join(', ') + (finding.truncated ? ', …' : '')
    log(`[prumo] sync-plan warning: ${displayIdentifier(finding.task)} is ${tr(finding.effective)}, but validation now has ${finding.count} ${unit} (${indexLabel} ${indices}); is this planning?`)
  }
  for (const invalidation of diagnostics.invalidatedWorkflows ?? []) {
    const workflow = tr(invalidation.workflow)
    const label = invalidation.task ? `${displayIdentifier(invalidation.task)} ${workflow}` :
      `${displayIdentifier(invalidation.id)} ${workflow}`
    log('[prumo] ' + tr('sync-plan warning: {0} was invalidated: {1}', label, invalidation.cause))
  }
}

function readPlan(planPath, state) {
  const source = resolve(planPath)
  const plan = JSON.parse(readFileSync(source, 'utf8'))
  const validationPlan = state ? { ...plan, planningMode: state.plan.planningMode ?? 'task' } : plan
  validatePlan(validationPlan, args['allow-overlap'] === true, historicalTasks(state))
  return { plan, source }
}

function taskFromPlan(t) {
  return {
    id: t.id,
    phase: t.phase ?? null,
    title: t.title,
    label: t.label,
    summary: t.summary,
    validationSummary: t.validationSummary,
    deps: t.deps ?? [],
    validation: t.validation ?? '',
    validationMode: t.validationMode,
    inspectionReason: t.inspectionReason,
    requireReview: t.requireReview,
    maxAttempts: t.maxAttempts,
    tags: t.tags ?? [],
    touches: t.touches ?? [],
    unavailable: t.unavailable,
    state: 'pending',
    discussionRequired: true,
    discussionAttempts: [],
    discussionSkips: [],
    discoveryRequired: true,
    planningRequired: true,
    planner: null,
    planningAttempts: [],
    planningHistory: [],
    planningSkips: [],
    agent: null,
    reviewer: null,
    attempts: [],
    validations: [],
    notes: [],
  }
}

function globalPlanValues(plan) {
  return {
    name: plan.name,
    description: plan.description ?? '',
    requireReview: plan.requireReview !== false,
  }
}

function beginPlanning(state, task, agent, context = planningContext(state, task), digest = task.discovery?.digest) {
  task.planningRequired = true
  task.planner = agent
  task.planningAttempts ??= []
  task.planningHistory ??= []
  task.planningAttempts.push({ n: task.planningAttempts.length + 1, agent,
    startedAt: new Date().toISOString(), context, attempt: task.attempts.length + (task.planningReturn ? 0 : 1),
    contextSnapshot: taskContextSnapshot(state, task),
    ...(digest ? { discoveryDigest: digest } : {}) })
  task.state = 'planning'
}

function closePlanning(task, result, cause) {
  const round = task.planningAttempts?.at(-1)
  if (round && !round.endedAt) Object.assign(round, { endedAt: new Date().toISOString(), result,
    ...(cause ? { cause } : {}) })
}

function closeDiscussion(task, result, cause) {
  const round = task.discussionAttempts?.at(-1)
  if (round && !round.endedAt) Object.assign(round, { endedAt: new Date().toISOString(), result,
    ...(cause ? { cause } : {}) })
}

function currentDiscussion(state, task) {
  const round = task.discussionAttempts?.at(-1)
  return round?.result === 'discussed' && round.context === planningContext(state, task) &&
    round.attempt === task.attempts.length + (task.planningReturn ? 0 : 1) &&
    task.discovery?.roundId === round.roundId && task.discovery?.nonce === round.nonce &&
    task.discovery?.digest === round.discoveryDigest && task.discovery.digest === discoveryDigest(task.discovery)
}

function phaseMembers(state, phaseId) {
  return Object.values(state.tasks).filter(task => task.phase === phaseId)
}

function getPhase(state, phaseId) {
  const phase = state.phaseWorkflows?.[phaseId]
  if (!phase) die(`unknown phase "${phaseId}"`)
  return phase
}

function phaseTargets(state, phaseId) {
  return phaseMembers(state, phaseId).filter(task => !['done', 'skipped'].includes(task.state) &&
    usesCurrentPlanning(state, task) &&
    !(task.taskPlan?.phaseId === phaseId && hasCurrentTaskPlan(state, task)))
}

function phaseDiscussionTargets(state, phaseId, round = null) {
  const targets = phaseTargets(state, phaseId)
  if (targets.length || !round?.targetsFallback) return targets
  return phaseMembers(state, phaseId).filter(task => usesCurrentPlanning(state, task) &&
    !['done', 'skipped'].includes(task.state))
}

function phasePlanningBlockers(state, phaseId) {
  const blockers = new Set()
  for (const task of phaseMembers(state, phaseId)) {
    if (['done', 'skipped'].includes(task.state) || !usesCurrentPlanning(state, task)) continue
    for (const id of task.deps ?? []) {
      const dep = state.tasks[id]
      if (dep?.phase !== phaseId && !['done', 'skipped'].includes(dep?.state)) {
        blockers.add(dep?.phase ?? id)
      }
    }
  }
  return [...blockers]
}

function eligibleDiscussionPhases(state) {
  if (state.plan.planningMode !== 'phase') return []
  return (state.plan.phases ?? []).flatMap(phase => {
    const workflow = state.phaseWorkflows?.[phase.id]
    if (!workflow || ['discussing', 'planning'].includes(workflow.state) ||
        state.legacyPhaseAdoption && !workflow.adoptedLegacy || phasePlanningBlockers(state, phase.id).length)
      return []
    const targets = phaseTargets(state, phase.id)
    return targets.length ? [{ phase: phase.id, tasks: targets.map(task => task.id) }] : []
  })
}

function announceNewlyEligiblePhases(name, previouslyEligible, state, cause) {
  const previous = new Set(previouslyEligible.map(item => item.phase))
  for (const item of eligibleDiscussionPhases(state)) {
    if (previous.has(item.phase)) continue
    emit(name, 'phase_eligible', null, { ...item, cause })
    log('[prumo] ' + tr('phase {0} is eligible for discussion; tasks: {1}', item.phase, item.tasks.join(', ')))
  }
}

function planQuestionRef(task, plan, index) {
  const fingerprint = digestValue([task.id, plan?.startedAt ?? '', index + 1, plan?.openQuestions?.[index]?.question])
  return plan?.openQuestions?.[index]?.questionRef ?? `${task.id}:plan:${fingerprint.slice(0, 12)}`
}

function annotatePlanQuestions(task, questions, startedAt) {
  return (questions ?? []).map((question, index) => ({ ...question,
    questionRef: `${task.id}:plan:${digestValue([task.id, startedAt, index + 1, question.question]).slice(0, 12)}` }))
}

function openQuestionRecords(state) {
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

function questionResolutionMap(state) {
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

function validateQuestionDeadlines(state, taskId, openQuestions) {
  for (const [index, question] of (openQuestions ?? []).entries()) {
    if (question.decideBy && typeof question.decideBy === 'object') {
      if (question.decideBy.beforeTask && !state.tasks[question.decideBy.beforeTask])
        die(`task plan open question ${index + 1} references unknown task ${question.decideBy.beforeTask}`)
      if (question.decideBy.beforePhase && !(state.plan.phases ?? []).some(phase => phase.id === question.decideBy.beforePhase))
        die(`task plan open question ${index + 1} references unknown phase ${question.decideBy.beforePhase}`)
    }
    const decideBy = question.blocking ? 'user-now' : (question.decideBy ?? 'executor')
    if (!question.answer && targetHasStarted(state, decideBy))
      die(tr('task plan open question {0} has an expired deadline and must be answered before it can be added', index + 1))
  }
}

function validateQuestionResolutions(state, decisions) {
  const known = new Set(openQuestionRecords(state).map(item => item.ref))
  const requested = (decisions ?? []).filter(item => item?.resolvesQuestion).map(item => item.resolvesQuestion)
  if (new Set(requested).size !== requested.length)
    die(tr('decisions cannot resolve the same open question more than once'))
  for (const ref of requested) if (!known.has(ref))
    die(tr('decision references unknown open question {0}', ref))
  const resolved = questionResolutionMap(state)
  for (const ref of requested) if (resolved.has(ref))
    die(tr('open question {0} was already resolved', ref))
  return requested
}

function recordQuestionResolutions(state, refs, decisions, { task, phase } = {}) {
  if (!refs.length) return
  state.questionResolutions ??= []
  for (const ref of refs) {
    const decision = decisions.find(item => item.resolvesQuestion === ref)
    state.questionResolutions.push({ questionRef: ref, ...(task ? { byTask: task } : {}),
      ...(phase ? { byPhase: phase } : {}), question: decision.question, answer: decision.answer,
      at: new Date().toISOString() })
  }
}

function taskHasStarted(state, task) {
  return Boolean(task && ((task.discussionAttempts?.length ?? 0) || (task.planningAttempts?.length ?? 0) ||
    (task.discussionSkips?.length ?? 0) || (task.planningSkips?.length ?? 0) ||
    (task.attempts?.length ?? 0) || ['running', 'reviewing', 'done', 'skipped'].includes(task.state)))
}

function phaseWorkflowHasStarted(state, phaseId, taskId = null) {
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

function targetHasStarted(state, decideBy) {
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

function overdueQuestions(state, taskId = null, phaseId = null) {
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

function questionIsOverdue(state, item) {
  if (item.decideBy === 'user-now') return true
  if (item.decideBy === 'executor') return false
  return targetHasStarted(state, item.decideBy)
}

function scheduledQuestionsForTarget(state, taskId = null, phaseId = null) {
  const resolved = questionResolutionMap(state)
  return openQuestionRecords(state).filter(item => {
    if (item.question.answer || resolved.has(item.ref)) return false
    if (item.decideBy === 'executor') return false
    if (item.decideBy === 'user-now') return item.sourceTask === taskId
    if (item.decideBy?.beforeTask) return item.decideBy.beforeTask === taskId
    if (item.decideBy?.beforePhase) return item.decideBy.beforePhase === phaseId
    return false
  })
}

function printQuestionsForTarget(state, taskId, phaseId) {
  const questions = scheduledQuestionsForTarget(state, taskId, phaseId)
  if (!questions.length) return
  log('[prumo] ' + tr('resolve open questions before proceeding; reference each question ID in decisions[].resolvesQuestion:'))
  for (const item of questions)
    log(`[prumo] ${item.ref} (from ${item.sourceTask}): ${item.question.question}`)
}

function assertNoOverdueQuestions(state, task) {
  const questions = overdueQuestions(state, task.id, task.phase)
  if (questions.length)
    die(tr('{0} has unresolved questions due before it starts: {1}; resolve them in discussion or planning decisions',
      task.id, questions.map(item => item.ref).join(', ')))
}

function printQuestionStatus(state) {
  const resolved = questionResolutionMap(state)
  for (const item of openQuestionRecords(state)) {
    if (item.question.answer || resolved.has(item.ref) || item.decideBy === 'executor') continue
    const deadline = item.decideBy === 'user-now' ? tr('now') : item.decideBy.beforeTask ?
      tr('before task {0}', item.decideBy.beforeTask) : tr('before phase {0}', item.decideBy.beforePhase)
    const label = questionIsOverdue(state, item) ? tr('overdue') : tr('scheduled')
    log('[prumo] ' + tr('open question {0} ({1}, {2}): {3}', item.ref, label, deadline, item.question.question))
  }
}

function taskAuthorization(task) { return task.executionAuthorization ?? null }

function assertTaskExecutionAuthorized(task) {
  if (!taskAuthorization(task))
    die(tr('{0} has no execution authorization; ask the user to accept a scope with authorize --confirmed-by-user', task.id))
}

function assertReauthorizedAfterContractChange(task) {
  if (!taskAuthorization(task) && task.authorizationHistory?.length) assertTaskExecutionAuthorized(task)
}

function manualDispatchConfirmation(task, message) {
  const authorization = taskAuthorization(task)
  if (authorization?.mode !== 'manual') return null
  if (args['confirmed-by-user'] !== true) die(tr(message, task.id))
  const channel = args.channel ?? 'cli'
  if (typeof channel !== 'string' || !channel.trim()) die(tr('confirmation channel must be nonempty'))
  return { authorizationId: authorization.authorizationId, confirmedByUser: true,
    at: new Date().toISOString(), channel: channel.trim() }
}

function manualConfirmationIdentity(entry) {
  const { action, ...payload } = entry
  return JSON.stringify([action, Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))])
}

function compareManualConfirmationTime(left, right) {
  const leftAt = Date.parse(left.at), rightAt = Date.parse(right.at)
  const a = Number.isFinite(leftAt) ? leftAt : Number.POSITIVE_INFINITY
  const b = Number.isFinite(rightAt) ? rightAt : Number.POSITIVE_INFINITY
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function mergeMissingManualConfirmations(history, missing) {
  const orderedMissing = missing.map((entry, index) => ({ entry, index }))
    .sort((left, right) => compareManualConfirmationTime(left.entry, right.entry) || left.index - right.index)
    .map(item => item.entry)
  const merged = []
  let existingIndex = 0, missingIndex = 0
  while (existingIndex < history.length && missingIndex < orderedMissing.length) {
    if (compareManualConfirmationTime(orderedMissing[missingIndex], history[existingIndex]) < 0)
      merged.push(orderedMissing[missingIndex++])
    else merged.push(history[existingIndex++])
  }
  merged.push(...history.slice(existingIndex), ...orderedMissing.slice(missingIndex))
  return merged
}

function recordManualConfirmation(attempt, action, confirmation) {
  if (!attempt || !confirmation) return
  const fields = {
    dispatch: 'manualDispatchConfirmation',
    review: 'manualReviewConfirmation',
    retry: 'manualRetryConfirmation',
    resume: 'manualResumeConfirmation',
  }
  let history = Array.isArray(attempt.manualConfirmations) ? [...attempt.manualConfirmations] : []
  const seen = new Set(history.map(manualConfirmationIdentity))
  const missing = []
  for (const [legacyAction, field] of Object.entries(fields)) {
    const legacy = attempt[field]
    if (!legacy) continue
    const entry = { action: legacyAction, ...legacy }
    const identity = manualConfirmationIdentity(entry)
    if (seen.has(identity)) continue
    seen.add(identity)
    missing.push(entry)
  }
  history = mergeMissingManualConfirmations(history, missing)
  history.push({ action, ...confirmation })
  attempt.manualConfirmations = history
  attempt[fields[action]] = confirmation
}

function authorizeScope(state, scope) {
  if (scope === 'run') return Object.keys(state.tasks)
  if (typeof scope !== 'string' || !scope.includes(':')) die('authorize needs --scope run|phase:<phase>|tasks:<task,...>')
  const [kind, value, ...extra] = scope.split(':')
  if (extra.length || !value) die('authorize scope must be run, phase:<phase> or tasks:<task,...>')
  if (kind === 'phase') {
    if (!(state.plan.phases ?? []).some(phase => phase.id === value)) die(`unknown phase "${value}"`)
    return Object.values(state.tasks).filter(task => task.phase === value).map(task => task.id)
  }
  if (kind === 'tasks') {
    const ids = value.split(',').filter(Boolean)
    if (!ids.length || new Set(ids).size !== ids.length) die('tasks scope needs distinct task IDs')
    for (const id of ids) getTask(state, id)
    return ids
  }
  die('authorize scope must be run, phase:<phase> or tasks:<task,...>')
}

function executionSlots(state) {
  const occ = occupancy(state)
  return Math.max(0, Math.min(occ.maxExec - occ.executors.length, occ.cap - occ.busy.length))
}

function actionForTask(state, task, slots) {
  if (!['ready_for_discussion', 'ready_to_plan', 'ready'].includes(task.effective)) return ''
  if (task.effective === 'ready_for_discussion')
    return state.plan.planningMode === 'phase' ? tr('ask user to begin discussion for {0}', task.phase) :
      `begin-discussion ${task.id}; ${tr('ask user')}`
  const due = overdueQuestions(state, task.id, task.phase)
  if (task.effective === 'ready_to_plan') {
    const command = state.plan.planningMode === 'phase' ? `plan-phase ${task.phase} --agent <planner>` : `plan-task ${task.id} --agent <planner>`
    return `${command}${due.length ? `; ${tr('resolve due questions {0} in the plan decisions', due.map(item => item.ref).join(', '))}` : ''}`
  }
  if (due.length) {
    const command = state.plan.planningMode === 'phase' ? `begin-phase-discussion ${task.phase}` : `begin-discussion ${task.id}`
    return `${command}; ${tr('resolve due questions {0} before dispatch', due.map(item => item.ref).join(', '))}`
  }
  const authorization = taskAuthorization(task)
  if (!authorization) return `${tr('ask user to authorize')}: authorize --scope tasks:${task.id} --confirmed-by-user`
  if (authorization.mode === 'manual') return tr('ask user before dispatching {0}', task.id)
  if (slots > 0) return `start ${task.id} --agent <executor>`
  return tr('wait for an execution slot, then start {0}', task.id)
}

function printDispatchSuggestions(state, tasks = null) {
  const d = derive(state)
  const candidates = tasks ?? Object.values(d).filter(task => ['ready_for_discussion', 'ready_to_plan', 'ready'].includes(task.effective))
  let slots = executionSlots(state)
  for (const task of candidates) {
    const current = d[task.id] ?? task
    const action = actionForTask(state, current, slots)
    if (action) log('[prumo] ' + tr('suggested action for {0}: {1}', current.id, action))
    if (current.effective === 'ready' && taskAuthorization(current)?.mode === 'auto' && slots > 0 &&
        !overdueQuestions(state, current.id, current.phase).length) slots -= 1
  }
}

function suggestedActionsByTask(state) {
  const actions = new Map()
  let slots = executionSlots(state)
  for (const task of Object.values(derive(state))) {
    const action = actionForTask(state, task, slots)
    if (action) actions.set(task.id, action)
    if (task.effective === 'ready' && taskAuthorization(task)?.mode === 'auto' && slots > 0 &&
        !overdueQuestions(state, task.id, task.phase).length) slots -= 1
  }
  return actions
}

function assertPhasePlanningOrder(state, phaseId) {
  const blockers = phasePlanningBlockers(state, phaseId)
  if (blockers.length) die(`${phaseId} waits for external dependencies: ${blockers.join(', ')}. Keep the approved phases; complete their dependency tasks first.`)
}

function phaseContext(state, phaseId, targets = phaseTargets(state, phaseId)) {
  return JSON.stringify([state.plan.name, state.plan.description, state.plan.planningRevision ?? 0, phaseId,
    targets.map(task => [task.id, phasePlanningContext(state, task)]).sort()])
}

function digestValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function contextPlanSnapshot(state) {
  return { name: state.plan.name, description: state.plan.description ?? '',
    planningRevision: state.plan.planningRevision ?? 0 }
}

function contextTaskIds(state, targets) {
  const ids = new Set()
  const visit = id => {
    if (ids.has(id)) return
    ids.add(id)
    for (const dependency of state.tasks[id]?.deps ?? []) visit(dependency)
  }
  for (const task of targets) visit(task.id)
  return [...ids].sort()
}

function taskContextDigests(state, targets, { phasePlanning = false } = {}) {
  return contextTaskIds(state, targets).map(id => {
    const task = state.tasks[id]
    if (!task) return { task: id, contextDigest: digestValue(null), inputDigest: digestValue(null), outputDigest: digestValue(null) }
    const taskDigest = phasePlanning ? phasePlanningContext(state, task) : planningContext(state, task)
    const dependencyIds = [...(task.deps ?? [])].sort()
    const input = dependencyIds.map(dependency => {
      const value = state.tasks[dependency]
      return phasePlanning
        ? [dependency, value ? phasePlanningContext(state, value) : null]
        : [dependency, value ? [phasePlanningContext(state, value), value.state, value.attempts, value.validations, value.skipReason] : null]
    })
    const output = [task.id, task.phase ?? null, task.title, task.deps ?? [], task.validation ?? '',
      task.validationMode, task.inspectionReason, task.requireReview, task.maxAttempts, task.tags ?? [],
      task.touches ?? [], task.unavailable]
    return { task: id, contextDigest: taskDigest, inputDigest: digestValue(input), outputDigest: digestValue(output) }
  })
}

function phaseContextSnapshot(state, targets) {
  return { plan: contextPlanSnapshot(state), tasks: taskContextDigests(state, targets, { phasePlanning: true }) }
}

function taskContextSnapshot(state, task) {
  return { plan: contextPlanSnapshot(state), tasks: taskContextDigests(state, [task]) }
}

function phaseContractDigests(state, targets) {
  return targets.map(task => ({ task: task.id, digest: phasePlanningContext(state, task) }))
    .sort((left, right) => left.task.localeCompare(right.task))
}

function latestPlanSyncAuditAt(name) {
  try {
    const lines = readFileSync(join(runDir(name), 'events.ndjson'), 'utf8').trim().split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index--) {
      const event = JSON.parse(lines[index])
      if (event.type === 'plan_sync_audit' && typeof event.at === 'string') return event.at
    }
  } catch { /* uma execução antiga ou incompleta ainda pode não ter log de eventos */ }
  return null
}

function staleReason(name, round, currentSnapshot, currentContext) {
  const saved = round?.contextSnapshot
  const changes = []
  if (saved?.plan && currentSnapshot?.plan) {
    for (const field of ['name', 'description', 'planningRevision']) {
      if (JSON.stringify(saved.plan[field]) !== JSON.stringify(currentSnapshot.plan[field]))
        changes.push(tr('plan {0} changed', field))
    }
    const previous = new Map((saved.tasks ?? []).map(task => [task.task, task]))
    const current = new Map((currentSnapshot.tasks ?? []).map(task => [task.task, task]))
    for (const id of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
      const before = previous.get(id), after = current.get(id)
      if (!before || !after) {
        changes.push(tr('task {0} entered or left the current context', displayIdentifier(id)))
        continue
      }
      for (const field of ['contextDigest', 'inputDigest', 'outputDigest']) {
        if (before[field] !== after[field])
          changes.push(tr('task {0} {1} digest changed ({2} → {3})', displayIdentifier(id), field,
            String(before[field] ?? 'missing').slice(0, 12), String(after[field] ?? 'missing').slice(0, 12)))
      }
    }
  }
  if (!changes.length && round?.context !== currentContext)
    changes.push(tr('saved context digest {0} differs from current digest {1}',
      String(round?.context ?? 'missing').slice(0, 12), String(currentContext ?? 'missing').slice(0, 12)))
  if (!changes.length && round?.context === currentContext)
    changes.push(tr('discussion decision or attempt binding changed'))
  const auditAt = latestPlanSyncAuditAt(name)
  if (auditAt) changes.push(tr('last plan_sync_audit: {0}', auditAt))
  return changes.length ? changes.join('; ') : tr('saved and current planning contexts differ')
}

function currentPhasePlanningSkip(state, phase) {
  const decision = phase?.planningSkips?.at(-1)
  if (decision?.decision !== 'skipped' || decision.confirmedByUser !== true) return null
  const targets = decision.targets?.map(id => state.tasks[id]).filter(Boolean)
  return targets?.length === decision.targets.length &&
    decision.context === phaseContext(state, phase.id, targets) ? decision : null
}

function invalidatedSyncWorkflows(name, before, after) {
  const result = []
  const record = (scope, workflow, id, round, contextSnapshot, currentSnapshot, currentContext, task) => {
    const cause = staleReason(name, { ...round, context: round?.context ?? round?.scope, contextSnapshot }, currentSnapshot, currentContext)
    result.push({ scope, workflow, id, ...(task ? { task } : {}),
      ...(round?.roundId ? { roundId: round.roundId } : {}),
      ...(round?.decisionId ? { decisionId: round.decisionId } : {}), cause })
  }

  for (const [phaseId, oldPhase] of Object.entries(before.phaseWorkflows ?? {})) {
    const phase = after.phaseWorkflows?.[phaseId]
    if (!phase) continue
    const discussion = oldPhase.discussionAttempts?.at(-1)
    const currentDiscussionTargets = phaseDiscussionTargets(after, phaseId, discussion)
    const currentDiscussionTargetIds = currentDiscussionTargets.map(task => task.id).sort()
    const openedDiscussionTargetIds = [...(discussion?.targets ?? [])].sort()
    if (discussion && !discussion.endedAt && (discussion.context !== phaseContext(after, phaseId,
        (discussion.targets ?? []).map(id => after.tasks[id]).filter(Boolean)) ||
        JSON.stringify(openedDiscussionTargetIds) !== JSON.stringify(currentDiscussionTargetIds))) {
      record('phase', 'discussion', phaseId, discussion, discussion.contextSnapshot,
        phaseContextSnapshot(after, currentDiscussionTargets),
        phaseContext(after, phaseId, currentDiscussionTargets))
    }
    const planning = oldPhase.planningAttempts?.at(-1)
    if (planning && !planning.endedAt && !currentPhasePlanning(after, phase, planning)) {
      const targets = (planning.contextTargets ?? planning.targets ?? []).map(id => after.tasks[id]).filter(Boolean)
      record('phase', 'planning', phaseId, planning, planning.contextSnapshot,
        phaseContextSnapshot(after, targets), phaseContext(after, phaseId, targets))
    }
    const completedDiscussion = currentPhaseDiscussionDecision(before, oldPhase)
    if (completedDiscussion?.kind === 'discussed' && !currentPhaseDiscussionDecision(after, phase)) {
      const targets = (completedDiscussion.targets ?? []).map(id => after.tasks[id]).filter(Boolean)
      record('phase', 'discussion', phaseId, oldPhase.discussionAttempts?.find(round => round.roundId === completedDiscussion.id),
        oldPhase.discussionAttempts?.find(round => round.roundId === completedDiscussion.id)?.contextSnapshot,
        phaseContextSnapshot(after, targets), phaseContext(after, phaseId, targets))
    }
    const discussionSkip = currentPhaseDiscussionSkip(before, oldPhase)
    if (discussionSkip && !currentPhaseDiscussionSkip(after, phase)) {
      const targets = (discussionSkip.targets ?? []).map(id => after.tasks[id]).filter(Boolean)
      record('phase', 'discussion skip', phaseId, discussionSkip, discussionSkip.contextSnapshot,
        phaseContextSnapshot(after, targets), phaseContext(after, phaseId, targets))
    }
    const planningSkip = currentPhasePlanningSkip(before, oldPhase)
    if (planningSkip && !currentPhasePlanningSkip(after, phase)) {
      const targets = (planningSkip.targets ?? []).map(id => after.tasks[id]).filter(Boolean)
      record('phase', 'planning skip', phaseId, planningSkip, planningSkip.contextSnapshot,
        phaseContextSnapshot(after, targets), phaseContext(after, phaseId, targets))
    }
  }

  for (const [id, oldTask] of Object.entries(before.tasks ?? {})) {
    const task = after.tasks?.[id]
    if (!task) continue
    const discussion = oldTask.discussionAttempts?.at(-1)
    if (discussion && !discussion.endedAt && discussion.context !== planningContext(after, task))
      record('task', 'discussion', id, discussion, discussion.contextSnapshot,
        taskContextSnapshot(after, task), planningContext(after, task), id)
    const completedDiscussion = currentTaskDiscussionDecision(before, oldTask)
    if (completedDiscussion?.kind === 'discussed' && !currentTaskDiscussionDecision(after, task)) {
      const round = oldTask.discussionAttempts?.find(item => item.roundId === completedDiscussion.id)
      record('task', 'discussion', id, round, round?.contextSnapshot,
        taskContextSnapshot(after, task), planningContext(after, task), id)
    }
    const planning = oldTask.planningAttempts?.at(-1)
    if (planning && !planning.endedAt && planning.context !== planningContext(after, task))
      record('task', 'planning', id, planning, planning.contextSnapshot,
        taskContextSnapshot(after, task), planningContext(after, task), id)
    const discussionSkip = currentTaskDiscussionSkip(before, oldTask)
    if (discussionSkip && !currentTaskDiscussionSkip(after, task))
      record('task', 'discussion skip', id, discussionSkip, discussionSkip.contextSnapshot,
        taskContextSnapshot(after, task), planningContext(after, task), id)
    const planningSkip = currentPlanningSkip(before, oldTask)
    if (planningSkip && !currentPlanningSkip(after, task))
      record('task', 'planning skip', id, planningSkip, planningSkip.contextSnapshot,
        taskContextSnapshot(after, task), planningContext(after, task), id)
  }
  return result
}

function currentPhaseDiscussion(state, phase) {
  const round = phase?.discussionAttempts?.at(-1)
  const targets = round?.targets?.map(id => state.tasks[id]).filter(Boolean)
  const covered = new Set(round?.targets ?? [])
  return round?.result === 'discussed' && targets?.length === round.targets.length &&
    phaseTargets(state, phase.id).every(task => covered.has(task.id)) &&
    round.context === phaseContext(state, phase.id, targets) && phase.discovery?.context === round.context &&
    phase.discovery?.roundId === round.roundId &&
    phase.discovery?.nonce === round.nonce && phase.discovery?.digest === round.discoveryDigest &&
    phase.discovery.digest === discoveryDigest(phase.discovery)
}

function currentPhaseDiscussionSkip(state, phase) {
  const decision = phase?.discussionSkips?.at(-1)
  if (decision?.decision !== 'skipped' || decision.confirmedByUser !== true) return null
  const targets = decision.targets?.map(id => state.tasks[id]).filter(Boolean)
  const covered = new Set(decision.targets ?? [])
  return targets?.length === decision.targets.length &&
    phaseTargets(state, phase.id).every(task => covered.has(task.id)) &&
    decision.context === phaseContext(state, phase.id, targets) ? decision : null
}

function currentPhaseDiscussionDecision(state, phase) {
  const round = currentPhaseDiscussion(state, phase) ? phase.discussionAttempts.at(-1) : null
  const skipped = currentPhaseDiscussionSkip(state, phase)
  const discussionAt = round?.endedAt ?? ''
  if (round && (!skipped || discussionAt > skipped.at)) return {
    kind: 'discussed', id: round.roundId, digest: phase.discovery.digest, targets: round.targets,
  }
  if (skipped) return {
    kind: 'skipped', id: skipped.decisionId, digest: skipped.digest, targets: skipped.targets,
  }
  return null
}

function logPhasePlanningInputs(phaseId, round) {
  const binding = { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n }
  for (const id of round.targets) {
    log(tr('Copy these fields into task-plan-{0}.json:', id))
    log('```json')
    log(JSON.stringify({ phaseBinding: binding, unresolvedInputs: round.requiredInputs?.[id] ?? [] }, null, 2))
    log('```')
  }
}

function currentTaskDiscussionSkip(state, task) {
  const decision = task.discussionSkips?.at(-1)
  return decision?.decision === 'skipped' && decision.confirmedByUser === true &&
    decision.scope === phasePlanningContext(state, task) ? decision : null
}

function currentTaskDiscussionDecision(state, task) {
  const round = currentDiscussion(state, task) ? task.discussionAttempts.at(-1) : null
  const skipped = currentTaskDiscussionSkip(state, task)
  if (round && (!skipped || (round.endedAt ?? '') > skipped.at)) return {
    kind: 'discussed', id: round.roundId, digest: task.discovery.digest,
  }
  return skipped ? { kind: 'skipped', id: skipped.decisionId, digest: skipped.digest } : null
}

function explicitSkipDecision(scope) {
  const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() :
    die(`${scope} needs --reason <text>`)
  if (args['confirmed-by-user'] !== true)
    die(`${scope} needs --confirmed-by-user after the user explicitly chooses to skip`)
  const decisionId = randomUUID(), at = new Date().toISOString()
  return { decision: 'skipped', decisionId, digest: decisionId, reason, confirmedByUser: true, at }
}

function currentPhasePlanning(state, phase, round = phase?.planningAttempts?.at(-1)) {
  if (!round || round.endedAt || !Array.isArray(round.targets)) return false
  const discussion = currentPhaseDiscussionDecision(state, phase)
  const targets = round.targets.map(id => state.tasks[id]).filter(Boolean)
  const liveTargets = phaseTargets(state, phase.id).map(task => task.id).sort()
  return discussion?.id === round.discussionRoundId && discussion.digest === (round.discussionDigest ?? round.discoveryDigest) &&
    targets.length === round.targets.length &&
    JSON.stringify([...round.targets].sort()) === JSON.stringify(liveTargets) &&
    round.context === phaseContext(state, phase.id, discussion.targets.map(id => state.tasks[id]))
}

function assertCurrentTaskScope(state, task) {
  if (!hasCurrentTaskScope(state, task))
    die(task.id + ' execution scope needs current planning — keep work blocked, run plan-task and finish-planning, then unblock explicitly')
}

function assertCurrentExecutionInputs(state, task) {
  if (!task.attempts?.length) return
  const blockedBy = (task.deps ?? []).filter(id => !['done', 'skipped'].includes(state.tasks[id]?.state))
  if (blockedBy.length) die(task.id + ' still waiting on: ' + blockedBy.join(', '))
  if (!task.taskPlan?.phaseId && !currentPlanningSkip(state, task)) return
  let receipt
  try { receipt = executionInputReceipt(state, task) } catch (error) { die(error.message) }
  if (task.attempts.at(-1).inputDigest !== receipt.digest)
    die(task.id + ' dependency input receipt changed after execution started')
}

/** Derived view: effective state per task (ready is computed, never stored). */
export function derive(state) {
  const out = {}
  const migrationPending = !['phase', 'task'].includes(state.plan?.planningMode)
  for (const [id, t] of Object.entries(state.tasks)) {
    let effective = t.state
    let blockedBy = []
    let planningBlockedBy = []
    const phase = state.phaseWorkflows?.[t.phase]
    if (t.state === 'pending') {
      blockedBy = t.deps.filter((d) => {
        const dep = state.tasks[d]
        return !dep || (dep.state !== 'done' && dep.state !== 'skipped')
      })
      const phaseAdopted = !(state.legacyPhaseAdoption && !state.phaseWorkflows?.[t.phase]?.adoptedLegacy)
      if (!usesCurrentPlanning(state, t)) {
        effective = blockedBy.length ? 'waiting' : 'ready'
      } else if (state.plan.planningMode === 'phase') {
        planningBlockedBy = phasePlanningBlockers(state, t.phase)
        const discussionRound = phase?.discussionAttempts?.at(-1)
        const phaseDiscussing = phase?.state === 'discussing' && !discussionRound?.endedAt &&
          discussionRound?.targets?.includes(t.id)
        const planningRound = phase?.planningAttempts?.at(-1)
        const phasePlanning = phase?.state === 'planning' && currentPhasePlanning(state, phase, planningRound) &&
          planningRound.targets.includes(t.id)
        effective = !phaseAdopted ? 'pending' : phaseDiscussing ? 'discussing' : hasCurrentTaskPlan(state, t) ?
          (blockedBy.length ? 'waiting' : 'ready') : phasePlanning ? 'planning' : planningBlockedBy.length ? 'waiting' :
            (currentPhaseDiscussionDecision(state, phase) ? 'ready_to_plan' : 'ready_for_discussion')
      } else {
        effective = blockedBy.length ? 'waiting' : !phaseAdopted ? 'pending' :
          hasCurrentTaskPlan(state, t) ? 'ready' :
            t.discussionRequired && !currentTaskDiscussionDecision(state, t) ? 'ready_for_discussion' : 'ready_to_plan'
      }
    }
    const planningStatus = !usesCurrentPlanning(state, t) ? 'legacy_lifecycle' :
      state.legacyPhaseAdoption && !phase?.adoptedLegacy ? 'awaiting_phase_adoption' : currentPlanningSkip(state, t) ? 'planning_skipped' :
      hasCurrentTaskPlan(state, t) ? 'planned' :
      phase?.state === 'discussing' ? 'phase_discussing' : phase?.state === 'planning' ? 'phase_planning' : 'awaiting_phase_plan'
    let inputStatus
    if (t.taskPlan?.phaseId && t.taskPlan.unresolvedInputs?.length) {
      const entries = t.taskPlan.unresolvedInputs.map(input => ({ input, task: state.tasks[input.task] }))
      const unresolved = entries.filter(({ task }) => !task || !['done', 'skipped'].includes(task.state))
      const inputs = entries.map(({ task }) => task)
      inputStatus = unresolved.length ?
        (unresolved.every(({ task }) => task && task.phase !== t.phase) ? 'unresolved_later_phase_input' : 'unresolved_input') :
        inputs.some(dep => dep.state === 'skipped') ? 'waived_input' : 'validated_input'
    }
    const showPlanningStatus = state.plan.planningMode === 'phase' && usesCurrentPlanning(state, t) && !['done', 'skipped'].includes(t.state)
    out[id] = { ...t, effective, blockedBy, ...(manualInspectionPending(state, t) ? { manualInspectionPending: true } : {}), ...(showPlanningStatus ?
      { planningStatus, ...(planningBlockedBy.length ? { planningBlockedBy } : {}), ...(inputStatus ? { inputStatus } : {}) } : {}) }
    if (migrationPending && t.state === 'pending' && usesCurrentPlanning(state, t))
      Object.assign(out[id], { effective: 'pending', planningStatus: 'awaiting_migration' })
  }
  return out
}

/** Who is busy right now, split by role — the cap is enforced per role, not in bulk. */
function occupancy(state) {
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
    maxExec: state.plan.maxExecutors ?? DEFAULT_MAX_EXECUTORS,
    cap: state.plan.maxParallel ?? DEFAULT_MAX_PARALLEL,
  }
}

/** An agent name may hold only one task at a time, whatever the role. */
function agentBusy(state, agent) {
  return occupancy(state).busy.find((t) => (t.state === 'reviewing' ? t.reviewer : t.state === 'planning' ? t.planner : t.agent) === agent)
}

// Starting and resuming both acquire a slot; a paused task no longer owns one.
function assertAvailable(state, task, role, agent) {
  if (typeof agent !== 'string' || !agent.trim()) die('active work needs a recorded agent')
  const blockedBy = task.deps.filter((id) => !['done', 'skipped'].includes(state.tasks[id]?.state))
  if (blockedBy.length) die(task.id + ' still waiting on: ' + blockedBy.join(', '))
  const occ = occupancy(state)
  if (role === 'running' && occ.executors.length >= occ.maxExec && !args.force)
    die(occ.executors.length + ' executors already running (max ' + occ.maxExec + ')')
  if (occ.busy.filter(t => t.id !== task.id).length >= occ.cap &&
      (!args.force || role === 'planning' || task.planningRequired || occ.planners.length > 0))
    die(occ.busy.length + ' agents busy (cap ' + occ.cap + ')')
  const busy = agentBusy(state, agent)
  if (busy && busy.id !== task.id && (!args.force || role === 'planning' || task.planningRequired || busy.state === 'planning'))
    die('agent "' + agent + '" is already on ' + busy.id + ' — one agent per task')
}

function progress(state) {
  const total = Object.keys(state.tasks).length
  const by = {}
  for (const t of Object.values(derive(state))) by[t.effective] = (by[t.effective] ?? 0) + 1
  return { total, done: by.done ?? 0, by }
}

// ---------- commands ----------
const commands = {
  init() {
    const planPath = args.plan ?? die('init needs --plan <plan.json>')
    const name = args.run ?? die('init needs --run <name>')
    const { plan, source } = readPlan(planPath)
    warnPlanTouchPaths(plan)
    const dir = runDir(name)
    if (existsSync(join(dir, 'state.json')) && !args.force)
      die(`run "${name}" already exists (use --force to overwrite)`)
    mkdirSync(dir, { recursive: true })
    const state = {
      schemaVersion: STATE_SCHEMA_VERSION,
      run: name,
      plan: {
        name: plan.name,
        description: plan.description ?? '',
        phases: plan.phases ?? [],
        maxParallel: plan.maxParallel ?? DEFAULT_MAX_PARALLEL,
        maxExecutors: plan.maxExecutors ?? DEFAULT_MAX_EXECUTORS,
        requireReview: plan.requireReview !== false,
        planningMode: plan.planningMode ?? ((plan.phases?.length ?? 0) ? 'phase' : 'task'),
        source,
      },
      createdAt: new Date().toISOString(),
      authorizations: [],
      tasks: {},
    }
    for (const t of plan.tasks) state.tasks[t.id] = taskFromPlan(t)
    if (state.plan.planningMode === 'phase') state.phaseWorkflows = Object.fromEntries(
      state.plan.phases.map(phase => [phase.id, { id: phase.id, title: phase.title, state: 'pending',
        discussionAttempts: [], planningAttempts: [], planningHistory: [] }]),
    )
    writeFileSync(join(dir, 'events.ndjson'), '')
    saveState(name, state)
    writeFileSync(CURRENT_FILE, name)
    emit(name, 'run_init', null, { plan: plan.name, tasks: plan.tasks.length })
    log(
      `[prumo] run "${name}" initialised: ${plan.tasks.length} tasks, ` +
        `${state.plan.maxExecutors} executors + 1 review slot (cap ${state.plan.maxParallel})` +
        `${state.plan.requireReview ? ', review REQUIRED before done' : ''} — set as CURRENT`,
    )
  },

  migrate() {
    return migrateState(runName(), { check: args.check === true })
  },

  'sync-plan'() {
    const name = runName()
    const state = loadState(name)
    const storedSource = state.plan.source
    const centralSource = storedSource ? join(GRAPH_DIR, 'plans', basename(storedSource)) :
      join(GRAPH_DIR, 'plans', `${safeId(state.plan.name, 'plan')}.plan.json`)
    const planPath = args.plan ?? (storedSource && existsSync(storedSource) ? storedSource :
      existsSync(centralSource) ? centralSource : die('sync-plan needs --plan <plan.json> once'))
    const { plan, source } = readPlan(planPath, state)
    warnPlanTouchPaths(plan)
    const removed = Object.keys(state.tasks).filter((id) => !plan.tasks.some((t) => t.id === id))
    if (removed.length) die(`sync-plan is additive: plan removed ${removed.join(', ')}`)

    const contractFields = TASK_CONTRACT_FIELDS
    const beforeState = structuredClone(state)
    const persistedTasks = structuredClone(state.tasks)
    const added = []
    const updated = []
    const metadataUpdated = []
    const preserved = []
    const changes = []
    for (const planTask of plan.tasks) {
      const current = state.tasks[planTask.id]
      if (!current) {
        state.tasks[planTask.id] = taskFromPlan(planTask)
        added.push(planTask.id)
        continue
      }
      const next = taskFromPlan(planTask)
      const metadataChanges = ['label', 'summary', 'validationSummary'].filter(
        field => JSON.stringify(current[field]) !== JSON.stringify(next[field]))
      for (const field of metadataChanges) {
        if (next[field] === undefined) delete current[field]
        else current[field] = next[field]
      }
      if (metadataChanges.length) metadataUpdated.push(planTask.id)
      const changed = contractFields.filter(
        (field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]),
      )
      if (!changed.length) continue
      const fields = contractChanges(current, next, contractFields)
      if (['done', 'skipped'].includes(current.state)) {
        preserved.push(planTask.id)
        changes.push({ task: planTask.id, applied: false, preserved: true, fields })
        continue
      }
      for (const field of changed) current[field] = next[field]
      if (current.executionAuthorization) {
        current.authorizationHistory ??= []
        current.authorizationHistory.push({ ...current.executionAuthorization, revokedAt: new Date().toISOString(),
          revokeReason: 'sync-plan changed this task contract' })
        delete current.executionAuthorization
      }
      if (current.planningRequired) current.planningRevision = (current.planningRevision ?? 0) + 1
      if (changed.some(field => !['validation', 'validationMode', 'inspectionReason'].includes(field)))
        current.scopeRevision = (current.scopeRevision ?? 0) + 1
      if (changed.some((field) => ['validation', 'validationMode', 'inspectionReason'].includes(field)))
        current.contractRevision = (current.contractRevision ?? 0) + 1
      updated.push(planTask.id)
      changes.push({ task: planTask.id, applied: true, preserved: false, fields })
    }

    const effectiveTasks = derive({ ...state, tasks: persistedTasks })
    const diagnostics = auditSyncPlan({ stateTasks: persistedTasks, planTasks: plan.tasks, added, effectiveTasks })

    const effectivePlan = { ...plan, tasks: Object.values(state.tasks).map(planTaskFromState) }
    validatePlan(effectivePlan, args['allow-overlap'] === true, historicalTasks(state))
    const nextPlan = {
      name: plan.name,
      description: plan.description ?? '',
      phases: plan.phases ?? [],
      maxParallel: plan.maxParallel ?? DEFAULT_MAX_PARALLEL,
      maxExecutors: plan.maxExecutors ?? DEFAULT_MAX_EXECUTORS,
      requireReview: plan.requireReview !== false,
      ...(state.plan.planningMode ? { planningMode: state.plan.planningMode } : {}),
      source,
    }
    const planningChanged = ['name', 'description', 'requireReview'].some(field => state.plan[field] !== nextPlan[field])
    const changedPlanFields = GLOBAL_PLAN_FIELDS.filter(field =>
      JSON.stringify(globalPlanValues(state.plan)[field]) !== JSON.stringify(globalPlanValues(nextPlan)[field]))
    if (state.plan.planningRevision || planningChanged)
      nextPlan.planningRevision = (state.plan.planningRevision ?? 0) + (planningChanged ? 1 : 0)
    const planChanged = JSON.stringify(state.plan) !== JSON.stringify(nextPlan)
    if (!added.length && !updated.length && !metadataUpdated.length && !planChanged) {
      const hasDiagnostics = diagnostics.blockReasonContradictions.length || diagnostics.newLeaves.length ||
        diagnostics.preDiscussionFunctionalContracts.length
      if (hasDiagnostics || changes.length) {
        emit(name, 'plan_sync_audit', null, {
          added: sanitizeTaskIds(added),
          updated: sanitizeTaskIds(updated),
          metadataUpdated: sanitizeTaskIds(metadataUpdated),
          preserved: sanitizeTaskIds(preserved),
          changes: sanitizeChanges(changes),
          diagnostics: sanitizeDiagnostics(diagnostics),
          tasks: Object.keys(state.tasks).length,
        })
        printSyncPlanAudit(changes, diagnostics)
      }
      if (preserved.length)
        log(`[prumo] no state changes; plan differs for preserved tasks: ${preserved.map(displayIdentifier).join(', ')}. Use refresh-contract for an approved validation change; do not fail/retry completed work to refresh a contract.`)
      else log(`[prumo] run "${name}" already matches plan (${Object.keys(state.tasks).length} tasks)`)
      return
    }

    copyFileSync(join(runDir(name), 'state.json'), join(runDir(name), 'state.pre-sync.json'))
    state.plan = nextPlan
    if (state.plan.planningMode === 'phase') {
      state.phaseWorkflows ??= {}
      for (const phase of state.plan.phases) state.phaseWorkflows[phase.id] ??=
        { id: phase.id, title: phase.title, state: 'pending', discussionAttempts: [], planningAttempts: [], planningHistory: [] }
    }

    const historyTaskIds = new Set([...updated, ...added])
    if (changedPlanFields.length)
      for (const task of Object.values(state.tasks))
        if (!['done', 'skipped'].includes(task.state)) historyTaskIds.add(task.id)
    const historyAt = new Date().toISOString()
    for (const id of historyTaskIds) {
      const task = state.tasks[id]
      if (!task || ['done', 'skipped'].includes(task.state)) continue
      const previous = beforeState.tasks[id]
      const taskFields = changes.find(change => change.task === id && change.applied)?.fields.map(change => change.field) ??
        (added.includes(id) ? ['task'] : [])
      task.contractHistory ??= []
      task.contractHistory.push({ at: historyAt, source,
        fields: [...new Set([...taskFields, ...changedPlanFields.map(field => `plan.${field}`)])],
        before: previous ? businessContract(beforeState.plan, previous) : null,
        after: businessContract(state.plan, task) })
      if (task.contractHistory.length > 20) task.contractHistory.splice(0, task.contractHistory.length - 20)
      if (changedPlanFields.length && task.executionAuthorization) {
        task.authorizationHistory ??= []
        task.authorizationHistory.push({ ...task.executionAuthorization, revokedAt: historyAt,
          revokeReason: 'sync-plan changed global plan decisions' })
        delete task.executionAuthorization
      }
    }

    const invalidatedWorkflows = invalidatedSyncWorkflows(name, beforeState, state)
    diagnostics.invalidatedWorkflows = invalidatedWorkflows
    if (state.plan.planningMode === 'phase') {
      const confirmationPhases = new Set()
      for (const item of invalidatedWorkflows) {
        if (item.scope === 'phase') confirmationPhases.add(item.id)
        if (item.scope === 'task') {
          const phaseId = state.tasks[item.task]?.phase ?? beforeState.tasks[item.task]?.phase
          if (phaseId && state.phaseWorkflows?.[phaseId]) confirmationPhases.add(phaseId)
        }
      }
      for (const phaseId of confirmationPhases) {
        const phase = state.phaseWorkflows[phaseId]
        let targets = phaseTargets(state, phaseId)
        if (!targets.length) targets = phaseMembers(state, phaseId).filter(task =>
          usesCurrentPlanning(state, task) && !['done', 'skipped'].includes(task.state))
        if (!targets.length) continue
        phase.contractConfirmationRequired = { at: historyAt, source,
          tasks: targets.map(task => task.id),
          invalidated: invalidatedWorkflows.filter(item => item.id === phaseId || item.task &&
            (state.tasks[item.task]?.phase ?? beforeState.tasks[item.task]?.phase) === phaseId) }
      }
    } else {
      const confirmationTasks = new Set(invalidatedWorkflows
        .filter(item => item.scope === 'task' && item.task)
        .map(item => item.task))
      for (const id of confirmationTasks) {
        const task = state.tasks[id]
        if (!task || ['done', 'skipped'].includes(task.state) || !usesCurrentPlanning(state, task)) continue
        task.contractConfirmationRequired = { at: historyAt, source, task: id,
          invalidated: invalidatedWorkflows.filter(item => item.scope === 'task' && item.task === id) }
      }
    }
    const previouslyEligible = eligibleDiscussionPhases(beforeState)
    saveState(name, state)
    emit(name, 'plan_sync', null, {
      added: sanitizeTaskIds(added),
      updated: sanitizeTaskIds(updated),
      metadataUpdated: sanitizeTaskIds(metadataUpdated),
      preserved: sanitizeTaskIds(preserved),
      changes: sanitizeChanges(changes),
      diagnostics: sanitizeDiagnostics(diagnostics),
      tasks: Object.keys(state.tasks).length,
      revokedAuthorizationTasks: sanitizeTaskIds(Object.keys(state.tasks).filter(id => beforeState.tasks[id]?.executionAuthorization &&
        !state.tasks[id]?.executionAuthorization)),
    })
    printSyncPlanAudit(changes, diagnostics)
    log(
      `[prumo] run "${name}" synced: +${added.length}, updated ${updated.length}, ` +
        `preserved ${preserved.length}, total ${Object.keys(state.tasks).length}`,
    )
    announceNewlyEligiblePhases(name, previouslyEligible, state, 'sync-plan')
    printDispatchSuggestions(state)
  },

  'show-contract'() {
    const id = args._[0] ?? die('show-contract <task> [--diff]')
    const state = loadState(runName())
    const task = getTask(state, id)
    const history = task.contractHistory?.at(-1)
    const drift = contractDrift(state)
    let before, after, fields = [], source = state.plan.source ?? null, changedAt
    let approvedPlan = null
    if (state.plan.source && existsSync(state.plan.source)) {
      try { approvedPlan = JSON.parse(readFileSync(state.plan.source, 'utf8')) } catch { /* exibe o último contrato persistido abaixo */ }
    }
    const liveTaskDrift = drift.tasks.find(item => item.task === id)
    const hasLiveDrift = drift.available && (liveTaskDrift || drift.planFields.length)
    if (hasLiveDrift && approvedPlan) {
      const approvedTask = approvedPlan.tasks?.find(item => item.id === id)
      before = businessContract(state.plan, task)
      after = approvedTask ? businessContract(approvedPlan, approvedTask) : null
      fields = [...(liveTaskDrift?.fields ?? []), ...drift.planFields.map(field => `plan.${field}`)]
    } else if (history) {
      ({ before, after, fields, source, at: changedAt } = history)
    } else {
      before = businessContract(state.plan, task)
      after = before
    }
    const select = value => {
      if (!args.diff || !fields.length || !value) return value
      if (fields.includes('task')) return value
      const planFields = new Set(fields.filter(field => field.startsWith('plan.')).map(field => field.slice(5)))
      const taskFields = new Set(fields.filter(field => !field.startsWith('plan.')))
      return {
        plan: Object.fromEntries(Object.entries(value.plan ?? {}).filter(([field]) => planFields.has(field))),
        task: Object.fromEntries(Object.entries(value.task ?? {}).filter(([field]) => taskFields.has(field))),
      }
    }
    console.log(JSON.stringify({ task: id, source, ...(changedAt ? { changedAt } : {}),
      diff: args.diff === true, fields, before: select(before), after: select(after) }, null, 2))
  },

  'show-check'() {
    const id = args._[0] ?? die('show-check <task> --check <index> --attempt <number>')
    const checkNumber = positiveIndex(args.check, 'show-check --check')
    const attemptNumber = positiveIndex(args.attempt, 'show-check --attempt')
    const task = getTask(loadState(runName()), id)
    const receipt = task.validations?.slice().reverse().find(item =>
      item.attempt === attemptNumber && item.checks?.[checkNumber - 1])
    if (!receipt) die(`${id} has no stored check ${checkNumber} for attempt ${attemptNumber}`)
    const check = receipt.checks[checkNumber - 1]
    const reused = Boolean(check.reusedAt)
    log(`[prumo] ${id} check ${checkNumber}/${receipt.checks.length} from attempt ${attemptNumber} (${receipt.by ?? 'unknown'}; reused ${tr(reused ? 'yes' : 'no')})`)
    console.log(tr('run: {0}', check.run ?? '(not recorded)'))
    console.log(tr('cwd: {0}', check.cwd ?? '(not recorded)'))
    console.log(tr('exit code: {0}', check.exitCode ?? '(not recorded)'))
    if (check.error) console.log(tr('error: {0}', check.error))
    if (check.signal) console.log(tr('signal: {0}', check.signal))
    const stdout = typeof check.stdout === 'string' ? check.stdout : ''
    const stderr = typeof check.stderr === 'string' ? check.stderr : ''
    log('--- stdout ---')
    if (stdout) { process.stdout.write(stdout); if (!stdout.endsWith('\n')) process.stdout.write('\n') }
    else log('(empty)')
    log('--- stderr ---')
    if (stderr) { process.stdout.write(stderr); if (!stderr.endsWith('\n')) process.stdout.write('\n') }
    else log('(empty)')
  },

  runs() {
    if (!existsSync(GRAPH_DIR)) return log('(no runs)')
    for (const d of readdirSync(GRAPH_DIR)) {
      if (d === 'CURRENT') continue
      /* Probed, not caught: `loadState` answers a missing state.json with `die()`, which
         exits the process — so a `try/catch` around it can never run. `plans/` lives in
         this directory and is not a run; so does anything else a person drops here. */
      if (!existsSync(join(GRAPH_DIR, d, 'state.json'))) continue
      const s = loadState(d)
      const p = progress(s)
      const migration = migrationStatus(s)
      log(`${d}  ${p.done}/${p.total} done  (updated ${s.updatedAt})${migration.needed ? '  [migration required]' : ''}`)
    }
  },

  authorize() {
    const name = runName()
    if (args['confirmed-by-user'] !== true)
      die('authorize requires --confirmed-by-user after the user accepts this execution scope')
    const state = loadState(name)
    const scope = args.scope ?? die('authorize needs --scope run|phase:<phase>|tasks:<task,...>')
    const mode = args.mode ?? 'auto'
    if (!['auto', 'manual'].includes(mode)) die('authorize --mode must be auto or manual')
    const channel = args.channel ?? 'cli'
    if (typeof channel !== 'string' || !channel.trim()) die('authorize --channel must be nonempty')
    const taskIds = authorizeScope(state, scope)
    if (!taskIds.length) die(`authorization scope "${scope}" contains no tasks`)
    const authorization = { authorizationId: randomUUID(), scope, taskIds, mode, confirmedByUser: true,
      at: new Date().toISOString(), channel: channel.trim() }
    state.authorizations ??= []
    state.authorizations.push(authorization)
    for (const id of taskIds) state.tasks[id].executionAuthorization = {
      authorizationId: authorization.authorizationId, scope, mode, confirmedByUser: true,
      at: authorization.at, channel: authorization.channel,
    }
    saveState(name, state)
    emit(name, 'run_authorized', null, { scope, mode, confirmedByUser: true, at: authorization.at,
      channel: authorization.channel, tasks: taskIds })
    log('[prumo] ' + tr('authorized {0} task(s) for {1} mode ({2}) via {3}', taskIds.length, mode, scope, authorization.channel))
    printDispatchSuggestions(state)
  },

  status() {
    const name = runName()
    const state = loadState(name)
    printContractDriftWarnings(state)
    printPendingContractConfirmations(state)
    printPlanningRoundProgress(state)
    printQuestionStatus(state)
    const d = derive(state)
    const p = progress(state)
    const actions = suggestedActionsByTask(state)
    log(`run: ${name}  plan: ${state.plan.name}  ${p.done}/${p.total} done`)
    log(`states: ${JSON.stringify(p.by)}`)
    const countGateSkips = field => new Set([
      ...Object.values(state.phaseWorkflows ?? {}).flatMap(phase => phase[field] ?? []),
      ...Object.values(state.tasks).flatMap(task => task[field] ?? []),
    ].map(decision => decision.decisionId).filter(Boolean)).size
    log(`${tr('Discussion skipped')}: ${countGateSkips('discussionSkips')}  ${tr('Planning skipped')}: ${countGateSkips('planningSkips')}`)
    const width = Math.max(...Object.values(d).map((t) => t.id.length))
    const row = (t) => {
      const phasePlanner = t.effective === 'planning' && t.state !== 'planning' ? state.phaseWorkflows?.[t.phase]?.planner : null
      const agent = t.state === 'discussing' ? `  @${tr('orchestrator')} (${tr('discussing')})` :
        t.state === 'planning' ? `  @${t.planner} (${tr('planning')})` :
        phasePlanner ? `  @${phasePlanner} (${tr('planning')})` :
        t.state === 'reviewing' ? `  @${t.reviewer} (review)` : t.agent ? `  @${t.agent}` : ''
      const attempts = t.attempts.length > 1 ? `  (attempt ${t.attempts.length})` : ''
      const wait = t.effective === 'waiting' ? `  ← ${(t.planningBlockedBy ?? t.blockedBy).join(',')}` : ''
      const manual = t.manualInspectionPending ? `  [${tr('Manual inspection pending')}]` : ''
      const digest = t.taskPlan?.digest ?? t.attempts.at(-1)?.planDigest
      const plan = digest ? `  ${tr('Plan {0}', digest.slice(0, 4))}` : ''
      const auth = t.executionAuthorization ? `  [${tr('authorized')} ${t.executionAuthorization.mode}]` :
        `  [${tr('authorization required')}]`
      const action = actions.get(t.id) ?? ''
      console.log(`  ${t.id.padEnd(width)}  ${tr(t.effective).padEnd(8)}${agent}${attempts}${wait}${manual}${plan}${auth}${action ? `  → ${action}` : ''}`)
    }
    for (const phase of state.plan.phases) {
      console.log(`\n${phase.id} — ${phase.title}`)
      Object.values(d).filter((t) => t.phase === phase.id).forEach(row)
    }
    /* phases is OPTIONAL in a plan — tasks with no phase (or one no phase entry names)
       must still be listed, or status silently hides part of the run. */
    const known = new Set(state.plan.phases.map((p) => p.id))
    const orphans = Object.values(d).filter((t) => !known.has(t.phase))
    if (orphans.length) {
      log(`\n(no phase)`)
      orphans.forEach(row)
    }
    log('[prumo] ' + tr('{0} execution slot(s) available', executionSlots(state)))
  },

  ready() {
    const state = loadState(runName())
    printContractDriftWarnings(state)
    printPendingContractConfirmations(state)
    printPlanningRoundProgress(state)
    printQuestionStatus(state)
    const d = derive(state)
    const occ = occupancy(state)
    const list = Object.values(d).filter((t) => ['ready_for_discussion', 'ready_to_plan', 'ready'].includes(t.effective))
    const slots = executionSlots(state)
    const actions = suggestedActionsByTask(state)
    for (const t of list) {
      const auth = t.executionAuthorization ? tr('authorized {0}', t.executionAuthorization.mode) : tr('authorization required')
      const action = actions.get(t.id) ?? ''
      console.log(`${t.id}  ${t.title}  [${tr(t.effective)} · ${auth}]${action ? `  → ${action}` : ''}`)
    }
    log(
      `\n[prumo] ${occ.executors.length}/${occ.maxExec} executors, ${occ.reviewers.length} in review ` +
        `(cap ${occ.cap}) — dispatch at most ${slots} now`,
    )
    log(`[prumo] ${occ.planners.length} in planning — ${Math.max(0, occ.cap - occ.busy.length)} agent slots available for planning`)
    if (occ.reviewers.length) log(`[prumo] awaiting review: ${occ.reviewers.map((t) => `${t.id} @${t.reviewer}`).join(', ')}`)
  },

  graph() {
    const state = loadState(runName())
    console.log(JSON.stringify({ ...state, derived: derive(state), progress: progress(state) }, null, 2))
  },

  'begin-phase-discussion'() {
    const name = runName()
    const phaseId = args._[0] ?? die('begin-phase-discussion <phase> [--adopt-legacy]')
    const state = loadState(name)
    if (!(state.plan.phases ?? []).some(phase => phase.id === phaseId)) die(`unknown phase "${phaseId}"`)
    assertPhasePlanningOrder(state, phaseId)
    printQuestionsForTarget(state, null, phaseId)
    const members = phaseMembers(state, phaseId)
    const needsLegacyAdoption = state.plan.planningMode !== 'phase' ||
      (state.legacyPhaseAdoption && !state.phaseWorkflows?.[phaseId]?.adoptedLegacy)
    if (needsLegacyAdoption) {
      if (args['adopt-legacy'] !== true)
        die(state.plan.planningMode === 'phase' ? `${phaseId} is not adopted yet; use --adopt-legacy to opt in this phase` :
          'legacy run uses task planning; use --adopt-legacy to opt in this phase')
      const legacyMembers = members.filter(task => !['done', 'skipped'].includes(task.state))
      const openTaskFlows = Object.values(state.tasks).filter(task =>
        task.discussionAttempts?.some(round => !round.endedAt) || task.planningAttempts?.some(round => !round.endedAt))
      if (openTaskFlows.length)
        die('phase legacy adoption is unsafe with open task discussion or planning for: ' + openTaskFlows.map(task => task.id).join(', '))
      const unsafe = legacyMembers.filter(task =>
        (!['pending', 'failed'].includes(task.state) || task.attempts?.length ||
          task.discussionAttempts?.some(round => !round.endedAt) || task.planningAttempts?.some(round => !round.endedAt)))
      if (unsafe.length) die('phase legacy adoption is unsafe for: ' + unsafe.map(task => task.id).join(', '))
      if (state.plan.planningMode !== 'phase') {
        state.plan.planningMode = 'phase'
        state.legacyPhaseAdoption = true
        state.phaseWorkflows = Object.fromEntries((state.plan.phases ?? []).map(phase => [phase.id,
          { id: phase.id, title: phase.title, state: 'pending', discussionAttempts: [], planningAttempts: [], planningHistory: [] }]))
      }
      for (const task of legacyMembers) {
        task.discussionRequired = true
        task.discoveryRequired = true
        task.planningRequired = true
        task.planningHistory ??= []
      }
      state.phaseWorkflows[phaseId].adoptedLegacy = true
    }
    const phase = getPhase(state, phaseId)
    if (!phaseMembers(state, phaseId).length) die(`phase "${phaseId}" has no tasks`)
    const discussion = phase.discussionAttempts.at(-1)
    const discussionTargets = discussion?.targets?.map(id => state.tasks[id]).filter(Boolean) ?? []
    const currentDiscussionTargets = phaseDiscussionTargets(state, phaseId, discussion)
    const discussionTargetIds = [...(discussion?.targets ?? [])].sort()
    const currentDiscussionTargetIds = currentDiscussionTargets.map(task => task.id).sort()
    const staleDiscussion = phase.state === 'discussing' && discussion && !discussion.endedAt &&
      (discussionTargets.length !== discussion.targets.length ||
        JSON.stringify(discussionTargetIds) !== JSON.stringify(currentDiscussionTargetIds) ||
        discussion.context !== phaseContext(state, phaseId, discussionTargets))
    if (phase.state === 'discussing' && discussion && !discussion.endedAt && !staleDiscussion)
      die(`${phaseId} already has an open discussion round`)
    const superseded = []
    if (staleDiscussion) {
      const cause = staleReason(name, discussion, phaseContextSnapshot(state, currentDiscussionTargets),
        phaseContext(state, phaseId, currentDiscussionTargets))
      Object.assign(discussion, { endedAt: new Date().toISOString(), result: 'superseded', cause })
      superseded.push({ workflow: 'discussion', roundId: discussion.roundId, cause })
    }
    const planning = phase.planningAttempts.at(-1)
    const stalePlanning = phase.state === 'planning' && planning && !currentPhasePlanning(state, phase, planning)
    if (phase.state === 'planning' && !stalePlanning) die(`${phaseId} is currently planning`)
    if (stalePlanning) {
      const planningTargets = (planning.contextTargets ?? planning.targets ?? []).map(id => state.tasks[id]).filter(Boolean)
      const cause = staleReason(name, planning, phaseContextSnapshot(state, planningTargets),
        phaseContext(state, phaseId, planningTargets))
      Object.assign(planning, { endedAt: new Date().toISOString(), result: 'superseded', cause })
      superseded.push({ workflow: 'planning', round: planning.n, cause })
      phase.planner = null
    }
    let targets = phaseTargets(state, phaseId)
    const targetsFallback = targets.length === 0
    if (targetsFallback) targets = phaseMembers(state, phaseId).filter(task =>
      usesCurrentPlanning(state, task) && !['done', 'skipped'].includes(task.state))
    if (!targets.length) die(`${phaseId} has no nonterminal tasks to discuss`)
    const requiresContractConfirmation = Boolean(phase.contractConfirmationRequired)
    const round = { roundId: randomUUID(), nonce: randomUUID(), startedAt: new Date().toISOString(),
      targets: targets.map(task => task.id), context: phaseContext(state, phaseId, targets),
      contextSnapshot: phaseContextSnapshot(state, targets),
      ...(targetsFallback ? { targetsFallback: true } : {}),
      ...(requiresContractConfirmation ? { requiresContractConfirmation: true,
        confirmsContract: phaseContractDigests(state, targets) } : {}) }
    phase.discussionAttempts.push(round)
    phase.state = 'discussing'
    saveState(name, state)
    emit(name, 'phase_discussion', null, { phase: phaseId, roundId: round.roundId, members: round.targets,
      ...(superseded.length ? { superseded } : {}),
      ...(requiresContractConfirmation ? { requiresContractConfirmation: true,
        confirmsContract: round.confirmsContract } : {}),
      ...(args['adopt-legacy'] === true ? { adoptedLegacy: true } : {}) })
    log(`[prumo] ${phaseId} discussing ${round.targets.length} task(s) (round ${round.roundId}, nonce ${round.nonce})`)
    if (requiresContractConfirmation) {
      log('[prumo] ' + tr('contract confirmation required: inspect each task with show-contract, then ask the user to confirm the displayed contracts'))
      log('[prumo] ' + tr('include this exact current task digest list in an answered discovery question:'))
      log(JSON.stringify({ confirmsContract: round.confirmsContract }, null, 2))
    }
    log('[prumo] discussion guard: inspect local context and resolve decisions only; planner researches how, executor delivers every task')
  },

  'skip-phase-discussion'() {
    const name = runName()
    const phaseId = args._[0] ?? die('skip-phase-discussion <phase> --reason <text> --confirmed-by-user')
    const state = loadState(name)
    if (state.plan.planningMode !== 'phase') die('this run uses task planning; use skip-discussion')
    assertPhasePlanningOrder(state, phaseId)
    const phase = getPhase(state, phaseId)
    if (phase.contractConfirmationRequired)
      die(`${phaseId} requires a fresh answered contract confirmation; begin-phase-discussion and ask the user before skipping discussion`)
    if (['discussing', 'planning'].includes(phase.state))
      die(`${phaseId} has active ${phase.state}; finish or block it before changing the gate decision`)
    const targets = phaseTargets(state, phaseId)
    if (!targets.length) die(`${phaseId} has no task requiring a discussion decision`)
    const decision = { ...explicitSkipDecision('skip-phase-discussion'), targets: targets.map(task => task.id),
      context: phaseContext(state, phaseId, targets), contextSnapshot: phaseContextSnapshot(state, targets) }
    phase.discussionSkips ??= []
    phase.discussionSkips.push(decision)
    phase.state = 'pending'
    saveState(name, state)
    emit(name, 'phase_discussion_skipped', null, { phase: phaseId, decisionId: decision.decisionId,
      reason: decision.reason, confirmedByUser: true, members: decision.targets })
    log(`[prumo] ${phaseId} discussion skipped by explicit user choice; ready for the planning decision (${targets.length} task(s))`)
  },

  'finish-phase-discussion'() {
    const name = runName()
    const phaseId = args._[0] ?? die('finish-phase-discussion <phase> --context <discovery.json>')
    if (typeof args.context !== 'string' || !args.context.trim()) die('finish-phase-discussion needs --context <discovery.json>')
    const state = loadState(name), phase = getPhase(state, phaseId), round = phase.discussionAttempts.at(-1)
    if (phase.state !== 'discussing' || !round || round.endedAt) die(`${phaseId} has no open discussion round`)
    const currentTargets = phaseDiscussionTargets(state, phaseId, round)
    const currentContext = phaseContext(state, phaseId, currentTargets)
    const targetCoverageCurrent = JSON.stringify([...round.targets].sort()) ===
      JSON.stringify(currentTargets.map(task => task.id).sort())
    if (round.context !== currentContext || !targetCoverageCurrent)
      die(tr('{0} discussion is stale: {1} — begin a fresh phase discussion', phaseId,
        staleReason(name, round, phaseContextSnapshot(state, currentTargets), currentContext)))
    let discovery, digest
    try {
      discovery = JSON.parse(readFileSync(resolve(args.context), 'utf8'))
      assertDiscovery(discovery)
      assertDiscussionBoundary(discovery, round.targets, { acceptPremature: args['accept-premature-work'] === true })
      if (discovery.roundId !== round.roundId || discovery.nonce !== round.nonce)
        throw new Error('discovery roundId and nonce must match the current phase discussion')
      if (!discovery.questions.some(question => question.roundId === round.roundId))
        throw new Error('discovery needs a fresh answered question bound to the current phase discussion roundId')
      if (round.requiresContractConfirmation) {
        const expected = round.confirmsContract ?? []
        const confirmed = discovery.questions.some(question => {
          if (question.roundId !== round.roundId || !Array.isArray(question.confirmsContract)) return false
          const actual = question.confirmsContract.map(item => ({ task: item?.task, digest: item?.digest }))
            .sort((left, right) => String(left.task).localeCompare(String(right.task)))
          return JSON.stringify(actual) === JSON.stringify(expected)
        })
        if (!confirmed)
          throw new Error(tr('discovery needs an answered question with confirmsContract matching every current task and digest'))
      }
      round.questionRefs = validateQuestionResolutions(state, discovery.decisions)
      digest = discoveryDigest(discovery)
    } catch (error) { die(error.message) }
    const fields = ['research', 'questions', 'coverage', 'decisions', 'deferred', 'executionBoundary', 'closure', 'roundId', 'nonce']
    phase.discovery = { ...Object.fromEntries(fields.map(field => [field, discovery[field]])),
      recordedAt: new Date().toISOString(), context: round.context, digest }
    Object.assign(round, { endedAt: new Date().toISOString(), result: 'discussed', discoveryDigest: digest,
      discovery: phase.discovery })
    if (round.requiresContractConfirmation) {
      phase.contractConfirmations ??= []
      phase.contractConfirmations.push({ roundId: round.roundId, at: new Date().toISOString(),
        contracts: round.confirmsContract, discoveryDigest: digest })
      phase.contractConfirmationRequired = null
    }
    phase.state = 'pending'
    recordQuestionResolutions(state, round.questionRefs ?? [], discovery.decisions, { phase: phaseId })
    saveState(name, state)
    emit(name, 'phase_discussed', null, { phase: phaseId, roundId: round.roundId, questions: discovery.questions.length,
      members: round.targets, prematureTaskWork: discovery.executionBoundary.prematureTaskWork.length })
    log(`[prumo] ${phaseId} ready to plan (${round.targets.length} task(s))`)
  },

  'plan-phase'() {
    const name = runName()
    const phaseId = args._[0] ?? die('plan-phase <phase> --agent <name>')
    const agent = args.agent ?? die('plan-phase needs --agent <name>')
    const state = loadState(name), phase = getPhase(state, phaseId)
    assertPhasePlanningOrder(state, phaseId)
    printQuestionsForTarget(state, null, phaseId)
    const discussion = currentPhaseDiscussionDecision(state, phase)
    if (!discussion) die(`${phaseId} needs a completed current phase discussion or an explicit user-confirmed discussion skip`)
    const targets = discussion.targets.map(id => getTask(state, id)).filter(task => !hasCurrentTaskPlan(state, task))
    if (!targets.length) die(`${phaseId} has no task requiring a phase plan`)
    const context = phaseContext(state, phaseId, discussion.targets.map(id => getTask(state, id)))
    const open = phase.planningAttempts.at(-1)
    if (phase.state === 'planning' && !open?.endedAt && open.context === context && open.discussionDigest === discussion.digest) {
      if (agent !== phase.planner) die(`${phaseId} already has planner "${phase.planner}" for the current round`)
      log(`[prumo] ${tr('{0} already in planning with the same discovery; no new round recorded', phaseId)}`)
      logPhasePlanningInputs(phaseId, open)
      return
    }
    if (phase.state === 'planning') {
      const reason = staleReason(name, open, phaseContextSnapshot(state,
        (open?.contextTargets ?? open?.targets ?? []).map(id => state.tasks[id]).filter(Boolean)), context)
      die(tr('{0} has a stale open planning round: {1} — begin a fresh phase discussion', phaseId, reason))
    }
    const occ = occupancy(state)
    if (occ.busy.length >= occ.cap) die(`${occ.busy.length} agents busy (cap ${occ.cap})`)
    const busy = agentBusy(state, agent)
    if (busy) die(`agent "${agent}" is already on ${busy.id} — one agent per task or phase`)
    const round = { n: phase.planningAttempts.length + 1, agent, startedAt: new Date().toISOString(), context,
      contextSnapshot: phaseContextSnapshot(state, discussion.targets.map(id => getTask(state, id))),
      discussionDecision: discussion.kind, discussionDigest: discussion.digest, discussionRoundId: discussion.id,
      ...(discussion.kind === 'discussed' ? { discoveryDigest: discussion.digest } : {}),
      targets: targets.map(task => task.id), contextTargets: discussion.targets,
      requiredInputs: Object.fromEntries(targets.map(task => [task.id, phaseRequiredInputs(state, task)])) }
    phase.planner = agent
    phase.planningAttempts.push(round)
    phase.state = 'planning'
    saveState(name, state)
    emit(name, 'phase_planning', null, { phase: phaseId, planner: agent, round: round.n, members: round.targets })
    log(`[prumo] ${phaseId} in planning (planner ${agent}, ${round.targets.length} task(s))`)
    logPhasePlanningInputs(phaseId, round)
    log('[prumo] planner guard: read-only research may determine how to execute; task results and acceptance evidence belong to the executor')
  },

  'skip-phase-planning'() {
    const name = runName()
    const phaseId = args._[0] ?? die('skip-phase-planning <phase> --reason <text> --confirmed-by-user')
    const state = loadState(name)
    if (state.plan.planningMode !== 'phase') die('this run uses task planning; use skip-planning')
    assertPhasePlanningOrder(state, phaseId)
    const phase = getPhase(state, phaseId)
    if (phase.contractConfirmationRequired)
      die(`${phaseId} requires a fresh answered contract confirmation; finish the discussion before skipping planning`)
    if (['discussing', 'planning'].includes(phase.state))
      die(`${phaseId} has active ${phase.state}; finish or block it before changing the gate decision`)
    const discussion = currentPhaseDiscussionDecision(state, phase)
    if (!discussion) die(`${phaseId} needs a completed current phase discussion or an explicit user-confirmed discussion skip`)
    const targets = discussion.targets.map(id => getTask(state, id)).filter(task => !hasCurrentTaskPlan(state, task))
    if (!targets.length) die(`${phaseId} has no task requiring a planning decision`)
    const decision = { ...explicitSkipDecision('skip-phase-planning'), phaseId,
      targets: targets.map(task => task.id), context: phaseContext(state, phaseId, targets),
      contextSnapshot: phaseContextSnapshot(state, targets),
      discussionDecision: discussion.kind, discussionDecisionId: discussion.id }
    phase.planningSkips ??= []
    phase.planningSkips.push(decision)
    for (const task of targets) {
      task.planningSkips ??= []
      task.planningSkips.push({ ...decision, scope: phasePlanningContext(state, task), task: task.id,
        context: planningContext(state, task), contextSnapshot: taskContextSnapshot(state, task) })
      delete task.retryPlan
    }
    phase.state = 'planned'
    saveState(name, state)
    emit(name, 'phase_planning_skipped', null, { phase: phaseId, decisionId: decision.decisionId,
      reason: decision.reason, confirmedByUser: true, members: decision.targets })
    log(`[prumo] ${phaseId} planning skipped by explicit user choice; ${targets.length} task(s) ready when dependencies allow`)
  },

  'finish-phase-planning'() {
    const name = runName()
    const phaseId = args._[0] ?? die('finish-phase-planning <phase> --plan-dir <directory>')
    if (typeof args['plan-dir'] !== 'string' || !args['plan-dir'].trim())
      die('finish-phase-planning needs --plan-dir <directory>')
    const state = loadState(name), phase = getPhase(state, phaseId), round = phase.planningAttempts.at(-1)
    if (phase.state !== 'planning' || !round || round.endedAt || round.agent !== phase.planner)
      die(`${phaseId} has no open planning round and recorded planner`)
    if (!currentPhasePlanning(state, phase, round)) {
      const targets = (round.contextTargets ?? round.targets ?? []).map(id => state.tasks[id]).filter(Boolean)
      const currentContext = phaseContext(state, phaseId, targets)
      die(tr('{0} planning is stale: {1} — discuss and plan the current phase contract', phaseId,
        staleReason(name, round, phaseContextSnapshot(state, targets), currentContext)))
    }
    const tasks = round.targets.map(id => getTask(state, id))
    const binding = { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n }
    const plans = [], errors = [], plannedQuestionRefs = new Set(), planDir = resolve(args['plan-dir'])
    for (const task of tasks) {
      const filename = `task-plan-${task.id}.json`
      try {
        safeId(task.id)
        const path = resolve(planDir, filename)
        if (dirname(path) !== planDir) throw new Error(tr('task plan artifact path escapes --plan-dir'))
        const plan = readPlanningArtifact(path)
        assertPhaseTaskPlan(state, task, plan, binding, round.requiredInputs?.[task.id] ?? [])
        validateQuestionDeadlines(state, task.id, plan.openQuestions)
        const questionRefs = validateQuestionResolutions(state, plan.decisions)
        for (const ref of questionRefs) {
          if (plannedQuestionRefs.has(ref))
            throw new Error(tr('phase planning cannot resolve the same open question more than once'))
          plannedQuestionRefs.add(ref)
        }
        plans.push([task, plan, questionRefs])
      } catch (error) { errors.push(planningArtifactError(filename, error)) }
    }
    if (errors.length) die(tr('finish-phase-planning {0} rejected {1} task-plan artifact(s); nothing was recorded:\n{2}',
      phaseId, errors.length, errors.join('\n')))
    for (const [task, plan] of plans) warnTaskPlan(task, plan)
    const completedAt = new Date().toISOString()
    const allResolutions = []
    for (const [task, plan, questionRefs] of plans) {
      const fields = ['summary', 'research', 'decisions', 'steps', 'verification', 'openQuestions', 'phaseBinding', 'unresolvedInputs', 'writes']
      const artifact = Object.fromEntries(fields.map(field => [field, plan[field]]))
      artifact.openQuestions = annotatePlanQuestions(task, artifact.openQuestions, round.startedAt)
      allResolutions.push(...questionRefs.map(questionRef => ({
        task: task.id, questionRef, decisions: plan.decisions,
      })))
      task.planner = phase.planner
      task.taskPlan = { ...artifact, digest: taskPlanDigest(artifact), planner: phase.planner, startedAt: round.startedAt, completedAt,
        context: round.context, scope: phasePlanningContext(state, task), phaseId,
        phaseDecision: round.discussionDecision ?? 'discussed', phaseDecisionDigest: round.discussionDigest ?? round.discoveryDigest,
        ...(round.discoveryDigest ? { phaseDiscoveryDigest: round.discoveryDigest } : {}), attempt: task.attempts.length + 1 }
      task.planningHistory ??= []
      task.planningHistory.push(task.taskPlan)
      delete task.phasePlanDefect
      delete task.retryPlan
    }
    Object.assign(round, { endedAt: completedAt, result: 'planned', artifactCount: plans.length })
    phase.planningHistory.push({ round: round.n, planner: phase.planner, completedAt, members: round.targets,
      discoveryDigest: round.discoveryDigest })
    phase.state = 'planned'
    for (const item of allResolutions)
      recordQuestionResolutions(state, [item.questionRef], item.decisions, { task: item.task, phase: phaseId })
    saveState(name, state)
    emit(name, 'phase_planned', null, { phase: phaseId, planner: phase.planner, round: round.n, members: round.targets })
    log(`[prumo] ${phaseId} planned atomically (${round.targets.length} task artifact(s))`)
  },

  'begin-discussion'() {
    const name = runName()
    const id = args._[0] ?? die('begin-discussion <task>')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase') die('this run uses phase planning; use begin-phase-discussion')
    const t = getTask(state, id)
    printQuestionsForTarget(state, id, t.phase)
    const blockedBy = t.deps.filter(dep => !['done', 'skipped'].includes(state.tasks[dep]?.state))
    if (blockedBy.length) die(id + ' still waiting on: ' + blockedBy.join(', '))
    const adoptLegacy = !t.discussionRequired && args['adopt-legacy'] === true
    if (!t.discussionRequired && !adoptLegacy)
      die(id + ' is a legacy task without the discussion gate (use --adopt-legacy to opt in this task)')
    if (adoptLegacy) {
      const openDiscussion = t.discussionAttempts?.at(-1)
      const openPlanning = t.planningAttempts?.at(-1)
      if (!['pending', 'failed'].includes(t.state))
        die(id + ' can adopt legacy discussion only while pending or failed')
      if ((t.attempts?.length ?? 0) > 0)
        die(id + ' cannot adopt legacy discussion after execution started')
      if ((openDiscussion && !openDiscussion.endedAt) || (openPlanning && !openPlanning.endedAt))
        die(id + ' cannot adopt legacy discussion with an open discussion or planning round')
    }
    const stalePlanning = t.state === 'planning' && t.planningAttempts?.at(-1)?.context !== planningContext(state, t)
    const pausedExecution = t.planningRequired && t.state === 'blocked' && ['running', 'reviewing'].includes(t.stateBeforeBlock)
    if (!['pending', 'discussing'].includes(t.state) && !stalePlanning && !pausedExecution &&
        !(adoptLegacy && t.state === 'failed'))
      die(id + ' must be ready for discussion or require fresh planning')
    const open = t.discussionAttempts?.at(-1)
    const staleDiscussion = t.state === 'discussing' && open && !open.endedAt &&
      (open.context !== planningContext(state, t) ||
        open.attempt !== t.attempts.length + (t.planningReturn ? 0 : 1))
    if (t.state === 'discussing' && open && !open.endedAt && !staleDiscussion)
      die(id + ' already has an open discussion round')
    const superseded = []
    if (staleDiscussion) {
      const cause = staleReason(name, open, taskContextSnapshot(state, t), planningContext(state, t))
      closeDiscussion(t, 'superseded', cause)
      superseded.push({ workflow: 'discussion', roundId: open.roundId, cause })
    }
    if (stalePlanning) {
      const staleRound = t.planningAttempts.at(-1)
      const cause = staleReason(name, staleRound, taskContextSnapshot(state, t), planningContext(state, t))
      closePlanning(t, 'superseded', cause)
      superseded.push({ workflow: 'planning', round: staleRound.n, cause })
    }
    if (pausedExecution) t.planningReturn = { stateBeforeBlock: t.stateBeforeBlock, blockReason: t.blockReason }
    const requiresContractConfirmation = Boolean(t.contractConfirmationRequired)
    const round = {
      roundId: randomUUID(), nonce: randomUUID(), startedAt: new Date().toISOString(),
      context: planningContext(state, t), attempt: t.attempts.length + (t.planningReturn ? 0 : 1),
      contextSnapshot: taskContextSnapshot(state, t),
      ...(requiresContractConfirmation ? { requiresContractConfirmation: true,
        confirmsContract: [{ task: id, digest: phasePlanningContext(state, t) }] } : {}),
    }
    if (adoptLegacy) {
      t.discussionRequired = true
      t.discoveryRequired = true
      t.planningRequired = true
      t.planningAttempts ??= []
      t.planningHistory ??= []
    }
    t.discussionAttempts ??= []
    t.discussionAttempts.push(round)
    t.state = 'discussing'
    saveState(name, state)
    emit(name, 'task_discussion', id, { roundId: round.roundId, attempt: round.attempt,
      ...(superseded.length ? { superseded } : {}),
      ...(requiresContractConfirmation ? { requiresContractConfirmation: true,
        confirmsContract: round.confirmsContract } : {}),
      ...(adoptLegacy ? { adoptedLegacy: true } : {}) })
    log(`[prumo] ${id} discussing (round ${round.roundId}, nonce ${round.nonce})`)
    if (requiresContractConfirmation) {
      log('[prumo] ' + tr('contract confirmation required: inspect each task with show-contract, then ask the user to confirm the displayed contracts'))
      log('[prumo] ' + tr('include this exact current task digest list in an answered discovery question:'))
      log(JSON.stringify({ confirmsContract: round.confirmsContract }, null, 2))
    }
    log('[prumo] discussion guard: inspect local context and resolve decisions only; planner researches how, executor delivers the task')
  },

  'skip-discussion'() {
    const name = runName()
    const id = args._[0] ?? die('skip-discussion <task> --reason <text> --confirmed-by-user')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase') die('this run uses phase planning; use skip-phase-discussion')
    const task = getTask(state, id)
    const blockedBy = task.deps.filter(dep => !['done', 'skipped'].includes(state.tasks[dep]?.state))
    if (blockedBy.length) die(id + ' still waiting on: ' + blockedBy.join(', '))
    if (task.contractConfirmationRequired)
      die(tr('{0} requires a fresh answered contract confirmation; begin-discussion and ask the user before skipping discussion', id))
    if (!['pending', 'failed'].includes(task.state)) die(`${id} must be pending or failed to skip discussion`)
    if (!usesCurrentPlanning(state, task)) die(`${id} is a legacy task without current planning gates`)
    const decision = { ...explicitSkipDecision('skip-discussion'), scope: phasePlanningContext(state, task),
      context: planningContext(state, task), contextSnapshot: taskContextSnapshot(state, task) }
    task.discussionSkips ??= []
    task.discussionSkips.push(decision)
    saveState(name, state)
    emit(name, 'task_discussion_skipped', id, { decisionId: decision.decisionId,
      reason: decision.reason, confirmedByUser: true })
    log(`[prumo] ${id} discussion skipped by explicit user choice; ready for the planning decision`)
  },

  'finish-discussion'() {
    const name = runName()
    const id = args._[0] ?? die('finish-discussion <task> --context <discovery.json>')
    if (typeof args.context !== 'string' || !args.context.trim())
      die('finish-discussion needs --context <discovery.json>')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase') die('this run uses phase planning; use finish-phase-discussion')
    const t = getTask(state, id)
    const round = t.discussionAttempts?.at(-1)
    if (t.state !== 'discussing' || !round || round.endedAt)
      die(id + ' has no open discussion round')
    const currentContext = planningContext(state, t)
    if (round.context !== currentContext || round.attempt !== t.attempts.length + (t.planningReturn ? 0 : 1))
      die(tr('{0} discussion is stale: {1} — begin a fresh discussion', id,
        staleReason(name, round, taskContextSnapshot(state, t), currentContext)))
    let discovery, digest
    try {
      discovery = JSON.parse(readFileSync(resolve(args.context), 'utf8'))
      assertDiscovery(discovery)
      assertDiscussionBoundary(discovery, [id], { acceptPremature: args['accept-premature-work'] === true })
      if (discovery.roundId !== round.roundId || discovery.nonce !== round.nonce)
        throw new Error('discovery roundId and nonce must match the current discussion')
      if (!discovery.questions.some(question => question.roundId === round.roundId))
        throw new Error('discovery needs a fresh answered question bound to the current discussion roundId')
      if (round.requiresContractConfirmation) {
        const expected = round.confirmsContract ?? []
        const confirmed = discovery.questions.some(question => {
          if (question.roundId !== round.roundId || !Array.isArray(question.confirmsContract)) return false
          const actual = question.confirmsContract.map(item => ({ task: item?.task, digest: item?.digest }))
          return JSON.stringify(actual) === JSON.stringify(expected)
        })
        if (!confirmed)
          throw new Error(tr('discovery needs an answered question with confirmsContract matching every current task and digest'))
      }
      round.questionRefs = validateQuestionResolutions(state, discovery.decisions)
      digest = discoveryDigest(discovery)
    } catch (error) { die(error.message) }
    const fields = ['research', 'questions', 'coverage', 'decisions', 'deferred', 'executionBoundary', 'closure', 'roundId', 'nonce']
    t.discovery = { ...Object.fromEntries(fields.map(field => [field, discovery[field]])),
      recordedAt: new Date().toISOString(), context: round.context, attempt: round.attempt, digest }
    Object.assign(round, { endedAt: new Date().toISOString(), result: 'discussed', discoveryDigest: digest })
    if (round.requiresContractConfirmation) {
      t.contractConfirmations ??= []
      t.contractConfirmations.push({ roundId: round.roundId, at: new Date().toISOString(),
        contracts: round.confirmsContract, discoveryDigest: digest })
      t.contractConfirmationRequired = null
    }
    t.state = t.planningReturn ? 'blocked' : 'pending'
    recordQuestionResolutions(state, round.questionRefs ?? [], discovery.decisions, { task: id })
    saveState(name, state)
    emit(name, 'task_discussed', id, { roundId: round.roundId, questions: discovery.questions.length, state: t.state,
      prematureTaskWork: discovery.executionBoundary.prematureTaskWork.length })
    log(`[prumo] ${id} ready to plan (discussion ${round.roundId} closed)`)
  },

  'plan-task'() {
    const name = runName()
    const id = args._[0] ?? die('plan-task <task> --agent <name> --context <discovery.json>')
    const agent = args.agent ?? die('plan-task needs --agent <name>')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase') die('this run uses phase planning; use plan-phase')
    const t = getTask(state, id)
    printQuestionsForTarget(state, id, t.phase)
    const pausedExecution = t.planningRequired && t.state === 'blocked' && ['running', 'reviewing'].includes(t.stateBeforeBlock)
    const stale = t.state === 'planning' && t.planningAttempts?.at(-1)?.context !== planningContext(state, t)
    let discovery, digest
    if (t.discussionRequired) {
      const discussion = currentTaskDiscussionDecision(state, t)
      if (!discussion)
        die(id + ' needs a completed current discussion or an explicit user-confirmed discussion skip before the planner is dispatched')
      if (discussion.kind === 'discussed') discovery = t.discovery
      digest = discussion.digest
    } else if (t.discoveryRequired) {
      if (typeof args.context !== 'string' || !args.context.trim())
        die('plan-task needs --context <discovery.json> before the planner is dispatched')
      try {
        discovery = JSON.parse(readFileSync(resolve(args.context), 'utf8'))
        assertDiscovery(discovery)
        digest = discoveryDigest(discovery)
      } catch (error) { die(error.message) }
    }
    const roundDigest = t.planningAttempts?.at(-1)?.discoveryDigest
    const skippedDiscussion = currentTaskDiscussionSkip(state, t)
    const storedDiscoveryCurrent = digest && (skippedDiscussion?.digest === digest ||
      (digest === t.discovery?.digest && digest === discoveryDigest(t.discovery)))
    const changedDiscovery = t.state === 'planning' && digest && (!storedDiscoveryCurrent || digest !== roundDigest)
    if (t.state === 'planning' && !stale && storedDiscoveryCurrent && digest === roundDigest) {
      log(`[prumo] ${id} already in planning with the same discovery; no new round recorded`)
      return
    }
    if (t.state !== 'pending' && !stale && !pausedExecution && !changedDiscovery)
      die(id + ' must be pending, have stale planning, or have paused execution before plan-task')
    if (pausedExecution) {
      const attempt = t.attempts.at(-1)
      if (!attempt || attempt.endedAt || attempt.result || !t.agent || attempt.agent !== t.agent)
        die('cannot replan without an open attempt and its original executor')
    }
    try { validationContract(t) } catch (error) { die(error.message) }
    assertAvailable(state, t, 'planning', agent)
    if (pausedExecution) t.planningReturn = { stateBeforeBlock: t.stateBeforeBlock, blockReason: t.blockReason }
    if (stale || changedDiscovery) {
      const oldRound = t.planningAttempts?.at(-1)
      const cause = staleReason(name, oldRound, taskContextSnapshot(state, t), planningContext(state, t))
      closePlanning(t, 'superseded', cause)
    }
    if (discovery && !t.discussionRequired) {
      assertDiscussionBoundary(discovery, [id], { acceptPremature: args['accept-premature-work'] === true })
      const fields = ['research', 'questions', 'coverage', 'decisions', 'deferred', 'executionBoundary', 'closure']
      t.discovery = { ...Object.fromEntries(fields.map(field => [field, discovery[field]])),
        recordedAt: new Date().toISOString(), context: planningContext(state, t),
        attempt: t.attempts.length + (t.planningReturn ? 0 : 1), digest }
    }
    beginPlanning(state, t, agent, planningContext(state, t), digest)
    saveState(name, state)
    emit(name, 'task_planning', id, { planner: agent, round: t.planningAttempts.length,
      ...(discovery ? { discoveryQuestions: discovery.questions.length } : {}) })
    log(`[prumo] ${id} in planning (planner ${agent}, round ${t.planningAttempts.length})`)
    log('[prumo] planner guard: read-only research may determine how to execute; task results and acceptance evidence belong to the executor')
  },

  'skip-planning'() {
    const name = runName()
    const id = args._[0] ?? die('skip-planning <task> --reason <text> --confirmed-by-user')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase') die('this run uses phase planning; use skip-phase-planning')
    const task = getTask(state, id)
    if (!['pending', 'failed'].includes(task.state)) die(`${id} must be pending or failed to skip planning`)
    if (!usesCurrentPlanning(state, task)) die(`${id} is a legacy task without current planning gates`)
    if (task.contractConfirmationRequired)
      die(tr('{0} requires a fresh answered contract confirmation; finish the discussion before skipping planning', id))
    if (task.discussionRequired && !currentTaskDiscussionDecision(state, task))
      die(`${id} needs a completed discussion or an explicit user-confirmed discussion skip`)
    const decision = { ...explicitSkipDecision('skip-planning'), task: id,
      scope: phasePlanningContext(state, task), context: planningContext(state, task),
      contextSnapshot: taskContextSnapshot(state, task) }
    task.planningSkips ??= []
    task.planningSkips.push(decision)
    delete task.retryPlan
    task.state = 'pending'
    saveState(name, state)
    emit(name, 'task_planning_skipped', id, { decisionId: decision.decisionId,
      reason: decision.reason, confirmedByUser: true })
    log(`[prumo] ${id} planning skipped by explicit user choice; ready to execute when dependencies allow`)
  },

  'finish-planning'() {
    const name = runName()
    const id = args._[0] ?? die('finish-planning <task> --plan <task-plan.json>')
    if (typeof args.plan !== 'string' || !args.plan.trim()) die('finish-planning needs --plan <task-plan.json>')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase') die('this run uses phase planning; use finish-phase-planning')
    const t = getTask(state, id)
    if (t.state !== 'planning') die(id + ' is not in planning')
    const round = t.planningAttempts?.at(-1)
    if (!round || round.endedAt || round.agent !== t.planner) die('planning needs an open round and its recorded planner')
    const currentContext = planningContext(state, t)
    if (round.context !== currentContext)
      die(tr('task planning is stale: {0} — run plan-task again and research the current contract',
        staleReason(name, round, taskContextSnapshot(state, t), currentContext)))
    const skippedDiscussion = currentTaskDiscussionSkip(state, t)
    if (t.discoveryRequired && !skippedDiscussion && (!t.discovery?.digest || t.discovery.digest !== discoveryDigest(t.discovery) ||
        round.discoveryDigest !== t.discovery.digest || t.discovery.context !== round.context ||
        t.discovery.attempt !== round.attempt))
      die('task planning used stale discovery — run plan-task with the current discovery context')
    if (t.deps.some(dep => !['done', 'skipped'].includes(state.tasks[dep]?.state))) die('planning dependencies are no longer complete')
    let plan
    const path = resolve(args.plan), filename = basename(path)
    try {
      plan = readPlanningArtifact(path)
      assertTaskPlan(t, plan)
      validateQuestionDeadlines(state, id, plan.openQuestions)
    } catch (error) { die(planningArtifactError(filename, error)) }
    const questionRefs = validateQuestionResolutions(state, plan.decisions)
    warnTaskPlan(t, plan)
    const artifact = Object.fromEntries(['summary', 'research', 'decisions', 'steps', 'verification', 'openQuestions', 'writes'].map(field => [field, plan[field]]))
    artifact.openQuestions = annotatePlanQuestions(t, artifact.openQuestions, round.startedAt)
    t.taskPlan = { ...artifact, digest: taskPlanDigest(artifact), planner: t.planner, startedAt: round.startedAt, completedAt: new Date().toISOString(),
      context: round.context, scope: planningContext(state, t, { scopeOnly: true }), attempt: round.attempt,
      ...(round.discoveryDigest ? { discoveryDigest: round.discoveryDigest } : {}),
      ...(skippedDiscussion ? { discussionDecision: 'skipped', discussionDecisionId: skippedDiscussion.decisionId,
        discussionDecisionDigest: skippedDiscussion.digest } : {}) }
    t.planningHistory.push(t.taskPlan)
    delete t.retryPlan
    closePlanning(t, 'planned')
    round.artifactCount = 1
    t.state = t.planningReturn ? 'blocked' : 'pending'
    if (t.planningReturn) {
      Object.assign(t, t.planningReturn)
      delete t.planningReturn
    }
    recordQuestionResolutions(state, questionRefs, plan.decisions, { task: id })
    saveState(name, state)
    emit(name, 'task_planned', id, { planner: t.planner, round: t.planningAttempts.length, state: t.state })
    if (t.state === 'blocked') log(`[prumo] ${id} task plan recorded; still blocked — unblock explicitly to resume the current attempt`)
    else log(`[prumo] ${id} ready to execute (task plan recorded by ${t.planner})`)
  },

  start() {
    const name = runName()
    const id = args._[0] ?? die('start <task> --agent <name>')
    if (args.agent && args.executor && args.agent !== args.executor) die('start: --agent and --executor must name the same agent')
    const agent = args.agent ?? args.executor ?? die('start needs --agent <name> (alias: --executor)')
    if (typeof agent !== 'string' || !agent.trim()) die('start needs a nonempty agent name')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'pending') die(`${id} is ${t.state}, not pending`)
    assertTaskExecutionAuthorized(t)
    const dispatchConfirmation = manualDispatchConfirmation(t, 'manual authorization for {0} requires --confirmed-by-user before dispatch')
    assertNoOverdueQuestions(state, t)
    if (!hasCurrentTaskPlan(state, t)) die(id + ' needs completed current planning — run plan-task and finish-planning before start')
    try { validationContract(t) } catch (error) {
      die(`${id} has an invalid legacy validation contract: ${error.message} — correct the approved plan and run sync-plan before start`)
    }
    assertAvailable(state, t, 'running', agent)
    let inputReceipt
    if (t.taskPlan?.phaseId || currentPlanningSkip(state, t)) {
      try { inputReceipt = executionInputReceipt(state, t) } catch (error) { die(error.message) }
    }
    const planDigest = t.taskPlan ? taskPlanDigest(t.taskPlan) : undefined
    if (planDigest) t.taskPlan.digest = planDigest
    t.state = 'running'
    t.agent = agent
    t.attempts.push({ n: t.attempts.length + 1, agent, startedAt: new Date().toISOString(),
      ...(t.retryPlan?.attempt === t.attempts.length + 1 ? {
        planSourceAttempt: t.retryPlan.planSourceAttempt,
        correctionOf: t.retryPlan.failedAttempt, correctionReason: t.retryPlan.reason,
      } : {}), ...(planDigest ? { planDigest } : {}),
      ...(inputReceipt ? { inputReceipt: inputReceipt.inputs, inputDigest: inputReceipt.digest } : {}) })
    recordManualConfirmation(t.attempts.at(-1), 'dispatch', dispatchConfirmation)
    const total = t.taskPlan?.steps?.length
    if (total) t.attempts.at(-1).executionStep = 1
    saveState(name, state)
    emit(name, 'task_start', id, { agent, attempt: t.attempts.length,
      ...(planDigest ? { planDigest: planDigest.slice(0, 4) } : {}),
      ...(dispatchConfirmation ? { manualDispatchConfirmation: dispatchConfirmation } : {}),
      ...(total ? { current: 1, total } : {}) })
    log(`[prumo] ${id} running (agent ${agent}, attempt ${t.attempts.length})`)
    if (total) {
      const command = [...(process.platform === 'win32' ? ['&'] : []), quoteCommandArg(process.execPath),
        quoteCommandArg(process.argv[1]), 'progress', quoteCommandArg(id), '--step', '1', '--agent',
        quoteCommandArg(agent), '--run', quoteCommandArg(name)].join(' ')
      log('[prumo] report each actual execution step with:')
      console.log(command)
    }
  },

  progress() {
    const name = runName()
    const id = args._[0] ?? die('progress <task> --step <index> --agent <executor>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'running') die(`${id} is ${t.state}, not running`)
    assertCurrentTaskScope(state, t)
    assertCurrentExecutionInputs(state, t)
    if (!args.agent || args.agent !== t.agent) die('progress needs the current executor agent')
    const current = Number(args.step), total = t.taskPlan?.steps?.length
    if (!total || !Number.isSafeInteger(current) || current < 1 || current > total)
      die('progress step must be an index in the current task plan')
    const attempt = t.attempts.at(-1)
    if (current < (attempt.executionStep ?? 1)) die('progress cannot move backwards within an attempt')
    if (current === attempt.executionStep) {
      log(`[prumo] ${id} execution position already recorded at ${current}/${total} (agent ${t.agent}, attempt ${t.attempts.length}); position is not completion evidence`)
      return
    }
    attempt.executionStep = current
    saveState(name, state)
    emit(name, 'task_progress', id, { agent: t.agent, attempt: t.attempts.length, current, total })
    log(`[prumo] ${id} execution position recorded at ${current}/${total} (agent ${t.agent}, attempt ${t.attempts.length}); position is not completion evidence`)
  },

  /** Hand a finished task to a REVIEWER — a different agent, fresh context, that never
   *  saw the work being written. This is the gate that makes `done` mean something. */
  review() {
    const name = runName()
    const id = args._[0] ?? die('review <task> --agent <name>')
    const reviewer = args.agent ?? die('review needs --agent <name>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'running') die(`${id} is ${t.state}, not running`)
    assertReauthorizedAfterContractChange(t)
    const dispatchConfirmation = manualDispatchConfirmation(t, 'manual authorization for {0} requires --confirmed-by-user before dispatch')
    assertCurrentTaskScope(state, t)
    assertCurrentExecutionInputs(state, t)
    if (reviewer === t.agent && !args.force)
      die(`"${reviewer}" wrote ${id} — a reviewer must be a different agent (or --force)`)
    /* No cap check here on purpose: the task ALREADY holds a slot as `running`, so moving
       it to `reviewing` is a role handoff, not a new agent. Review is therefore never
       blocked by capacity — a finished task can always be judged immediately, which is the
       whole reason executors are capped below the total. */
    const busy = agentBusy(state, reviewer)
    if (busy && (!args.force || t.planningRequired || busy.state === 'planning'))
      die(`agent "${reviewer}" is already on ${busy.id} — one agent per task`)
    t.state = 'reviewing'
    t.reviewer = reviewer
    t.attempts.at(-1).reviewer = reviewer
    t.attempts.at(-1).reviewStartedAt = new Date().toISOString()
    const denominator = reviewDenominator(t)
    reviewProgressRecord(t, reviewer, denominator)
    recordManualConfirmation(t.attempts.at(-1), 'review', dispatchConfirmation)
    saveState(name, state)
    emit(name, 'task_review', id, { reviewer, attempt: t.attempts.length,
      ...(denominator ? { current: 1, total: denominator.total, basis: denominator.basis } : {}),
      ...(dispatchConfirmation ? { manualDispatchConfirmation: dispatchConfirmation } : {}) })
    log(`[prumo] ${id} in review (reviewer ${reviewer})`)
    if (t.taskPlan?.steps?.length > 1 && (t.attempts.at(-1).executionStep ?? 1) === 1)
      log(`[prumo] WARNING: executor progress stayed at 1/${t.taskPlan.steps.length}; the position is not proof of completed work`)
    printDispatchSuggestions(state)
  },

  'review-progress'() {
    const name = runName()
    const id = args._[0] ?? die('review-progress <task> --step <index> --agent <reviewer>')
    const state = loadState(name)
    const t = getTask(state, id)
    const reviewDisabled = (t.requireReview ?? state.plan.requireReview) === false
    const agent = t.state === 'reviewing' ? t.reviewer : t.state === 'running' && reviewDisabled ? t.agent : null
    if (!agent) die(`${id} is not in review`)
    if (!args.agent || args.agent !== agent) die('review-progress needs the current reviewing agent')
    assertCurrentTaskScope(state, t)
    assertCurrentExecutionInputs(state, t)
    const denominator = reviewDenominator(t)
    if (!denominator) die(`${id} has no structured review progress denominator; legacy criteria keep progress unknown`)
    const step = positiveIndex(args.step, 'review-progress step')
    if (step > denominator.total) die(`review-progress step must be between 1 and ${denominator.total}`)
    const attempt = t.attempts.at(-1)
    let progress = attempt.reviewProgress
    if (!progress || progress.total !== denominator.total || progress.basis !== denominator.basis ||
        progress.agent !== agent || progress.contractRevision !== (t.contractRevision ?? 0) ||
        progress.scopeRevision !== (t.scopeRevision ?? 0)) {
      progress = reviewProgressRecord(t, agent, denominator)
    }
    if (step <= progress.traversed) {
      log(`[prumo] ${id} review progress already reports ${progress.traversed}/${progress.total} criteria traversed; no state change; reviewer report is not proof of inspection or approval`)
      return
    }
    if (step !== progress.current)
      die(`review-progress must traverse the next criterion in order: expected ${progress.current}, received ${step}`)
    progress.traversed = step
    progress.current = Math.min(step + 1, progress.total)
    progress.selfReported = true
    progress.reportedAt = new Date().toISOString()
    saveState(name, state)
    emit(name, 'task_review_progress', id, { reviewer: agent, attempt: t.attempts.length,
      current: progress.current, total: progress.total, traversed: progress.traversed, basis: progress.basis,
      selfReported: true })
    if (progress.traversed === progress.total)
      log(`[prumo] ${id} review progress reports ${progress.traversed}/${progress.total} criteria traversed; reviewer report is not proof of inspection or approval`)
    else log(`[prumo] ${id} review progress reports ${progress.traversed}/${progress.total} criteria traversed; next criterion ${progress.current}/${progress.total}; reviewer report is not proof of inspection`)
  },

  'refresh-contract'() {
    const name = runName()
    const id = args._[0] ?? die('refresh-contract <task> --plan <approved-plan.json>')
    const state = loadState(name)
    const task = getTask(state, id)
    if (['done', 'skipped'].includes(task.state)) die('completed task contracts are immutable; create an explicit follow-up task')
    const source = args.plan ?? state.plan.source ?? die('refresh-contract needs --plan <approved-plan.json>')
    const plan = JSON.parse(readFileSync(resolve(source), 'utf8'))
    const matches = Array.isArray(plan.tasks) ? plan.tasks.filter((candidate) => candidate?.id === id) : []
    if (matches.length !== 1) die('approved plan must contain exactly one task ' + id)
    const fields = ['validation', 'validationMode', 'inspectionReason']
    const changes = Object.fromEntries(fields.map((field) => [field, matches[0][field]]))
    try { validationContract({ ...task, ...changes }) } catch (e) { die(e.message) }
    if (fields.every((field) => JSON.stringify(task[field]) === JSON.stringify(changes[field]))) {
      log('[prumo] ' + id + ' validation contract already matches; state and attempt unchanged')
      return
    }
    const authorization = task.executionAuthorization
    if (authorization) {
      task.authorizationHistory ??= []
      task.authorizationHistory.push({ ...authorization, revokedAt: new Date().toISOString(),
        revokeReason: 'refresh-contract changed this task validation contract' })
      delete task.executionAuthorization
    }
    Object.assign(task, changes)
    task.contractRevision = (task.contractRevision ?? 0) + 1
    saveState(name, state)
    emit(name, 'task_contract_refreshed', id, { revision: task.contractRevision, attempt: task.attempts.length, state: task.state,
      source: resolve(source), authorizationRevoked: Boolean(authorization) })
    log('[prumo] ' + tr('{0} contract refreshed; state {1}, attempt {2} preserved; previous validation receipts are stale',
      id, task.state, task.attempts.length))
    if (authorization)
      log('[prumo] ' + tr('execution authorization revoked for {0}; ask the user to accept the changed contract before another dispatch', id))
  },

  async validate() {
    const name = runName()
    const id = args._[0] ?? die('validate <task> --ok|--failed --evidence "<text>" [--cwd <project>]')
    const requestedOk = args.ok === true ? true : args.failed === true ? false : die('pass --ok or --failed')
    if (typeof args.evidence !== 'string' || !args.evidence.trim()) die('validation evidence must not be empty')
    if (args.summary !== undefined && (typeof args.summary !== 'string' || !args.summary.trim()))
      die('validation summary must be a nonempty string when present')
    const tail = tailLineLimit(args.tail)
    const token = randomUUID()
    const snapshot = withLock(name, () => {
      const state = loadState(name)
      const t = getTask(state, id)
      if (t.state !== 'running' && t.state !== 'reviewing') die(id + ' is not running or reviewing')
      if (requestedOk) {
        assertNoOverdueQuestions(state, t)
        assertCurrentTaskScope(state, t)
        assertCurrentExecutionInputs(state, t)
      }
      const by = t.state === 'reviewing' ? 'review' : 'executor'
      if (requestedOk && (t.requireReview ?? state.plan.requireReview) !== false &&
          (by !== 'review' || !t.reviewer || t.reviewer === t.agent))
        die('passing validation requires an independent reviewer')
      const denominator = reviewDenominator(t)
      if (requestedOk && denominator?.inspection) {
        const progress = t.attempts.at(-1)?.reviewProgress
        const reviewer = by === 'review' ? t.reviewer : t.agent
        if (!progress || progress.total !== denominator.total || progress.traversed !== denominator.total ||
            progress.selfReported !== true ||
            progress.basis !== denominator.basis || progress.agent !== reviewer ||
            progress.contractRevision !== (t.contractRevision ?? 0) || progress.scopeRevision !== (t.scopeRevision ?? 0))
          die(`${id} inspection criteria are not fully traversed; record reviewer-reported progress for each criterion with review-progress ${id} --step <index> --agent ${reviewer} (this is not proof of inspection)`)
      }
      if (requestedOk) {
        try { validationDirectories(t, args.cwd) } catch (error) { die(error.message) }
      }
      // Invalidate any previous pass before running commands, including on interruption.
      t.validations.push({ ok: false, by, agent: by === 'review' ? t.reviewer : t.agent,
        evidence: args.evidence, ...(args.summary === undefined ? {} : { summary: args.summary }),
        at: new Date().toISOString(), attempt: t.attempts.length, token,
        ...(t.planningRequired ? { planningScope: currentPlanningScope(state, t) } : {}) })
      saveState(name, state)
      emit(name, 'task_validation_started', id, { token, attempt: t.attempts.length })
      return t
    })
    // Tests must not hold the run lock: other tasks and the dashboard remain usable.
    let result = {}
    let error = null
    if (requestedOk) {
      try {
        const previous = snapshot.validations.slice(0, -1).reverse().find(receipt =>
          receipt.by === snapshot.validations.at(-1).by && receipt.checks?.length)
        result = await runValidation(snapshot, args.cwd, previous, check => {
          withLock(name, () => {
            const current = getTask(loadState(name), id)
            if (current.validations.at(-1)?.token !== token || current.state !== snapshot.state ||
                current.attempts.length !== snapshot.attempts.length || current.agent !== snapshot.agent ||
                current.reviewer !== snapshot.reviewer ||
                (current.contractRevision ?? 0) !== (snapshot.contractRevision ?? 0) ||
                (current.scopeRevision ?? 0) !== (snapshot.scopeRevision ?? 0) ||
                (current.stateRevision ?? 0) !== (snapshot.stateRevision ?? 0)) return
            emit(name, 'task_check', id, { ...check, token, attempt: snapshot.attempts.length,
              by: snapshot.validations.at(-1).by })
          })
        })
        printValidationTail(result.checks ?? [], tail)
        assertValidation(snapshot, { ...result, evidence: args.evidence })
      } catch (e) { error = e.message }
    }
    withLock(name, () => {
      const state = loadState(name)
      const t = getTask(state, id)
      const last = t.validations.at(-1)
      if (t.state !== snapshot.state || t.attempts.length !== snapshot.attempts.length ||
          t.agent !== snapshot.agent || t.reviewer !== snapshot.reviewer || last?.token !== token ||
          (t.contractRevision ?? 0) !== (snapshot.contractRevision ?? 0) ||
          (t.scopeRevision ?? 0) !== (snapshot.scopeRevision ?? 0) ||
          (t.stateRevision ?? 0) !== (snapshot.stateRevision ?? 0) ||
          JSON.stringify([t.validation, t.validationMode, t.inspectionReason]) !==
          JSON.stringify([snapshot.validation, snapshot.validationMode, snapshot.inspectionReason]))
        die('task changed during validation; result discarded — validate the current attempt again')
      if (requestedOk) {
        try { assertNoOverdueQuestions(state, t) } catch (questionError) { error ??= questionError.message }
        assertCurrentExecutionInputs(state, t)
      }
      Object.assign(last, result, { ok: requestedOk && !error, error, at: new Date().toISOString() })
      saveState(name, state)
      emit(name, 'task_validate', id, { ok: last.ok, by: last.by, evidence: last.evidence,
        ...(last.summary === undefined ? {} : { summary: last.summary }), error })
      log('[prumo] ' + id + ' validation recorded by ' + last.by + ': ' + (last.ok ? 'OK' : 'FAILED'))
    })
    if (error) die(error)
  },

  done() {
    const name = runName()
    const id = args._[0] ?? die('done <task>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'running' && t.state !== 'reviewing')
      die(`${id} is ${t.state}, not running or reviewing`)
    assertNoOverdueQuestions(state, t)
    assertCurrentTaskScope(state, t)
    assertCurrentExecutionInputs(state, t)
    const last = t.validations.at(-1)
    if (!last || !last.ok || last.attempt !== t.attempts.length)
      die(`${id} has no passing validation for the current attempt — validate first`)
    if (t.planningRequired && last.planningScope !== currentPlanningScope(state, t))
      die('execution scope changed after validation — validate the current scope again')
    /* The gavel belongs to the reviewer. A validation the executor recorded about its own
       work is a self-report, and the whole point of the role split is that it does not count. */
    if ((t.requireReview ?? state.plan.requireReview) !== false && last.by !== 'review')
      die(`${id} was validated by the ${last.by ?? 'executor'}, not a reviewer — run \`review ${id} --agent <name>\` first`)
    if (last.by === 'review' && (!t.reviewer || last.agent !== t.reviewer || t.reviewer === t.agent))
      die('passing validation requires the current independent reviewer')
    try { assertValidation(t, last) } catch (e) { die(e.message) }
    const previouslyEligible = eligibleDiscussionPhases(state)
    t.state = 'done'
    t.attempts.at(-1).endedAt = new Date().toISOString()
    t.attempts.at(-1).result = 'done'
    saveState(name, state)
    emit(name, 'task_done', id, { agent: t.agent })
    const unlocked = Object.values(derive(state)).filter(
      (o) => ['ready_to_plan', 'ready'].includes(o.effective) && o.deps.includes(id),
    )
    log(`[prumo] ${id} done${unlocked.length ? ` — unlocked: ${unlocked.map((u) => u.id).join(', ')}` : ''}`)
    announceNewlyEligiblePhases(name, previouslyEligible, state, 'done')
    printDispatchSuggestions(state)
  },

  fail() {
    const name = runName()
    const id = args._[0] ?? die('fail <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'running' && t.state !== 'reviewing')
      die(`${id} is ${t.state}, not running or reviewing`)
    const failedFrom = t.state
    t.state = 'failed'
    const a = t.attempts.at(-1)
    a.endedAt = new Date().toISOString()
    a.result = 'failed'
    a.reason = args.reason ?? ''
    a.failedFrom = failedFrom
    a.planDefect = args['plan-defect'] === true
    saveState(name, state)
    emit(name, 'task_fail', id, { reason: args.reason ?? '', attempt: t.attempts.length,
      failedFrom, planDefect: a.planDefect })
    log(`[prumo] ${id} failed (attempt ${t.attempts.length}): ${args.reason ?? ''}`)
  },

  retry() {
    const name = runName()
    const id = args._[0] ?? die('retry <task>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'failed') die(`${id} is ${t.state}, not failed`)
    assertReauthorizedAfterContractChange(t)
    const retryConfirmation = manualDispatchConfirmation(t, 'manual authorization for {0} requires --confirmed-by-user before retry')
    if (state.plan.source && existsSync(state.plan.source)) {
      const { plan } = readPlan(state.plan.source, state)
      if (!plan.tasks.some(candidate => candidate.id === id))
        die(`approved plan no longer contains ${id} — inspect it before retry`)
      const drift = contractDrift(state, { plan })
      const taskChanges = drift.tasks.find(item => item.task === id)
      const changed = taskChanges?.fields ?? []
      if (changed.length) die(`${id} contract differs from the approved plan (${changed.join(', ')}) — run sync-plan and inspect the persisted contract before retry`)
      const globalChanges = drift.planFields
      if (globalChanges.length)
        die(`${id} global plan decisions differ from the approved plan (${globalChanges.join(', ')}) — run sync-plan and inspect the persisted plan before retry`)
    }
    const cap = t.maxAttempts ?? MAX_ATTEMPTS_SOFT
    if (t.attempts.length >= cap && !args.force)
      die(`${id} already has ${t.attempts.length} attempts (cap ${cap}) — escalate instead, or --force`)
    const failed = t.attempts.at(-1)
    recordManualConfirmation(failed, 'retry', retryConfirmation)
    const planningSkipped = currentPlanningSkip(state, t)
    const planSourceAttempt = t.taskPlan?.attempt
    const reuse = Boolean(planningSkipped || (t.planningRequired && failed?.failedFrom === 'reviewing' && !failed.planDefect &&
      typeof failed.reason === 'string' && failed.reason.trim() && Number.isSafeInteger(planSourceAttempt) &&
      hasCurrentTaskScope(state, t, planSourceAttempt)))
    if (reuse) {
      const attempt = t.attempts.length + 1
      t.retryPlan = {
        ...(planningSkipped ? { skippedPlanning: true } : { planSourceAttempt }),
        failedAttempt: t.attempts.length, attempt, reason: failed.reason,
        ...(!planningSkipped ? { discoveryDigest: t.discovery?.digest,
          planContext: t.taskPlan.context, planScope: t.taskPlan.scope } : {}),
        context: planningContext(state, t, { attempt }),
        scope: planningContext(state, t, { scopeOnly: true, attempt }),
      }
    } else {
      delete t.retryPlan
      if (t.taskPlan?.phaseId && failed?.planDefect) t.phasePlanDefect = true
    }
    t.state = 'pending'
    t.agent = null
    t.reviewer = null
    saveState(name, state)
    emit(name, 'task_retry', id, { nextAttempt: t.attempts.length + 1,
      reusedPlan: Boolean(reuse && !planningSkipped), reusedPlanningSkip: Boolean(planningSkipped),
      ...(retryConfirmation ? { manualRetryConfirmation: retryConfirmation } : {}),
      ...(reuse ? { reason: failed.reason, ...(!planningSkipped ? { planSourceAttempt } : {}),
        failedAttempt: t.attempts.length } : {}) })
    log(`[prumo] ${id} back to pending (attempt ${t.attempts.length + 1} when started; ${planningSkipped ? 'approved planning skip reused' : reuse ? 'approved plan reused' : 'planning required'})`)
  },

  block() {
    const name = runName()
    const id = args._[0] ?? die('block <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    const question = args.question === undefined ? undefined :
      typeof args.question === 'string' && args.question.trim() ? args.question.trim() : die(tr('block --question must be nonempty'))
    const options = args.option === undefined ? undefined :
      (Array.isArray(args.option) ? args.option : [args.option]).map(value => typeof value === 'string' && value.trim() ? value.trim() :
        die(tr('block --option values must be nonempty')))
    if (options && question === undefined && !t.blockQuestion)
      die(tr('block --option requires --question'))
    if (['done', 'skipped'].includes(t.state)) die('completed tasks cannot be paused')
    const alreadyBlocked = t.state === 'blocked'
    if (t.state === 'planning') closePlanning(t, 'blocked')
    if (t.state === 'discussing') closeDiscussion(t, 'blocked')
    if (!alreadyBlocked) t.stateBeforeBlock = t.state
    t.stateRevision = (t.stateRevision ?? 0) + 1
    t.state = 'blocked'
    t.blockReason = args.reason ?? ''
    if (question !== undefined) {
      if (t.blockQuestion !== question && options === undefined) delete t.blockOptions
      t.blockQuestion = question
    }
    if (options !== undefined) t.blockOptions = [...new Set(options)]
    saveState(name, state)
    emit(name, alreadyBlocked ? 'task_block_updated' : 'task_block', id, { reason: args.reason ?? '',
      ...(t.blockQuestion ? { question: t.blockQuestion } : {}), ...(t.blockOptions ? { options: t.blockOptions } : {}) })
    log(`[prumo] ${id} blocked: ${args.reason ?? ''}`)
  },

  unblock() {
    const name = runName()
    const id = args._[0] ?? die('unblock <task> [--reviewer <agent>]')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'blocked') die(id + ' is ' + t.state + ', not blocked')
    const answer = args.answer === undefined ? undefined :
      typeof args.answer === 'string' && args.answer.trim() ? args.answer.trim() : die(tr('unblock --answer must be nonempty'))
    if (t.blockQuestion && answer === undefined) die(tr('unblock needs --answer to resolve the current block question'))
    if (!t.blockQuestion && answer !== undefined) die(tr('unblock --answer requires a current block question'))
    // Legacy unstarted tasks can return to pending; never guess the phase of an existing attempt.
    const previous = t.stateBeforeBlock ?? (t.attempts.length === 0 ? 'pending' : null)
    if (!['pending', 'discussing', 'planning', 'running', 'reviewing', 'failed'].includes(previous))
      die('cannot restore stateBeforeBlock; inspect the recorded history before repairing this task')
    const handoff = args.reviewer !== undefined
    if (handoff && !['running', 'reviewing'].includes(previous))
      die('direct review requires a paused active attempt; pending/failed tasks cannot bypass start/retry')
    const target = handoff ? 'reviewing' : previous === 'discussing' ? 'pending' : previous
    if (['running', 'reviewing'].includes(target)) assertReauthorizedAfterContractChange(t)
    const dispatchConfirmation = ['running', 'reviewing'].includes(target) ?
      manualDispatchConfirmation(t, 'manual authorization for {0} requires --confirmed-by-user to resume execution') : null
    const reviewer = handoff ? args.reviewer : t.reviewer
    if (target === 'planning') {
      const round = t.planningAttempts?.at(-1)
      if (!round || round.result !== 'blocked' || round.agent !== t.planner)
        die('cannot resume planning without its paused round and original planner')
      assertAvailable(state, t, target, t.planner)
      beginPlanning(state, t, t.planner, round.context)
    }
    if (target === 'running' || target === 'reviewing') {
      const attempt = t.attempts.at(-1)
      if (!attempt || attempt.endedAt || attempt.result || !t.agent || attempt.agent !== t.agent)
        die('cannot resume without an open attempt and its original executor')
      assertCurrentTaskScope(state, t)
      assertCurrentExecutionInputs(state, t)
      if (target === 'reviewing' && reviewer === t.agent)
        die('passing validation requires an independent reviewer')
      assertAvailable(state, t, target, target === 'reviewing' ? reviewer : t.agent)
      recordManualConfirmation(t.attempts.at(-1), 'resume', dispatchConfirmation)
      if (handoff && reviewer !== t.reviewer) {
        t.reviewer = reviewer
        attempt.reviewer = reviewer
        attempt.reviewStartedAt = new Date().toISOString()
      }
    }
    let reviewDenom
    if (target === 'reviewing') {
      const attempt = t.attempts.at(-1)
      reviewDenom = reviewDenominator(t)
      const progress = attempt.reviewProgress
      if (!progress || progress.agent !== reviewer || progress.total !== reviewDenom?.total ||
          progress.basis !== reviewDenom?.basis || progress.contractRevision !== (t.contractRevision ?? 0) ||
          progress.scopeRevision !== (t.scopeRevision ?? 0))
        reviewProgressRecord(t, reviewer, reviewDenom)
    }
    t.state = target
    t.blockHistory ??= []
    t.blockHistory.push({ reason: t.blockReason ?? '', ...(t.blockQuestion ? { question: t.blockQuestion } : {}),
      ...(answer !== undefined ? { answer } : {}), at: new Date().toISOString() })
    delete t.blockReason
    delete t.blockQuestion
    delete t.blockOptions
    delete t.stateBeforeBlock
    saveState(name, state)
    emit(name, 'task_unblock', id, { state: target, agent: target === 'reviewing' ? t.reviewer : target === 'planning' ? t.planner : t.agent,
      attempt: t.attempts.length, ...(answer !== undefined ? { answer } : {}),
      ...(target === 'reviewing' && reviewDenom ? { current: 1, total: reviewDenom.total, basis: reviewDenom.basis } : {}),
      ...(dispatchConfirmation ? { manualDispatchConfirmation: dispatchConfirmation } : {}) })
    log('[prumo] ' + id + ' unblocked to ' + target + '; attempt ' + t.attempts.length + ' preserved; no agent dispatched')
    if (target === 'reviewing' && t.taskPlan?.steps?.length > 1 && (t.attempts.at(-1).executionStep ?? 1) === 1)
      log(`[prumo] WARNING: executor progress stayed at 1/${t.taskPlan.steps.length}; the position is not proof of completed work`)
  },

  skip() {
    const name = runName()
    const id = args._[0] ?? die('skip <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    if (['done', 'skipped'].includes(t.state)) die(`${id} is already terminal`)
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : die('skip requires --reason <text>')
    const previouslyEligible = eligibleDiscussionPhases(state)
    if (t.state === 'planning') closePlanning(t, 'skipped')
    if (t.state === 'discussing') closeDiscussion(t, 'skipped')
    t.state = 'skipped'
    t.skipReason = reason
    const attempt = t.attempts?.at(-1)
    if (attempt && !attempt.endedAt && !attempt.result) {
      attempt.endedAt = new Date().toISOString()
      attempt.result = 'skipped'
      attempt.reason = reason
    }
    saveState(name, state)
    emit(name, 'task_skip', id, { reason })
    log(`[prumo] ${id} skipped: ${reason}`)
    announceNewlyEligiblePhases(name, previouslyEligible, state, 'skip')
    printDispatchSuggestions(state)
  },

  note() {
    const name = runName()
    const id = args._[0] ?? die('note <task> --text "<text>"')
    const text = args.text
    if (typeof text !== 'string' || !text.trim()) die('note needs a nonempty --text "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    t.notes.push({ text, at: new Date().toISOString() })
    saveState(name, state)
    emit(name, 'task_note', id, { text })
    const characters = Array.from(text).length
    log(`[prumo] ${id} note recorded (${characters} ${characters === 1 ? 'character' : 'characters'})`)
  },
}

if (!cmd || !commands[cmd]) {
  errorLog(`usage: engine.mjs <${Object.keys(commands).join('|')}> — see file header for details`)
  process.exit(1)
}

/* Readers need no lock: saveState renames a complete file into place, so a reader sees
   either the previous state or the next one, never a half-written one. Everything else
   takes the run's lock for its whole read-modify-write; validate locks its state updates
   separately so command execution cannot outlive the short lock lease. */
const READ_ONLY = new Set(['runs', 'status', 'ready', 'graph', 'show-contract', 'show-check'])
const LEGACY_MIGRATION_CONTINUATIONS = new Set([
  'start', 'progress', 'review', 'review-progress', 'validate', 'done', 'fail', 'retry', 'block', 'unblock', 'skip', 'refresh-contract',
])
function assertMigrationCommandAllowed(state, command) {
  if (READ_ONLY.has(command) || command === 'sync-plan' || command === 'note') return
  const task = state.tasks[args._[0]]
  if (command === 'finish-discussion' && task?.discussionAttempts?.some(round => !round.endedAt)) return
  if (command === 'finish-planning' && task?.planningAttempts?.some(round => !round.endedAt)) return
  const phase = state.phaseWorkflows?.[args._[0]]
  if (command === 'finish-phase-discussion' && phase?.discussionAttempts?.some(round => !round.endedAt)) return
  if (command === 'finish-phase-planning' && phase?.planningAttempts?.some(round => !round.endedAt)) return
  const legacyAttempt = task && task.planningRequired !== true && (task.attempts?.length ?? 0) > 0
  if (legacyAttempt && LEGACY_MIGRATION_CONTINUATIONS.has(command)) return
  die('migration is blocked by unsafe in-flight planning; only legacy attempt continuation, read-only commands, sync-plan and note are allowed')
}
if (!['init', 'runs', 'migrate'].includes(cmd)) {
  const name = runName()
  if (migrationStatus(loadState(name)).needed) withLock(name, () => {
    const state = loadState(name)
    if (!migrationStatus(state).needed) return
    const status = migrationStatus(state)
    if (status.blockers.length) {
      errorLog('[prumo] Migration deferred: resolve unsafe in-flight planning before starting new work')
      errorLog('[prumo] Migration blockers: ' + status.blockers.join('; '))
      assertMigrationCommandAllowed(state, cmd)
    } else migrateState(name, { quiet: true })
  })
}
if (cmd === 'migrate' && args.check !== true) withLock(runName(), commands[cmd])
else if (READ_ONLY.has(cmd) || cmd === 'validate' || cmd === 'migrate') await commands[cmd]()
else withLock(cmd === 'init' ? (args.run ?? die('init needs --run <name>')) : runName(), commands[cmd])
