#!/usr/bin/env node
/**
 * Prumo — estado genérico de execução de grafos de tarefas para planos conduzidos por agentes.
 *
 * O ENGINE é reutilizável e não conhece nenhum projeto específico. O que muda entre projetos
 * é o PLAN (um arquivo JSON: fases + tarefas + deps + como validar).
 * O orquestrador (uma pessoa ou um agente) o conduz por esta CLI; o dashboard
 * (serve.mjs) apenas LÊ o mesmo estado — é observabilidade, nunca um segundo cérebro.
 *
 * O estado fica em ~/.local/share/prumo/<workspace>/.specs/graph/<run>/:
 *   state.json     — a única fonte de verdade (instantâneo do plano + estado por tarefa)
 *   events.ndjson  — histórico somente de acréscimo de cada transição (alimenta o log do dashboard)
 *
 * Ciclo de vida da tarefa (imposto):
 *   pending ─begin-discussion→ discussing ─finish-discussion→ pending (pronto para planejar)
 *   pending ─plan-task→ planning ─finish-planning→ pending (pronto) ─start→ running
 *   running ─review→ reviewing ─validate(ok)→ ─done→ done
 *      │                │                  │└─validate(failed)→ permanece reviewing
 *      │                │└─fail→ failed ─retry→ pending
 *      │                └─(done a partir de running é recusado quando a revisão é obrigatória)
 *      ├─block→ blocked ─unblock→ pending
 *      └─skip→ skipped (com motivo)
 *
 * AUTOR ≠ VERIFICADOR: o executor escreve, um agente REVIEWER bate o martelo. `done` exige uma
 * validação aprovada registrada durante a revisão, por um agente diferente daquele que fez o trabalho.
 *
 * A prontidão é DERIVED: deps satisfeitas → ready_to_plan; plano atual da tarefa → ready.
 * Tarefas sem planningRequired (ou marcadas explicitamente como false durante a migração)
 * mantêm seu ciclo de vida original.
 *
 * Uso (ENGINE = caminho para este arquivo, onde quer que a skill esteja instalada):
 *   node $ENGINE init --plan <plan.json> --run <name>
 *   node $ENGINE sync-plan --plan <plan.json> [--run <name>] [--cwd <project>] [--dry-run] [--confirm-invalidation]
 *   node $ENGINE migrate [--check] [--run <name>]
 *   node $ENGINE status [--verify-install]|ready|graph [--run <name>]
 *   node $ENGINE show-contract <task> [--diff] [--run <name>]
 *   node $ENGINE begin-phase-discussion <phase> [--adopt-legacy]
 *   node $ENGINE skip-phase-discussion <phase> --reason <text> --confirmed-by-user
 *   node $ENGINE finish-phase-discussion <phase> --context <discovery.json> [--accept-premature-work]
 *   node $ENGINE plan-phase <phase> --agent <name> [--plan-dir <directory>]
 *   node $ENGINE skip-phase-planning <phase> --reason <text> --confirmed-by-user
 *   node $ENGINE finish-phase-planning <phase> --plan-dir <directory>
 *   node $ENGINE begin-discussion <task> [--adopt-legacy]
 *   node $ENGINE skip-discussion <task> --reason <text> --confirmed-by-user
 *   node $ENGINE finish-discussion <task> --context <discovery.json> [--accept-premature-work]
 *   node $ENGINE plan-task <task> --agent <name> [--context <legacy-discovery.json>]
 *   node $ENGINE skip-planning <task> --reason <text> --confirmed-by-user
 *   node $ENGINE finish-planning <task> --plan <task-plan.json>
 *   node $ENGINE start <task> --agent <name> [--confirmed-by-user]   (manual mode; max 3 executors)
 *   node $ENGINE progress <task> --step <1-based index> --agent <executor>
 *   node $ENGINE review <task> --agent <name> [--confirmed-by-user]  (manual mode; hands it to a reviewer)
 *   node $ENGINE review-progress <task> --step <1-based index> --agent <reviewer>
 *   node $ENGINE validate <task> --ok|--failed --evidence "<text>" [--cwd <project>] [--tail <lines>]
 *   node $ENGINE show-check <task> --check <1-based index> --attempt <number>
 *   node $ENGINE refresh-contract <task> --plan <approved-plan.json>
 *   node $ENGINE done <task>
 *   node $ENGINE fail <task> --reason "<text>" [--plan-defect]
 *   node $ENGINE retry <task> [--force] [--confirmed-by-user]   (manual mode)
 *   node $ENGINE authorize --scope run|phase:<phase>|tasks:<task,...> [--mode auto|manual] --confirmed-by-user
 *   node $ENGINE block <task> --reason [--question <text>] [--option <text>...]
 *   node $ENGINE unblock <task> [--answer <text>] [--reviewer <agent>] [--confirmed-by-user]   (manual active resume)
 *   node $ENGINE skip <task> --reason
 *   node $ENGINE note <task> --text "<text>"
 *   node $ENGINE runs
 */
import {
  mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync,
  rmSync, statSync, copyFileSync, realpathSync,
} from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isReadyForReview } from './review-readiness.mjs'
import { assertExplicitScope, scopeConflicts, sameProject, captureScopeBaseline, scopeEvidenceRequirement, verifyTaskScope } from './task-scope.mjs'
import { executionReadiness, planQuestionRef, openQuestionRecords, questionResolutionMap, targetHasStarted, overdueQuestions, questionIsOverdue, taskAuthorization, runHasAuthorizationScope, occupancy, isExternalBlock } from './execution-readiness.mjs'
import { writeAtomicState } from './atomic-state.mjs'
import { hydrateDiscoveries, compactDiscoveries } from './discovery-history.mjs'
import { runValidation, assertValidation, assertValidationEnvironment, validationContract, validationDirectories, assertDiscovery, assertDiscussionBoundary, discoveryDigest, assertTaskPlan,
  assertUnavailableResources,
  planTaskFromState, planningContext, hasCurrentTaskPlan, hasCurrentTaskScope, currentPlanningScope, usesCurrentPlanning,
  phasePlanningContext, phaseRequiredInputs, assertPhaseTaskPlan, executionInputReceipt, currentPlanningSkip,
  taskPlanDigest } from './validation.mjs'

import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findRoot, inside, storageHome } from './storage.mjs'
import { log, errorLog, tr } from './i18n.mjs'
import {
  auditSyncPlan, contractChanges, displayIdentifier, formatContractChange,
  sanitizeChanges, sanitizeDiagnostics, sanitizeTaskIds,
} from './sync-plan-audit.mjs'
import { businessContract, contractDrift, GLOBAL_PLAN_FIELDS, TASK_CONTRACT_FIELDS } from './contract-drift.mjs'
import { parseEngineArgs } from './engine-args.mjs'
import { taskIdentifierProblem, phaseIdentifierProblem } from './task-identifiers.mjs'
import { captureDelivery, checkDelivery, verifyNumericProvenance, assertEvidenceContract } from './delivery-evidence.mjs'
import { assertRolePreferences, recordDispatchMetadata, dispatchOwners, reportedUsageTotals, pauseRun, resumeRun, shellCommand, taskBrief, agentRoles, repeatedPlanQuestions, recordedPlanIdentity } from './run-metadata.mjs'
import { newCommandRecord, recordCommand } from './command-metrics.mjs'

let ROOT
try { ROOT = findRoot() } catch (error) { errorLog('[prumo] ERROR: ' + error.message); process.exit(1) }
const GRAPH_DIR = join(ROOT, '.specs', 'graph')
const CURRENT_FILE = join(GRAPH_DIR, 'CURRENT')
const MAX_ATTEMPTS_SOFT = 3
const DEFAULT_MAX_PARALLEL = 4
const DEFAULT_MAX_EXECUTORS = 3   // Metadado legado; maxAgents governa todos os papéis.
const STATE_SCHEMA_VERSION = 1
const LOCK_WAIT_MS = 5000         // quanto tempo um comando aguarda pelo bloqueio da execução
const LOCK_STALE_MS = 30000       // um bloqueio mais antigo que isso pertencia a um processo que morreu

// ---------- analisador minúsculo de argumentos ----------
const [, , cmd, ...rest] = process.argv
let args
let metricRunName
let currentRunAtStart
try { if (existsSync(CURRENT_FILE)) currentRunAtStart = readFileSync(CURRENT_FILE, 'utf8').trim() } catch { /* sem execução selecionada */ }
let recognizedCommand = false
try { parseEngineArgs(cmd, []); recognizedCommand = true } catch { /* comando desconhecido */ }
if (recognizedCommand) {
  const metric = newCommandRecord(cmd)
  process.on('exit', code => {
    try {
      if (cmd === 'sync-plan' && args?.['dry-run']) return
      const runFlag = rest.lastIndexOf('--run')
      if (runFlag >= 0 && rest[runFlag + 1] === undefined) return
      const requestedRun = args?.run ?? process.env.PRUMO_RUN ?? (runFlag >= 0 ? rest[runFlag + 1] : undefined)
      const name = requestedRun ?? (cmd === 'init' ? undefined : (metricRunName ?? currentRunAtStart))
      if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return
      recordCommand(join(GRAPH_DIR, name), metric, code)
    } catch { /* métricas não alteram o resultado do comando */ }
  })
}
try { args = parseEngineArgs(cmd, rest) } catch (error) { die(error.message) }

function die(msg) {
  errorLog(`[prumo] ERROR: ${msg}`)
  process.exit(1)
}

function readPlanningArtifact(path) {
  let source
  try { source = readFileSync(path, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(tr('task plan artifact does not exist'))
    throw error
  }
  if (source.charCodeAt(0) === 0xFEFF) source = source.slice(1)
  try {
    const plan = JSON.parse(source)
    // O dashboard numera a lista; remova apenas o ordinal correspondente na conversão de novos planos.
    if (Array.isArray(plan?.steps)) plan.steps = plan.steps.map((step, index) => typeof step === 'string'
      ? step.replace(new RegExp(`^\\s*${index + 1}\\.\\s+(?=\\S)`), '') : step)
    return plan
  }
  catch (error) { throw new Error(tr('task plan artifact JSON is invalid: {0}', error.message)) }
}

function planningArtifactError(filename, error) {
  return tr('task plan artifact {0}: {1}', filename, tr(error.message))
}

function runName() {
  if (args.run !== undefined) return (metricRunName = safeRun(args.run))
  if (process.env.PRUMO_RUN !== undefined) return (metricRunName = safeRun(process.env.PRUMO_RUN))
  if (existsSync(CURRENT_FILE)) return (metricRunName = readFileSync(CURRENT_FILE, 'utf8').trim())
  die('no run selected — pass --run <name> or init one')
}

/* O nome da execução chega a join() como um segmento de caminho, então é validado por lista permitida, nunca confiável:
 * slug simples, sem ponto inicial, sem separadores — mesma regra de serve.mjs; mantenha sincronizado.
 * Imposto AQUI porque runDir é o único ponto de controle por onde passam todos os usos do sistema de arquivos
 * (state, events, lock, init) — um CURRENT editado para "../../x" deve morrer, não percorrer diretórios. */
function safeRun(name) {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    die(`invalid run name "${name}" — letters, digits, ".", "_" and "-" only (no leading dot, no path separators)`)
  return name
}

function safeId(id, kind = 'task') {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
    die(`invalid ${kind} id "${id}" — letters, digits, ".", "_" and "-" only (no leading dot or path separators)`)
  return id
}

function runDir(name) {
  return join(GRAPH_DIR, safeRun(name))
}

function loadState(name) {
  const p = join(runDir(name), 'state.json')
  if (!existsSync(p)) die(`run "${name}" has no state.json`)
  return hydrateDiscoveries(JSON.parse(readFileSync(p, 'utf8')), runDir(name))
}

function saveState(name, state) {
  state.updatedAt = new Date().toISOString()
  const previous = existsSync(join(runDir(name), 'state.json')) ? loadState(name) : { tasks: {} }
  const aliases = state.taskIdAliases ?? {}
  const redispatchTask = cmd === 'unblock' ? Object.hasOwn(aliases, args._[0]) ? aliases[args._[0]] : args._[0] : undefined
  for (const record of recordDispatchMetadata(previous, state, args, redispatchTask)) log('[prumo] model dispatch (reported, not verified): ' + JSON.stringify(record))
  closeInactiveActivity(state, state.updatedAt)
  const dir = runDir(name)
  compactDiscoveries(state, dir)
  writeAtomicState(join(dir, 'state.json'), JSON.stringify(state, null, 2))
}

function stopOpenActivity(owner, at) {
  const open = owner?.activityIntervals?.findLast(interval => !interval.endedAt)
  if (open) open.endedAt = at
}

function closeInactiveActivity(state, at) {
  for (const phase of Object.values(state.phaseWorkflows ?? {})) {
    if (phase.state !== 'discussing' || phase.discussionAttempts?.at(-1)?.endedAt) stopOpenActivity(phase.discussionAttempts?.at(-1), at)
    if (phase.state !== 'planning' || phase.planningAttempts?.at(-1)?.endedAt) stopOpenActivity(phase.planningAttempts?.at(-1), at)
    for (const role of ['discussion', 'planning']) {
      const round = phase[`${role}Attempts`]?.at(-1)
      for (const worker of Object.values(round?.workers ?? {}))
        if (worker.endedAt || round.endedAt || phase.state !== (role === 'discussion' ? 'discussing' : 'planning')) stopOpenActivity(worker, at)
    }
  }
  for (const task of Object.values(state.tasks ?? {})) {
    if (task.state !== 'discussing' || task.discussionAttempts?.at(-1)?.endedAt) stopOpenActivity(task.discussionAttempts?.at(-1), at)
    if (task.state !== 'planning' || task.planningAttempts?.at(-1)?.endedAt) stopOpenActivity(task.planningAttempts?.at(-1), at)
    const attempt = task.attempts?.at(-1)
    const open = attempt?.activityIntervals?.findLast(interval => !interval.endedAt)
    if (open && (task.state !== (open.role === 'execution' ? 'running' : 'reviewing') || attempt.endedAt)) open.endedAt = at
  }
}

function migrationStatus(state) {
  if (Number(state.schemaVersion) > STATE_SCHEMA_VERSION)
    die(`run uses newer schema v${state.schemaVersion}; update Prumo before opening it`)
  const nonterminal = Object.values(state.tasks ?? {}).filter(task => !['done', 'skipped'].includes(task.state))
  const missingMode = !['phase', 'task'].includes(state.plan?.planningMode)
  const mode = missingMode ? ((state.plan?.phases?.length ?? 0) ? 'phase' : 'task') : state.plan.planningMode
  const missingWorkflows = mode === 'phase' && (state.plan?.phases ?? []).some(phase => !state.phaseWorkflows?.[phase.id])
  const structural = missingMode || missingWorkflows
  const blockers = []
  if (structural) {
    for (const task of nonterminal) {
      const reasons = []
      const openDiscussion = task.discussionAttempts?.some(round => !round.endedAt)
      const openPlanning = task.planningAttempts?.some(round => !round.endedAt)
      const executionStarted = (task.attempts?.length ?? 0) > 0
      // Uma tarefa com um fluxo atual aberto não pode ser movida entre os planejadores de tarefas
      // e de fases enquanto esse fluxo estiver em andamento. Uma tentativa legada já
      // iniciada pode continuar no ciclo de vida antigo, porém;
      // transformá-la em bloqueio de migração era o que congelava trabalho não relacionado.
      // Uma tentativa no modo de tarefa 1.2 também encerrava seu próprio plano de tarefa antes da execução.
      const currentPlanning = !executionStarted && task.planningRequired !== false
      if (currentPlanning && !['pending', 'failed', 'blocked'].includes(task.state)) reasons.push(`state ${task.state}`)
      if (openDiscussion) reasons.push('open discussion')
      if (openPlanning) reasons.push('open planning')
      if (reasons.length) blockers.push(`${task.id}: ${reasons.join(', ')}`)
    }
    for (const phase of Object.values(state.phaseWorkflows ?? {})) {
      if (phase.discussionAttempts?.some(round => !round.endedAt)) blockers.push(`${phase.id}: open phase discussion`)
      if (phase.planningAttempts?.some(round => !round.endedAt)) blockers.push(`${phase.id}: open phase planning`)
    }
  }
  return { needed: state.schemaVersion !== STATE_SCHEMA_VERSION || structural || state.plan.maxAgents === undefined, structural, mode, blockers }
}

function migrateState(name, { check = false, quiet = false } = {}) {
  const state = loadState(name)
  const status = migrationStatus(state)
  if (check) {
    log(status.needed ? `[prumo] run "${name}" needs schema migration to v${STATE_SCHEMA_VERSION}` :
      `[prumo] run "${name}" already uses schema v${STATE_SCHEMA_VERSION}`)
    if (status.blockers.length) log(`[prumo] migration blocked by ${status.blockers.join('; ')}`)
    return status
  }
  if (!status.needed) return status
  if (status.blockers.length) die(`run "${name}" needs migration, blocked by ${status.blockers.join('; ')}`)
  const dir = runDir(name)
  const backup = join(dir, `state.pre-migrate-v${STATE_SCHEMA_VERSION}.json`)
  if (!existsSync(backup)) copyFileSync(join(dir, 'state.json'), backup)
  const adoptingLegacy = !['phase', 'task'].includes(state.plan.planningMode)
  state.schemaVersion = STATE_SCHEMA_VERSION
  state.plan.planningMode = status.mode
  if (state.plan.maxAgents === undefined) {
    state.plan.maxAgents = 3
    state.agentLimitHistory ??= []
    state.agentLimitHistory.push({ previous: null, maxAgents: 3, actor: 'migration', at: new Date().toISOString(),
      previousLimits: { maxParallel: state.plan.maxParallel ?? null, maxExecutors: state.plan.maxExecutors ?? null } })
  }
  if (status.mode === 'phase') {
    state.phaseWorkflows ??= {}
    for (const phase of state.plan.phases ?? []) {
      state.phaseWorkflows[phase.id] ??= { id: phase.id, title: phase.title, state: 'pending', discussionAttempts: [], planningAttempts: [], planningHistory: [] }
      if (adoptingLegacy) state.phaseWorkflows[phase.id].adoptedLegacy = true
    }
    if (adoptingLegacy) delete state.legacyPhaseAdoption
  }
  for (const task of Object.values(state.tasks)) {
    if (['done', 'skipped'].includes(task.state)) continue
    if (isExternalBlock(task)) {
      task.blockKind = 'external'
      excludeBlockedPhaseTask(state, task)
    }
    const started = (task.attempts?.length ?? 0) > 0
    const openWorkflow = task.discussionAttempts?.some(round => !round.endedAt) ||
      task.planningAttempts?.some(round => !round.endedAt)
    const legacy = task.planningRequired === false || started ||
      (task.planningRequired === undefined && ['running', 'reviewing'].includes(task.state))
    if (legacy) {
      // Este marcador é o limite de compatibilidade por tarefa. Ele permite que a
      // execução global adote a estrutura atual do grafo sem forçar uma
      // tentativa existente a passar por uma nova rodada de discussão/planejamento.
      if (adoptingLegacy && task.planningRequired === undefined) task.planningRequired = false
      continue
    }
    // Um fluxo aberto malformado é rejeitado por migrationStatus acima. Mantenha
    // seus campos intactos caso uma chamada futura ainda chegue a este ramo.
    if (openWorkflow) continue
    if (task.planningRequired === undefined) {
      task.discussionRequired = true
      task.discoveryRequired = true
      task.planningRequired = true
      task.discussionAttempts ??= []
      task.planningAttempts ??= []
      task.planningHistory ??= []
    } else if (adoptingLegacy) {
      task.discussionRequired = true
      task.discoveryRequired = true
      task.planningRequired = true
      task.discussionAttempts ??= []
      task.planningAttempts ??= []
      task.planningHistory ??= []
    }
  }
  saveState(name, state)
  emit(name, 'schema_migrate', null, { schemaVersion: STATE_SCHEMA_VERSION, planningMode: status.mode })
  if (!quiet) log(`[prumo] run "${name}" migrated to schema v${STATE_SCHEMA_VERSION}; backup: ${backup}`)
  return { ...status, migrated: true, backup }
}

/* Cada comando mutável faz uma leitura-modificação-gravação de state.json a partir de seu próprio
 * processo de curta duração, e o orquestrador recebe a instrução de despachar vários na MESMA
 * mensagem — portanto eles realmente executam ao mesmo tempo. Sem bloqueio, vence o último
 * gravador: um `start` imprime "running" e acrescenta seu evento enquanto sua alteração em state.json
 * é sobrescrita por um irmão, deixando uma tarefa que o grafo considera pending e um agente já trabalhando
 * nela. A renomeação atômica em saveState impede um arquivo truncado; somente isto evita uma gravação perdida.
 *
 * O bloqueio é um DIRETÓRIO: mkdir é atômico e falha claramente quando ele existe, em todas as
 * plataformas, sem as ressalvas de O_EXCL. Um bloqueio por execução, então duas execuções nunca
 * aguardam uma pela outra.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

let heldLock = null
/* die() encerra o processo DENTRO da seção bloqueada (uma transição recusada é o
   caminho normal, não uma exceção), e process.exit ignora blocos finally — portanto a liberação
   também precisa ficar no evento exit ou cada recusa deixaria seu bloqueio preso. */
process.on('exit', () => { if (heldLock) rmSync(heldLock, { recursive: true, force: true }) })

function withLock(name, fn) {
  const dir = runDir(name)
  mkdirSync(dir, { recursive: true })   // init adquire o bloqueio antes de o diretório da execução existir
  const lock = join(dir, '.lock')
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      heldLock = lock
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      /* Um processo encerrado no meio do comando deixa seu bloqueio para trás. A idade é a única evidência
         disponível, então um bloqueio antigo é presumido abandonado e rompido — uma execução que nunca
         mais pudesse gravar seria uma falha pior que a colisão que isto protege. */
      let age
      try { age = Date.now() - statSync(lock).mtimeMs } catch (error) {
        // Outro comando pode liberar o bloqueio entre a disputa e a leitura; tente adquiri-lo novamente.
        if (error.code === 'ENOENT') continue
        throw error
      }
      if (age > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) die(`run "${name}" is locked by another command (waited ${LOCK_WAIT_MS}ms) — retry`)
      sleepSync(25)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
    heldLock = null
  }
}

function emit(name, type, task, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), type, task, ...data })
  appendFileSync(join(runDir(name), 'events.ndjson'), line + '\n')
}

function getTask(state, id) {
  const aliases = state.taskIdAliases ?? {}
  const taskId = Object.hasOwn(aliases, id) ? aliases[id] : id
  const t = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : undefined
  if (!t) die(`unknown task "${id}"`)
  return t
}

function reviewDenominator(task) {
  let contract
  try { contract = validationContract(task) } catch { return null }
  const criteria = task.taskPlan?.verification
  if (contract.mode === 'inspection' && Array.isArray(criteria) && criteria.length)
    return { total: criteria.length, basis: 'inspection', inspection: true }
  if (contract.steps.length) return { total: contract.steps.length, basis: 'checks', inspection: contract.mode === 'inspection' }
  return null
}

function reviewProgressRecord(task, agent, denominator) {
  const attempt = task.attempts.at(-1)
  if (!denominator) {
    delete attempt.reviewProgress
    return null
  }
  const record = { current: 1, total: denominator.total, traversed: 0, basis: denominator.basis,
    agent, selfReported: false, contractRevision: task.contractRevision ?? 0,
    scopeRevision: task.scopeRevision ?? 0 }
  attempt.reviewProgress = record
  return record
}

// Shell que vai colar a linha de `progress` impressa por `start`. Fora do Windows é sempre POSIX.
// No Windows, o executor típico roda no Git Bash/MSYS2 (ferramenta Bash do Claude Code), que exporta
// MSYSTEM e/ou SHELL aos processos filhos; PowerShell e cmd não definem nenhuma das duas. Por isso a
// evidência positiva de shell POSIX decide e, só na ausência dela, a linha sai em PowerShell (o padrão
// do Windows). PSModulePath não serve de critério: é variável de sistema e aparece também no Git Bash.
function invokingShell(env = process.env) {
  if (process.platform !== 'win32') return 'posix'
  return env.MSYSTEM || env.SHELL ? 'posix' : 'powershell'
}

function quoteCommandArg(value, shell = invokingShell()) {
  const text = String(value)
  return shell === 'powershell'
    ? `'${text.replaceAll("'", "''")}'`
    : `'${text.replaceAll("'", "'\\''")}'`
}

function positiveIndex(value, label, choices) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    die(`${label} must be a positive integer${choices === undefined ? '' : '; available: ' + JSON.stringify(choices)}`)
  return Number(value)
}

function tailLineLimit(value) {
  if (value === undefined) return 15
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    die('validate --tail must be a nonnegative integer')
  return Number(value)
}

function checkPassed(check) {
  const expected = Array.isArray(check.expectedExitCodes) ? check.expectedExitCodes : [0]
  return expected.includes(check.exitCode) && !check.error && !check.signal
}

function checkOutput(check) {
  const stdout = typeof check.stdout === 'string' ? check.stdout : ''
  const stderr = typeof check.stderr === 'string' ? check.stderr : ''
  if (!stdout || !stderr) return stdout + stderr
  return stdout + (stdout.endsWith('\n') || stdout.endsWith('\r') ? '' : '\n') + stderr
}

function printValidationTail(checks, limit) {
  if (limit === 0) return
  for (const [index, check] of checks.entries()) {
    if (check.kind !== 'functional' && checkPassed(check)) continue
    const lines = checkOutput(check).split(/\r\n|\n|\r/)
    while (lines.at(-1) === '') lines.pop()
    if (!lines.length) continue
    const tail = lines.slice(-limit)
    log(`[prumo] check ${index + 1}/${checks.length} output tail (${tail.length} lines; exit ${check.exitCode ?? 'unknown'}; reused ${tr(check.reusedAt ? 'yes' : 'no')}; summary labels are textual only)`)
    for (const line of tail) {
      const visible = line.length > 1024 ? `…${line.slice(-1024)}` : line
      const summary = /\b(?:summary|results?|total|passed|failed|skipped|errors?)\b|\b\d+\s+(?:tests?|checks?|cases?|scenarios?)\b/i.test(visible)
      console.log(`  ${summary ? tr('SUMMARY') : '|'} ${visible}`)
    }
  }
}

/** `from` pode alcançar `to` pelas deps? Duas tarefas tão relacionadas são ORDERED, nunca concorrentes. */
function reaches(byId, from, to, seen = new Set()) {
  if (from === to) return true
  if (seen.has(from)) return false
  seen.add(from)
  return (byId[from]?.deps ?? []).some((d) => reaches(byId, d, to, seen))
}

/** Os prefixos de caminho colidem quando um contém o outro. */
function pathsCollide(a, b) {
  return a.startsWith(b) || b.startsWith(a)
}

function touchPathSegments(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) return null
  return normalized.split('/').filter(part => part && part !== '.')
}

function projectCwd(stored) {
  if (args.cwd !== undefined) {
    if (!args.cwd.trim()) die(tr('project cwd is not an accessible directory: {0}', args.cwd))
    const directory = resolve(args.cwd)
    try { if (statSync(directory).isDirectory()) return directory } catch { /* erro informado abaixo */ }
    die(tr('project cwd is not an accessible directory: {0}', directory))
  }
  if (typeof stored === 'string' && stored.trim()) return resolve(stored)
  let cwd = process.cwd(), central = storageHome(), root = ROOT
  // Caminhos equivalentes da central não podem ser confundidos com o repositório do projeto.
  try { cwd = realpathSync(cwd); central = realpathSync(central); root = realpathSync(root) } catch { /* preserva a comparação lexical quando a pasta não está acessível */ }
  return cwd === central || (inside(central, root) && inside(root, cwd)) ? undefined : process.cwd()
}

function validationRoots(task, cwd) {
  if (task.project) return [task.project]
  const steps = Array.isArray(task.validation) ? task.validation : []
  const roots = steps.length
    ? steps.map(step => typeof step?.cwd === 'string' && step.cwd.trim() ? resolve(step.cwd) : cwd)
    : [cwd]
  return [...new Set(roots.filter(Boolean))]
}

