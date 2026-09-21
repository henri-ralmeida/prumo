#!/usr/bin/env node
/**
 * Prumo — observability server. It renders state.json without writing it. Optional
 * --sync-plan delegates approved plan reconciliation to engine.mjs, the only state writer.
 * Kill it and execution is unaffected.
 *
 * Usage: node <skill>/scripts/serve.mjs [--port 4949] [--run <name>] [--sync-plan]
 * Then open http://localhost:4949
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE = join(HERE, 'engine.mjs')

import { findRoot, storageHome, graphRoots as listRoots, globalGraphRoots } from './storage.mjs'
import { language, localizeDashboard, log, errorLog, tr } from './i18n.mjs'
import { discoveryDigest, hasCurrentTaskPlan, phasePlanningContext, planningContext, usesCurrentPlanning } from './validation.mjs'
import { dashboardDiagnostics } from './dashboard-diagnostics.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const PORT = Number(flag('port', 4949))
const RUN_FLAG = flag('run', null)
const SYNC_PLAN = argv.includes('--sync-plan')
const GLOBAL = argv.includes('--global')
if (GLOBAL && SYNC_PLAN) {
  errorLog('[prumo] ERROR: --global is read-only and cannot be combined with --sync-plan')
  process.exit(1)
}

let ROOT = null
if (!GLOBAL) try { ROOT = findRoot() } catch (error) { errorLog('[prumo] ERROR: ' + error.message); process.exit(1) }
const GRAPH_DIR = ROOT && join(ROOT, '.specs', 'graph')
const ROOT_NAME = ROOT && basename(ROOT)
const INDEX_ROOT = storageHome()

/* The run name reaches join() as a path segment, so it is allowlisted, never trusted:
 * plain slug, no leading dot, no separators. Applies to ?run=, --run and CURRENT alike. */
function safeRun(name) {
  return name && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : null
}

function graphRoots() {
  return GLOBAL ? globalGraphRoots() : { roots: listRoots(ROOT, INDEX_ROOT), warnings: [] }
}

function currentRun(root = ROOT) {
  if (root === ROOT && RUN_FLAG) return safeRun(RUN_FLAG)
  const p = join(root, '.specs', 'graph', 'CURRENT')
  return existsSync(p) ? safeRun(readFileSync(p, 'utf8').trim()) : null
}

function catalog() {
  const { roots, warnings } = graphRoots()
  const runs = []
  let selected = GLOBAL ? null : { root: roots.find(candidate => candidate.path === ROOT), run: currentRun() }
  let newest = -1
  for (const root of roots) {
    let entries
    try { entries = readdirSync(root.graphDir, { withFileTypes: true }) }
    catch { warnings.push(`Could not read graph directory: ${root.graphDir}`); continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeRun(entry.name)) continue
      const statePath = join(root.graphDir, entry.name, 'state.json')
      if (!existsSync(statePath)) continue
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8'))
        runs.push({
          root: root.name,
          run: entry.name,
          plan: state.plan?.name ?? '',
          updatedAt: state.updatedAt ?? statSync(statePath).mtime.toISOString(),
        })
      } catch { /* one damaged run must not hide the others */ }
    }
    if (GLOBAL) {
      const currentPath = join(root.graphDir, 'CURRENT')
      if (!existsSync(currentPath)) continue
      try {
        const run = safeRun(readFileSync(currentPath, 'utf8').trim())
        if (!run) {
          warnings.push(`Ignored invalid CURRENT in ${root.path}`)
          continue
        }
        const statePath = join(root.graphDir, run, 'state.json')
        if (!existsSync(statePath)) {
          warnings.push(`Ignored CURRENT without state in ${root.path}: ${run}`)
          continue
        }
        JSON.parse(readFileSync(statePath, 'utf8'))
        const modified = statSync(currentPath).mtimeMs
        if (modified > newest) { newest = modified; selected = { root, run } }
      } catch { warnings.push(`Ignored invalid CURRENT in ${root.path}`) }
    }
  }
  runs.sort((a, b) => a.run.localeCompare(b.run))
  return { roots, warnings, currentRoot: selected?.root?.name ?? null, current: selected?.run ?? null, runs }
}

function listRuns() {
  const { currentRoot, current, runs, warnings } = catalog()
  return { currentRoot, current, runs, warnings }
}

function selectedGraph(url) {
  const snapshot = catalog()
  const requestedRoot = url.searchParams.get('root')
  const root = requestedRoot === null
    ? snapshot.roots.find(candidate => candidate.name === snapshot.currentRoot)
    : snapshot.roots.find(candidate => candidate.name === requestedRoot)
  if (!root) return null
  const requestedRun = url.searchParams.get('run')
  if (requestedRun !== null && !safeRun(requestedRun)) return null
  return { graphDir: root.graphDir, run: safeRun(requestedRun) ?? currentRun(root.path) }
}

