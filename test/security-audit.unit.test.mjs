import test from 'node:test'
import assert from 'node:assert/strict'
import { AuditError, refusalText, BLOCKING_SEVERITIES, graphClosed, openAuditAttempt, isLocalAuditEnvironment, validateAuditReport, auditCounts, blockingFindings, securityAuditView, securityBrief, auditAgentsInUse, markAuditDecisionIfClosed, enableAudit, skipAudit, startAudit, recordAuditReport, acceptFinding, auditActivityTarget, auditNotices, auditGateNotice, findingTag, findingFixTask, SECURITY_FINDING_TAG, securityFixPlan } from '../scripts/security-audit.mjs'
import { dispatchOwners, assertRolePreferences, pauseRun } from '../scripts/run-metadata.mjs'
import { occupancy } from '../scripts/execution-readiness.mjs'
import { isSafeTouch } from '../scripts/task-scope.mjs'
import { renumberBlockers } from '../scripts/task-renumber.mjs'
import { Cvss4Error } from '../scripts/cvss4.mjs'

const t = (state, extra = {}) => ({ state, ...extra })
const finding = (extra = {}) => ({ id: 'F1', severity: 'high', title: 'T', cwe: 'CWE-89', taskRefs: ['T1'], attackPath: 'a', evidence: 'e', reproduction: 'r', remediation: 'm', ...extra })
const refusal = (action, pattern) => assert.throws(action, error => error instanceof AuditError && pattern.test(error.message), String(pattern))

test('graphClosed requires at least one done task and no open task', () => {
  for (const [tasks, expected] of [[{}, false], [{ A: t('skipped') }, false], [{ A: t('done') }, true], [{ A: t('done'), B: t('skipped') }, true], [{ A: t('done'), B: t('pending') }, false], [{ A: t('done'), B: t('blocked') }, false]])
    assert.equal(graphClosed({ tasks }), expected)
  assert.equal(graphClosed({}), false)
})

test('an audit is open only while it is running and its latest attempt is unfinished', () => {
  const open = { n: 1, agent: 'a' }
  assert.equal(openAuditAttempt({ securityAudit: { state: 'running', attempts: [open] } }), open)
  for (const audit of [undefined, { state: 'running' }, { state: 'running', attempts: [] }, { state: 'running', attempts: [{ ...open, endedAt: 'x' }] }, { state: 'done', attempts: [open] }])
    assert.equal(openAuditAttempt({ securityAudit: audit }), null)
})

test('local audit environments accept a local origin with or without a path and normalize it to the origin', () => {
  const accepted = { localhost: 'http://localhost', 'LocalHost:3000': 'http://localhost:3000', 'LOCALHOST:5000': 'http://localhost:5000', 'http://127.0.0.1:8080': 'http://127.0.0.1:8080', 'https://[::1]': 'https://[::1]', 'https://[::1]:3000/': 'https://[::1]:3000', 'app.localhost': 'http://app.localhost', 'http://a.b.localhost:1/': 'http://a.b.localhost:1', 'shop.test': 'http://shop.test', 'https://api.shop.test:8443': 'https://api.shop.test:8443',
    'http://localhost:3000/app': 'http://localhost:3000', 'localhost/x': 'http://localhost', 'https://app.localhost/a/b/': 'https://app.localhost' }
  for (const [value, origin] of Object.entries(accepted)) assert.equal(isLocalAuditEnvironment(value), origin, value)
  // Userinfo, query, hash, other protocols and non-local hosts stay refused whatever follows the host.
  for (const value of ['evil-localhost.com', 'localhost.evil.com', 'http://localhost.evil.com/localhost', 'http://user@localhost', 'http://user:pw@localhost', 'http://localhost@evil.com', 'http://evil.com\\@localhost', 'ftp://localhost', 'file:///etc/passwd', 'localhost/x?y', 'http://localhost/path?x=1', 'http://localhost?x=1', 'http://localhost#h', 'http://localhost/a#h', 'localhost#', 'example.com', 'example.com/localhost', '10.0.0.1', 'http://10.0.0.5', 'http://', '', '   ', 'test', 'a.testing', undefined, null, 5, {}])
    assert.equal(isLocalAuditEnvironment(value), null, String(value))
})

test('report validation names the finding index and field, applying task aliases', () => {
  const state = { tasks: { T2: {} }, taskIdAliases: { T1: 'T2' } }, attempt = { environment: 'http://localhost:3000' }
  const base = (extra = {}) => ({ summary: 's', environment: 'localhost:3000', findings: [], ...extra })
  assert.deepEqual(validateAuditReport(base({ findings: [finding(), finding({ id: 'F2', taskRefs: [] })], tools: ['npm audit'] }), state, attempt).map(item => item.id), ['F1', 'F2'])
  const cases = [
    [null, /JSON object/], [[], /JSON object/], [base({ x: 1 }), /unknown field "x"/], [base({ summary: '' }), /summary/], [base({ environment: 'localhost:4000' }), /environment must match/],
    [base({ tools: 'x' }), /tools must be an array/], [base({ tools: [' '] }), /tools must be an array/], [base({ findings: null }), /findings must be an array/],
    [base({ findings: [1] }), /finding\[0\] must be an object/], [base({ findings: [[]] }), /finding\[0\] must be an object/],
    [base({ findings: [finding(), finding({ id: 'F2', cwe: 'cwe-1' })] }), /finding\[1\]\.cwe must look like CWE-89/],
    [base({ findings: [finding({ cwe: 'CWE-123456' })] }), /cwe/], [base({ findings: [finding({ severity: 'severe' })] }), /severity/],
    [base({ findings: [finding({ id: 7 })] }), /id must be/], [base({ findings: [finding(), finding()] }), /duplicated/],
    [base({ findings: [finding({ id: 'T1' })] }), /finding\[0\]\.id "T1" looks like a task identifier/], [base({ findings: [finding({ id: 't12-sqli' })] }), /task renumbering/],
    [base({ findings: [finding({ taskRefs: undefined })] }), /taskRefs must be an array/], [base({ findings: [finding({ taskRefs: ['T9'] })] }), /unknown task "T9"/],
    [base({ findings: [finding({ taskRefs: [3] })] }), /unknown task "3"/], [base({ findings: [finding({ extra: 1 })] }), /unknown field "extra"/],
    ...['title', 'attackPath', 'evidence', 'reproduction', 'remediation'].map(field => [base({ findings: [finding({ [field]: 1 })] }), new RegExp(`${field} must be a nonempty string`)]),
  ]
  for (const [report, pattern] of cases) assert.throws(() => validateAuditReport(report, state, attempt), pattern)
  assert.deepEqual(validateAuditReport(base(), {}, attempt), [])
  assert.deepEqual(validateAuditReport(base({ findings: [finding({ taskRefs: [] }), finding({ id: 'TOKEN-1', taskRefs: [] })] }), {}, attempt).length, 2, 'only T followed by a digit is refused')
})

test('counts and blocking findings are derived from one rule', () => {
  assert.deepEqual(BLOCKING_SEVERITIES, ['critical', 'high'])
  assert.deepEqual(auditCounts(), { critical: 0, high: 0, medium: 0, low: 0, info: 0 })
  const findings = [finding({ id: 'A', severity: 'critical' }), finding({ id: 'B' }), finding({ id: 'C', accepted: true }), finding({ id: 'D', severity: 'medium' })]
  assert.deepEqual(auditCounts(findings), { critical: 1, high: 2, medium: 1, low: 0, info: 0 })
  assert.deepEqual(blockingFindings({ report: { findings } }).map(item => item.id), ['A', 'B'])
  assert.deepEqual(blockingFindings({}), []); assert.deepEqual(blockingFindings(undefined), [])
})

