import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditSyncPlan,
  citedWaitingTasks,
  contractChanges,
  displayIdentifier,
  formatContractChange,
} from './sync-plan-audit.mjs'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), 'engine.mjs')
const check = { kind: 'functional', run: 'node -e "process.exit(0)"', expect: 'behavior verified' }

test('sync audit preserves dependency arrays and summarizes validation contracts', () => {
  const before = {
    deps: ['T11'],
    validation: [{ kind: 'functional', run: 'a'.repeat(2000), expect: 'old' }],
  }
  const after = {
    deps: ['T11', 'T25', 'T26'],
    validation: [
      { kind: 'static', run: 'b'.repeat(2000), expect: 'new' },
      { kind: 'functional', run: 'c'.repeat(2000), expect: 'new' },
    ],
  }
  const changes = contractChanges(before, after)
  assert.deepEqual(changes.find(change => change.field === 'deps'), {
    field: 'deps', before: ['T11'], after: ['T11', 'T25', 'T26'],
  })
  const validation = changes.find(change => change.field === 'validation')
  assert.deepEqual(validation.before, { type: 'steps', count: 1, kinds: { functional: 1 } })
  assert.deepEqual(validation.after, { type: 'steps', count: 2, kinds: { static: 1, functional: 1 } })
  assert.doesNotMatch(formatContractChange(validation), /a{100}|b{100}|c{100}/)
})

test('sync audit reports changed validation step indices when shape stays the same', () => {
  const before = {
    validation: [
      { kind: 'static', run: 'node check-a.mjs', expect: 'old static result' },
      { kind: 'functional', run: 'node verify-a.mjs', expect: 'old behavior' },
      { kind: 'functional', run: 'node stable.mjs', expect: 'unchanged behavior' },
    ],
  }
  const after = {
    validation: [
      { kind: 'static', run: 'node check-b.mjs', expect: 'new static result' },
      { kind: 'functional', run: 'node verify-b.mjs', expect: 'new behavior' },
      { kind: 'functional', run: 'node stable.mjs', expect: 'unchanged behavior' },
    ],
  }
  const validation = contractChanges(before, after).find(change => change.field === 'validation')
  assert.deepEqual(validation, {
    field: 'validation',
    before: { type: 'steps', count: 3, kinds: { static: 1, functional: 2 } },
    after: { type: 'steps', count: 3, kinds: { static: 1, functional: 2 } },
    changedSteps: { count: 2, indices: [1, 2] },
  })
  assert.equal(formatContractChange(validation), 'validation content changed in 2 checks (indices 1,2)')
  assert.doesNotMatch(formatContractChange(validation), /check-a|verify-b|old behavior|new behavior/)
})

test('sync audit bounds every contract field before it reaches output or events', () => {
  const marker = 'sensitive-marker-' + 'x'.repeat(6000)
  const before = {
    phase: marker,
    title: marker,
    deps: ['T11', marker],
    validation: [{ kind: 'functional', run: marker, expect: marker }],
    validationMode: 'functional',
    inspectionReason: marker,
    requireReview: true,
    maxAttempts: 1,
    tags: [marker],
    touches: [marker],
  }
  const after = { ...before, title: marker + '-after', tags: [marker + '-after'] }
  const changes = contractChanges(before, after)
  const rendered = JSON.stringify(changes) + changes.map(formatContractChange).join('\n')
  assert.doesNotMatch(rendered, new RegExp(marker))
  assert.equal(displayIdentifier(marker), '<task id length 6017>')
})

test('waiting citations require an explicit waiting context', () => {
  assert.deepEqual(citedWaitingTasks('T25 foi citado no histórico, mas o bloqueio é de outra causa', ['T25']), [])
  assert.deepEqual(citedWaitingTasks('Reabre quando T25 e T26 fecharem', ['T25', 'T26']), ['T25', 'T26'])
  assert.deepEqual(citedWaitingTasks('waiting for T25 and T26', ['T25', 'T26']), ['T25', 'T26'])
  assert.deepEqual(citedWaitingTasks('waiting for t25 and T25', ['T25']), ['T25'])
  assert.deepEqual(citedWaitingTasks('waiting for T25-foo', ['T25']), [])
  assert.deepEqual(citedWaitingTasks('waiting for T25-foo', ['T25-foo']), ['T25-foo'])
})

