#!/usr/bin/env node
/**
 * Prumo — generic task-graph execution state for agent-driven plans.
 *
 * The ENGINE is reusable and knows nothing about any particular project. What changes
 * between projects is the PLAN (a JSON file: phases + tasks + deps + how to validate).
 * The orchestrator (a human or an agent) drives it through this CLI; the dashboard
 * (serve.mjs) only READS the same state — it is observability, never a second brain.
 *
 * State lives under ~/.local/share/graph-foreman/<workspace>/.specs/graph/<run>/:
 *   state.json     — the single source of truth (plan snapshot + per-task state)
 *   events.ndjson  — append-only history of every transition (feeds the dashboard log)
 *
 * Task lifecycle (enforced):
 *   pending ─start→ running ─review→ reviewing ─validate(ok)→ ─done→ done
 *      │                │                  │└─validate(failed)→ stays reviewing
 *      │                │└─fail→ failed ─retry→ pending
 *      │                └─(done straight from running is refused when review is required)
 *      ├─block→ blocked ─unblock→ pending
 *      └─skip→ skipped (with reason)
 *
 * AUTHOR ≠ VERIFIER: the executor writes, a REVIEWER agent bangs the gavel. `done` demands a
 * passing validation recorded during review, by an agent other than the one that did the work.
 *
 * "ready" is DERIVED, never stored: pending + every dep done/skipped.
 *
 * Usage (ENGINE = path to this file, wherever the skill is installed):
 *   node $ENGINE init --plan <plan.json> --run <name>
 *   node $ENGINE sync-plan --plan <plan.json> [--run <name>]
 *   node $ENGINE status|ready|graph [--run <name>]
 *   node $ENGINE start <task> --agent <name>   (max 3 executors)
 *   node $ENGINE review <task> --agent <name>  (hands it to a reviewer)
 *   node $ENGINE validate <task> --ok|--failed --evidence "<text>" [--cwd <project>]
 *   node $ENGINE refresh-contract <task> --plan <approved-plan.json>
 *   node $ENGINE done <task>
 *   node $ENGINE fail <task> --reason "<text>"
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
import { runValidation, assertValidation, validationContract, validationDirectories } from './validation.mjs'
import { join, resolve } from 'node:path'

import { findRoot } from './storage.mjs'
import { log, errorLog, tr } from './i18n.mjs'

let ROOT
try { ROOT = findRoot() } catch (error) { errorLog('[prumo] ERROR: ' + error.message); process.exit(1) }
const GRAPH_DIR = join(ROOT, '.specs', 'graph')
const CURRENT_FILE = join(GRAPH_DIR, 'CURRENT')
const MAX_ATTEMPTS_SOFT = 3
const DEFAULT_MAX_PARALLEL = 4
const DEFAULT_MAX_EXECUTORS = 3   // the 4th slot is RESERVED for review
const TASK_CONTRACT_FIELDS = ['phase', 'title', 'deps', 'validation', 'validationMode', 'inspectionReason', 'requireReview', 'maxAttempts', 'tags', 'touches']
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
  for (const t of plan.tasks) {
    if (!t.id || !t.title) die('every task needs id and title')
    if (ids.has(t.id)) die(`duplicate task id ${t.id}`)
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
  validatePlan(plan, args['allow-overlap'] === true, historicalTasks(state))
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
    agent: null,
    reviewer: null,
    attempts: [],
    validations: [],
    notes: [],
  }
}

function planTaskFromState(t) {
  return {
    id: t.id,
    phase: t.phase,
    title: t.title,
    deps: t.deps,
    validation: t.validation,
    validationMode: t.validationMode,
    inspectionReason: t.inspectionReason,
    requireReview: t.requireReview,
    maxAttempts: t.maxAttempts,
    tags: t.tags,
    touches: t.touches,
  }
}

/** Derived view: effective state per task (ready is computed, never stored). */
export function derive(state) {
  const out = {}
  for (const [id, t] of Object.entries(state.tasks)) {
    let effective = t.state
    let blockedBy = []
    if (t.state === 'pending') {
      blockedBy = t.deps.filter((d) => {
        const dep = state.tasks[d]
        return !dep || (dep.state !== 'done' && dep.state !== 'skipped')
      })
      effective = blockedBy.length === 0 ? 'ready' : 'waiting'
    }
    out[id] = { ...t, effective, blockedBy }
  }
  return out
}

/** Who is busy right now, split by role — the cap is enforced per role, not in bulk. */
function occupancy(state) {
  const all = Object.values(state.tasks)
  const executors = all.filter((t) => t.state === 'running')
  const reviewers = all.filter((t) => t.state === 'reviewing')
  return {
    executors,
    reviewers,
    busy: [...executors, ...reviewers],
    maxExec: state.plan.maxExecutors ?? DEFAULT_MAX_EXECUTORS,
    cap: state.plan.maxParallel ?? DEFAULT_MAX_PARALLEL,
  }
}