function pathDistance(left, right) {
  const a = process.platform === 'win32' ? left.toLowerCase() : left
  const b = process.platform === 'win32' ? right.toLowerCase() : right
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

function closestTouchPath(root, parts) {
  let parent = root
  const found = []
  for (let index = 0; index < parts.length; index++) {
    let entries
    try { entries = readdirSync(parent, { withFileTypes: true }) } catch { return null }
    const wanted = parts[index]
    const equal = name => process.platform === 'win32' ? name.toLowerCase() === wanted.toLowerCase() : name === wanted
    const exact = entries.find(entry => equal(entry.name))
    if (exact) {
      found.push(exact.name)
      parent = join(parent, exact.name)
      if (index < parts.length - 1 && !exact.isDirectory()) return null
      continue
    }
    const candidates = entries.map(entry => ({ name: entry.name, distance: pathDistance(wanted, entry.name) }))
      .sort((a, b) => a.distance - b.distance)
    const best = candidates[0]
    if (!best || best.distance > Math.max(1, Math.floor(wanted.length / 3)) || candidates[1]?.distance === best.distance)
      return null
    const suggestion = [...found, best.name, ...parts.slice(index + 1)]
    try { statSync(resolve(root, ...suggestion)); return suggestion.join('/') } catch { return null }
  }
  return null
}

function warnPlanTouchPaths(plan, cwd) {
  let unknownRootWarned = false
  for (const task of plan.tasks) {
    if (!Array.isArray(task.touches) || !task.touches.length) continue
    const roots = validationRoots(task, cwd)
    if (!roots.length) {
      if (!unknownRootWarned) log('[prumo] ' + tr('touches check skipped: project directory is unknown; use sync-plan --cwd <project> or declare validation step.cwd'))
      unknownRootWarned = true
      continue
    }
    const accessible = roots.filter(root => {
      try { return statSync(root).isDirectory() } catch { return false }
    })
    const inaccessible = roots.filter(root => !accessible.includes(root))
    for (const touch of task.touches) {
      const parts = touchPathSegments(touch)
      if (!parts) {
        log('[prumo] ' + tr('touches check not run for task {0} path "{1}": only repository-relative paths can be checked',
          task.id, touch))
        continue
      }
      if (accessible.some(root => {
        try { statSync(resolve(root, ...parts)); return true } catch { return false }
      })) continue
      if (!accessible.length) {
        log('[prumo] ' + tr('touches check not run for task {0} path "{1}": validation repository/cwd is inaccessible ({2})',
          task.id, touch, roots.join(', ')))
        continue
      }
      const suggestion = accessible.map(root => closestTouchPath(root, parts)).find(Boolean)
      log('[prumo] ' + tr('touches warning: task {0} path "{1}" was not found in validation repository/cwd {2}{3}; a new file or folder is allowed, so confirm this is intentional',
        task.id, touch, accessible.join(', '), suggestion ? tr(' — closest existing path: {0}', suggestion) : ''))
      if (inaccessible.length)
        log('[prumo] ' + tr('touches check not run in inaccessible validation repository/cwd: {0}', inaccessible.join(', ')))
    }
  }
}

function warnTaskPlan(task, plan, state) {
  for (const index of repeatedPlanQuestions(task, plan, state.phaseWorkflows?.[task.phase]?.discovery))
    log(`[prumo] planning warning: ${task.id} openQuestions[${index}] repeats a literally answered discussion/decision question; inspect the current contract and answer before retaining it. No answer or resolution was inferred.`)
  if (!plan.writes?.length)
    log('[prumo] ' + tr('task plan warning: {0} declares no writes; confirm the executor stays within approved touches', task.id))
  for (let index = 0; index < plan.verification.length; index++) {
    const item = plan.verification[index]
    for (const resource of new Set(item.requires ?? [])) {
      if (task.unavailable?.includes(resource))
        log('[prumo] ' + tr('planning warning: task {0} verification {1} requires unavailable resource {2}; keep it pending for the reviewer',
          task.id, index + 1, resource))
    }
  }
}

/* Identifica o código que está de fato em execução. O instalador grava .prumo-install.json ao lado de
   scripts/; uma cópia do código-fonte tem package.json ali. A infraestrutura de testes só é informada
   quando o marcador a registra, nunca inferida. */
async function printEngineIdentity() {
  const engineFile = fileURLToPath(import.meta.url)
  const skillDir = dirname(dirname(engineFile))
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
  let marker = null
  try {
    const value = JSON.parse(readFileSync(join(skillDir, '.prumo-install.json'), 'utf8').replace(/^﻿/, ''))
    if (value?.product === 'prumo') marker = value
  } catch { /* cópia do código-fonte ou scripts copiados */ }
  if (!marker) {
    let version = tr('unknown version'), id = null
    try { version = JSON.parse(readFileSync(join(skillDir, 'package.json'), 'utf8')).version ?? version } catch { /* scripts copiados */ }
    try { id = (await import('./installation-bundle.mjs')).contentId('en', { packageRoot: skillDir }) } catch { /* cópia incompleta */ }
    log('[prumo] ' + tr('Prumo {0} ({1}) — source checkout without an installation marker; harness not recorded',
      version, id ?? tr('content identifier unavailable')))
    return
  }
  const harness = typeof marker.harness === 'string' && marker.harness ? marker.harness : tr('harness not recorded')
  const installedVersion = marker.version ?? tr('unknown version')
  if (marker.contentId) log(`[prumo] Prumo ${installedVersion} (${marker.contentId}) — ${harness}`)
  else log('[prumo] ' + tr('Prumo {0} (content identifier missing — run prumo update) — {1}', installedVersion, harness))
  let engineHash = null
  try { engineHash = sha256(readFileSync(engineFile)) } catch { /* arquivo do engine ilegível */ }
  if (marker.engineHash && engineHash && marker.engineHash !== engineHash)
    log('[prumo] ' + tr('WARNING: the running engine.mjs differs from the installation marker ({0} {1}); run prumo status --verify-install, then prumo update',
      installedVersion, marker.contentId ?? tr('content identifier missing')))
  try {
    const { engineDashboardMismatch, registeredDashboardIdentity } = await import('./installation-bundle.mjs')
    const mismatch = engineDashboardMismatch(skillDir, await registeredDashboardIdentity({ home: homedir() }))
    if (mismatch) log('[prumo] ' + tr('WARNING: engine content {0} differs from dashboard content {1}; run prumo update',
      mismatch.engineContentId, mismatch.dashboardContentId))
  } catch { /* Cópias incompletas não comprovam divergência de conteúdo. */ }
  if (args['verify-install'] !== true) return
  let current = null
  try {
    const lang = ['en', 'pt-BR'].includes(marker.lang) ? marker.lang : 'en'
    current = (await import('./installation-bundle.mjs')).contentId(lang, { packageRoot: skillDir })
  } catch { /* instalação incompleta */ }
  if (current && current === marker.contentId) log('[prumo] ' + tr('installed files match the installation marker ({0})', current))
  else log('[prumo] ' + tr('WARNING: installed files differ from the installation marker (marker {0}, files {1}); run prumo update',
    marker.contentId ?? tr('content identifier missing'), current ?? tr('content identifier unavailable')))
}

function printContractDriftWarnings(state) {
  const drift = contractDrift(state)
  if (!drift.available) {
    log('[prumo] ' + tr('approved plan source unavailable ({0}); contract drift was not checked', tr(drift.reason)))
    return
  }
  if (drift.planFields.length)
    log('[prumo] ' + tr('contract drift: approved plan fields: {0} — run sync-plan', drift.planFields.join(', ')))
  const preserved = []
  for (const item of drift.tasks) {
    const task = displayIdentifier(item.task)
    if (['done', 'skipped'].includes(state.tasks[item.task]?.state) && !item.fields.includes('missingFromApprovedPlan')) {
      preserved.push(task)
      continue
    }
    if (item.fields.includes('notSynchronized'))
      log('[prumo] ' + tr('contract drift: task {0} is new in the approved plan and not synchronized — run sync-plan', task))
    else if (item.fields.includes('missingFromApprovedPlan'))
      log('[prumo] ' + tr('contract drift: task {0} is missing from the approved plan; sync-plan refuses task removal — restore it in the approved plan', task))
    else log('[prumo] ' + tr('contract drift: task {0} fields: {1} — run sync-plan', task, item.fields.join(', ')))
  }
  if (preserved.length) log('[prumo] ' + tr('completed task contracts preserved: {0} — inspect with show-contract <task> --diff; create a follow-up task for approved changes', preserved.join(', ')))
}

function ageLabel(startedAt) {
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000))
  if (!Number.isFinite(elapsed)) return tr('unknown age')
  if (elapsed < 60) return tr('{0}s', elapsed)
  if (elapsed < 3600) return tr('{0}m', Math.floor(elapsed / 60))
  return tr('{0}h', Math.floor(elapsed / 3600))
}

function printPlanningRoundProgress(state) {
  // Uma rodada ainda aberta quando uma alteração posterior de contrato (sync-plan) exigiu confirmação não conta mais
  // como trabalho em andamento: ela não pode aparecer como "open", ou o orquestrador aguardará artefatos que
  // finish-planning recusaria.
  const invalidated = (owner, round) => !round.endedAt && typeof owner.contractConfirmationRequired?.at === 'string' &&
    Date.parse(owner.contractConfirmationRequired.at) >= Date.parse(round.startedAt)
  const line = (id, round, recorded, total, owner) => round.endedAt
    ? tr('planning round {0} ({1}) completed for {2}; artifacts {3}/{4}',
      id, round.n, ageLabel(round.startedAt), recorded, total)
    : invalidated(owner, round)
      ? tr('planning round {0} ({1}) is stale after a contract change; artifacts {2}/{3}', id, round.n, recorded, total)
      : tr('planning round {0} ({1}) {2} for {3}; artifacts {4}/{5}',
        id, round.n, tr('open'), ageLabel(round.startedAt), recorded, total)
  for (const phase of Object.values(state.phaseWorkflows ?? {})) {
    const round = phase.planningAttempts?.at(-1)
    if (!round || (round.endedAt && round.result !== 'planned')) continue
    const total = round.targets?.length ?? 0
    // Uma rodada aberta que conhece seu diretório de artefatos contabiliza os arquivos já gravados ali.
    const recorded = Number.isSafeInteger(round.artifactCount) ? round.artifactCount :
      !round.endedAt && typeof round.planDir === 'string' ?
        (round.targets ?? []).filter(id => existsSync(join(round.planDir, `task-plan-${id}.json`))).length :
      (round.targets ?? []).filter(id => {
        const plan = state.tasks[id]?.taskPlan
        return plan?.phaseId === phase.id && plan.phaseBinding?.discussionRoundId === round.discussionRoundId &&
          plan.phaseBinding?.plannerRound === round.n
      }).length
    log('[prumo] ' + line(phase.id, round, recorded, total, phase))
  }
  for (const task of Object.values(state.tasks)) {
    if (task.phase || state.plan.planningMode === 'phase') continue
    const round = task.planningAttempts?.at(-1)
    if (!round || (round.endedAt && round.result !== 'planned')) continue
    const recorded = Number.isSafeInteger(round.artifactCount) ? round.artifactCount :
      (task.taskPlan?.startedAt === round.startedAt && task.taskPlan?.context === round.context ? 1 : 0)
    log('[prumo] ' + line(task.id, round, recorded, 1, task))
  }
}

function printPendingContractConfirmations(state) {
  for (const phase of Object.values(state.phaseWorkflows ?? {})) {
    if (!phase.contractConfirmationRequired) continue
    const tasks = (phase.contractConfirmationRequired.tasks ?? []).map(displayIdentifier).join(', ')
    log('[prumo] ' + tr('contract confirmation required for phase {0}: {1}', phase.id, tasks || tr('current phase tasks')))
  }
  for (const task of Object.values(state.tasks)) {
    if (task.contractConfirmationRequired)
      log('[prumo] ' + tr('contract confirmation required for task {0}', displayIdentifier(task.id)))
  }
}

function manualInspectionPending(state, task) {
  const required = task.unavailable?.includes('manual-inspection') ||
    task.taskPlan?.verification?.some(item => item.requires?.includes('manual-inspection'))
  if (!required) return false
  const receipt = task.validations?.at(-1)
  const currentScope = !task.planningRequired || receipt?.planningScope === currentPlanningScope(state, task, receipt?.attempt)
  return !(receipt?.ok && receipt.by === 'review' && receipt.agent === task.reviewer && task.reviewer !== task.agent &&
    receipt.attempt === task.attempts?.length && currentScope)
}

/* Estimativa humana opcional para fazer a tarefa manualmente, armazenada em minutos inteiros para que cada leitor
   compare o mesmo valor. Aceita minutos (45), "4h", "4h30", "90m", "45min" ou ISO "PT4H30M".
   É metadado de exibição para a visão de ganhos, nunca uma medição e nunca parte do contrato. */
function manualEstimateMinutes(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  let hours = 0, minutes = 0, match
  if ((match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(text)) && (match[1] || match[2])) {
    hours = Number(match[1] ?? 0); minutes = Number(match[2] ?? 0)
  } else if ((match = /^(\d+)\s*h(?:\s*(\d+)\s*(?:m|min)?)?$/i.exec(text))) {
    hours = Number(match[1]); minutes = Number(match[2] ?? 0)
    if (match[2] !== undefined && minutes >= 60) return null
  } else if ((match = /^(\d+)\s*(?:m|min)$/i.exec(text))) {
    minutes = Number(match[1])
  } else return null
  const total = hours * 60 + minutes
  return Number.isSafeInteger(total) && total > 0 ? total : null
}

function validatePlan(plan, allowOverlap = false, historical = new Set(), defaultProject = projectCwd()) {
  try { assertRolePreferences(plan.rolePreferences) } catch (error) { die(error.message) }
  if (plan.maxAgents !== undefined && (!Number.isSafeInteger(plan.maxAgents) || plan.maxAgents < 1)) die('maxAgents must be a positive integer')
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) die('plan has no tasks')
  const ids = new Set()
  const planningMode = plan.planningMode ?? ((plan.phases?.length ?? 0) ? 'phase' : 'task')
  if (!['phase', 'task'].includes(planningMode)) die('planningMode must be phase or task')
  const phaseIds = new Set()
  for (const phase of plan.phases ?? []) {
    safeId(phase.id, 'phase')
    if (phaseIds.has(phase.id)) die(`duplicate phase id ${phase.id}`)
    phaseIds.add(phase.id)
  }
  for (const t of plan.tasks) {
    if (!t.id || !t.title) die('every task needs id and title')
    try { assertEvidenceContract(t) } catch (error) { die(`task ${t.id}: ${error.message}`) }
    try { assertExplicitScope(t, historical.has(t.id) ? undefined : plan.scopePolicy) } catch (error) { die(`task ${t.id}: ${error.message}`) }
    safeId(t.id)
    if (ids.has(t.id)) die(`duplicate task id ${t.id}`)
    for (const field of ['summary', 'validationSummary'])
      if (t[field] !== undefined && (typeof t[field] !== 'string' || !t[field].trim()))
        die(tr('task {0} {1} must be a nonempty string when present', t.id, field))
    if (t.label !== undefined) {
      const words = typeof t.label === 'string' && t.label.trim() ? t.label.trim().split(/\s+/u) : []
      if (!words.length || words.length > 3 || Array.from(t.label).length > 24)
        die(tr('task {0} label must have 1 to 3 words and no more than 24 characters', t.id))
    }
    if (t.manualEstimate !== undefined && manualEstimateMinutes(t.manualEstimate) === null)
      die(tr('task {0} manualEstimate must be a positive whole number of minutes or a duration such as 4h30, 90m or PT4H30M', t.id))
    if (planningMode === 'phase' && !phaseIds.has(t.phase)) die(`task ${t.id} needs a declared phase for phase planning`)
    try { assertUnavailableResources(t) } catch (error) { die(`task ${t.id}: ${error.message}`) }
    if (!historical.has(t.id))
      try { validationContract(t) } catch (error) { die(`task ${t.id}: ${error.message}`) }
    ids.add(t.id)
  }
  for (const t of plan.tasks)
    for (const d of t.deps ?? [])
      if (!ids.has(d)) die(`task ${t.id} depends on unknown task ${d}`)

  const depsOf = Object.fromEntries(plan.tasks.map((t) => [t.id, t.deps ?? []]))
  const visitState = {}
  const path = []
  const visit = (id) => {
    if (visitState[id] === 2) return null
    if (visitState[id] === 1) return [...path.slice(path.indexOf(id)), id]
    visitState[id] = 1
    path.push(id)
    for (const d of depsOf[id]) {
      const cycle = visit(d)
      if (cycle) return cycle
    }
    path.pop()
    visitState[id] = 2
    return null
  }
  for (const t of plan.tasks) {
    const cycle = visit(t.id)
    if (cycle) die(`plan has a dependency cycle: ${cycle.join(' → ')}`)
  }

  const byId = Object.fromEntries(plan.tasks.map((t) => [t.id, t]))
  for (let i = 0; i < plan.tasks.length; i++) {
    for (let j = i + 1; j < plan.tasks.length; j++) {
      const a = plan.tasks[i]
      const b = plan.tasks[j]
      const shared = scopeConflicts(a, b).resources
      if (shared.length && !allowOverlap && !reaches(byId, a.id, b.id) && !reaches(byId, b.id, a.id))
        die(`${a.id} and ${b.id} share write resources: ${shared.join(', ')} — add a dep between them (or --allow-overlap)`)
      if (!a.touches?.length || !b.touches?.length) continue
      if (reaches(byId, a.id, b.id) || reaches(byId, b.id, a.id)) continue
      const clash = plan.scopePolicy === 'explicit' ? scopeConflicts(a, b, defaultProject).paths[0] :
        sameProject(a, b, defaultProject) && a.touches.find((pa) => b.touches.some((pb) => pathsCollide(pa, pb)))
      if (clash && !allowOverlap)
        die(
          `${a.id} and ${b.id} can run in parallel but both touch "${clash}" — ` +
            `add a dep between them (or --allow-overlap)`,
        )
    }
  }
}

function historicalTasks(state) {
  return new Set(Object.values(state?.tasks ?? {}).filter(t => ['done', 'skipped'].includes(t.state)).map(t => t.id))
}

function printSyncPlanAudit(changes, diagnostics) {
  // Alterações aplicadas são o resultado acionável da CLI. Diferenças terminais preservadas permanecem
  // estruturadas no evento e são resumidas pelo ID da tarefa abaixo, evitando uma parede
  // de campos históricos quando uma execução antiga contém muitos contratos concluídos.
  for (const change of changes.filter(item => !item.preserved)) {
    const details = change.fields.map(formatContractChange).join('; ')
    log('[prumo] ' + tr('sync-plan task {0} changed: {1}', displayIdentifier(change.task), details))
  }
  for (const finding of diagnostics.blockReasonContradictions) {
    if (finding.missingDeps.length)
      log('[prumo] ' + tr(
        'sync-plan warning: {0} blockReason cites {1}, absent from persisted deps',
        displayIdentifier(finding.task), finding.missingDeps.map(displayIdentifier).join(', '),
      ))
    if (finding.plannedMissingDeps.length)
      log('[prumo] ' + tr(
        'sync-plan warning: {0} blockReason cites {1}, absent from planned deps',
        displayIdentifier(finding.task), finding.plannedMissingDeps.map(displayIdentifier).join(', '),
      ))
    const backEdges = [...new Set([...finding.backEdgesBefore, ...finding.backEdgesAfter])]
    if (backEdges.length)
      log('[prumo] ' + tr(
        'sync-plan strong warning: {0} blockReason cites {1}, and cited tasks depend on it',
        displayIdentifier(finding.task), backEdges.map(displayIdentifier).join(', '),
      ))
  }
  for (const leaf of diagnostics.newLeaves) {
    if (leaf.severity === 'warning') {
      const blocker = diagnostics.blockReasonContradictions.find(item => item.cited.includes(leaf.task)).task
      log('[prumo] ' + tr(
        'sync-plan warning: new leaf task {0} is cited by blocked task {1}',
        displayIdentifier(leaf.task), displayIdentifier(blocker),
      ))
    } else {
      log('[prumo] ' + tr('sync-plan info: new leaf task {0} has no dependents', displayIdentifier(leaf.task)))
    }
  }
  for (const finding of diagnostics.preDiscussionFunctionalContracts) {
    const unit = finding.count === 1 ? 'functional check' : 'functional checks'
    const indexLabel = finding.indices.length === 1 ? 'new index' : 'new indices'
    const indices = finding.indices.join(', ')
    log(`[prumo] sync-plan warning: ${displayIdentifier(finding.task)} is ${tr(finding.effective)}, but validation now has ${finding.count} ${unit} (${indexLabel} ${indices}); is this planning?`)
  }
  for (const invalidation of diagnostics.invalidatedWorkflows ?? []) {
    const workflow = tr(invalidation.workflow)
    const label = invalidation.task ? `${displayIdentifier(invalidation.task)} ${workflow}` :
      `${displayIdentifier(invalidation.id)} ${workflow}`
    log('[prumo] ' + tr('sync-plan warning: {0} was invalidated: {1}', label, invalidation.cause))
  }
}

function readPlan(planPath, state) {
  const source = resolve(planPath)
  const plan = JSON.parse(readFileSync(source, 'utf8'))
  const validationPlan = state ? { ...plan, planningMode: state.plan.planningMode ?? 'task' } : plan
  validatePlan(validationPlan, args['allow-overlap'] === true, historicalTasks(state), projectCwd(state?.plan.cwd))
  const identifierTasks = state ? plan.tasks.map(task => ['done', 'skipped'].includes(state.tasks[task.id]?.state)
    ? { ...task, deps: state.tasks[task.id].deps } : task) : plan.tasks
  const identifierProblem = taskIdentifierProblem(identifierTasks, state ? Object.keys(state.tasks) : undefined, state?.tasks)
  if (identifierProblem) die(tr(identifierProblem.message, ...identifierProblem.values))
  const phaseProblem = phaseIdentifierProblem(plan.phases ?? [], (state?.plan.phases ?? []).map(phase => phase.id))
  if (phaseProblem) die(tr(phaseProblem.message, ...phaseProblem.values))
  return { plan, source }
}

function taskFromPlan(t) {
  return {
    id: t.id,
    phase: t.phase ?? null,
    title: t.title,
    label: t.label,
    summary: t.summary,
    validationSummary: t.validationSummary,
    manualEstimate: t.manualEstimate === undefined ? undefined : manualEstimateMinutes(t.manualEstimate),
    deps: t.deps ?? [],
    validation: t.validation ?? '',
    validationMode: t.validationMode,
    inspectionReason: t.inspectionReason,
    requireReview: t.requireReview,
    maxAttempts: t.maxAttempts,
    tags: t.tags ?? [],
    touches: t.touches ?? [],
    ...(t.project === undefined ? {} : { project: t.project }),
    ...(t.writeScope === undefined ? {} : { writeScope: t.writeScope }),
    ...(t.sharedResources === undefined ? {} : { sharedResources: t.sharedResources }),
    ...Object.fromEntries(['textRules', 'deliveries', 'numericProvenance'].filter(key => t[key] !== undefined).map(key => [key, structuredClone(t[key])])),
    unavailable: t.unavailable === undefined ? undefined : [...new Set(t.unavailable)],
    state: 'pending',
    discussionRequired: true,
    discussionAttempts: [],
    discussionSkips: [],
    discoveryRequired: true,
    planningRequired: true,
    planner: null,
    planningAttempts: [],
    planningHistory: [],
    planningSkips: [],
    agent: null,
    reviewer: null,
    attempts: [],
    validations: [],
    notes: [],
  }
}

function globalPlanValues(plan) {
  return {
    name: plan.name,
    description: plan.description ?? '',
    requireReview: plan.requireReview !== false,
    ...(plan.scopePolicy === undefined ? {} : { scopePolicy: plan.scopePolicy }),
  }
}

function beginPlanning(state, task, agent, context = planningContext(state, task), digest = task.discovery?.digest) {
  task.planningRequired = true
  task.planner = agent
  task.planningAttempts ??= []
  task.planningHistory ??= []
  task.planningAttempts.push({ n: task.planningAttempts.length + 1, agent,
    startedAt: new Date().toISOString(), activityTiming: 'explicit', activityIntervals: [],
    context, attempt: task.attempts.length + (task.planningReturn ? 0 : 1),
    contextSnapshot: taskContextSnapshot(state, task),
    ...(digest ? { discoveryDigest: digest } : {}) })
  task.state = 'planning'
}

function closePlanning(task, result, cause) {
  const round = task.planningAttempts?.at(-1)
  if (round && !round.endedAt) Object.assign(round, { endedAt: new Date().toISOString(), result,
    ...(cause ? { cause } : {}) })
}

function closeDiscussion(task, result, cause) {
  const round = task.discussionAttempts?.at(-1)
  if (round && !round.endedAt) Object.assign(round, { endedAt: new Date().toISOString(), result,
    ...(cause ? { cause } : {}) })
}

function currentDiscussion(state, task) {
  const round = task.discussionAttempts?.at(-1)
  return round?.result === 'discussed' && round.context === planningContext(state, task) &&
    round.attempt === task.attempts.length + (task.planningReturn ? 0 : 1) &&
    task.discovery?.roundId === round.roundId && task.discovery?.nonce === round.nonce &&
    task.discovery?.digest === round.discoveryDigest && task.discovery.digest === discoveryDigest(task.discovery)
}

function phaseMembers(state, phaseId) {
  return Object.values(state.tasks).filter(task => task.phase === phaseId)
}

function getPhase(state, phaseId) {
  const phase = Object.hasOwn(state.phaseWorkflows ?? {}, phaseId) ? state.phaseWorkflows[phaseId] : undefined
  if (!phase) die(`unknown phase "${phaseId}"`)
  return phase
}

function phaseTargets(state, phaseId) {
  return phaseMembers(state, phaseId).filter(task => !['done', 'skipped'].includes(task.state) && !isExternalBlock(task) && !task.individualPlanning &&
    usesCurrentPlanning(state, task) &&
    !(task.taskPlan?.phaseId === phaseId && hasCurrentTaskPlan(state, task)))
}

function phaseDiscussionTargets(state, phaseId, round = null) {
  const targets = phaseTargets(state, phaseId)
  if (targets.length || !round?.targetsFallback) return targets
  return phaseMembers(state, phaseId).filter(task => usesCurrentPlanning(state, task) &&
    !['done', 'skipped'].includes(task.state) && !isExternalBlock(task) && !task.individualPlanning)
}

function phasePlanningBlockers(state, phaseId) {
  const blockers = new Set()
  for (const task of phaseMembers(state, phaseId)) {
    if (['done', 'skipped'].includes(task.state) || isExternalBlock(task) || task.individualPlanning || !usesCurrentPlanning(state, task)) continue
    for (const id of task.deps ?? []) {
      const dep = state.tasks[id]
      if (dep?.phase !== phaseId && !['done', 'skipped'].includes(dep?.state)) {
        blockers.add(dep?.phase ?? id)
      }
    }
  }
  return [...blockers]
}

function logExcludedTasks(state, phaseId) {
  const tasks = phaseMembers(state, phaseId).filter(isExternalBlock)
  if (tasks.length) log('[prumo] ' + tr('Outside this round (blocked): {0}', tasks.map(task => `${task.id} — ${task.blockReason || tr('external input pending')}`).join('; ')))
}

function excludeBlockedPhaseTask(state, task) {
  const phase = state.phaseWorkflows?.[task.phase]
  if (!phase || !isExternalBlock(task)) return
  task.individualPlanning = true
  for (const record of [phase.discussionAttempts?.at(-1), phase.discussionSkips?.at(-1), phase.planningAttempts?.at(-1)]) {
    if (!record?.targets?.includes(task.id)) continue
    record.originalTargets ??= [...record.targets]
    record.excludedTargets ??= []
    record.excludedTargets.push({ task: task.id, reason: task.blockReason, at: new Date().toISOString() })
    record.targets = record.targets.filter(id => id !== task.id)
    if (Object.hasOwn(record.workers ?? {}, task.id)) {
      stopOpenActivity(record.workers[task.id], new Date().toISOString())
      record.workers[task.id].endedAt = new Date().toISOString()
    }
    if (record.activeTargets) record.activeTargets = record.activeTargets.filter(id => id !== task.id)
    if (record.queuedTargets) record.queuedTargets = record.queuedTargets.filter(id => id !== task.id)
    if (record.stagedPlans) record.stagedPlans = record.stagedPlans.filter(item => item.task !== task.id)
    if (record.contextTargets) record.contextTargets = record.contextTargets.filter(id => id !== task.id)
    const targets = (record.contextTargets ?? record.targets).map(id => state.tasks[id]).filter(Boolean)
    record.context = phaseContext(state, phase.id, targets)
    record.contextSnapshot = phaseContextSnapshot(state, targets)
    if (phase.discovery && phase.discovery.roundId === record.roundId) phase.discovery.context = record.context
    if (record.discovery && record.discovery.roundId === record.roundId) record.discovery.context = record.context
  }
}