test('T12/T25/T26 audit detects the persisted semantic cycle', () => {
  const stateTasks = {
    T11: { id: 'T11', deps: [] },
    T12: { id: 'T12', deps: ['T11'], blockReason: 'Reabre quando T25 e T26 fecharem' },
    T25: { id: 'T25', deps: ['T12'] },
    T26: { id: 'T26', deps: ['T12'] },
  }
  const planTasks = [
    { id: 'T11', deps: [] },
    { id: 'T12', deps: ['T11', 'T25', 'T26'] },
    { id: 'T25', deps: ['T11'] },
    { id: 'T26', deps: ['T11'] },
  ]
  const audit = auditSyncPlan({ stateTasks, planTasks })
  assert.deepEqual(audit.blockReasonContradictions, [{
    task: 'T12', cited: ['T25', 'T26'], missingDeps: ['T25', 'T26'], plannedMissingDeps: [],
    backEdgesBefore: ['T25', 'T26'], backEdgesAfter: [], severity: 'strong',
  }])
})

test('a new leaf is informational until a blocked reason cites it, then it is a warning', () => {
  const stateTasks = {
    T12: { id: 'T12', deps: [], blockReason: 'aguardando T25' },
  }
  const planTasks = [
    { id: 'T12', deps: [] },
    { id: 'T25', deps: [] },
    { id: 'T26', deps: [] },
  ]
  const audit = auditSyncPlan({ stateTasks, planTasks, added: ['T25', 'T26'] })
  assert.deepEqual(audit.newLeaves, [
    { task: 'T25', dependents: [], severity: 'warning' },
    { task: 'T26', dependents: [], severity: 'info' },
  ])
})

test('sync audit warns when a phased task gains functional checks before discussion', () => {
  const stateTasks = {
    T26: { id: 'T26', phase: 'F2', validation: [{ kind: 'static', run: 'node lint.mjs', expect: 'clean' }] },
  }
  const planTasks = [{
    id: 'T26', phase: 'F2', validation: [
      { kind: 'static', run: 'node lint.mjs', expect: 'clean' },
      { kind: 'functional', run: 'node test-a.mjs', expect: 'case A passes' },
      { kind: 'functional', run: 'node test-b.mjs', expect: 'case B passes' },
    ],
  }]
  const audit = auditSyncPlan({
    stateTasks,
    planTasks,
    effectiveTasks: { T26: { effective: 'ready_for_discussion' } },
  })
  assert.deepEqual(audit.preDiscussionFunctionalContracts, [{
    task: 'T26', effective: 'ready_for_discussion', count: 2, added: 2,
    indices: [2, 3], severity: 'warning',
  }])
  assert.deepEqual(auditSyncPlan({
    stateTasks,
    planTasks,
    effectiveTasks: { T26: { effective: 'ready' } },
  }).preDiscussionFunctionalContracts, [], 'planned work must not warn')
  assert.deepEqual(auditSyncPlan({
    stateTasks: { T26: { ...stateTasks.T26, validation: planTasks[0].validation } },
    planTasks,
    effectiveTasks: { T26: { effective: 'ready_for_discussion' } },
  }).preDiscussionFunctionalContracts, [], 'unchanged functional count must not warn')
})

