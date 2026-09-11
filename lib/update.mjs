import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, isAbsolute, relative, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { discoverInstallations } from './install.mjs'
import { language } from '../scripts/i18n.mjs'

export function updateRequest(value) {
  const request = JSON.parse(value ?? '{}')
  if (!request || typeof request.dryRun !== 'boolean' || typeof request.cwd !== 'string' || !isAbsolute(request.cwd) || !Array.isArray(request.projects) || request.projects.some(path => typeof path !== 'string' || !isAbsolute(path)) || request.updateCli !== undefined && typeof request.updateCli !== 'boolean') throw new Error('Invalid Prumo update request')
  if (request.lang !== undefined) language(request.lang)
  return { ...request, updateCli: request.updateCli !== false }
}

export function npmProcess(args, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return { command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
  return { command: 'npm', args }
}

export function globalCliState(packageRoot, { platform = process.platform, env = process.env, run = spawnSync, read = readFileSync } = {}) {
  const npm = npmProcess(['root', '--global'], { platform, env })
  const result = run(npm.command, npm.args, { encoding: 'utf8', env, windowsHide: true, timeout: 10000 })
  if (result.error || result.status !== 0 || !result.stdout?.trim()) return { running: false, version: null }
  const root = resolve(result.stdout.trim())
  const path = relative(root, resolve(packageRoot))
  let version = null
  try { version = JSON.parse(read(join(root, '@henri-ralmeida', 'prumo', 'package.json'), 'utf8')).version ?? null } catch { /* not installed */ }
  return { running: path !== '' && !path.startsWith('..') && !isAbsolute(path), version }
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

export async function launchUpdate(request, { env = process.env } = {}) {
  const installed = discoverInstallations({ cwd: request.cwd, projects: request.projects, env })
  if (!installed.length && request.updateCli === false) return null
  const base = realpathSync(tmpdir())
  const temporary = mkdtempSync(join(base, 'prumo-update-'))
  try {
    // An empty working directory prevents a project's older local binary from
    // shadowing the version fetched by npm. Shell arguments are fixed literals;
    // paths and preferences travel as JSON, never as Windows shell source.
    return await new Promise((resolve, reject) => {
      const npm = npmProcess(['exec', '--yes', '--ignore-scripts', '--prefer-online', '--loglevel=error', '--package=@henri-ralmeida/prumo@latest', '--', 'prumo', '_update'], { env })
      const child = spawn(npm.command, npm.args, {
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
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