function assertExternalBlockAction(state, id) {
  const task = state.tasks[id]
  if (isExternalBlock(task)) die(tr('{0} is blocked: {1}. Use unblock before discussing, planning, reviewing or executing.',
    id, task.blockReason || tr('external input pending')))
}

function agentLimitChange() {
  if (args['confirmed-by-user'] !== true) die('set-agent-limit requires --confirmed-by-user')
  const max = Number(args.max), actor = args.actor
  if (!Number.isSafeInteger(max) || max < 1) die('maxAgents must be a positive integer')
  if (typeof actor !== 'string' || !actor.trim()) die('set-agent-limit requires --actor')
  return { max, actor: actor.trim() }
}

function eligibleDiscussionPhases(state) {
  if (state.runPause && !state.runPause.endedAt) return []
  if (state.plan.planningMode !== 'phase') return []
  return (state.plan.phases ?? []).flatMap(phase => {
    const workflow = state.phaseWorkflows?.[phase.id]
    if (!workflow || ['discussing', 'planning'].includes(workflow.state) ||
        state.legacyPhaseAdoption && !workflow.adoptedLegacy || phasePlanningBlockers(state, phase.id).length)
      return []
    const targets = phaseTargets(state, phase.id)
    return targets.length ? [{ phase: phase.id, tasks: targets.map(task => task.id) }] : []
  })
}

function announceNewlyEligiblePhases(name, previouslyEligible, state, cause) {
  const previous = new Set(previouslyEligible.map(item => item.phase))
  for (const item of eligibleDiscussionPhases(state)) {
    if (previous.has(item.phase)) continue
    emit(name, 'phase_eligible', null, { ...item, cause })
    log('[prumo] ' + tr('phase {0} is eligible for discussion; tasks: {1}', item.phase, item.tasks.join(', ')))
  }
}



function annotatePlanQuestions(task, questions, startedAt) {
  return questions.map((question, index) => ({ ...question,
    questionRef: `${task.id}:plan:${digestValue([task.id, startedAt, index + 1, question.question]).slice(0, 12)}` }))
}





function validateQuestionDeadlines(state, taskId, openQuestions) {
  for (const [index, question] of openQuestions.entries()) {
    if (question.decideBy && typeof question.decideBy === 'object') {
      if (question.decideBy.beforeTask && (!Object.hasOwn(state.tasks, question.decideBy.beforeTask) || !state.tasks[question.decideBy.beforeTask]))
        throw new Error(tr('task {0} plan open question {1} references unknown task {2}', taskId, index + 1, question.decideBy.beforeTask))
      if (question.decideBy.beforePhase && !(state.plan.phases ?? []).some(phase => phase.id === question.decideBy.beforePhase))
        throw new Error(tr('task {0} plan open question {1} references unknown phase {2}', taskId, index + 1, question.decideBy.beforePhase))
    }
    const decideBy = question.blocking ? 'user-now' : (question.decideBy ?? 'executor')
    if (!question.answer && targetHasStarted(state, decideBy)) {
      const deadline = decideBy.beforeTask ? tr('before task {0}', decideBy.beforeTask) : tr('before phase {0}', decideBy.beforePhase)
      throw new Error(tr('task {0} plan open question {1} has an expired deadline ({2}) and must be answered before it can be added: {3}', taskId, index + 1, deadline, question.question.replace(/\s+/g, ' ').slice(0, 120)))
    }
  }
}

function validateQuestionResolutions(state, decisions) {
  const known = new Set(openQuestionRecords(state).map(item => item.ref))
  const requested = decisions.filter(item => item?.resolvesQuestion).map(item => item.resolvesQuestion)
  if (new Set(requested).size !== requested.length)
    die(tr('decisions cannot resolve the same open question more than once'))
  for (const ref of requested) if (!known.has(ref))
    die(tr('decision references unknown open question {0}', ref))
  const resolved = questionResolutionMap(state)
  for (const ref of requested) if (resolved.has(ref))
    die(tr('open question {0} was already resolved', ref))
  return requested
}

function recordQuestionResolutions(state, refs, decisions, { task, phase } = {}) {
  if (!refs.length) return
  state.questionResolutions ??= []
  for (const ref of refs) {
    const decision = decisions.find(item => item.resolvesQuestion === ref)
    state.questionResolutions.push({ questionRef: ref, ...(task ? { byTask: task } : {}),
      ...(phase ? { byPhase: phase } : {}), question: decision.question, answer: decision.answer,
      at: new Date().toISOString() })
  }
}











function scheduledQuestionsForTarget(state, taskId = null, phaseId = null) {
  const resolved = questionResolutionMap(state)
  return openQuestionRecords(state).filter(item => {
    if (item.question.answer || resolved.has(item.ref)) return false
    if (item.decideBy === 'executor') return false
    if (item.decideBy === 'user-now') return item.sourceTask === taskId
    if (item.decideBy?.beforeTask) return item.decideBy.beforeTask === taskId
    if (item.decideBy?.beforePhase) return item.decideBy.beforePhase === phaseId
    return false
  })
}

function printQuestionsForTarget(state, taskId, phaseId) {
  const questions = scheduledQuestionsForTarget(state, taskId, phaseId)
  if (!questions.length) return
  log('[prumo] ' + tr('resolve open questions before proceeding; reference each question ID in decisions[].resolvesQuestion:'))
  for (const item of questions)
    log(`[prumo] ${item.ref} (from ${item.sourceTask}): ${item.question.question}`)
}

/* Depois que um plano é registrado, informe ao orquestrador quais perguntas abertas vão ao usuário agora e quais
   aguardam uma tarefa ou fase posterior, para que uma decisão futura não seja trazida junto com a
   autorização de execução. Perguntas que o executor aplica a partir da resposta proposta não são listadas. */
function printPlannedQuestionSummary(tasks) {
  const now = [], later = [], unanswered = []
  for (const task of tasks) {
    for (const question of task.taskPlan.openQuestions) {
      const decideBy = question.blocking ? 'user-now' : (question.decideBy ?? 'executor')
      const item = { ref: question.questionRef, task: task.id, question }
      if (decideBy === 'user-now') now.push(item)
      else if (decideBy && typeof decideBy === 'object') later.push({ ...item, decideBy })
      else if (question.decideBy === 'executor' && !question.answer) unanswered.push(item)
    }
  }
  if (now.length) {
    log('[prumo] ' + tr('open questions for the user now:'))
    for (const item of now) log('[prumo]   ' + (item.question.answer
      ? tr('{0} ({1}): {2} — proposed answer: {3}', item.ref, item.task, item.question.question, item.question.answer)
      : `${item.ref} (${item.task}): ${item.question.question}`))
  }
  if (later.length) {
    log('[prumo] ' + tr('open questions with a later deadline; do not ask them now, they reappear at their target:'))
    for (const item of later) {
      const deadline = item.decideBy.beforeTask ? tr('before task {0}', item.decideBy.beforeTask) :
        tr('before phase {0}', item.decideBy.beforePhase)
      log(`[prumo]   ${item.ref} (${item.task}, ${deadline}): ${item.question.question}`)
    }
  }
  for (const item of unanswered)
    log('[prumo] ' + tr('WARNING: open question {0} ({1}) is decided by the executor but has no proposed answer',
      item.ref, item.task))
}

function assertNoOverdueQuestions(state, task) {
  const questions = overdueQuestions(state, task.id, task.phase)
  if (questions.length)
    die(tr('{0} has unresolved questions due before it starts: {1}; resolve them in discussion or planning decisions',
      task.id, questions.map(item => item.ref).join(', ')))
}

function printQuestionStatus(state) {
  const resolved = questionResolutionMap(state)
  for (const item of openQuestionRecords(state)) {
    if (item.question.answer || resolved.has(item.ref) || item.decideBy === 'executor') continue
    const deadline = item.decideBy === 'user-now' ? tr('now') : item.decideBy.beforeTask ?
      tr('before task {0}', item.decideBy.beforeTask) : tr('before phase {0}', item.decideBy.beforePhase)
    const label = questionIsOverdue(state, item) ? tr('overdue') : tr('scheduled')
    log('[prumo] ' + tr('open question {0} ({1}, {2}): {3}', item.ref, label, deadline, item.question.question))
  }
}



// Uma execução só restringe o despacho depois que o escopo do usuário foi registrado pelo menos uma vez.
// Execuções criadas antes de existir autorização, ou nunca autorizadas, mantêm o comportamento anterior.


/** Retorna true quando start prossegue sob o comportamento anterior, sem escopo. */
function assertTaskExecutionAuthorized(state, task) {
  if (taskAuthorization(task)) return false
  if (task.authorizationHistory?.length || runHasAuthorizationScope(state))
    die(tr('{0} has no execution authorization; ask the user to accept a scope with authorize --confirmed-by-user', task.id))
  return true
}

function assertReauthorizedAfterContractChange(task) {
  if (!taskAuthorization(task) && task.authorizationHistory?.length)
    die(tr('{0} has no execution authorization; ask the user to accept a scope with authorize --confirmed-by-user', task.id))
}

function manualDispatchConfirmation(task, message) {
  const authorization = taskAuthorization(task)
  if (authorization?.mode !== 'manual') return null
  if (args['confirmed-by-user'] !== true) die(tr(message, task.id))
  const channel = args.channel ?? 'cli'
  if (typeof channel !== 'string' || !channel.trim()) die(tr('confirmation channel must be nonempty'))
  return { authorizationId: authorization.authorizationId, confirmedByUser: true,
    at: new Date().toISOString(), channel: channel.trim() }
}

function manualConfirmationIdentity(entry) {
  const { action, ...payload } = entry
  return JSON.stringify([action, Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))])
}

function compareManualConfirmationTime(left, right) {
  const leftAt = Date.parse(left.at), rightAt = Date.parse(right.at)
  const a = Number.isFinite(leftAt) ? leftAt : Number.POSITIVE_INFINITY
  const b = Number.isFinite(rightAt) ? rightAt : Number.POSITIVE_INFINITY
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function mergeMissingManualConfirmations(history, missing) {
  const orderedMissing = missing.map((entry, index) => ({ entry, index }))
    .sort((left, right) => compareManualConfirmationTime(left.entry, right.entry) || left.index - right.index)
    .map(item => item.entry)
  const merged = []
  let existingIndex = 0, missingIndex = 0
  while (existingIndex < history.length && missingIndex < orderedMissing.length) {
    if (compareManualConfirmationTime(orderedMissing[missingIndex], history[existingIndex]) < 0)
      merged.push(orderedMissing[missingIndex++])
    else merged.push(history[existingIndex++])
  }
  merged.push(...history.slice(existingIndex), ...orderedMissing.slice(missingIndex))
  return merged
}

function recordManualConfirmation(attempt, action, confirmation) {
  if (!attempt || !confirmation) return
  const fields = {
    dispatch: 'manualDispatchConfirmation',
    review: 'manualReviewConfirmation',
    retry: 'manualRetryConfirmation',
    resume: 'manualResumeConfirmation',
  }
  let history = Array.isArray(attempt.manualConfirmations) ? [...attempt.manualConfirmations] : []
  const seen = new Set(history.map(manualConfirmationIdentity))
  const missing = []
  for (const [legacyAction, field] of Object.entries(fields)) {
    const legacy = attempt[field]
    if (!legacy) continue
    const entry = { action: legacyAction, ...legacy }
    const identity = manualConfirmationIdentity(entry)
    if (seen.has(identity)) continue
    seen.add(identity)
    missing.push(entry)
  }
  history = mergeMissingManualConfirmations(history, missing)
  history.push({ action, ...confirmation })
  attempt.manualConfirmations = history
  attempt[fields[action]] = confirmation
}

function authorizeScope(state, scope) {
  if (scope === 'run') return Object.keys(state.tasks)
  if (typeof scope !== 'string' || !scope.includes(':')) die('authorize needs --scope run|phase:<phase>|tasks:<task,...>')
  const [kind, value, ...extra] = scope.split(':')
  if (extra.length || !value) die('authorize scope must be run, phase:<phase> or tasks:<task,...>')
  if (kind === 'phase') {
    if (!(state.plan.phases ?? []).some(phase => phase.id === value)) die(`unknown phase "${value}"`)
    return Object.values(state.tasks).filter(task => task.phase === value).map(task => task.id)
  }
  if (kind === 'tasks') {
    const ids = value.split(',').filter(Boolean)
    if (!ids.length || new Set(ids).size !== ids.length) die('tasks scope needs distinct task IDs')
    for (const id of ids) getTask(state, id)
    return ids
  }
  die('authorize scope must be run, phase:<phase> or tasks:<task,...>')
}

function executionSlots(state) {
  if (state.runPause && !state.runPause.endedAt) return 0
  const occ = occupancy(state)
  return Math.max(0, Math.min(occ.maxExec - occ.executors.length, occ.cap - occ.busy.length))
}

function actionForTask(state, task, slots) {
  if (state.runPause && !state.runPause.endedAt) return ''
  if (!['ready_for_discussion', 'ready_to_plan', 'ready'].includes(task.effective)) return ''
  if (task.effective === 'ready_for_discussion')
    return state.plan.planningMode === 'phase' ? tr('ask user to begin discussion for {0}', task.phase) :
      `begin-discussion ${task.id}; ${tr('ask user')}`
  const due = overdueQuestions(state, task.id, task.phase)
  if (task.effective === 'ready_to_plan') {
    const command = state.plan.planningMode === 'phase' ? `plan-phase ${task.phase} --agent <planner>` : `plan-task ${task.id} --agent <planner>`
    return `${command}${due.length ? `; ${tr('resolve due questions {0} in the plan decisions', due.map(item => item.ref).join(', '))}` : ''}`
  }
  if (due.length) {
    const command = state.plan.planningMode === 'phase' ? `begin-phase-discussion ${task.phase}` : `begin-discussion ${task.id}`
    return `${command}; ${tr('resolve due questions {0} before dispatch', due.map(item => item.ref).join(', '))}`
  }
  const authorization = taskAuthorization(task)
  if (!authorization) return `${tr('ask user to authorize')}: authorize --scope tasks:${task.id} --confirmed-by-user`
  if (authorization.mode === 'manual') return tr('ask user before dispatching {0}', task.id)
  if (slots > 0) return `start ${task.id} --agent <executor>`
  return tr('wait for an execution slot, then start {0}', task.id)
}

function printDispatchSuggestions(state, tasks = null) {
  if (state.runPause && !state.runPause.endedAt) return
  const d = derive(state)
  const candidates = tasks ?? Object.values(d).filter(task => ['ready_for_discussion', 'ready_to_plan', 'ready'].includes(task.effective))
  let slots = executionSlots(state)
  for (const task of candidates) {
    const current = d[task.id] ?? task
    const action = actionForTask(state, current, slots)
    if (action) log('[prumo] ' + tr('suggested action for {0}: {1}', current.id, action))
    if (current.effective === 'ready' && taskAuthorization(current)?.mode === 'auto' && slots > 0 &&
        !overdueQuestions(state, current.id, current.phase).length) slots -= 1
  }
}

/** Registra que uma revisão ou conclusão abriu capacidade de execução para trabalho pronto autorizado. */
function announceFreedSlot(name, state, freedBy, cause, slotsBefore) {
  const slots = executionSlots(state)
  if (slots <= slotsBefore) return
  const next = []
  for (const task of Object.values(derive(state))) {
    if (next.length >= slots) break
    if (task.effective === 'ready' && taskAuthorization(task)?.mode === 'auto' &&
        !overdueQuestions(state, task.id, task.phase).length) next.push(task.id)
  }
  // Sem trabalho pronto autorizado, não há nada a sinalizar; as sugestões de despacho ainda explicam o motivo.
  if (!next.length) return
  emit(name, 'slot_freed', null, { freedBy, cause, slots, next })
  log('[prumo] ' + tr('execution slot freed by {0} ({1}); authorized next: {2}', freedBy, tr(cause),
    next.map(id => `start ${id} --agent <executor>`).join(', ')))
}

function suggestedActionsByTask(state) {
  const actions = new Map()
  let slots = executionSlots(state)
  for (const task of Object.values(derive(state))) {
    const action = actionForTask(state, task, slots)
    if (action) actions.set(task.id, action)
    if (task.effective === 'ready' && taskAuthorization(task)?.mode === 'auto' && slots > 0 &&
        !overdueQuestions(state, task.id, task.phase).length) slots -= 1
  }
  return actions
}

function assertPhasePlanningOrder(state, phaseId) {
  const blockers = phasePlanningBlockers(state, phaseId)
  if (blockers.length) die(`${phaseId} waits for external dependencies: ${blockers.join(', ')}. Keep the approved phases; complete their dependency tasks first.`)
}

function phaseContext(state, phaseId, targets = phaseTargets(state, phaseId)) {
  return JSON.stringify([state.plan.name, state.plan.description, state.plan.planningRevision ?? 0, phaseId,
    targets.map(task => [task.id, phasePlanningContext(state, task)]).sort()])
}

function digestValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function contextPlanSnapshot(state) {
  return { name: state.plan.name, description: state.plan.description ?? '',
    planningRevision: state.plan.planningRevision ?? 0 }
}

function contextTaskIds(state, targets) {
  const ids = new Set()
  const visit = id => {
    if (ids.has(id)) return
    ids.add(id)
    for (const dependency of state.tasks[id]?.deps ?? []) visit(dependency)
  }
  for (const task of targets) visit(task.id)
  return [...ids].sort()
}

function taskContextDigests(state, targets, { phasePlanning = false } = {}) {
  return contextTaskIds(state, targets).map(id => {
    const task = state.tasks[id]
    if (!task) return { task: id, contextDigest: digestValue(null), inputDigest: digestValue(null), outputDigest: digestValue(null) }
    const taskDigest = phasePlanning ? phasePlanningContext(state, task) : planningContext(state, task)
    const dependencyIds = [...task.deps].sort()
    const input = dependencyIds.map(dependency => {
      const value = state.tasks[dependency]
      return phasePlanning
        ? [dependency, value ? phasePlanningContext(state, value) : null]
        : [dependency, value ? [phasePlanningContext(state, value), value.state, value.attempts, value.validations, value.skipReason] : null]
    })
    const output = [task.id, task.phase ?? null, task.title, task.deps, task.validation ?? '',
      task.validationMode, task.inspectionReason, task.requireReview, task.maxAttempts, task.tags ?? [],
      task.touches ?? [], task.unavailable]
    return { task: id, contextDigest: taskDigest, inputDigest: digestValue(input), outputDigest: digestValue(output) }
  })
}

function phaseContextSnapshot(state, targets) {
  return { plan: contextPlanSnapshot(state), tasks: taskContextDigests(state, targets, { phasePlanning: true }) }
}

function taskContextSnapshot(state, task) {
  return { plan: contextPlanSnapshot(state), tasks: taskContextDigests(state, [task]) }
}

function phaseContractDigests(state, targets) {
  return targets.map(task => ({ task: task.id, digest: phasePlanningContext(state, task) }))
    .sort((left, right) => left.task.localeCompare(right.task))
}

function latestPlanSyncAuditAt(name) {
  try {
    const lines = readFileSync(join(runDir(name), 'events.ndjson'), 'utf8').trim().split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index--) {
      const event = JSON.parse(lines[index])
      if (event.type === 'plan_sync_audit' && typeof event.at === 'string') return event.at
    }
  } catch { /* uma execução antiga ou incompleta ainda pode não ter log de eventos */ }
  return null
}