test('security audit view derives pending-recheck and exposes attempts, counts and findings', () => {
  const closed = { A: t('done') }, open = { A: t('done'), B: t('pending') }
  assert.equal(securityAuditView({ tasks: closed }), null)
  const attempt = { n: 1, agent: 'x', environment: 'http://localhost', startedAt: 's', endedAt: 'e', result: 'blocked', report: { digest: 'd', findings: [finding()] } }
  const view = securityAuditView({ tasks: closed, securityAudit: { state: 'blocked', attempts: [attempt] } })
  assert.equal(view.state, 'blocked'); assert.equal(view.graphClosed, true); assert.deepEqual(view.blocking, ['F1']); assert.equal(view.attempts[0].digest, 'd'); assert.equal(view.counts.high, 1)
  assert.equal(securityAuditView({ tasks: open, securityAudit: { state: 'blocked', attempts: [attempt] } }).state, 'pending-recheck')
  assert.equal(securityAuditView({ tasks: open, securityAudit: { state: 'blocked', attempts: [attempt] } }).stored, 'blocked')
  const bare = securityAuditView({ tasks: closed, securityAudit: { state: 'awaiting-decision' } })
  assert.deepEqual([bare.attempts, bare.findings, bare.blocking, bare.previousBlocking], [[], [], [], []])
  assert.equal(securityAuditView({ tasks: closed, securityAudit: { state: 'running', attempts: [{ n: 1, agent: 'x' }] } }).attempts[0].endedAt, null)
})

test('the gate is open while the audit runs, awaits a re-check, blocks or still needs a decision', () => {
  const closed = { A: t('done') }, open = { A: t('done'), B: t('pending') }
  const gate = (tasks, audit) => securityAuditView({ tasks, securityAudit: audit }).gate
  assert.equal(gate(closed, { state: 'blocked', attempts: [] }), true)
  assert.equal(gate(closed, { state: 'awaiting-decision' }), true)
  assert.equal(gate(closed, { state: 'enabled' }), true)
  assert.equal(gate(closed, { state: 'running', attempts: [{ n: 1 }] }), true)
  assert.equal(gate(open, { state: 'running', attempts: [{ n: 1 }] }), true)
  assert.equal(gate(open, { state: 'blocked', attempts: [] }), true, 'pending-recheck')
  assert.equal(gate(open, { state: 'awaiting-decision' }), false, 'an open graph is not announced')
  assert.equal(gate(closed, { state: 'done', attempts: [] }), false)
  assert.equal(gate(closed, { state: 'skipped' }), false)
})

test('a running attempt starts empty and exposes the previous blocking findings it must revalidate', () => {
  const first = { n: 1, agent: 'old', environment: 'http://localhost', startedAt: 's', endedAt: 'e', result: 'blocked', report: { digest: 'd', findings: [finding({ id: 'A' }), finding({ id: 'B', severity: 'critical', accepted: true }), finding({ id: 'C', severity: 'low' }), finding({ id: 'D' })] } }
  const state = { run: 'r', plan: { name: 'n' }, tasks: { T1: t('done', { id: 'T1', title: 'One', notes: [{ text: 'EXECUTOR NOTE' }] }), T9: t('done', { id: 'T9', tags: [findingTag(1, 'D')] }) },
    securityAudit: { state: 'running', attempts: [first, { n: 2, agent: 'new', environment: 'http://localhost', startedAt: 's2' }] } }
  const view = securityAuditView(state)
  assert.equal(view.state, 'running'); assert.deepEqual(view.findings, []); assert.deepEqual(view.blocking, [])
  assert.deepEqual(view.previousBlocking.map(item => [item.id, item.status, item.fixTask, item.attempt]), [['A', 'open', null, 1], ['B', 'accepted', null, 1], ['D', 'fix-task', 'T9', 1]])
  assert.equal(view.previousBlocking[0].reproduction, 'r')
  const brief = securityBrief(state, tokens => tokens.join(' '))
  assert.deepEqual(brief.previousBlocking, view.previousBlocking)
  assert.equal(brief.previousBlocking[1].status, 'accepted')
  assert.match(brief.revalidation, /Revalidate every unaccepted entry of previousBlocking/)
  assert.match(brief.revalidation, /Accepted entries are history only: do not retest them or report them again/)
  assert.doesNotMatch(JSON.stringify(brief), /EXECUTOR NOTE/)
  assert.equal(Object.hasOwn(securityBrief({ ...state, securityAudit: { state: 'running', attempts: [{ n: 1, agent: 'x' }] } }, () => ''), 'revalidation'), false)
})

test('security role is a valid preference role and audit attempts are dispatch owners without a task', () => {
  assert.doesNotThrow(() => assertRolePreferences({ security: { model: 'opus' } }))
  const state = { tasks: {}, securityAudit: { attempts: [{ agent: 'a', startedAt: 's' }, { agent: 'b', startedAt: 't' }] } }
  assert.deepEqual(dispatchOwners(state).map(item => [item.key, item.task, item.role, item.agent]), [['run:security:0', null, 'security', 'a'], ['run:security:1', null, 'security', 'b']])
  assert.deepEqual(dispatchOwners({ tasks: {} }), [])
})

test('occupancy counts only an open running audit as an auditor', () => {
  const base = { tasks: {}, plan: { maxAgents: 2 } }
  const open = { n: 1, agent: 'a' }
  assert.equal(occupancy({ ...base, securityAudit: { state: 'running', attempts: [open] } }).busy.length, 1)
  assert.deepEqual(occupancy({ ...base, securityAudit: { state: 'running', attempts: [open] } }).auditors, [{ id: '@security-audit', state: 'auditing', agent: 'a' }])
  for (const audit of [undefined, { state: 'running' }, { state: 'running', attempts: [{ ...open, endedAt: 'x' }] }, { state: 'done', attempts: [open] }])
    assert.equal(occupancy({ ...base, securityAudit: audit }).auditors.length, 0)
})

test('pause-run closes the auditor interval like the other roles and ignores a finished audit', () => {
  const state = { tasks: {}, securityAudit: { state: 'running', attempts: [{ n: 1, agent: 'a', activityIntervals: [{ role: 'security', agent: 'a', startedAt: 's', endedAt: 'x' }, { role: 'security', agent: 'a', startedAt: 's2' }] }] } }
  pauseRun(state, 'maintenance', undefined, '2026-10-07T13:00:00.000Z')
  const [done, paused] = state.securityAudit.attempts[0].activityIntervals
  assert.equal(done.endedAt, 'x'); assert.equal(done.closedBy, undefined)
  assert.equal(paused.endedAt, '2026-10-07T13:00:00.000Z'); assert.equal(paused.closedBy, 'run-pause')
  const ended = { tasks: {}, securityAudit: { state: 'done', attempts: [{ n: 1, endedAt: 'e', activityIntervals: [{ role: 'security', startedAt: 's' }] }] } }
  pauseRun(ended, 'maintenance', undefined, '2026-10-07T13:00:00.000Z')
  assert.equal(ended.securityAudit.attempts[0].activityIntervals[0].endedAt, undefined)
  const bare = { tasks: {}, securityAudit: { state: 'running', attempts: [{ n: 1 }] } }
  assert.doesNotThrow(() => pauseRun(bare, 'maintenance', undefined, '2026-10-07T13:00:00.000Z'))
})

