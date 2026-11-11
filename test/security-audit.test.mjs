import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const engine = fileURLToPath(new URL('../scripts/engine.mjs', import.meta.url))
const at = minute => new Date(Date.UTC(2026, 9, 7, 13, minute)).toISOString()
const ENV = 'http://localhost:3000'

function task(id, extra = {}) {
  return { id, phase: null, title: `Delivery ${id}`, touches: ['out'], deps: [], state: 'done', planningRequired: false, discussionRequired: false, discoveryRequired: false,
    validation: [{ kind: 'functional', run: 'node --version', expect: 'Node runs' }], validations: [], notes: [], agent: 'exec-' + id, reviewer: 'rev-' + id,
    attempts: [{ n: 1, agent: 'exec-' + id, reviewer: 'rev-' + id, startedAt: at(1), endedAt: at(2), result: 'done' }], ...extra }
}

function fixture(t, taskStates = { T1: 'done' }) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'prumo-audit-'))), cwd = join(home, 'project'), root = join(home, 'store', 'workspace'), run = join(root, '.specs', 'graph', 'demo')
  mkdirSync(join(cwd, 'out'), { recursive: true }); mkdirSync(run, { recursive: true })
  const tasks = Object.fromEntries(Object.entries(taskStates).map(([id, state]) => [id, state === 'done' ? task(id) : task(id, { state, attempts: [], agent: undefined, reviewer: undefined })]))
  const state = { schemaVersion: 1, run: 'demo', createdAt: at(0), plan: { name: 'approved-delivery', planningMode: 'task', phases: [], maxAgents: 3, requireReview: true, cwd }, tasks }
  const statePath = join(run, 'state.json')
  const save = () => writeFileSync(statePath, JSON.stringify(state))
  save(); writeFileSync(join(run, 'events.ndjson'), ''); writeFileSync(join(dirname(run), 'CURRENT'), 'demo')
  const cli = (args, expected = 0) => {
    const result = spawnSync(process.execPath, [engine, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PRUMO_HOME: dirname(root), PRUMO_ROOT: root, PRUMO_LANG: 'en', PRUMO_RUN: 'demo' }, timeout: 30000 })
    assert.ifError(result.error); assert.equal(result.status, expected, result.stdout + result.stderr)
    return result.stdout + result.stderr
  }
  const read = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const mutate = change => { const current = read(); change(current); writeFileSync(statePath, JSON.stringify(current)) }
  const reportFile = (value, name = 'report.json') => { const path = join(home, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path }
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return { home, cwd, root, run, state, save, cli, read, mutate, reportFile }
}
// Attempts record reportSchema 2, so medium and above carry a CVSS v4.0 vector whose official band matches the severity.
const SCORES = { critical: ['CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N', 9.3], high: ['CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N', 7.1], medium: ['CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:L/VA:N/SC:N/SI:N/SA:N', 6.3] }
const withScore = item => SCORES[item.severity] && !item.cvss ? { ...item, cvss: { version: '4.0', vector: SCORES[item.severity][0], score: SCORES[item.severity][1], scoreSource: 'calculator' } } : item
const finding = (extra = {}) => withScore({ id: 'F1', severity: 'high', title: 'IDOR on invoices', cwe: 'CWE-639', taskRefs: ['T1'], attackPath: 'Change the id in the URL', evidence: 'Response 200 with another tenant data', reproduction: 'curl http://localhost:3000/invoices/2', remediation: 'Check ownership before returning the invoice', ...extra })
const report = (findings, extra = {}) => ({ summary: 'Local audit completed', environment: ENV, findings, ...extra })
const start = (f, extra = []) => f.cli(['audit-start', '--agent', 'auditor', '--environment', ENV, '--confirmed-by-user', ...extra])

test('auditoria independente preserva 14 tarefas DONE; apenas correções aprovadas criam T15 e T16', t => {
  const f = fixture(t, Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`T${i + 1}`, 'done'])))
  const before = readFileSync(join(f.run, 'state.json'), 'utf8')
  const proposal = JSON.parse(f.cli(['audit-propose', '--environment', ENV]))
  const contract = join(f.home, 'contract.json')
  f.cli(['audit-propose', '--environment', ENV, '--out', contract])
  assert.equal(readFileSync(join(f.run, 'state.json'), 'utf8'), before)
  assert.equal(proposal.source.tasks.length, 14)
  f.cli(['audit-propose', '--environment', ENV, '--out', contract], 1)
  f.cli(['audit-propose', '--environment', ENV, '--out', join(f.home, 'absent', 'contract.json')], 1)
  for (const invalid of ['null', '[]', '1', 'not-json'])
    f.cli(['audit-start', '--agent', 'auditor', '--environment', ENV, '--confirmed-by-user', '--contract', f.reportFile(invalid, 'invalid-contract.json')], 1)
  start(f, ['--contract', contract])
  assert.equal(Object.keys(f.read().tasks).length, 14)
  assert.equal(f.read().auditTasks, undefined)
  assert.equal(JSON.parse(f.cli(['audit-status'])).gate, false)
  assert.deepEqual(JSON.parse(f.cli(['brief', '--role', 'security'])).auditContract, proposal)
  f.cli(['audit-fix-plan'], 1)
  f.cli(['audit-finish', '--report', f.reportFile(report([finding(), finding({ id: 'F2', severity: 'medium' })]))])
  assert.ok(Object.values(f.read().tasks).every(task => task.state === 'done'))
  assert.equal(JSON.parse(f.cli(['audit-status'])).gate, false)
  assert.match(f.cli(['status']), /Delivery remains DONE/)
  const out = join(f.home, 'fixes.json')
  f.cli(['audit-fix-plan', '--out', out])
  assert.equal(Object.keys(f.read().tasks).length, 14)
  assert.deepEqual(JSON.parse(readFileSync(out)).tasks.slice(14).map(item => item.id), ['T15', 'T16'])
  const auditState = readFileSync(join(f.run, 'state.json'), 'utf8'), auditEvents = readFileSync(join(f.run, 'events.ndjson'), 'utf8')
  const unchanged = JSON.parse(readFileSync(out)); unchanged.tasks = unchanged.tasks.slice(0, 14)
  const unchangedPath = f.reportFile(unchanged, 'delivery-without-corrections.json')
  assert.match(f.cli(['sync-plan', '--plan', unchangedPath, '--complete-audit', '1', '--confirmed-by-user'], 1), /Audit corrections must be proposed/)
  assert.equal(readFileSync(join(f.run, 'state.json'), 'utf8'), auditState)
  assert.equal(readFileSync(join(f.run, 'events.ndjson'), 'utf8'), auditEvents)
  f.cli(['sync-plan', '--plan', out, '--propose'], 1)
  f.cli(['sync-plan', '--plan', out, '--propose', '--complete-audit', '1'], 1)
  assert.equal(Object.keys(f.read().tasks).length, 14)
  f.cli(['sync-plan', '--plan', out, '--propose', '--complete-audit', '1', '--confirmed-by-user'])
  assert.deepEqual(f.read().securityAudit.correctionDecision.tasks, ['T15', 'T16'])
  assert.equal(f.read().tasks.T15.state, 'pending')
  assert.ok(f.read().tasks.T15.planningRequired)
  assert.ok(f.read().tasks.T16.contractConfirmationRequired.proposed)
  assert.equal(f.read().securityAudit.attempts[0].result, 'blocked')
})

