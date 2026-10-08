import { log, tr } from './i18n.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const insist = (condition, message) => { if (!condition) throw new Error(message) }
const expectedExitCodes = (step) => step.expectedExitCodes ?? [0]
const passed = (step, check) => !!check && expectedExitCodes(step).includes(check.exitCode) && !check.error && !check.signal
const RESOURCE_VALUES = ['database', 'network', 'credential', 'external-service', 'production-data', 'manual-inspection']

function assertResources(value, field) {
  insist(Array.isArray(value) && value.every(resource => RESOURCE_VALUES.includes(resource)),
    `${field} must be an array containing only ${RESOURCE_VALUES.join(', ')}`)
}

export function assertUnavailableResources(task) {
  if (task.unavailable !== undefined) assertResources(task.unavailable, 'unavailable')
}

function safeRelativePath(value) {
  if (!nonempty(value) || value.includes('\0')) return false
  const normalized = value.replace(/\\/g, '/')
  return !isAbsolute(value) && !normalized.startsWith('/') && !/^[/\\]{2}/.test(value) &&
    !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..')
}

function normalizedScopePath(value) {
  const parts = String(value).replace(/\\/g, '/').split('/').filter(part => part && part !== '.')
  const normalized = parts.join('/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function writeIsInsideTouches(write, touches) {
  const candidate = normalizedScopePath(write)
  return touches.some(touch => {
    const prefix = normalizedScopePath(touch)
    return prefix === '' || candidate === prefix || candidate.startsWith(prefix + '/')
  })
}
const failureMessage = (step, check, index, total) =>
  `validation check ${index + 1}/${total} (${step.kind ?? 'static'}) failed: ${check?.error ?? `exit ${check?.exitCode ?? 'not run'}`}; command: ${step.run} — functional failures cannot be replaced by lint`

const DISCOVERY_AREAS = [
  'problem', 'affected', 'outcome', 'currentBehavior', 'desiredBehavior',
  'rules', 'exceptions', 'scope', 'acceptance',
]
const DISCOVERY_FIELDS = ['research', 'questions', 'coverage', 'decisions', 'deferred', 'executionBoundary', 'closure', 'roundId', 'nonce']
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value

export function discoveryDigest(context) {
  const persisted = Object.fromEntries(DISCOVERY_FIELDS.map(field => [field, context[field]]))
  return createHash('sha256').update(JSON.stringify(canonical(persisted))).digest('hex')
}

// A conversa principal fornece esta evidência antes de um planejador ser despachado.
export function assertDiscovery(context) {
  insist(context && typeof context === 'object' && !Array.isArray(context), 'discovery context must be a JSON object')
  insist(Array.isArray(context.research) && context.research.length > 0 &&
    context.research.every(item => item && nonempty(item.source) && nonempty(item.findings)),
  'discovery research needs nonempty source and findings for each entry')
  insist(Array.isArray(context.questions) && context.questions.length > 0 &&
    context.questions.every(item => item && nonempty(item.question) && nonempty(item.answer) &&
      ['native', 'chat-fallback'].includes(item.channel) && Number.isSafeInteger(item.round) && item.round > 0),
  'discovery needs at least one answered question with channel native or chat-fallback and a positive round')
  insist(context.questions.every(item => item.confirmsContract === undefined ||
    (Array.isArray(item.confirmsContract) && item.confirmsContract.every(confirmation =>
      confirmation && nonempty(confirmation.task) && /^[a-f0-9]{64}$/i.test(confirmation.digest)))),
  'discovery question confirmsContract must contain task IDs and current 64-character digests')
  insist(context.coverage && typeof context.coverage === 'object' && !Array.isArray(context.coverage) &&
    DISCOVERY_AREAS.every(area => nonempty(context.coverage[area])),
  'discovery coverage needs problem, affected, outcome, currentBehavior, desiredBehavior, rules, exceptions, scope and acceptance')
  insist(Array.isArray(context.decisions) && context.decisions.every(item =>
    item && nonempty(item.question) && nonempty(item.answer) &&
      (item.resolvesQuestion === undefined || nonempty(item.resolvesQuestion))),
  'discovery decisions must contain resolved question and answer entries')
  insist(Array.isArray(context.deferred) && context.deferred.every(nonempty),
    'discovery deferred must be an array of nonempty strings')
  insist(context.executionBoundary && typeof context.executionBoundary === 'object' &&
    !Array.isArray(context.executionBoundary), 'discovery needs an executionBoundary object')
  insist(Array.isArray(context.executionBoundary.deferredToExecutor) &&
    context.executionBoundary.deferredToExecutor.every(nonempty),
  'discovery executionBoundary.deferredToExecutor must be an array of task IDs')
  insist(Array.isArray(context.executionBoundary.prematureTaskWork) &&
    context.executionBoundary.prematureTaskWork.every(item => item && nonempty(item.task) && nonempty(item.action)),
  'discovery executionBoundary.prematureTaskWork must contain task and action entries')
  insist(nonempty(context.closure), 'discovery closure must explain why no consequential gray area remains')
}

export function assertDiscussionBoundary(context, targetIds, { acceptPremature = false } = {}) {
  const deferred = [...new Set(context.executionBoundary.deferredToExecutor)].sort()
  const targets = [...new Set(targetIds)].sort()
  insist(JSON.stringify(deferred) === JSON.stringify(targets),
    `discovery must defer every discussion target to its executor; planner research cannot deliver the task; expected targets: [${targets.join(', ')}]; received targets: [${deferred.join(', ')}]`)
  const premature = context.executionBoundary.prematureTaskWork
  insist(premature.every(item => targets.includes(item.task)),
    'premature task work must identify a current discussion target')
  insist(!premature.length || acceptPremature,
    'premature task work was reported; stop and obtain explicit user approval, then repeat with --accept-premature-work so the executor still redoes it')
}

// O plano classifica as verificações; somente o revisor pode julgar sua cobertura comportamental.
export function validationContract(task) {
  assertUnavailableResources(task)
  const mode = task.validationMode ?? 'functional'
  insist(['functional', 'inspection'].includes(mode), 'validationMode must be functional or inspection')
  if (mode === 'inspection')
    insist(nonempty(task.inspectionReason), 'inspection requires inspectionReason explaining why runtime behavior is unaffected')
  const steps = Array.isArray(task.validation) ? task.validation : []
  if (mode === 'functional')
    insist(Array.isArray(task.validation) && steps.length > 0,
      'functional validation must be a nonempty array of executable steps; prose is allowed only for justified inspection')
  else insist(steps.length > 0 || nonempty(task.validation), 'inspection validation must not be empty')
  for (const step of steps) {
    insist(step && nonempty(step.run) && nonempty(step.expect), 'each validation step needs nonempty run and expect')
    insist(step.kind === undefined || ['static', 'functional'].includes(step.kind), 'step kind must be static or functional')
    if (step.cacheable !== undefined) insist(typeof step.cacheable === 'boolean', 'cacheable must be true or false')
    if (step.cacheable) insist((step.kind ?? 'static') === 'static', 'only static validation steps can be cacheable')
    if (step.cachePaths !== undefined) {
      insist(step.cacheable === true, 'cachePaths requires cacheable: true')
      insist(Array.isArray(step.cachePaths) && step.cachePaths.length > 0 && step.cachePaths.every(safeRelativePath),
      'cachePaths must be a nonempty array of safe relative paths')
    }
    if (step.expectedExitCodes !== undefined)
      insist(Array.isArray(step.expectedExitCodes) && step.expectedExitCodes.length > 0 &&
        step.expectedExitCodes.every((code) => Number.isInteger(code) && code >= 0 && code <= 255),
      'expectedExitCodes must be a nonempty array of integer process exit codes from 0 to 255')
    if (step.env !== undefined)
      insist(step.env !== null && typeof step.env === 'object' && !Array.isArray(step.env) &&
        Object.entries(step.env).every(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
          typeof value === 'string' && !value.includes('\0')),
      'env must map environment variable names to string values')
    if (step.requiresEnv !== undefined)
      insist(Array.isArray(step.requiresEnv) && step.requiresEnv.every(name =>
        typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)),
      'requiresEnv must be an array of portable nonempty environment variable names')
    if (step.shell !== undefined) insist(nonempty(step.shell), 'shell must be an executable name or path')
    if (step.timeoutMs !== undefined)
      insist(Number.isSafeInteger(step.timeoutMs) && step.timeoutMs >= 0 && step.timeoutMs <= 2147483647,
        'timeoutMs must be an integer from 0 to 2147483647; 0 explicitly disables the deadline')
    if (process.platform === 'win32' && !step.shell && /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(step.run))
      throw new Error('Unix environment assignment does not run in cmd.exe; move NAME=value into step.env or declare step.shell explicitly')
  }
  if (mode === 'functional')
    insist(steps.some((step) => step.kind === 'functional'),
      'functional task requires an executable functional check; lint, build, typecheck or prose alone cannot approve it')
  return { mode, steps, key: JSON.stringify([mode, task.inspectionReason ?? '', task.validation]) }
}