test('security brief carries every card, the last independent review and no executor narrative or notes', () => {
  const state = { run: 'r', plan: { name: 'n', description: 'd' }, tasks: {
    T1: { id: 'T1', title: 'One', phase: 'P1', state: 'done', touches: ['a'], progress: ['secret narrative'], failure: { reason: 'secret failure' }, lastRejection: 'x', notes: [{ text: 'secret note' }], deliveries: ['a'],
      validations: [{ by: 'review', ok: false, summary: 'no' }, { by: 'review', ok: true, agent: 'rev', at: 't', summary: 's', evidence: 'ev', deliveryCheck: { fingerprint: 'df' }, scopeCheck: { fingerprint: 'sf' } }] },
    T2: { id: 'T2', title: 'Two', state: 'skipped', skipReason: 'why', validations: [{ by: 'review', ok: true, at: 't2' }] },
    T3: { id: 'T3', title: 'Three', state: 'done' } } }
  const brief = securityBrief(state, tokens => tokens.join(' '))
  assert.deepEqual(brief.tasks.map(item => item.id), ['T1', 'T2', 'T3'])
  assert.deepEqual(brief.tasks[0].review, { agent: 'rev', at: 't', summary: 's', evidence: 'ev', deliveryFingerprint: 'df', scopeFingerprint: 'sf' })
  assert.equal(brief.tasks[1].review.agent, null); assert.equal(brief.tasks[1].review.deliveryFingerprint, null)
  assert.equal(brief.tasks[2].review, null); assert.equal(brief.tasks[2].phase, null); assert.equal(Object.hasOwn(brief.tasks[2], 'notes'), false)
  assert.equal(brief.tasks[1].skipReason, 'why'); assert.equal(brief.audit, null); assert.deepEqual(brief.previousBlocking, []); assert.equal(brief.modelPreference, null); assert.equal(brief.runPause, null)
  assert.doesNotMatch(JSON.stringify(brief), /secret/)
  assert.deepEqual(brief.context, { name: 'n', description: 'd', phases: [], scopePolicy: null, cwd: null })
  const configured = securityBrief({ ...state, runPause: { reason: 'p' }, plan: { ...state.plan, phases: [{ id: 'P1' }], scopePolicy: 'explicit', cwd: '/x', rolePreferences: { security: { model: 'm' } } } }, tokens => tokens.join(' '))
  assert.deepEqual(configured.modelPreference, { model: 'm' }); assert.equal(configured.context.cwd, '/x'); assert.equal(configured.runPause.reason, 'p')
  assert.match(brief.commands.join('|'), /activity-start security-audit.*audit-finish --report/)
})

test('briefing identifica o projeto de cada card para auditar a entrega no repositório correto', () => {
  const state = { run: 'demo', plan: { name: 'n', cwd: '/repo-a' }, tasks: {
    T1: { id: 'T1', state: 'done', project: '/repo-b', touches: ['src'] },
    T2: { id: 'T2', state: 'done', touches: ['out'] },
  } }
  const brief = securityBrief(state, () => '')
  assert.equal(brief.tasks[0].project, '/repo-b')
  assert.equal(brief.tasks[1].project, '/repo-a')
})

test('renumeração aguarda o auditor terminar para não transferir um achado a outra entrega', () => {
  const attempt = { n: 1, agent: 'auditor' }
  const state = { tasks: { T1: { state: 'done' }, T2: { state: 'skipped' } }, securityAudit: { state: 'running', attempts: [attempt] } }
  assert.deepEqual(renumberBlockers(state), [{ owner: 'security-audit', ownerType: 'run', state: 'running', kind: 'attempt', attempt: 1 }])
  assert.equal(renumberBlockers({ ...state, securityAudit: { state: 'done', attempts: [attempt] } }).length, 0)
  assert.equal(renumberBlockers({ ...state, securityAudit: { state: 'running', attempts: [{ ...attempt, endedAt: 'fim' }] } }).length, 0)
})

const blockedState = (findings, extraTasks = {}, audit = {}) => ({
  run: 'demo', plan: { name: 'approved', description: 'Approved delivery', phases: [{ id: 'F1', title: 'Build' }], maxParallel: 2, maxExecutors: 2, requireReview: true, cwd: '/project' },
  tasks: { T1: { id: 'T1', phase: 'F1', title: 'Invoices', state: 'done', deps: [], touches: ['src/invoices'], writeScope: 'files', tags: [], summary: 'Invoice delivery', label: 'Invoices', validation: [{ kind: 'static', run: 'node --check a.mjs', expect: 'ok' }, { kind: 'functional', run: 'npm run unit', expect: 'passes' }] }, ...extraTasks },
  securityAudit: { state: 'blocked', attempts: [{ n: 1, agent: 'auditor', environment: 'http://localhost', startedAt: 's', endedAt: 'e', result: 'blocked', report: { digest: 'd', findings } }], ...audit },
})

test('blocking findings report accepted, fix-task, fix-skipped or open; other severities carry no resolution', () => {
  const state = blockedState([finding({ id: 'A' }), finding({ id: 'B', accepted: true }), finding({ id: 'C', severity: 'critical' }), finding({ id: 'D', severity: 'low' }), finding({ id: 'E', accepted: true }), finding({ id: 'G' })],
    { T9: { id: 'T9', state: 'done', tags: [findingTag(1, 'C'), findingTag(1, 'E'), findingTag(2, 'A')] }, T8: { id: 'T8', state: 'skipped', tags: [findingTag(1, 'G')] } })
  const byId = Object.fromEntries(securityAuditView(state).findings.map(item => [item.id, item]))
  assert.deepEqual([byId.A.resolution, byId.A.fixTask], ['open', null])
  assert.deepEqual([byId.B.resolution, byId.B.fixTask], ['accepted', null])
  assert.deepEqual([byId.C.resolution, byId.C.fixTask], ['fix-task', 'T9'])
  assert.equal(byId.E.resolution, 'accepted', 'an accepted risk wins over a linked task')
  assert.deepEqual([byId.G.resolution, byId.G.fixTask], ['fix-skipped', 'T8'], 'a skipped fix task is not a delivered fix')
  assert.equal(Object.hasOwn(byId.D, 'resolution'), false)
  assert.equal(findingFixTask(state, 1, 'zzz'), null)
  assert.match(findingTag(3, 'F-1'), SECURITY_FINDING_TAG)
})

test('securityFixPlan refuses without a blocked finished audit, a blocking finding or an unlinked finding', () => {
  refusal(() => securityFixPlan({ tasks: {}, plan: {} }), /no blocked security audit/)
  refusal(() => securityFixPlan({ ...blockedState([finding()]), securityAudit: { state: 'done', attempts: [] } }), /no blocked security audit/)
  refusal(() => securityFixPlan({ ...blockedState([finding()]), securityAudit: { state: 'blocked', attempts: [{ n: 1, report: { findings: [finding()] } }] } }), /no blocked security audit/)
  refusal(() => securityFixPlan(blockedState([finding({ accepted: true }), finding({ id: 'M', severity: 'medium' })])), /no blocking finding left/)
  refusal(() => securityFixPlan(blockedState([finding()], { T2: { id: 'T2', state: 'pending', tags: [findingTag(1, 'F1')] } })), /already exist: F1=T2/)
})

test('securityFixPlan appends one phase with a task per blocking finding and keeps the persisted plan intact', () => {
  const state = blockedState([finding({ id: 'A', title: 'IDOR', taskRefs: ['T1'], cwe: 'CWE-639' }), finding({ id: 'B', severity: 'critical', taskRefs: ['T5'] }), finding({ id: 'C', accepted: true }), finding({ id: 'D', severity: 'medium' })],
    { T5: { id: 'T5', phase: 'F1', title: 'Lib', state: 'done', deps: ['T1'], touches: ['lib', '../escape', '/abs', 'C:/win', 7], project: '/other', tags: [] } })
  state.removedTasks = { T7: {} }; state.taskIdAliases = { T8: 'T5' }
  const plan = securityFixPlan(state)
  assert.deepEqual(plan.phases, [{ id: 'F1', title: 'Build' }, { id: 'F2', title: 'Security fixes (audit #1)' }])
  assert.deepEqual(plan.tasks.map(item => item.id), ['T1', 'T5', 'T9', 'T10'])
  assert.deepEqual([plan.name, plan.description, plan.maxParallel, plan.maxExecutors, plan.requireReview], ['approved', 'Approved delivery', 2, 2, true])
  assert.equal(Object.hasOwn(plan, 'scopePolicy'), false); assert.equal(Object.hasOwn(plan, 'rolePreferences'), false)
  const [existing] = plan.tasks
  assert.deepEqual([existing.summary, existing.label, existing.touches], ['Invoice delivery', 'Invoices', ['src/invoices']])
  const [first, second] = plan.tasks.slice(2)
  assert.equal(first.title, 'Fix IDOR (CWE-639)'); assert.equal(first.phase, 'F2')
  assert.deepEqual(first.tags, [findingTag(1, 'A'), 'security-fix']); assert.deepEqual(first.deps, [])
  assert.deepEqual([first.touches, first.writeScope, first.project], [['src/invoices'], 'files', undefined])
  assert.deepEqual([second.touches, second.writeScope, second.project], [['lib'], 'files', '/other'])
  assert.deepEqual(first.validation, [{ kind: 'functional', run: 'npm run unit', expect: 'All tests pass, including a regression test that reproduces the attack path of finding A (CWE-639) and fails without the fix' }])
  assert.match(first.summary, /IDOR.*CWE-639.*high.*a$/); assert.match(first.validationSummary, /fails before the fix and passes after it.*m$/)
  assert.deepEqual(first.securityFinding, { audit: 1, id: 'A', severity: 'high', cwe: 'CWE-639', evidence: 'e', reproduction: 'r', remediation: 'm' })
  assert.deepEqual(second.deps, [], 'different projects never collide')
})