test('recusar correções preserva o relatório concluído sem dizer que os testes foram pulados', t => {
  const f = fixture(t), contract = f.reportFile(JSON.parse(f.cli(['audit-propose', '--environment', ENV])), 'contract.json')
  start(f, ['--contract', contract])
  f.cli(['audit-finish', '--report', f.reportFile(report([finding()]))])
  const output = f.cli(['audit-skip', '--reason', 'Avaliar depois', '--confirmed-by-user', '--lang', 'pt-BR'])
  assert.match(output, /auditoria de segurança concluída sem tarefas de correção/i)
  assert.equal(f.read().securityAudit.correctionDecision.choice, 'no-corrections')
  assert.equal(f.read().securityAudit.attempts[0].report.findings[0].accepted, undefined)
  assert.equal(Object.keys(f.read().tasks).length, 1)
  assert.doesNotMatch(f.cli(['status']), /GATE OPEN|BLOCKED by/)
})

test('closing the graph with done announces the decision once and Not now repeats the notice without writing', t => {
  const f = fixture(t, { T1: 'pending' })
  f.state.tasks.T1.validation = [{ kind: 'functional', run: 'node --version', expect: 'Node runs' }]
  f.save()
  f.cli(['start', 'T1', '--agent', 'executor'])
  f.cli(['review', 'T1', '--agent', 'revisor'])
  f.cli(['validate', 'T1', '--ok', '--evidence', 'Delivery inspected', '--cwd', f.cwd])
  assert.equal(f.read().securityAudit, undefined)
  const output = f.cli(['done', 'T1'])
  assert.match(output, /Delivery is DONE.*optional independent audit/)
  const stored = f.read().securityAudit
  assert.equal(stored.state, 'awaiting-decision'); assert.ok(stored.announcedAt)
  assert.deepEqual(Object.keys(stored).sort(), ['advisory', 'announcedAt', 'state']); assert.equal(stored.advisory, true)
  const before = readFileSync(join(f.run, 'state.json'), 'utf8')
  for (const command of ['status', 'ready']) assert.match(f.cli([command]), /Delivery is DONE/)
  assert.doesNotMatch(f.cli(['status']), /SECURITY AUDIT GATE OPEN/)
  assert.equal(readFileSync(join(f.run, 'state.json'), 'utf8'), before, 'Not now writes nothing')
})

test('skip that closes the graph announces; legacy closed runs are not asked retroactively but can start explicitly', t => {
  const f = fixture(t, { T1: 'done', T2: 'pending' })
  assert.match(f.cli(['skip', 'T2', '--reason', 'Out of scope']), /Delivery is DONE/)
  assert.equal(f.read().securityAudit.state, 'awaiting-decision')
  const legacy = fixture(t)
  for (const command of ['status', 'ready']) assert.doesNotMatch(legacy.cli([command]), /SECURITY AUDIT|security audit/)
  assert.equal(legacy.read().securityAudit, undefined)
  start(legacy)
  assert.equal(legacy.read().securityAudit.state, 'running')
})

test('audit-enable pre-authorizes, announces dispatch instead of a question and requires confirmation', t => {
  const f = fixture(t, { T1: 'done', T2: 'pending' })
  assert.match(f.cli(['audit-enable'], 1), /requires --confirmed-by-user/)
  const enabled = f.cli(['audit-enable', '--confirmed-by-user'])
  assert.match(enabled, /pre-authorized for this run/)
  assert.equal(f.read().securityAudit.state, 'enabled')
  const closing = f.cli(['skip', 'T2', '--reason', 'Not needed'])
  assert.match(closing, /pre-authorized: dispatch an independent auditor/)
  assert.doesNotMatch(closing, /Run \/ Skip \/ Not now/)
  assert.equal(f.read().securityAudit.state, 'enabled')
})

