import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { downloadPublishedFile } from './fixtures/published-download.mjs'
import { shardConfig, selectShard } from '../tools/ci-shards.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const smoke = join(repo, 'scripts/published-update-smoke.mjs')
// O registro fornece os tarballs publicados; tags Git não representam instalações disponíveis no npm.
// O prazo acompanha todas as publicações, para que novas versões não interrompam a matriz histórica.
const workers = process.platform === 'win32' ? 1 : 2
const publishedMetadata = JSON.parse((await downloadPublishedFile('https://registry.npmjs.org/@henri-ralmeida%2fprumo')).toString('utf8'))
const publishedMatrixTimeout = Math.ceil(selectShard(Object.keys(publishedMetadata.versions), shardConfig(process.env, 'PRUMO_TEST_PUBLISHED_SHARD')).length / workers) * 90000 + 120000

test('versões publicadas no npm atualizam para o candidato e preservam seus dados', { timeout: publishedMatrixTimeout }, async () => {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [smoke], {
      cwd: repo, env: { ...process.env }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], timeout: publishedMatrixTimeout - 1000,
    })
    let output = ''
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { output += value })
    child.once('error', reject)
    child.once('close', (status, signal) => resolveResult({ status, signal, output }))
  })
  assert.equal(result.status, 0, result.output + (result.signal ? '\nInterrompido por ' + result.signal : ''))
  process.stdout.write(result.output)
})

// Registrado com o motor 1.2.2: DONE foi planejada por tarefa (planningRequired: true) e iniciada.
// Antes da correção, a migração estrutural tratava esta tentativa como planejamento inseguro e recusava
// até review, validate e done, então a execução não podia continuar após `prumo update`.
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