test('securityFixPlan chains colliding scopes, resolves aliases and honors the test command without inventing one', () => {
  const state = blockedState([finding({ id: 'A', taskRefs: ['T1'] }), finding({ id: 'B', taskRefs: ['OLD'] }), finding({ id: 'C', taskRefs: [] })])
  state.taskIdAliases = { OLD: 'T1' }; state.plan.scopePolicy = 'explicit'; state.plan.rolePreferences = { security: { model: 'opus' } }
  const [, a, b, c] = securityFixPlan(state).tasks
  assert.deepEqual([a.deps, b.deps, c.deps], [[], ['T2'], []])
  assert.deepEqual([c.touches, c.writeScope], [[], 'unknown'])
  assert.equal(securityFixPlan(state).scopePolicy, 'explicit'); assert.deepEqual(securityFixPlan(state).rolePreferences, { security: { model: 'opus' } })
  assert.equal(securityFixPlan(state, 'make verify').tasks[1].validation[0].run, 'make verify')
  state.tasks.T1.validation = [{ kind: 'static', run: 'lint', expect: 'ok' }]
  refusal(() => securityFixPlan(state), /no functional validation command can be derived.*--test-command/)
  state.tasks.T1.validation = [{ kind: 'functional', run: 'npm run unit', expect: 'ok' }]; state.tasks.T1.state = 'skipped'
  refusal(() => securityFixPlan(state), /--test-command/)
  assert.equal(securityFixPlan(state, 'make verify').tasks[1].validation[0].run, 'make verify')
})

test('touches are safe only when they stay inside the repository', () => {
  for (const value of ['src', 'a/b.txt', '.', 'a\\b']) assert.equal(isSafeTouch(value), true, value)
  for (const value of ['', ' ', '../x', 'a/../b', '/abs', '\\abs', 'C:/win', 'a\0b', 7, null, undefined]) assert.equal(isSafeTouch(value), false, String(value))
})

test('the auditor must differ from every executor, reviewer and planner, ignoring case, spaces and removed tasks', () => {
  const state = {
    tasks: { T1: { agent: ' Exec-1 ', reviewer: 'Rev-1', planner: 'Plan-1',
      attempts: [{ agent: 'attempt-exec', reviewer: 'attempt-rev', reviewHistory: [{ reviewer: 'History-Rev' }], reviewStartedAt: 'x' }, { agent: 'second-exec' }],
      planningAttempts: [{ agent: 'task-planner', activityAgent: 'Activity-Planner', workers: { T1: { agent: 'Worker-Only', activityAgent: 'worker-activity' } } }],
      discussionAttempts: [{ activityAgent: 'task-discusser' }] }, T2: {} },
    phaseWorkflows: { F1: { planner: 'phase-planner', planningAttempts: [{ agent: 'round-planner', assignments: { T1: 'assigned-planner' } }], discussionAttempts: [{ agent: 'phase-discusser', workers: { T1: { agent: 'discuss-worker' } } }] }, F2: {} },
    removedTasks: { T9: { task: { agent: 'Gone-Exec', attempts: [{ reviewer: 'gone-rev' }], planningAttempts: [{ agent: 'gone-planner' }] } }, T8: {}, T7: null },
    securityAudit: { attempts: [{ agent: 'Previous-Auditor' }] } }
  const names = auditAgentsInUse(state, dispatchOwners)
  for (const name of ['exec-1', 'rev-1', 'plan-1', 'attempt-exec', 'attempt-rev', 'history-rev', 'second-exec', 'task-planner', 'activity-planner', 'worker-only', 'worker-activity', 'task-discusser', 'phase-planner', 'round-planner', 'assigned-planner', 'phase-discusser', 'discuss-worker', 'gone-exec', 'gone-rev', 'gone-planner'])
    assert.ok(names.has(name), name)
  assert.equal(names.has('previous-auditor'), false, 'earlier auditors do not block the next attempt')
  assert.deepEqual(auditAgentsInUse({ tasks: {} }, dispatchOwners), new Set())
})

const closedRun = (extra = {}) => ({ tasks: { T1: { id: 'T1', state: 'done', agent: 'exec' }, ...extra.tasks }, ...extra.rest })
const startContext = (extra = {}) => ({ agent: 'auditor', environment: 'http://localhost:3000/app', at: 'now', dispatchOwners, used: 0, cap: 3, ...extra })

test('closing the graph asks once, never retroactively invents a block and asks again for unaudited work', () => {
  const open = { tasks: { T1: t('done'), T2: t('pending') } }
  markAuditDecisionIfClosed(open, 'x'); assert.equal(open.securityAudit, undefined)
  const closed = { tasks: { T1: t('done') } }
  markAuditDecisionIfClosed(closed, 'x'); assert.deepEqual(closed.securityAudit, { state: 'awaiting-decision', announcedAt: 'x' })
  const defaulted = { tasks: { T1: t('done') } }
  markAuditDecisionIfClosed(defaulted); assert.equal(defaulted.securityAudit.state, 'awaiting-decision'); assert.ok(defaulted.securityAudit.announcedAt)
  const passed = { tasks: { T1: t('done'), T2: t('done') }, securityAudit: { state: 'done', attempts: [{ taskIds: ['T1'] }] } }
  markAuditDecisionIfClosed(passed, 'y'); assert.deepEqual([passed.securityAudit.state, passed.securityAudit.announcedAt, passed.securityAudit.attempts.length], ['awaiting-decision', 'y', 1])
  const audited = { tasks: { T1: t('done') }, securityAudit: { state: 'done', attempts: [{ taskIds: ['T1'] }] } }
  markAuditDecisionIfClosed(audited, 'z'); assert.equal(audited.securityAudit.state, 'done')
  for (const audit of [{ state: 'skipped' }, { state: 'done' }, { state: 'blocked', attempts: [{ taskIds: [] }] }]) {
    const other = { tasks: { T1: t('done') }, securityAudit: audit }
    markAuditDecisionIfClosed(other, 'z'); assert.equal(other.securityAudit.state, audit.state)
  }
})

test('enable and skip record the user decision and refuse while the audit runs, is blocked or is done', () => {
  const state = closedRun()
  assert.deepEqual(enableAudit(state, 'at'), { state: 'enabled', enabledAt: 'at', confirmedByUser: true })
  assert.deepEqual(skipAudit(state, 'No exposure', 'at'), { state: 'skipped', skip: { reason: 'No exposure', at: 'at', confirmedByUser: true } })
  const kept = { ...state, securityAudit: { state: 'awaiting-decision', announcedAt: 'a' } }
  assert.equal(enableAudit(kept, 'at').announcedAt, 'a'); assert.equal(skipAudit(kept, 'r', 'at').announcedAt, 'a')
  const running = { ...state, securityAudit: { state: 'running' } }, blocked = { ...state, securityAudit: { state: 'blocked' } }, done = { ...state, securityAudit: { state: 'done' } }
  refusal(() => enableAudit(running, 'at'), /is running/); refusal(() => skipAudit(running, 'r', 'at'), /is running/)
  refusal(() => enableAudit(blocked, 'at'), /blocked by findings/); refusal(() => skipAudit(blocked, 'r', 'at'), /cannot be skipped/)
  refusal(() => enableAudit(done, 'at'), /already done/); refusal(() => skipAudit(done, 'r', 'at'), /already done/)
  assert.equal(enableAudit({ tasks: { T1: t('done'), T2: t('pending') }, securityAudit: { state: 'done' } }, 'at').state, 'enabled', 'reopened work can be pre-authorized again')
})