test('audit-start refuses every unsafe precondition without recording anything', t => {
  const open = fixture(t, { T1: 'done', T2: 'pending' })
  assert.match(open.cli(['audit-start', '--agent', 'auditor', '--environment', ENV, '--confirmed-by-user'], 1), /every task is done or skipped/)
  assert.equal(open.read().securityAudit, undefined)
  const skippedOnly = fixture(t, { T1: 'skipped' })
  assert.match(skippedOnly.cli(['audit-start', '--agent', 'auditor', '--environment', ENV, '--confirmed-by-user'], 1), /no delivered task to audit/)
  assert.equal(skippedOnly.read().securityAudit, undefined)
  const f = fixture(t)
  const refuse = (args, pattern) => { assert.match(f.cli(['audit-start', ...args], 1), pattern); assert.equal(f.read().securityAudit, undefined) }
  refuse(['--agent', 'auditor', '--environment', ENV], /requires --confirmed-by-user/)
  refuse(['--environment', ENV, '--confirmed-by-user'], /requires --agent/)
  refuse(['--agent', 'auditor', '--confirmed-by-user'], /requires --environment/)
  for (const agent of ['exec-T1', 'rev-T1', ' EXEC-t1 ']) refuse(['--agent', agent, '--environment', ENV, '--confirmed-by-user'], /must be independent/)
  f.state.tasks.T1.attempts[0].reviewer = 'old-reviewer'; f.state.tasks.T1.reviewer = 'now'
  f.state.tasks.T1.attempts[0].reviewHistory = [{ reviewer: 'history-reviewer' }]
  f.state.tasks.T1.planner = 'planner-x'
  f.state.tasks.T1.planningAttempts = [{ agent: 'task-planner' }]
  f.state.phaseWorkflows = { F1: { planningAttempts: [{ agent: 'phase-planner', workers: { T1: { agent: 'worker-planner' } } }] } }
  f.save()
  for (const agent of ['old-reviewer', 'history-reviewer', 'planner-x', 'task-planner', 'phase-planner', 'worker-planner']) refuse(['--agent', agent, '--environment', ENV, '--confirmed-by-user'], /must be independent/)
  refuse(['--agent', 'auditor', '--environment', 'example.com', '--confirmed-by-user'], /must be a local host/)
  const paused = fixture(t)
  paused.cli(['pause-run', '--reason', 'Maintenance window'])
  assert.match(paused.cli(['audit-start', '--agent', 'auditor', '--environment', ENV, '--confirmed-by-user'], 1), /Run is paused/)
  assert.equal(paused.read().securityAudit, undefined)
})

test('audit-start needs a free agent slot and counts the running auditor as busy', t => {
  const f = fixture(t)
  f.state.plan.maxAgents = 1; f.state.phaseWorkflows = { F1: { id: 'F1', state: 'planning', planningAttempts: [{ n: 1, agent: 'busy-planner', startedAt: at(1) }] } }; f.save()
  assert.match(f.cli(['audit-start', '--agent', 'auditor', '--environment', ENV, '--confirmed-by-user'], 1), /no agent slot available/)
  delete f.state.phaseWorkflows; f.save()
  start(f)
  assert.match(f.cli(['ready']), /1\/1 executors|executors/)
  assert.match(f.cli(['audit-start', '--agent', 'other', '--environment', ENV, '--confirmed-by-user'], 1), /already running/)
})

test('a local environment with a path is normalized to its origin and recorded with the dispatch', t => {
  for (const [input, origin] of [['http://LOCALHOST:5000/app', 'http://localhost:5000']]) {
    const f = fixture(t)
    f.cli(['audit-start', '--agent', 'auditor', '--environment', input, '--confirmed-by-user', '--model', 'opus'])
    const attempt = f.read().securityAudit.attempts[0]
    assert.equal(attempt.environment, origin)
    assert.deepEqual(attempt.taskIds, ['T1']); assert.equal(attempt.n, 1); assert.equal(attempt.confirmedByUser, true)
    assert.equal(attempt.modelDispatches[0].role, 'security'); assert.equal(attempt.modelDispatches[0].reported.model, 'opus')
  }
})

test('audit-finish validates the report strictly and records the digest of the exact bytes', t => {
  const f = fixture(t)
  assert.match(f.cli(['audit-finish', '--report', 'x.json'], 1), /no running security audit/)
  start(f)
  assert.match(f.cli(['audit-finish'], 1), /requires --report/)
  assert.match(f.cli(['audit-finish', '--report', join(f.home, 'missing.json')], 1), /cannot read the audit report/)
  assert.match(f.cli(['audit-finish', '--report', f.reportFile('{ not json')], 1), /not valid JSON/)
  const refuse = (value, pattern) => assert.match(f.cli(['audit-finish', '--report', f.reportFile(value)], 1), pattern)
  refuse(report([finding({ id: 'T1' })]), /finding\[0\]\.id "T1" looks like a task identifier/)
  assert.equal(f.read().securityAudit.state, 'running', 'refusals keep the audit running')
  const medium = f.reportFile(report([finding({ id: 'F5', severity: 'medium', taskRefs: [] })], { tools: ['npm audit'] }), 'medium.json')
  const output = f.cli(['audit-finish', '--report', medium])
  assert.match(output, /finished: done/)
  const audit = f.read().securityAudit, attempt = audit.attempts[0]
  assert.equal(audit.state, 'done'); assert.equal(attempt.result, 'done'); assert.ok(attempt.endedAt)
  assert.equal(attempt.report.digest, createHash('sha256').update(readFileSync(medium)).digest('hex'))
  assert.deepEqual(attempt.report.tools, ['npm audit'])
  assert.match(f.cli(['audit-finish', '--report', medium], 1), /no running security audit/)
  assert.match(f.cli(['audit-start', '--agent', 'auditor-2', '--environment', ENV, '--confirmed-by-user'], 1), /already done/)
})