/** An agent name may hold only one task at a time, whatever the role. */
function agentBusy(state, agent) {
  return occupancy(state).busy.find((t) => (t.state === 'reviewing' ? t.reviewer : t.agent) === agent)
}

// Starting and resuming both acquire a slot; a paused task no longer owns one.
function assertAvailable(state, task, role, agent) {
  if (typeof agent !== 'string' || !agent.trim()) die('active work needs a recorded agent')
  const blockedBy = task.deps.filter((id) => !['done', 'skipped'].includes(state.tasks[id]?.state))
  if (blockedBy.length && !args.force) die(task.id + ' still waiting on: ' + blockedBy.join(', '))
  const occ = occupancy(state)
  if (role === 'running' && occ.executors.length >= occ.maxExec && !args.force)
    die(occ.executors.length + ' executors already running (max ' + occ.maxExec + ')')
  if (occ.busy.length >= occ.cap && !args.force)
    die(occ.busy.length + ' agents busy (cap ' + occ.cap + ')')
  const busy = agentBusy(state, agent)
  if (busy && !args.force) die('agent "' + agent + '" is already on ' + busy.id + ' — one agent per task')
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
      run: name,
      plan: {
        name: plan.name,
        description: plan.description ?? '',
        phases: plan.phases ?? [],
        maxParallel: plan.maxParallel ?? DEFAULT_MAX_PARALLEL,
        maxExecutors: plan.maxExecutors ?? DEFAULT_MAX_EXECUTORS,
        requireReview: plan.requireReview !== false,
        source,
      },
      createdAt: new Date().toISOString(),
      tasks: {},
    }
    for (const t of plan.tasks) state.tasks[t.id] = taskFromPlan(t)
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

  'sync-plan'() {
    const name = runName()
    const state = loadState(name)
    const planPath = args.plan ?? state.plan.source ?? die('sync-plan needs --plan <plan.json> once')
    const { plan, source } = readPlan(planPath, state)
    const removed = Object.keys(state.tasks).filter((id) => !plan.tasks.some((t) => t.id === id))
    if (removed.length) die(`sync-plan is additive: plan removed ${removed.join(', ')}`)

    const mutableStates = new Set(['pending', 'failed', 'blocked'])
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
      source,
    }
    const planChanged = JSON.stringify(state.plan) !== JSON.stringify(nextPlan)
    if (!added.length && !updated.length && !planChanged) {
      if (preserved.length)
        log(`[prumo] no state changes; plan differs for preserved tasks: ${preserved.join(', ')}. Use refresh-contract for an approved validation change; do not fail/retry completed work to refresh a contract.`)
      else log(`[prumo] run "${name}" already matches plan (${Object.keys(state.tasks).length} tasks)`)
      return
    }

    copyFileSync(join(runDir(name), 'state.json'), join(runDir(name), 'state.pre-sync.json'))
    state.plan = nextPlan
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
      log(`${d}  ${p.done}/${p.total} done  (updated ${s.updatedAt})`)
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
      const agent = t.state === 'reviewing' ? `  @${t.reviewer} (review)` : t.agent ? `  @${t.agent}` : ''
      const attempts = t.attempts.length > 1 ? `  (attempt ${t.attempts.length})` : ''
      const wait = t.effective === 'waiting' ? `  ← ${t.blockedBy.join(',')}` : ''
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
    const list = Object.values(d).filter((t) => t.effective === 'ready')
    for (const t of list) console.log(`${t.id}  ${t.title}`)
    const slots = Math.max(0, Math.min(occ.maxExec - occ.executors.length, occ.cap - occ.busy.length))
    log(
      `\n[prumo] ${occ.executors.length}/${occ.maxExec} executors, ${occ.reviewers.length} in review ` +
        `(cap ${occ.cap}) — dispatch at most ${slots} now`,
    )
    if (occ.reviewers.length) log(`[prumo] awaiting review: ${occ.reviewers.map((t) => `${t.id} @${t.reviewer}`).join(', ')}`)
  },

  graph() {
    const state = loadState(runName())
    console.log(JSON.stringify({ ...state, derived: derive(state), progress: progress(state) }, null, 2))
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
    try { validationContract(t) } catch (error) {
      die(`${id} has an invalid legacy validation contract: ${error.message} — correct the approved plan and run sync-plan before start`)
    }
    assertAvailable(state, t, 'running', agent)
    t.state = 'running'
    t.agent = agent
    t.attempts.push({ n: t.attempts.length + 1, agent, startedAt: new Date().toISOString() })
    saveState(name, state)
    emit(name, 'task_start', id, { agent, attempt: t.attempts.length })
    log(`[prumo] ${id} running (agent ${agent}, attempt ${t.attempts.length})`)
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
    if (reviewer === t.agent && !args.force)
      die(`"${reviewer}" wrote ${id} — a reviewer must be a different agent (or --force)`)
    /* No cap check here on purpose: the task ALREADY holds a slot as `running`, so moving
       it to `reviewing` is a role handoff, not a new agent. Review is therefore never
       blocked by capacity — a finished task can always be judged immediately, which is the
       whole reason executors are capped below the total. */
    const busy = agentBusy(state, reviewer)
    if (busy && !args.force) die(`agent "${reviewer}" is already on ${busy.id} — one agent per task (or --force)`)
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
      const by = t.state === 'reviewing' ? 'review' : 'executor'
      if (requestedOk && (t.requireReview ?? state.plan.requireReview) !== false &&
          (by !== 'review' || !t.reviewer || t.reviewer === t.agent))
        die('passing validation requires an independent reviewer')
      if (requestedOk) {
        try { validationDirectories(t, args.cwd) } catch (error) { die(error.message) }
      }
      // Invalidate any previous pass before running commands, including on interruption.
      t.validations.push({ ok: false, by, agent: by === 'review' ? t.reviewer : t.agent,
        evidence: args.evidence, at: new Date().toISOString(), attempt: t.attempts.length, token })
      saveState(name, state)
      emit(name, 'task_validation_started', id, { token, attempt: t.attempts.length })
      return t
    })
    // Tests must not hold the run lock: other tasks and the dashboard remain usable.
    let result = {}
    let error = null
    if (requestedOk) {
      try {
        result = await runValidation(snapshot, args.cwd, snapshot.validations.at(-2))
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
    const last = t.validations.at(-1)
    if (!last || !last.ok || last.attempt !== t.attempts.length)
      die(`${id} has no passing validation for the current attempt — validate first`)
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
      (o) => o.effective === 'ready' && o.deps.includes(id),
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
    t.state = 'failed'
    const a = t.attempts.at(-1)
    a.endedAt = new Date().toISOString()
    a.result = 'failed'
    a.reason = args.reason ?? ''
    saveState(name, state)
    emit(name, 'task_fail', id, { reason: args.reason ?? '', attempt: t.attempts.length })
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
      const approved = plan.tasks.find((candidate) => candidate.id === id)
      if (!approved) die(`approved plan no longer contains ${id} — inspect it before retry`)
      const next = taskFromPlan(approved)
      const changed = TASK_CONTRACT_FIELDS.filter((field) => JSON.stringify(t[field]) !== JSON.stringify(next[field]))
      if (changed.length) die(`${id} contract differs from the approved plan (${changed.join(', ')}) — run sync-plan and inspect the persisted contract before retry`)
    }
    const cap = t.maxAttempts ?? MAX_ATTEMPTS_SOFT
    if (t.attempts.length >= cap && !args.force)
      die(`${id} already has ${t.attempts.length} attempts (cap ${cap}) — escalate instead, or --force`)
    t.state = 'pending'
    t.agent = null
    t.reviewer = null
    saveState(name, state)
    emit(name, 'task_retry', id, { nextAttempt: t.attempts.length + 1 })
    log(`[prumo] ${id} back to pending (attempt ${t.attempts.length + 1} when started)`)
  },

  block() {
    const name = runName()
    const id = args._[0] ?? die('block <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    if (['done', 'skipped'].includes(t.state)) die('completed tasks cannot be paused')
    const alreadyBlocked = t.state === 'blocked'
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
    if (!['pending', 'running', 'reviewing', 'failed'].includes(previous))
      die('cannot restore stateBeforeBlock; inspect the recorded history before repairing this task')
    const handoff = args.reviewer !== undefined
    if (handoff && !['running', 'reviewing'].includes(previous))
      die('direct review requires a paused active attempt; pending/failed tasks cannot bypass start/retry')
    const target = handoff ? 'reviewing' : previous
    const reviewer = handoff ? args.reviewer : t.reviewer
    if (target === 'running' || target === 'reviewing') {
      const attempt = t.attempts.at(-1)
      if (!attempt || attempt.endedAt || attempt.result || !t.agent || attempt.agent !== t.agent)
        die('cannot resume without an open attempt and its original executor')
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
    emit(name, 'task_unblock', id, { state: target, agent: target === 'reviewing' ? t.reviewer : t.agent, attempt: t.attempts.length })
    log('[prumo] ' + id + ' unblocked to ' + target + '; attempt ' + t.attempts.length + ' preserved; no agent dispatched')
  },

  skip() {
    const name = runName()
    const id = args._[0] ?? die('skip <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state === 'done') die(`${id} already done`)
    t.state = 'skipped'
    t.skipReason = args.reason ?? ''
    saveState(name, state)
    emit(name, 'task_skip', id, { reason: args.reason ?? '' })
    log(`[prumo] ${id} skipped: ${args.reason ?? ''}`)
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
if (READ_ONLY.has(cmd) || cmd === 'validate') await commands[cmd]()
else withLock(cmd === 'init' ? (args.run ?? die('init needs --run <name>')) : runName(), commands[cmd])