test('startAudit validates every precondition in order and returns the next block without recording on refusal', () => {
  const state = closedRun()
  const { audit, attempt } = startAudit(state, startContext())
  assert.deepEqual(attempt, { n: 1, agent: 'auditor', environment: 'http://localhost:3000', startedAt: 'now', confirmedByUser: true, taskIds: ['T1'], reportSchema: 2 })
  assert.deepEqual(audit, { state: 'running', attempts: [attempt] }); assert.equal(state.securityAudit, undefined)
  const second = startAudit({ ...state, securityAudit: { state: 'blocked', announcedAt: 'a', attempts: [{ n: 1 }] } }, startContext({ agent: 'auditor-2' }))
  assert.deepEqual([second.attempt.n, second.audit.attempts.length, second.audit.announcedAt], [2, 2, 'a'])
  refusal(() => startAudit({ tasks: { T1: t('done'), T2: t('pending') } }, startContext()), /every task is done or skipped/)
  refusal(() => startAudit({ tasks: { T1: t('done'), T2: t('pending') }, securityAudit: { state: 'blocked' } }, startContext()), /tasks were reopened/)
  refusal(() => startAudit({ tasks: { T1: t('skipped'), T2: t('skipped') } }, startContext()), /no delivered task to audit: every task was skipped/)
  refusal(() => startAudit({ tasks: {} }, startContext()), /no delivered task to audit/)
  refusal(() => startAudit({ ...state, securityAudit: { state: 'running' } }, startContext()), /already running/)
  refusal(() => startAudit({ ...state, securityAudit: { state: 'done' } }, startContext()), /already done/)
  refusal(() => startAudit(state, startContext({ agent: 'Exec' })), /Exec already executed, reviewed or planned a task; the auditor must be independent/)
  refusal(() => startAudit(state, startContext({ used: 3 })), /no agent slot available for the auditor \(3\/3 in use\)/)
  refusal(() => startAudit(state, startContext({ environment: 'example.com' })), /must be a local host/)
  assert.equal(new AuditError('{0}-{1}', 0, 'x').message, '0-x'); assert.equal(new AuditError('{2}').message, '{2}')
})

test('recordAuditReport derives the result from blocking findings and acceptFinding closes the audit when none is left', () => {
  const attempt = { n: 1, environment: 'http://localhost' }, state = { securityAudit: { state: 'running', attempts: [attempt] } }
  const findings = [finding({ id: 'A' }), finding({ id: 'B', severity: 'critical' }), finding({ id: 'C', severity: 'low' })]
  assert.deepEqual(recordAuditReport(state, attempt, { report: { summary: 's', tools: ['x'] }, findings, path: 'p', digest: 'd', at: 'e' }), { critical: 1, high: 1, medium: 0, low: 1, info: 0 })
  assert.deepEqual([state.securityAudit.state, attempt.result, attempt.endedAt, attempt.report.tools, attempt.report.environment], ['blocked', 'blocked', 'e', ['x'], 'http://localhost'])
  refusal(() => acceptFinding({ securityAudit: { state: 'done' } }, 'A', 'r', 'at'), /no blocking security findings to accept/)
  refusal(() => acceptFinding(state, 'Z', 'r', 'at'), /unknown finding "Z"/)
  refusal(() => acceptFinding(state, 'C', 'r', 'at'), /C is not a blocking finding/)
  assert.equal(acceptFinding(state, 'A', 'because', 'at'), 'blocked')
  refusal(() => acceptFinding(state, 'A', 'again', 'at'), /A was already accepted/)
  assert.equal(acceptFinding(state, 'B', 'also', 'at2'), 'done')
  assert.deepEqual(attempt.acceptances.map(item => [item.finding, item.reason, item.at, item.confirmedByUser]), [['A', 'because', 'at', true], ['B', 'also', 'at2', true]])
  const clean = { securityAudit: { state: 'running', attempts: [{ n: 1, environment: 'http://localhost' }] } }
  recordAuditReport(clean, clean.securityAudit.attempts[0], { report: { summary: 's' }, findings: [], path: 'p', digest: 'd', at: 'e' })
  assert.equal(clean.securityAudit.state, 'done'); assert.equal(Object.hasOwn(clean.securityAudit.attempts[0].report, 'tools'), false)
})

test('run activity targets only the running auditor and the security-audit id', () => {
  const state = { tasks: {}, securityAudit: { state: 'running', attempts: [{ n: 1, agent: 'auditor' }] } }
  assert.equal(auditActivityTarget(state, 'security-audit', 'security', 'auditor'), state.securityAudit.attempts[0])
  for (const [id, role, agent] of [['T1', 'security', 'auditor'], ['security-audit', 'execution', 'auditor'], ['security-audit', 'security', ' '], ['security-audit', 'security', undefined]])
    refusal(() => auditActivityTarget(state, id, role, agent), /needs the id security-audit, the security role and a nonempty agent/)
  refusal(() => auditActivityTarget(state, 'security-audit', 'security', 'someone-else'), /security-audit security activity belongs to auditor/)
  refusal(() => auditActivityTarget({ tasks: {} }, 'security-audit', 'security', 'auditor'), /security-audit has no running security audit/)
})

test('notices announce the decision, the gate and each blocked resolution without repeating the wrong guidance', () => {
  const closed = { A: t('done') }, open = { A: t('done'), B: t('pending') }
  const notices = (tasks, audit, extraTasks = {}) => auditNotices({ tasks: { ...tasks, ...extraTasks }, securityAudit: audit }).map(([message]) => message)
  assert.deepEqual(auditNotices({ tasks: closed }), []); assert.equal(auditGateNotice({ tasks: closed }), null)
  assert.match(notices(closed, { state: 'running', attempts: [{ n: 1, agent: 'x' }] })[0], /security audit running/)
  assert.deepEqual(auditNotices({ tasks: closed, securityAudit: { state: 'running', attempts: [{ n: 1, agent: 'x' }] } })[0].slice(1), ['x'])
  assert.match(notices(open, { state: 'blocked', attempts: [] })[0], /tasks were reopened after blocking findings/)
  assert.deepEqual(notices(open, { state: 'awaiting-decision' }), [], 'an open graph without a re-check is not announced')
  assert.match(notices(closed, { state: 'awaiting-decision' })[0], /DECISION PENDING/)
  assert.match(notices(closed, { state: 'enabled' })[0], /pre-authorized/)
  for (const audit of [{ state: 'skipped' }, { state: 'done', attempts: [] }]) assert.deepEqual(notices(closed, audit), [])
  const blocked = findings => ({ state: 'blocked', attempts: [{ n: 1, agent: 'x', endedAt: 'e', report: { findings } }] })
  const open1 = notices(closed, blocked([finding({ id: 'A' })]))
  assert.deepEqual(open1.map(message => message.slice(0, 18)), ['SECURITY AUDIT BLO', 'Present each findi', 'Then run audit-fix'])
  const skipped = auditNotices({ tasks: { ...closed, T9: t('skipped', { id: 'T9', tags: [findingTag(1, 'A')] }) }, securityAudit: blocked([finding({ id: 'A' })]) })
  assert.match(skipped[1][0], /fix tasks of \{0\} were skipped/); assert.deepEqual([skipped[1][1], skipped.length], ['A', 2])
  const both = notices({ ...closed, T9: t('skipped', { id: 'T9', tags: [findingTag(1, 'A')] }) }, blocked([finding({ id: 'A' }), finding({ id: 'B' })]))
  assert.equal(both.length, 4)
  const fixed = notices({ ...closed, T9: t('done', { id: 'T9', tags: [findingTag(1, 'A')] }) }, blocked([finding({ id: 'A' })]))
  assert.match(fixed[1], /All blocking findings are accepted or have finished fix tasks/)
  assert.deepEqual(auditGateNotice({ tasks: closed, securityAudit: { state: 'blocked', attempts: [] } }), ['SECURITY AUDIT GATE OPEN ({0}): do not declare the demand closed to the user until the audit is done or skipped', 'blocked'])
  assert.equal(auditGateNotice({ tasks: closed, securityAudit: { state: 'done', attempts: [] } }), null)
})