test('critical and high findings block until each is accepted with a reason and confirmation', t => {
  const f = fixture(t)
  start(f)
  const path = f.reportFile(report([finding({ id: 'F1', severity: 'high' }), finding({ id: 'F2', severity: 'critical', cwe: 'CWE-78' }), finding({ id: 'F3', severity: 'low' })]))
  const output = f.cli(['audit-finish', '--report', path])
  assert.match(output, /BLOCKED by critical\/high findings: F1, F2/)
  assert.equal(f.read().securityAudit.state, 'blocked')
  assert.match(f.cli(['status']), /SECURITY AUDIT BLOCKED/)
  assert.match(f.cli(['audit-accept', 'F1', '--reason', 'Risk accepted'], 1), /requires --confirmed-by-user/)
  assert.match(f.cli(['audit-accept', 'F1', '--confirmed-by-user'], 1), /requires --reason/)
  assert.match(f.cli(['audit-accept', '--reason', 'x', '--confirmed-by-user'], 1), /audit-accept <finding>/)
  assert.match(f.cli(['audit-accept', 'F9', '--reason', 'x', '--confirmed-by-user'], 1), /unknown finding/)
  assert.match(f.cli(['audit-accept', 'F3', '--reason', 'x', '--confirmed-by-user'], 1), /not a blocking finding/)
  assert.match(f.cli(['audit-skip', '--reason', 'x', '--confirmed-by-user'], 1), /blocked by findings/)
  assert.match(f.cli(['audit-enable', '--confirmed-by-user'], 1), /blocked by findings/)
  f.mutate(current => { current.taskIdAliases = { F1: 'T1' } })
  f.cli(['audit-accept', 'F1', '--reason', 'Isolated internal tool', '--confirmed-by-user'])
  assert.equal(f.read().securityAudit.state, 'blocked')
  assert.match(f.cli(['audit-accept', 'F1', '--reason', 'again', '--confirmed-by-user'], 1), /already accepted/)
  f.cli(['audit-accept', 'F2', '--reason', 'Fix scheduled outside this run', '--confirmed-by-user'])
  const audit = f.read().securityAudit
  assert.equal(audit.state, 'done')
  assert.deepEqual(audit.attempts[0].acceptances.map(item => item.finding), ['F1', 'F2'])
  assert.ok(audit.attempts[0].acceptances.every(item => item.confirmedByUser === true && item.reason && item.at))
  assert.match(f.cli(['audit-accept', 'F1', '--reason', 'x', '--confirmed-by-user'], 1), /no blocking security findings/)
})

test('reopening the graph derives pending-recheck, refuses audit-start and a new attempt revalidates', t => {
  const f = fixture(t)
  start(f)
  f.cli(['audit-finish', '--report', f.reportFile(report([finding()]))])
  f.mutate(current => { current.tasks.T2 = task('T2', { state: 'pending', attempts: [], agent: undefined, reviewer: undefined }) })
  const view = JSON.parse(f.cli(['audit-status']))
  assert.equal(view.state, 'pending-recheck'); assert.equal(view.stored, 'blocked'); assert.equal(view.graphClosed, false)
  assert.equal(f.read().securityAudit.state, 'blocked', 'the derived state is never stored')
  assert.match(f.cli(['status']), /tasks were reopened after blocking findings/)
  assert.match(f.cli(['audit-start', '--agent', 'auditor-2', '--environment', ENV, '--confirmed-by-user'], 1), /tasks were reopened/)
  f.cli(['skip', 'T2', '--reason', 'Replaced by a fix elsewhere'])
  assert.match(f.cli(['status']), /SECURITY AUDIT BLOCKED/)
  f.cli(['audit-start', '--agent', 'auditor-2', '--environment', ENV, '--confirmed-by-user'])
  const audit = f.read().securityAudit
  assert.equal(audit.attempts.length, 2); assert.equal(audit.attempts[1].n, 2); assert.deepEqual(audit.attempts[1].taskIds, ['T1', 'T2'])
  f.cli(['audit-finish', '--report', f.reportFile(report([], { revalidates: ['F1'] }))])
  assert.equal(f.read().securityAudit.state, 'done')
})

test('work added after a done audit asks again when the graph closes, and skipped stays skipped', t => {
  const f = fixture(t)
  start(f)
  f.cli(['audit-finish', '--report', f.reportFile(report([]))])
  f.mutate(current => { current.tasks.T2 = task('T2', { state: 'pending', attempts: [], agent: undefined, reviewer: undefined }) })
  assert.equal(f.read().securityAudit.state, 'done')
  assert.match(f.cli(['skip', 'T2', '--reason', 'No longer needed']), /DECISION PENDING/)
  const audit = f.read().securityAudit
  assert.equal(audit.state, 'awaiting-decision'); assert.equal(audit.attempts.length, 1)
  const skipped = fixture(t, { T1: 'done', T2: 'pending' })
  assert.match(skipped.cli(['audit-skip', '--confirmed-by-user', '--reason', ' '], 1), /requires --reason/)
  assert.match(skipped.cli(['audit-skip', '--reason', 'No exposure'], 1), /requires --confirmed-by-user/)
  skipped.cli(['audit-skip', '--reason', 'No exposure', '--confirmed-by-user'])
  assert.equal(skipped.read().securityAudit.skip.reason, 'No exposure')
  assert.doesNotMatch(skipped.cli(['skip', 'T2', '--reason', 'Out']), /SECURITY AUDIT DECISION/)
  assert.equal(skipped.read().securityAudit.state, 'skipped')
  assert.doesNotMatch(skipped.cli(['status']), /GATE OPEN/, 'a skipped audit leaves no gate')
  assert.match(skipped.cli(['audit-enable', '--confirmed-by-user']), /pre-authorized/)
})

test('audit-skip and audit-enable are refused while the audit is running or finished', t => {
  const f = fixture(t)
  start(f)
  for (const command of [['audit-skip', '--reason', 'x', '--confirmed-by-user'], ['audit-enable', '--confirmed-by-user']]) assert.match(f.cli(command, 1), /running/)
  f.cli(['audit-finish', '--report', f.reportFile(report([]))])
  assert.match(f.cli(['audit-skip', '--reason', 'x', '--confirmed-by-user'], 1), /already done/)
  assert.match(f.cli(['audit-enable', '--confirmed-by-user'], 1), /already done/)
})