let lastPlanSignature = null
let planSyncing = false
function syncPlanIfChanged() {
  if (!SYNC_PLAN) return
  const run = currentRun()
  if (!run) return
  const statePath = join(GRAPH_DIR, run, 'state.json')
  if (!existsSync(statePath)) return
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const planPath = state.plan?.source
  if (!planPath || !existsSync(planPath)) return
  const signature = `${run}:${planPath}:${statSync(planPath).mtimeMs}`
  if (signature === lastPlanSignature || planSyncing) return
  planSyncing = true
  execFile(
    process.execPath,
    [ENGINE, 'sync-plan', '--run', run, '--plan', planPath],
    { cwd: ROOT, env: { ...process.env, GRAPH_ROOT: ROOT, PRUMO_ROOT: ROOT, PRUMO_LANG: 'en' }, encoding: 'utf8' },
    (error, stdout, stderr) => {
      planSyncing = false
      if (error) return errorLog(`[prumo] auto-sync failed: ${(stderr || stdout || error.message).trim()}`)
      lastPlanSignature = signature
      const message = stdout.trim()
      if (message && !message.includes('already matches plan')) log(message)
    },
  )
}

if (SYNC_PLAN) {
  const sync = () => {
    try { syncPlanIfChanged() }
    catch (error) { errorLog(`[prumo] auto-sync failed: ${error.message}`) }
  }
  sync()
  setInterval(sync, 1000)
}

/** Same derivation the engine uses — duplicated on purpose so this stays dependency-free
 *  read-only (importing engine.mjs would run its CLI arg handling). Keep in sync. */
function phaseTargets(state, phaseId) {
  return Object.values(state.tasks).filter(task => task.phase === phaseId && !['done', 'skipped'].includes(task.state) &&
    usesCurrentPlanning(state, task) &&
    !(task.taskPlan?.phaseId === phaseId && hasCurrentTaskPlan(state, task)))
}

function phasePlanningBlockers(state, phaseId) {
  const blockers = new Set()
  for (const task of Object.values(state.tasks).filter(task => task.phase === phaseId)) {
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

function phaseContext(state, phaseId, targets = phaseTargets(state, phaseId)) {
  return JSON.stringify([state.plan.name, state.plan.description, state.plan.planningRevision ?? 0, phaseId,
    targets.map(task => [task.id, phasePlanningContext(state, task)]).sort()])
}

function currentPhaseDiscussion(state, phase) {
  const round = phase?.discussionAttempts?.at(-1)
  const targets = round?.targets?.map(id => state.tasks[id]).filter(Boolean)
  if (round?.result !== 'discussed' || targets?.length !== round.targets.length ||
      !phaseTargets(state, phase.id).every(task => round.targets.includes(task.id))) return false
  const context = phaseContext(state, phase.id, targets)
  return round.context === context && phase.discovery?.context === context && phase.discovery?.roundId === round.roundId &&
    phase.discovery?.nonce === round.nonce && phase.discovery?.digest === round.discoveryDigest &&
    phase.discovery.digest === discoveryDigest(phase.discovery)
}

function currentPhasePlanning(state, phase, round = phase?.planningAttempts?.at(-1)) {
  if (!round || round.endedAt || !Array.isArray(round.targets)) return false
  const discussion = phase?.discussionAttempts?.at(-1)
  const targets = round.targets.map(id => state.tasks[id]).filter(Boolean)
  const liveTargets = phaseTargets(state, phase.id).map(task => task.id).sort()
  return discussion?.roundId === round.discussionRoundId && currentPhaseDiscussion(state, phase) &&
    targets.length === round.targets.length && JSON.stringify([...round.targets].sort()) === JSON.stringify(liveTargets) &&
    round.context === phaseContext(state, phase.id, discussion.targets.map(id => state.tasks[id])) &&
    round.discoveryDigest === phase.discovery?.digest
}

function currentDiscussion(state, task) {
  const round = task.discussionAttempts?.at(-1)
  return round?.result === 'discussed' && round.context === planningContext(state, task) &&
    round.attempt === task.attempts.length + (task.planningReturn ? 0 : 1) &&
    task.discovery?.roundId === round.roundId && task.discovery?.nonce === round.nonce &&
    task.discovery?.digest === round.discoveryDigest && task.discovery.digest === discoveryDigest(task.discovery)
}

function derive(state) {
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
      const phaseAdopted = !(state.legacyPhaseAdoption && !phase?.adoptedLegacy)
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
            (currentPhaseDiscussion(state, phase) ? 'ready_to_plan' : 'ready_for_discussion')
      } else {
        effective = blockedBy.length ? 'waiting' : !phaseAdopted ? 'pending' :
          hasCurrentTaskPlan(state, t) ? 'ready' :
            t.discussionRequired && !currentDiscussion(state, t) ? 'ready_for_discussion' : 'ready_to_plan'
      }
    }
    const planningStatus = !usesCurrentPlanning(state, t) ? 'legacy_lifecycle' :
      state.legacyPhaseAdoption && !phase?.adoptedLegacy ? 'awaiting_phase_adoption' : hasCurrentTaskPlan(state, t) ? 'planned' :
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
    out[id] = { effective, blockedBy,
      ...(showPlanningStatus ?
        { planningStatus, ...(planningBlockedBy.length ? { planningBlockedBy } : {}), ...(inputStatus ? { inputStatus } : {}) } : {}) }
    if (migrationPending && t.state === 'pending' && usesCurrentPlanning(state, t))
      Object.assign(out[id], { effective: 'pending', planningStatus: 'awaiting_migration' })
  }
  return out
}

