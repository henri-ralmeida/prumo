import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, isAbsolute, relative, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { discoverInstallations, installationFilesCurrent } from './install.mjs'
import { compareVersions } from './release-notes.mjs'
import { language } from '../scripts/i18n.mjs'
import { dashboardStatus, enableDashboard, restartDashboard } from './autostart.mjs'

export async function reconcileDashboardUpdate({ dryRun = false, dashboardOptions = {}, before: savedBefore } = {}, { status = dashboardStatus, enable = enableDashboard, restart = restartDashboard } = {}) {
  const before = savedBefore ?? await status(dashboardOptions)
  if (before.disabled) return { ok: true, action: 'disabled', status: before }
  if (!before.enabled) {
    if (before.process !== 'running') return { ok: true, action: 'none', status: before }
    if (dryRun) return { ok: true, action: 'enable', status: before }
    const result = await enable(dashboardOptions)
    return { ok: result.ok === true, action: 'enable', status: result }
  }
  if (dryRun) return { ok: true, action: 'restart', status: before }
  const result = await restart(dashboardOptions)
  return { ok: result.ok === true, action: 'restart', status: result }
}

export function updateRequest(value) {
  const request = JSON.parse(value ?? '{}')
  if (!request || typeof request.dryRun !== 'boolean' || typeof request.cwd !== 'string' || !isAbsolute(request.cwd) || !Array.isArray(request.projects) || request.projects.some(path => typeof path !== 'string' || !isAbsolute(path)) || request.updateCli !== undefined && typeof request.updateCli !== 'boolean' || request.pendingUpdate !== undefined && typeof request.pendingUpdate !== 'boolean' || request.sourceVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(request.sourceVersion) || request.globalVersion !== undefined && request.globalVersion !== null && !/^\d+\.\d+\.\d+$/.test(request.globalVersion)) throw new Error('Invalid Prumo update request')
  if (request.lang !== undefined) language(request.lang)
  return { ...request, updateCli: request.updateCli !== false }
}

export function npmProcess(args, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return { command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
  return { command: 'npm', args }
}

export function npmLatestVersion({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  const npm = npmProcess(['view', '@henri-ralmeida/prumo', 'version', '--json', '--loglevel=error'], { platform, env })
  const result = run(npm.command, npm.args, { encoding: 'utf8', env, windowsHide: true, timeout: 30000 })
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr?.trim() || 'Unable to read npm latest version')
  const value = JSON.parse(result.stdout)
  const version = Array.isArray(value) ? value.at(-1) : value
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('npm returned an invalid Prumo version')
  return version
}

export function assertUpdateVersion(installed, available) {
  if (installed && compareVersions(available, installed) < 0)
    throw new Error(`Installed Prumo ${installed} is newer than npm latest ${available}; update refused to prevent downgrade`)
}

export function installationsCurrent(installations, version, { read = readFileSync, filesCurrent = installationFilesCurrent } = {}) {
  return installations.length > 0 && installations.every(entry => entry.roots.length > 0 && entry.roots.every(root => {
    try {
      const marker = JSON.parse(read(join(root, 'prumo', '.prumo-install.json'), 'utf8').replace(/^\uFEFF/, ''))
      return marker.version === version && filesCurrent(root, marker)
    }
    catch { return false }
  }))
}

export function globalCliState(packageRoot, { platform = process.platform, env = process.env, run = spawnSync, read = readFileSync } = {}) {
  const npm = npmProcess(['root', '--global'], { platform, env })
  const result = run(npm.command, npm.args, { encoding: 'utf8', env, windowsHide: true, timeout: 10000 })
  if (result.error || result.status !== 0 || !result.stdout?.trim()) return { running: false, version: null, packageRoot: null }
  const root = resolve(result.stdout.trim())
  const path = relative(root, resolve(packageRoot))
  const installedRoot = join(root, '@henri-ralmeida', 'prumo')
  let version = null
  try { version = JSON.parse(read(join(installedRoot, 'package.json'), 'utf8')).version ?? null } catch { /* not installed */ }
  return { running: path !== '' && !path.startsWith('..') && !isAbsolute(path), version, packageRoot: version ? installedRoot : null }
}

export function isGlobalCli(packageRoot, options) {
  return globalCliState(packageRoot, options).running
}

export async function updateGlobalCli(version, { env = process.env, run = spawn, platform = process.platform } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Prumo version')
  return new Promise((resolve, reject) => {
    const npm = npmProcess(['install', '--global', '--ignore-scripts', '--prefer-online', '--loglevel=error', `@henri-ralmeida/prumo@${version}`], { platform, env })
    const child = run(npm.command, npm.args, {
      env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let errors = ''
    child.stderr?.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code && errors.trim()) process.stderr.write(errors)
      signal ? reject(new Error('Prumo CLI update was interrupted')) : resolve(code ?? 1)
    })
  })
}

export async function launchUpdate(request, { env = process.env, onCurrent = () => {}, discover = discoverInstallations, latestVersion = npmLatestVersion, run = spawn, filesCurrent = installationFilesCurrent } = {}) {
  const installed = discover({ cwd: request.cwd, projects: request.projects, env })
  if (request.updateCli === false && !installed.length) return null
  if (request.sourceVersion) {
    const latest = latestVersion({ env })
    assertUpdateVersion(request.sourceVersion, latest)
    // `null` indica uma CLI global ausente; preserve essa distinção dos chamadores legados.
    const globalVersion = request.globalVersion === undefined ? request.sourceVersion : request.globalVersion
    if (request.updateCli !== false && globalVersion !== null) assertUpdateVersion(globalVersion, latest)
    if (request.lang === undefined && !request.pendingUpdate && globalVersion === latest && installationsCurrent(installed, latest, { filesCurrent })) {
      onCurrent(latest)
      return 0
    }
  }
  const base = realpathSync(tmpdir())
  const temporary = mkdtempSync(join(base, 'prumo-update-'))
  try {
    // An empty working directory prevents a project's older local binary from
    // shadowing the version fetched by npm. Shell arguments are fixed literals;
    // paths and preferences travel as JSON, never as Windows shell source.
    return await new Promise((resolve, reject) => {
      const npm = npmProcess(['exec', '--yes', '--ignore-scripts', '--prefer-online', '--loglevel=error', '--package=@henri-ralmeida/prumo@latest', '--', 'prumo', '_update'], { env })
      const child = run(npm.command, npm.args, {
        cwd: temporary, env: { ...env, PRUMO_UPDATE_REQUEST: JSON.stringify(request) },
        windowsHide: true, stdio: ['inherit', 'inherit', 'pipe'],
      })
      let errors = ''
      child.stderr?.on('data', chunk => { errors += chunk })
      child.on('error', reject)
      child.on('exit', (code, signal) => {
        if (code && errors.trim()) process.stderr.write(errors)
        signal ? reject(new Error('Prumo update was interrupted')) : resolve(code ?? 1)
      })
    })
  } finally {
    assert.equal(dirname(temporary), base)
    assert.ok(temporary.startsWith(join(base, 'prumo-update-')))
    rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}
