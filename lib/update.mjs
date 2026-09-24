import { mkdtempSync, rmSync, realpathSync, readFileSync, readdirSync, lstatSync, mkdirSync, copyFileSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, isAbsolute, relative, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { discoverInstallations, installationFilesCurrent } from './install.mjs'
import { compareVersions } from './release-notes.mjs'
import { language } from '../scripts/i18n.mjs'
import { dashboardStatus, enableDashboard, restartDashboard } from './autostart.mjs'
import { packageIdentity } from '../scripts/installation-bundle.mjs'
import { packageDistributionFiles } from '../scripts/package-content.mjs'

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

function runNpm(args, { env, run, platform, cwd }) {
  return new Promise((resolve, reject) => {
    const npm = npmProcess(args, { platform, env })
    let child
    try { child = run(npm.command, npm.args, { cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }) }
    catch (error) { reject(error); return }
    let errors = ''
    child.stderr?.on('data', chunk => { errors += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code && errors.trim()) process.stderr.write(errors)
      signal ? reject(new Error('Prumo CLI package update was interrupted')) : resolve(code ?? 1)
    })
  })
}

export function globalCliContentCurrent(sourcePackageRoot, globalPackageRoot, lang = 'en') {
  if (!sourcePackageRoot || !globalPackageRoot) return false
  try {
    const source = resolve(sourcePackageRoot)
    const global = resolve(globalPackageRoot)
    const sourcePackage = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    const globalPackage = JSON.parse(readFileSync(join(global, 'package.json'), 'utf8'))
    if (sourcePackage.name !== '@henri-ralmeida/prumo' || sourcePackage.version !== globalPackage.version) return false
    const sourceFiles = packageDistributionFiles(source)
    const globalFiles = packageDistributionFiles(global)
    if (sourceFiles.length !== globalFiles.length || sourceFiles.some((name, index) => name !== globalFiles[index])) return false
    if (sourceFiles.some(name => !readFileSync(join(source, name)).equals(readFileSync(join(global, name))))) return false
    return packageIdentity(lang, { packageRoot: source }).contentId === packageIdentity(lang, { packageRoot: global }).contentId
  } catch { return false }
}

function assertGlobalCliTargetIsManaged({ env, runSync, platform }) {
  const npm = npmProcess(['root', '--global'], { platform, env })
  const result = runSync(npm.command, npm.args, { encoding: 'utf8', env, windowsHide: true, timeout: 10000 })
  if (result.error || result.status !== 0 || !result.stdout?.trim()) throw new Error('Unable to verify the global Prumo CLI installation path')
  const root = resolve(result.stdout.trim())
  const target = join(root, '@henri-ralmeida', 'prumo')
  for (const directory of [target, dirname(target), root]) {
    const stat = lstatSync(directory, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw new Error('Global Prumo CLI package path is linked; refusing to replace user-managed files')
    if (stat && !stat.isDirectory()) throw new Error('Global Prumo CLI package path is not a managed directory')
  }
  return target
}

function assertPlainTree(root) {
  const visit = path => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`Package tree contains a linked path: ${path}`)
    if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry))
    else if (!stat.isFile()) throw new Error(`Package tree contains an invalid path: ${path}`)
  }
  visit(root)
}

function npmPrefixEnvironment(env, prefix, cache) {
  const next = { ...env }
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'npm_config_prefix' || key.toLowerCase() === 'npm_config_cache') delete next[key]
  }
  next.npm_config_prefix = prefix
  next.npm_config_cache = cache
  return next
}

function stagePackage(source, stage) {
  mkdirSync(stage, { recursive: true })
  for (const name of packageDistributionFiles(source)) {
    const destination = join(stage, name)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(source, name), destination)
  }
  const baseline = join(source, 'scripts', 'release-baseline.json')
  if (existsSync(baseline)) {
    if (lstatSync(baseline).isSymbolicLink() || !lstatSync(baseline).isFile()) throw new Error('Release baseline is linked or not a regular file')
    const destination = join(stage, 'scripts', 'release-baseline.json')
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(baseline, destination)
  }
}

function packageArchiveName(stage) {
  const archives = readdirSync(stage).filter(name => name.endsWith('.tgz'))
  if (archives.length !== 1 || !/^[A-Za-z0-9._-]+\.tgz$/.test(archives[0])) throw new Error('The local Prumo CLI package archive is missing, unsafe or ambiguous')
  return archives[0]
}

function verifyGlobalPackage(source, packageRoot, metadata, expectedContentId, lang) {
  if (!packageRoot) throw new Error('Global Prumo CLI package is unavailable after installation')
  const actual = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (actual.version !== metadata.version || actual.name !== metadata.name || !globalCliContentCurrent(source, packageRoot, lang) || packageIdentity(lang, { packageRoot }).contentId !== expectedContentId) {
    throw new Error('Global Prumo CLI package verification failed after installation')
  }
}

function restoreGlobalPackage(target, backup, hadPreviousPackage) {
  const current = lstatSync(target, { throwIfNoEntry: false })
  if (current) {
    if (current.isSymbolicLink() || !current.isDirectory()) throw new Error('Global Prumo CLI target changed to an unmanaged path during installation')
    assertPlainTree(target)
    rmSync(target, { recursive: true, force: true })
  }
  if (hadPreviousPackage) cpSync(backup, target, { recursive: true, errorOnExist: true })
}