// Exija os pré-requisitos de todas as etapas antes de executar qualquer comando, sem expor seus valores.
export function assertValidationEnvironment(task, environment = process.env, platform = process.platform) {
  const { steps } = validationContract(task)
  const missing = new Set()
  const environments = steps.map(step => {
    const env = Object.assign(Object.create(null), environment)
    for (const [name, value] of Object.entries(step.env ?? {})) {
      if (platform === 'win32')
        for (const key of Object.keys(env)) if (key.toLowerCase() === name.toLowerCase()) delete env[key]
      env[name] = value
    }
    for (const name of step.requiresEnv ?? []) {
      const key = platform === 'win32' ? Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) : name
      if (key === undefined || !nonempty(env[key])) missing.add(name)
    }
    return env
  })
  insist(!missing.size, tr('validation requires environment variables: {0}; configure them in the process environment or step.env before start or validate --ok',
    [...missing].join(', ')))
  return environments
}

// A evidência é fornecida pelo planejador; este portão verifica completude, não a veracidade da pesquisa.
export function assertTaskPlan(task, plan, { checkSelfDeadline = true } = {}) {
  insist(plan && typeof plan === 'object' && !Array.isArray(plan), 'task plan must be a JSON object')
  if (plan.summary !== undefined)
    insist(nonempty(plan.summary), 'task plan summary must be a nonempty string when present')
  insist(Array.isArray(plan.research) && plan.research.length > 0 &&
    plan.research.every(item => item && nonempty(item.source) && nonempty(item.findings)),
  'task plan research needs nonempty source and findings for each entry')
  insist(Array.isArray(plan.decisions) && plan.decisions.every(item => item && nonempty(item.question) && nonempty(item.answer)),
    'task plan decisions must contain resolved question and answer entries; use [] when none are needed')
  insist(Array.isArray(plan.steps) && plan.steps.length > 0 && plan.steps.every(nonempty),
    'task plan needs nonempty execution steps')
  const contract = validationContract(task)
  const checks = contract.steps.length ? contract.steps.map((_, index) => index + 1) : ['inspection']
  insist(Array.isArray(plan.verification) && plan.verification.length > 0 &&
    plan.verification.every(item => item && nonempty(item.criterion) && checks.includes(item.check)) &&
    checks.every(check => plan.verification.some(item => item.check === check)),
  'task plan verification must map observable criteria to every validation check (1-based index, or "inspection")')
  for (const item of plan.verification) {
    if (item.requires !== undefined)
      assertResources(item.requires, 'verification requires')
  }
  if (plan.writes !== undefined) {
    insist(Array.isArray(plan.writes) && plan.writes.every(safeRelativePath),
      'task plan writes must be an array of safe relative paths without absolute paths, .. or NUL')
    insist(task.writeScope !== 'read-only' || !plan.writes.length, 'read-only task plan cannot declare writes')
    if (task.touches?.length) {
      for (const write of plan.writes)
        insist(writeIsInsideTouches(write, task.touches),
          `task plan writes path "${write}" is outside task touches; correct the approved task contract, run sync-plan, and replan before execution`)
    }
  }
  const validQuestionDeadline = value => value === undefined || value === 'executor' || value === 'user-now' ||
    value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 &&
      ((nonempty(value.beforeTask) && value.beforePhase === undefined) ||
        (nonempty(value.beforePhase) && value.beforeTask === undefined))
  insist(Array.isArray(plan.openQuestions) && plan.openQuestions.every(item => item &&
    nonempty(item.question) && typeof item.blocking === 'boolean' &&
    (item.answer === undefined || nonempty(item.answer)) && validQuestionDeadline(item.decideBy)),
  'task plan openQuestions must contain question, blocking boolean, optional nonempty answer, and a valid optional decideBy')
  for (const [index, question] of plan.openQuestions.entries()) {
    // A pergunta sobre a própria tarefa precisa estar respondida quando seu plano for entregue.
    if (checkSelfDeadline && !question.answer && question.decideBy?.beforeTask && question.decideBy.beforeTask === task.id)
      throw new Error(tr('task {0} plan open question {1} targets its own task with beforeTask; answer it before adding the plan: {2}', task.id, index + 1, question.question.replace(/\s+/g, ' ').slice(0, 120)))
  }
  insist(plan.openQuestions.every(item => !item.blocking || nonempty(item.answer)),
    'task plan has unanswered blocking questions; resolve them with the user before execution')
  insist(Array.isArray(plan.decisions) && plan.decisions.every(item => item.resolvesQuestion === undefined || nonempty(item.resolvesQuestion)),
    'task plan decisions resolvesQuestion must reference a question ID when present')
}