test('audit-status is read only and brief --role security exposes every card without executor narrative', t => {
  const f = fixture(t)
  f.state.tasks.T1.progress = [{ step: 1, text: 'EXECUTOR NARRATIVE' }]
  f.state.tasks.T1.failure = { reason: 'FAILURE NARRATIVE' }
  f.state.tasks.T1.notes = [{ text: 'Careful with tenants', at: at(3) }]
  f.state.tasks.T1.validations = [{ by: 'review', ok: true, agent: 'rev-T1', at: at(4), summary: 'Reviewed', evidence: 'Independent evidence', deliveryCheck: { fingerprint: 'abc' }, scopeCheck: { fingerprint: 'def' } }]
  f.state.tasks.T2 = task('T2', { state: 'skipped', skipReason: 'Not needed', attempts: [] })
  f.save()
  const before = readFileSync(join(f.run, 'state.json'), 'utf8')
  assert.deepEqual(JSON.parse(f.cli(['audit-status'])), { state: null })
  const out = f.cli(['brief', '--role', 'security'])
  assert.equal(readFileSync(join(f.run, 'state.json'), 'utf8'), before, 'read-only commands do not touch the state')
  const brief = JSON.parse(out)
  assert.equal(brief.role, 'security'); assert.deepEqual(brief.tasks.map(item => item.id), ['T1', 'T2'])
  assert.equal(brief.tasks[0].review.agent, 'rev-T1'); assert.equal(brief.tasks[0].review.deliveryFingerprint, 'abc')
  assert.equal(brief.tasks[1].skipReason, 'Not needed')
  assert.doesNotMatch(out, /EXECUTOR NARRATIVE|FAILURE NARRATIVE|Careful with tenants/)
  assert.ok(brief.rulesOfEngagement.length >= 4); assert.equal(brief.reference, 'references/security-audit.md')
  assert.match(f.cli(['brief', 'T1', '--role', 'reviewer']), /"role": "reviewer"/)
})

test('activity --scope run records auditor intervals, refuses other actors and closes when the audit ends', t => {
  const f = fixture(t)
  const run = (command, ...rest) => ['activity-' + command, 'security-audit', '--scope', 'run', '--role', 'security', '--agent', ...rest]
  assert.match(f.cli(run('start', 'auditor'), 1), /no running security audit/)
  start(f)
  assert.match(f.cli(['activity-start', 'T1', '--scope', 'run', '--role', 'security', '--agent', 'auditor'], 1), /needs the id security-audit/)
  assert.match(f.cli(['activity-start', 'security-audit', '--scope', 'run', '--role', 'execution', '--agent', 'auditor'], 1), /security role/)
  assert.match(f.cli(run('start', 'someone-else'), 1), /belongs to auditor/)
  assert.match(f.cli(run('stop', 'auditor'), 1), /no active security work/)
  f.cli(run('start', 'auditor'))
  assert.match(f.cli(run('start', 'auditor'), 1), /already has active work/)
  assert.equal(f.read().securityAudit.attempts[0].activityIntervals.length, 1)
  f.cli(run('stop', 'auditor'))
  f.cli(run('start', 'auditor'))
  f.cli(['audit-finish', '--report', f.reportFile(report([]))])
  const intervals = f.read().securityAudit.attempts[0].activityIntervals
  assert.equal(intervals.length, 2); assert.ok(intervals.every(interval => interval.role === 'security' && interval.endedAt))
  assert.equal(intervals[1].endedBy, 'audit-finish')
  assert.match(f.cli(['activity-start', 'T1', '--scope', 'task', '--role', 'security', '--agent', 'auditor'], 1), /valid scope, role/)
})

test('security is a known role for preferences but report-usage is refused for it', t => {
  const f = fixture(t)
  f.cli(['set-role', '--role', 'security', '--model', 'opus', '--effort', 'high'])
  assert.deepEqual(f.read().plan.rolePreferences.security, { model: 'opus', effort: 'high' })
  assert.match(f.cli(['report-usage', 'T1', '--role', 'security', '--receipt', 'r1', '--tokens', '5'], 1), /run-level and not supported/)
  assert.match(f.cli(['report-usage', 'T1', '--role', 'security', '--receipt', 'r1', '--tokens', '5', '--lang', 'pt-BR'], 1), /da execução inteira/)
  f.cli(['audit-start', '--agent', 'auditor', '--environment', ENV, '--confirmed-by-user', '--effort', 'low'])
  const dispatch = f.read().securityAudit.attempts[0].modelDispatches[0]
  assert.deepEqual(dispatch.requested, { model: 'opus', effort: 'high' }); assert.deepEqual(dispatch.reported, { effort: 'low' })
  assert.match(f.cli(['brief', '--role', 'security']), /"model": "opus"/)
})

test('renumber-tasks remaps finding references and audit task snapshots', t => {
  const f = fixture(t, { T1: 'done', T2: 'done' })
  f.state.plan.tasks = undefined
  const planPath = join(f.home, 'plan.json')
  writeFileSync(planPath, JSON.stringify({ name: 'approved-delivery', tasks: Object.values(f.state.tasks).map(item => ({ id: item.id, title: item.title, touches: item.touches, deps: [], validation: item.validation })) }))
  f.state.plan.source = planPath
  f.state.securityAudit = { state: 'done', attempts: [{ n: 1, agent: 'auditor', environment: ENV, startedAt: at(5), endedAt: at(6), confirmedByUser: true, result: 'done', taskIds: ['T1', 'T2'], report: { path: 'r.json', digest: 'd', summary: 's', environment: ENV, findings: [finding({ taskRefs: ['T1'], severity: 'medium' }), finding({ id: 'F2', taskRefs: ['T2', 'T1'], severity: 'low' })] } }] }
  f.save()
  const output = f.cli(['renumber-tasks', '--map', 'T1=T2,T2=T1', '--confirmed-by-user'], 0)
  assert.match(output, /applied/)
  const attempt = f.read().securityAudit.attempts[0]
  assert.deepEqual(attempt.taskIds, ['T2', 'T1'])
  assert.deepEqual(attempt.report.findings.map(item => item.taskRefs), [['T2'], ['T1', 'T2']])
})

function blockedFixture(t, findings) {
  const f = fixture(t, { T1: 'done', T2: 'done' })
  f.mutate(current => { current.tasks.T2.touches = ['lib']; current.tasks.T1.summary = 'Invoice delivery' })
  start(f)
  f.cli(['audit-finish', '--report', f.reportFile(report(findings))])
  return f
}
const fixFindings = () => [finding({ id: 'F1', severity: 'high', taskRefs: ['T1'] }), finding({ id: 'F2', severity: 'critical', cwe: 'CWE-78', title: 'Command injection', taskRefs: ['T2'] }), finding({ id: 'F3', severity: 'medium', cwe: 'CWE-352' })]