/** Campos do contrato que sync-plan alterou por tarefa desde a abertura de uma rodada, lidos do log de eventos. */
function syncChangedFieldsSince(name, since) {
  const fields = new Map()
  if (typeof since !== 'string') return fields
  try {
    for (const line of readFileSync(join(runDir(name), 'events.ndjson'), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (event.type !== 'plan_sync' || typeof event.at !== 'string' || event.at < since) continue
      for (const change of event.changes ?? []) {
        if (change?.applied === false || typeof change?.task !== 'string') continue
        const names = fields.get(change.task) ?? new Set()
        for (const item of change.fields ?? []) if (typeof item?.field === 'string') names.add(item.field)
        if (names.size) fields.set(change.task, names)
      }
    }
  } catch { /* uma execução antiga ou incompleta ainda pode não ter log de eventos */ }
  return fields
}

function staleReason(name, round, currentSnapshot, currentContext) {
  const saved = round?.contextSnapshot
  const changes = []
  if (saved?.plan && currentSnapshot?.plan) {
    for (const field of ['name', 'description', 'planningRevision']) {
      if (JSON.stringify(saved.plan[field]) !== JSON.stringify(currentSnapshot.plan[field]))
        changes.push(tr('plan {0} changed', field))
    }
    const previous = new Map((saved.tasks ?? []).map(task => [task.task, task]))
    const current = new Map(currentSnapshot.tasks.map(task => [task.task, task]))
    const synced = syncChangedFieldsSince(name, round?.startedAt ?? round?.at)
    for (const id of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
      const before = previous.get(id), after = current.get(id)
      if (!before || !after) {
        changes.push(tr('task {0} entered or left the current context', displayIdentifier(id)))
        continue
      }
      let changedDigest = false
      for (const field of ['contextDigest', 'inputDigest', 'outputDigest']) {
        if (before[field] !== after[field]) {
          changedDigest = true
          changes.push(tr('task {0} {1} digest changed ({2} → {3})', displayIdentifier(id), field,
            String(before[field] ?? 'missing').slice(0, 12), String(after[field]).slice(0, 12)))
        }
      }
      const fields = synced.get(displayIdentifier(id))
      if (changedDigest && fields?.size)
        changes.push(tr('task {0} contract fields changed by sync-plan: {1}', displayIdentifier(id), [...fields].join(', ')))
    }
  }
  if (!changes.length && round?.context !== currentContext)
    changes.push(tr('saved context digest {0} differs from current digest {1}',
      String(round?.context ?? 'missing').slice(0, 12), String(currentContext).slice(0, 12)))
  if (!changes.length && round?.context === currentContext)
    changes.push(tr('discussion decision or attempt binding changed'))
  const auditAt = latestPlanSyncAuditAt(name)
  if (auditAt) changes.push(tr('last plan_sync_audit: {0}', auditAt))
  return changes.join('; ')
}

function logSupersededRounds(owner, superseded) {
  for (const item of superseded)
    log('[prumo] ' + tr(item.workflow === 'planning' ? 'previous planning round {0} of {1} closed as superseded: {2}' :
      'previous discussion round {0} of {1} closed as superseded: {2}', item.roundId ?? item.round ?? '?', owner, item.cause))
}

function currentPhasePlanningSkip(state, phase) {
  const decision = phase?.planningSkips?.at(-1)
  if (decision?.decision !== 'skipped' || decision.confirmedByUser !== true) return null
  const targets = decision.targets?.map(id => state.tasks[id]).filter(Boolean)
  return targets?.length === decision.targets.length &&
    decision.context === phaseContext(state, phase.id, targets) ? decision : null
}

function invalidatedSyncWorkflows(name, before, after) {
  const result = []
  const record = (scope, workflow, id, round, contextSnapshot, currentSnapshot, currentContext, task) => {
    const cause = staleReason(name, { ...round, context: round?.context ?? round?.scope, contextSnapshot }, currentSnapshot, currentContext)
    result.push({ scope, workflow, id, ...(task ? { task } : {}),
      ...(round?.roundId ? { roundId: round.roundId } : {}),
      ...(round?.decisionId ? { decisionId: round.decisionId } : {}), cause })
  }

  for (const [phaseId, oldPhase] of Object.entries(before.phaseWorkflows ?? {})) {
    const phase = after.phaseWorkflows?.[phaseId]
    if (!phase) continue
    const discussion = oldPhase.discussionAttempts?.at(-1)
    const currentDiscussionTargets = phaseDiscussionTargets(after, phaseId, discussion)
    const currentDiscussionTargetIds = currentDiscussionTargets.map(task => task.id).sort()
    const openedDiscussionTargetIds = [...(discussion?.targets ?? [])].sort()
    if (discussion && !discussion.endedAt && (discussion.context !== phaseContext(after, phaseId,
        (discussion.targets ?? []).map(id => after.tasks[id]).filter(Boolean)) ||
        JSON.stringify(openedDiscussionTargetIds) !== JSON.stringify(currentDiscussionTargetIds))) {
      record('phase', 'discussion', phaseId, discussion, discussion.contextSnapshot,
        phaseContextSnapshot(after, currentDiscussionTargets),
        phaseContext(after, phaseId, currentDiscussionTargets))
    }
    const planning = oldPhase.planningAttempts?.at(-1)
    if (planning && !planning.endedAt && !currentPhasePlanning(after, phase, planning)) {
      const targets = (planning.contextTargets ?? planning.targets ?? []).map(id => after.tasks[id]).filter(Boolean)
      record('phase', 'planning', phaseId, planning, planning.contextSnapshot,
        phaseContextSnapshot(after, targets), phaseContext(after, phaseId, targets))
    }
    const completedDiscussion = currentPhaseDiscussionDecision(before, oldPhase)
    if (completedDiscussion?.kind === 'discussed' && !currentPhaseDiscussionDecision(after, phase)) {
      const targets = completedDiscussion.targets.map(id => after.tasks[id]).filter(Boolean)
      record('phase', 'discussion', phaseId, oldPhase.discussionAttempts?.find(round => round.roundId === completedDiscussion.id),
        oldPhase.discussionAttempts?.find(round => round.roundId === completedDiscussion.id)?.contextSnapshot,
        phaseContextSnapshot(after, targets), phaseContext(after, phaseId, targets))
    }
    const discussionSkip = currentPhaseDiscussionSkip(before, oldPhase)
    if (discussionSkip && !currentPhaseDiscussionSkip(after, phase)) {
      const targets = discussionSkip.targets.map(id => after.tasks[id]).filter(Boolean)
      record('phase', 'discussion skip', phaseId, discussionSkip, discussionSkip.contextSnapshot,
        phaseContextSnapshot(after, targets), phaseContext(after, phaseId, targets))
    }
    const planningSkip = currentPhasePlanningSkip(before, oldPhase)
    if (planningSkip && !currentPhasePlanningSkip(after, phase)) {
      const targets = planningSkip.targets.map(id => after.tasks[id]).filter(Boolean)
      record('phase', 'planning skip', phaseId, planningSkip, planningSkip.contextSnapshot,
        phaseContextSnapshot(after, targets), phaseContext(after, phaseId, targets))
    }
  }

  for (const [id, oldTask] of Object.entries(before.tasks)) {
    const task = after.tasks[id]
    const discussion = oldTask.discussionAttempts?.at(-1)
    if (discussion && !discussion.endedAt && discussion.context !== planningContext(after, task))
      record('task', 'discussion', id, discussion, discussion.contextSnapshot,
        taskContextSnapshot(after, task), planningContext(after, task), id)
    const completedDiscussion = currentTaskDiscussionDecision(before, oldTask)
    if (completedDiscussion?.kind === 'discussed' && !currentTaskDiscussionDecision(after, task)) {
      const round = oldTask.discussionAttempts?.find(item => item.roundId === completedDiscussion.id)
      record('task', 'discussion', id, round, round?.contextSnapshot,
        taskContextSnapshot(after, task), planningContext(after, task), id)
    }
    const planning = oldTask.planningAttempts?.at(-1)
    if (planning && !planning.endedAt && planning.context !== planningContext(after, task))
      record('task', 'planning', id, planning, planning.contextSnapshot,
        taskContextSnapshot(after, task), planningContext(after, task), id)
    const discussionSkip = currentTaskDiscussionSkip(before, oldTask)
    if (discussionSkip && !currentTaskDiscussionSkip(after, task))
      record('task', 'discussion skip', id, discussionSkip, discussionSkip.contextSnapshot,
        taskContextSnapshot(after, task), planningContext(after, task), id)
    const planningSkip = currentPlanningSkip(before, oldTask)
    if (planningSkip && !currentPlanningSkip(after, task))
      record('task', 'planning skip', id, planningSkip, planningSkip.contextSnapshot,
        taskContextSnapshot(after, task), planningContext(after, task), id)
  }
  return result
}

// Alterar a descrição invalida decisões concluídas; a pessoa deve conhecer o alcance antes de confirmar.
function completedDescriptionInvalidations(before, after, invalidated) {
  if ((before.plan.description ?? '') === after.plan.description) return []
  const result = invalidated.filter(item => item.workflow === 'discussion' &&
    (item.scope === 'phase' ? before.phaseWorkflows[item.id] : before.tasks[item.task])
      .discussionAttempts.some(round => round.roundId === item.roundId && round.endedAt && round.result === 'discussed'))
    .map(item => item.scope === 'phase' ? { ...item, tasks: before.phaseWorkflows[item.id].discussionAttempts
      .find(round => round.roundId === item.roundId).targets } : item)
  for (const [id, phase] of Object.entries(before.phaseWorkflows ?? {})) {
    const round = phase.planningAttempts?.at(-1)
    if (round?.endedAt && round.result === 'planned' &&
        round.context === phaseContext(before, id, (round.contextTargets ?? round.targets).map(task => before.tasks[task])) &&
        round.context !== phaseContext(after, id, (round.contextTargets ?? round.targets).map(task => after.tasks[task])))
      result.push({ scope: 'phase', id, workflow: 'planning', tasks: round.targets })
  }
  for (const [id, task] of Object.entries(before.tasks)) {
    if (task.taskPlan && hasCurrentTaskPlan(before, task) && !hasCurrentTaskPlan(after, after.tasks[id]))
      result.push({ scope: 'task', id, task: id, workflow: 'planning' })
  }
  return result
}

function currentPhaseDiscussion(state, phase) {
  const round = phase?.discussionAttempts?.at(-1)
  const targets = round?.targets?.map(id => state.tasks[id]).filter(Boolean)
  const covered = new Set(round?.targets ?? [])
  return round?.result === 'discussed' && targets?.length === round.targets.length &&
    phaseTargets(state, phase.id).every(task => covered.has(task.id)) &&
    round.context === phaseContext(state, phase.id, targets) && phase.discovery?.context === round.context &&
    phase.discovery?.roundId === round.roundId &&
    phase.discovery?.nonce === round.nonce && phase.discovery?.digest === round.discoveryDigest &&
    phase.discovery.digest === discoveryDigest(phase.discovery)
}

function currentPhaseDiscussionSkip(state, phase) {
  const decision = phase?.discussionSkips?.at(-1)
  if (decision?.decision !== 'skipped' || decision.confirmedByUser !== true) return null
  const targets = decision.targets?.map(id => state.tasks[id]).filter(Boolean)
  const covered = new Set(decision.targets ?? [])
  return targets?.length === decision.targets.length &&
    phaseTargets(state, phase.id).every(task => covered.has(task.id)) &&
    decision.context === phaseContext(state, phase.id, targets) ? decision : null
}

function currentPhaseDiscussionDecision(state, phase) {
  const round = currentPhaseDiscussion(state, phase) ? phase.discussionAttempts.at(-1) : null
  const skipped = currentPhaseDiscussionSkip(state, phase)
  const discussionAt = round?.endedAt ?? ''
  if (round && (!skipped || discussionAt > skipped.at)) return {
    kind: 'discussed', id: round.roundId, digest: phase.discovery.digest, targets: round.targets,
  }
  if (skipped) return {
    kind: 'skipped', id: skipped.decisionId, digest: skipped.digest, targets: skipped.targets,
  }
  return null
}

function logPhasePlanningInputs(phaseId, round) {
  const binding = { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n }
  for (const id of round.activeTargets ?? round.targets) {
    log(tr('Copy these fields into task-plan-{0}.json:', id))
    log('```json')
    log(JSON.stringify({ phaseBinding: binding, unresolvedInputs: round.requiredInputs?.[id] ?? [] }, null, 2))
    log('```')
  }
}

function phaseAssignments(targets, specification, role) {
  const values = Array.isArray(specification) ? specification : [specification ?? role]
  let entries
  if (values.length === 1 && !values[0].includes('=')) {
    if (!values[0].trim()) die('phase agents require a nonempty name')
    entries = targets.map(task => [task.id, `${values[0]}:${task.id}`])
  }
  else entries = values.map(value => {
    const separator = value.indexOf('=')
    const id = value.slice(0, separator), agent = value.slice(separator + 1).trim()
    if (separator < 1 || !agent || !targets.some(task => task.id === id)) die('phase agent assignments must use a target task=agent')
    return [id, agent]
  })
  if (new Set(entries.map(([id]) => id)).size !== targets.length || entries.length !== targets.length)
    die('phase agent assignments must cover every target exactly once')
  if (new Set(entries.map(([, agent]) => agent)).size !== entries.length) die('phase agents must have distinct names')
  return Object.fromEntries(entries)
}

function activatePhaseWorkers(state, round, role) {
  round.workers ??= {}
  let slots = Math.max(0, occupancy(state).cap - occupancy(state).busy.length)
  round.activeTargets = Object.entries(round.workers).filter(([, worker]) => !worker.endedAt).map(([id]) => id)
  while (slots > 0 && round.queuedTargets.length) {
    const id = round.queuedTargets[0], agent = round.assignments[id]
    if (agentBusy(state, agent)) die(`agent "${agent}" is already busy`)
    round.queuedTargets.shift()
    Object.defineProperty(round.workers, id, { value: { agent, role, startedAt: new Date().toISOString(), activityTiming: 'explicit', activityIntervals: [] }, enumerable: true, writable: true, configurable: true })
    round.activeTargets.push(id)
    slots--
  }
}

function finishPhaseWorkers(round, at) {
  for (const id of round.activeTargets ?? []) {
    const worker = round.workers[id]
    stopOpenActivity(worker, at)
    worker.endedAt = at
  }
  round.activeTargets = []
}

function phaseActivityWorker(state, id, scope, role, agent) {
  if (!['discussion', 'planning'].includes(role)) return null
  if (scope === 'task' && state.tasks[id]?.individualPlanning) return null
  const phase = scope === 'phase' ? state.phaseWorkflows?.[id] : state.phaseWorkflows?.[state.tasks[id]?.phase]
  const round = phase?.[`${role}Attempts`]?.at(-1)
  if (!round?.workers) return null
  const worker = scope === 'phase' ? Object.values(round.workers).find(value => value.agent === agent && !value.endedAt) : Object.hasOwn(round.workers, id) ? round.workers[id] : null
  if (!worker || worker.endedAt || phase.state !== (role === 'discussion' ? 'discussing' : 'planning'))
    die('activity requires a currently assigned phase worker')
  return worker
}

function logPhaseWorkers(phaseId, round) {
  log('[prumo] ' + tr('{0} of {1} targets active; waiting for a slot: {2}',
    round.activeTargets?.length ?? 0, round.targets.length, round.queuedTargets?.join(', ') || '—'))
  for (const id of round.activeTargets ?? []) log(`[prumo] ${phaseId} ${id}: ${round.workers[id].agent}`)
}

function currentTaskDiscussionSkip(state, task) {
  const decision = task.discussionSkips?.at(-1)
  return decision?.decision === 'skipped' && decision.confirmedByUser === true &&
    decision.scope === phasePlanningContext(state, task) ? decision : null
}

function currentTaskDiscussionDecision(state, task) {
  const round = currentDiscussion(state, task) ? task.discussionAttempts.at(-1) : null
  const skipped = currentTaskDiscussionSkip(state, task)
  if (round && (!skipped || (round.endedAt ?? '') > skipped.at)) return {
    kind: 'discussed', id: round.roundId, digest: task.discovery.digest,
  }
  return skipped ? { kind: 'skipped', id: skipped.decisionId, digest: skipped.digest } : null
}

function explicitSkipDecision(scope) {
  const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() :
    die(`${scope} needs --reason <text>`)
  if (args['confirmed-by-user'] !== true)
    die(`${scope} needs --confirmed-by-user after the user explicitly chooses to skip`)
  const decisionId = randomUUID(), at = new Date().toISOString()
  return { decision: 'skipped', decisionId, digest: decisionId, reason, confirmedByUser: true, at }
}

function currentPhasePlanning(state, phase, round = phase?.planningAttempts?.at(-1)) {
  if (!round || round.endedAt || !Array.isArray(round.targets)) return false
  const discussion = currentPhaseDiscussionDecision(state, phase)
  const targets = round.targets.map(id => state.tasks[id]).filter(Boolean)
  const liveTargets = phaseTargets(state, phase.id).map(task => task.id).sort()
  return discussion?.id === round.discussionRoundId && discussion.digest === (round.discussionDigest ?? round.discoveryDigest) &&
    targets.length === round.targets.length &&
    JSON.stringify([...round.targets].sort()) === JSON.stringify(liveTargets) &&
    round.context === phaseContext(state, phase.id, discussion.targets.map(id => state.tasks[id]))
}

function assertCurrentTaskScope(state, task) {
  if (!hasCurrentTaskScope(state, task))
    die(task.id + ' execution scope needs current planning — keep work blocked, run plan-task and finish-planning, then unblock explicitly')
}

function assertCurrentExecutionInputs(state, task) {
  if (!task.attempts?.length) return
  const blockedBy = (task.deps ?? []).filter(id => !['done', 'skipped'].includes(state.tasks[id]?.state))
  if (blockedBy.length) die(task.id + ' still waiting on: ' + blockedBy.join(', '))
  if (!task.taskPlan?.phaseId && !currentPlanningSkip(state, task)) return
  let receipt
  try { receipt = executionInputReceipt(state, task) } catch (error) { die(error.message) }
  if (task.attempts.at(-1).inputDigest !== receipt.digest)
    die(task.id + ' dependency input receipt changed after execution started')
}

/** Visão derivada: estado efetivo por tarefa (ready é calculado, nunca armazenado). */
export function derive(state) {
  const out = {}
  const migrationPending = !['phase', 'task'].includes(state.plan?.planningMode)
  for (const [id, t] of Object.entries(state.tasks)) {
    let effective = isReadyForReview(t, state.plan) ? 'ready_for_review' : t.state
    let blockedBy = []
    let planningBlockedBy = []
    const phase = state.phaseWorkflows?.[t.phase]
    if (t.state === 'pending') {
      blockedBy = t.deps.filter((d) => {
        const dep = state.tasks[d]
        return !dep || (dep.state !== 'done' && dep.state !== 'skipped')
      })
      const phaseAdopted = !(state.legacyPhaseAdoption && !state.phaseWorkflows?.[t.phase]?.adoptedLegacy)
      if (!usesCurrentPlanning(state, t)) {
        effective = blockedBy.length ? 'waiting' : 'ready'
      } else if (state.plan.planningMode === 'phase' && !t.individualPlanning) {
        planningBlockedBy = phasePlanningBlockers(state, t.phase)
        const discussionRound = phase?.discussionAttempts?.at(-1)
        const phaseDiscussing = phase?.state === 'discussing' && !discussionRound?.endedAt &&
          (discussionRound?.activeTargets ?? discussionRound?.targets)?.includes(t.id)
        const planningRound = phase?.planningAttempts?.at(-1)
        const phasePlanning = phase?.state === 'planning' && currentPhasePlanning(state, phase, planningRound) &&
          (planningRound.activeTargets ?? planningRound.targets).includes(t.id)
        effective = !phaseAdopted ? 'pending' : phaseDiscussing ? 'discussing' : hasCurrentTaskPlan(state, t) ?
          (blockedBy.length ? 'waiting' : 'ready') : phasePlanning ? 'planning' : planningBlockedBy.length ? 'waiting' :
            (currentPhaseDiscussionDecision(state, phase) ? 'ready_to_plan' : 'ready_for_discussion')
      } else {
        effective = blockedBy.length ? 'waiting' : !phaseAdopted ? 'pending' :
          hasCurrentTaskPlan(state, t) ? 'ready' :
            t.discussionRequired && !currentTaskDiscussionDecision(state, t) ? 'ready_for_discussion' : 'ready_to_plan'
      }
    }
    const planningStatus = !usesCurrentPlanning(state, t) ? 'legacy_lifecycle' :
      state.legacyPhaseAdoption && !phase?.adoptedLegacy ? 'awaiting_phase_adoption' : currentPlanningSkip(state, t) ? 'planning_skipped' :
      hasCurrentTaskPlan(state, t) ? 'planned' :
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
    out[id] = { ...t, effective, blockedBy, ...(manualInspectionPending(state, t) ? { manualInspectionPending: true } : {}), ...(showPlanningStatus ?
      { planningStatus, ...(planningBlockedBy.length ? { planningBlockedBy } : {}), ...(inputStatus ? { inputStatus } : {}) } : {}) }
    const agentRound = phase?.[phase.state === 'discussing' ? 'discussionAttempts' : 'planningAttempts']?.at(-1)
    const worker = Object.hasOwn(agentRound?.workers ?? {}, id) ? agentRound.workers[id] : null
    if (worker && !worker.endedAt && ['planning', 'discussing'].includes(effective)) out[id].activeAgent = worker.agent
    if (t.state === 'discussing' && t.discussionAttempts?.at(-1)?.agent) out[id].activeAgent = t.discussionAttempts.at(-1).agent
    if (t.state === 'pending' && agentRound?.queuedTargets?.includes(id)) Object.assign(out[id], { effective: 'waiting', agentQueued: true })
    if (t.state === 'pending' && worker?.endedAt && !agentRound.endedAt && ['planning', 'discussing'].includes(phase.state))
      Object.assign(out[id], { effective: 'waiting', phaseBatchPending: true })
    if (migrationPending && t.state === 'pending' && usesCurrentPlanning(state, t))
      Object.assign(out[id], { effective: 'pending', planningStatus: 'awaiting_migration' })
  }
  for (const task of Object.values(out)) task.executionReadiness = executionReadiness(state, task, task)
  return out
}

/** Quem está ocupado agora, separado por papel — o limite é imposto por papel, não em bloco. */


/** Um nome de agente pode manter somente uma tarefa por vez, qualquer que seja o papel. */
function recordConcurrentScopes(state, task, resume = false) {
  const scopes = resume ? [...(task.attempts.at(-1)?.concurrentScopes ?? [])] : []
  if (state.plan.scopePolicy === 'explicit') for (const other of Object.values(state.tasks).filter(other => other.id !== task.id && ['running', 'reviewing'].includes(other.state) && sameProject(task, other, state.plan.cwd))) {
    scopes.push(other.touches)
    other.attempts.at(-1).concurrentScopes ??= []
    other.attempts.at(-1).concurrentScopes.push(task.touches)
  }
  return scopes
}

function agentBusy(state, agent) {
  return occupancy(state).busy.find((t) => (t.state === 'reviewing' ? t.reviewer : t.state === 'planning' ? t.planner : t.agent) === agent)
}

// Iniciar e retomar adquirem uma vaga; uma tarefa pausada não possui mais uma.
function assertAvailable(state, task, role, agent) {
  if (typeof agent !== 'string' || !agent.trim()) die('active work needs a recorded agent')
  const blockedBy = task.deps.filter((id) => !['done', 'skipped'].includes(state.tasks[id]?.state))
  if (blockedBy.length) die(task.id + ' still waiting on: ' + blockedBy.join(', '))
  const occ = occupancy(state)
  if (role === 'running' && state.plan.scopePolicy === 'explicit') {
    if (!task.writeScope || task.writeScope === 'unknown') die('Write scope must be resolved before execution')
    for (const other of occ.busy.filter(other => other.id !== task.id && other.touches)) {
      const conflict = scopeConflicts(task, other, state.plan.cwd)
      if (conflict.paths.length || conflict.resources.length) die(`Execution scope conflicts with ${other.id}: ${[...conflict.paths, ...conflict.resources].join(', ')}`)
    }
  }
  if (role === 'running' && occ.executors.length >= occ.maxExec)
    die(occ.executors.length + ' executors already running (max ' + occ.maxExec + ')')
  // A revisão substitui o executor na vaga atual, mesmo após reduzir o limite.
  const reviewHandoff = role === 'reviewing' && task.state === 'running'
  if (occ.busy.filter(t => t.id !== task.id).length >= occ.cap && !reviewHandoff)
    die(occ.busy.length + ' agents busy (cap ' + occ.cap + ')')
  const busy = agentBusy(state, agent)
  if (busy && busy.id !== task.id)
    die('agent "' + agent + '" is already on ' + busy.id + ' — one agent per task')
}

function progress(state) {
  const total = Object.keys(state.tasks).length
  const by = {}
  for (const t of Object.values(derive(state))) by[t.effective] = (by[t.effective] ?? 0) + 1
  return { total, done: by.done ?? 0, by }
}

// ---------- comandos ----------
const commands = {
  init() {
    const planPath = args.plan ?? die('init needs --plan <plan.json>')
    const name = args.run ?? process.env.PRUMO_RUN ?? (existsSync(CURRENT_FILE) ? readFileSync(CURRENT_FILE, 'utf8').trim() : undefined)
    const { plan, source } = readPlan(planPath)
    const cwd = projectCwd()
    warnPlanTouchPaths(plan, cwd)
    const dir = runDir(name)
    if (existsSync(join(dir, 'state.json')) && !args.force)
      die(`run "${name}" already exists (use --force to overwrite)`)
    mkdirSync(dir, { recursive: true })
    const state = {
      schemaVersion: STATE_SCHEMA_VERSION,
      run: name,
      plan: {
        name: plan.name,
        description: plan.description ?? '',
        phases: plan.phases ?? [],
        maxParallel: plan.maxParallel ?? DEFAULT_MAX_PARALLEL,
        maxExecutors: plan.maxExecutors ?? DEFAULT_MAX_EXECUTORS,
        maxAgents: plan.maxAgents ?? 3,
        requireReview: plan.requireReview !== false,
        planningMode: plan.planningMode ?? ((plan.phases?.length ?? 0) ? 'phase' : 'task'),
        ...(plan.scopePolicy === undefined ? {} : { scopePolicy: plan.scopePolicy }),
        ...(plan.rolePreferences === undefined ? {} : { rolePreferences: structuredClone(plan.rolePreferences) }),
        source,
        ...(cwd ? { cwd } : {}),
      },
      createdAt: new Date().toISOString(),
      authorizations: [],
      tasks: {},
    }
    for (const t of plan.tasks) state.tasks[t.id] = taskFromPlan(t)
    if (state.plan.planningMode === 'phase') state.phaseWorkflows = Object.fromEntries(
      state.plan.phases.map(phase => [phase.id, { id: phase.id, title: phase.title, state: 'pending',
        discussionAttempts: [], planningAttempts: [], planningHistory: [] }]),
    )
    writeFileSync(join(dir, 'events.ndjson'), '')
    saveState(name, state)
    writeFileSync(CURRENT_FILE, name)
    emit(name, 'run_init', null, { plan: plan.name, tasks: plan.tasks.length })
    log(
      `[prumo] run "${name}" initialised: ${plan.tasks.length} tasks, ` +
        `${state.plan.maxAgents} agents shared by all roles` +
        `${state.plan.requireReview ? ', review REQUIRED before done' : ''} — set as CURRENT`,
    )
  },

  migrate() {
    return migrateState(runName(), { check: args.check === true })
  },

  'sync-plan'() {
    const name = runName()
    const state = loadState(name)
    const storedSource = state.plan.source
    let planPath = args.plan
    if (planPath == null) {
      const centralSource = storedSource ? join(GRAPH_DIR, 'plans', basename(storedSource)) :
        join(GRAPH_DIR, 'plans', `${safeId(state.plan.name, 'plan')}.plan.json`)
      planPath = storedSource && existsSync(storedSource) ? storedSource :
        existsSync(centralSource) ? centralSource : die('sync-plan needs --plan <plan.json> once')
    }
    const { plan, source } = readPlan(planPath, state)
    const cwd = projectCwd(state.plan.cwd)
    warnPlanTouchPaths(plan, cwd)
    const removed = Object.keys(state.tasks).filter((id) => !plan.tasks.some((t) => t.id === id))
    if (removed.length) die(`sync-plan is additive: plan removed ${removed.join(', ')}`)
    const missingSummaries = plan.tasks.filter(task => !Object.hasOwn(state.tasks, task.id) && task.summary === undefined)
    if (missingSummaries.length) die(tr(
      'new tasks require summary before sync-plan: {0}; fill the expected result and its purpose from the approved scope, then run sync-plan again',
      missingSummaries.map(task => displayIdentifier(task.id)).join(', ')))

    const contractFields = TASK_CONTRACT_FIELDS
    const beforeState = hydrateDiscoveries(structuredClone(state), runDir(name))
    const persistedTasks = hydrateDiscoveries({ tasks: structuredClone(state.tasks) }, runDir(name)).tasks
    const added = []
    const updated = []
    const metadataUpdated = []
    const preserved = []
    const changes = []
    for (const planTask of plan.tasks) {
      const current = state.tasks[planTask.id]
      if (!current) {
        state.tasks[planTask.id] = taskFromPlan(planTask)
        added.push(planTask.id)
        continue
      }
      const next = taskFromPlan(planTask)
      const metadataChanges = ['label', 'summary', 'validationSummary', 'manualEstimate'].filter(
        field => JSON.stringify(current[field]) !== JSON.stringify(next[field]))
      for (const field of metadataChanges) {
        if (next[field] === undefined) delete current[field]
        else current[field] = next[field]
      }
      if (metadataChanges.length) metadataUpdated.push(planTask.id)
      const changed = contractFields.filter(
        (field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]),
      )
      if (!changed.length) continue
      const fields = contractChanges(current, next, contractFields)
      if (['done', 'skipped'].includes(current.state)) {
        preserved.push(planTask.id)
        changes.push({ task: planTask.id, applied: false, preserved: true, fields })
        continue
      }
      for (const field of changed) current[field] = next[field]
      if (current.executionAuthorization) {
        current.authorizationHistory ??= []
        current.authorizationHistory.push({ ...current.executionAuthorization, revokedAt: new Date().toISOString(),
          revokeReason: 'sync-plan changed this task contract' })
        delete current.executionAuthorization
      }
      if (current.planningRequired) current.planningRevision = (current.planningRevision ?? 0) + 1
      if (changed.some(field => !['validation', 'validationMode', 'inspectionReason'].includes(field)))
        current.scopeRevision = (current.scopeRevision ?? 0) + 1
      if (changed.some((field) => ['validation', 'validationMode', 'inspectionReason'].includes(field)))
        current.contractRevision = (current.contractRevision ?? 0) + 1
      updated.push(planTask.id)
      changes.push({ task: planTask.id, applied: true, preserved: false, fields })
    }

    const effectiveTasks = derive({ ...state, tasks: persistedTasks })
    const diagnostics = auditSyncPlan({ stateTasks: persistedTasks, planTasks: plan.tasks, added, effectiveTasks })

    // O modo existente governa a sincronização; o arquivo não pode enfraquecer suas regras de fase.
    const effectivePlan = { ...plan, scopePolicy: plan.scopePolicy ?? state.plan.scopePolicy, planningMode: state.plan.planningMode ?? 'task', tasks: Object.values(state.tasks).map(planTaskFromState) }
    validatePlan(effectivePlan, args['allow-overlap'] === true, historicalTasks(state), cwd)
    const nextPlan = {
      name: plan.name,
      description: plan.description ?? '',
      phases: plan.phases ?? [],
      maxParallel: plan.maxParallel ?? DEFAULT_MAX_PARALLEL,
      maxExecutors: plan.maxExecutors ?? DEFAULT_MAX_EXECUTORS,
      maxAgents: state.plan.maxAgents ?? 3,
      requireReview: plan.requireReview !== false,
      ...(state.plan.planningMode ? { planningMode: state.plan.planningMode } : {}),
      ...((plan.scopePolicy ?? state.plan.scopePolicy) === undefined ? {} : { scopePolicy: plan.scopePolicy ?? state.plan.scopePolicy }),
      ...((plan.rolePreferences ?? state.plan.rolePreferences) === undefined ? {} : { rolePreferences: structuredClone(plan.rolePreferences ?? state.plan.rolePreferences) }),
      source,
      ...(cwd ? { cwd } : {}),
    }
    const planningChanged = ['name', 'description', 'requireReview', 'scopePolicy'].some(field => state.plan[field] !== nextPlan[field])
    const changedPlanFields = GLOBAL_PLAN_FIELDS.filter(field =>
      JSON.stringify(globalPlanValues(state.plan)[field]) !== JSON.stringify(globalPlanValues(nextPlan)[field]))
    if (state.plan.planningRevision || planningChanged)
      nextPlan.planningRevision = (state.plan.planningRevision ?? 0) + (planningChanged ? 1 : 0)
    const planChanged = JSON.stringify(state.plan) !== JSON.stringify(nextPlan)
    const preview = { ...state, plan: nextPlan }
    const invalidatedWorkflows = invalidatedSyncWorkflows(name, beforeState, preview)
    diagnostics.invalidatedWorkflows = invalidatedWorkflows
    const completed = completedDescriptionInvalidations(beforeState, preview, invalidatedWorkflows)
    for (const item of completed)
      log('[prumo] ' + tr(item.workflow === 'discussion'
        ? 'sync-plan description change invalidates completed discussion for {0} {1}; tasks: {2}'
        : 'sync-plan description change invalidates completed planning for {0} {1}; tasks: {2}',
        tr(item.scope), displayIdentifier(item.id),
        (item.tasks ?? [item.id]).map(displayIdentifier).join(', ')))
    if (args['dry-run']) {
      printSyncPlanAudit(changes, diagnostics)
      log('[prumo] ' + tr('sync-plan dry-run: no changes written; added {0}, updated {1}, metadata {2}',
        added.length, updated.length, metadataUpdated.length))
      return
    }
    if (completed.length && !args['confirm-invalidation'])
      die(tr('sync-plan requires --confirm-invalidation to invalidate completed rounds after a description change; inspect --dry-run first'))
    // Migração só persiste após a confirmação; a nova leitura preserva o comportamento dos contratos históricos.
    const migration = migrationStatus(beforeState)
    if (migration.needed && (beforeState.schemaVersion !== STATE_SCHEMA_VERSION || migration.structural) && migration.blockers.length) {
      errorLog('[prumo] Migration deferred: resolve unsafe in-flight planning before starting new work')
      errorLog('[prumo] Migration blockers: ' + migration.blockers.join('; '))
    }
    if (migration.needed && (beforeState.schemaVersion !== STATE_SCHEMA_VERSION || migration.structural) && !migration.blockers.length) {
      migrateState(name, { quiet: true })
      return commands['sync-plan']()
    }
    if (!added.length && !updated.length && !metadataUpdated.length && !planChanged) {
      const hasDiagnostics = diagnostics.blockReasonContradictions.length || diagnostics.newLeaves.length ||
        diagnostics.preDiscussionFunctionalContracts.length
      if (hasDiagnostics || changes.length) {
        emit(name, 'plan_sync_audit', null, {
          added: sanitizeTaskIds(added),
          updated: sanitizeTaskIds(updated),
          metadataUpdated: sanitizeTaskIds(metadataUpdated),
          preserved: sanitizeTaskIds(preserved),
          changes: sanitizeChanges(changes),
          diagnostics: sanitizeDiagnostics(diagnostics),
          tasks: Object.keys(state.tasks).length,
        })
        printSyncPlanAudit(changes, diagnostics)
      }
      if (preserved.length)
        log('[prumo] ' + tr('no state changes; plan differs for preserved tasks: {0}. Create a follow-up task; do not rewrite completed history.', preserved.map(displayIdentifier).join(', ')))
      else log(`[prumo] run "${name}" already matches plan (${Object.keys(state.tasks).length} tasks)`)
      return
    }

    copyFileSync(join(runDir(name), 'state.json'), join(runDir(name), 'state.pre-sync.json'))
    state.plan = nextPlan
    if (state.plan.planningMode === 'phase') {
      state.phaseWorkflows ??= {}
      for (const phase of state.plan.phases) state.phaseWorkflows[phase.id] ??=
        { id: phase.id, title: phase.title, state: 'pending', discussionAttempts: [], planningAttempts: [], planningHistory: [] }
    }

    const historyTaskIds = new Set([...updated, ...added])
    if (changedPlanFields.length)
      for (const task of Object.values(state.tasks))
        if (!['done', 'skipped'].includes(task.state)) historyTaskIds.add(task.id)
    const historyAt = new Date().toISOString()
    for (const id of historyTaskIds) {
      const task = state.tasks[id]
      const previous = beforeState.tasks[id]
      const taskFields = changes.find(change => change.task === id && change.applied)?.fields.map(change => change.field) ??
        (added.includes(id) ? ['task'] : [])
      task.contractHistory ??= []
      task.contractHistory.push({ at: historyAt, source,
        fields: [...new Set([...taskFields, ...changedPlanFields.map(field => `plan.${field}`)])],
        before: previous ? businessContract(beforeState.plan, previous) : null,
        after: businessContract(state.plan, task) })
      if (task.contractHistory.length > 20) task.contractHistory.splice(0, task.contractHistory.length - 20)
      if (changedPlanFields.length && task.executionAuthorization) {
        task.authorizationHistory ??= []
        task.authorizationHistory.push({ ...task.executionAuthorization, revokedAt: historyAt,
          revokeReason: 'sync-plan changed global plan decisions' })
        delete task.executionAuthorization
      }
    }

    if (state.plan.planningMode === 'phase') {
      const confirmationPhases = new Set()
      for (const item of invalidatedWorkflows) {
        if (item.scope === 'phase') confirmationPhases.add(item.id)
        if (item.scope === 'task') {
          const phaseId = state.tasks[item.task].phase
          if (phaseId && state.phaseWorkflows?.[phaseId]) confirmationPhases.add(phaseId)
        }
      }
      for (const phaseId of confirmationPhases) {
        const phase = state.phaseWorkflows[phaseId]
        let targets = phaseTargets(state, phaseId)
        if (!targets.length) targets = phaseMembers(state, phaseId).filter(task =>
          usesCurrentPlanning(state, task) && !['done', 'skipped'].includes(task.state))
        if (!targets.length) continue
        phase.contractConfirmationRequired = { at: historyAt, source,
          tasks: targets.map(task => task.id),
          invalidated: invalidatedWorkflows.filter(item => item.id === phaseId || item.task &&
            state.tasks[item.task].phase === phaseId) }
      }
    } else {
      const confirmationTasks = new Set(invalidatedWorkflows
        .filter(item => item.scope === 'task' && item.task)
        .map(item => item.task))
      for (const id of confirmationTasks) {
        const task = state.tasks[id]
        if (!task || ['done', 'skipped'].includes(task.state) || !usesCurrentPlanning(state, task)) continue
        task.contractConfirmationRequired = { at: historyAt, source, task: id,
          invalidated: invalidatedWorkflows.filter(item => item.scope === 'task' && item.task === id) }
      }
    }
    const previouslyEligible = eligibleDiscussionPhases(beforeState)
    saveState(name, state)
    emit(name, 'plan_sync', null, {
      added: sanitizeTaskIds(added),
      updated: sanitizeTaskIds(updated),
      metadataUpdated: sanitizeTaskIds(metadataUpdated),
      preserved: sanitizeTaskIds(preserved),
      changes: sanitizeChanges(changes),
      diagnostics: sanitizeDiagnostics(diagnostics),
      tasks: Object.keys(state.tasks).length,
      revokedAuthorizationTasks: sanitizeTaskIds(Object.keys(state.tasks).filter(id => beforeState.tasks[id]?.executionAuthorization &&
        !state.tasks[id]?.executionAuthorization)),
    })
    printSyncPlanAudit(changes, diagnostics)
    log(
      `[prumo] run "${name}" synced: +${added.length}, updated ${updated.length}, metadata ${metadataUpdated.length}, ` +
        `preserved ${preserved.length}, total ${Object.keys(state.tasks).length}`,
    )
    announceNewlyEligiblePhases(name, previouslyEligible, state, 'sync-plan')
    printDispatchSuggestions(state)
  },

  brief() {
    const state = loadState(runName()), task = getTask(state, args._[0])
    console.log(JSON.stringify(taskBrief(state, task, args.role, tokens => shellCommand([process.execPath, fileURLToPath(import.meta.url), ...tokens, '--run', state.run])), null, 2))
  },
  'set-role'() {
    const name = runName(), state = loadState(name)
    const supplied = Object.fromEntries(['model', 'effort'].filter(key => args[key] !== undefined).map(key => [key, args[key]]))
    assertRolePreferences({ [args.role]: supplied })
    const preference = { ...(state.plan.rolePreferences?.[args.role] ?? {}), ...supplied }
    ;(state.rolePreferenceHistory ??= []).push({ role: args.role, before: state.plan.rolePreferences?.[args.role] ?? null, after: preference, at: new Date().toISOString() })
    state.plan.rolePreferences ??= {}
    state.plan.rolePreferences[args.role] = preference
    saveState(name, state)
    emit(name, 'role_preference', null, { role: args.role, preference, requested: true })
  },
  'pause-run'() {
    const name = runName(), state = loadState(name)
    pauseRun(state, args.reason, args.until, new Date().toISOString())
    saveState(name, state); emit(name, 'run_pause', null, state.runPause)
    log('[prumo] Run paused; external harness processes are not interrupted; --until never resumes automatically')
  },
  'resume-run'() {
    const name = runName(), state = loadState(name)
    resumeRun(state, new Date().toISOString())
    saveState(name, state); emit(name, 'run_resume', null, { at: state.runPause.endedAt })
    log('[prumo] Run resumed explicitly; new dispatches use current limits')
    printDispatchSuggestions(state)
  },
  'report-usage'() {
    const name = runName(), state = loadState(name), task = getTask(state, args._[0])
    if (!agentRoles.includes(args.role) || !args.receipt?.trim() || args.receipt.length > 128) die('report-usage requires role and a bounded receipt id')
    const attemptNumber = args.attempt === undefined ? (args.role === 'execution' || args.role === 'review' ? task.attempts.length : task[`${args.role}Attempts`]?.length ?? 0) : positiveIndex(args.attempt, 'report-usage --attempt')
    const owner = args.role === 'execution' || args.role === 'review' ? task.attempts[attemptNumber - 1] : task[`${args.role}Attempts`]?.[attemptNumber - 1]
    const phaseId = args.phase ?? task.phase
    const workers = Object.entries(state.phaseWorkflows ?? {}).filter(([id]) => !phaseId || id === phaseId).flatMap(([id, phase]) => (phase[`${args.role}Attempts`] ?? []).filter(round => round.n === attemptNumber && (Object.hasOwn(round.workers ?? {}, task.id) || !round.workers && round.targets?.includes(task.id))).map(round => ({ phase: id, worker: round.workers?.[task.id] ?? round })))
    if (!owner && workers.length > 1) die('More than one recorded phase worker matches; select --phase explicitly')
    const target = args.phase === undefined ? owner ?? workers[0]?.worker : workers[0]?.worker
    if (!target || args.role === 'review' && !target.reviewStartedAt) die('No recorded attempt/worker for the selected role')
    const counts = {}
    for (const key of ['tokens', 'tools']) if (args[key] !== undefined) {
      const value = Number(args[key])
      if (!/^\d+$/.test(args[key]) || !Number.isSafeInteger(value)) die('Reported usage must be nonnegative safe integers')
      counts[key] = value
    }
    if (!Object.keys(counts).length) die('report-usage requires tokens or tools')
    const value = { task: task.id, role: args.role, attempt: attemptNumber, receipt: args.receipt, ...counts, selfReported: true }
    const previous = (target.usageReports ?? []).find(item => item.receipt === args.receipt && item.role === args.role)
    if (previous) { if (JSON.stringify(previous) !== JSON.stringify(value)) die('Receipt already recorded with different values'); return log('[prumo] Usage receipt already recorded; totals unchanged') }
    ;(target.usageReports ??= []).push(value)
    const totals = reportedUsageTotals(state)
    saveState(name, state); emit(name, 'reported_usage', task.id, value)
    log('[prumo] Reported tokens/tools (not measured): ' + JSON.stringify(totals))
  },
  'verify-provenance'() {
    const state = loadState(runName()), task = getTask(state, args._[0])
    if (!task.numericProvenance) die('No numeric provenance contract is recorded; approve the manifest and sources before explicitly verifying a numeric summary')
    console.log(JSON.stringify(verifyNumericProvenance(task, state.plan.cwd)))
  },

  'show-contract'() {
    const id = args._[0] ?? die('show-contract <task> [--diff]')
    const state = loadState(runName())
    const task = getTask(state, id)
    const history = task.contractHistory?.at(-1)
    const drift = contractDrift(state)
    let before, after, fields = [], source = state.plan.source ?? null, changedAt
    let approvedPlan = null
    if (state.plan.source && existsSync(state.plan.source)) {
      try { approvedPlan = JSON.parse(readFileSync(state.plan.source, 'utf8')) } catch { /* exibe o último contrato persistido abaixo */ }
    }
    const liveTaskDrift = drift.tasks.find(item => item.task === id)
    const hasLiveDrift = drift.available && (liveTaskDrift || drift.planFields.length)
    if (hasLiveDrift && approvedPlan) {
      const approvedTask = approvedPlan.tasks?.find(item => item.id === id)
      before = businessContract(state.plan, task)
      after = approvedTask ? businessContract(approvedPlan, approvedTask) : null
      fields = [...(liveTaskDrift?.fields ?? []), ...drift.planFields.map(field => `plan.${field}`)]
    } else if (history) {
      ({ before, after, fields, source, at: changedAt } = history)
    } else {
      before = businessContract(state.plan, task)
      after = before
    }
    const select = value => {
      if (!args.diff || !fields.length || !value) return value
      if (fields.includes('task')) return value
      const planFields = new Set(fields.filter(field => field.startsWith('plan.')).map(field => field.slice(5)))
      const taskFields = new Set(fields.filter(field => !field.startsWith('plan.')))
      return {
        plan: Object.fromEntries(Object.entries(value.plan ?? {}).filter(([field]) => planFields.has(field))),
        task: Object.fromEntries(Object.entries(value.task ?? {}).filter(([field]) => taskFields.has(field))),
      }
    }
    console.log(JSON.stringify({ task: id, source, ...(changedAt ? { changedAt } : {}),
      diff: args.diff === true, fields, before: select(before), after: select(after) }, null, 2))
  },

  'show-check'() {
    const id = args._[0] ?? die('show-check <task> --check <index> --attempt <number>')
    const name = runName()
    const task = getTask(loadState(name), id)
    const latest = task.attempts?.at(-1)?.n ?? task.attempts?.length ?? 0
    const receipts = [...new Map((task.validations ?? []).map(item => [item.attempt, item])).values()]
    const options = receipts.map(item => ({ attempt: item.attempt, checks: (item.checks ?? []).map((check, index) => ({ index: index + 1, run: check.run, command: shellCommand([process.execPath, fileURLToPath(import.meta.url), 'show-check', id, '--attempt', item.attempt, '--check', index + 1, '--run', name]) })) }))
    if (args.check === undefined) {
      const selected = args.attempt === undefined ? null : positiveIndex(args.attempt, 'show-check --attempt', options)
      console.log(JSON.stringify({ task: id, latestAttempt: latest, attempts: selected === null ? options : options.filter(item => item.attempt === selected), note: 'No receipt for the current attempt means no stored check; older validation is never selected implicitly.' }, null, 2))
      if (selected !== null && !options.some(item => item.attempt === selected)) die('No stored checks for this attempt; available: ' + options.map(item => item.attempt).join(', '))
      return
    }
    const checkNumber = positiveIndex(args.check, 'show-check --check', options)
    const attemptNumber = args.attempt === undefined ? latest : positiveIndex(args.attempt, 'show-check --attempt', options)
    const receipt = receipts.find(item => item.attempt === attemptNumber)
    if (!receipt?.checks?.[checkNumber - 1]) die(`${id} has no stored check ${checkNumber} for attempt ${attemptNumber}; available: ` + JSON.stringify(options))
    const check = receipt.checks[checkNumber - 1]
    const reused = Boolean(check.reusedAt)
    log(`[prumo] ${id} check ${checkNumber}/${receipt.checks.length} from attempt ${attemptNumber} (${receipt.by ?? 'unknown'}; reused ${tr(reused ? 'yes' : 'no')})`)
    console.log(tr('run: {0}', check.run ?? '(not recorded)'))
    console.log(tr('cwd: {0}', check.cwd ?? '(not recorded)'))
    console.log(tr('exit code: {0}', check.exitCode ?? '(not recorded)'))
    if (check.error) console.log(tr('error: {0}', check.error))
    if (check.signal) console.log(tr('signal: {0}', check.signal))
    const stdout = typeof check.stdout === 'string' ? check.stdout : ''
    const stderr = typeof check.stderr === 'string' ? check.stderr : ''
    log('--- stdout ---')
    if (stdout) { process.stdout.write(stdout); if (!stdout.endsWith('\n')) process.stdout.write('\n') }
    else log('(empty)')
    log('--- stderr ---')
    if (stderr) { process.stdout.write(stderr); if (!stderr.endsWith('\n')) process.stdout.write('\n') }
    else log('(empty)')
  },

  runs() {
    if (!existsSync(GRAPH_DIR)) return log('(no runs)')
    for (const entry of readdirSync(GRAPH_DIR, { withFileTypes: true })) {
      const d = entry.name
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(d)) continue
      /* Verificado, não capturado: `loadState` responde a um state.json ausente com `die()`, que
         encerra o processo — portanto um `try/catch` ao redor dele nunca pode ser executado. `plans/` fica
         neste diretório e não é uma execução; o mesmo vale para qualquer outra coisa que uma pessoa deixe aqui. */
      if (!existsSync(join(GRAPH_DIR, d, 'state.json'))) continue
      try {
        const s = loadState(d)
        if (Number(s?.schemaVersion) > STATE_SCHEMA_VERSION) throw new Error('newer schema; update Prumo before opening it')
        const p = progress(s)
        const migration = migrationStatus(s)
        log(`${d}  ${p.done}/${p.total} done  (updated ${s.updatedAt})${migration.needed ? '  [migration required]' : ''}`)
      } catch (error) {
        errorLog(`[prumo] WARNING: could not inspect run ${d}: ${error.message}`)
      }
    }
  },

  authorize() {
    const name = runName()
    if (args['confirmed-by-user'] !== true)
      die('authorize requires --confirmed-by-user after the user accepts this execution scope')
    const state = loadState(name)
    const scope = args.scope ?? die('authorize needs --scope run|phase:<phase>|tasks:<task,...>')
    const mode = args.mode ?? 'auto'
    if (!['auto', 'manual'].includes(mode)) die('authorize --mode must be auto or manual')
    const channel = args.channel ?? 'cli'
    if (typeof channel !== 'string' || !channel.trim()) die('authorize --channel must be nonempty')
    const taskIds = authorizeScope(state, scope)
    if (!taskIds.length) die(`authorization scope "${scope}" contains no tasks`)
    const authorization = { authorizationId: randomUUID(), scope, taskIds, mode, confirmedByUser: true,
      at: new Date().toISOString(), channel: channel.trim() }
    state.authorizations ??= []
    state.authorizations.push(authorization)
    for (const id of taskIds) state.tasks[id].executionAuthorization = {
      authorizationId: authorization.authorizationId, scope, mode, confirmedByUser: true,
      at: authorization.at, channel: authorization.channel,
    }
    saveState(name, state)
    emit(name, 'run_authorized', null, { scope, mode, confirmedByUser: true, at: authorization.at,
      channel: authorization.channel, tasks: taskIds })
    log('[prumo] ' + tr('authorized {0} task(s) for {1} mode ({2}) via {3}', taskIds.length, mode, scope, authorization.channel))
    printDispatchSuggestions(state)
  },

  'set-agent-limit'() {
    const { max, actor } = agentLimitChange()
    const name = runName(), state = loadState(name), previous = state.plan.maxAgents ?? null
    state.plan.maxAgents = max
    const change = { previous, maxAgents: max, actor: actor.trim(), at: new Date().toISOString() }
    state.agentLimitHistory ??= []
    state.agentLimitHistory.push(change)
    saveState(name, state)
    emit(name, 'agent_limit_changed', null, change)
    log('[prumo] ' + tr('Agent limit updated: {0}; {1} in use', max, occupancy(state).busy.length))
  },

  async status() {
    const name = runName()
    const state = loadState(name)
    await printEngineIdentity()
    if (state.runPause && !state.runPause.endedAt) log('[prumo] RUN PAUSED: ' + JSON.stringify(state.runPause))
    log('[prumo] model preferences (requested; not verified): ' + JSON.stringify(state.plan.rolePreferences ?? {}))
    log('[prumo] reported tokens/tools (not measured): ' + JSON.stringify(reportedUsageTotals(state)))
    for (const item of dispatchOwners(state)) if (item.owner.modelDispatches?.length && item.role !== 'review') log('[prumo] ' + item.key + ' dispatches (reported): ' + JSON.stringify(item.owner.modelDispatches))
    printContractDriftWarnings(state)
    printPendingContractConfirmations(state)
    printPlanningRoundProgress(state)
    printQuestionStatus(state)
    const d = derive(state)
    const p = progress(state)
    const actions = suggestedActionsByTask(state)
    const scoped = runHasAuthorizationScope(state)
    log(`run: ${name}  plan: ${state.plan.name}  ${p.done}/${p.total} done`)
    log(`states: ${JSON.stringify(p.by)}`)
    const countGateSkips = field => new Set([
      ...Object.values(state.phaseWorkflows ?? {}).flatMap(phase => phase[field] ?? []),
      ...Object.values(state.tasks).flatMap(task => task[field] ?? []),
    ].map(decision => decision.decisionId).filter(Boolean)).size
    log(`${tr('Discussion skipped')}: ${countGateSkips('discussionSkips')}  ${tr('Planning skipped')}: ${countGateSkips('planningSkips')}`)
    const width = Math.max(...Object.values(d).map((t) => t.id.length))
    const row = (t) => {
      const phasePlanner = t.effective === 'planning' && t.state !== 'planning' ? t.activeAgent : null
      const agent = t.effective === 'discussing' ? `  @${t.activeAgent ?? t.agent ?? tr('orchestrator')} (${tr('discussing')})` :
        t.state === 'planning' ? `  @${t.planner} (${tr('planning')})` :
        phasePlanner ? `  @${phasePlanner} (${tr('planning')})` :
        t.state === 'reviewing' ? `  @${t.reviewer} (review)` : t.agent ? `  @${t.agent}` : ''
      const attempts = t.attempts.length > 1 ? `  (attempt ${t.attempts.length})` : ''
      const wait = t.effective === 'waiting' ? `  ← ${(t.planningBlockedBy ?? t.blockedBy).join(',')}` : ''
      const manual = t.manualInspectionPending ? `  [${tr('Manual inspection pending')}]` : ''
      const digest = t.taskPlan?.digest ?? t.attempts.at(-1)?.planDigest
      const plan = digest ? `  ${tr('Plan {0}', digest.slice(0, 4))}` : ''
      const auth = t.executionAuthorization ? `  [${tr('authorized')} ${t.executionAuthorization.mode}]` :
        `  [${tr(scoped ? 'authorization required' : 'no authorization scope recorded')}]`
      const action = actions.get(t.id) ?? ''
      console.log(`  ${t.id.padEnd(width)}  ${tr(t.effective).padEnd(8)}${agent}${attempts}${wait}${manual}${plan}${auth}${action ? `  → ${action}` : ''}`)
    }
    for (const phase of state.plan.phases) {
      console.log(`\n${phase.id} — ${phase.title}`)
      const workflow = state.phaseWorkflows?.[phase.id]
      const discussion = workflow?.discussionAttempts?.at(-1)
      const planning = workflow?.planningAttempts?.at(-1)
      const decision = workflow && currentPhaseDiscussionDecision(state, workflow)
      if (decision?.kind === 'skipped') log('[prumo] ' + tr('phase {0} discussion {1}: {2}', phase.id, decision.id, tr('current')))
      if (discussion) {
        const targets = (discussion.contextTargets ?? discussion.targets ?? []).map(id => state.tasks[id]).filter(Boolean)
        const current = !workflow.contractConfirmationRequired && discussion.context === phaseContext(state, phase.id, targets) &&
          (!discussion.endedAt || decision?.id === discussion.roundId)
        log('[prumo] ' + tr('phase {0} discussion {1}: {2}', phase.id, discussion.roundId, tr(current ? 'current' : 'stale')))
      }
      if (planning) log('[prumo] ' + tr('phase {0} planning round {1}: {2}', phase.id, planning.n,
        tr((currentPhasePlanning(state, workflow, planning) || (decision && planning.result === 'planned' &&
          decision?.id === planning.discussionRoundId && decision.digest === (planning.discussionDigest ?? planning.discoveryDigest) &&
          planning.context === phaseContext(state, phase.id, decision.targets.map(id => state.tasks[id])))) ? 'current' : 'stale')))
      Object.values(d).filter((t) => t.phase === phase.id).forEach(row)
    }
    /* phases é OPCIONAL em um plano — tarefas sem fase (ou com uma entrada que não nomeia fase)
       ainda precisam ser listadas, ou status ocultará silenciosamente parte da execução. */
    const known = new Set(state.plan.phases.map((p) => p.id))
    const orphans = Object.values(d).filter((t) => !known.has(t.phase))
    if (orphans.length) {
      log(`\n(no phase)`)
      orphans.forEach(row)
    }
    log('[prumo] ' + tr('{0} execution slot(s) available', executionSlots(state)))
  },

  ready() {
    const state = loadState(runName())
    if (state.runPause && !state.runPause.endedAt) return log('[prumo] RUN PAUSED: ' + JSON.stringify(state.runPause) + '; resume-run explicitly')
    printContractDriftWarnings(state)
    printPendingContractConfirmations(state)
    printPlanningRoundProgress(state)
    printQuestionStatus(state)
    const d = derive(state)
    const occ = occupancy(state)
    const list = Object.values(d).filter((t) => ['ready_for_discussion', 'ready_to_plan', 'ready'].includes(t.effective))
    const slots = executionSlots(state)
    const actions = suggestedActionsByTask(state)
    const scoped = runHasAuthorizationScope(state)
    for (const t of list) {
      const auth = t.executionAuthorization ? tr('authorized {0}', t.executionAuthorization.mode) :
        tr(scoped ? 'authorization required' : 'no authorization scope recorded')
      const action = actions.get(t.id)
      console.log(`${t.id}  ${t.title}  [${tr(t.effective)} · ${auth}]  → ${action}`)
      if (action?.startsWith(`start ${t.id} `))
        log('[prumo] ' + tr('run before dispatch: node "{0}" {1} --run "{2}"', fileURLToPath(import.meta.url), action, state.run))
    }
    log(
      `\n[prumo] ${occ.executors.length}/${occ.maxExec} executors, ${occ.reviewers.length} in review ` +
        `(cap ${occ.cap}) — dispatch at most ${slots} now`,
    )
    log(`[prumo] ${occ.planners.length} in planning — ${Math.max(0, occ.cap - occ.busy.length)} agent slots available for planning`)
    if (occ.reviewers.length) log(`[prumo] awaiting review: ${occ.reviewers.map((t) => `${t.id} @${t.reviewer}`).join(', ')}`)
    if (list.some(task => task.effective === 'ready'))
      log('[prumo] ' + tr('Register start successfully before dispatching an executor. If start fails, do not dispatch. Mark activity-start when work begins and activity-stop before waiting or finishing.'))
  },

  graph() {
    const state = loadState(runName())
    console.log(JSON.stringify({ ...state, derived: derive(state), progress: progress(state) }, null, 2))
  },

  'begin-phase-discussion'() {
    const name = runName()
    const phaseId = args._[0] ?? die('begin-phase-discussion <phase> [--adopt-legacy]')
    const state = loadState(name)
    if (!(state.plan.phases ?? []).some(phase => phase.id === phaseId)) die(`unknown phase "${phaseId}"`)
    assertPhasePlanningOrder(state, phaseId)
    printQuestionsForTarget(state, null, phaseId)
    const members = phaseMembers(state, phaseId)
    const needsLegacyAdoption = state.plan.planningMode !== 'phase' ||
      (state.legacyPhaseAdoption && !state.phaseWorkflows?.[phaseId]?.adoptedLegacy)
    if (needsLegacyAdoption) {
      if (args['adopt-legacy'] !== true)
        die(state.plan.planningMode === 'phase' ? `${phaseId} is not adopted yet; use --adopt-legacy to opt in this phase` :
          'legacy run uses task planning; use --adopt-legacy to opt in this phase')
      const legacyMembers = members.filter(task => !['done', 'skipped'].includes(task.state))
      const openTaskFlows = Object.values(state.tasks).filter(task =>
        task.discussionAttempts?.some(round => !round.endedAt) || task.planningAttempts?.some(round => !round.endedAt))
      if (openTaskFlows.length)
        die('phase legacy adoption is unsafe with open task discussion or planning for: ' + openTaskFlows.map(task => task.id).join(', '))
      const unsafe = legacyMembers.filter(task =>
        (!['pending', 'failed'].includes(task.state) || task.attempts?.length ||
          task.discussionAttempts?.some(round => !round.endedAt) || task.planningAttempts?.some(round => !round.endedAt)))
      if (unsafe.length) die('phase legacy adoption is unsafe for: ' + unsafe.map(task => task.id).join(', '))
      if (state.plan.planningMode !== 'phase') {
        state.plan.planningMode = 'phase'
        state.legacyPhaseAdoption = true
        state.phaseWorkflows = Object.fromEntries(state.plan.phases.map(phase => [phase.id,
          { id: phase.id, title: phase.title, state: 'pending', discussionAttempts: [], planningAttempts: [], planningHistory: [] }]))
      }
      for (const task of legacyMembers) {
        task.discussionRequired = true
        task.discoveryRequired = true
        task.planningRequired = true
        task.planningHistory ??= []
      }
      state.phaseWorkflows[phaseId].adoptedLegacy = true
    }
    const phase = getPhase(state, phaseId)
    if (!phaseMembers(state, phaseId).length) die(`phase "${phaseId}" has no tasks`)
    const discussion = phase.discussionAttempts.at(-1)
    const discussionTargets = discussion?.targets?.map(id => state.tasks[id]).filter(Boolean) ?? []
    const currentDiscussionTargets = phaseDiscussionTargets(state, phaseId, discussion)
    const discussionTargetIds = [...(discussion?.targets ?? [])].sort()
    const currentDiscussionTargetIds = currentDiscussionTargets.map(task => task.id).sort()
    const staleDiscussion = phase.state === 'discussing' && discussion && !discussion.endedAt &&
      (discussionTargets.length !== discussion.targets.length ||
        JSON.stringify(discussionTargetIds) !== JSON.stringify(currentDiscussionTargetIds) ||
        discussion.context !== phaseContext(state, phaseId, discussionTargets))
    if (phase.state === 'discussing' && discussion && !discussion.endedAt && !staleDiscussion)
      die(`${phaseId} already has an open discussion round`)
    const superseded = []
    if (staleDiscussion) {
      const cause = staleReason(name, discussion, phaseContextSnapshot(state, currentDiscussionTargets),
        phaseContext(state, phaseId, currentDiscussionTargets))
      Object.assign(discussion, { endedAt: new Date().toISOString(), result: 'superseded', cause })
      superseded.push({ workflow: 'discussion', roundId: discussion.roundId, cause })
    }
    const planning = phase.planningAttempts.at(-1)
    const stalePlanning = phase.state === 'planning' && planning && !currentPhasePlanning(state, phase, planning)
    if (phase.state === 'planning' && !stalePlanning) die(`${phaseId} is currently planning`)
    if (stalePlanning) {
      const planningTargets = (planning.contextTargets ?? planning.targets ?? []).map(id => state.tasks[id]).filter(Boolean)
      const cause = staleReason(name, planning, phaseContextSnapshot(state, planningTargets),
        phaseContext(state, phaseId, planningTargets))
      Object.assign(planning, { endedAt: new Date().toISOString(), result: 'superseded', cause })
      superseded.push({ workflow: 'planning', round: planning.n, cause })
      phase.planner = null
    }
    logExcludedTasks(state, phaseId)
    let targets = phaseTargets(state, phaseId)
    const targetsFallback = targets.length === 0
    if (targetsFallback) targets = phaseMembers(state, phaseId).filter(task =>
      usesCurrentPlanning(state, task) && !['done', 'skipped'].includes(task.state) && !isExternalBlock(task) && !task.individualPlanning)
    if (!targets.length) die(`${phaseId} has no nonterminal tasks to discuss`)
    if (occupancy(state).busy.length >= occupancy(state).cap) die(`${occupancy(state).busy.length} agents busy (cap ${occupancy(state).cap})`)
    const requiresContractConfirmation = Boolean(phase.contractConfirmationRequired)
    const round = { roundId: randomUUID(), nonce: randomUUID(), startedAt: new Date().toISOString(),
      activityTiming: 'explicit', activityIntervals: [],
      targets: targets.map(task => task.id), context: phaseContext(state, phaseId, targets),
      contextSnapshot: phaseContextSnapshot(state, targets),
      assignments: phaseAssignments(targets, args.agent, 'orchestrator'), queuedTargets: targets.map(task => task.id), workers: {},
      ...(targetsFallback ? { targetsFallback: true } : {}),
      ...(requiresContractConfirmation ? { requiresContractConfirmation: true,
        confirmsContract: phaseContractDigests(state, targets) } : {}) }
    activatePhaseWorkers(state, round, 'discussion')
    phase.discussionAttempts.push(round)
    phase.state = 'discussing'
    saveState(name, state)
    emit(name, 'phase_discussion', null, { phase: phaseId, roundId: round.roundId, members: round.targets,
      ...(superseded.length ? { superseded } : {}),
      ...(requiresContractConfirmation ? { requiresContractConfirmation: true,
        confirmsContract: round.confirmsContract } : {}),
      ...(args['adopt-legacy'] === true ? { adoptedLegacy: true } : {}) })
    log(`[prumo] ${phaseId} discussing ${round.targets.length} task(s) (round ${round.roundId}, nonce ${round.nonce})`)
    log('[prumo] ' + tr('discussion targets: {0}', round.targets.join(', ')))
    logPhaseWorkers(phaseId, round)
    logSupersededRounds(phaseId, superseded)
    if (requiresContractConfirmation) {
      log('[prumo] ' + tr('contract confirmation required: inspect each task with show-contract, then ask the user to confirm the displayed contracts'))
      log('[prumo] ' + tr('include this exact current task digest list in an answered discovery question:'))
      log(JSON.stringify({ confirmsContract: round.confirmsContract }, null, 2))
    }
    log('[prumo] discussion guard: inspect local context and resolve decisions only; planner researches how, executor delivers every task')
  },

  'skip-phase-discussion'() {
    const name = runName()
    const phaseId = args._[0] ?? die('skip-phase-discussion <phase> --reason <text> --confirmed-by-user')
    const state = loadState(name)
    if (state.plan.planningMode !== 'phase') die('this run uses task planning; use skip-discussion')
    assertPhasePlanningOrder(state, phaseId)
    const phase = getPhase(state, phaseId)
    if (phase.contractConfirmationRequired)
      die(`${phaseId} requires a fresh answered contract confirmation; begin-phase-discussion and ask the user before skipping discussion`)
    if (['discussing', 'planning'].includes(phase.state))
      die(`${phaseId} has active ${phase.state}; finish or block it before changing the gate decision`)
    const targets = phaseTargets(state, phaseId)
    if (!targets.length) die(`${phaseId} has no task requiring a discussion decision`)
    const decision = { ...explicitSkipDecision('skip-phase-discussion'), targets: targets.map(task => task.id),
      context: phaseContext(state, phaseId, targets), contextSnapshot: phaseContextSnapshot(state, targets) }
    phase.discussionSkips ??= []
    phase.discussionSkips.push(decision)
    phase.state = 'pending'
    saveState(name, state)
    emit(name, 'phase_discussion_skipped', null, { phase: phaseId, decisionId: decision.decisionId,
      reason: decision.reason, confirmedByUser: true, members: decision.targets })
    log(`[prumo] ${phaseId} discussion skipped by explicit user choice; ready for the planning decision (${targets.length} task(s))`)
  },

  'finish-phase-discussion'() {
    const name = runName()
    const phaseId = args._[0] ?? die('finish-phase-discussion <phase> --context <discovery.json>')
    if (typeof args.context !== 'string' || !args.context.trim()) die('finish-phase-discussion needs --context <discovery.json>')
    const state = loadState(name), phase = getPhase(state, phaseId), round = phase.discussionAttempts.at(-1)
    if (phase.state !== 'discussing' || !round || round.endedAt) die(`${phaseId} has no open discussion round`)
    const currentTargets = phaseDiscussionTargets(state, phaseId, round)
    const currentContext = phaseContext(state, phaseId, currentTargets)
    const targetCoverageCurrent = JSON.stringify([...round.targets].sort()) ===
      JSON.stringify(currentTargets.map(task => task.id).sort())
    if (round.context !== currentContext || !targetCoverageCurrent)
      die(tr('{0} discussion is stale: {1} — begin a fresh phase discussion', phaseId,
        staleReason(name, round, phaseContextSnapshot(state, currentTargets), currentContext)))
    let discovery, digest
    try {
      discovery = JSON.parse(readFileSync(resolve(args.context), 'utf8'))
      assertDiscovery(discovery)
      assertDiscussionBoundary(discovery, round.activeTargets ?? round.targets, { acceptPremature: args['accept-premature-work'] === true })
      if (discovery.roundId !== round.roundId || discovery.nonce !== round.nonce)
        throw new Error('discovery roundId and nonce must match the current phase discussion')
      if (!discovery.questions.some(question => question.roundId === round.roundId))
        throw new Error('discovery needs a fresh answered question bound to the current phase discussion roundId')
      if (round.requiresContractConfirmation) {
        const expected = round.confirmsContract ?? []
        const confirmed = discovery.questions.some(question => {
          if (question.roundId !== round.roundId || !Array.isArray(question.confirmsContract)) return false
          const actual = question.confirmsContract.map(item => ({ task: item?.task, digest: item?.digest }))
            .sort((left, right) => String(left.task).localeCompare(String(right.task)))
          return JSON.stringify(actual) === JSON.stringify(expected)
        })
        if (!confirmed)
          throw new Error(tr('discovery needs an answered question with confirmsContract matching every current task and digest'))
      }
      round.questionRefs = validateQuestionResolutions(state, discovery.decisions)
      digest = discoveryDigest(discovery)
    } catch (error) { die(error.message) }
    if (round.workers) {
      round.discoveries ??= []
      round.discoveries.push(discovery)
      finishPhaseWorkers(round, new Date().toISOString())
      if (round.queuedTargets.length) {
        activatePhaseWorkers(state, round, 'discussion')
        saveState(name, state)
        emit(name, 'phase_discussion_batch', null, { phase: phaseId, active: round.activeTargets, queued: round.queuedTargets })
        logPhaseWorkers(phaseId, round)
        return
      }
      const pieces = round.discoveries
      discovery = { ...discovery, research: pieces.flatMap(piece => piece.research), questions: pieces.flatMap(piece => piece.questions),
        decisions: pieces.flatMap(piece => piece.decisions), deferred: pieces.flatMap(piece => piece.deferred),
        executionBoundary: { deferredToExecutor: [...new Set(pieces.flatMap(piece => piece.executionBoundary.deferredToExecutor))].filter(id => round.targets.includes(id)),
          prematureTaskWork: pieces.flatMap(piece => piece.executionBoundary.prematureTaskWork) } }
      round.questionRefs = validateQuestionResolutions(state, discovery.decisions)
      digest = discoveryDigest(discovery)
    }
    const fields = ['research', 'questions', 'coverage', 'decisions', 'deferred', 'executionBoundary', 'closure', 'roundId', 'nonce']
    phase.discovery = { ...Object.fromEntries(fields.map(field => [field, discovery[field]])),
      recordedAt: new Date().toISOString(), context: round.context, digest }
    Object.assign(round, { endedAt: new Date().toISOString(), result: 'discussed', discoveryDigest: digest,
      discovery: phase.discovery })
    if (round.requiresContractConfirmation) {
      phase.contractConfirmations ??= []
      phase.contractConfirmations.push({ roundId: round.roundId, at: new Date().toISOString(),
        contracts: round.confirmsContract, discoveryDigest: digest })
      phase.contractConfirmationRequired = null
    }
    phase.state = 'pending'
    recordQuestionResolutions(state, round.questionRefs, discovery.decisions, { phase: phaseId })
    saveState(name, state)
    emit(name, 'phase_discussed', null, { phase: phaseId, roundId: round.roundId, questions: discovery.questions.length,
      members: round.targets, prematureTaskWork: discovery.executionBoundary.prematureTaskWork.length })
    log(`[prumo] ${phaseId} ready to plan (${round.targets.length} task(s))`)
  },

  'plan-phase'() {
    const name = runName()
    const phaseId = args._[0] ?? die('plan-phase <phase> --agent <name>')
    const specification = args.agent ?? die('plan-phase needs --agent <name>')
    const agent = Array.isArray(specification) ? JSON.stringify(specification) : specification
    const state = loadState(name), phase = getPhase(state, phaseId)
    logExcludedTasks(state, phaseId)
    assertPhasePlanningOrder(state, phaseId)
    printQuestionsForTarget(state, null, phaseId)
    const discussion = currentPhaseDiscussionDecision(state, phase)
    if (!discussion) die(`${phaseId} needs a completed current phase discussion or an explicit user-confirmed discussion skip`)
    const targets = discussion.targets.map(id => getTask(state, id)).filter(task => !hasCurrentTaskPlan(state, task))
    if (!targets.length) die(`${phaseId} has no task requiring a phase plan`)
    const context = phaseContext(state, phaseId, discussion.targets.map(id => getTask(state, id)))
    const open = phase.planningAttempts.at(-1)
    if (phase.state === 'planning' && !open?.endedAt && open.context === context && open.discussionDigest === discussion.digest) {
      if (agent !== phase.planner) die(`${phaseId} already has planner "${phase.planner}" for the current round`)
      log(`[prumo] ${tr('{0} already in planning with the same discovery; no new round recorded', phaseId)}`)
      logPhasePlanningInputs(phaseId, open)
      if (open.workers) {
        if (open.queuedTargets.length && occupancy(state).busy.length < occupancy(state).cap) {
          activatePhaseWorkers(state, open, 'planning')
          saveState(name, state)
        }
        logPhaseWorkers(phaseId, open)
      }
      return
    }
    if (phase.state === 'planning') {
      const reason = staleReason(name, open, phaseContextSnapshot(state,
        (open?.contextTargets ?? open?.targets ?? []).map(id => state.tasks[id]).filter(Boolean)), context)
      die(tr('{0} has a stale open planning round: {1} — begin a fresh phase discussion', phaseId, reason))
    }
    const occ = occupancy(state)
    if (occ.busy.length >= occ.cap) die(`${occ.busy.length} agents busy (cap ${occ.cap})`)
    const busy = agentBusy(state, agent)
    if (busy) die(`agent "${agent}" is already on ${busy.id} — one agent per task or phase`)
    const planDir = args['plan-dir'] === undefined ? undefined :
      typeof args['plan-dir'] === 'string' && args['plan-dir'].trim() ? resolve(args['plan-dir']) : die('plan-phase --plan-dir must name a directory')
    const round = { n: phase.planningAttempts.length + 1, agent, startedAt: new Date().toISOString(), context,
      activityTiming: 'explicit', activityIntervals: [],
      ...(planDir ? { planDir } : {}),
      contextSnapshot: phaseContextSnapshot(state, discussion.targets.map(id => getTask(state, id))),
      discussionDecision: discussion.kind, discussionDigest: discussion.digest, discussionRoundId: discussion.id,
      ...(discussion.kind === 'discussed' ? { discoveryDigest: discussion.digest } : {}),
      targets: targets.map(task => task.id), contextTargets: discussion.targets,
      requiredInputs: Object.fromEntries(targets.map(task => [task.id, phaseRequiredInputs(state, task)])),
      assignments: phaseAssignments(targets, specification, 'planner'), queuedTargets: targets.map(task => task.id), workers: {} }
    activatePhaseWorkers(state, round, 'planning')
    phase.planner = agent
    phase.planningAttempts.push(round)
    phase.state = 'planning'
    saveState(name, state)
    emit(name, 'phase_planning', null, { phase: phaseId, planner: agent, round: round.n, members: round.targets })
    log(`[prumo] ${phaseId} in planning (planner ${agent}, ${round.targets.length} task(s))`)
    logPhasePlanningInputs(phaseId, round)
    logPhaseWorkers(phaseId, round)
    log('[prumo] planner guard: read-only research may determine how to execute; task results and acceptance evidence belong to the executor')
    log('[prumo] If the planner cannot write, return complete task-plan-<task>.json JSON on stdout. The orchestrator saves that exact artifact, then runs finish-phase-planning --plan-dir. Empty output is not a plan; all artifact gates still apply.')
  },

  'skip-phase-planning'() {
    const name = runName()
    const phaseId = args._[0] ?? die('skip-phase-planning <phase> --reason <text> --confirmed-by-user')
    const state = loadState(name)
    if (state.plan.planningMode !== 'phase') die('this run uses task planning; use skip-planning')
    assertPhasePlanningOrder(state, phaseId)
    const phase = getPhase(state, phaseId)
    if (phase.contractConfirmationRequired)
      die(`${phaseId} requires a fresh answered contract confirmation; finish the discussion before skipping planning`)
    if (['discussing', 'planning'].includes(phase.state))
      die(`${phaseId} has active ${phase.state}; finish or block it before changing the gate decision`)
    const discussion = currentPhaseDiscussionDecision(state, phase)
    if (!discussion) die(`${phaseId} needs a completed current phase discussion or an explicit user-confirmed discussion skip`)
    const targets = discussion.targets.map(id => getTask(state, id)).filter(task => !hasCurrentTaskPlan(state, task))
    if (!targets.length) die(`${phaseId} has no task requiring a planning decision`)
    const decision = { ...explicitSkipDecision('skip-phase-planning'), phaseId,
      targets: targets.map(task => task.id), context: phaseContext(state, phaseId, targets),
      contextSnapshot: phaseContextSnapshot(state, targets),
      discussionDecision: discussion.kind, discussionDecisionId: discussion.id }
    phase.planningSkips ??= []
    phase.planningSkips.push(decision)
    for (const task of targets) {
      task.planningSkips ??= []
      task.planningSkips.push({ ...decision, scope: phasePlanningContext(state, task), task: task.id,
        context: planningContext(state, task), contextSnapshot: taskContextSnapshot(state, task) })
      delete task.retryPlan
    }
    phase.state = 'planned'
    saveState(name, state)
    emit(name, 'phase_planning_skipped', null, { phase: phaseId, decisionId: decision.decisionId,
      reason: decision.reason, confirmedByUser: true, members: decision.targets })
    log(`[prumo] ${phaseId} planning skipped by explicit user choice; ${targets.length} task(s) ready when dependencies allow`)
  },

  'finish-phase-planning'() {
    const name = runName()
    const phaseId = args._[0] ?? die('finish-phase-planning <phase> --plan-dir <directory>')
    if (typeof args['plan-dir'] !== 'string' || !args['plan-dir'].trim())
      die('finish-phase-planning needs --plan-dir <directory>')
    const state = loadState(name), phase = getPhase(state, phaseId), round = phase.planningAttempts.at(-1)
    if (phase.state !== 'planning' || !round || round.endedAt || round.agent !== phase.planner)
      die(`${phaseId} has no open planning round and recorded planner`)
    if (!currentPhasePlanning(state, phase, round)) {
      const targets = (round.contextTargets ?? round.targets ?? []).map(id => state.tasks[id]).filter(Boolean)
      const currentContext = phaseContext(state, phaseId, targets)
      die(tr('{0} planning is stale: {1} — discuss and plan the current phase contract', phaseId,
        staleReason(name, round, phaseContextSnapshot(state, targets), currentContext)))
    }
    const tasks = (round.activeTargets ?? round.targets).map(id => getTask(state, id)).filter(task => !isExternalBlock(task))
    const binding = { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n }
    let plans = []
    const errors = [], plannedQuestionRefs = new Set((round.stagedPlans ?? []).flatMap(item => item.questionRefs)), planDir = resolve(args['plan-dir'])
    for (const task of tasks) {
      const filename = `task-plan-${task.id}.json`
      try {
        safeId(task.id)
        const path = resolve(planDir, filename)
        const plan = readPlanningArtifact(path)
        assertPhaseTaskPlan(state, task, plan, binding, round.requiredInputs?.[task.id] ?? [])
        validateQuestionDeadlines(state, task.id, plan.openQuestions)
        const questionRefs = validateQuestionResolutions(state, plan.decisions)
        for (const ref of questionRefs) {
          if (plannedQuestionRefs.has(ref))
            throw new Error(tr('phase planning cannot resolve the same open question more than once'))
          plannedQuestionRefs.add(ref)
        }
        plans.push([task, plan, questionRefs, path])
      } catch (error) { errors.push(planningArtifactError(filename, error) + '\n' + tr('artifact path: {0}', resolve(planDir, filename))) }
    }
    if (errors.length) die(tr('finish-phase-planning {0} rejected {1} task-plan artifact(s); nothing was recorded:\n{2}',
      phaseId, errors.length, errors.join('\n')))
    for (const [task, plan] of plans) warnTaskPlan(task, plan, state)
    const completedAt = new Date().toISOString()
    if (round.workers) {
      round.stagedPlans ??= []
      round.stagedPlans.push(...plans.map(([task, plan, questionRefs, sourcePath]) => ({ task: task.id, plan, questionRefs, sourcePath })))
      finishPhaseWorkers(round, completedAt)
      if (round.queuedTargets.length) {
        activatePhaseWorkers(state, round, 'planning')
        saveState(name, state)
        emit(name, 'phase_planning_batch', null, { phase: phaseId, completed: tasks.map(task => task.id), active: round.activeTargets, queued: round.queuedTargets })
        logPhaseWorkers(phaseId, round)
        logPhasePlanningInputs(phaseId, round)
        return
      }
      plans = round.stagedPlans.filter(item => !isExternalBlock(state.tasks[item.task])).map(item => [getTask(state, item.task), item.plan, item.questionRefs, item.sourcePath])
    }
    const allResolutions = []
    for (const [task, plan, questionRefs, sourcePath] of plans) {
      const fields = ['summary', 'research', 'decisions', 'steps', 'verification', 'openQuestions', 'phaseBinding', 'unresolvedInputs', 'writes']
      const artifact = Object.fromEntries(fields.map(field => [field, plan[field]]))
      artifact.openQuestions = annotatePlanQuestions(task, artifact.openQuestions, round.startedAt)
      allResolutions.push(...questionRefs.map(questionRef => ({
        task: task.id, questionRef, decisions: plan.decisions,
      })))
      task.planner = round.assignments?.[task.id] ?? phase.planner
      task.taskPlan = { ...artifact, ...(sourcePath ? { sourcePath } : {}), digest: taskPlanDigest(artifact), planner: task.planner, startedAt: round.workers?.[task.id]?.startedAt ?? round.startedAt, completedAt,
        context: round.context, scope: phasePlanningContext(state, task), phaseId,
        phaseDecision: round.discussionDecision ?? 'discussed', phaseDecisionDigest: round.discussionDigest ?? round.discoveryDigest,
        ...(round.discoveryDigest ? { phaseDiscoveryDigest: round.discoveryDigest } : {}), attempt: task.attempts.length + 1 }
      task.planningHistory ??= []
      task.planningHistory.push(task.taskPlan)
      delete task.phasePlanDefect
      delete task.retryPlan
    }
    Object.assign(round, { endedAt: completedAt, result: 'planned', artifactCount: plans.length })
    phase.planningHistory.push({ round: round.n, planner: phase.planner, completedAt, members: round.targets,
      discoveryDigest: round.discoveryDigest })
    phase.state = 'planned'
    for (const item of allResolutions)
      recordQuestionResolutions(state, [item.questionRef], item.decisions, { task: item.task, phase: phaseId })
    saveState(name, state)
    emit(name, 'phase_planned', null, { phase: phaseId, planner: phase.planner, round: round.n, members: round.targets })
    log(`[prumo] ${phaseId} planned atomically (${round.targets.length} task artifact(s))`)
    printPlannedQuestionSummary(tasks)
  },

  'begin-discussion'() {
    const name = runName()
    const id = args._[0] ?? die('begin-discussion <task>')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase' && !state.tasks[id]?.individualPlanning) die('this run uses phase planning; use begin-phase-discussion')
    const t = getTask(state, id)
    printQuestionsForTarget(state, id, t.phase)
    const blockedBy = t.deps.filter(dep => !['done', 'skipped'].includes(state.tasks[dep]?.state))
    if (blockedBy.length) die(id + ' still waiting on: ' + blockedBy.join(', '))
    const adoptLegacy = !t.discussionRequired && args['adopt-legacy'] === true
    if (!t.discussionRequired && !adoptLegacy)
      die(id + ' is a legacy task without the discussion gate (use --adopt-legacy to opt in this task)')
    if (adoptLegacy) {
      const openDiscussion = t.discussionAttempts?.at(-1)
      const openPlanning = t.planningAttempts?.at(-1)
      if (!['pending', 'failed'].includes(t.state))
        die(id + ' can adopt legacy discussion only while pending or failed')
      if ((t.attempts?.length ?? 0) > 0)
        die(id + ' cannot adopt legacy discussion after execution started')
      if ((openDiscussion && !openDiscussion.endedAt) || (openPlanning && !openPlanning.endedAt))
        die(id + ' cannot adopt legacy discussion with an open discussion or planning round')
    }
    const stalePlanning = t.state === 'planning' && t.planningAttempts?.at(-1)?.context !== planningContext(state, t)
    const pausedExecution = t.planningRequired && t.state === 'blocked' && ['running', 'reviewing'].includes(t.stateBeforeBlock)
    if (!['pending', 'discussing'].includes(t.state) && !stalePlanning && !pausedExecution &&
        !(adoptLegacy && t.state === 'failed'))
      die(id + ' must be ready for discussion or require fresh planning')
    const open = t.discussionAttempts?.at(-1)
    const staleDiscussion = t.state === 'discussing' && open && !open.endedAt &&
      (open.context !== planningContext(state, t) ||
        open.attempt !== t.attempts.length + (t.planningReturn ? 0 : 1))
    if (t.state === 'discussing' && open && !open.endedAt && !staleDiscussion)
      die(id + ' already has an open discussion round')
    const superseded = []
    if (staleDiscussion) {
      const cause = staleReason(name, open, taskContextSnapshot(state, t), planningContext(state, t))
      closeDiscussion(t, 'superseded', cause)
      superseded.push({ workflow: 'discussion', roundId: open.roundId, cause })
    }
    if (stalePlanning) {
      const staleRound = t.planningAttempts.at(-1)
      const cause = staleReason(name, staleRound, taskContextSnapshot(state, t), planningContext(state, t))
      closePlanning(t, 'superseded', cause)
      superseded.push({ workflow: 'planning', round: staleRound.n, cause })
    }
    if (pausedExecution) t.planningReturn = { stateBeforeBlock: t.stateBeforeBlock, blockReason: t.blockReason, blockKind: 'replan' }
    const requiresContractConfirmation = Boolean(t.contractConfirmationRequired)
    const round = {
      roundId: randomUUID(), nonce: randomUUID(), startedAt: new Date().toISOString(),
      activityTiming: 'explicit', activityIntervals: [],
      context: planningContext(state, t), attempt: t.attempts.length + (t.planningReturn ? 0 : 1),
      contextSnapshot: taskContextSnapshot(state, t),
      ...(requiresContractConfirmation ? { requiresContractConfirmation: true,
        confirmsContract: [{ task: id, digest: phasePlanningContext(state, t) }] } : {}),
    }
    if (adoptLegacy) {
      t.discussionRequired = true
      t.discoveryRequired = true
      t.planningRequired = true
      t.planningAttempts ??= []
      t.planningHistory ??= []
    }
    t.discussionAttempts ??= []
    const discussionAgent = args.agent ?? `orchestrator:${id}`
    assertAvailable(state, t, 'discussing', discussionAgent)
    round.agent = discussionAgent
    t.discussionAttempts.push(round)
    t.state = 'discussing'
    saveState(name, state)
    emit(name, 'task_discussion', id, { roundId: round.roundId, attempt: round.attempt,
      ...(superseded.length ? { superseded } : {}),
      ...(requiresContractConfirmation ? { requiresContractConfirmation: true,
        confirmsContract: round.confirmsContract } : {}),
      ...(adoptLegacy ? { adoptedLegacy: true } : {}) })
    log(`[prumo] ${id} discussing (round ${round.roundId}, nonce ${round.nonce})`)
    logSupersededRounds(id, superseded)
    if (requiresContractConfirmation) {
      log('[prumo] ' + tr('contract confirmation required: inspect each task with show-contract, then ask the user to confirm the displayed contracts'))
      log('[prumo] ' + tr('include this exact current task digest list in an answered discovery question:'))
      log(JSON.stringify({ confirmsContract: round.confirmsContract }, null, 2))
    }
    log('[prumo] discussion guard: inspect local context and resolve decisions only; planner researches how, executor delivers the task')
  },

  'skip-discussion'() {
    const name = runName()
    const id = args._[0] ?? die('skip-discussion <task> --reason <text> --confirmed-by-user')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase' && !state.tasks[id]?.individualPlanning) die('this run uses phase planning; use skip-phase-discussion')
    const task = getTask(state, id)
    const blockedBy = task.deps.filter(dep => !['done', 'skipped'].includes(state.tasks[dep]?.state))
    if (blockedBy.length) die(id + ' still waiting on: ' + blockedBy.join(', '))
    if (task.contractConfirmationRequired)
      die(tr('{0} requires a fresh answered contract confirmation; begin-discussion and ask the user before skipping discussion', id))
    if (!['pending', 'failed'].includes(task.state)) die(`${id} must be pending or failed to skip discussion`)
    if (!usesCurrentPlanning(state, task)) die(`${id} is a legacy task without current planning gates`)
    const decision = { ...explicitSkipDecision('skip-discussion'), scope: phasePlanningContext(state, task),
      context: planningContext(state, task), contextSnapshot: taskContextSnapshot(state, task) }
    task.discussionSkips ??= []
    task.discussionSkips.push(decision)
    saveState(name, state)
    emit(name, 'task_discussion_skipped', id, { decisionId: decision.decisionId,
      reason: decision.reason, confirmedByUser: true })
    log(`[prumo] ${id} discussion skipped by explicit user choice; ready for the planning decision`)
  },

  'finish-discussion'() {
    const name = runName()
    const id = args._[0] ?? die('finish-discussion <task> --context <discovery.json>')
    if (typeof args.context !== 'string' || !args.context.trim())
      die('finish-discussion needs --context <discovery.json>')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase' && !state.tasks[id]?.individualPlanning) die('this run uses phase planning; use finish-phase-discussion')
    const t = getTask(state, id)
    const round = t.discussionAttempts?.at(-1)
    if (t.state !== 'discussing' || !round || round.endedAt)
      die(id + ' has no open discussion round')
    const currentContext = planningContext(state, t)
    if (round.context !== currentContext || round.attempt !== t.attempts.length + (t.planningReturn ? 0 : 1))
      die(tr('{0} discussion is stale: {1} — begin a fresh discussion', id,
        staleReason(name, round, taskContextSnapshot(state, t), currentContext)))
    let discovery, digest
    try {
      discovery = JSON.parse(readFileSync(resolve(args.context), 'utf8'))
      assertDiscovery(discovery)
      assertDiscussionBoundary(discovery, [id], { acceptPremature: args['accept-premature-work'] === true })
      if (discovery.roundId !== round.roundId || discovery.nonce !== round.nonce)
        throw new Error('discovery roundId and nonce must match the current discussion')
      if (!discovery.questions.some(question => question.roundId === round.roundId))
        throw new Error('discovery needs a fresh answered question bound to the current discussion roundId')
      if (round.requiresContractConfirmation) {
        const expected = round.confirmsContract ?? []
        const confirmed = discovery.questions.some(question => {
          if (question.roundId !== round.roundId || !Array.isArray(question.confirmsContract)) return false
          const actual = question.confirmsContract.map(item => ({ task: item?.task, digest: item?.digest }))
          return JSON.stringify(actual) === JSON.stringify(expected)
        })
        if (!confirmed)
          throw new Error(tr('discovery needs an answered question with confirmsContract matching every current task and digest'))
      }
      round.questionRefs = validateQuestionResolutions(state, discovery.decisions)
      digest = discoveryDigest(discovery)
    } catch (error) { die(error.message) }
    const fields = ['research', 'questions', 'coverage', 'decisions', 'deferred', 'executionBoundary', 'closure', 'roundId', 'nonce']
    t.discovery = { ...Object.fromEntries(fields.map(field => [field, discovery[field]])),
      recordedAt: new Date().toISOString(), context: round.context, attempt: round.attempt, digest }
    Object.assign(round, { endedAt: new Date().toISOString(), result: 'discussed', discoveryDigest: digest, discovery: t.discovery })
    if (round.requiresContractConfirmation) {
      t.contractConfirmations ??= []
      t.contractConfirmations.push({ roundId: round.roundId, at: new Date().toISOString(),
        contracts: round.confirmsContract, discoveryDigest: digest })
      t.contractConfirmationRequired = null
    }
    t.state = t.planningReturn ? 'blocked' : 'pending'
    recordQuestionResolutions(state, round.questionRefs, discovery.decisions, { task: id })
    saveState(name, state)
    emit(name, 'task_discussed', id, { roundId: round.roundId, questions: discovery.questions.length, state: t.state,
      prematureTaskWork: discovery.executionBoundary.prematureTaskWork.length })
    log(`[prumo] ${id} ready to plan (discussion ${round.roundId} closed)`)
  },

  'plan-task'() {
    const name = runName()
    const id = args._[0] ?? die('plan-task <task> --agent <name> --context <discovery.json>')
    const agent = args.agent ?? die('plan-task needs --agent <name>')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase' && !state.tasks[id]?.individualPlanning) die('this run uses phase planning; use plan-phase')
    const t = getTask(state, id)
    printQuestionsForTarget(state, id, t.phase)
    const pausedExecution = t.planningRequired && t.state === 'blocked' && ['running', 'reviewing'].includes(t.stateBeforeBlock)
    if (pausedExecution && t.blockKind === 'replan') t.planningReturn = { stateBeforeBlock: t.stateBeforeBlock, blockReason: t.blockReason, blockKind: 'replan' }
    const stale = t.state === 'planning' && t.planningAttempts?.at(-1)?.context !== planningContext(state, t)
    let discovery, digest
    if (t.discussionRequired) {
      const discussion = currentTaskDiscussionDecision(state, t)
      if (!discussion)
        die(id + ' needs a completed current discussion or an explicit user-confirmed discussion skip before the planner is dispatched')
      if (discussion.kind === 'discussed') discovery = t.discovery
      digest = discussion.digest
    } else if (t.discoveryRequired) {
      if (typeof args.context !== 'string' || !args.context.trim())
        die('plan-task needs --context <discovery.json> before the planner is dispatched')
      try {
        discovery = JSON.parse(readFileSync(resolve(args.context), 'utf8'))
        assertDiscovery(discovery)
        digest = discoveryDigest(discovery)
      } catch (error) { die(error.message) }
    }
    const roundDigest = t.planningAttempts?.at(-1)?.discoveryDigest
    const skippedDiscussion = currentTaskDiscussionSkip(state, t)
    const storedDiscoveryCurrent = digest && (skippedDiscussion?.digest === digest ||
      (digest === t.discovery?.digest && digest === discoveryDigest(t.discovery)))
    const changedDiscovery = t.state === 'planning' && digest && (!storedDiscoveryCurrent || digest !== roundDigest)
    if (t.state === 'planning' && !stale && storedDiscoveryCurrent && digest === roundDigest) {
      log(`[prumo] ${id} already in planning with the same discovery; no new round recorded`)
      return
    }
    if (t.state !== 'pending' && !stale && !pausedExecution && !changedDiscovery)
      die(id + ' must be pending, have stale planning, or have paused execution before plan-task')
    if (pausedExecution) {
      const attempt = t.attempts.at(-1)
      if (!attempt || attempt.endedAt || attempt.result || !t.agent || attempt.agent !== t.agent)
        die('cannot replan without an open attempt and its original executor')
    }
    try { validationContract(t) } catch (error) { die(error.message) }
    assertAvailable(state, t, 'planning', agent)
    if (pausedExecution) t.planningReturn = { stateBeforeBlock: t.stateBeforeBlock, blockReason: t.blockReason, blockKind: 'replan' }
    const superseded = []
    if (stale || changedDiscovery) {
      const oldRound = t.planningAttempts?.at(-1)
      const cause = staleReason(name, oldRound, taskContextSnapshot(state, t), planningContext(state, t))
      closePlanning(t, 'superseded', cause)
      superseded.push({ workflow: 'planning', round: oldRound?.n, cause })
    }
    if (discovery && !t.discussionRequired) {
      assertDiscussionBoundary(discovery, [id], { acceptPremature: args['accept-premature-work'] === true })
      const fields = ['research', 'questions', 'coverage', 'decisions', 'deferred', 'executionBoundary', 'closure']
      t.discovery = { ...Object.fromEntries(fields.map(field => [field, discovery[field]])),
        recordedAt: new Date().toISOString(), context: planningContext(state, t),
        attempt: t.attempts.length + (t.planningReturn ? 0 : 1), digest }
    }
    beginPlanning(state, t, agent, planningContext(state, t), digest)
    saveState(name, state)
    emit(name, 'task_planning', id, { planner: agent, round: t.planningAttempts.length,
      ...(discovery ? { discoveryQuestions: discovery.questions.length } : {}) })
    log(`[prumo] ${id} in planning (planner ${agent}, round ${t.planningAttempts.length})`)
    logSupersededRounds(id, superseded)
    log('[prumo] planner guard: read-only research may determine how to execute; task results and acceptance evidence belong to the executor')
  },

  'skip-planning'() {
    const name = runName()
    const id = args._[0] ?? die('skip-planning <task> --reason <text> --confirmed-by-user')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase' && !state.tasks[id]?.individualPlanning) die('this run uses phase planning; use skip-phase-planning')
    const task = getTask(state, id)
    if (!['pending', 'failed'].includes(task.state)) die(`${id} must be pending or failed to skip planning`)
    if (!usesCurrentPlanning(state, task)) die(`${id} is a legacy task without current planning gates`)
    if (task.contractConfirmationRequired)
      die(tr('{0} requires a fresh answered contract confirmation; finish the discussion before skipping planning', id))
    if (task.discussionRequired && !currentTaskDiscussionDecision(state, task))
      die(`${id} needs a completed discussion or an explicit user-confirmed discussion skip`)
    const decision = { ...explicitSkipDecision('skip-planning'), task: id,
      scope: phasePlanningContext(state, task), context: planningContext(state, task),
      contextSnapshot: taskContextSnapshot(state, task) }
    task.planningSkips ??= []
    task.planningSkips.push(decision)
    delete task.retryPlan
    task.state = 'pending'
    saveState(name, state)
    emit(name, 'task_planning_skipped', id, { decisionId: decision.decisionId,
      reason: decision.reason, confirmedByUser: true })
    log(`[prumo] ${id} planning skipped by explicit user choice; ready to execute when dependencies allow`)
  },

  'finish-planning'() {
    const name = runName()
    const id = args._[0] ?? die('finish-planning <task> --plan <task-plan.json>')
    if (typeof args.plan !== 'string' || !args.plan.trim()) die('finish-planning needs --plan <task-plan.json>')
    const state = loadState(name)
    if (state.plan.planningMode === 'phase' && !state.tasks[id]?.individualPlanning) die('this run uses phase planning; use finish-phase-planning')
    const t = getTask(state, id)
    if (t.state !== 'planning') die(id + ' is not in planning')
    const round = t.planningAttempts?.at(-1)
    if (!round || round.endedAt || round.agent !== t.planner) die('planning needs an open round and its recorded planner')
    const currentContext = planningContext(state, t)
    if (round.context !== currentContext)
      die(tr('task planning is stale: {0} — run plan-task again and research the current contract',
        staleReason(name, round, taskContextSnapshot(state, t), currentContext)))
    const skippedDiscussion = currentTaskDiscussionSkip(state, t)
    if (t.discoveryRequired && !skippedDiscussion && (!t.discovery?.digest || t.discovery.digest !== discoveryDigest(t.discovery) ||
        round.discoveryDigest !== t.discovery.digest || t.discovery.context !== round.context ||
        t.discovery.attempt !== round.attempt))
      die('task planning used stale discovery — run plan-task with the current discovery context')
    if (t.deps.some(dep => !['done', 'skipped'].includes(state.tasks[dep]?.state))) die('planning dependencies are no longer complete')
    let plan
    const path = resolve(args.plan), filename = basename(path)
    try {
      plan = readPlanningArtifact(path)
      assertTaskPlan(t, plan)
      validateQuestionDeadlines(state, id, plan.openQuestions)
    } catch (error) { die(planningArtifactError(filename, error)) }
    const questionRefs = validateQuestionResolutions(state, plan.decisions)
    warnTaskPlan(t, plan, state)
    const artifact = Object.fromEntries(['summary', 'research', 'decisions', 'steps', 'verification', 'openQuestions', 'writes'].map(field => [field, plan[field]]))
    artifact.openQuestions = annotatePlanQuestions(t, artifact.openQuestions, round.startedAt)
    t.taskPlan = { ...artifact, sourcePath: path, digest: taskPlanDigest(artifact), planner: t.planner, startedAt: round.startedAt, completedAt: new Date().toISOString(),
      context: round.context, scope: planningContext(state, t, { scopeOnly: true }), attempt: round.attempt,
      ...(round.discoveryDigest ? { discoveryDigest: round.discoveryDigest } : {}),
      ...(skippedDiscussion ? { discussionDecision: 'skipped', discussionDecisionId: skippedDiscussion.decisionId,
        discussionDecisionDigest: skippedDiscussion.digest } : {}) }
    t.planningHistory.push(t.taskPlan)
    delete t.retryPlan
    closePlanning(t, 'planned')
    round.artifactCount = 1
    t.state = t.planningReturn ? 'blocked' : 'pending'
    if (t.planningReturn) {
      Object.assign(t, t.planningReturn)
      delete t.planningReturn
    }
    recordQuestionResolutions(state, questionRefs, plan.decisions, { task: id })
    saveState(name, state)
    emit(name, 'task_planned', id, { planner: t.planner, round: t.planningAttempts.length, state: t.state })
    if (t.state === 'blocked') log(`[prumo] ${id} task plan recorded; still blocked — unblock explicitly to resume the current attempt`)
    else log(`[prumo] ${id} ready to execute (task plan recorded by ${t.planner})`)
    printPlannedQuestionSummary([t])
  },

  start() {
    const name = runName()
    const id = args._[0] ?? die('start <task> --agent <name>')
    if (args.agent && args.executor && args.agent !== args.executor) die('start: --agent and --executor must name the same agent')
    const agent = args.agent ?? args.executor ?? die('start needs --agent <name> (alias: --executor)')
    if (typeof agent !== 'string' || !agent.trim()) die('start needs a nonempty agent name')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'pending') die(`${id} is ${t.state}, not pending`)
    const unscoped = assertTaskExecutionAuthorized(state, t)
    const dispatchConfirmation = manualDispatchConfirmation(t, 'manual authorization for {0} requires --confirmed-by-user before dispatch')
    assertNoOverdueQuestions(state, t)
    if (!hasCurrentTaskPlan(state, t)) die(state.plan.planningMode === 'phase' && t.phase
      ? `${id} needs completed current planning for phase ${t.phase} — run begin-phase-discussion ${t.phase}, finish-phase-discussion, plan-phase and finish-phase-planning before start`
      : id + ' needs completed current planning — run plan-task and finish-planning before start')
    try { validationContract(t) } catch (error) {
      die(`${id} has an invalid legacy validation contract: ${error.message} — correct the approved plan and run sync-plan before start`)
    }
    try { assertValidationEnvironment(t) } catch (error) { die(error.message) }
    assertAvailable(state, t, 'running', agent)
    let inputReceipt
    if (t.taskPlan?.phaseId || currentPlanningSkip(state, t)) {
      try { inputReceipt = executionInputReceipt(state, t) } catch (error) { die(error.message) }
    }
    const planDigest = t.taskPlan ? taskPlanDigest(t.taskPlan) : undefined
    if (planDigest) t.taskPlan.digest = planDigest
    let deliveryBaseline
    if (t.project && captureScopeBaseline(t.project).method !== 'git') die(tr('task {0} project must be an accessible Git repository root: {1}', id, t.project))
    try { deliveryBaseline = captureDelivery(t, t.project ?? state.plan.cwd) } catch (error) { die(error.message) }
    const concurrentScopes = recordConcurrentScopes(state, t)
    t.state = 'running'
    t.agent = agent
    t.attempts.push({ n: t.attempts.length + 1, agent, startedAt: new Date().toISOString(), deliveryBaseline,
      ...(state.plan.scopePolicy === 'explicit' ? { scopeBaseline: captureScopeBaseline(t.project ?? state.plan.cwd) } : {}),
      ...(state.plan.scopePolicy === 'explicit' ? { concurrentScopes } : {}),
      activityTiming: 'explicit', activityIntervals: [],
      ...(t.retryPlan?.attempt === t.attempts.length + 1 ? {
        planSourceAttempt: t.retryPlan.planSourceAttempt,
        correctionOf: t.retryPlan.failedAttempt, correctionReason: t.retryPlan.reason,
      } : {}), ...(planDigest ? { planDigest } : {}),
      ...(inputReceipt ? { inputReceipt: inputReceipt.inputs, inputDigest: inputReceipt.digest } : {}) })
    recordManualConfirmation(t.attempts.at(-1), 'dispatch', dispatchConfirmation)
    const total = t.taskPlan?.steps?.length
    if (total) t.attempts.at(-1).executionStep = 1
    saveState(name, state)
    emit(name, 'task_start', id, { agent, attempt: t.attempts.length,
      ...(planDigest ? { planDigest: planDigest.slice(0, 4) } : {}),
      ...(dispatchConfirmation ? { manualDispatchConfirmation: dispatchConfirmation } : {}),
      ...(total ? { current: 1, total } : {}) })
    log(`[prumo] ${id} running (agent ${agent}, attempt ${t.attempts.length})`)
    if (concurrentScopes.length) log('[prumo] ' + tr('If concurrent deliveries changed files outside this task, the independent reviewer needs: validate {0} --ok --evidence <evidence> --scope-evidence <paths and attribution>', id))
    if (t.taskPlan) log('[prumo] current recorded plan: ' + JSON.stringify(recordedPlanIdentity(t)))
    if (unscoped)
      log('[prumo] ' + tr('no execution authorization scope is recorded for this run; {0} started as before — record the user scope with authorize to enable automatic dispatch', id))
    if (total) {
      const shell = invokingShell()
      const quote = value => quoteCommandArg(value, shell)
      const command = [...(shell === 'powershell' ? ['&'] : []), quote(process.execPath),
        quote(process.argv[1]), 'progress', quote(id), '--step', '1', '--agent',
        quote(agent), '--run', quote(name)].join(' ')
      log('[prumo] report each actual execution step with:')
      console.log(command)
    }
  },

  progress() {
    const name = runName()
    const id = args._[0] ?? die('progress <task> --step <index> --agent <executor>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'running') die(`${id} is ${t.state}, not running`)
    assertCurrentTaskScope(state, t)
    assertCurrentExecutionInputs(state, t)
    if (!args.agent || args.agent !== t.agent) die('progress needs the current executor agent')
    const current = Number(args.step), total = t.taskPlan?.steps?.length
    if (!total || !Number.isSafeInteger(current) || current < 1 || current > total)
      die('progress step must be an index in the current task plan')
    const attempt = t.attempts.at(-1)
    if (current < (attempt.executionStep ?? 1)) die('progress cannot move backwards within an attempt')
    if (current === attempt.executionStep) {
      log(`[prumo] ${id} execution position already recorded at ${current}/${total} (agent ${t.agent}, attempt ${t.attempts.length}); position is not completion evidence`)
      return
    }
    attempt.executionStep = current
    saveState(name, state)
    emit(name, 'task_progress', id, { agent: t.agent, attempt: t.attempts.length, current, total })
    log(`[prumo] ${id} execution position recorded at ${current}/${total} (agent ${t.agent}, attempt ${t.attempts.length}); position is not completion evidence`)
  },

  /** Entregue uma tarefa concluída a um REVIEWER — um agente diferente, com contexto novo, que nunca
   *  viu o trabalho sendo escrito. Este é o portão que faz `done` significar algo. */
  review() {
    const name = runName()
    const id = args._[0] ?? die('review <task> --agent <name>')
    const reviewer = args.agent ?? die('review needs --agent <name>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'running') die(`${id} is ${t.state}, not running`)
    assertReauthorizedAfterContractChange(t)
    const dispatchConfirmation = manualDispatchConfirmation(t, 'manual authorization for {0} requires --confirmed-by-user before dispatch')
    assertCurrentTaskScope(state, t)
    assertCurrentExecutionInputs(state, t)
    if (reviewer === t.agent && !args.force)
      die(`"${reviewer}" wrote ${id} — a reviewer must be a different agent (or --force)`)
    // A revisão substitui o executor no mesmo slot; também respeita reduções do limite.
    assertAvailable(state, t, 'reviewing', reviewer)
    try { checkDelivery(state, t, state.plan.cwd) } catch (error) { die(error.message) }
    const slotsBeforeReview = executionSlots(state)
    t.state = 'reviewing'
    t.reviewer = reviewer
    t.attempts.at(-1).reviewer = reviewer
    t.attempts.at(-1).reviewStartedAt = new Date().toISOString()
    const denominator = reviewDenominator(t)
    reviewProgressRecord(t, reviewer, denominator)
    recordManualConfirmation(t.attempts.at(-1), 'review', dispatchConfirmation)
    saveState(name, state)
    emit(name, 'task_review', id, { reviewer, attempt: t.attempts.length,
      ...(denominator ? { current: 1, total: denominator.total, basis: denominator.basis } : {}),
      ...(dispatchConfirmation ? { manualDispatchConfirmation: dispatchConfirmation } : {}) })
    log(`[prumo] ${id} in review (reviewer ${reviewer})`)
    const executedStep = t.attempts.at(-1).executionStep ?? 1
    if (t.taskPlan?.steps?.length > 1 && executedStep < t.taskPlan.steps.length)
      log(`[prumo] WARNING: executor progress stayed at ${executedStep}/${t.taskPlan.steps.length}; the position is not proof of completed work`)
    announceFreedSlot(name, state, id, 'review', slotsBeforeReview)
    printDispatchSuggestions(state)
  },

  'review-progress'() {
    const name = runName()
    const id = args._[0] ?? die('review-progress <task> --step <index> --agent <reviewer>')
    const state = loadState(name)
    const t = getTask(state, id)
    const reviewDisabled = (t.requireReview ?? state.plan.requireReview) === false
    const agent = t.state === 'reviewing' ? t.reviewer : t.state === 'running' && reviewDisabled ? t.agent : null
    if (!agent) die(`${id} is not in review`)
    if (!args.agent || args.agent !== agent) die('review-progress needs the current reviewing agent')
    assertCurrentTaskScope(state, t)
    assertCurrentExecutionInputs(state, t)
    const denominator = reviewDenominator(t)
    if (!denominator) die(`${id} has no structured review progress denominator; legacy criteria keep progress unknown`)
    const step = positiveIndex(args.step, 'review-progress step')
    if (step > denominator.total) die(`review-progress step must be between 1 and ${denominator.total}`)
    const attempt = t.attempts.at(-1)
    let progress = attempt.reviewProgress
    if (!progress || progress.total !== denominator.total || progress.basis !== denominator.basis ||
        progress.agent !== agent || progress.contractRevision !== (t.contractRevision ?? 0) ||
        progress.scopeRevision !== (t.scopeRevision ?? 0)) {
      progress = reviewProgressRecord(t, agent, denominator)
    }
    if (step <= progress.traversed) {
      log(`[prumo] ${id} review progress already reports ${progress.traversed}/${progress.total} criteria traversed; no state change; reviewer report is not proof of inspection or approval`)
      return
    }
    if (step !== progress.current)
      die(`review-progress must traverse the next criterion in order: expected ${progress.current}, received ${step}`)
    progress.traversed = step
    progress.current = Math.min(step + 1, progress.total)
    progress.selfReported = true
    progress.reportedAt = new Date().toISOString()
    saveState(name, state)
    emit(name, 'task_review_progress', id, { reviewer: agent, attempt: t.attempts.length,
      current: progress.current, total: progress.total, traversed: progress.traversed, basis: progress.basis,
      selfReported: true })
    if (progress.traversed === progress.total)
      log(`[prumo] ${id} review progress reports ${progress.traversed}/${progress.total} criteria traversed; reviewer report is not proof of inspection or approval`)
    else log(`[prumo] ${id} review progress reports ${progress.traversed}/${progress.total} criteria traversed; next criterion ${progress.current}/${progress.total}; reviewer report is not proof of inspection`)
  },

  'refresh-contract'() {
    const name = runName()
    const id = args._[0] ?? die('refresh-contract <task> --plan <approved-plan.json>')
    const state = loadState(name)
    const task = getTask(state, id)
    if (['done', 'skipped'].includes(task.state)) die('completed task contracts are immutable; create an explicit follow-up task')
    const source = args.plan ?? state.plan.source ?? die('refresh-contract needs --plan <approved-plan.json>')
    const plan = JSON.parse(readFileSync(resolve(source), 'utf8'))
    const matches = Array.isArray(plan.tasks) ? plan.tasks.filter((candidate) => candidate?.id === id) : []
    if (matches.length !== 1) die('approved plan must contain exactly one task ' + id)
    const fields = ['validation', 'validationMode', 'inspectionReason']
    const changes = Object.fromEntries(fields.map((field) => [field, matches[0][field]]))
    try { validationContract({ ...task, ...changes }) } catch (e) { die(e.message) }
    if (fields.every((field) => JSON.stringify(task[field]) === JSON.stringify(changes[field]))) {
      log('[prumo] ' + id + ' validation contract already matches; state and attempt unchanged')
      return
    }
    const authorization = task.executionAuthorization
    if (authorization) {
      task.authorizationHistory ??= []
      task.authorizationHistory.push({ ...authorization, revokedAt: new Date().toISOString(),
        revokeReason: 'refresh-contract changed this task validation contract' })
      delete task.executionAuthorization
    }
    Object.assign(task, changes)
    task.contractRevision = (task.contractRevision ?? 0) + 1
    saveState(name, state)
    emit(name, 'task_contract_refreshed', id, { revision: task.contractRevision, attempt: task.attempts.length, state: task.state,
      source: resolve(source), authorizationRevoked: Boolean(authorization) })
    log('[prumo] ' + tr('{0} contract refreshed; state {1}, attempt {2} preserved; previous validation receipts are stale',
      id, task.state, task.attempts.length))
    if (authorization)
      log('[prumo] ' + tr('execution authorization revoked for {0}; ask the user to accept the changed contract before another dispatch', id))
  },

  async validate() {
    const name = runName()
    const id = args._[0] ?? die('validate <task> --ok|--failed --evidence "<text>" [--cwd <project>]')
    const requestedOk = args.ok === true ? true : args.failed === true ? false : die('pass --ok or --failed')
    if (typeof args.evidence !== 'string' || !args.evidence.trim()) die('validation evidence must not be empty')
    if (args.summary !== undefined && (typeof args.summary !== 'string' || !args.summary.trim()))
      die('validation summary must be a nonempty string when present')
    const tail = tailLineLimit(args.tail)
    const token = randomUUID()
    const snapshot = withLock(name, () => {
      const state = loadState(name)
      if (state.runPause && !state.runPause.endedAt) die('Run is paused; resume-run explicitly. External harness processes are not interrupted.')
      const t = getTask(state, id)
      assertExternalBlockAction(state, id)
      if (t.state !== 'running' && t.state !== 'reviewing') die(id + ' is not running or reviewing')
      if (requestedOk) {
        assertNoOverdueQuestions(state, t)
        assertCurrentTaskScope(state, t)
        assertCurrentExecutionInputs(state, t)
      }
      const by = t.state === 'reviewing' ? 'review' : 'executor'
      if (requestedOk && (t.requireReview ?? state.plan.requireReview) !== false &&
          (by !== 'review' || !t.reviewer || t.reviewer === t.agent))
        die('passing validation requires an independent reviewer')
      const denominator = reviewDenominator(t)
      if (requestedOk && denominator?.inspection) {
        const progress = t.attempts.at(-1)?.reviewProgress
        const reviewer = by === 'review' ? t.reviewer : t.agent
        if (!progress || progress.total !== denominator.total || progress.traversed !== denominator.total ||
            progress.selfReported !== true ||
            progress.basis !== denominator.basis || progress.agent !== reviewer ||
            progress.contractRevision !== (t.contractRevision ?? 0) || progress.scopeRevision !== (t.scopeRevision ?? 0))
          die(`${id} inspection criteria are not fully traversed; record reviewer-reported progress for each criterion with review-progress ${id} --step <index> --agent ${reviewer} (this is not proof of inspection)`)
      }
      if (requestedOk) {
        if (state.plan.scopePolicy === 'explicit') {
          const reason = scopeEvidenceRequirement(t, t.attempts.at(-1)?.scopeBaseline, t.attempts.at(-1)?.concurrentScopes)
          if (reason && (!args['scope-evidence']?.trim() || by !== 'review' || !t.reviewer || t.reviewer === t.agent))
            die(tr('Independent reviewer --scope-evidence is required before validation ({0}); provide inspected paths and attribution; no checks or receipt were recorded', tr(reason)))
        }
        if (t.project && args.cwd && !sameProject(t, { project: args.cwd }))
          log('[prumo] ' + tr('WARNING: validation --cwd {0} differs from task project {1}; scope and delivery checks remain bound to the approved project', args.cwd, t.project))
        try { assertValidationEnvironment(t); validationDirectories(t, args.cwd) } catch (error) { die(error.message) }
      }
      // Invalide qualquer aprovação anterior antes de executar comandos, inclusive em caso de interrupção.
      t.validations.push({ ok: false, by, agent: by === 'review' ? t.reviewer : t.agent,
        evidence: args.evidence, ...(args.summary === undefined ? {} : { summary: args.summary }),
        at: new Date().toISOString(), attempt: t.attempts.length, token,
        ...(t.planningRequired ? { planningScope: currentPlanningScope(state, t) } : {}) })
      saveState(name, state)
      emit(name, 'task_validation_started', id, { token, attempt: t.attempts.length })
      return { ...t, evidenceState: { run: state.run, plan: state.plan, tasks: state.tasks }, explicitScopeRequired: state.plan.scopePolicy === 'explicit' }
    })
    // Testes não devem manter o bloqueio da execução: outras tarefas e o dashboard continuam utilizáveis.
    let result = {}
    let error = null
    if (requestedOk) {
      try {
        result.deliveryCheck = checkDelivery(snapshot.evidenceState, snapshot, snapshot.evidenceState.plan.cwd)
        result.numericProvenance = verifyNumericProvenance(snapshot, snapshot.evidenceState.plan.cwd)
        const previous = snapshot.validations.slice(0, -1).reverse().find(receipt =>
          receipt.by === snapshot.validations.at(-1).by && receipt.checks?.length)
        const reusablePrevious = result.numericProvenance && previous?.numericProvenance?.fingerprint !== result.numericProvenance.fingerprint ? undefined : previous
        const validationResult = await runValidation(snapshot, args.cwd, reusablePrevious, check => {
          withLock(name, () => {
            const current = getTask(loadState(name), id)
            if (current.validations.at(-1)?.token !== token || current.state !== snapshot.state ||
                current.attempts.length !== snapshot.attempts.length || current.agent !== snapshot.agent ||
                current.reviewer !== snapshot.reviewer ||
                (current.contractRevision ?? 0) !== (snapshot.contractRevision ?? 0) ||
                (current.scopeRevision ?? 0) !== (snapshot.scopeRevision ?? 0) ||
                (current.stateRevision ?? 0) !== (snapshot.stateRevision ?? 0)) return
            emit(name, 'task_check', id, { ...check, token, attempt: snapshot.attempts.length,
              by: snapshot.validations.at(-1).by })
          })
        })
        Object.assign(result, validationResult)
        if (JSON.stringify(verifyNumericProvenance(snapshot, snapshot.evidenceState.plan.cwd)) !== JSON.stringify(result.numericProvenance)) throw new Error('Provenance sources changed during validation; validate again')
        if (checkDelivery(snapshot.evidenceState, snapshot, snapshot.evidenceState.plan.cwd).fingerprint !== result.deliveryCheck.fingerprint) throw new Error('Delivery changed during validation; validate again')
        printValidationTail(result.checks ?? [], tail)
        assertValidation(snapshot, { ...result, evidence: args.evidence })
        if (snapshot.explicitScopeRequired) result.scopeCheck = verifyTaskScope(snapshot, snapshot.attempts.at(-1)?.scopeBaseline,
          snapshot.state === 'reviewing' && snapshot.reviewer ? { evidence: args['scope-evidence'], agent: snapshot.reviewer } : undefined, snapshot.attempts.at(-1)?.concurrentScopes)
      } catch (e) { error = e.message }
    }
    withLock(name, () => {
      const state = loadState(name)
      const t = getTask(state, id)
      const last = t.validations.at(-1)
      if (t.state !== snapshot.state || t.attempts.length !== snapshot.attempts.length ||
          t.agent !== snapshot.agent || t.reviewer !== snapshot.reviewer || last?.token !== token ||
          (t.contractRevision ?? 0) !== (snapshot.contractRevision ?? 0) ||
          (t.scopeRevision ?? 0) !== (snapshot.scopeRevision ?? 0) ||
          (t.stateRevision ?? 0) !== (snapshot.stateRevision ?? 0) ||
          JSON.stringify([t.validation, t.validationMode, t.inspectionReason]) !==
          JSON.stringify([snapshot.validation, snapshot.validationMode, snapshot.inspectionReason]))
        die('task changed during validation; result discarded — validate the current attempt again')
      if (requestedOk) {
        try { assertNoOverdueQuestions(state, t) } catch (questionError) { error ??= questionError.message }
        assertCurrentExecutionInputs(state, t)
      }
      Object.assign(last, result, { ok: requestedOk && !error, error, at: new Date().toISOString() })
      if (last.by === 'review') stopOpenActivity(t.attempts.at(-1), last.at)
      saveState(name, state)
      emit(name, 'task_validate', id, { ok: last.ok, by: last.by, evidence: last.evidence,
        ...(last.summary === undefined ? {} : { summary: last.summary }), error })
      log('[prumo] ' + id + ' validation recorded by ' + last.by + ': ' + (last.ok ? 'OK' : 'FAILED'))
      if (last.summary !== undefined) log('[prumo] ' + tr('Recorded summary: {0}', last.summary))
      const preview = last.evidence.split(/\r?\n/).slice(0, 5).join('\n').slice(0, 1000)
      log('[prumo] ' + tr('Recorded evidence (first 5 lines, up to 1000 characters; {0} characters total):', last.evidence.length))
      log(preview)
      if (last.scopeCheck) log('[prumo] ' + tr('Scope check: method {0}; paths: {1}; excluded paths: {2}',
        last.scopeCheck.method, (last.scopeCheck.paths ?? []).join(', ') || tr('none'),
        (last.scopeCheck.excludedPaths ?? []).join(', ') || tr('none')))

    })
    if (error) die(error)
  },

  done() {
    const name = runName()
    const id = args._[0] ?? die('done <task>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'running' && t.state !== 'reviewing')
      die(`${id} is ${t.state}, not running or reviewing`)
    assertNoOverdueQuestions(state, t)
    assertCurrentTaskScope(state, t)
    assertCurrentExecutionInputs(state, t)
    const last = t.validations.at(-1)
    if (!last || !last.ok || last.attempt !== t.attempts.length)
      die(`${id} has no passing validation for the current attempt — validate first`)
    if (t.planningRequired && last.planningScope !== currentPlanningScope(state, t))
      die('execution scope changed after validation — validate the current scope again')
    /* O martelo pertence ao revisor. Uma validação que o executor registrou sobre seu próprio
       trabalho é um autorrelato, e esse é exatamente o motivo pelo qual a divisão de papéis não o considera. */
    if ((t.requireReview ?? state.plan.requireReview) !== false && last.by !== 'review')
      die(`${id} was validated by the ${last.by ?? 'executor'}, not a reviewer — run \`review ${id} --agent <name>\` first`)
    if (last.by === 'review' && (!t.reviewer || last.agent !== t.reviewer || t.reviewer === t.agent))
      die('passing validation requires the current independent reviewer')
    try { assertValidation(t, last) } catch (e) { die(e.message) }
    if (state.plan.scopePolicy === 'explicit') {
      try {
        const scope = verifyTaskScope(t, t.attempts.at(-1)?.scopeBaseline,
          last.scopeCheck?.method === 'independent-review' && last.scopeCheck.agent === t.reviewer ? last.scopeCheck :
            last.scopeCheck?.independentEvidence?.agent === t.reviewer ? last.scopeCheck.independentEvidence : undefined, t.attempts.at(-1)?.concurrentScopes)
        if (scope.method === 'git' && scope.fingerprint !== last.scopeCheck?.fingerprint) die('Delivery changed after scope validation; validate again')
      } catch (error) { die(error.message) }
    }
    try {
      const delivery = checkDelivery(state, t, state.plan.cwd)
      if (last.deliveryCheck && delivery.fingerprint !== last.deliveryCheck.fingerprint) die('Delivery changed after validation; validate again')
      if (JSON.stringify(verifyNumericProvenance(t, state.plan.cwd)) !== JSON.stringify(last.numericProvenance ?? null)) die('Provenance changed after validation; validate again')
    } catch (error) { die(error.message) }
    const previouslyEligible = eligibleDiscussionPhases(state)
    const slotsBeforeDone = executionSlots(state)
    t.state = 'done'
    t.attempts.at(-1).endedAt = new Date().toISOString()
    t.attempts.at(-1).result = 'done'
    saveState(name, state)
    emit(name, 'task_done', id, { agent: t.agent })
    const unlocked = Object.values(derive(state)).filter(
      (o) => ['ready_to_plan', 'ready'].includes(o.effective) && o.deps.includes(id),
    )
    log(`[prumo] ${id} done${unlocked.length ? ` — unlocked: ${unlocked.map((u) => u.id).join(', ')}` : ''}`)
    announceNewlyEligiblePhases(name, previouslyEligible, state, 'done')
    announceFreedSlot(name, state, id, 'done', slotsBeforeDone)
    printDispatchSuggestions(state)
  },

  fail() {
    const name = runName()
    const id = args._[0] ?? die('fail <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'running' && t.state !== 'reviewing')
      die(`${id} is ${t.state}, not running or reviewing`)
    const failedFrom = t.state
    t.state = 'failed'
    const a = t.attempts.at(-1)
    a.endedAt = new Date().toISOString()
    a.result = 'failed'
    a.reason = args.reason ?? ''
    a.failedFrom = failedFrom
    a.planDefect = args['plan-defect'] === true
    saveState(name, state)
    emit(name, 'task_fail', id, { reason: args.reason ?? '', attempt: t.attempts.length,
      failedFrom, planDefect: a.planDefect })
    log(`[prumo] ${id} failed (attempt ${t.attempts.length}): ${args.reason ?? ''}`)
  },

  retry() {
    const name = runName()
    const id = args._[0] ?? die('retry <task>')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'failed') die(`${id} is ${t.state}, not failed`)
    assertReauthorizedAfterContractChange(t)
    const retryConfirmation = manualDispatchConfirmation(t, 'manual authorization for {0} requires --confirmed-by-user before retry')
    if (state.plan.source && existsSync(state.plan.source)) {
      const { plan } = readPlan(state.plan.source, state)
      if (!plan.tasks.some(candidate => candidate.id === id))
        die(`approved plan no longer contains ${id} — inspect it before retry`)
      const drift = contractDrift(state, { plan })
      const taskChanges = drift.tasks.find(item => item.task === id)
      const changed = taskChanges?.fields ?? []
      if (changed.length) die(`${id} contract differs from the approved plan (${changed.join(', ')}) — run sync-plan and inspect the persisted contract before retry`)
      const globalChanges = drift.planFields
      if (globalChanges.length)
        die(`${id} global plan decisions differ from the approved plan (${globalChanges.join(', ')}) — run sync-plan and inspect the persisted plan before retry`)
    }
    const cap = t.maxAttempts ?? MAX_ATTEMPTS_SOFT
    if (t.attempts.length >= cap && !args.force)
      die(`${id} already has ${t.attempts.length} attempts (cap ${cap}) — escalate instead, or --force`)
    const failed = t.attempts.at(-1)
    recordManualConfirmation(failed, 'retry', retryConfirmation)
    const planningSkipped = currentPlanningSkip(state, t)
    const planSourceAttempt = t.taskPlan?.attempt
    const reuse = Boolean(planningSkipped || (t.planningRequired && failed?.failedFrom === 'reviewing' && !failed.planDefect &&
      typeof failed.reason === 'string' && failed.reason.trim() && Number.isSafeInteger(planSourceAttempt) &&
      hasCurrentTaskScope(state, t, planSourceAttempt)))
    if (reuse) {
      const attempt = t.attempts.length + 1
      t.retryPlan = {
        ...(planningSkipped ? { skippedPlanning: true } : { planSourceAttempt }),
        failedAttempt: t.attempts.length, attempt, reason: failed.reason,
        ...(!planningSkipped ? { discoveryDigest: t.discovery?.digest,
          planContext: t.taskPlan.context, planScope: t.taskPlan.scope } : {}),
        context: planningContext(state, t, { attempt }),
        scope: planningContext(state, t, { scopeOnly: true, attempt }),
      }
    } else {
      delete t.retryPlan
      if (t.taskPlan?.phaseId && failed?.planDefect) t.phasePlanDefect = true
    }
    t.state = 'pending'
    t.agent = null
    t.reviewer = null
    saveState(name, state)
    emit(name, 'task_retry', id, { nextAttempt: t.attempts.length + 1,
      reusedPlan: Boolean(reuse && !planningSkipped), reusedPlanningSkip: Boolean(planningSkipped),
      ...(retryConfirmation ? { manualRetryConfirmation: retryConfirmation } : {}),
      ...(reuse ? { reason: failed.reason, ...(!planningSkipped ? { planSourceAttempt } : {}),
        failedAttempt: t.attempts.length } : {}) })
    log(`[prumo] ${id} back to pending (attempt ${t.attempts.length + 1} when started; ${planningSkipped ? 'approved planning skip reused' : reuse ? 'approved plan reused' : 'planning required'})`)
    if (reuse && !planningSkipped) log('[prumo] reused recorded plan: ' + JSON.stringify(recordedPlanIdentity(t)))
  },

  block() {
    const name = runName()
    const id = args._[0] ?? die('block <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    const question = args.question === undefined ? undefined :
      typeof args.question === 'string' && args.question.trim() ? args.question.trim() : die(tr('block --question must be nonempty'))
    const options = args.option === undefined ? undefined :
      (Array.isArray(args.option) ? args.option : [args.option]).map(value => typeof value === 'string' && value.trim() ? value.trim() :
        die(tr('block --option values must be nonempty')))
    if (options && question === undefined && !t.blockQuestion)
      die(tr('block --option requires --question'))
    if (['done', 'skipped'].includes(t.state)) die('completed tasks cannot be paused')
    const alreadyBlocked = t.state === 'blocked'
    if (cmd === 'pause-replanning' && (!t.planningRequired || !['running', 'reviewing'].includes(t.stateBeforeBlock ?? t.state) || t.blockQuestion))
      die('pause-replanning requires an active attempt needing a revised plan, without an external question')
    if (t.state === 'planning') closePlanning(t, 'blocked')
    if (t.state === 'discussing') closeDiscussion(t, 'blocked')
    if (!alreadyBlocked) t.stateBeforeBlock = t.state
    t.stateRevision = (t.stateRevision ?? 0) + 1
    t.state = 'blocked'
    t.blockKind = cmd === 'pause-replanning' ? 'replan' : 'external'
    if (cmd === 'pause-replanning' && state.plan.planningMode === 'phase' && t.phase) t.individualPlanning = true
    t.blockReason = args.reason ?? ''
    if (question !== undefined) {
      if (t.blockQuestion !== question && options === undefined) delete t.blockOptions
      t.blockQuestion = question
    }
    if (options !== undefined) t.blockOptions = [...new Set(options)]
    excludeBlockedPhaseTask(state, t)
    saveState(name, state)
    emit(name, alreadyBlocked ? 'task_block_updated' : 'task_block', id, { reason: args.reason ?? '', blockKind: t.blockKind,
      ...(t.blockQuestion ? { question: t.blockQuestion } : {}), ...(t.blockOptions ? { options: t.blockOptions } : {}) })
    log(`[prumo] ${id} blocked: ${args.reason ?? ''}`)
  },

  'pause-replanning'() { commands.block() },

  unblock() {
    const name = runName()
    const id = args._[0] ?? die('unblock <task> [--reviewer <agent>]')
    const state = loadState(name)
    const t = getTask(state, id)
    if (t.state !== 'blocked') die(id + ' is ' + t.state + ', not blocked')
    const answer = args.answer === undefined ? undefined :
      typeof args.answer === 'string' && args.answer.trim() ? args.answer.trim() : die(tr('unblock --answer must be nonempty'))
    if (t.blockQuestion && answer === undefined) die(tr('unblock needs --answer to resolve the current block question'))
    if (!t.blockQuestion && answer !== undefined) die(tr('unblock --answer requires a current block question'))
    // Tarefas legadas não iniciadas podem voltar a pending; nunca adivinhe a fase de uma tentativa existente.
    const previous = t.stateBeforeBlock ?? (t.attempts.length === 0 ? 'pending' : null)
    if (!['pending', 'discussing', 'planning', 'running', 'reviewing', 'failed'].includes(previous))
      die('cannot restore stateBeforeBlock; inspect the recorded history before repairing this task')
    const handoff = args.reviewer !== undefined
    if (handoff && !['running', 'reviewing'].includes(previous))
      die('direct review requires a paused active attempt; pending/failed tasks cannot bypass start/retry')
    const needsReplanning = isExternalBlock(t) && t.planningRequired && ['running', 'reviewing'].includes(previous) && !hasCurrentTaskScope(state, t)
    if (needsReplanning && handoff) die('approved scope needs current planning before review')
    const target = needsReplanning ? 'blocked' : handoff ? 'reviewing' : previous === 'discussing' ? 'pending' : previous
    if (['running', 'reviewing'].includes(target)) assertReauthorizedAfterContractChange(t)
    const dispatchConfirmation = ['running', 'reviewing'].includes(target) ?
      manualDispatchConfirmation(t, 'manual authorization for {0} requires --confirmed-by-user to resume execution') : null
    const reviewer = handoff ? args.reviewer : t.reviewer
    if (target === 'planning') {
      const round = t.planningAttempts?.at(-1)
      if (!round || round.result !== 'blocked' || round.agent !== t.planner)
        die('cannot resume planning without its paused round and original planner')
      assertAvailable(state, t, target, t.planner)
      beginPlanning(state, t, t.planner, round.context)
    }
    if (target === 'running' || target === 'reviewing') {
      const attempt = t.attempts.at(-1)
      if (!attempt || attempt.endedAt || attempt.result || !t.agent || attempt.agent !== t.agent)
        die('cannot resume without an open attempt and its original executor')
      assertCurrentTaskScope(state, t)
      assertCurrentExecutionInputs(state, t)
      if (target === 'reviewing' && reviewer === t.agent)
        die('passing validation requires an independent reviewer')
      assertAvailable(state, t, target, target === 'reviewing' ? reviewer : t.agent)
      recordManualConfirmation(t.attempts.at(-1), 'resume', dispatchConfirmation)
      if (handoff) { try { checkDelivery(state, t, state.plan.cwd) } catch (error) { die(error.message) } }
      if (handoff && reviewer !== t.reviewer) {
        t.reviewer = reviewer
        attempt.reviewer = reviewer
        attempt.reviewStartedAt = new Date().toISOString()
      }
    }
    let reviewDenom
    if (target === 'reviewing') {
      const attempt = t.attempts.at(-1)
      reviewDenom = reviewDenominator(t)
      const progress = attempt.reviewProgress
      if (!progress || progress.agent !== reviewer || progress.total !== reviewDenom?.total ||
          progress.basis !== reviewDenom?.basis || progress.contractRevision !== (t.contractRevision ?? 0) ||
          progress.scopeRevision !== (t.scopeRevision ?? 0))
        reviewProgressRecord(t, reviewer, reviewDenom)
    }
    if (state.plan.scopePolicy === 'explicit' && (target === 'running' || target === 'reviewing')) t.attempts.at(-1).concurrentScopes = recordConcurrentScopes(state, t, true)
    t.state = target
    t.blockHistory ??= []
    t.blockHistory.push({ reason: t.blockReason ?? '', ...(t.blockQuestion ? { question: t.blockQuestion } : {}),
      ...(answer !== undefined ? { answer } : {}), at: new Date().toISOString() })
    delete t.blockReason
    delete t.blockKind
    delete t.blockQuestion
    delete t.blockOptions
    delete t.stateBeforeBlock
    if (needsReplanning) {
      t.blockKind = 'replan'
      t.blockReason = 'approved scope needs current planning'
      t.stateBeforeBlock = previous
      if (state.plan.planningMode === 'phase' && t.phase) t.individualPlanning = true
    }
    saveState(name, state)
    emit(name, 'task_unblock', id, { state: target, agent: target === 'reviewing' ? t.reviewer : target === 'planning' ? t.planner : t.agent,
      attempt: t.attempts.length, ...(answer !== undefined ? { answer } : {}),
      ...(target === 'reviewing' && reviewDenom ? { current: 1, total: reviewDenom.total, basis: reviewDenom.basis } : {}),
      ...(dispatchConfirmation ? { manualDispatchConfirmation: dispatchConfirmation } : {}) })
    log('[prumo] ' + id + ' unblocked to ' + target + '; attempt ' + t.attempts.length + ' preserved; no agent dispatched')
    const executedStep = t.attempts.at(-1)?.executionStep ?? 1
    if (target === 'reviewing' && t.taskPlan?.steps?.length > 1 && executedStep < t.taskPlan.steps.length)
      log(`[prumo] WARNING: executor progress stayed at ${executedStep}/${t.taskPlan.steps.length}; the position is not proof of completed work`)
  },

  skip() {
    const name = runName()
    const id = args._[0] ?? die('skip <task> --reason "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    if (['done', 'skipped'].includes(t.state)) die(`${id} is already terminal`)
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : die('skip requires --reason <text>')
    const previouslyEligible = eligibleDiscussionPhases(state)
    if (t.state === 'planning') closePlanning(t, 'skipped')
    if (t.state === 'discussing') closeDiscussion(t, 'skipped')
    t.state = 'skipped'
    t.skipReason = reason
    const attempt = t.attempts?.at(-1)
    if (attempt && !attempt.endedAt && !attempt.result) {
      attempt.endedAt = new Date().toISOString()
      attempt.result = 'skipped'
      attempt.reason = reason
    }
    saveState(name, state)
    emit(name, 'task_skip', id, { reason })
    log(`[prumo] ${id} skipped: ${reason}`)
    announceNewlyEligiblePhases(name, previouslyEligible, state, 'skip')
    printDispatchSuggestions(state)
  },

  note() {
    const name = runName()
    const id = args._[0] ?? die('note <task> --text "<text>"')
    const text = args.text
    if (typeof text !== 'string' || !text.trim()) die('note needs a nonempty --text "<text>"')
    const state = loadState(name)
    const t = getTask(state, id)
    t.notes.push({ text, at: new Date().toISOString() })
    saveState(name, state)
    emit(name, 'task_note', id, { text })
    const characters = Array.from(text).length
    log(`[prumo] ${id} note recorded (${characters} ${characters === 1 ? 'character' : 'characters'})`)
  },

  'activity-start'() {
    const name = runName()
    const id = args._[0] ?? die(tr('activity-start <id> --scope task|phase --role discussion|planning|execution|review --agent <name>'))
    const scope = args.scope ?? 'task'
    const role = args.role
    const agent = args.agent
    if (!['task', 'phase'].includes(scope) || !['discussion', 'planning', 'execution', 'review'].includes(role) ||
        typeof agent !== 'string' || !agent.trim()) die(tr('activity-start needs a valid scope, role and nonempty agent'))
    if (scope === 'phase' && !['discussion', 'planning'].includes(role)) die(tr('phase activity supports discussion or planning only'))
    const state = loadState(name)
    const target = scope === 'phase' ? getPhase(state, id) : getTask(state, id)
    const worker = phaseActivityWorker(state, id, scope, role, agent)
    const expectedState = { discussion: 'discussing', planning: 'planning', execution: 'running', review: 'reviewing' }[role]
    if (!worker && target.state !== expectedState) die(tr('{0} must be {1} to start {2} activity', id, expectedState, role))
    const owner = worker ?? (role === 'discussion' ? target.discussionAttempts?.at(-1) : role === 'planning' ?
      target.planningAttempts?.at(-1) : target.attempts?.at(-1))
    if (!owner || owner.endedAt) die(tr('{0} has no current {1} activity round', id, role))
    const expectedAgent = worker?.agent ?? (role === 'planning' ? target.planner : role === 'execution' ? target.agent :
      role === 'review' ? target.reviewer : owner.agent ?? owner.activityAgent)
    if (expectedAgent && expectedAgent !== agent) die(tr('{0} {1} activity belongs to {2}', id, role, expectedAgent))
    if (owner.activityIntervals?.some(interval => !interval.endedAt)) die(tr('{0} already has active work', id))
    if (owner.activityTiming !== 'explicit') {
      owner.activityTiming = 'explicit'
      owner.activityLegacy = true
      owner.activityIntervals = []
    }
    if (role === 'discussion') owner.activityAgent ??= agent
    owner.activityIntervals ??= []
    owner.activityIntervals.push({ role, agent, startedAt: new Date().toISOString() })
    saveState(name, state)
    emit(name, 'activity_start', id, { scope, role, agent })
    log('[prumo] ' + tr('{0} {1} activity started by {2}', id, role, agent))
  },

  'activity-stop'() {
    const name = runName()
    const id = args._[0] ?? die(tr('activity-stop <id> --scope task|phase --role discussion|planning|execution|review --agent <name>'))
    const scope = args.scope ?? 'task'
    const role = args.role
    const agent = args.agent
    if (!['task', 'phase'].includes(scope) || !['discussion', 'planning', 'execution', 'review'].includes(role) ||
        typeof agent !== 'string' || !agent.trim()) die(tr('activity-stop needs a valid scope, role and nonempty agent'))
    if (scope === 'phase' && !['discussion', 'planning'].includes(role)) die(tr('phase activity supports discussion or planning only'))
    const state = loadState(name)
    const target = scope === 'phase' ? getPhase(state, id) : getTask(state, id)
    const owner = phaseActivityWorker(state, id, scope, role, agent) ?? (role === 'discussion' ? target.discussionAttempts?.at(-1) : role === 'planning' ?
      target.planningAttempts?.at(-1) : target.attempts?.at(-1))
    const open = owner?.activityIntervals?.findLast(interval => !interval.endedAt)
    if (!open || open.role !== role || open.agent !== agent) die(tr('{0} has no active {1} work by {2}', id, role, agent))
    open.endedAt = new Date().toISOString()
    saveState(name, state)
    emit(name, 'activity_stop', id, { scope, role, agent })
    log('[prumo] ' + tr('{0} {1} activity stopped by {2}', id, role, agent))
  },
}

if (!cmd || !Object.hasOwn(commands, cmd)) {
  errorLog(`usage: engine.mjs <${Object.keys(commands).join('|')}> — see file header for details`)
  process.exit(1)
}

/* Leitores não precisam de bloqueio: saveState renomeia um arquivo completo para o lugar, então um leitor vê
   ou o estado anterior ou o próximo, nunca um arquivo meio gravado. Todo o restante
   usa o bloqueio da execução durante toda a leitura-modificação-gravação; validate bloqueia suas atualizações de estado
   separadamente para que a execução de comandos não sobreviva ao curto período do bloqueio. */
const READ_ONLY = new Set(['brief', 'verify-provenance', 'runs', 'status', 'ready', 'graph', 'show-contract', 'show-check'])
const LEGACY_MIGRATION_CONTINUATIONS = new Set([
  'start', 'progress', 'review', 'review-progress', 'validate', 'done', 'fail', 'retry', 'block', 'unblock', 'skip', 'refresh-contract',
  'pause-replanning',
  'activity-start', 'activity-stop',
])
function assertMigrationCommandAllowed(state, command) {
  if (READ_ONLY.has(command) || command === 'sync-plan' || command === 'note' || command === 'set-agent-limit') return
  const task = Object.hasOwn(state.tasks, args._[0]) ? state.tasks[args._[0]] : undefined
  if (command === 'finish-discussion' && task?.discussionAttempts?.some(round => !round.endedAt)) return
  if (command === 'finish-planning' && task?.planningAttempts?.some(round => !round.endedAt)) return
  const phase = Object.hasOwn(state.phaseWorkflows ?? {}, args._[0]) ? state.phaseWorkflows[args._[0]] : undefined
  if (command === 'activity-start' || command === 'activity-stop') {
    if (args.scope === 'phase' && phase && (
      phase.state === 'discussing' && phase.discussionAttempts?.some(round => !round.endedAt) ||
      phase.state === 'planning' && phase.planningAttempts?.some(round => !round.endedAt))) return
    if (args.scope !== 'phase' && task && (
      task.state === 'discussing' && task.discussionAttempts?.some(round => !round.endedAt) ||
      task.state === 'planning' && task.planningAttempts?.some(round => !round.endedAt) ||
      ['running', 'reviewing'].includes(task.state) && task.attempts?.some(attempt => !attempt.endedAt))) return
  }
  if (command === 'finish-phase-discussion' && phase?.discussionAttempts?.some(round => !round.endedAt)) return
  if (command === 'finish-phase-planning' && phase?.planningAttempts?.some(round => !round.endedAt)) return
  // Uma tentativa no modo de tarefa 1.2 carrega planningRequired, mas seu plano de tarefa foi encerrado antes da execução:
  // ela continua nesse plano registrado enquanto outros bloqueios adiam a migração estrutural.
  const openWorkflow = task?.discussionAttempts?.some(round => !round.endedAt) || task?.planningAttempts?.some(round => !round.endedAt)
  const legacyAttempt = task && (task.attempts?.length ?? 0) > 0 && (task.planningRequired !== true || !openWorkflow)
  if (legacyAttempt && LEGACY_MIGRATION_CONTINUATIONS.has(command)) return
  die('migration is blocked by unsafe in-flight planning; only legacy attempt continuation, read-only commands, sync-plan and note are allowed')
}
if (cmd === 'set-agent-limit') agentLimitChange()
if (!['init', 'runs', 'migrate', 'sync-plan'].includes(cmd)) {
  const name = runName()
  const initialState = loadState(name)
  const aliases = initialState.taskIdAliases ?? {}
  if (!cmd.includes('phase') && args._[0] && Object.hasOwn(aliases, args._[0])) args._[0] = aliases[args._[0]]
  if (args.scope?.startsWith('tasks:')) args.scope = 'tasks:' + args.scope.slice(6).split(',').map(id => Object.hasOwn(aliases, id) ? aliases[id] : id).join(',')
  const initialMigration = migrationStatus(initialState)
  // Um limite ausente usa o padrão 3; consultas e recusas não devem reescrever um plano atual.
  if (initialMigration.needed && (initialState.schemaVersion !== STATE_SCHEMA_VERSION || initialMigration.structural)) withLock(name, () => {
    const state = loadState(name)
    if (!migrationStatus(state).needed) return
    const status = migrationStatus(state)
    if (status.blockers.length) {
      errorLog('[prumo] Migration deferred: resolve unsafe in-flight planning before starting new work')
      errorLog('[prumo] Migration blockers: ' + status.blockers.join('; '))
      assertMigrationCommandAllowed(state, cmd)
    } else migrateState(name, { quiet: true })
  })
}
const BLOCKED_ACTIONS = new Set(['begin-discussion', 'finish-discussion', 'skip-discussion', 'plan-task', 'finish-planning', 'skip-planning', 'start', 'progress', 'review', 'review-progress', 'validate', 'done', 'fail', 'retry', 'skip', 'activity-start', 'pause-replanning'])
function runCommand() {
  if (BLOCKED_ACTIONS.has(cmd) && args.scope !== 'phase') assertExternalBlockAction(loadState(runName()), args._[0])
  const paused = !['init', 'runs'].includes(cmd) ? loadState(runName()).runPause : null
  if (paused && !paused.endedAt && /^(?:begin-|plan-|finish-|skip-|start$|review$|retry$|unblock$|activity-start$|validate$|done$|progress$|review-progress$)/.test(cmd)) die('Run is paused; resume-run explicitly. External harness processes are not interrupted.')
  return commands[cmd]()
}
if (cmd === 'migrate' && args.check !== true) withLock(runName(), runCommand)
else if (READ_ONLY.has(cmd) || cmd === 'validate' || cmd === 'migrate' || cmd === 'sync-plan' && args['dry-run']) await runCommand()
else withLock(runName(), runCommand)
