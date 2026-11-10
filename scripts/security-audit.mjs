import { planTaskFromState } from './validation.mjs'
import { scopeConflicts, isSafeTouch } from './task-scope.mjs'
import { parseCvss4, scoreCvss4, Cvss4Error, CVSS4_BASE_METRICS } from './cvss4.mjs'
import { businessContract } from './contract-drift.mjs'
import { isDeepStrictEqual } from 'node:util'

/** A refusal carries its message template and values so the engine can translate it without parsing text. */
export class AuditError extends Error {
  constructor(template, ...params) {
    super(template.replace(/\{(\d+)\}/g, (all, index) => params[index] ?? all))
    this.template = template
    this.params = params
  }
}

/** The message of a refusal in the caller's language; any other error keeps its own text. */
export const refusalText = (error, translate) => error instanceof AuditError || error instanceof Cvss4Error ? translate(error.template, ...error.params) : error.message

export const AUDIT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
/** Critical and high findings block the run until they are accepted or revalidated. */
export const BLOCKING_SEVERITIES = ['critical', 'high']
const GATE_STATES = ['blocked', 'awaiting-decision', 'enabled']
const AUDIT_TEXT_FIELDS = ['title', 'attackPath', 'evidence', 'reproduction', 'remediation']
const START_COMMAND = 'audit-start --agent <auditor> --environment <local URL> --confirmed-by-user'