test('functions tolerate states that omit optional collections', () => {
  assert.equal(findingFixTask({}, 1, 'F1'), null)
  assert.deepEqual(securityBrief({ run: 'r', plan: {} }, () => '').tasks, [])
  assert.deepEqual(auditAgentsInUse({}, dispatchOwners), new Set())
  refusal(() => startAudit({}, startContext()), /no delivered task to audit/)
  assert.throws(() => validateAuditReport({ summary: 's', environment: 'localhost', findings: [finding()] }, {}, { environment: 'http://localhost' }), /unknown task "T1"/)
  const minimal = { run: 'r', plan: { name: 'n' }, tasks: { T1: { id: 'T1', state: 'done', title: 'One', deps: [], validation: [{ kind: 'functional', run: 'node --test', expect: 'ok' }] } },
    securityAudit: { state: 'blocked', attempts: [{ n: 1, endedAt: 'e', report: { findings: [finding()] } }] } }
  const plan = securityFixPlan(minimal)
  assert.deepEqual([plan.description, plan.phases, plan.tasks.at(-1).id, plan.tasks.at(-1).touches], ['', [{ id: 'F1', title: 'Security fixes (audit #1)' }], 'T2', []])
})

test('refusals are translated through their template while other errors keep their text', () => {
  assert.equal(refusalText(new AuditError('{0} refused: {1}', 'a', 'b'), (template, ...values) => template + '|' + values.join(',')), '{0} refused: {1}|a,b')
  assert.equal(refusalText(new Error('plain'), () => 'translated'), 'plain')
  assert.equal(refusalText(new Cvss4Error('{0}: metric {1}', 'vector', 'AV'), (template, ...values) => template + '|' + values.join(',')), '{0}: metric {1}|vector,AV')
})

// Report schema 2: CVSS v4.0 backed severity, class floor, re-audit coverage. Attempts without reportSchema keep the old rules.
const BASE = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N'
const cvss = (extra = {}, vector = BASE, score = 8.7) => ({ version: '4.0', vector, score, scoreSource: 'estimated', ...extra })
const finding2 = (extra = {}) => finding({ cvss: cvss(), ...extra })
const CRITICAL = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'
const SSRF = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N'
const v2 = { state: { tasks: { T1: {}, T2: {} } }, attempt: { environment: 'http://localhost:3000', reportSchema: 2 } }
const report2 = (findings, extra = {}) => ({ summary: 's', environment: 'localhost:3000', findings, ...extra })
const check2 = (findings, extra, state = v2.state, attempt = v2.attempt) => validateAuditReport(report2(findings, extra), state, attempt)

test('relatório não pode reduzir o bloqueio com métricas de ameaça ou ambientais sem evidência do card', () => {
  const vector = BASE.replace('PR:N', 'PR:L')
  const auditCvss = vector => ({ version: '4.0', vector })
  assert.equal(check2([finding2({ cvss: auditCvss(vector) })])[0].cvss.computedScore, 7.1)
  for (const suffix of ['/E:U', '/E:P', '/E:A']) {
    assert.throws(() => check2([finding2({ severity: suffix === '/E:A' ? 'high' : 'medium', cvss: auditCvss(vector + suffix) })]), /cvss\.vector.*E.*not allowed/)
    assert.throws(() => check2([finding2({ cvss: { ...auditCvss(vector), environmental: { vector: vector + suffix } }, severityRationale: 'T1.' })]), /cvss\.environmental\.vector.*E.*not allowed/)
  }
  assert.throws(() => check2([finding2({ severity: 'info', cvss: auditCvss(vector + '/MVC:N/MVI:N/MVA:N/MSC:N/MSI:N/MSA:N') })]), /cvss\.vector.*cvss\.environmental.*card evidence/)
  assert.throws(() => check2([finding2({ cvss: auditCvss(vector + '/CR:H') })]), /cvss\.vector.*cvss\.environmental.*card evidence/)
  assert.equal(check2([finding2({ cvss: auditCvss(vector + '/E:X/CR:X/MVC:X/S:P') })])[0].cvss.computedScore, 7.1)
  assert.equal(check2([finding2({ severity: 'medium', cvss: { ...auditCvss(vector), environmental: { vector: vector + '/MVC:L' } }, severityRationale: 'T1 limita os dados expostos.' })])[0].cvss.environmental.computedScore, 5.3)
})

test('schema 2 accepts a complete finding and the old attempt keeps the old format untouched', () => {
  const full = finding2({ location: 'server.mjs:38 readToken', wstg: ['WSTG-SESS-10', 'WSTG-ATHN-04'], severityRationale: 'Public API; T1 stores the token.', chainedWith: ['F2'] })
  assert.deepEqual(check2([full, finding2({ id: 'F2' })]).map(item => item.id), ['F1', 'F2'])
  assert.equal(check2([finding({ id: 'F3', severity: 'low' })]).length, 1, 'low and info need no cvss')
  assert.equal(check2([finding2({ severity: 'low', cvss: { version: '4.0', vector: 'CVSS:4.0/AV:P/AC:H/AT:N/PR:H/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N' } })])[0].cvss.computedScore, 1)
  assert.equal(check2([finding({ id: 'F3', severity: 'info', cvss: cvss({}, BASE.replace('VC:H', 'VC:N'), 0) })]).length, 1)
  const oldAttempt = { environment: 'http://localhost:3000' }
  assert.equal(validateAuditReport(report2([finding({ id: 'F9', severity: 'high' })]), v2.state, oldAttempt).length, 1, 'high without cvss still finishes in an old attempt')
  assert.throws(() => validateAuditReport(report2([finding2()]), v2.state, oldAttempt), /unknown field "cvss"/)
  assert.throws(() => validateAuditReport(report2([finding({ location: 'x' })]), v2.state, oldAttempt), /unknown field "location"/)
  assert.throws(() => validateAuditReport(report2([], { revalidates: [] }), v2.state, oldAttempt), /unknown field "revalidates"/)
})