export function planTaskFromState(t) {
  return {
    id: t.id,
    phase: t.phase,
    title: t.title,
    deps: t.deps,
    validation: t.validation,
    validationMode: t.validationMode,
    inspectionReason: t.inspectionReason,
    requireReview: t.requireReview,
    maxAttempts: t.maxAttempts,
    tags: t.tags,
    touches: t.touches,
    ...(t.project === undefined ? {} : { project: t.project }),
    ...(t.writeScope === undefined ? {} : { writeScope: t.writeScope }),
    ...(t.sharedResources === undefined ? {} : { sharedResources: t.sharedResources }),
    ...Object.fromEntries(['textRules', 'deliveries', 'numericProvenance'].filter(key => t[key] !== undefined).map(key => [key, t[key]])),
    unavailable: t.unavailable,
  }
}

const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

const TASK_PLAN_CONTENT_FIELDS = [
  'research', 'decisions', 'steps', 'verification', 'openQuestions', 'writes',
  'phaseBinding', 'unresolvedInputs',
]

// Calcule o hash do conteúdo executável de planejamento. Resumos de apresentação e metadados de registro não
// alteram a identidade do plano nem sua autorização.
export function taskPlanDigest(plan) {
  const value = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : {}
  const content = Object.fromEntries(TASK_PLAN_CONTENT_FIELDS
    .filter(field => Object.hasOwn(value, field))
    .map(field => [field, value[field]]))
  return digest(content)
}