test('sync-plan warns but still applies functional checks added before phase discussion', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-sync-discussion-warning-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const root = join(home, 'workspace')
  mkdirSync(root)
  const planPath = join(root, 'plan.json')
  const initialPlan = {
    name: 'discussion-warning',
    phases: [{ id: 'F1', title: 'Discovery' }],
    tasks: [{
      id: 'T26', phase: 'F1', title: 'Define behavior', deps: [],
      validationMode: 'inspection', inspectionReason: 'Initial contract is documentation-only.',
      validation: 'Inspect the approved document.',
    }],
  }
  writeFileSync(planPath, JSON.stringify(initialPlan))
  const env = { ...process.env, PRUMO_HOME: home, PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  const run = (...args) => spawnSync(process.execPath, [engine, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 20000,
  })
  const init = run('init', '--plan', planPath, '--run', 'warning')
  assert.equal(init.status, 0, init.stdout + init.stderr)

  const changedPlan = structuredClone(initialPlan)
  const task = changedPlan.tasks[0]
  task.validationMode = 'functional'
  delete task.inspectionReason
  task.validation = [
    { ...check, run: 'node test-a.mjs', expect: 'case A passes' },
    { ...check, run: 'node test-b.mjs', expect: 'case B passes' },
  ]
  writeFileSync(planPath, JSON.stringify(changedPlan))
  const synced = run('sync-plan', '--plan', planPath)
  assert.equal(synced.status, 0, synced.stdout + synced.stderr)
  assert.match(synced.stdout + synced.stderr,
    /T26 is ready_for_discussion, but validation now has 2 functional checks \(new indices 1, 2\); is this planning\?/)

  const statePath = join(root, '.specs', 'graph', 'warning', 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(state.tasks.T26.validation.length, 2, 'warning must not block synchronization')
  const events = readFileSync(join(root, '.specs', 'graph', 'warning', 'events.ndjson'), 'utf8')
    .trim().split('\n').map(JSON.parse)
  const event = events.find(item => item.type === 'plan_sync')
  assert.deepEqual(event.diagnostics.preDiscussionFunctionalContracts, [{
    task: 'T26', effective: 'ready_for_discussion', count: 2, added: 2,
    indices: [1, 2], severity: 'warning',
  }])
})

test('sync-plan records per-task changes and diagnostics in plan_sync', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-sync-audit-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const root = join(home, 'workspace')
  mkdirSync(root)
  const planPath = join(root, 'plan.json')
  const initialPlan = {
    name: 'sync-audit',
    tasks: [
      { id: 'T11', title: 'Prerequisite', deps: [], validation: [check] },
      { id: 'T12', title: 'Blocked task', deps: ['T11'], validation: [check] },
      { id: 'T25', title: 'First leaf', deps: ['T12'], validation: [check] },
      { id: 'T26', title: 'Second leaf', deps: ['T12'], validation: [check] },
    ],
  }
  writeFileSync(planPath, JSON.stringify(initialPlan))
  const env = { ...process.env, PRUMO_HOME: home, PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  const run = (...args) => spawnSync(process.execPath, [engine, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 20000,
  })
  const init = run('init', '--plan', planPath, '--run', 'audit')
  assert.equal(init.status, 0, init.stdout + init.stderr)
  const statePath = join(root, '.specs', 'graph', 'audit', 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  // Model a legacy run with the old lifecycle; the sync itself remains the state owner.
  for (const task of Object.values(state.tasks)) {
    delete task.planningRequired
    delete task.planner
    delete task.planningAttempts
    delete task.planningHistory
  }
  writeFileSync(statePath, JSON.stringify(state))
  const skipped = run('skip', 'T11', '--reason', 'Prerequisite represented by the legacy fixture')
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr)
  const started = run('start', 'T12', '--agent', 'executor')
  assert.equal(started.status, 0, started.stdout + started.stderr)
  const blocked = run('block', 'T12', '--reason', 'Reabre quando T25 e T26 fecharem')
  assert.equal(blocked.status, 0, blocked.stdout + blocked.stderr)

  const correctedPlan = structuredClone(initialPlan)
  const largeMarker = 'contract-marker-' + 'z'.repeat(6000)
  correctedPlan.tasks.find(task => task.id === 'T12').title = largeMarker
  correctedPlan.tasks.find(task => task.id === 'T12').deps = ['T11', 'T25', 'T26']
  correctedPlan.tasks.find(task => task.id === 'T12').validation = [
    { ...check, expect: 'corrected behavior verified' },
  ]
  correctedPlan.tasks.find(task => task.id === 'T25').deps = ['T11']
  correctedPlan.tasks.find(task => task.id === 'T26').deps = ['T11']
  writeFileSync(planPath, JSON.stringify(correctedPlan))
  const synced = run('sync-plan', '--plan', planPath)
  assert.equal(synced.status, 0, synced.stdout + synced.stderr)
  assert.match(synced.stdout + synced.stderr, /T12 changed: .*deps \["T11"\] -> \["T11","T25","T26"\]/)
  assert.match(synced.stdout + synced.stderr, /validation content changed in 1 check \(indices 1\)/)
  assert.match(synced.stdout + synced.stderr, /strong warning: T12 blockReason cites T25, T26/)
  assert.doesNotMatch(synced.stdout + synced.stderr, new RegExp(largeMarker))

  const events = readFileSync(join(root, '.specs', 'graph', 'audit', 'events.ndjson'), 'utf8')
    .trim().split('\n').map(JSON.parse)
  const event = events.find(item => item.type === 'plan_sync')
  assert.ok(event)
  assert.doesNotMatch(JSON.stringify(event), new RegExp(largeMarker))
  const t12 = event.changes.find(change => change.task === 'T12')
  assert.deepEqual(t12.fields.find(field => field.field === 'deps'), {
    field: 'deps', before: ['T11'], after: ['T11', 'T25', 'T26'],
  })
  assert.deepEqual(t12.fields.find(field => field.field === 'validation').changedSteps, {
    count: 1, indices: [1],
  })
  assert.deepEqual(event.diagnostics.blockReasonContradictions[0].backEdgesBefore, ['T25', 'T26'])

  const invalidPlan = structuredClone(correctedPlan)
  invalidPlan.tasks.find(task => task.id === 'T25').deps = ['T12']
  writeFileSync(planPath, JSON.stringify(invalidPlan))
  const stateBeforeInvalid = readFileSync(statePath, 'utf8')
  const eventsBeforeInvalid = readFileSync(join(root, '.specs', 'graph', 'audit', 'events.ndjson'), 'utf8')
  const invalid = run('sync-plan', '--plan', planPath)
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stdout + invalid.stderr, /dependency cycle/)
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /T12 changed/)
  assert.equal(readFileSync(statePath, 'utf8'), stateBeforeInvalid)
  assert.equal(readFileSync(join(root, '.specs', 'graph', 'audit', 'events.ndjson'), 'utf8'), eventsBeforeInvalid)

  writeFileSync(planPath, JSON.stringify(correctedPlan))
  const stateWithDiagnostic = JSON.parse(stateBeforeInvalid)
  stateWithDiagnostic.tasks.T12.blockReason = 'waiting for T99'
  writeFileSync(statePath, JSON.stringify(stateWithDiagnostic))
  const stateBeforeAuditOnly = readFileSync(statePath, 'utf8')
  const auditOnly = run('sync-plan', '--plan', planPath)
  assert.equal(auditOnly.status, 0, auditOnly.stdout + auditOnly.stderr)
  assert.match(auditOnly.stdout + auditOnly.stderr, /absent from persisted deps/)
  assert.equal(readFileSync(statePath, 'utf8'), stateBeforeAuditOnly)
  const auditEvents = readFileSync(join(root, '.specs', 'graph', 'audit', 'events.ndjson'), 'utf8')
    .trim().split('\n').map(JSON.parse)
  const auditEvent = auditEvents.find(item => item.type === 'plan_sync_audit')
  assert.ok(auditEvent)
  assert.deepEqual(auditEvent.changes, [])
  assert.deepEqual(auditEvent.diagnostics.blockReasonContradictions[0].missingDeps, ['T99'])
})
