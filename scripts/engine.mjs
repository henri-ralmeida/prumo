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
 * Legacy tasks without planningRequired retain their original lifecycle.
 *
 * Usage (ENGINE = path to this file, wherever the skill is installed):
 *   node $ENGINE init --plan <plan.json> --run <name>
 *   node $ENGINE sync-plan --plan <plan.json> [--run <name>]
 *   node $ENGINE migrate [--check] [--run <name>]
 *   node $ENGINE status|ready|graph [--run <name>]
 *   node $ENGINE begin-phase-discussion <phase> [--adopt-legacy]
 *   node $ENGINE finish-phase-discussion <phase> --context <discovery.json>
 *   node $ENGINE plan-phase <phase> --agent <name>
 *   node $ENGINE finish-phase-planning <phase> --plan-dir <directory>
 *   node $ENGINE begin-discussion <task> [--adopt-legacy]
 *   node $ENGINE finish-discussion <task> --context <discovery.json>
 *   node $ENGINE plan-task <task> --agent <name> [--context <legacy-discovery.json>]
 *   node $ENGINE finish-planning <task> --plan <task-plan.json>
 *   node $ENGINE start <task> --agent <name>   (max 3 executors)
 *   node $ENGINE progress <task> --step <1-based index> --agent <executor>
 *   node $ENGINE review <task> --agent <name>  (hands it to a reviewer)
 *   node $ENGINE validate <task> --ok|--failed --evidence "<text>" [--cwd <project>]
 *   node $ENGINE refresh-contract <task> --plan <approved-plan.json>
 *   node $ENGINE done <task>
 *   node $ENGINE fail <task> --reason "<text>" [--plan-defect]
 *   node $ENGINE retry <task> [--force]
 *   node $ENGINE block <task> --reason | unblock <task> [--reviewer <agent>]
 *   node $ENGINE skip <task> --reason
 *   node $ENGINE note <task> --text "<text>"
 *   node $ENGINE runs
 */
import {
  mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync,
  rmSync, statSync, copyFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { writeAtomicState } from './atomic-state.mjs'
import { runValidation, assertValidation, validationContract, validationDirectories, assertDiscovery, discoveryDigest, assertTaskPlan,
  planTaskFromState, planningContext, hasCurrentTaskPlan, hasCurrentTaskScope, currentPlanningScope,
  phasePlanningContext, phaseRequiredInputs, assertPhaseTaskPlan, executionInputReceipt } from './validation.mjs'
import { dirname, join, resolve } from 'node:path'

import { findRoot, legacyExecutionPending } from './storage.mjs'
import { log, errorLog, tr } from './i18n.mjs'

let ROOT
try { ROOT = findRoot() } catch (error) { errorLog('[prumo] ERROR: ' + error.message); process.exit(1) }
const GRAPH_DIR = join(ROOT, '.specs', 'graph')
const CURRENT_FILE = join(GRAPH_DIR, 'CURRENT')
const MAX_ATTEMPTS_SOFT = 3
const DEFAULT_MAX_PARALLEL = 4
const DEFAULT_MAX_EXECUTORS = 3   // the 4th slot is RESERVED for review
const STATE_SCHEMA_VERSION = 1
const TASK_CONTRACT_FIELDS = ['phase', 'title', 'deps', 'validation', 'validationMode', 'inspectionReason', 'requireReview', 'maxAttempts', 'tags', 'touches']
const GLOBAL_PLAN_FIELDS = ['name', 'description', 'requireReview']
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
      args[key] = next
      i++
    } else args[key] = true
  } else args._.push(a)
}

function die(msg) {
  errorLog(`[prumo] ERROR: ${msg}`)
  process.exit(1)
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
      if (!['pending', 'failed'].includes(task.state)) reasons.push(`state ${task.state}`)
      if (task.attempts?.length) reasons.push(`${task.attempts.length} execution attempt(s)`)
      if (task.discussionAttempts?.some(round => !round.endedAt)) reasons.push('open discussion')
      if (task.planningAttempts?.some(round => !round.endedAt)) reasons.push('open planning')
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
    if (!adoptingLegacy || ['done', 'skipped'].includes(task.state)) continue
    task.discussionRequired = true
    task.discoveryRequired = true
    task.planningRequired = true
    task.discussionAttempts ??= []
    task.planningAttempts ??= []
    task.planningHistory ??= []
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
    if (planningMode === 'phase' && !phaseIds.has(t.phase)) die(`task ${t.id} needs a declared phase for phase planning`)
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
    deps: t.deps ?? [],
    validation: t.validation ?? '',
    validationMode: t.validationMode,
    inspectionReason: t.inspectionReason,
    requireReview: t.requireReview,
    maxAttempts: t.maxAttempts,
    tags: t.tags ?? [],
    touches: t.touches ?? [],
    state: 'pending',
    discussionRequired: true,
    discussionAttempts: [],
    discoveryRequired: true,
    planningRequired: true,
    planner: null,
    planningAttempts: [],
    planningHistory: [],
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
    ...(digest ? { discoveryDigest: digest } : {}) })
  task.state = 'planning'
}