// O planejamento de fase é intencionalmente apenas contratual: o progresso da entrega pode satisfazer uma entrada,
// mas nunca deve reescrever um plano já aprovado.
export function phasePlanningContext(state, task) {
  const dependencies = new Set()
  const visit = id => {
    if (dependencies.has(id)) return
    dependencies.add(id)
    for (const dep of state.tasks[id]?.deps ?? []) visit(dep)
  }
  task.deps.forEach(visit)
  const contract = t => [planTaskFromState(t), t.contractRevision ?? 0, t.scopeRevision ?? 0]
  return digest([
    state.plan.name, state.plan.description, state.plan.requireReview, state.plan.planningRevision ?? 0,
    contract(task), [...dependencies].sort().map(id => [id, state.tasks[id] ? contract(state.tasks[id]) : null]),
  ])
}

export function phaseRequiredInputs(state, task) {
  return task.deps.filter(id => !['done', 'skipped'].includes(state.tasks[id]?.state)).sort().map(id => ({
    task: id,
    phase: state.tasks[id]?.phase ?? null,
    requiredEvidence: `current terminal receipt for ${id}`,
  }))
}

export function assertPhaseTaskPlan(state, task, plan, binding, expected = phaseRequiredInputs(state, task)) {
  assertTaskPlan(task, plan)
  insist(plan.phaseBinding?.phaseId === binding.phaseId &&
    plan.phaseBinding?.discussionRoundId === binding.discussionRoundId &&
    plan.phaseBinding?.plannerRound === binding.plannerRound,
  'phase task plan binding must match phase, discussion round and planner round')
  insist(Array.isArray(plan.unresolvedInputs) && plan.unresolvedInputs.every(input =>
    input && nonempty(input.task) && Object.hasOwn(input, 'phase') && nonempty(input.requiredEvidence)),
  'phase task plan unresolvedInputs must contain task, phase and requiredEvidence')
  const key = input => JSON.stringify([input.task, input.phase])
  const difference = (left, right) => {
    const counts = new Map()
    for (const input of right) counts.set(key(input), (counts.get(key(input)) ?? 0) + 1)
    const unmatched = []
    for (const input of left) {
      const inputKey = key(input), count = counts.get(inputKey) ?? 0
      if (count) counts.set(inputKey, count - 1)
      else unmatched.push({ task: input.task, phase: input.phase })
    }
    return unmatched.sort((a, b) => a.task.localeCompare(b.task) || key(a).localeCompare(key(b)))
  }
  const missing = difference(expected, plan.unresolvedInputs)
  const unexpected = difference(plan.unresolvedInputs, expected)
  if (missing.length || unexpected.length) {
    insist(false, `phase task plan ${task.id} unresolvedInputs differ from the inputs captured when its planning round opened: missing ${JSON.stringify(missing)}; unexpected ${JSON.stringify(unexpected)}; expected JSON at round opening: ${JSON.stringify(expected)}`)
  }
}