export async function updateGlobalCliFromPackage(packageRoot, { lang = 'en', env = process.env, run = spawn, runSync = spawnSync, platform = process.platform, temporaryRoot = tmpdir() } = {}) {
  lang = language(lang)
  const requestedSource = resolve(packageRoot)
  if (lstatSync(requestedSource).isSymbolicLink()) throw new Error('Local Prumo CLI package path is linked; refusing to pack user-managed files')
  const source = realpathSync(requestedSource)
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (metadata.name !== '@henri-ralmeida/prumo' || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('Invalid local Prumo CLI package')
  packageDistributionFiles(source)
  const expectedContentId = packageIdentity(lang, { packageRoot: source }).contentId
  const target = assertGlobalCliTargetIsManaged({ env, runSync, platform })
  const temporaryBase = realpathSync(temporaryRoot)
  const temporary = mkdtempSync(join(temporaryBase, 'prumo-cli-refresh-'))
  const stage = join(temporary, 'package')
  const backup = join(temporary, 'previous-package')
  let hadPreviousPackage = false
  try {
    stagePackage(source, stage)
    const packed = await runNpm(['pack', '--ignore-scripts', '--no-audit', '--no-fund', '--json'], { env, run, platform, cwd: stage })
    if (packed !== 0) throw new Error('Unable to pack the local Prumo CLI package')
    const archive = packageArchiveName(stage)
    const validationEnv = npmPrefixEnvironment(env, join(temporary, 'validation-prefix'), join(temporary, 'validation-cache'))
    const isolatedInstall = await runNpm(['install', '--global', '--force', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--loglevel=error', archive], { env: validationEnv, run, platform, cwd: stage })
    if (isolatedInstall !== 0) throw new Error('Unable to validate the local Prumo CLI package in an isolated installation')
    const isolated = globalCliState(source, { platform, env: validationEnv, run: runSync })
    verifyGlobalPackage(source, isolated.packageRoot, metadata, expectedContentId, lang)

    const current = lstatSync(target, { throwIfNoEntry: false })
    if (current) {
      if (current.isSymbolicLink() || !current.isDirectory()) throw new Error('Global Prumo CLI target is not a managed package directory')
      assertPlainTree(target)
      cpSync(target, backup, { recursive: true, errorOnExist: true })
      hadPreviousPackage = true
    }
    try {
      const installed = await runNpm(['install', '--global', '--force', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--loglevel=error', archive], { env, run, platform, cwd: stage })
      if (installed !== 0) throw new Error('Unable to install the local Prumo CLI package globally')
      const state = globalCliState(source, { platform, env, run: runSync })
      verifyGlobalPackage(source, state.packageRoot, metadata, expectedContentId, lang)
      return { ...state, contentId: expectedContentId }
    } catch (error) {
      try { restoreGlobalPackage(target, backup, hadPreviousPackage) }
      catch (rollbackError) { throw new Error(`Global Prumo CLI update failed and rollback could not restore the previous package: ${rollbackError.message}`, { cause: error }) }
      throw error
    }
  } finally {
    assert.equal(dirname(temporary), temporaryBase)
    assert.ok(temporary.startsWith(join(temporaryBase, 'prumo-cli-refresh-')))
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

export async function ensureGlobalCliContent(sourcePackageRoot, globalState, lang = 'en', options = {}) {
  lang = language(lang)
  if (globalCliContentCurrent(sourcePackageRoot, globalState?.packageRoot, lang)) {
    return { ...globalState, contentId: packageIdentity(lang, { packageRoot: sourcePackageRoot }).contentId, contentRefreshed: false }
  }
  if (!globalState?.packageRoot) throw new Error('Global Prumo CLI package is unavailable after installation')
  const state = await updateGlobalCliFromPackage(sourcePackageRoot, { ...options, lang })
  if (!globalCliContentCurrent(sourcePackageRoot, state.packageRoot, lang)) throw new Error('Global Prumo CLI content still differs after installation')
  return { ...state, contentRefreshed: true }
}

export async function launchUpdate(request, { env = process.env, onCurrent = () => {}, onDashboardRepair = () => {}, discover = discoverInstallations, latestVersion = npmLatestVersion, run = spawn, filesCurrent = installationFilesCurrent, status = dashboardStatus, repair = restartDashboard } = {}) {
  const installed = discover({ cwd: request.cwd, projects: request.projects, env })
  if (request.updateCli === false && !installed.length) return null
  if (request.sourceVersion) {
    const latest = latestVersion({ env })
    assertUpdateVersion(request.sourceVersion, latest)
    // `null` indica uma CLI global ausente; preserve essa distinção dos chamadores legados.
    const globalVersion = request.globalVersion === undefined ? request.sourceVersion : request.globalVersion
    if (request.updateCli !== false && globalVersion !== null) assertUpdateVersion(globalVersion, latest)
    if (request.lang === undefined && !request.pendingUpdate && globalVersion === latest && installationsCurrent(installed, latest, { filesCurrent })) {
      const dashboard = await status({ env })
      if (dashboard.enabled && !dashboard.disabled && (dashboard.process !== 'running' || !dashboard.registered || dashboard.version !== latest || dashboard.contentCurrent === false)) {
        if (request.dryRun) { onDashboardRepair(true); return 0 }
        const result = await repair({ env })
        if (!result.ok) throw new Error(`Dashboard restart failed: ${result.error ?? result.process}`)
        onDashboardRepair(false)
      }
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
