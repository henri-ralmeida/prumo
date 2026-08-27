#!/usr/bin/env node
/**
 * Graph Engine — generic task-graph execution state for agent-driven plans.
 *
 * The ENGINE is reusable and knows nothing about any particular project. What changes
 * between projects is the PLAN (a JSON file: phases + tasks + deps + how to validate).
 * The orchestrator (a human or an agent) drives it through this CLI; the dashboard
 * (serve.mjs) only READS the same state — it is observability, never a second brain.
 *
 * State lives under .specs/graph/<run>/ (gitignored scratch):
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
 *   node $ENGINE status|ready|graph [--run <name>]
 *   node $ENGINE start <task> --agent <name>   (max 3 executors)
 *   node $ENGINE review <task> --agent <name>  (hands it to a reviewer)
 *   node $ENGINE validate <task> --ok|--failed --evidence "<text>"
 *   node $ENGINE done <task>
 *   node $ENGINE fail <task> --reason "<text>"
 *   node $ENGINE retry <task> [--force]
 *   node $ENGINE block <task> --reason | unblock <task>
 *   node $ENGINE skip <task> --reason
 *   node $ENGINE note <task> --text "<text>"
 *   node $ENGINE runs
 */
import {
  mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, readdirSync,
  rmSync, statSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'

/* The project root is DISCOVERED, never assumed from where this script happens to live —
 * the skill can be installed at any depth (.claude/skills/graph-foreman/scripts/, a vendored
 * copy, a global install). GRAPH_ROOT overrides; otherwise walk up from cwd to the first
 * directory that looks like a project (.git or package.json). No marker found = refuse:
 * writing .specs/ into whatever directory happens to be above cwd is the one failure mode
 * this function exists to prevent, and it must be loud, never silent.
 */
function findRoot() {
  if (process.env.GRAPH_ROOT) {
    const r = resolve(process.env.GRAPH_ROOT)
    if (!existsSync(r)) {
      console.error(`[graph] ERROR: GRAPH_ROOT points to "${r}", which does not exist`)
      process.exit(1)
    }
    return r
  }
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      console.error(
        '[graph] ERROR: no project root found (no .git or package.json above cwd) — ' +
          'run from inside a project, or set GRAPH_ROOT',
      )
      process.exit(1)
    }
    dir = parent
  }
}