export function executionInputReceipt(state, task) {
  const inputs = task.deps.slice().sort().map(id => {
    const dep = state.tasks[id]
    insist(dep && ['done', 'skipped'].includes(dep.state), `${task.id} still waiting on: ${id}`)
    if (dep.state === 'skipped') {
      insist(nonempty(dep.skipReason), `${id} skip waiver needs a reason`)
      return { task: id, phase: dep.phase ?? null, result: 'waived', reason: dep.skipReason }
    }
    const validation = dep.validations?.at(-1)
    insist(validation?.ok && validation.attempt === dep.attempts?.length,
      `${id} has no current passing validation receipt`)
    return { task: id, phase: dep.phase ?? null, result: 'validated', attempt: dep.attempts.length,
      validation: digest([validation.token, validation.at, validation.agent, validation.evidence,
        validation.planningScope, dep.contractRevision ?? 0, dep.stateRevision ?? 0]) }
  })
  return { inputs, digest: digest(inputs) }
}

// Compartilhado pelo engine e pelo dashboard somente leitura: a prontidão deve usar exatamente a mesma evidência.
export function planningContext(state, task, {
  scopeOnly = false, attempt = task.attempts.length + (task.planningReturn ? 0 : 1),
} = {}) {
  const dependencies = new Set()
  const visit = id => {
    if (dependencies.has(id)) return
    dependencies.add(id)
    for (const dep of state.tasks[id]?.deps ?? []) visit(dep)
  }
  task.deps.forEach(visit)
  const contract = t => [planTaskFromState(t), t.contractRevision ?? 0, t.planningRevision ?? 0]
  const { validation, validationMode, inspectionReason, ...scope } = planTaskFromState(task)
  return createHash('sha256').update(JSON.stringify([
    state.plan.name, state.plan.description, state.plan.requireReview, state.plan.planningRevision ?? 0,
    scopeOnly ? [scope, task.scopeRevision ?? 0] : contract(task), attempt,
    [...dependencies].sort().map(id => {
      const dep = state.tasks[id]
      return dep ? [id, contract(dep), dep.state, dep.attempts, dep.validations, dep.skipReason] : [id, null]
    }),
  ])).digest('hex')
}

// Indica se esta tarefa pertence ao fluxo de planejamento atual. Durante uma
// migração estrutural, tarefas sem o marcador ainda são interpretadas a partir de
// seu histórico persistido: uma tentativa antiga permanece legada, enquanto o trabalho não iniciado
// aguarda a migração atribuir explicitamente o fluxo atual.
export function usesCurrentPlanning(state, task) {
  if (task.planningRequired === true) return true
  if (task.planningRequired === false) return false
  return !['phase', 'task'].includes(state.plan?.planningMode) && !(task.attempts?.length)
}

// Uma decisão explícita do usuário pode dispensar o artefato de planejamento de fase/tarefa sem
// transformar a tarefa em um ciclo de vida legado. A decisão permanece atual somente
// enquanto o contrato aprovado e os contratos das dependências não mudarem.
export function currentPlanningSkip(state, task) {
  const decision = task.planningSkips?.at(-1)
  if (decision?.decision !== 'skipped' || decision.confirmedByUser !== true) return null
  return decision.scope === phasePlanningContext(state, task) ? decision : null
}