function json(res, code, body) {
  const content = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(content)
}

function productVersion() {
  for (const path of [join(HERE, '..', 'package.json'), join(HERE, '..', '.prumo-install.json')]) {
    try {
      const metadata = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof metadata.version === 'string') return metadata.version
    } catch { /* try the next package layout */ }
  }
  return 'unknown'
}

const VERSION = productVersion()
const diagnostic = GLOBAL ? dashboardDiagnostics({ version: VERSION, port: PORT }) : () => {}
diagnostic('startup', { node: process.version, platform: process.platform })
const EMPTY_STATE = { plan: { name: '', phases: [] }, tasks: {}, derived: {}, empty: true }

const server = createServer((req, res) => {
  try {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname === '/api/runs') return json(res, 200, listRuns())
  if (url.pathname === '/api/health') return json(res, 200, {
    product: 'prumo', version: VERSION, pid: process.pid, mode: GLOBAL ? 'global' : 'workspace',
    readOnly: true, host: '127.0.0.1', port: server.address().port,
  })

  const selected = selectedGraph(url)
  const run = selected?.run

  if (url.pathname === '/api/state') {
    if (!run) {
      if (GLOBAL && !url.searchParams.has('root') && !url.searchParams.has('run')) return json(res, 200, EMPTY_STATE)
      return json(res, 404, { error: tr('no run') })
    }
    const p = join(selected.graphDir, run, 'state.json')
    if (!existsSync(p)) return json(res, 404, { error: tr(`run "${run}" not found`) })
    const state = JSON.parse(readFileSync(p, 'utf8'))
    return json(res, 200, { ...state, derived: derive(state) })
  }

  if (url.pathname === '/api/events') {
    if (!run) {
      if (GLOBAL && !url.searchParams.has('root') && !url.searchParams.has('run')) return json(res, 200, { events: [] })
      return json(res, 404, { error: 'no run' })
    }
    const p = join(selected.graphDir, run, 'events.ndjson')
    if (!existsSync(p)) return json(res, 200, { events: [] })
    const limit = Number(url.searchParams.get('limit') ?? 300)
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    return json(res, 200, { events: lines.slice(-limit).map((l) => JSON.parse(l)) })
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const page = localizeDashboard(readFileSync(join(HERE, 'dashboard.html'), 'utf8'), language(flag('lang', undefined)))
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      /* Backstop for the dashboard's own escaping: state.json free text is agent-authored,
       * and if any of it ever slipped into markup unescaped, this stops the page from
       * reaching anything beyond its own origin — no external scripts, no cross-origin
       * fetch (a different localhost PORT is a different origin), no remote images.
       * 'unsafe-inline' is required: the dashboard is a single self-contained file. */
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
    })
    return res.end(page)
  }

  res.writeHead(404)
  res.end(tr('not found'))
  /* A corrupt state.json (or a mid-write read) must cost one response, never the process. */
  } catch (e) {
    if (res.headersSent) res.destroy()
    else json(res, 500, { error: String(e?.message ?? e) })
  }
/* Loopback ONLY: this is a read-only dashboard for the dev's own browser. Binding every
 * interface would expose run state to the local network for no benefit. */
}).listen(PORT, '127.0.0.1', () => {
  diagnostic('listening', { port: server.address().port })
  let selected
  try { selected = GLOBAL ? catalog().current : currentRun() }
  catch (error) { errorLog(`[prumo] Could not read current run: ${error.message}`) }
  log(
    `[prumo] dashboard on http://localhost:${server.address().port} (run: ${selected ?? '—'}, ` +
      `auto-sync: ${SYNC_PLAN ? 'on' : 'off'})`,
  )
}).on('error', (e) => {
  diagnostic('server-error', { code: e.code, message: e.message })
  /* A taken port is the NORMAL second-run case (the previous dashboard is still up and
     already follows CURRENT) — say that, instead of dying with a stack trace. */
  if (e.code === 'EADDRINUSE') {
    errorLog(
      `[prumo] port ${PORT} is already in use — an earlier dashboard is likely still serving ` +
        `http://localhost:${PORT} (it follows CURRENT). To run a SECOND one: --port <other>` +
        `${RUN_FLAG ? '' : ' (add --run <name> to pin it to one run)'}`,
    )
    process.exit(1)
  }
  throw e
})
