#!/usr/bin/env node
/**
 * Graph Engine — observability server. READ-ONLY: it renders the same state.json the
 * orchestrator writes through engine.mjs; it never mutates anything and never decides
 * anything. Kill it and the execution is unaffected.
 *
 * Usage: node <skill>/scripts/serve.mjs [--port 4949] [--run <name>]
 * Then open http://localhost:4949
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/* Same discovery as engine.mjs (duplicated on purpose — importing the engine would run
 * its CLI arg handling). GRAPH_ROOT overrides; otherwise walk up from cwd to the first
 * .git or package.json. Keep in sync. */
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

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const PORT = Number(flag('port', 4949))
const RUN_FLAG = flag('run', null)

/* The run name reaches join() as a path segment, so it is allowlisted, never trusted:
 * plain slug, no leading dot, no separators. Applies to ?run=, --run and CURRENT alike. */
function safeRun(name) {
  return name && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : null
}

function currentRun() {
  if (RUN_FLAG) return safeRun(RUN_FLAG)
  const p = join(GRAPH_DIR, 'CURRENT')
  return existsSync(p) ? safeRun(readFileSync(p, 'utf8').trim()) : null
}

/** Same derivation the engine uses — duplicated on purpose so this stays dependency-free
 *  read-only (importing engine.mjs would run its CLI arg handling). Keep in sync. */
function derive(state) {
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
    out[id] = { effective, blockedBy }
  }
  return out
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

createServer((req, res) => {
  try {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const run = safeRun(url.searchParams.get('run')) ?? currentRun()

  if (url.pathname === '/api/state') {
    if (!run) return json(res, 404, { error: 'no run' })
    const p = join(GRAPH_DIR, run, 'state.json')
    if (!existsSync(p)) return json(res, 404, { error: `run "${run}" not found` })
    const state = JSON.parse(readFileSync(p, 'utf8'))
    return json(res, 200, { ...state, derived: derive(state) })
  }

  if (url.pathname === '/api/events') {
    if (!run) return json(res, 404, { error: 'no run' })
    const p = join(GRAPH_DIR, run, 'events.ndjson')
    if (!existsSync(p)) return json(res, 200, { events: [] })
    const limit = Number(url.searchParams.get('limit') ?? 300)
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    return json(res, 200, { events: lines.slice(-limit).map((l) => JSON.parse(l)) })
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
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
    return res.end(readFileSync(join(HERE, 'dashboard.html'), 'utf8'))
  }

  res.writeHead(404)
  res.end('not found')
  /* A corrupt state.json (or a mid-write read) must cost one response, never the process. */
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) })
  }
/* Loopback ONLY: this is a read-only dashboard for the dev's own browser. Binding every
 * interface would expose run state to the local network for no benefit. */
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[graph] dashboard on http://localhost:${PORT} (run: ${currentRun() ?? '—'})`)
}).on('error', (e) => {
  /* A taken port is the NORMAL second-run case (the previous dashboard is still up and
     already follows CURRENT) — say that, instead of dying with a stack trace. */
  if (e.code === 'EADDRINUSE') {
    console.error(
      `[graph] port ${PORT} is already in use — an earlier dashboard is likely still serving ` +
        `http://localhost:${PORT} (it follows CURRENT). To run a SECOND one: --port <other>` +
        `${RUN_FLAG ? '' : ' (add --run <name> to pin it to one run)'}`,
    )
    process.exit(1)
  }
  throw e
})