export function hasCurrentTaskPlan(state, task) {
  if (state.legacyPhaseAdoption && !state.phaseWorkflows?.[task.phase]?.adoptedLegacy) return false
  // Tarefas legadas mantêm o ciclo de vida que já usavam. O modo de
  // planejamento pode ter sido introduzido por uma migração estrutural, mas
  // não deve fabricar retroativamente um plano de tarefa para uma tentativa ativa.
  if (!usesCurrentPlanning(state, task)) return true
  if (currentPlanningSkip(state, task)) return true
  // Prazos históricos continuam sendo cobrados pelo motor, sem invalidar o contrato já registrado.
  try { assertTaskPlan(task, task.taskPlan, { checkSelfDeadline: false }) } catch { return false }
  if (task.taskPlan?.phaseId) {
    const phase = state.phaseWorkflows?.[task.taskPlan.phaseId]
    if (task.taskPlan.phaseDecision === 'skipped') {
      const decision = phase?.discussionSkips?.find(item =>
        item.decisionId === task.taskPlan.phaseBinding?.discussionRoundId)
      return !task.phasePlanDefect && decision?.confirmedByUser === true && decision.digest === task.taskPlan.phaseDecisionDigest &&
        task.taskPlan.scope === phasePlanningContext(state, task)
    }
    const discussion = phase?.discussionAttempts?.find(round =>
      round.roundId === task.taskPlan.phaseBinding?.discussionRoundId)
    const discovery = discussion?.discovery ??
      (phase?.discovery?.roundId === discussion?.roundId ? phase.discovery : null)
    const latestTargets = phase?.discussionAttempts?.find(round => round.roundId === phase.discovery?.roundId)?.targets ?? []
    return !task.phasePlanDefect && (!latestTargets.includes(task.id) || phase.discovery.roundId === discussion?.roundId) &&
      discovery?.digest === task.taskPlan.phaseDiscoveryDigest &&
      discovery.digest === discoveryDigest(discovery) &&
      task.taskPlan.scope === phasePlanningContext(state, task)
  }
  const skippedDiscussion = task.taskPlan?.discussionDecision === 'skipped' ? task.discussionSkips?.find(decision =>
    decision.decisionId === task.taskPlan.discussionDecisionId && decision.confirmedByUser === true &&
    decision.digest === task.taskPlan.discussionDecisionDigest && decision.scope === phasePlanningContext(state, task)) : null
  const discoveryCurrent = !task.discoveryRequired || Boolean(skippedDiscussion) || (nonempty(task.discovery?.digest) &&
    task.discovery.digest === discoveryDigest(task.discovery) &&
    task.taskPlan.discoveryDigest === task.discovery.digest &&
    task.discovery.context === task.taskPlan.context && task.discovery.attempt === task.taskPlan.attempt)
  return discoveryCurrent && hasCurrentTaskScope(state, task, task.attempts.length + 1)
}

// Atualizações somente de validação não invalidam a pesquisa por trás de uma tentativa de execução ativa.
export function hasCurrentTaskScope(state, task, attempt = task.attempts.length) {
  if (state.legacyPhaseAdoption && !state.phaseWorkflows?.[task.phase]?.adoptedLegacy) return false
  // Consulte hasCurrentTaskPlan: a compatibilidade por tarefa tem precedência sobre o
  // modo de planejamento da execução enquanto o trabalho legado é concluído.
  if (!usesCurrentPlanning(state, task)) return true
  if (currentPlanningSkip(state, task)) return true
  const plan = task.taskPlan
  try { assertTaskPlan(task, plan, { checkSelfDeadline: false }) } catch { return false }
  if (!(nonempty(plan?.planner) && nonempty(plan.completedAt))) return false
  if (plan.phaseId) {
    const phase = state.phaseWorkflows?.[plan.phaseId]
    if (plan.phaseDecision === 'skipped') {
      const decision = phase?.discussionSkips?.find(item =>
        item.decisionId === plan.phaseBinding?.discussionRoundId)
      return !task.phasePlanDefect && decision?.confirmedByUser === true && decision.digest === plan.phaseDecisionDigest &&
        plan.scope === phasePlanningContext(state, task)
    }
    const discussion = phase?.discussionAttempts?.find(round => round.roundId === plan.phaseBinding?.discussionRoundId)
    const discovery = discussion?.discovery ??
      (phase?.discovery?.roundId === discussion?.roundId ? phase.discovery : null)
    const latestTargets = phase?.discussionAttempts?.find(round => round.roundId === phase.discovery?.roundId)?.targets ?? []
    return !task.phasePlanDefect && (!latestTargets.includes(task.id) || phase.discovery.roundId === discussion?.roundId) &&
      discovery?.digest === plan.phaseDiscoveryDigest &&
      discovery.digest === discoveryDigest(discovery) && plan.scope === phasePlanningContext(state, task)
  }
  const skippedDiscussion = plan?.discussionDecision === 'skipped' ? task.discussionSkips?.find(decision =>
    decision.decisionId === plan.discussionDecisionId && decision.confirmedByUser === true &&
    decision.digest === plan.discussionDecisionDigest && decision.scope === phasePlanningContext(state, task)) : null
  const discoveryCurrent = !task.discoveryRequired || Boolean(skippedDiscussion) || (nonempty(task.discovery?.digest) &&
    task.discovery.digest === discoveryDigest(task.discovery) && plan.discoveryDigest === task.discovery.digest &&
    task.discovery.context === plan.context && task.discovery.attempt === plan.attempt)
  if (!discoveryCurrent) return false
  if (plan.attempt === attempt)
    return plan.scope === planningContext(state, task, { scopeOnly: true, attempt }) &&
      (task.state !== 'failed' || plan.context === planningContext(state, task, { attempt }))
  const retry = task.retryPlan
  const failed = task.attempts[attempt - 2]
  return retry?.attempt === attempt && retry.planSourceAttempt === plan.attempt &&
    retry.failedAttempt === attempt - 1 && failed?.n === retry.failedAttempt && failed.result === 'failed' &&
    failed.reason === retry.reason && nonempty(retry.reason) && retry.context === planningContext(state, task, { attempt }) &&
    retry.discoveryDigest === task.discovery?.digest && retry.planContext === plan.context && retry.planScope === plan.scope &&
    plan.scope === planningContext(state, task, { scopeOnly: true, attempt: plan.attempt }) &&
    retry.scope === planningContext(state, task, { scopeOnly: true, attempt })
}