test('blocked audit asks per finding and audit-fix-plan proposes one phase with a task per blocking finding without touching the state', t => {
  const f = blockedFixture(t, fixFindings())
  const notice = f.cli(['status'])
  assert.match(notice, /Present each finding \(F1, F2\) and ask the user per finding: Fix .* or Accept the risk/)
  assert.match(notice, /audit-fix-plan --out <file.json>.*sync-plan --plan <file.json> --propose/)
  f.cli(['audit-accept', 'F2', '--reason', 'Isolated tool', '--confirmed-by-user'], 0)
  const before = readFileSync(join(f.run, 'state.json'), 'utf8')
  const printed = JSON.parse(f.cli(['audit-fix-plan']))
  const out = join(f.home, 'fix-plan.json')
  assert.match(f.cli(['audit-fix-plan', '--out', out, '--test-command', 'node --version']), /fix phase proposed in .*fix-plan\.json.*T3 \(F1\)/)
  const plan = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(plan.tasks.map(item => item.id), ['T1', 'T2', 'T3']); assert.deepEqual(printed.tasks.at(-1).tags, plan.tasks.at(-1).tags)
  assert.deepEqual(plan.phases.map(phase => phase.id), ['F1']); assert.equal(plan.phases[0].title, 'Security fixes (audit #1)')
  assert.equal(plan.tasks[2].tags[0], 'security-finding:1:F1'); assert.deepEqual(plan.tasks[2].touches, ['out'])
  assert.equal(readFileSync(join(f.run, 'state.json'), 'utf8'), before, 'audit-fix-plan is read only')
  assert.match(f.cli(['audit-fix-plan', '--out', out], 1), /already exists/)
  assert.match(f.cli(['audit-fix-plan', '--out', out, '--bogus', 'x'], 1), /bogus/)
  assert.match(f.cli(['audit-fix-plan', '--out', join(f.home, 'missing-dir', 'plan.json')], 1), /audit-fix-plan cannot write .*missing-dir.*ENOENT/)
  assert.match(f.cli(['audit-fix-plan', '--out', join(f.home, 'missing-dir', 'plan.json'), '--lang', 'pt-BR'], 1), /não conseguiu gravar/)
  const view = JSON.parse(f.cli(['audit-status']))
  assert.deepEqual(view.findings.filter(item => item.resolution).map(item => [item.id, item.resolution]), [['F1', 'open'], ['F2', 'accepted']])
})

test('audit-fix-plan refuses a second proposal once the fix tasks exist', t => {
  const f = blockedFixture(t, fixFindings())
  const out = join(f.home, 'fix-plan.json')
  f.cli(['audit-fix-plan', '--out', out])
  f.cli(['sync-plan', '--plan', out, '--propose'])
  assert.match(f.cli(['audit-fix-plan'], 1), /already exist: F1=T3, F2=T4/)
})

test('fix phase enters only as an accepted proposal, then closing it requests a new audit attempt that finishes clean', t => {
  const f = blockedFixture(t, fixFindings())
  const out = join(f.home, 'fix-plan.json')
  f.cli(['audit-fix-plan', '--out', out, '--test-command', 'node --version'])
  const refused = f.cli(['sync-plan', '--plan', out], 1)
  assert.match(refused, /security fix tasks \(T3, T4\) are added only as a proposal.*--propose/)
  assert.deepEqual(Object.keys(f.read().tasks), ['T1', 'T2'], 'the refusal changes nothing')
  assert.match(f.cli(['sync-plan', '--plan', out, '--dry-run']), /dry-run: no changes written; added 2/)
  assert.deepEqual(Object.keys(f.read().tasks), ['T1', 'T2'])
  f.cli(['sync-plan', '--plan', out, '--propose'])
  const proposed = f.read()
  assert.deepEqual(Object.keys(proposed.tasks), ['T1', 'T2', 'T3', 'T4'])
  assert.deepEqual(proposed.tasks.T4.deps, [], 'findings on different files run in parallel')
  assert.ok(proposed.tasks.T3.contractConfirmationRequired.proposed && proposed.tasks.T4.contractConfirmationRequired.proposed)
  assert.equal(proposed.plan.phases.at(-1).id, 'F1'); assert.equal(proposed.tasks.T3.phase, 'F1')
  assert.match(f.cli(['start', 'T3', '--agent', 'executor'], 1), /Proposed contract requires exact user acceptance/)
  const view = JSON.parse(f.cli(['audit-status']))
  assert.equal(view.state, 'pending-recheck'); assert.deepEqual(view.findings.slice(0, 2).map(item => [item.resolution, item.fixTask]), [['fix-task', 'T3'], ['fix-task', 'T4']])
  assert.match(f.cli(['status']), /tasks were reopened after blocking findings/)
  f.mutate(current => {
    for (const id of ['T3', 'T4']) Object.assign(current.tasks[id], { contractConfirmationRequired: null, planningRequired: false, discussionRequired: false, discoveryRequired: false })
  })
  for (const [id, agent, reviewer] of [['T3', 'exec-3', 'rev-3'], ['T4', 'exec-4', 'rev-4']]) {
    f.cli(['start', id, '--agent', agent]); f.cli(['review', id, '--agent', reviewer])
    f.cli(['validate', id, '--ok', '--evidence', 'Regression test inspected', '--cwd', f.cwd])
    f.cli(['done', id])
  }
  const closed = f.cli(['status'])
  assert.match(closed, /All blocking findings are accepted or have finished fix tasks; run audit-start/)
  assert.doesNotMatch(closed, /ask the user per finding/)
  assert.equal(f.read().securityAudit.state, 'blocked')
  f.cli(['audit-start', '--agent', 'auditor-2', '--environment', ENV, '--confirmed-by-user'])
  assert.deepEqual(f.read().securityAudit.attempts[1].taskIds, ['T1', 'T2', 'T3', 'T4'])
  f.cli(['audit-finish', '--report', f.reportFile(report([finding({ id: 'F3', severity: 'medium', cwe: 'CWE-352' })], { revalidates: ['F1', 'F2'] }), 'second.json')])
  assert.equal(f.read().securityAudit.state, 'done')
  assert.match(f.cli(['audit-fix-plan'], 1), /no blocked security audit/)
})

