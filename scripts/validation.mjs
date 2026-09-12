import { log } from './i18n.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const insist = (condition, message) => { if (!condition) throw new Error(message) }
const expectedExitCodes = (step) => step.expectedExitCodes ?? [0]
const passed = (step, check) => expectedExitCodes(step).includes(check.exitCode) && !check.error && !check.signal
const failureMessage = (step, check, index, total) =>
  `validation check ${index + 1}/${total} (${step.kind ?? 'static'}) failed: ${check?.error ?? `exit ${check?.exitCode ?? 'not run'}`}; command: ${step.run} — functional failures cannot be replaced by lint`

// The plan classifies checks; only the reviewer can judge their behavioral coverage.
export function validationContract(task) {
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
    insist(['static', 'functional'].includes(step.kind ?? 'static'), 'step kind must be static or functional')
    if (step.cacheable !== undefined) insist(typeof step.cacheable === 'boolean', 'cacheable must be true or false')
    if (step.cacheable) insist((step.kind ?? 'static') === 'static', 'only static validation steps can be cacheable')
    if (step.expectedExitCodes !== undefined)
      insist(Array.isArray(step.expectedExitCodes) && step.expectedExitCodes.length > 0 &&
        step.expectedExitCodes.every((code) => Number.isInteger(code) && code >= 0 && code <= 255),
      'expectedExitCodes must be a nonempty array of integer process exit codes from 0 to 255')
    if (step.env !== undefined)
      insist(step.env !== null && typeof step.env === 'object' && !Array.isArray(step.env) &&
        Object.entries(step.env).every(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
          typeof value === 'string' && !value.includes('\0')),
      'env must map environment variable names to string values')
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

// Evidence is supplied by the planner; this gate checks completeness, not the truth of research.
export function assertTaskPlan(task, plan) {
  insist(plan && typeof plan === 'object' && !Array.isArray(plan), 'task plan must be a JSON object')
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
  insist(Array.isArray(plan.openQuestions) && plan.openQuestions.every(item => item &&
    nonempty(item.question) && typeof item.blocking === 'boolean' &&
    (item.answer === undefined || nonempty(item.answer))),
  'task plan openQuestions must contain question, blocking boolean and optional nonempty answer')
  insist(plan.openQuestions.every(item => !item.blocking || nonempty(item.answer)),
    'task plan has unanswered blocking questions; resolve them with the user before execution')
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
  }
}

// Shared by the engine and read-only dashboard: readiness must use exactly the same evidence.
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

export function hasCurrentTaskPlan(state, task) {
  if (!task.planningRequired) return true
  try { assertTaskPlan(task, task.taskPlan) } catch { return false }
  return hasCurrentTaskScope(state, task, task.attempts.length + 1) &&
    task.taskPlan.context === planningContext(state, task) && task.taskPlan.attempt === task.attempts.length + 1
}

// Validation-only refreshes do not invalidate the research behind an active execution attempt.
export function hasCurrentTaskScope(state, task, attempt = task.attempts.length) {
  if (!task.planningRequired) return true
  const plan = task.taskPlan
  return nonempty(plan?.planner) && nonempty(plan.completedAt) && plan.attempt === attempt &&
    plan.scope === planningContext(state, task, { scopeOnly: true, attempt })
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
      // Stop the owned process tree before its shell disappears, so checks cannot outlive a timeout.
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

function workspaceRevision(directory) {
  const options = { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 }
  const git = (...args) => spawnSync('git', ['-C', directory, ...args], options)
  const root = git('rev-parse', '--show-toplevel')
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
    const directory = step.cwd ?? cwd
    if (typeof directory === 'string' && /^[A-Za-z]:(?![\\\\/])/.test(directory))
      throw new Error('validation cwd looks like a Windows path whose backslashes were consumed by the shell; use a quoted absolute path with forward slashes, for example "C:/work/project"')
    insist(nonempty(directory) && isAbsolute(directory), 'executable validation needs an absolute --cwd or step.cwd')
    insist(statSync(directory).isDirectory(), `validation cwd is not a directory: ${directory}`)
    return directory
  })
}

export async function runValidation(task, cwd, previousReceipt = null) {
  const contract = validationContract(task)
  const checks = []
  const directories = validationDirectories(task, cwd)
  for (const [index, step] of contract.steps.entries()) {
    const revision = step.cacheable ? workspaceRevision(directories[index]) : null
    const prior = previousReceipt?.checks?.[index]
    if (revision && previousReceipt?.contract === contract.key &&
        (previousReceipt.contractRevision ?? 0) === (task.contractRevision ?? 0) &&
        previousReceipt.attempt === task.attempts?.length &&
        (previousReceipt.stateRevision ?? 0) === (task.stateRevision ?? 0) &&
        previousReceipt.by === task.validations?.at(-1)?.by &&
        previousReceipt.agent === task.validations?.at(-1)?.agent &&
        prior?.workspaceRevision === revision && passed(step, prior)) {
      checks.push({ ...prior, reusedAt: new Date().toISOString() })
      log(`[prumo] reused check ${index + 1}/${contract.steps.length} (static, unchanged workspace)`)
      continue
    }
    const timeoutMs = step.timeoutMs ?? 600000
    const shell = step.shell ?? (process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh')
    const env = { ...process.env }
    for (const [name, value] of Object.entries(step.env ?? {})) {
      if (process.platform === 'win32')
        for (const key of Object.keys(env)) if (key.toLowerCase() === name.toLowerCase()) delete env[key]
      env[name] = value
    }
    log(`[prumo] running check ${index + 1}/${contract.steps.length}; timeout ${timeoutMs === 0 ? 'disabled by plan' : timeoutMs + 'ms'}; expected exit ${expectedExitCodes(step).join(',')}`)
    const result = await execute(step.run, {
      cwd: directories[index], shell, env,
      windowsHide: true,
    }, timeoutMs)
    const check = {
      run: step.run, expect: step.expect, kind: step.kind ?? 'static', cwd: directories[index],
      shell, timeoutMs, expectedExitCodes: expectedExitCodes(step),
      exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
      stdout: result.stdout ?? '', stderr: result.stderr ?? '', at: new Date().toISOString(),
      workspaceRevision: revision,
    }
    checks.push(check)
    log(`[prumo] check ${index + 1}/${contract.steps.length} (${check.kind}): exit ${check.exitCode}${check.error ? ` — ${check.error}` : ''}`)
    if (!passed(step, check)) break
  }
  return { contract: contract.key, contractRevision: task.contractRevision ?? 0,
    stateRevision: task.stateRevision ?? 0, checks }
}

export function assertValidation(task, receipt) {
  insist(nonempty(receipt?.evidence), 'validation evidence must not be empty')
  const contract = validationContract(task)
  insist(receipt.contract === contract.key, 'validation lacks an execution receipt for this contract — validate again')
  insist((receipt.contractRevision ?? 0) === (task.contractRevision ?? 0),
    'contract was refreshed after validation — validate the current contract again')
  insist(Array.isArray(receipt.checks), 'validation receipt has no checks')
  if (receipt.checks.length !== contract.steps.length) {
    const index = receipt.checks.length - 1
    if (index >= 0 && !passed(contract.steps[index], receipt.checks[index]))
      throw new Error(failureMessage(contract.steps[index], receipt.checks[index], index, contract.steps.length))
    throw new Error('not all validation commands completed')
  }
  for (const [index, step] of contract.steps.entries()) {
    const check = receipt.checks[index]
    insist(check.run === step.run && check.kind === (step.kind ?? 'static') &&
      check.expect === step.expect && passed(step, check),
    failureMessage(step, check, index, contract.steps.length))
  }
}