// Antes da primeira execução, o planejamento pertence à tentativa 1, ainda sem registro de execução.
export function currentPlanningScope(state, task, attempt = task.attempts.length || 1) {
  if (!usesCurrentPlanning(state, task) || !hasCurrentTaskScope(state, task, attempt)) return undefined
  const skipped = currentPlanningSkip(state, task)
  if (skipped) return skipped.scope
  return task.taskPlan.attempt === attempt ? task.taskPlan.scope : task.retryPlan.scope
}

function execute(run, options, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(run, { ...options, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    const stdout = [], stderr = []
    let size = 0, error = null, timer
    const stop = (reason) => {
      if (error) return
      error = reason
      if (!child.pid) return
      // Pare a árvore de processos pertencente antes que o shell desapareça, para que as verificações não sobrevivam a um tempo limite.
      if (process.platform === 'win32') {
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 10000 })
        if (killed.error || killed.status !== 0) {
          error += '; process-tree termination failed: ' + (killed.error?.message ?? killed.stderr.trim())
          child.kill('SIGKILL')
        }
      } else {
        try { process.kill(-child.pid, 'SIGKILL') }
        catch (e) { if (e.code !== 'ESRCH') error += '; process-group termination failed: ' + e.message }
      }
    }
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]])
      stream.on('data', (data) => {
        size += data.length
        if (size > 4 * 1024 * 1024) stop('ENOBUFS: validation output exceeds 4 MiB')
        else chunks.push(data)
      })
    child.on('error', (e) => { error ??= e.message })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, error: error ? new Error(error) : null,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    if (timeoutMs > 0) timer = setTimeout(() => stop('ETIMEDOUT: validation deadline exceeded'), timeoutMs)
  })
}

function workspaceRevision(directory, paths) {
  const options = { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 }
  const git = (...args) => spawnSync('git', ['-C', directory, ...args], options)
  const root = git('rev-parse', '--show-toplevel')
  if (paths) {
    const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths)
    if (root.status !== 0 || root.error || files.status !== 0 || files.error) return null
    const hash = createHash('sha256').update(root.stdout.trim()).update('\0').update(JSON.stringify(paths))
    for (const file of files.stdout.split('\0').filter(Boolean).sort()) {
      hash.update('\0').update(file).update('\0')
      if (!existsSync(resolve(directory, file))) hash.update('missing')
      else {
        const blob = git('hash-object', '--', file)
        if (blob.status !== 0 || blob.error) return null
        hash.update(blob.stdout.trim())
      }
    }
    return hash.digest('hex')
  }
  const head = git('rev-parse', 'HEAD')
  const diff = git('diff', '--binary', '--no-ext-diff', 'HEAD', '--')
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z')
  if ([root, head, diff, untracked].some(result => result.status !== 0 || result.error)) return null
  const hash = createHash('sha256').update(root.stdout.trim()).update('\0').update(head.stdout.trim()).update('\0').update(diff.stdout)
  for (const file of untracked.stdout.split('\0').filter(Boolean)) {
    const blob = git('hash-object', '--', file)
    if (blob.status !== 0 || blob.error) return null
    hash.update('\0').update(file).update('\0').update(blob.stdout.trim())
  }
  return hash.digest('hex')
}

export function validationDirectories(task, cwd) {
  return validationContract(task).steps.map((step) => {
    const directory = step.cwd ?? cwd ?? task.project
    if (typeof directory === 'string' && /^[A-Za-z]:(?![\\\\/])/.test(directory))
      throw new Error('validation cwd looks like a Windows path whose backslashes were consumed by the shell; use a quoted absolute path with forward slashes, for example "C:/work/project"')
    insist(nonempty(directory) && isAbsolute(directory), 'executable validation needs an absolute --cwd or step.cwd')
    insist(statSync(directory).isDirectory(), `validation cwd is not a directory: ${directory}`)
    return directory
  })
}