test('a persisting finding is proposed again for the new attempt with its own link and the next free numbers', t => {
  const f = blockedFixture(t, [finding({ id: 'F1', taskRefs: ['T1'] })])
  const out = join(f.home, 'fix-plan.json')
  f.cli(['audit-fix-plan', '--out', out]); f.cli(['sync-plan', '--plan', out, '--propose'])
  f.mutate(current => { Object.assign(current.tasks.T3, { state: 'skipped', skipReason: 'Replaced', contractConfirmationRequired: null }) })
  assert.equal(JSON.parse(f.cli(['audit-status'])).findings[0].resolution, 'fix-skipped')
  const skippedNotice = f.cli(['status'])
  assert.match(skippedNotice, /fix tasks of F1 were skipped, so no fix was delivered/)
  assert.doesNotMatch(skippedNotice, /finished fix tasks|ask the user per finding/)
  f.cli(['audit-start', '--agent', 'auditor-2', '--environment', ENV, '--confirmed-by-user'])
  f.cli(['audit-finish', '--report', f.reportFile(report([finding({ id: 'F1', taskRefs: ['T1', 'T3'] })], { revalidates: ['F1'] }), 'second.json')])
  const second = join(f.home, 'fix-plan-2.json')
  f.cli(['audit-fix-plan', '--out', second])
  const plan = JSON.parse(readFileSync(second, 'utf8'))
  assert.deepEqual(plan.phases.map(phase => phase.id), ['F1', 'F2']); assert.equal(plan.phases[1].title, 'Security fixes (audit #2)')
  assert.deepEqual(plan.tasks.at(-1).tags, ['security-finding:2:F1', 'security-fix']); assert.equal(plan.tasks.at(-1).id, 'T4')
  f.cli(['sync-plan', '--plan', second, '--propose'])
  assert.equal(JSON.parse(f.cli(['audit-status'])).findings[0].fixTask, 'T4')
})

test('a new attempt brief and status carry the previous blocking findings to revalidate', t => {
  const f = blockedFixture(t, fixFindings())
  f.cli(['audit-start', '--agent', 'auditor-2', '--environment', ENV, '--confirmed-by-user'])
  const view = JSON.parse(f.cli(['audit-status']))
  assert.equal(view.state, 'running'); assert.deepEqual(view.findings, []); assert.equal(view.gate, true)
  assert.deepEqual(view.previousBlocking.map(item => [item.id, item.status, item.attempt]), [['F1', 'open', 1], ['F2', 'open', 1]])
  const brief = JSON.parse(f.cli(['brief', '--role', 'security']))
  assert.deepEqual(brief.previousBlocking.map(item => item.id), ['F1', 'F2']); assert.match(brief.revalidation, /Revalidate every unaccepted entry of previousBlocking/)
  assert.match(f.cli(['status']), /GATE OPEN \(running\)/)
})

test('an auditor name differing only by case or spaces is not independent', t => {
  const f = fixture(t)
  assert.match(f.cli(['audit-start', '--agent', 'REV-t1', '--environment', ENV, '--confirmed-by-user'], 1), /must be independent/)
  f.state.removedTasks = { T9: { task: { agent: 'Gone-Executor' } } }; f.save()
  assert.match(f.cli(['audit-start', '--agent', 'gone-executor', '--environment', ENV, '--confirmed-by-user'], 1), /must be independent/)
  assert.equal(f.read().securityAudit, undefined)
})

function planFile(f, tasks) {
  const path = join(f.home, 'plan.json')
  writeFileSync(path, JSON.stringify({ name: 'approved-delivery', tasks: tasks.map(id => ({ id, title: `Delivery ${id}`, summary: `Result of ${id}`, touches: ['out'], deps: id === 'T1a' ? ['T1'] : [], validation: [{ kind: 'functional', run: 'node --version', expect: 'Node runs' }] })) }))
  return path
}

test('removing the last open task with sync-plan closes the graph and announces the audit decision', t => {
  const f = fixture(t, { T1: 'done', T2: 'pending' })
  const output = f.cli(['sync-plan', '--plan', planFile(f, ['T1']), '--remove', 'T2', '--reason', 'Out of scope'])
  assert.match(output, /Delivery is DONE/)
  assert.equal(f.read().securityAudit.state, 'awaiting-decision')
  assert.match(f.cli(['status']), /Delivery is DONE/)
  const legacy = fixture(t)
  const metadata = planFile(legacy, ['T1'])
  const plan = JSON.parse(readFileSync(metadata, 'utf8')); plan.tasks[0].label = 'Renamed'; writeFileSync(metadata, JSON.stringify(plan))
  legacy.cli(['sync-plan', '--plan', metadata])
  assert.equal(legacy.read().tasks.T1.label, 'Renamed')
  assert.equal(legacy.read().securityAudit, undefined, 'a run that was already closed is not asked retroactively')
})

test('sync-plan refuses to add tasks while the audit runs and accepts them once it is recorded', t => {
  const f = fixture(t)
  start(f)
  const before = readFileSync(join(f.run, 'state.json'), 'utf8')
  assert.match(f.cli(['sync-plan', '--plan', planFile(f, ['T1', 'T1a'])], 1), /security audit is running; finish it with audit-finish/)
  assert.equal(readFileSync(join(f.run, 'state.json'), 'utf8'), before)
  f.cli(['audit-finish', '--report', f.reportFile(report([]))])
  f.cli(['sync-plan', '--plan', planFile(f, ['T1', 'T1a'])])
  assert.deepEqual(Object.keys(f.read().tasks), ['T1', 'T1a'])
})

