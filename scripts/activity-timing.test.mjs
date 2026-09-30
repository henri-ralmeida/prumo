import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = fileURLToPath(new URL('./engine.mjs', import.meta.url))

test('atividade explícita respeita agente, pausa e rodada de fase', () => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-activity-'))
  const workspace = join(home, 'workspace')
  const runDir = join(workspace, '.specs', 'graph', 'timing')
  mkdirSync(runDir, { recursive: true })
  const statePath = join(runDir, 'state.json')
  const state = {
    schemaVersion: 1, run: 'timing', plan: { name: 'Teste', planningMode: 'task', phases: [] },
    tasks: { T1: { id: 'T1', title: 'Tarefa', state: 'discussing', deps: [], attempts: [], notes: [], validations: [],
      discussionAttempts: [{ roundId: 'rodada', activityTiming: 'explicit', activityIntervals: [] }], planningAttempts: [] } },
  }
  writeFileSync(statePath, JSON.stringify(state))
  writeFileSync(join(runDir, 'events.ndjson'), '')
  const invoke = (...args) => spawnSync(process.execPath, [engine, ...args, '--run', 'timing'], {
    env: { ...process.env, PRUMO_ROOT: workspace }, encoding: 'utf8', timeout: 20000, windowsHide: true,
  })
  const current = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const success = (...args) => { const result = invoke(...args); assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr) }
  try {
    success('activity-start', 'T1', '--role', 'discussion', '--agent', 'alice')
    assert.equal(invoke('activity-start', 'T1', '--role', 'discussion', '--agent', 'alice').status, 1)
    assert.equal(invoke('activity-stop', 'T1', '--role', 'discussion', '--agent', 'bob').status, 1)
    success('activity-stop', 'T1', '--role', 'discussion', '--agent', 'alice')
    success('activity-start', 'T1', '--role', 'discussion', '--agent', 'alice')
    success('block', 'T1', '--reason', 'aguardar resposta')
    const intervals = current().tasks.T1.discussionAttempts[0].activityIntervals
    assert.equal(intervals.length, 2)
    assert.ok(intervals.every(interval => interval.endedAt && Date.parse(interval.endedAt) >= Date.parse(interval.startedAt)))

    const phaseState = current()
    phaseState.schemaVersion = 0
    phaseState.plan.planningMode = 'phase'
    phaseState.plan.phases = [{ id: 'P1', title: 'Fase' }]
    phaseState.tasks.T1.state = 'running'
    phaseState.tasks.T1.agent = 'executor'
    phaseState.tasks.T1.attempts = [{ n: 1, agent: 'executor', activityTiming: 'explicit', activityIntervals: [] }]
    phaseState.phaseWorkflows = { P1: { id: 'P1', state: 'planning', planner: 'planner', discussionAttempts: [],
      planningAttempts: [{ n: 1, agent: 'planner', activityTiming: 'explicit', activityIntervals: [] }] } }
    writeFileSync(statePath, JSON.stringify(phaseState))
    success('activity-start', 'P1', '--scope', 'phase', '--role', 'planning', '--agent', 'planner')
    assert.equal(invoke('activity-start', 'P1', '--scope', 'phase', '--role', 'planning', '--agent', 'outro').status, 1)
    success('activity-stop', 'P1', '--scope', 'phase', '--role', 'planning', '--agent', 'planner')
    assert.equal(invoke('activity-stop', 'P1', '--scope', 'phase', '--role', 'planning', '--agent', 'planner').status, 1)
    assert.equal(invoke('activity-start', 'P1', '--scope', 'phase', '--role', 'review', '--agent', 'planner').status, 1)
    assert.equal(current().phaseWorkflows.P1.planningAttempts[0].activityIntervals.length, 1)

    const legacyState = current()
    delete legacyState.phaseWorkflows.P1.planningAttempts[0].activityTiming
    delete legacyState.phaseWorkflows.P1.planningAttempts[0].activityIntervals
    writeFileSync(statePath, JSON.stringify(legacyState))
    success('activity-start', 'P1', '--scope', 'phase', '--role', 'planning', '--agent', 'planner')
    assert.equal(current().phaseWorkflows.P1.planningAttempts[0].activityLegacy, true)
    assert.equal(current().phaseWorkflows.P1.planningAttempts[0].activityIntervals.length, 1)
    success('activity-stop', 'P1', '--scope', 'phase', '--role', 'planning', '--agent', 'planner')

    const executionState = current()
    executionState.tasks.T1.state = 'running'
    executionState.tasks.T1.agent = 'executor'
    executionState.tasks.T1.attempts = [{ n: 1, agent: 'executor', activityTiming: 'explicit', activityIntervals: [] }]
    writeFileSync(statePath, JSON.stringify(executionState))
    success('activity-start', 'T1', '--role', 'execution', '--agent', 'executor')
    success('block', 'T1', '--reason', 'aguardar decisão')
    assert.ok(current().tasks.T1.attempts[0].activityIntervals[0].endedAt)

    const reviewState = current()
    reviewState.tasks.T1.state = 'reviewing'
    reviewState.tasks.T1.reviewer = 'revisor'
    reviewState.tasks.T1.attempts[0].reviewer = 'revisor'
    writeFileSync(statePath, JSON.stringify(reviewState))
    assert.equal(invoke('activity-start', 'T1', '--role', 'review', '--agent', 'executor').status, 1)
    success('activity-start', 'T1', '--role', 'review', '--agent', 'revisor')
    success('activity-stop', 'T1', '--role', 'review', '--agent', 'revisor')
    assert.equal(current().tasks.T1.attempts[0].activityIntervals.at(-1).role, 'review')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
