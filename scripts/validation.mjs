import { log } from './i18n.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const insist = (condition, message) => { if (!condition) throw new Error(message) }
const expectedExitCodes = (step) => step.expectedExitCodes ?? [0]
const passed = (step, check) => expectedExitCodes(step).includes(check.exitCode) && !check.error && !check.signal

// The plan classifies checks; only the reviewer can judge their behavioral coverage.
export function validationContract(task) {
  const mode = task.validationMode ?? 'functional'
  insist(['functional', 'inspection'].includes(mode), 'validationMode must be functional or inspection')
  if (mode === 'inspection')
    insist(nonempty(task.inspectionReason), 'inspection requires inspectionReason explaining why runtime behavior is unaffected')
  const steps = Array.isArray(task.validation) ? task.validation : []
  insist(steps.length > 0 || nonempty(task.validation), 'validation contract must not be empty')
  for (const step of steps) {
    insist(step && nonempty(step.run) && nonempty(step.expect), 'each validation step needs nonempty run and expect')
    insist(['static', 'functional'].includes(step.kind ?? 'static'), 'step kind must be static or functional')
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

export async function runValidation(task, cwd) {
  const contract = validationContract(task)
  const checks = []
  // Resolve every working directory before executing any command.
  const directories = contract.steps.map((step) => {
    const directory = step.cwd ?? cwd
    insist(nonempty(directory) && isAbsolute(directory), 'executable validation needs an absolute --cwd or step.cwd')
    insist(statSync(directory).isDirectory(), `validation cwd is not a directory: ${directory}`)
    return directory
  })
  for (const [index, step] of contract.steps.entries()) {
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
    }
    checks.push(check)
    log(`[prumo] check ${index + 1}/${contract.steps.length} (${check.kind}): exit ${check.exitCode}${check.error ? ` — ${check.error}` : ''}`)
    if (!passed(step, check)) break
  }
  return { contract: contract.key, contractRevision: task.contractRevision ?? 0, checks }
}

export function assertValidation(task, receipt) {
  insist(nonempty(receipt?.evidence), 'validation evidence must not be empty')
  const contract = validationContract(task)
  insist(receipt.contract === contract.key, 'validation lacks an execution receipt for this contract — validate again')
  insist((receipt.contractRevision ?? 0) === (task.contractRevision ?? 0),
    'contract was refreshed after validation — validate the current contract again')
  insist(Array.isArray(receipt.checks) && receipt.checks.length === contract.steps.length,
    'not all validation commands completed')
  for (const [index, step] of contract.steps.entries()) {
    const check = receipt.checks[index]
    insist(check.run === step.run && check.kind === (step.kind ?? 'static') &&
      check.expect === step.expect && passed(step, check),
    `validation check ${index + 1} did not pass — functional failures cannot be replaced by lint`)
  }
}