/** The run-level audit only starts when every task is terminal and at least one was completed. */
export function graphClosed(state) {
  const tasks = Object.values(state.tasks ?? {})
  const done = tasks.filter(task => task.state === 'done').length
  return done > 0 && done + tasks.filter(task => task.state === 'skipped').length === tasks.length
}
/** The single rule for an audit in progress: running and its latest attempt not finished. */
export function openAuditAttempt(state) {
  const attempt = state.securityAudit?.attempts?.at(-1)
  return state.securityAudit?.state === 'running' && attempt && !attempt.endedAt ? attempt : null
}
/** Accepts a local origin, with or without a path, so an audit cannot be aimed at a remote host; the path is dropped. */
export function isLocalAuditEnvironment(value) {
  if (typeof value !== 'string' || !value.trim() || /[?#]/.test(value)) return null
  let url
  try { url = new URL(value.includes('://') ? value : 'http://' + value) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(host) || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:localhost|test)$/.test(host)
  return local ? url.origin : null
}

export const REPORT_SCHEMA = 2
/** Classes whose proven impact keeps the gate at high or above even when the CVSS score is lower. */
export const SEVERITY_FLOOR_CLASSES = ['ssrf-internal', 'rce', 'auth-bypass', 'credential-exposure']
const CVSS_REQUIRED_SEVERITIES = ['critical', 'high', 'medium']
/** The official CVSS v4.0 qualitative bands; the severity of a finding must match the score the engine calculates from its vector. */
export const cvssBand = score => score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'info'
const isScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/** Parses a CVSS v4.0 vector for the report; its refusals keep the template and values so they can be translated. */
function parseCvssVector(vector, at, environmental) {
  let metrics
  try { metrics = parseCvss4(vector, at) } catch (error) { throw new AuditError(error.template, ...error.params) }
  // A prova já existe: maturidade de exploração não reduz o risco; ajustes ambientais precisam da evidência do card.
  if (metrics.E !== undefined && metrics.E !== 'X') throw new AuditError('{0}: metric E is not allowed in audit reports; use CVSS-B or card-backed CVSS-BE', at)
  if (!environmental && Object.keys(metrics).some(name => (['CR', 'IR', 'AR'].includes(name) || name.startsWith('M')) && metrics[name] !== 'X'))
    throw new AuditError('{0}: put environmental metrics in cvss.environmental with card evidence in severityRationale', at)
  return metrics
}
const hasExactKeys = (value, required, optional = []) => isPlainObject(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const uniqueStrings = list => Array.isArray(list) && list.length > 0 && new Set(list).size === list.length && list.every(item => typeof item === 'string' && item.trim())
const cites = (text, refs, aliases) => refs.some(ref => [ref, aliases[ref]].some(id => typeof id === 'string' && new RegExp(`(?<![A-Za-z0-9])${id.replace(/[^A-Za-z0-9]/g, '\\$&')}(?![A-Za-z0-9])`).test(text)))

/** Report schema 2 rules for one finding; they only run for attempts started with reportSchema 2. */
function validateFindingV2(finding, at, ids, aliases) {
  const bad = (template, ...params) => { throw new AuditError(template, at, ...params) }
  if (!/^F\d+$/.test(finding.id)) bad('{0}.id "{1}" must look like F<number> (for example F1)', finding.id)
  if (finding.location !== undefined && (typeof finding.location !== 'string' || !finding.location.trim() || finding.location.length > 300)) bad('{0}.location must be a nonempty string of at most 300 characters')
  if (finding.wstg !== undefined && (!uniqueStrings(finding.wstg) || finding.wstg.some(id => !/^WSTG-[A-Z]{4}-\d{2}$/.test(id)))) bad('{0}.wstg must be a nonempty array of unique ids like WSTG-ATHZ-04')
  if (finding.severityRationale !== undefined && (typeof finding.severityRationale !== 'string' || !finding.severityRationale.trim() || finding.severityRationale.length > 1000)) bad('{0}.severityRationale must be a nonempty string of at most 1000 characters')
  if (finding.chainedWith !== undefined) {
    if (!uniqueStrings(finding.chainedWith)) bad('{0}.chainedWith must be a nonempty array of unique ids of other findings of this report')
    for (const id of finding.chainedWith) if (id === finding.id || !ids.has(id)) bad('{0}.chainedWith references "{1}", which is not another finding of this report', id)
    if (!finding.cvss) bad('{0}.chainedWith requires cvss')
  }
  const { cvss, severity, severityFloor: floor } = finding
  if (cvss === undefined) {
    if (CVSS_REQUIRED_SEVERITIES.includes(severity)) bad('{0}.cvss is required for {1} findings', severity)
    if (floor !== undefined) bad('{0}.severityFloor requires cvss')
    return
  }
  if (!hasExactKeys(cvss, ['version', 'vector'], ['score', 'scoreSource', 'computedScore', 'environmental'])) bad('{0}.cvss must have version and vector, and may have score, scoreSource and environmental')
  if (cvss.version !== '4.0') bad('{0}.cvss.version must be "4.0"')
  if (cvss.score !== undefined && !isScore(cvss.score)) bad('{0}.cvss.score must be a number from 0.0 to 10.0 with at most one decimal')
  if (cvss.scoreSource !== undefined && !['calculator', 'estimated'].includes(cvss.scoreSource)) bad('{0}.cvss.scoreSource must be calculator or estimated')
  // The engine, not the auditor, is the source of the score: severity and the floor rules below use the calculated value.
  const base = parseCvssVector(cvss.vector, `${at}.cvss.vector`, false)
  const baseScore = scoreCvss4(cvss.vector).score
  if (cvss.score !== undefined && cvss.score !== baseScore) bad('{0}.cvss.score {1} differs from the score {2} the engine calculates from cvss.vector; remove score or use the calculated one (audit-cvss <vector> prints it)', cvss.score, baseScore)
  cvss.computedScore = baseScore
  let final = baseScore
  const env = cvss.environmental
  if (env !== undefined) {
    if (!hasExactKeys(env, ['vector'], ['score', 'computedScore'])) bad('{0}.cvss.environmental must have vector and may have score')
    if (env.score !== undefined && !isScore(env.score)) bad('{0}.cvss.environmental.score must be a number from 0.0 to 10.0 with at most one decimal')
    const metrics = parseCvssVector(env.vector, `${at}.cvss.environmental.vector`, true)
    if (CVSS4_BASE_METRICS.some(([name]) => metrics[name] !== base[name])) bad('{0}.cvss.environmental.vector must keep the base metrics of cvss.vector')
    const envScore = scoreCvss4(env.vector).score
    if (env.score !== undefined && env.score !== envScore) bad('{0}.cvss.environmental.score {1} differs from the score {2} the engine calculates from cvss.environmental.vector; remove score or use the calculated one (audit-cvss <vector> prints it)', env.score, envScore)
    env.computedScore = envScore
    if (finding.severityRationale === undefined) bad('{0}.severityRationale is required when cvss.environmental is present')
    if (!cites(finding.severityRationale, finding.taskRefs, aliases)) bad('{0}.severityRationale must cite at least one of the finding taskRefs ({1}) as the card evidence of the environmental metrics', finding.taskRefs.join(', '))
    final = envScore
  }
  const band = cvssBand(final)
  if (floor === undefined) {
    if (severity !== band) bad('{0}.severity is {1} but the final CVSS score {2} is {3}; the severity must match the score unless a severityFloor applies', severity, final, band)
    return
  }
  if (!hasExactKeys(floor, ['class', 'evidence'])) bad('{0}.severityFloor must have exactly class and evidence')
  if (!SEVERITY_FLOOR_CLASSES.includes(floor.class)) bad('{0}.severityFloor.class must be one of {1}', SEVERITY_FLOOR_CLASSES.join('|'))
  if (typeof floor.evidence !== 'string' || !floor.evidence.trim() || floor.evidence.length > 1000) bad('{0}.severityFloor.evidence must be a nonempty string of at most 1000 characters')
  // The floor only lifts to high: critical needs a critical score, reached by the score itself or by a documented chain.
  if (severity !== (AUDIT_SEVERITIES.indexOf(band) > AUDIT_SEVERITIES.indexOf('high') ? 'high' : band)) bad('{0}.severityFloor lifts the severity only to high; the final score {1} is {2}, so severity {3} is not allowed', final, band, severity)
}

/** A re-audit must retest every blocking finding of the previous attempt that was not accepted, and may only name findings that existed. */
function validateRevalidates(report, state, attempt) {
  const bad = (template, ...params) => { throw new AuditError(template, ...params) }
  const previous = (state.securityAudit?.attempts ?? []).findLast(item => item !== attempt && item.endedAt)
  const required = previous ? blockingFindings(previous).map(finding => finding.id) : []
  const revalidates = report.revalidates
  if (revalidates !== undefined) {
    if (!uniqueStrings(revalidates)) bad('report.revalidates must be a nonempty array of unique finding ids')
    if (!previous) bad('report.revalidates is refused: there is no previous audit attempt')
    const known = new Set((previous.report?.findings ?? []).map(finding => finding.id))
    for (const id of revalidates) if (!known.has(id)) bad('report.revalidates references "{0}", which is not a finding of the previous attempt', id)
  }
  const missing = required.filter(id => !(revalidates ?? []).includes(id))
  if (missing.length) bad('report.revalidates must list the blocking findings of the previous attempt that are not accepted: {0}', missing.join(', '))
}

/** Validates the auditor report strictly; every refusal names the finding index and field. */
export function validateAuditReport(report, state, attempt) {
  const fail = message => { throw new Error(message) }
  const v2 = attempt.reportSchema === REPORT_SCHEMA
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('report must be a JSON object')
  for (const key of Object.keys(report)) if (!['summary', 'environment', 'findings', 'tools', ...(v2 ? ['revalidates'] : [])].includes(key)) fail(`report has unknown field "${key}"`)
  if (typeof report.summary !== 'string' || !report.summary.trim()) fail('report.summary must be a nonempty string')
  if (isLocalAuditEnvironment(report.environment) !== attempt.environment) fail(`report.environment must match the audited environment ${attempt.environment}`)
  if (report.tools !== undefined && (!Array.isArray(report.tools) || report.tools.some(tool => typeof tool !== 'string' || !tool.trim()))) fail('report.tools must be an array of nonempty strings')
  if (!Array.isArray(report.findings)) fail('report.findings must be an array')
  const aliases = state.taskIdAliases ?? {}, seen = new Set()
  const allowed = ['id', 'severity', 'title', 'cwe', 'taskRefs', 'attackPath', 'evidence', 'reproduction', 'remediation', ...(v2 ? ['location', 'wstg', 'cvss', 'severityRationale', 'severityFloor', 'chainedWith'] : [])]
  report.findings.forEach((finding, index) => {
    const at = `finding[${index}]`
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) fail(`${at} must be an object`)
    for (const key of Object.keys(finding)) if (!allowed.includes(key)) fail(`${at} has unknown field "${key}"`)
    if (typeof finding.id !== 'string' || !finding.id.trim()) fail(`${at}.id must be a nonempty string`)
    // Task renumbering rewrites every T<number> token, so such an id would be silently changed.
    if (/^T\d/i.test(finding.id)) fail(`${at}.id "${finding.id}" looks like a task identifier (T<number>) and would be rewritten by task renumbering; use another id such as F1`)
    if (seen.has(finding.id)) fail(`${at}.id "${finding.id}" is duplicated`)
    seen.add(finding.id)
    if (!AUDIT_SEVERITIES.includes(finding.severity)) fail(`${at}.severity must be one of ${AUDIT_SEVERITIES.join('|')}`)
    if (typeof finding.cwe !== 'string' || !/^CWE-\d{1,5}$/.test(finding.cwe)) fail(`${at}.cwe must look like CWE-89`)
    if (!Array.isArray(finding.taskRefs)) fail(`${at}.taskRefs must be an array`)
    for (const ref of finding.taskRefs) if (typeof ref !== 'string' || !Object.hasOwn(state.tasks ?? {}, Object.hasOwn(aliases, ref) ? aliases[ref] : ref)) fail(`${at}.taskRefs references unknown task "${ref}"`)
    for (const field of AUDIT_TEXT_FIELDS) if (typeof finding[field] !== 'string' || !finding[field].trim()) fail(`${at}.${field} must be a nonempty string`)
  })
  if (v2) {
    report.findings.forEach((finding, index) => validateFindingV2(finding, `finding[${index}]`, seen, aliases))
    validateRevalidates(report, state, attempt)
  }
  return report.findings
}
export function auditCounts(findings = []) {
  const counts = Object.fromEntries(AUDIT_SEVERITIES.map(severity => [severity, 0]))
  for (const finding of findings) counts[finding.severity]++
  return counts
}
const isBlocking = finding => BLOCKING_SEVERITIES.includes(finding.severity)
/** Single source of truth for what blocks the run; critical/high stay blocking until explicitly accepted. */
export function blockingFindings(attempt) {
  return (attempt?.report?.findings ?? []).filter(finding => isBlocking(finding) && !finding.accepted)
}
/** Machine-readable link between a fix task and the audit finding it corrects; it is a task tag, so it survives sync-plan and renumbering. */
export const findingTag = (attempt, id) => `security-finding:${attempt}:${id}`
export const SECURITY_FINDING_TAG = /^security-finding:\d+:/
export function findingFixTask(state, attempt, id) {
  const tag = findingTag(attempt, id)
  return Object.values(state.tasks ?? {}).find(task => task.tags?.includes(tag))?.id ?? null
}
/** Blocking findings are accepted, linked to a fix task (delivered or skipped) or still open; other severities carry no resolution. */
function findingResolution(state, attempt, finding) {
  if (!isBlocking(finding)) return {}
  const fixTask = findingFixTask(state, attempt?.n, finding.id)
  const resolution = finding.accepted ? 'accepted' : !fixTask ? 'open' : state.tasks[fixTask].state === 'skipped' ? 'fix-skipped' : 'fix-task'
  return { resolution, fixTask }
}
export function securityAuditView(state) {
  const audit = state.securityAudit
  if (!audit) return null
  const closed = graphClosed(state), attempts = audit.attempts ?? []
  const last = attempts.at(-1), finished = attempts.findLast(item => item.endedAt)
  const effective = audit.state === 'blocked' && !closed ? 'pending-recheck' : audit.state
  const findings = (last?.report?.findings ?? []).map(finding => ({ ...finding, ...findingResolution(state, last, finding) }))
  // A new attempt starts without findings; the previous blocking ones are what it must revalidate.
  const previousBlocking = (finished?.report?.findings ?? []).filter(isBlocking).map(finding => {
    const { resolution, fixTask } = findingResolution(state, finished, finding)
    return { ...finding, attempt: finished.n, status: resolution, fixTask }
  })
  return {
    state: effective, stored: audit.state, graphClosed: closed,
    // The run stays complete for the dashboard; the gate says the demand must not be declared closed yet.
    gate: audit.advisory !== true && (['running', 'pending-recheck'].includes(effective) || closed && GATE_STATES.includes(effective)),
    ...(audit.advisory === true ? { advisory: true } : {}),
    attempts: attempts.map(item => ({ n: item.n, agent: item.agent, environment: item.environment, startedAt: item.startedAt, endedAt: item.endedAt ?? null, result: item.result ?? null, digest: item.report?.digest ?? null, counts: auditCounts(item.report?.findings) })),
    counts: auditCounts(findings), blocking: blockingFindings(last).map(finding => finding.id), findings, previousBlocking,
  }
}
export function securityBrief(state, command) {
  // Executor and orchestrator progress notes stay out, as in the review: the auditor judges the delivery, not the narrative.
  const tasks = Object.values(state.tasks ?? {}).map(task => {
    const review = task.validations?.findLast(receipt => receipt.by === 'review' && receipt.ok)
    return {
      id: task.id, title: task.title, phase: task.phase ?? null, state: task.state, project: task.project ?? state.plan.cwd ?? null,
      contract: Object.fromEntries(['title', 'deps', 'touches', 'writeScope', 'sharedResources', 'unavailable', 'validation', 'validationMode', 'inspectionReason', 'textRules', 'deliveries', 'numericProvenance'].filter(key => task[key] !== undefined).map(key => [key, task[key]])),
      taskPlan: task.taskPlan ?? null, deliveries: task.deliveries ?? [], skipReason: task.skipReason ?? null,
      review: review ? { agent: review.agent ?? null, at: review.at, summary: review.summary, evidence: review.evidence, deliveryFingerprint: review.deliveryCheck?.fingerprint ?? null, scopeFingerprint: review.scopeCheck?.fingerprint ?? null } : null,
    }
  })
  const audit = securityAuditView(state)
  const previousBlocking = audit?.previousBlocking ?? []
  return {
    role: 'security', run: state.run, runPause: state.runPause ?? null,
    context: { name: state.plan.name, description: state.plan.description, phases: state.plan.phases ?? [], scopePolicy: state.plan.scopePolicy ?? null, cwd: state.plan.cwd ?? null },
    tasks, audit, previousBlocking,
    ...(state.securityAudit?.contract ? { auditContract: state.securityAudit.contract } : {}),
    ...(previousBlocking.length ? { revalidation: 'Revalidate every unaccepted entry of previousBlocking against the current delivery before anything else: rerun its reproduction. Accepted entries are history only: do not retest them or report them again. Report again, with fresh evidence, each unaccepted finding that still reproduces; omit those that no longer reproduce and say so in the summary. List the ids of the unaccepted previous blocking findings you retested in the top-level revalidates of the report (the report is refused if any is missing). Then audit the delivery for new findings.' } : {}),
    rulesOfEngagement: ['Attack only the approved scope and the validated local environment.', 'Nothing destructive against real data; no data leaves this machine; no real credentials.', 'No load or denial-of-service testing; do not install tools on your own.', 'Clean up proof-of-concept artifacts; stop and report if real personal data appears.'],
    reference: 'references/security-audit.md',
    modelPreference: state.plan.rolePreferences?.security ?? null,
    commands: [command(['activity-start', 'security-audit', '--scope', 'run', '--role', 'security', '--agent', '<auditor>']), command(['audit-finish', '--report', '<report.json>'])],
  }
}

/**
 * Names that executed, reviewed or planned anything in the run, including removed tasks and phase workers.
 * The auditor must differ from all of them, ignoring case and surrounding spaces.
 */
export function auditAgentsInUse(state, dispatchOwners) {
  const names = new Set()
  const add = value => { if (typeof value === 'string' && value.trim()) names.add(value.trim().toLowerCase()) }
  const removed = Object.fromEntries(Object.entries(state.removedTasks ?? {}).map(([id, entry]) => [id, entry?.task ?? {}]))
  for (const source of [state, { tasks: removed }])
    for (const item of dispatchOwners(source)) if (item.role !== 'security') { add(item.agent); add(item.owner.activityAgent) }
  const rounds = target => [...(target.discussionAttempts ?? []), ...(target.planningAttempts ?? [])]
  const addRound = round => {
    add(round.agent); add(round.activityAgent)
    for (const worker of Object.values(round.workers ?? {})) { add(worker.agent); add(worker.activityAgent) }
    for (const planner of Object.values(round.assignments ?? {})) add(planner)
  }
  for (const task of [...Object.values(state.tasks ?? {}), ...Object.values(removed)]) {
    add(task.agent); add(task.reviewer); add(task.planner)
    for (const attempt of task.attempts ?? []) { add(attempt.agent); add(attempt.reviewer); for (const past of attempt.reviewHistory ?? []) add(past.reviewer) }
    rounds(task).forEach(addRound)
  }
  for (const phase of Object.values(state.phaseWorkflows ?? {})) { add(phase.planner); rounds(phase).forEach(addRound) }
  return names
}

/** Records that the finished graph needs a security-audit decision; legacy runs without the block are never asked retroactively. */
export function markAuditDecisionIfClosed(state, at = new Date().toISOString()) {
  if (!graphClosed(state)) return
  const audit = state.securityAudit
  if (!audit) state.securityAudit = { state: 'awaiting-decision', advisory: true, announcedAt: at }
  // Work added after a passed audit was never audited, so the user is asked again without blocking.
  else if (audit.state === 'done' && audit.attempts?.at(-1) && Object.keys(state.tasks).some(id => !audit.attempts.at(-1).taskIds?.includes(id)))
    state.securityAudit = { ...audit, state: 'awaiting-decision', announcedAt: at }
}

export function enableAudit(state, at) {
  const audit = state.securityAudit
  if (audit?.state === 'running') throw new AuditError('security audit is running; audit-finish it first')
  if (audit?.state === 'blocked') throw new AuditError('security audit is blocked by findings; use audit-accept or fix the work and audit-start again')
  if (audit?.state === 'done' && graphClosed(state)) throw new AuditError('security audit is already done')
  return { ...(audit ?? {}), state: 'enabled', enabledAt: at, confirmedByUser: true }
}
export function skipAudit(state, reason, at) {
  const audit = state.securityAudit
  if (audit?.state === 'running') throw new AuditError('security audit is running; audit-finish it first')
  if (audit?.advisory && audit.attempts?.at(-1)?.endedAt)
    return { ...audit, state: 'done', correctionDecision: { choice: 'no-corrections', attempt: audit.attempts.at(-1).n, reason, at, confirmedByUser: true } }
  if (audit?.state === 'blocked') throw new AuditError('security audit is blocked by findings; it cannot be skipped. Use audit-accept or fix the work and audit-start again')
  if (audit?.state === 'done') throw new AuditError('security audit is already done')
  return { ...(audit ?? {}), state: 'skipped', skip: { reason, at, confirmedByUser: true } }
}
/** Validates every precondition of audit-start and returns the next block; nothing is recorded by a refusal. */
export function startAudit(state, { agent, environment, contract, at, dispatchOwners, used, cap }) {
  const audit = state.securityAudit
  if (!graphClosed(state)) {
    const tasks = Object.values(state.tasks ?? {})
    if (audit?.state === 'blocked') throw new AuditError('security audit is blocked and tasks were reopened; finish the work before auditing again')
    if (tasks.every(task => ['done', 'skipped'].includes(task.state))) throw new AuditError('there is no delivered task to audit: every task was skipped')
    throw new AuditError('the security audit starts only when every task is done or skipped')
  }
  if (audit?.state === 'running') throw new AuditError('security audit is already running')
  if (audit?.state === 'done') throw new AuditError('security audit is already done')
  if (auditAgentsInUse(state, dispatchOwners).has(agent.trim().toLowerCase())) throw new AuditError('{0} already executed, reviewed or planned a task; the auditor must be independent', agent)
  if (used >= cap) throw new AuditError('no agent slot available for the auditor ({0}/{1} in use)', used, cap)
  const origin = isLocalAuditEnvironment(environment) ?? (() => { throw new AuditError('the audit environment must be a local host (localhost, 127.0.0.1, [::1], *.localhost or *.test)') })()
  const acceptedContract = contract ?? audit?.contract
  if (acceptedContract) validateAuditContract(state, acceptedContract, origin)
  const attempt = { n: (audit?.attempts?.length ?? 0) + 1, agent, environment: origin, startedAt: at, confirmedByUser: true, taskIds: Object.keys(state.tasks), reportSchema: REPORT_SCHEMA,
    ...(acceptedContract ? { contract: structuredClone(acceptedContract) } : {}) }
  return { audit: { ...(audit ?? {}), ...(acceptedContract ? { contract: structuredClone(acceptedContract), advisory: true } : {}), state: 'running', attempts: [...(audit?.attempts ?? []), attempt] }, attempt }
}
/** Stores the validated report on the running attempt and derives the audit result from the blocking findings. */
export function recordAuditReport(state, attempt, { report, findings, path, digest, at }) {
  attempt.report = { path, digest, summary: report.summary, environment: attempt.environment, findings, ...(report.tools ? { tools: report.tools } : {}), ...(report.revalidates ? { revalidates: report.revalidates } : {}) }
  attempt.endedAt = at
  attempt.result = blockingFindings(attempt).length ? 'blocked' : 'done'
  state.securityAudit.state = attempt.result
  return auditCounts(findings)
}
export function acceptFinding(state, id, reason, at) {
  const audit = state.securityAudit
  if (audit?.state !== 'blocked') throw new AuditError('no blocking security findings to accept')
  const attempt = audit.attempts.at(-1), finding = attempt.report.findings.find(item => item.id === id)
  if (!finding) throw new AuditError('unknown finding "{0}"', id)
  if (!isBlocking(finding)) throw new AuditError('{0} is not a blocking finding', id)
  if (finding.accepted) throw new AuditError('{0} was already accepted', id)
  finding.accepted = true
  ;(attempt.acceptances ??= []).push({ finding: id, reason, at, confirmedByUser: true })
  if (!blockingFindings(attempt).length) audit.state = 'done'
  return audit.state
}
/** Guard for run-level activity: only the running auditor may open and close intervals on the audit. */
export function auditActivityTarget(state, id, role, agent) {
  if (id !== 'security-audit' || role !== 'security' || typeof agent !== 'string' || !agent.trim()) throw new AuditError('run activity needs the id security-audit, the security role and a nonempty agent')
  const attempt = openAuditAttempt(state)
  if (!attempt) throw new AuditError('{0} has no running security audit', id)
  if (attempt.agent !== agent) throw new AuditError('{0} {1} activity belongs to {2}', id, role, attempt.agent)
  return attempt
}

/** What `status`, `done`, `skip` and the audit commands tell the orchestrator, as [template, ...values] pairs. */
export function auditNotices(state) {
  const view = securityAuditView(state)
  if (!view) return []
  if (view.advisory && view.state === 'awaiting-decision') return [['Delivery is DONE. Offer an optional independent audit: explain its importance, prepare audit-propose --environment <local URL>, show the complete business contract and ask the user before audit-start --contract <file.json> --agent <auditor> --environment <local URL> --confirmed-by-user.']]
  if (view.advisory && !openAuditAttempt(state) && state.securityAudit.attempts?.at(-1)?.endedAt) {
    if (state.securityAudit.correctionDecision?.attempt === state.securityAudit.attempts.at(-1).n || !view.findings.some(item => !item.accepted)) return []
    return [['Delivery remains DONE. The audit report is finished. Present its findings and ask in the main chat whether to create correction tasks in this graph. Only after acceptance apply audit-fix-plan with sync-plan --propose --complete-audit {0} --confirmed-by-user. Declining corrections does not accept risks implicitly.', state.securityAudit.attempts.at(-1).n]]
  }
  if (view.state === 'running') return [['security audit running (auditor {0}); finish it with audit-finish --report <report.json>', state.securityAudit.attempts.at(-1).agent]]
  if (view.state === 'pending-recheck') return [['security audit: tasks were reopened after blocking findings; finish the work, then run {0} again to revalidate', START_COMMAND]]
  if (!view.graphClosed) return []
  if (view.state === 'awaiting-decision') return [['SECURITY AUDIT DECISION PENDING: all tasks are finished. Ask the user: Run / Skip / Not now. Run: {0} (the auditor must not have executed, reviewed or planned any task). Skip: audit-skip --reason <text> --confirmed-by-user. Not now: do nothing.', START_COMMAND]]
  if (view.state === 'enabled') return [['security audit is pre-authorized: dispatch an independent auditor with {0}', START_COMMAND]]
  if (view.state !== 'blocked') return []
  const open = view.findings.filter(finding => finding.resolution === 'open'), skipped = view.findings.filter(finding => finding.resolution === 'fix-skipped')
  const notices = [['SECURITY AUDIT BLOCKED by critical/high findings: {0}', view.blocking.join(', ')]]
  if (open.length) notices.push(['Present each finding ({0}) and ask the user per finding: Fix (it enters the proposed fix phase) or Accept the risk (audit-accept <finding> --reason <text> --confirmed-by-user)', open.map(finding => finding.id).join(', ')],
    ['Then run audit-fix-plan --out <file.json> for the remaining findings, show the proposed phase to the user and apply it with sync-plan --plan <file.json> --propose; the tasks run only after the user accepts their contracts'])
  if (skipped.length) notices.push(['The fix tasks of {0} were skipped, so no fix was delivered; run {1} for a new independent attempt that checks whether the finding persists, or accept the risk with audit-accept <finding> --reason <text> --confirmed-by-user', skipped.map(finding => finding.id).join(', '), START_COMMAND])
  if (!open.length && !skipped.length) notices.push(['All blocking findings are accepted or have finished fix tasks; run {0} for a new independent attempt that revalidates the fixes', START_COMMAND])
  return notices
}
/** The run stays complete, but the demand is only closed to the user once the audit is done or skipped. */
export function auditGateNotice(state) {
  const view = securityAuditView(state)
  return view?.gate ? ['SECURITY AUDIT GATE OPEN ({0}): do not declare the demand closed to the user until the audit is done or skipped', view.state] : null
}

/**
 * Builds a complete plan for sync-plan: the persisted plan plus one new phase with one fix task per blocking, unaccepted finding
 * of the last finished audit. The proposal is inert until the user accepts it through the existing contract acceptance.
 * Generated titles and summaries are English: they become contract text that must not change with the language of a later command.
 */
export function securityFixPlan(state, testCommand) {
  const audit = state.securityAudit, attempt = audit?.attempts?.findLast(item => item.endedAt)
  const advisory = audit?.advisory === true && ['blocked', 'done'].includes(audit.state) && audit.correctionDecision?.attempt !== attempt?.n
  if (!attempt || !advisory && audit.state !== 'blocked') throw new AuditError('there is no blocked security audit with a finished attempt')
  const blocking = advisory ? attempt.report.findings.filter(item => !item.accepted) : blockingFindings(attempt)
  if (!blocking.length) throw new AuditError('the last security audit has no blocking finding left to fix')
  const pending = blocking.filter(finding => !findingFixTask(state, attempt.n, finding.id))
  if (!pending.length) throw new AuditError('fix tasks for security audit {0} already exist: {1}', attempt.n, blocking.map(finding => `${finding.id}=${findingFixTask(state, attempt.n, finding.id)}`).join(', '))
  const run = testCommand ?? Object.values(state.tasks).findLast(task => task.state === 'done' && Array.isArray(task.validation) && task.validation.some(step => step.kind === 'functional'))?.validation.findLast(step => step.kind === 'functional').run
  if (!run) throw new AuditError('no functional validation command can be derived from the plan; pass --test-command <command>')
  const numbers = pattern => id => Number(pattern.exec(id)?.[1] ?? 0)
  const ids = [...Object.keys(state.tasks), ...Object.keys(state.removedTasks ?? {}), ...Object.keys(advisory ? {} : state.taskIdAliases ?? {})]
  let next = Math.max(0, ...ids.map(numbers(/^T(\d+)/i))) + 1
  const phaseId = 'F' + (Math.max(0, ...(state.plan.phases ?? []).map(phase => phase.id).map(numbers(/^F(\d+)$/))) + 1)
  const aliases = state.taskIdAliases ?? {}
  const fixes = []
  for (const finding of pending) {
    while (Object.hasOwn(aliases, 'T' + next)) next++
    const refs = finding.taskRefs.map(ref => state.tasks[Object.hasOwn(aliases, ref) ? aliases[ref] : ref]).filter(Boolean)
    const project = refs.find(task => task.touches?.some(isSafeTouch))?.project
    const touches = [...new Set(refs.filter(task => task.project === project).flatMap(task => task.touches ?? []).filter(isSafeTouch))]
    const fix = {
      id: 'T' + next++, phase: phaseId, title: `Fix ${finding.title} (${finding.cwe})`, deps: [],
      summary: `Correct "${finding.title}" (${finding.cwe}, ${finding.severity}) so the attack path no longer works: ${finding.attackPath}`,
      validationSummary: `The reproduction no longer works, a regression test reproducing the attack path fails before the fix and passes after it, and the existing tests stay green. Remediation advice: ${finding.remediation}`,
      validation: [{ kind: 'functional', run, expect: `All tests pass, including a regression test that reproduces the attack path of finding ${finding.id} (${finding.cwe}) and fails without the fix` }],
      tags: [findingTag(attempt.n, finding.id), 'security-fix'], touches, writeScope: touches.length ? 'files' : 'unknown',
      ...(project === undefined ? {} : { project }),
      // Advisory copy for the user's review; sync-plan does not persist it. The link that counts is the tag above.
      securityFinding: { audit: attempt.n, id: finding.id, severity: finding.severity, cwe: finding.cwe, evidence: finding.evidence, reproduction: finding.reproduction, remediation: finding.remediation, ...Object.fromEntries(['cvss', 'severityRationale', 'severityFloor', 'wstg', 'location'].filter(key => finding[key] !== undefined).map(key => [key, finding[key]])) },
    }
    // Findings that touch the same files cannot run in parallel; the later one waits for the earlier one.
    fix.deps = fixes.filter(other => scopeConflicts(other, fix, state.plan.cwd).paths.length).map(other => other.id)
    fixes.push(fix)
  }
  const existing = Object.values(state.tasks).map(task => ({ ...planTaskFromState(task), ...Object.fromEntries(['label', 'summary', 'validationSummary', 'timeCondition', 'manualEstimate'].filter(key => task[key] !== undefined).map(key => [key, task[key]])) }))
  return {
    name: state.plan.name, description: state.plan.description ?? '',
    phases: [...(state.plan.phases ?? []), { id: phaseId, title: advisory ? 'Security corrections' : `Security fixes (audit #${attempt.n})` }],
    maxParallel: state.plan.maxParallel, maxExecutors: state.plan.maxExecutors, requireReview: state.plan.requireReview,
    ...(state.plan.scopePolicy === undefined ? {} : { scopePolicy: state.plan.scopePolicy }),
    ...(state.plan.rolePreferences === undefined ? {} : { rolePreferences: state.plan.rolePreferences }),
    tasks: [...existing, ...fixes],
  }
}

function auditScope(state) {
  return JSON.parse(JSON.stringify({ plan: businessContract(state.plan, {}).plan,
    tasks: Object.values(state.tasks).map(task => ({ state: task.state, ...businessContract(state.plan, task).task })) }))
}

export function proposeAuditContract(state, environment) {
  if (!graphClosed(state)) throw new AuditError('Finish every delivery task before proposing the audit')
  const origin = isLocalAuditEnvironment(environment)
  if (!origin) throw new AuditError('The audit contract needs a local environment')
  return { schema: 1, run: state.run, environment: origin,
    businessContext: state.plan.description || state.plan.name,
    source: auditScope(state), policy: { localOnly: true, overloadTests: false, sourceChanges: false },
    scenarios: Object.values(state.tasks).map(task => ({ tasks: [task.id], businessBehavior: task.title,
      verification: task.validationSummary || task.summary || task.title })) }
}

function validateAuditContract(state, contract, environment) {
  if (contract.schema !== 1 || contract.run !== state.run || contract.environment !== environment ||
      typeof contract.businessContext !== 'string' || !contract.businessContext.trim() ||
      !isDeepStrictEqual(contract.policy, { localOnly: true, overloadTests: false, sourceChanges: false }))
    throw new AuditError('Invalid audit contract: preserve its run, local environment and safety policy')
  const bind = scope => ({ plan: scope?.plan, tasks: Array.isArray(scope?.tasks) ? scope.tasks.map(task => {
    const idFor = id => state.taskIdAliases?.[id] ?? id
    const { phase, ...business } = task
    return { ...business, id: idFor(task.id), deps: (task.deps ?? []).map(idFor).sort() }
  }).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })) : null })
  if (!isDeepStrictEqual(bind(contract.source), bind(auditScope(state))))
    throw new AuditError('The delivered business scope changed; prepare and approve a current audit contract')
  const sourceIds = new Set(contract.source.tasks.map(task => task.id)), covered = new Set()
  if (!Array.isArray(contract.scenarios) || !contract.scenarios.length)
    throw new AuditError('The audit contract needs business scenarios covering every delivery task')
  for (const scenario of contract.scenarios) {
    if (!Array.isArray(scenario?.tasks) || !scenario.tasks.length || scenario.tasks.some(id => !sourceIds.has(id)) ||
        [scenario.businessBehavior, scenario.verification].some(value => typeof value !== 'string' || !value.trim()))
      throw new AuditError('Invalid business scenario in the audit contract')
    scenario.tasks.forEach(id => covered.add(id))
  }
  if (covered.size !== sourceIds.size) throw new AuditError('The audit contract scenarios omit delivery tasks')
}

export function completeAuditCorrections(state, before, added, { attempt, confirmedByUser, at = new Date().toISOString() }) {
  const audit = before.securityAudit, report = audit?.attempts?.at(-1)
  if (!audit?.advisory || !report?.endedAt || String(report.n) !== attempt || audit.correctionDecision?.attempt === report.n)
    throw new AuditError('Finish the audit report before creating its correction tasks')
  if (confirmedByUser !== true || !added.length)
    throw new AuditError('Creating corrections requires explicit user confirmation and new tasks')
  const findings = report.report.findings.filter(item => !item.accepted)
  if (added.some(id => !findings.some(item => state.tasks[id].tags?.includes(findingTag(report.n, item.id)))))
    throw new AuditError('Every correction task must reference a finding from the finished audit')
  state.securityAudit.state = 'done'
  state.securityAudit.correctionDecision = { choice: 'corrections-created', attempt: report.n, tasks: [...added], confirmedByUser: true, at }
}