export async function runValidation(task, cwd, previousReceipt = null, onCheck = () => {}) {
  const contract = validationContract(task)
  const environments = assertValidationEnvironment(task)
  const checks = []
  const directories = validationDirectories(task, cwd)
  for (const [index, step] of contract.steps.entries()) {
    const revision = step.cacheable && !step.requiresEnv?.length ? workspaceRevision(directories[index], step.cachePaths) : null
    const prior = previousReceipt?.checks?.[index]
    const current = task.validations?.at(-1)
    const sameAttempt = previousReceipt?.attempt === task.attempts?.length && previousReceipt?.agent === current?.agent
    const correctiveRetry = step.cachePaths && task.attempts?.at(-1)?.correctionOf === previousReceipt?.attempt &&
      previousReceipt?.by === 'review' && current?.by === 'review'
    if (revision && previousReceipt?.contract === contract.key &&
        (previousReceipt.contractRevision ?? 0) === (task.contractRevision ?? 0) &&
        (previousReceipt.scopeRevision ?? 0) === (task.scopeRevision ?? 0) &&
        (previousReceipt.stateRevision ?? 0) === (task.stateRevision ?? 0) &&
        previousReceipt.by === current?.by && (sameAttempt || correctiveRetry) &&
        prior?.workspaceRevision === revision && passed(step, prior)) {
      checks.push({ ...prior, reusedAt: new Date().toISOString() })
      onCheck({ current: index + 1, total: contract.steps.length, kind: step.kind ?? 'static', status: 'reused' })
      log(`[prumo] reused check ${index + 1}/${contract.steps.length} (static, unchanged ${step.cachePaths ? 'declared paths' : 'workspace'})`)
      continue
    }
    const timeoutMs = step.timeoutMs ?? 600000
    const shell = step.shell ?? (process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh')
    const env = environments[index]
    log(`[prumo] running check ${index + 1}/${contract.steps.length}; timeout ${timeoutMs === 0 ? 'disabled by plan' : timeoutMs + 'ms'}; expected exit ${expectedExitCodes(step).join(',')}`)
    onCheck({ current: index + 1, total: contract.steps.length, kind: step.kind ?? 'static', status: 'started' })
    const result = await execute(step.run, {
      cwd: directories[index], shell, env,
      windowsHide: true,
    }, timeoutMs)
    const check = {
      run: step.run, expect: step.expect, kind: step.kind ?? 'static', cwd: directories[index],
      shell, timeoutMs, expectedExitCodes: expectedExitCodes(step),
      exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
      stdout: result.stdout, stderr: result.stderr, at: new Date().toISOString(),
      workspaceRevision: revision,
    }
    checks.push(check)
    onCheck({ current: index + 1, total: contract.steps.length, kind: check.kind, status: passed(step, check) ? 'passed' : 'failed' })
    log(`[prumo] check ${index + 1}/${contract.steps.length} (${check.kind}): exit ${check.exitCode}${check.error ? ` — ${check.error}` : ''}`)
    if (!passed(step, check)) break
  }
  return { contract: contract.key, contractRevision: task.contractRevision ?? 0,
    scopeRevision: task.scopeRevision ?? 0,
    stateRevision: task.stateRevision ?? 0, checks }
}

export function assertValidation(task, receipt) {
  insist(nonempty(receipt?.evidence), 'validation evidence must not be empty')
  const contract = validationContract(task)
  insist(receipt.contract === contract.key, 'validation lacks an execution receipt for this contract — validate again')
  insist((receipt.contractRevision ?? 0) === (task.contractRevision ?? 0),
    'contract was refreshed after validation — validate the current contract again')
  insist((receipt.scopeRevision ?? 0) === (task.scopeRevision ?? 0),
    'execution scope changed after validation — validate the current scope again')
  insist(Array.isArray(receipt.checks), 'validation receipt has no checks')
  if (receipt.checks.length !== contract.steps.length) {
    const index = receipt.checks.length - 1
    if (index >= 0 && index < contract.steps.length && !passed(contract.steps[index], receipt.checks[index]))
      throw new Error(failureMessage(contract.steps[index], receipt.checks[index], index, contract.steps.length))
    throw new Error('not all validation commands completed')
  }
  for (const [index, step] of contract.steps.entries()) {
    const check = receipt.checks[index]
    insist(check && check.run === step.run && check.kind === (step.kind ?? 'static') &&
      check.expect === step.expect && passed(step, check),
    failureMessage(step, check, index, contract.steps.length))
  }
}
