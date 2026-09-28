import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

// Builds each previous release from its Git tag, installs it with its own installer, creates
// runs with its own engine and upgrades through its own `prumo update` to this candidate.
// The published npm matrix (scripts/published-update-smoke.mjs) covers registry tarballs;
// this test also covers tagged releases that never reached npm and needs no network.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const smoke = join(repo, 'scripts/legacy-update-smoke.mjs')
// Default sample, one per storage/planning era: the first updater (graph-foreman root, no planning),
// per-task planning, the first phase planning line and the last release before this one.
// PRUMO_UPGRADE_TAGS=all runs every tag from v1.0.2; a comma list selects specific tags.
const representative = ['v1.0.2', 'v1.2.2', 'v1.3.2', 'v1.3.16']
const scenarioTimeout = Number(process.env.PRUMO_UPGRADE_SCENARIO_TIMEOUT ?? 360000)
const parallel = Math.max(1, Number(process.env.PRUMO_UPGRADE_PARALLEL ?? 2))

const npm = args => process.platform === 'win32'
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]] : ['npm', args]
function sync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, ...options })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`)
  return result.stdout
}
const version = tag => tag.slice(1).split('.').map(Number)
const compare = (a, b) => version(a).reduce((result, value, index) => result || value - version(b)[index], 0)

function releaseTags() {
  const git = spawnSync('git', ['tag', '--list', 'v*'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (git.error || git.status !== 0) return null
  // 1.0.0 and 1.0.1 have no `update` command; their users reinstall the package.
  return git.stdout.split(/\r?\n/).filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))
    .filter(tag => compare(tag, 'v1.0.2') >= 0 && compare(tag, `v${pkg.version}`) < 0).sort(compare)
}

function selectedTags(tags) {
  const requested = process.env.PRUMO_UPGRADE_TAGS
  if (requested === 'all') return tags
  const wanted = requested ? requested.split(',').map(tag => tag.trim()).filter(Boolean) : [...representative, tags.at(-1)]
  return tags.filter(tag => wanted.includes(tag))
}

function packTag(tag, work) {
  const source = join(work, `source-${tag}`), archive = join(work, `source-${tag}.tar`), out = join(work, `package-${tag}`)
  mkdirSync(source, { recursive: true })
  mkdirSync(out, { recursive: true })
  sync('git', ['archive', '--format=tar', '-o', archive, tag], { cwd: repo })
  // Relative paths keep GNU tar from reading a Windows drive letter as a remote host.
  sync('tar', ['-xf', `source-${tag}.tar`, '-C', `source-${tag}`], { cwd: work })
  // The historical prepack check is not part of the user's installation path.
  sync(...npm(['pack', '--ignore-scripts', '--pack-destination', out, '--loglevel=error']), { cwd: source,
    env: { ...process.env, npm_config_cache: join(work, 'npm-cache') } })
  const [name] = readdirSync(out).filter(file => file.endsWith('.tgz'))
  assert.ok(name, `npm pack produced no archive for ${tag}`)
  return join(out, name)
}

function runScenario(from, archive, env) {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [smoke, from, archive], { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { output += value })
    const timer = setTimeout(() => { output += `\n[upgrade test] timed out after ${scenarioTimeout}ms`; child.kill() }, scenarioTimeout)
    child.once('close', status => { clearTimeout(timer); resolvePromise({ from, status, output }) })
  })
}

const tags = releaseTags()
const skip = !tags?.length ? 'release tags are unavailable; fetch tags (git fetch --tags) to run this matrix' : false

test('every selected tagged release upgrades to this candidate and keeps its runs usable', { skip, timeout: 3600000 }, async () => {
  const selected = selectedTags(tags)
  assert.ok(selected.length > 0, 'no release tags selected')
  const base = realpathSync(tmpdir())
  const work = mkdtempSync(join(base, 'prumo-upgrade-matrix-'))
  try {
    const candidateDir = join(work, 'candidate')
    mkdirSync(candidateDir)
    sync(...npm(['pack', '--ignore-scripts', '--pack-destination', candidateDir, '--loglevel=error']), { cwd: repo,
      env: { ...process.env, npm_config_cache: join(work, 'npm-cache') } })
    const candidate = join(candidateDir, `henri-ralmeida-prumo-${pkg.version}.tgz`)
    const archives = new Map(selected.map(tag => [tag, packTag(tag, work)]))
    const env = { ...process.env, PRUMO_CANDIDATE_ARCHIVE: candidate, PRUMO_LANG: 'en',
      PRUMO_TEST_PUBLISHED_VERSIONS: JSON.stringify(tags.map(tag => tag.slice(1))) }
    const pending = [...selected], results = []
    await Promise.all(Array.from({ length: Math.min(parallel, pending.length) }, async () => {
      while (pending.length) {
        const tag = pending.shift()
        results.push(await runScenario(tag.slice(1), archives.get(tag), env))
      }
    }))
    const failed = results.filter(result => result.status !== 0)
    assert.deepEqual(failed.map(result => result.from), [], failed.map(result => `--- ${result.from}\n${result.output.slice(-4000)}`).join('\n'))
    assert.equal(results.length, selected.length)
  } finally {
    assert.ok(work.startsWith(join(base, 'prumo-upgrade-matrix-')))
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// Recorded with the 1.2.2 engine: DONE was planned per task (planningRequired: true) and started.
// Before the fix, the structural migration treated this attempt as unsafe planning and refused
// even review, validate and done, so the run could not continue after `prumo update`.
test('a 1.2 task-planned attempt continues after update and the run then adopts phase planning', t => {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, 'prumo-upgrade-state-'))
  t.after(() => {
    assert.ok(home.startsWith(join(base, 'prumo-upgrade-state-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const root = join(home, 'central', 'legacy')
  const stateFile = join(root, '.specs', 'graph', 'legacy', 'state.json')
  mkdirSync(dirname(stateFile), { recursive: true })
  const recorded = readFileSync(join(repo, 'test', 'fixtures', 'v1.2.2-running-task-plan-state.json'), 'utf8')
  writeFileSync(stateFile, recorded)
  const env = { ...process.env, PRUMO_HOME: join(home, 'central'), PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  for (const key of ['GRAPH_ROOT', 'GRAPH_FOREMAN_HOME']) delete env[key]
  const engine = (...args) => spawnSync(process.execPath, [join(repo, 'scripts', 'engine.mjs'), ...args, '--run', 'legacy'],
    { cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 60000 })
  const ok = (...args) => { const result = engine(...args); assert.equal(result.status, 0, result.stdout + result.stderr); return result }
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  const before = JSON.parse(recorded)
  assert.equal(before.tasks.DONE.planningRequired, true)
  assert.equal(before.tasks.DONE.state, 'running')
  assert.equal(before.plan.planningMode, undefined)

  ok('review', 'DONE', '--agent', 'reviewer')
  const migrated = state()
  assert.equal(migrated.plan.planningMode, 'phase')
  assert.deepEqual(migrated.tasks.DONE.attempts.map(attempt => attempt.agent), before.tasks.DONE.attempts.map(attempt => attempt.agent))
  assert.deepEqual(migrated.tasks.DONE.taskPlan, before.tasks.DONE.taskPlan)
  assert.equal(migrated.tasks.NEXT.planningRequired, true)
  const validate = engine('validate', 'DONE', '--ok', '--evidence', 'Documentation inspected after update')
  if (validate.status !== 0) {
    assert.match(validate.stderr, /review-progress DONE --step <index> --agent reviewer/)
    ok('review-progress', 'DONE', '--step', '1', '--agent', 'reviewer')
    ok('validate', 'DONE', '--ok', '--evidence', 'Documentation inspected after update')
  }
  ok('done', 'DONE')
  assert.equal(state().tasks.DONE.state, 'done')
  assert.equal(state().tasks.DONE.attempts.length, 1)
})

test('a new attempt after phase adoption names the phase workflow instead of task planning', t => {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, 'prumo-upgrade-state-'))
  t.after(() => {
    assert.ok(home.startsWith(join(base, 'prumo-upgrade-state-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const root = join(home, 'central', 'legacy')
  const stateFile = join(root, '.specs', 'graph', 'legacy', 'state.json')
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, readFileSync(join(repo, 'test', 'fixtures', 'v1.2.2-running-task-plan-state.json')))
  const env = { ...process.env, PRUMO_HOME: join(home, 'central'), PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  for (const key of ['GRAPH_ROOT', 'GRAPH_FOREMAN_HOME']) delete env[key]
  const engine = (...args) => spawnSync(process.execPath, [join(repo, 'scripts', 'engine.mjs'), ...args, '--run', 'legacy'],
    { cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 60000 })
  for (const args of [['fail', 'DONE', '--reason', 'Transient failure'], ['retry', 'DONE']]) {
    const result = engine(...args)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  const start = engine('start', 'DONE', '--agent', 'executor')
  assert.equal(start.status, 1)
  assert.match(start.stderr, /DONE needs completed current planning for phase F1 — run begin-phase-discussion F1/)
  assert.doesNotMatch(start.stderr, /plan-task/)
})