test('schema 2 refuses each malformed field naming the finding and the field', () => {
  const cases = [
    [finding({ id: 'X1' }), /finding\[0\]\.id "X1" must look like F<number>/], [finding({ id: 'F' }), /must look like F<number>/],
    [finding({ severity: 'high' }), /finding\[0\]\.cvss is required for high findings/], [finding({ severity: 'medium' }), /cvss is required for medium/],
    [finding2({ location: ' ' }), /location must be a nonempty string/], [finding2({ location: 'x'.repeat(301) }), /location must be a nonempty string/],
    [finding2({ wstg: [] }), /wstg must be a nonempty array/], [finding2({ wstg: ['WSTG-ATHZ-4'] }), /wstg must be/], [finding2({ wstg: ['WSTG-ATHZ-04', 'WSTG-ATHZ-04'] }), /wstg must be/],
    [finding2({ cvss: { ...cvss(), extra: 1 } }), /cvss must have version and vector/], [finding2({ cvss: [] }), /cvss must have version and vector/], [finding2({ cvss: { version: '4.0' } }), /cvss must have version and vector/],
    [finding2({ cvss: cvss({ version: '3.1' }) }), /cvss\.version must be "4\.0"/], [finding2({ cvss: cvss({ scoreSource: 'online' }) }), /scoreSource must be calculator or estimated/],
    ...[10.1, -1, 8.75, '8.7', NaN].map(score => [finding2({ cvss: cvss({ score }) }), /cvss\.score must be a number from 0\.0 to 10\.0 with at most one decimal/]),
    [finding2({ cvss: cvss({}, BASE.replace('CVSS:4.0', 'CVSS:3.1')) }), /cvss\.vector must start with CVSS:4\.0\//],
    [finding2({ cvss: cvss({}, BASE.replace('/AT:N', '')) }), /base metric AT is missing or out of order/],
    [finding2({ cvss: cvss({}, BASE.replace('/AV:N/AC:L', '/AC:L/AV:N')) }), /base metric AV is missing or out of order/],
    [finding2({ cvss: cvss({}, BASE.replace('AV:N', 'AV:Z')) }), /metric AV has an invalid value "Z"/],
    [finding2({ cvss: cvss({}, BASE + '/CR:H/CR:H') }), /repeated or misordered metric "CR:H"/], [finding2({ cvss: cvss({}, BASE + '/IR:H/CR:H') }), /misordered metric "CR:H"/],
    [finding2({ cvss: cvss({}, BASE + '/ZZ:H') }), /unknown, repeated or misordered metric "ZZ:H"/], [finding2({ cvss: cvss({}, BASE + '/CR:Q') }), /metric CR has an invalid value "Q"/],
    [finding2({ cvss: cvss({}, BASE + '/') }), /unknown, repeated or misordered metric ""/], [finding2({ cvss: cvss({}, BASE + '/CR:H:H') }), /misordered metric "CR:H:H"/],
    [finding2({ cvss: cvss({}, BASE.replace('VC:H', 'VC:N'), 3), severity: 'low' }), /cvss\.score 3 differs from the score 0 the engine calculates from cvss\.vector/], [finding2({ cvss: cvss({}, BASE, 0), severity: 'info' }), /cvss\.score 0 differs from the score 8\.7/],
    [finding2({ cvss: cvss({}, BASE, 6.9) }), /cvss\.score 6\.9 differs from the score 8\.7 the engine calculates .*audit-cvss/],
    [finding2({ severity: 'critical' }), /severity is critical but the final CVSS score 8\.7 is high; the severity must match the score unless a severityFloor applies/],
    [finding2({ severity: 'medium' }), /severity is medium but the final CVSS score 8\.7 is high/],
    [finding2({ severity: 'high', cvss: cvss({}, SSRF, 6.3) }), /severity is high but the final CVSS score 6\.3 is medium/],
    [finding2({ severityRationale: '' }), /severityRationale must be a nonempty string/], [finding2({ severityRationale: 'x'.repeat(1001) }), /severityRationale must be/],
    [finding2({ chainedWith: [] }), /chainedWith must be a nonempty array/], [finding2({ chainedWith: ['F1'] }), /chainedWith references "F1"/], [finding2({ chainedWith: ['F8'] }), /chainedWith references "F8"/],
  ]
  for (const [item, pattern] of cases) assert.throws(() => check2([item]), pattern, String(pattern))
  assert.throws(() => check2([finding({ severity: 'low', chainedWith: ['F2'] }), finding2({ id: 'F2' })]), /finding\[0\]\.chainedWith requires cvss/)
  assert.throws(() => check2([finding({ severity: 'low', severityFloor: { class: 'rce', evidence: 'e' } })]), /severityFloor requires cvss/)
})

test('the final severity follows the base score, or the environmental score only with card evidence naming a task', () => {
  const SAFETY = SSRF + '/MSI:S/MSA:S/U:Red'
  const env = (score, vector = SSRF + '/CR:H/IR:H') => cvss({ environmental: { vector, score } }, SSRF, 6.3)
  const medium = { severity: 'medium', cvss: env(6.3) }
  assert.equal(check2([finding2({ ...medium, severityRationale: 'T1 says the internal service holds secrets.' })]).length, 1)
  assert.equal(check2([finding2({ severity: 'high', cvss: env(8.3, SAFETY), severityRationale: 'T1 classifies the data as restricted.' })]).length, 1, 'the band of the environmental score decides')
  assert.throws(() => check2([finding2({ severity: 'medium', cvss: env(8.3, SAFETY), severityRationale: 'T1 classifies the data.' })]), /final CVSS score 8\.3 is high/)
  assert.throws(() => check2([finding2({ severity: 'high', cvss: cvss({ environmental: { vector: BASE + '/MVC:L' } }, BASE), severityRationale: 'T1.' })]), /severity is high but the final CVSS score 6\.9 is medium/, 'the base score alone does not decide when an environmental one exists')
  assert.throws(() => check2([finding2(medium)]), /severityRationale is required when cvss\.environmental is present/)
  for (const rationale of ['The internal service holds secrets.', 'Cites T9 which is not a ref.', 'Cites T10 only', 'T1x holds secrets.']) assert.throws(() => check2([finding2({ ...medium, severityRationale: rationale })]), /must cite at least one of the finding taskRefs \(T1\)/, rationale)
  assert.throws(() => check2([finding2({ ...medium, taskRefs: [], severityRationale: 'T1 holds secrets.' })]), /must cite at least one of the finding taskRefs \(\)/)
  const aliased = { tasks: { T2: {} }, taskIdAliases: { T1: 'T2' } }
  assert.equal(check2([finding2({ ...medium, severityRationale: 'T2 holds secrets.' })], undefined, aliased).length, 1, 'an alias resolves to the same card')
  assert.equal(check2([finding2({ ...medium, cvss: cvss({ environmental: { vector: SSRF + '/CR:H' } }, SSRF, 6.3), severityRationale: 'T1 says the internal service holds secrets.' })]).length, 1, 'the environmental score is optional')
  for (const bad of [{ vector: SSRF + '/CR:H', score: 'x' }, { vector: SSRF.replace('AV:N', 'AV:L') + '/CR:H', score: 6.1 }, { vector: SSRF, score: 0 }, { vector: SSRF + '/CR:H', score: 7.4 }, { score: 6.3 }]) assert.throws(() => check2([finding2({ severity: 'medium', cvss: cvss({ environmental: bad }, SSRF, 6.3), severityRationale: 'T1.' })]), /cvss\.environmental/)
  // Modified metrics override the base ones: every impact modified to N means the environmental score must be 0.0.
  const none = SSRF + '/MVC:N/MVI:N/MVA:N/MSC:N/MSI:N/MSA:N'
  assert.throws(() => check2([finding2({ severity: 'medium', cvss: cvss({ environmental: { vector: none, score: 4.1 } }, SSRF, 6.3), severityRationale: 'T1.' })]), /cvss\.environmental\.score 4\.1 differs from the score 0 the engine calculates from cvss\.environmental\.vector/)
  assert.equal(check2([finding2({ severity: 'info', cvss: cvss({ environmental: { vector: none, score: 0 } }, SSRF, 6.3), severityRationale: 'T1 moves the data off the host.' })]).length, 1)
  assert.equal(check2([finding2({ severity: 'high', cvss: cvss({ environmental: { vector: SAFETY, score: 8.3 } }, SSRF, 6.3), severityRationale: 'T1 safety.' })]).length, 1, 'safety values and supplemental metrics are valid')
})

test('the class floor lifts a lower score to high only, with a valid class and the proof', () => {
  const floor = { class: 'ssrf-internal', evidence: 'The local listener on 127.0.0.1 returned its nonce through the callback.' }
  const ssrf = (extra = {}) => finding2({ severity: 'high', cvss: cvss({}, SSRF, 6.3), severityFloor: floor, ...extra })
  assert.equal(check2([ssrf()]).length, 1, 'medium score lifted to high by the floor')
  for (const kind of ['ssrf-internal', 'rce', 'auth-bypass', 'credential-exposure']) assert.equal(check2([ssrf({ severityFloor: { ...floor, class: kind } })]).length, 1, kind)
  assert.equal(check2([finding2({ severityFloor: floor })]).length, 1, 'a floor on a finding already at its band changes nothing')
  assert.throws(() => check2([ssrf({ severityFloor: { ...floor, class: 'xss' } })]), /severityFloor\.class must be one of ssrf-internal\|rce\|auth-bypass\|credential-exposure/)
  assert.throws(() => check2([ssrf({ severity: 'critical' })]), /severityFloor lifts the severity only to high; the final score 6\.3 is medium, so severity critical is not allowed/)
  assert.throws(() => check2([ssrf({ severity: 'medium' })]), /severity medium is not allowed/, 'a floor never lowers or leaves the band unexplained')
  assert.throws(() => check2([ssrf({ severity: 'low' })]), /severity low is not allowed/)
  assert.equal(check2([ssrf({ severity: 'critical', cvss: cvss({}, CRITICAL, 9.3) })]).length, 1, 'a critical score stays critical')
  assert.throws(() => check2([ssrf({ severity: 'high', cvss: cvss({}, CRITICAL, 9.3) })]), /severity high is not allowed/)
  for (const bad of [{ class: 'rce' }, { evidence: 'e' }, { ...floor, extra: 1 }, { ...floor, evidence: ' ' }, { ...floor, evidence: 'x'.repeat(1001) }, 'rce']) assert.throws(() => check2([ssrf({ severityFloor: bad })]), /severityFloor/)
  // Without a floor, the same lifted severity is refused: the score alone decides.
  assert.throws(() => check2([ssrf({ severityFloor: undefined })]), /unless a severityFloor applies/)
  // The floor is not part of schema 1.
  assert.throws(() => validateAuditReport(report2([finding({ severityFloor: floor })]), v2.state, { environment: 'http://localhost:3000' }), /unknown field "severityFloor"/)
})

test('the engine calculates the score from the vector, stores it and ignores scoreSource', () => {
  const [stored] = check2([finding2({ cvss: { version: '4.0', vector: BASE } })])
  assert.equal(stored.cvss.computedScore, 8.7, 'score and scoreSource are optional')
  const [withEnv] = check2([finding2({ severity: 'medium', cvss: { version: '4.0', vector: BASE, scoreSource: 'estimated', environmental: { vector: BASE + '/MVC:L' } }, severityRationale: 'T1 limits the exposed data.' })])
  assert.deepEqual([withEnv.cvss.computedScore, withEnv.cvss.environmental.computedScore], [8.7, 6.9])
  // A wrong estimate near the 7.0 boundary is refused with the calculated value instead of deciding the gate.
  assert.throws(() => check2([finding2({ severity: 'medium', cvss: cvss({}, BASE, 6.9) })]), /cvss\.score 6\.9 differs from the score 8\.7/)
  assert.throws(() => check2([finding2({ cvss: { version: '4.0', vector: BASE, score: 8.7, scoreSource: 'online' } })]), /scoreSource must be calculator or estimated/)
})

test('a re-audit must revalidate the blocking findings that were not accepted and only ones that existed', () => {
  const previous = { n: 1, endedAt: 'a', result: 'blocked', report: { findings: [finding({ id: 'F1' }), finding({ id: 'F2', accepted: true }), finding({ id: 'F3', severity: 'medium' }), finding({ id: 'F4', severity: 'critical' })] } }
  const current = { n: 2, environment: 'http://localhost:3000', reportSchema: 2 }
  const state = { tasks: { T1: {} }, securityAudit: { state: 'running', attempts: [previous, current] } }
  const run = revalidates => validateAuditReport(report2([], revalidates === undefined ? {} : { revalidates }), state, current)
  assert.deepEqual(run(['F1', 'F4']), [])
  assert.deepEqual(run(['F4', 'F1', 'F2', 'F3']), [], 'extra ids that existed (accepted or not blocking) are accepted')
  assert.throws(() => run(undefined), /must list the blocking findings of the previous attempt that are not accepted: F1, F4/)
  assert.throws(() => run(['F1']), /not accepted: F4/)
  assert.throws(() => run(['F1', 'F4', 'F9']), /references "F9", which is not a finding of the previous attempt/)
  assert.throws(() => validateAuditReport(report2([], { revalidates: ['F1'] }), { ...state, securityAudit: { attempts: [{ n: 1, endedAt: 'antiga' }, current] } }, current), /references "F1", which is not a finding of the previous attempt/)
  for (const bad of [[], ['F1', 'F1'], 'F1', [''], [1]]) assert.throws(() => run(bad), /nonempty array of unique finding ids/, JSON.stringify(bad))
  // Attempt 1 has nothing to revalidate; a fully accepted previous attempt requires nothing.
  const first = { n: 1, environment: 'http://localhost:3000', reportSchema: 2 }
  assert.throws(() => validateAuditReport(report2([], { revalidates: ['F1'] }), { tasks: {}, securityAudit: { attempts: [first] } }, first), /no previous audit attempt/)
  assert.throws(() => validateAuditReport(report2([], { revalidates: ['F1'] }), { tasks: {} }, first), /no previous audit attempt/)
  const accepted = { ...previous, report: { findings: [finding({ id: 'F1', accepted: true })] } }
  assert.deepEqual(validateAuditReport(report2([]), { tasks: {}, securityAudit: { attempts: [accepted, current] } }, current), [])
  assert.throws(() => validateAuditReport(report2([], { revalidates: ['F2'] }), { tasks: {}, securityAudit: { attempts: [accepted, current] } }, current), /not a finding of the previous attempt/)
  // The persisting finding keeps its id and is validated like any other.
  assert.equal(validateAuditReport(report2([finding2({ id: 'F1' })], { revalidates: ['F1', 'F4'] }), state, current).length, 1)
})

test('the stored report keeps revalidates and the fix plan carries the score, floor and location as advisory data', () => {
  const attempt = { n: 1, environment: 'http://localhost:3000', reportSchema: 2 }
  const floor = { class: 'rce', evidence: 'nonce file written' }
  const findings = [finding2({ location: 'a.mjs:1', wstg: ['WSTG-INPV-12'], severityRationale: 'r', severityFloor: floor })]
  recordAuditReport({ securityAudit: {} }, attempt, { report: { summary: 's', revalidates: ['F1'] }, findings, path: 'p', digest: 'd', at: 'now' })
  assert.deepEqual(attempt.report.revalidates, ['F1'])
  const state = { run: 'r', plan: { name: 'n', phases: [], maxParallel: 1, maxExecutors: 1, requireReview: true }, tasks: { T1: { id: 'T1', state: 'done', title: 't', touches: [], validation: [{ kind: 'functional', run: 'x', expect: 'y' }] } }, securityAudit: { state: 'blocked', attempts: [attempt] } }
  const advisory = securityFixPlan(state).tasks.at(-1).securityFinding
  assert.deepEqual([advisory.cvss.score, advisory.severityFloor, advisory.location, advisory.wstg, advisory.severityRationale], [8.7, floor, 'a.mjs:1', ['WSTG-INPV-12'], 'r'])
  assert.equal(Object.hasOwn(securityFixPlan({ ...state, securityAudit: { state: 'blocked', attempts: [{ ...attempt, report: { findings: [finding()] } }] } }).tasks.at(-1).securityFinding, 'cvss'), false)
})

test('the example report of the methodology passes the schema 2 validation and the old attempt refuses its new fields', async () => {
  const { readFileSync } = await import('node:fs')
  const doc = readFileSync(new URL('../references/security-audit.md', import.meta.url), 'utf8')
  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(doc)[1])
  const previous = { n: 1, endedAt: 'a', report: { findings: [finding({ id: 'F1' })] } }, current = { n: 2, environment: 'http://localhost:3000', reportSchema: 2 }
  const state = { tasks: { T2: {}, T3: {}, T4: {} }, securityAudit: { attempts: [previous, current] } }
  assert.deepEqual(validateAuditReport(example, state, current).map(item => item.id), ['F2', 'F3', 'F4'])
  assert.deepEqual(blockingFindings({ report: { findings: example.findings } }).map(item => item.id), ['F2', 'F3'])
  assert.throws(() => validateAuditReport(example, state, { environment: 'http://localhost:3000' }), /unknown field "revalidates"/)
})