test('pause-run closes the running auditor activity', t => {
  const f = fixture(t)
  start(f)
  f.cli(['activity-start', 'security-audit', '--scope', 'run', '--role', 'security', '--agent', 'auditor'])
  f.cli(['pause-run', '--reason', 'Maintenance window'])
  const [interval] = f.read().securityAudit.attempts[0].activityIntervals
  assert.ok(interval.endedAt); assert.equal(interval.closedBy, 'run-pause')
})

test('a fix phase proposed for a phase-planned run follows the phase discussion and planning flow', async t => {
  const { fixture: graph } = await import('./fixtures/approved-graph.mjs')
  const f = graph(t, { phase: true, tasks: [{ id: 'T1' }] })
  f.planPhase('F1')
  f.ok('start', 'T1', '--agent', 'executor-1'); f.ok('review', 'T1', '--agent', 'reviewer-1')
  f.ok('validate', 'T1', '--ok', '--evidence', 'Delivery inspected independently', '--cwd', f.project); f.ok('done', 'T1')
  f.ok('audit-start', '--agent', 'auditor', '--environment', ENV, '--confirmed-by-user')
  const path = join(f.home, 'audit-report.json')
  writeFileSync(path, JSON.stringify(report([finding({ taskRefs: ['T1'] })])))
  f.ok('audit-finish', '--report', path)
  const out = join(f.home, 'fix-plan.json')
  f.ok('audit-fix-plan', '--out', out)
  f.ok('sync-plan', '--plan', out, '--propose', '--complete-audit', '1', '--confirmed-by-user')
  const proposed = f.state()
  assert.equal(proposed.plan.phases.at(-1).id, 'F3'); assert.equal(proposed.tasks.T2.phase, 'F3')
  assert.equal(proposed.phaseWorkflows.F3.state, 'pending')
  assert.match(f.ok('status'), /F3/)
  f.planPhase('F3')
  const planned = f.state()
  assert.ok(planned.tasks.T2.taskPlan)
  assert.equal(JSON.parse(f.ok('audit-status')).findings[0].fixTask, 'T2')
  f.ok('authorize', '--scope', 'phase:F3', '--confirmed-by-user')
  f.ok('start', 'T2', '--agent', 'fixer')
  f.rejects(/independent|different|same agent|not be the executor/i, 'review', 'T2', '--agent', 'fixer')
  f.ok('review', 'T2', '--agent', 'fix-reviewer')
  f.ok('validate', 'T2', '--ok', '--evidence', 'Correção e regressão conferidas', '--cwd', f.project)
  f.ok('done', 'T2')
  assert.ok(Object.values(f.state().tasks).every(task => task.state === 'done'))
  assert.equal(JSON.parse(f.ok('audit-status')).gate, false)
})

test('audit-start records report schema 2, audit-finish enforces it with translated refusals and an attempt without it keeps the old format', t => {
  const f = fixture(t)
  start(f)
  assert.equal(f.read().securityAudit.attempts[0].reportSchema, 2)
  const refuse = (value, pattern, lang = []) => assert.match(f.cli(['audit-finish', '--report', f.reportFile(value), ...lang], 1), pattern)
  const noScore = finding(); delete noScore.cvss
  refuse(report([noScore]), /finding\[0\]\.cvss is required for high findings/)
  refuse(report([noScore]), /finding\[0\]\.cvss é obrigatório para achados high/, ['--lang', 'pt-BR'])
  const reduced = finding({ severity: 'medium', cvss: { version: '4.0', vector: SCORES.high[0] + '/E:U' } })
  refuse(report([reduced]), /metric E is not allowed in audit reports/)
  refuse(report([reduced]), /a métrica E não é permitida em relatórios de auditoria/, ['--lang', 'pt-BR'])
  refuse(report([finding({ severity: 'critical', cvss: { version: '4.0', vector: SCORES.high[0], score: 7.1, scoreSource: 'calculator' } })]), /severity is critical but the final CVSS score 7\.1 is high/)
  refuse(report([finding({ severity: 'critical', cvss: { version: '4.0', vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N', score: 6.3, scoreSource: 'calculator' }, severityFloor: { class: 'rce', evidence: 'x' } })]), /severityFloor lifts the severity only to high/, [])
  assert.equal(f.read().securityAudit.state, 'running', 'refusals keep the audit running')
  const floor = finding({ severity: 'high', location: 'server.mjs:44', wstg: ['WSTG-INPV-19'], cvss: { version: '4.0', vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N', score: 6.3, scoreSource: 'calculator' }, severityFloor: { class: 'ssrf-internal', evidence: 'The local listener returned its nonce through the callback.' } })
  assert.match(f.cli(['audit-finish', '--report', f.reportFile(report([floor]))]), /finished: blocked/)
  assert.equal(JSON.parse(f.cli(['audit-status'])).findings[0].severityFloor.class, 'ssrf-internal')
  // An attempt that started before schema 2 existed has no reportSchema and finishes with the old rules.
  const old = fixture(t)
  start(old)
  old.mutate(current => { delete current.securityAudit.attempts[0].reportSchema })
  const legacy = finding(); delete legacy.cvss
  assert.match(old.cli(['audit-finish', '--report', old.reportFile(report([legacy]))]), /finished: blocked/)
})

test('audit-cvss prints the calculated score without a run or workspace and refuses a malformed vector', () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'prumo-cvss-')))
  try {
    const run = args => spawnSync(process.execPath, [engine, 'audit-cvss', ...args], { cwd: home, encoding: 'utf8', env: { ...process.env, PRUMO_HOME: join(home, 'store'), PRUMO_LANG: 'en', PRUMO_ROOT: '', GRAPH_ROOT: '', PRUMO_RUN: '' } })
    const ok = run(['CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N'])
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.deepEqual(JSON.parse(ok.stdout), { vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N', score: 6.3, severity: 'medium', nomenclature: 'CVSS-B' })
    const bad = run(['CVSS:4.0/AV:N'])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /audit-cvss: vector: base metric AC is missing or out of order/)
    assert.equal(run([]).status, 1)
    const option = run(['--bogus'])
    assert.equal(option.status, 1)
    assert.match(option.stderr, /Unknown option --bogus for audit-cvss/)
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})
