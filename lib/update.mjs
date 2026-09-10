import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
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

export function isGlobalCli(packageRoot, { platform = process.platform, run = spawnSync } = {}) {
  const result = run('npm', ['root', '--global'], { encoding: 'utf8', shell: platform === 'win32', windowsHide: true, timeout: 10000 })
  if (result.error || result.status !== 0 || !result.stdout?.trim()) return false
  const path = relative(resolve(result.stdout.trim()), resolve(packageRoot))
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

export async function updateGlobalCli(version, { env = process.env, run = spawn } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Prumo version')
  return new Promise((resolve, reject) => {
    const child = run('npm', ['install', '--global', '--ignore-scripts', '--prefer-online', `@henri-ralmeida/prumo@${version}`], {
      env, shell: process.platform === 'win32', windowsHide: true, stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => signal ? reject(new Error('Prumo CLI update was interrupted')) : resolve(code ?? 1))
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
      const child = spawn('npm', ['exec', '--yes', '--ignore-scripts', '--prefer-online', '--package=@henri-ralmeida/prumo@latest', '--', 'prumo', '_update'], {
        cwd: temporary, env: { ...env, PRUMO_UPDATE_REQUEST: JSON.stringify(request) },
        shell: process.platform === 'win32', windowsHide: true, stdio: 'inherit',
      })
      child.on('error', reject)
      child.on('exit', (code, signal) => signal ? reject(new Error('Prumo update was interrupted')) : resolve(code ?? 1))
    })
  } finally {
    assert.equal(dirname(temporary), base)
    assert.ok(temporary.startsWith(join(base, 'prumo-update-')))
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