function closePlanning(task, result) {
  const round = task.planningAttempts?.at(-1)
  if (round && !round.endedAt) Object.assign(round, { endedAt: new Date().toISOString(), result })
}

function closeDiscussion(task, result) {
  const round = task.discussionAttempts?.at(-1)
  if (round && !round.endedAt) Object.assign(round, { endedAt: new Date().toISOString(), result })
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
    !(task.taskPlan?.phaseId === phaseId && hasCurrentTaskPlan(state, task)))
}

function phasePlanningBlockers(state, phaseId) {
  const blockers = new Set()
  for (const task of phaseMembers(state, phaseId)) {
    if (['done', 'skipped'].includes(task.state)) continue
    for (const id of task.deps ?? []) {
      const dep = state.tasks[id]
      if (dep?.phase !== phaseId && !['done', 'skipped'].includes(dep?.state)) {
        blockers.add(dep?.phase ?? id)
      }
    }
  }
  return [...blockers]
}

function assertPhasePlanningOrder(state, phaseId) {
  const blockers = phasePlanningBlockers(state, phaseId)
  if (blockers.length) die(`${phaseId} waits for external dependencies: ${blockers.join(', ')}. Keep the approved phases; complete their dependency tasks first.`)
}

function phaseContext(state, phaseId, targets = phaseTargets(state, phaseId)) {
  return JSON.stringify([state.plan.name, state.plan.description, state.plan.planningRevision ?? 0, phaseId,
    targets.map(task => [task.id, phasePlanningContext(state, task)]).sort()])
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

function currentPhasePlanning(state, phase, round = phase?.planningAttempts?.at(-1)) {
  if (!round || round.endedAt || !Array.isArray(round.targets)) return false
  const discussion = phase?.discussionAttempts?.at(-1)
  const targets = round.targets.map(id => state.tasks[id]).filter(Boolean)
  const liveTargets = phaseTargets(state, phase.id).map(task => task.id).sort()
  return discussion?.roundId === round.discussionRoundId &&
    currentPhaseDiscussion(state, phase) && targets.length === round.targets.length &&
    JSON.stringify([...round.targets].sort()) === JSON.stringify(liveTargets) &&
    round.context === phaseContext(state, phase.id, discussion.targets.map(id => state.tasks[id])) &&
    round.discoveryDigest === phase.discovery?.digest
}

function assertCurrentTaskScope(state, task) {
  if (!hasCurrentTaskScope(state, task))
    die(task.id + ' execution scope needs current planning — keep work blocked, run plan-task and finish-planning, then unblock explicitly')
}

function assertCurrentExecutionInputs(state, task) {
  if (!task.taskPlan?.phaseId || !task.attempts?.length) return
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
      if (state.plan.planningMode === 'phase') {
        planningBlockedBy = phasePlanningBlockers(state, t.phase)
        effective = !phaseAdopted ? 'pending' : hasCurrentTaskPlan(state, t) ?
          (blockedBy.length ? 'waiting' : 'ready') : planningBlockedBy.length ? 'waiting' :
            (currentPhaseDiscussion(state, phase) ? 'ready_to_plan' : 'ready_for_discussion')
      } else {
        effective = blockedBy.length ? 'waiting' : !phaseAdopted ? 'pending' :
          hasCurrentTaskPlan(state, t) ? 'ready' :
            t.discussionRequired && !currentDiscussion(state, t) ? 'ready_for_discussion' : 'ready_to_plan'
      }
    }
    const planningStatus = state.legacyPhaseAdoption && !phase?.adoptedLegacy ? 'awaiting_phase_adoption' : hasCurrentTaskPlan(state, t) ? 'planned' :
      phase?.state === 'discussing' ? 'phase_discussing' : phase?.state === 'planning' ? 'phase_planning' : 'awaiting_phase_plan'
    let inputStatus
    if (t.taskPlan?.phaseId && t.taskPlan.unresolvedInputs?.length) {
      const inputs = t.taskPlan.unresolvedInputs.map(input => state.tasks[input.task])
      inputStatus = inputs.some(dep => !dep || !['done', 'skipped'].includes(dep.state)) ? 'unresolved_later_phase_input' :
        inputs.some(dep => dep.state === 'skipped') ? 'waived_input' : 'validated_input'
    }
    const showPlanningStatus = state.plan.planningMode === 'phase' && !['done', 'skipped'].includes(t.state)
    out[id] = { ...t, effective, blockedBy, ...(showPlanningStatus ?
      { planningStatus, ...(planningBlockedBy.length ? { planningBlockedBy } : {}), ...(inputStatus ? { inputStatus } : {}) } : {}) }
    if (migrationPending && t.state === 'pending' && !t.attempts?.length)
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
  if (blockedBy.length && (!args.force || role === 'planning' || task.planningRequired)) die(task.id + ' still waiting on: ' + blockedBy.join(', '))
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
    const planPath = args.plan ?? state.plan.source ?? die('sync-plan needs --plan <plan.json> once')
    const { plan, source } = readPlan(planPath, state)
    const removed = Object.keys(state.tasks).filter((id) => !plan.tasks.some((t) => t.id === id))
    if (removed.length) die(`sync-plan is additive: plan removed ${removed.join(', ')}`)

    const mutableStates = new Set(['pending', 'planning', 'failed', 'blocked'])
    const contractFields = TASK_CONTRACT_FIELDS
    const added = []
    const updated = []
    const preserved = []
    for (const planTask of plan.tasks) {
      const current = state.tasks[planTask.id]
      if (!current) {
        state.tasks[planTask.id] = taskFromPlan(planTask)
        added.push(planTask.id)
        continue
      }
      const next = taskFromPlan(planTask)
      const changed = contractFields.filter(
        (field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]),
      )
      if (!changed.length) continue
      if (!mutableStates.has(current.state)) {
        preserved.push(planTask.id)
        continue
      }
      for (const field of changed) current[field] = next[field]
      if (current.planningRequired) current.planningRevision = (current.planningRevision ?? 0) + 1
      if (current.planningRequired && changed.some(field => !['validation', 'validationMode', 'inspectionReason'].includes(field)))
        current.scopeRevision = (current.scopeRevision ?? 0) + 1
      if (changed.some((field) => ['validation', 'validationMode', 'inspectionReason'].includes(field)))
        current.contractRevision = (current.contractRevision ?? 0) + 1
      updated.push(planTask.id)
    }

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
    if (state.plan.planningRevision || planningChanged)
      nextPlan.planningRevision = (state.plan.planningRevision ?? 0) + (planningChanged ? 1 : 0)
    const planChanged = JSON.stringify(state.plan) !== JSON.stringify(nextPlan)
    if (!added.length && !updated.length && !planChanged) {
      if (preserved.length)
        log(`[prumo] no state changes; plan differs for preserved tasks: ${preserved.join(', ')}. Use refresh-contract for an approved validation change; do not fail/retry completed work to refresh a contract.`)
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
    saveState(name, state)
    emit(name, 'plan_sync', null, {
      added,
      updated,
      preserved,
      tasks: Object.keys(state.tasks).length,
    })
    log(
      `[prumo] run "${name}" synced: +${added.length}, updated ${updated.length}, ` +
        `preserved ${preserved.length}, total ${Object.keys(state.tasks).length}`,
    )
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

  status() {
    const name = runName()
    const state = loadState(name)
    const d = derive(state)
    const p = progress(state)
    log(`run: ${name}  plan: ${state.plan.name}  ${p.done}/${p.total} done`)
    log(`states: ${JSON.stringify(p.by)}`)
    const width = Math.max(...Object.values(d).map((t) => t.id.length))
    const row = (t) => {
      const agent = t.state === 'discussing' ? `  @${tr('orchestrator')} (${tr('discussing')})` :
        t.state === 'planning' ? `  @${t.planner} (${tr('planning')})` :
        t.state === 'reviewing' ? `  @${t.reviewer} (review)` : t.agent ? `  @${t.agent}` : ''
      const attempts = t.attempts.length > 1 ? `  (attempt ${t.attempts.length})` : ''
      const wait = t.effective === 'waiting' ? `  ← ${(t.planningBlockedBy ?? t.blockedBy).join(',')}` : ''
      console.log(`  ${t.id.padEnd(width)}  ${tr(t.effective).padEnd(8)}${agent}${attempts}${wait}`)
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
  },

  ready() {
    const state = loadState(runName())
    const d = derive(state)
    const occ = occupancy(state)
    const list = Object.values(d).filter((t) => ['ready_for_discussion', 'ready_to_plan', 'ready'].includes(t.effective))
    for (const t of list) console.log(`${t.id}  ${t.title}  [${tr(t.effective)}]`)
    const slots = Math.max(0, Math.min(occ.maxExec - occ.executors.length, occ.cap - occ.busy.length))
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
    if (phase.state === 'discussing' && !phase.discussionAttempts.at(-1)?.endedAt)
      die(`${phaseId} already has an open discussion round`)
    const planning = phase.planningAttempts.at(-1)
    const stalePlanning = phase.state === 'planning' && planning && !currentPhasePlanning(state, phase, planning)
    if (phase.state === 'planning' && !stalePlanning) die(`${phaseId} is currently planning`)
    if (stalePlanning) {
      Object.assign(planning, { endedAt: new Date().toISOString(), result: 'superseded' })
      phase.planner = null
    }
    let targets = phaseTargets(state, phaseId)
    if (!targets.length) targets = phaseMembers(state, phaseId).filter(task => !['done', 'skipped'].includes(task.state))
    if (!targets.length) die(`${phaseId} has no nonterminal tasks to discuss`)
    const round = { roundId: randomUUID(), nonce: randomUUID(), startedAt: new Date().toISOString(),
      targets: targets.map(task => task.id), context: phaseContext(state, phaseId, targets) }
    phase.discussionAttempts.push(round)
    phase.state = 'discussing'
    saveState(name, state)
    emit(name, 'phase_discussion', null, { phase: phaseId, roundId: round.roundId, members: round.targets,
      ...(args['adopt-legacy'] === true ? { adoptedLegacy: true } : {}) })
    log(`[prumo] ${phaseId} discussing ${round.targets.length} task(s) (round ${round.roundId}, nonce ${round.nonce})`)
  },

  'finish-phase-discussion'() {
    const name = runName()
    const phaseId = args._[0] ?? die('finish-phase-discussion <phase> --context <discovery.json>')
    if (typeof args.context !== 'string' || !args.context.trim()) die('finish-phase-discussion needs --context <discovery.json>')
    const state = loadState(name), phase = getPhase(state, phaseId), round = phase.discussionAttempts.at(-1)
    if (phase.state !== 'discussing' || !round || round.endedAt) die(`${phaseId} has no open discussion round`)
    const targets = round.targets.map(id => getTask(state, id))
    if (round.context !== phaseContext(state, phaseId, targets)) die(`${phaseId} discussion is stale — begin a fresh phase discussion`)
    let discovery, digest
    try {
      discovery = JSON.parse(readFileSync(resolve(args.context), 'utf8'))
      assertDiscovery(discovery)
      if (discovery.roundId !== round.roundId || discovery.nonce !== round.nonce)
        throw new Error('discovery roundId and nonce must match the current phase discussion')
      if (!discovery.questions.some(question => question.roundId === round.roundId))
        throw new Error('discovery needs a fresh answered question bound to the current phase discussion roundId')
      digest = discoveryDigest(discovery)
    } catch (error) { die(error.message) }
    const fields = ['research', 'questions', 'coverage', 'decisions', 'deferred', 'closure', 'roundId', 'nonce']
    phase.discovery = { ...Object.fromEntries(fields.map(field => [field, discovery[field]])),
      recordedAt: new Date().toISOString(), context: round.context, digest }
    Object.assign(round, { endedAt: new Date().toISOString(), result: 'discussed', discoveryDigest: digest,
      discovery: phase.discovery })
    phase.state = 'pending'
    saveState(name, state)
    emit(name, 'phase_discussed', null, { phase: phaseId, roundId: round.roundId, questions: discovery.questions.length,
      members: round.targets })
    log(`[prumo] ${phaseId} ready to plan (${round.targets.length} task(s))`)
  },

  'plan-phase'() {
    const name = runName()
    const phaseId = args._[0] ?? die('plan-phase <phase> --agent <name>')
    const agent = args.agent ?? die('plan-phase needs --agent <name>')
    const state = loadState(name), phase = getPhase(state, phaseId)
    assertPhasePlanningOrder(state, phaseId)
    if (!currentPhaseDiscussion(state, phase)) die(`${phaseId} needs a completed current phase discussion`)
    const discussion = phase.discussionAttempts.at(-1)
    const targets = discussion.targets.map(id => getTask(state, id)).filter(task => !hasCurrentTaskPlan(state, task))
    if (!targets.length) die(`${phaseId} has no task requiring a phase plan`)
    const context = phaseContext(state, phaseId, discussion.targets.map(id => getTask(state, id)))
    const open = phase.planningAttempts.at(-1)
    if (phase.state === 'planning' && !open?.endedAt && open.context === context && open.discoveryDigest === phase.discovery.digest) {
      if (agent !== phase.planner) die(`${phaseId} already has planner "${phase.planner}" for the current round`)
      log(`[prumo] ${phaseId} already in planning with the same discovery; no new round recorded`)
      return
    }
    if (phase.state === 'planning') die(`${phaseId} has a stale open planning round; begin a fresh phase discussion`)
    const occ = occupancy(state)
    if (occ.busy.length >= occ.cap) die(`${occ.busy.length} agents busy (cap ${occ.cap})`)
    const busy = agentBusy(state, agent)
    if (busy) die(`agent "${agent}" is already on ${busy.id} — one agent per task or phase`)
    const round = { n: phase.planningAttempts.length + 1, agent, startedAt: new Date().toISOString(), context,
      discoveryDigest: phase.discovery.digest, discussionRoundId: discussion.roundId, targets: targets.map(task => task.id),
      requiredInputs: Object.fromEntries(targets.map(task => [task.id, phaseRequiredInputs(state, task)])) }
    phase.planner = agent
    phase.planningAttempts.push(round)
    phase.state = 'planning'
    saveState(name, state)
    emit(name, 'phase_planning', null, { phase: phaseId, planner: agent, round: round.n, members: round.targets })
    log(`[prumo] ${phaseId} in planning (planner ${agent}, ${round.targets.length} task(s))`)
  },

  'finish-phase-planning'() {
    const name = runName()
    const phaseId = args._[0] ?? die('finish-phase-planning <phase> --plan-dir <directory>')
    if (typeof args['plan-dir'] !== 'string' || !args['plan-dir'].trim())
      die('finish-phase-planning needs --plan-dir <directory>')
    const state = loadState(name), phase = getPhase(state, phaseId), round = phase.planningAttempts.at(-1)
    if (phase.state !== 'planning' || !round || round.endedAt || round.agent !== phase.planner)
      die(`${phaseId} has no open planning round and recorded planner`)
    if (!currentPhasePlanning(state, phase, round))
      die(`${phaseId} planning is stale — discuss and plan the current phase contract`)
    const tasks = round.targets.map(id => getTask(state, id))
    const binding = { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n }
    const plans = [], planDir = resolve(args['plan-dir'])
    try {
      for (const task of tasks) {
        safeId(task.id)
        const path = resolve(planDir, `task-plan-${task.id}.json`)
        if (dirname(path) !== planDir) throw new Error(`task-plan-${task.id}.json escapes --plan-dir`)
        const plan = JSON.parse(readFileSync(path, 'utf8'))
        assertPhaseTaskPlan(state, task, plan, binding, round.requiredInputs?.[task.id] ?? [])
        plans.push([task, plan])
      }
    } catch (error) { die(error.message) }
    const completedAt = new Date().toISOString()
    for (const [task, plan] of plans) {
      const fields = ['research', 'decisions', 'steps', 'verification', 'openQuestions', 'phaseBinding', 'unresolvedInputs']
      const artifact = Object.fromEntries(fields.map(field => [field, plan[field]]))
      task.planner = phase.planner
      task.taskPlan = { ...artifact, planner: phase.planner, startedAt: round.startedAt, completedAt,
        context: round.context, scope: phasePlanningContext(state, task), phaseId,
        phaseDiscoveryDigest: phase.discovery.digest, attempt: task.attempts.length + 1 }
      task.planningHistory ??= []
      task.planningHistory.push(task.taskPlan)
      delete task.phasePlanDefect
      delete task.retryPlan
    }
    Object.assign(round, { endedAt: completedAt, result: 'planned' })
    phase.planningHistory.push({ round: round.n, planner: phase.planner, completedAt, members: round.targets,
      discoveryDigest: round.discoveryDigest })
    phase.state = 'planned'
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
    if (t.state === 'discussing' && open && !open.endedAt)
      die(id + ' already has an open discussion round')
    if (stalePlanning) closePlanning(t, 'superseded')
    if (pausedExecution) t.planningReturn = { stateBeforeBlock: t.stateBeforeBlock, blockReason: t.blockReason }
    const round = {
      roundId: randomUUID(), nonce: randomUUID(), startedAt: new Date().toISOString(),
      context: planningContext(state, t), attempt: t.attempts.length + (t.planningReturn ? 0 : 1),
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
      ...(adoptLegacy ? { adoptedLegacy: true } : {}) })
    log(`[prumo] ${id} discussing (round ${round.roundId}, nonce ${round.nonce})`)
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
    if (round.context !== planningContext(state, t) || round.attempt !== t.attempts.length + (t.planningReturn ? 0 : 1))
      die(id + ' discussion is stale — begin a fresh discussion')
    let discovery, digest
    try {
      discovery = JSON.parse(readFileSync(resolve(args.context), 'utf8'))
      assertDiscovery(discovery)
      if (discovery.roundId !== round.roundId || discovery.nonce !== round.nonce)
        throw new Error('discovery roundId and nonce must match the current discussion')
      if (!discovery.questions.some(question => question.roundId === round.roundId))
        throw new Error('discovery needs a fresh answered question bound to the current discussion roundId')
      digest = discoveryDigest(discovery)
    } catch (error) { die(error.message) }
    const fields = ['research', 'questions', 'coverage', 'decisions', 'deferred', 'closure', 'roundId', 'nonce']
    t.discovery = { ...Object.fromEntries(fields.map(field => [field, discovery[field]])),
      recordedAt: new Date().toISOString(), context: round.context, attempt: round.attempt, digest }
    Object.assign(round, { endedAt: new Date().toISOString(), result: 'discussed', discoveryDigest: digest })
    t.state = t.planningReturn ? 'blocked' : 'pending'
    saveState(name, state)
    emit(name, 'task_discussed', id, { roundId: round.roundId, questions: discovery.questions.length, state: t.state })
    log(`[prumo] ${id} ready to plan (discussion ${round.roundId} closed)`)
  },

  'plan-task'() {
    const name = runName()
    const id = args._[0] ?? die('plan-task <task> --agent <name> --context <discovery.json>')
    const agent = args.agent ?? die('plan-task needs --agent <name>')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase') die('this run uses phase planning; use plan-phase')
    const t = getTask(state, id)
    const pausedExecution = t.planningRequired && t.state === 'blocked' && ['running', 'reviewing'].includes(t.stateBeforeBlock)
    const stale = t.state === 'planning' && t.planningAttempts?.at(-1)?.context !== planningContext(state, t)
    let discovery, digest
    if (t.discussionRequired) {
      if (!currentDiscussion(state, t))
        die(id + ' needs a completed current discussion before the planner is dispatched')
      discovery = t.discovery
      digest = t.discovery.digest
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
    const storedDiscoveryCurrent = digest && digest === t.discovery?.digest && digest === discoveryDigest(t.discovery)
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
    if (stale || changedDiscovery) closePlanning(t, 'superseded')
    if (discovery && !t.discussionRequired) {
      const fields = ['research', 'questions', 'coverage', 'decisions', 'deferred', 'closure']
      t.discovery = { ...Object.fromEntries(fields.map(field => [field, discovery[field]])),
        recordedAt: new Date().toISOString(), context: planningContext(state, t),
        attempt: t.attempts.length + (t.planningReturn ? 0 : 1), digest }
    }
    beginPlanning(state, t, agent, planningContext(state, t), digest)
    saveState(name, state)
    emit(name, 'task_planning', id, { planner: agent, round: t.planningAttempts.length,
      ...(discovery ? { discoveryQuestions: discovery.questions.length } : {}) })
    log(`[prumo] ${id} in planning (planner ${agent}, round ${t.planningAttempts.length})`)
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
    if (round.context !== planningContext(state, t)) die('task planning is stale — run plan-task again and research the current contract')
    if (t.discoveryRequired && (!t.discovery?.digest || t.discovery.digest !== discoveryDigest(t.discovery) ||
        round.discoveryDigest !== t.discovery.digest || t.discovery.context !== round.context ||
        t.discovery.attempt !== round.attempt))
      die('task planning used stale discovery — run plan-task with the current discovery context')
    if (t.deps.some(dep => !['done', 'skipped'].includes(state.tasks[dep]?.state))) die('planning dependencies are no longer complete')
    let plan
    try {
      plan = JSON.parse(readFileSync(resolve(args.plan), 'utf8'))
      assertTaskPlan(t, plan)
    } catch (error) { die(error.message) }
    const artifact = Object.fromEntries(['research', 'decisions', 'steps', 'verification', 'openQuestions'].map(field => [field, plan[field]]))
    t.taskPlan = { ...artifact, planner: t.planner, startedAt: round.startedAt, completedAt: new Date().toISOString(),
      context: round.context, scope: planningContext(state, t, { scopeOnly: true }), attempt: round.attempt,
      ...(round.discoveryDigest ? { discoveryDigest: round.discoveryDigest } : {}) }
    t.planningHistory.push(t.taskPlan)
    delete t.retryPlan
    closePlanning(t, 'planned')
    t.state = t.planningReturn ? 'blocked' : 'pending'
    if (t.planningReturn) {
      Object.assign(t, t.planningReturn)
      delete t.planningReturn
    }
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
    if (!hasCurrentTaskPlan(state, t)) die(id + ' needs completed current planning — run plan-task and finish-planning before start')
    try { validationContract(t) } catch (error) {
      die(`${id} has an invalid legacy validation contract: ${error.message} — correct the approved plan and run sync-plan before start`)
    }
    assertAvailable(state, t, 'running', agent)
    let inputReceipt
    if (t.taskPlan?.phaseId) {
      try { inputReceipt = executionInputReceipt(state, t) } catch (error) { die(error.message) }
    }
    t.state = 'running'
    t.agent = agent
    t.attempts.push({ n: t.attempts.length + 1, agent, startedAt: new Date().toISOString(),
      ...(t.retryPlan?.attempt === t.attempts.length + 1 ? {
        planSourceAttempt: t.retryPlan.planSourceAttempt,
        correctionOf: t.retryPlan.failedAttempt, correctionReason: t.retryPlan.reason,
      } : {}), ...(inputReceipt ? { inputReceipt: inputReceipt.inputs, inputDigest: inputReceipt.digest } : {}) })
    const total = t.taskPlan?.steps?.length
    if (total) t.attempts.at(-1).executionStep = 1
    saveState(name, state)
    emit(name, 'task_start', id, { agent, attempt: t.attempts.length, ...(total ? { current: 1, total } : {}) })
    log(`[prumo] ${id} running (agent ${agent}, attempt ${t.attempts.length})`)
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
    if (current === attempt.executionStep) return
    attempt.executionStep = current
    saveState(name, state)
    emit(name, 'task_progress', id, { agent: t.agent, attempt: t.attempts.length, current, total })
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
    saveState(name, state)
    emit(name, 'task_review', id, { reviewer, attempt: t.attempts.length })
    log(`[prumo] ${id} in review (reviewer ${reviewer})`)
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
    Object.assign(task, changes)
    task.contractRevision = (task.contractRevision ?? 0) + 1
    saveState(name, state)
    emit(name, 'task_contract_refreshed', id, { revision: task.contractRevision, attempt: task.attempts.length, state: task.state, source: resolve(source) })
    log('[prumo] ' + id + ' contract refreshed; state ' + task.state + ', attempt ' + task.attempts.length + ' preserved; previous validation receipts are stale')
  },

  async validate() {
    const name = runName()
    const id = args._[0] ?? die('validate <task> --ok|--failed --evidence "<text>" [--cwd <project>]')
    const requestedOk = args.ok === true ? true : args.failed === true ? false : die('pass --ok or --failed')
    if (typeof args.evidence !== 'string' || !args.evidence.trim()) die('validation evidence must not be empty')
    const token = randomUUID()
    const snapshot = withLock(name, () => {
      const state = loadState(name)
      const t = getTask(state, id)
      if (t.state !== 'running' && t.state !== 'reviewing') die(id + ' is not running or reviewing')
      if (requestedOk) {
        assertCurrentTaskScope(state, t)
        assertCurrentExecutionInputs(state, t)
      }
      const by = t.state === 'reviewing' ? 'review' : 'executor'
      if (requestedOk && (t.requireReview ?? state.plan.requireReview) !== false &&
          (by !== 'review' || !t.reviewer || t.reviewer === t.agent))
        die('passing validation requires an independent reviewer')
      if (requestedOk) {
        try { validationDirectories(t, args.cwd) } catch (error) { die(error.message) }
      }
      // Invalidate any previous pass before running commands, including on interruption.
      t.validations.push({ ok: false, by, agent: by === 'review' ? t.reviewer : t.agent,
        evidence: args.evidence, at: new Date().toISOString(), attempt: t.attempts.length, token,
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
                (current.stateRevision ?? 0) !== (snapshot.stateRevision ?? 0)) return
            emit(name, 'task_check', id, { ...check, token, attempt: snapshot.attempts.length,
              by: snapshot.validations.at(-1).by })
          })
        })
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
          (t.stateRevision ?? 0) !== (snapshot.stateRevision ?? 0) ||
          JSON.stringify([t.validation, t.validationMode, t.inspectionReason]) !==
          JSON.stringify([snapshot.validation, snapshot.validationMode, snapshot.inspectionReason]))
        die('task changed during validation; result discarded — validate the current attempt again')
      if (requestedOk) assertCurrentExecutionInputs(state, t)
      Object.assign(last, result, { ok: requestedOk && !error, error, at: new Date().toISOString() })
      saveState(name, state)
      emit(name, 'task_validate', id, { ok: last.ok, by: last.by, evidence: last.evidence, error })
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
    t.state = 'done'
    t.attempts.at(-1).endedAt = new Date().toISOString()
    t.attempts.at(-1).result = 'done'
    saveState(name, state)
    emit(name, 'task_done', id, { agent: t.agent })
    const unlocked = Object.values(derive(state)).filter(
      (o) => ['ready_to_plan', 'ready'].includes(o.effective) && o.deps.includes(id),
    )
    log(`[prumo] ${id} done${unlocked.length ? ` — unlocked: ${unlocked.map((u) => u.id).join(', ')}` : ''}`)
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
    if (state.plan.source && existsSync(state.plan.source)) {
      const { plan } = readPlan(state.plan.source, state)
      const currentGlobal = globalPlanValues(state.plan)
      const approvedGlobal = globalPlanValues(plan)
      const globalChanges = GLOBAL_PLAN_FIELDS.filter(field => JSON.stringify(currentGlobal[field]) !== JSON.stringify(approvedGlobal[field]))
      const approved = plan.tasks.find((candidate) => candidate.id === id)
      if (!approved) die(`approved plan no longer contains ${id} — inspect it before retry`)
      const next = taskFromPlan(approved)
      const changed = TASK_CONTRACT_FIELDS.filter((field) => JSON.stringify(t[field]) !== JSON.stringify(next[field]))
      if (changed.length) die(`${id} contract differs from the approved plan (${changed.join(', ')}) — run sync-plan and inspect the persisted contract before retry`)
      if (globalChanges.length)
        die(`${id} global plan decisions differ from the approved plan (${globalChanges.join(', ')}) — run sync-plan and inspect the persisted plan before retry`)
    }
    const cap = t.maxAttempts ?? MAX_ATTEMPTS_SOFT
    if (t.attempts.length >= cap && !args.force)
      die(`${id} already has ${t.attempts.length} attempts (cap ${cap}) — escalate instead, or --force`)
    const failed = t.attempts.at(-1)
    const planSourceAttempt = t.taskPlan?.attempt
    const reuse = Boolean(t.planningRequired && failed?.failedFrom === 'reviewing' && !failed.planDefect &&
      typeof failed.reason === 'string' && failed.reason.trim() && Number.isSafeInteger(planSourceAttempt) &&
      hasCurrentTaskScope(state, t, planSourceAttempt))
    if (reuse) {
      const attempt = t.attempts.length + 1
      t.retryPlan = {
        planSourceAttempt, failedAttempt: t.attempts.length, attempt, reason: failed.reason,
        discoveryDigest: t.discovery?.digest, planContext: t.taskPlan.context, planScope: t.taskPlan.scope,
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
    emit(name, 'task_retry', id, { nextAttempt: t.attempts.length + 1, reusedPlan: Boolean(reuse),
      ...(reuse ? { reason: failed.reason, planSourceAttempt, failedAttempt: t.attempts.length } : {}) })
    log(`[prumo] ${id} back to pending (attempt ${t.attempts.length + 1} when started; ${reuse ? 'approved plan reused' : 'planning required'})`)
  },

  block() {
    const name = runName()
    const id = args._[0] ?? die('block <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    if (['done', 'skipped'].includes(t.state)) die('completed tasks cannot be paused')
    const alreadyBlocked = t.state === 'blocked'
    if (t.state === 'planning') closePlanning(t, 'blocked')
    if (t.state === 'discussing') closeDiscussion(t, 'blocked')
    if (!alreadyBlocked) t.stateBeforeBlock = t.state
    t.stateRevision = (t.stateRevision ?? 0) + 1
    t.state = 'blocked'
    t.blockReason = args.reason ?? ''
    saveState(name, state)
    emit(name, alreadyBlocked ? 'task_block_updated' : 'task_block', id, { reason: args.reason ?? '' })
    log(`[prumo] ${id} blocked: ${args.reason ?? ''}`)
  },

  unblock() {
    const name = runName()
    const id = args._[0] ?? die('unblock <task> [--reviewer <agent>]')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'blocked') die(id + ' is ' + t.state + ', not blocked')
    // Legacy unstarted tasks can return to pending; never guess the phase of an existing attempt.
    const previous = t.stateBeforeBlock ?? (t.attempts.length === 0 ? 'pending' : null)
    if (!['pending', 'discussing', 'planning', 'running', 'reviewing', 'failed'].includes(previous))
      die('cannot restore stateBeforeBlock; inspect the recorded history before repairing this task')
    const handoff = args.reviewer !== undefined
    if (handoff && !['running', 'reviewing'].includes(previous))
      die('direct review requires a paused active attempt; pending/failed tasks cannot bypass start/retry')
    const target = handoff ? 'reviewing' : previous === 'discussing' ? 'pending' : previous
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
      if (handoff && reviewer !== t.reviewer) {
        t.reviewer = reviewer
        attempt.reviewer = reviewer
        attempt.reviewStartedAt = new Date().toISOString()
      }
    }
    t.state = target
    delete t.blockReason
    delete t.stateBeforeBlock
    saveState(name, state)
    emit(name, 'task_unblock', id, { state: target, agent: target === 'reviewing' ? t.reviewer : target === 'planning' ? t.planner : t.agent, attempt: t.attempts.length })
    log('[prumo] ' + id + ' unblocked to ' + target + '; attempt ' + t.attempts.length + ' preserved; no agent dispatched')
  },

  skip() {
    const name = runName()
    const id = args._[0] ?? die('skip <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state === 'done') die(`${id} already done`)
    const reason = args.reason ?? ''
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
  },

  note() {
    const name = runName()
    const id = args._[0] ?? die('note <task> --text "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    t.notes.push({ text: args.text ?? '', at: new Date().toISOString() })
    saveState(name, state)
    emit(name, 'task_note', id, { text: args.text ?? '' })
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
const READ_ONLY = new Set(['runs', 'status', 'ready', 'graph'])
if (!['init', 'runs', 'migrate'].includes(cmd)) {
  const name = runName()
  if (migrationStatus(loadState(name)).needed) withLock(name, () => {
    const state = loadState(name)
    if (!migrationStatus(state).needed) return
    const task = state.tasks[args._[0]]
    const resume = task?.state === 'blocked' && cmd === 'unblock' ||
      task?.attempts?.length && ['start', 'review', 'validate', 'done', 'fail', 'retry', 'block', 'unblock', 'note', 'amend-validation'].includes(cmd)
    if (legacyExecutionPending(state) && (READ_ONLY.has(cmd) || resume || ['skip', 'sync-plan'].includes(cmd))) {
      errorLog('[prumo] Migration deferred: finish or resume started legacy tasks before planning new work')
    } else migrateState(name, { quiet: true })
  })
}
if (cmd === 'migrate' && args.check !== true) withLock(runName(), commands[cmd])
else if (READ_ONLY.has(cmd) || cmd === 'validate' || cmd === 'migrate') await commands[cmd]()
else withLock(cmd === 'init' ? (args.run ?? die('init needs --run <name>')) : runName(), commands[cmd])