const ROOT = findRoot()
const GRAPH_DIR = join(ROOT, '.specs', 'graph')
const CURRENT_FILE = join(GRAPH_DIR, 'CURRENT')
const MAX_ATTEMPTS_SOFT = 3
const DEFAULT_MAX_PARALLEL = 4
const DEFAULT_MAX_EXECUTORS = 3   // the 4th slot is RESERVED for review
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
  console.error(`[graph] ERROR: ${msg}`)
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
  const tmp = join(dir, 'state.json.tmp')
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, join(dir, 'state.json'))
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
    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) die('plan has no tasks')
    const ids = new Set(plan.tasks.map((t) => t.id))
    for (const t of plan.tasks)
      for (const d of t.deps ?? [])
        if (!ids.has(d)) die(`task ${t.id} depends on unknown task ${d}`)
    /* The A in DAG, enforced. A cyclic plan would init fine and then deadlock in silence:
       every task on the cycle waits for the others forever and `ready` never lists them.
       Refusing here turns a mute hang into an error that names the loop. */
    {
      const depsOf = Object.fromEntries(plan.tasks.map((t) => [t.id, t.deps ?? []]))
      const state = {} // undefined = white, 1 = on current path, 2 = finished
      const path = []
      const visit = (id) => {
        if (state[id] === 2) return null
        if (state[id] === 1) return [...path.slice(path.indexOf(id)), id]
        state[id] = 1
        path.push(id)
        for (const d of depsOf[id]) {
          const cycle = visit(d)
          if (cycle) return cycle
        }
        path.pop()
        state[id] = 2
        return null
      }
      for (const t of plan.tasks) {
        const cycle = visit(t.id)
        if (cycle) die(`plan has a dependency cycle: ${cycle.join(' → ')}`)
      }
    }
    /* Two tasks that touch the same paths MUST be ordered by deps — otherwise the graph
       hands the same file to two agents at once. Only checked where `touches` is authored:
       a plan that omits it keeps the old behaviour (the dep chain is then the only guard). */
    const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]))
    for (let i = 0; i < plan.tasks.length; i++) {
      for (let j = i + 1; j < plan.tasks.length; j++) {
        const a = plan.tasks[i]
        const b = plan.tasks[j]
        if (!a.touches?.length || !b.touches?.length) continue
        if (reaches(byId, a.id, b.id) || reaches(byId, b.id, a.id)) continue
        const clash = a.touches.find((pa) => b.touches.some((pb) => pathsCollide(pa, pb)))
        if (clash && !args['allow-overlap'])
          die(
            `${a.id} and ${b.id} can run in parallel but both touch "${clash}" — ` +
              `add a dep between them (or --allow-overlap)`,
          )
      }
    }
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
      },
      createdAt: new Date().toISOString(),
      tasks: {},
    }
    for (const t of plan.tasks) {
      state.tasks[t.id] = {
        id: t.id,
        phase: t.phase ?? null,
        title: t.title,
        deps: t.deps ?? [],
        validation: t.validation ?? '',
        requireReview: t.requireReview,   // per-task override; undefined = inherit plan
        maxAttempts: t.maxAttempts,       // per-task override; undefined = soft default
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
    writeFileSync(join(dir, 'events.ndjson'), '')
    saveState(name, state)
    writeFileSync(CURRENT_FILE, name)
    emit(name, 'run_init', null, { plan: plan.name, tasks: plan.tasks.length })
    /* Run state is scratch and must never reach a commit. The engine cannot know the
       project's ignore policy, so it warns instead of editing .gitignore behind the dev. */
    if (existsSync(join(ROOT, '.git'))) {
      const gi = join(ROOT, '.gitignore')
      const ignored = existsSync(gi) && /^\.specs\/?\s*$/m.test(readFileSync(gi, 'utf8'))
      if (!ignored)
        console.warn(`[graph] WARNING: ".specs/" is not in ${gi} — add it, run state is local scratch and must never be committed`)
    }
    console.log(
      `[graph] run "${name}" initialised: ${plan.tasks.length} tasks, ` +
        `${state.plan.maxExecutors} executors + 1 review slot (cap ${state.plan.maxParallel})` +
        `${state.plan.requireReview ? ', review REQUIRED before done' : ''} — set as CURRENT`,
    )
  },

  runs() {
    if (!existsSync(GRAPH_DIR)) return console.log('(no runs)')
    for (const d of readdirSync(GRAPH_DIR)) {
      if (d === 'CURRENT') continue
      /* Probed, not caught: `loadState` answers a missing state.json with `die()`, which
         exits the process — so a `try/catch` around it can never run. `plans/` lives in
         this directory and is not a run; so does anything else a person drops here. */
      if (!existsSync(join(GRAPH_DIR, d, 'state.json'))) continue
      const s = loadState(d)
      const p = progress(s)
      console.log(`${d}  ${p.done}/${p.total} done  (updated ${s.updatedAt})`)
    }
  },

  status() {
    const name = runName()
    const state = loadState(name)
    const d = derive(state)
    const p = progress(state)
    console.log(`run: ${name}  plan: ${state.plan.name}  ${p.done}/${p.total} done`)
    console.log(`states: ${JSON.stringify(p.by)}`)
    const width = Math.max(...Object.values(d).map((t) => t.id.length))
    const row = (t) => {
      const agent = t.state === 'reviewing' ? `  @${t.reviewer} (review)` : t.agent ? `  @${t.agent}` : ''
      const attempts = t.attempts.length > 1 ? `  (attempt ${t.attempts.length})` : ''
      const wait = t.effective === 'waiting' ? `  ← ${t.blockedBy.join(',')}` : ''
      console.log(`  ${t.id.padEnd(width)}  ${t.effective.padEnd(8)}${agent}${attempts}${wait}`)
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
      console.log(`\n(no phase)`)
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
    console.log(
      `\n[graph] ${occ.executors.length}/${occ.maxExec} executors, ${occ.reviewers.length} in review ` +
        `(cap ${occ.cap}) — dispatch at most ${slots} now`,
    )
    if (occ.reviewers.length) console.log(`[graph] awaiting review: ${occ.reviewers.map((t) => `${t.id} @${t.reviewer}`).join(', ')}`)
  },

  graph() {
    const state = loadState(runName())
    console.log(JSON.stringify({ ...state, derived: derive(state), progress: progress(state) }, null, 2))
  },

  start() {
    const name = runName()
    const id = args._[0] ?? die('start <task> --agent <name>')
    const agent = args.agent ?? die('start needs --agent <name>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'pending') die(`${id} is ${t.state}, not pending`)
    const { blockedBy } = derive(state)[id]
    if (blockedBy.length && !args.force) die(`${id} still waiting on: ${blockedBy.join(', ')} (use --force)`)
    const occ = occupancy(state)
    /* Executors are capped BELOW the total so a finished task never waits for a slot to be
       verified — work done but stuck unverified is the worst state the graph can hold. */
    if (occ.executors.length >= occ.maxExec && !args.force)
      die(`${occ.executors.length} executors already running (max ${occ.maxExec}): ${occ.executors.map((x) => x.id).join(', ')} — wait for one (or --force)`)
    if (occ.busy.length >= occ.cap && !args.force)
      die(`${occ.busy.length} agents busy (cap ${occ.cap}) — wait for one (or --force)`)
    /* One agent, one task: a name on two concurrent tasks means either a mislabelled
       dispatch or one agent doing both — and then the parallelism is a fiction. */
    const busy = agentBusy(state, agent)
    if (busy && !args.force) die(`agent "${agent}" is already on ${busy.id} — one agent per task (or --force)`)
    t.state = 'running'
    t.agent = agent
    t.attempts.push({ n: t.attempts.length + 1, agent, startedAt: new Date().toISOString() })
    saveState(name, state)
    emit(name, 'task_start', id, { agent, attempt: t.attempts.length })
    console.log(`[graph] ${id} running (agent ${agent}, attempt ${t.attempts.length})`)
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
    console.log(`[graph] ${id} in review (reviewer ${reviewer})`)
  },

  validate() {
    const name = runName()
    const id = args._[0] ?? die('validate <task> --ok|--failed --evidence "<text>"')
    const ok = args.ok === true ? true : args.failed === true ? false : die('pass --ok or --failed')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'running' && t.state !== 'reviewing')
      die(`${id} is ${t.state}, not running or reviewing`)
    const by = t.state === 'reviewing' ? 'review' : 'executor'
    t.validations.push({
      ok,
      by,
      agent: by === 'review' ? t.reviewer : t.agent,
      evidence: args.evidence ?? '',
      at: new Date().toISOString(),
      attempt: t.attempts.length,
    })
    saveState(name, state)
    emit(name, 'task_validate', id, { ok, by, evidence: args.evidence ?? '' })
    console.log(`[graph] ${id} validation recorded by ${by}: ${ok ? 'OK' : 'FAILED'}`)
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
    t.state = 'done'
    t.attempts.at(-1).endedAt = new Date().toISOString()
    t.attempts.at(-1).result = 'done'
    saveState(name, state)
    emit(name, 'task_done', id, { agent: t.agent })
    const unlocked = Object.values(derive(state)).filter(
      (o) => o.effective === 'ready' && o.deps.includes(id),
    )
    console.log(`[graph] ${id} done${unlocked.length ? ` — unlocked: ${unlocked.map((u) => u.id).join(', ')}` : ''}`)
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
    console.log(`[graph] ${id} failed (attempt ${t.attempts.length}): ${args.reason ?? ''}`)
  },

  retry() {
    const name = runName()
    const id = args._[0] ?? die('retry <task>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'failed') die(`${id} is ${t.state}, not failed`)
    const cap = t.maxAttempts ?? MAX_ATTEMPTS_SOFT
    if (t.attempts.length >= cap && !args.force)
      die(`${id} already has ${t.attempts.length} attempts (cap ${cap}) — escalate instead, or --force`)
    t.state = 'pending'
    t.agent = null
    t.reviewer = null
    saveState(name, state)
    emit(name, 'task_retry', id, { nextAttempt: t.attempts.length + 1 })
    console.log(`[graph] ${id} back to pending (attempt ${t.attempts.length + 1} when started)`)
  },

  block() {
    const name = runName()
    const id = args._[0] ?? die('block <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    t.stateBeforeBlock = t.state
    t.state = 'blocked'
    t.blockReason = args.reason ?? ''
    saveState(name, state)
    emit(name, 'task_block', id, { reason: args.reason ?? '' })
    console.log(`[graph] ${id} blocked: ${args.reason ?? ''}`)
  },

  unblock() {
    const name = runName()
    const id = args._[0] ?? die('unblock <task>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'blocked') die(`${id} is ${t.state}, not blocked`)
    t.state = 'pending'
    delete t.blockReason
    delete t.stateBeforeBlock
    saveState(name, state)
    emit(name, 'task_unblock', id)
    console.log(`[graph] ${id} unblocked`)
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
    console.log(`[graph] ${id} skipped: ${args.reason ?? ''}`)
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
  console.error(`usage: engine.mjs <${Object.keys(commands).join('|')}> — see file header for details`)
  process.exit(1)
}

/* Readers need no lock: saveState renames a complete file into place, so a reader sees
   either the previous state or the next one, never a half-written one. Everything else
   takes the run's lock for its whole read-modify-write. */
const READ_ONLY = new Set(['runs', 'status', 'ready', 'graph'])
if (READ_ONLY.has(cmd)) commands[cmd]()
else withLock(cmd === 'init' ? (args.run ?? die('init needs --run <name>')) : runName(), commands[cmd])
