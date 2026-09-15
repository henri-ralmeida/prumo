import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DASHBOARD_PORT = 4949
export const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`
const TASK_NAME = 'Prumo Dashboard'
const LABEL = 'dev.prumo.dashboard'

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const quoteWindows = value => `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
const quoteService = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const command = (node, script) => [node, script, '--global', '--port', String(DASHBOARD_PORT)]

function windowsProcessCommand(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id < 1) throw new Error('Invalid process id')
  const source = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $p=Get-CimInstance Win32_Process -Filter "ProcessId = ${id}"; if ($null -eq $p) { exit 1 }; @{ executable = $p.ExecutablePath; commandLine = $p.CommandLine } | ConvertTo-Json -Compress`
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], { encoding: 'utf8', windowsHide: true, timeout: 10000 }))
}

function windowsProcessIds(script) {
  const literal = script.replaceAll("'", "''")
  const source = `$needle='${literal}'; Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\\').ToLowerInvariant().Contains($needle.Replace('/', '\\').ToLowerInvariant()) } | Select-Object -ExpandProperty ProcessId`
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    .trim().split(/\s+/).filter(Boolean).map(Number)
}

function defaults(options = {}) {
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const packageRoot = options.packageRoot ?? fileURLToPath(new URL('..', import.meta.url))
  const node = options.node ?? process.execPath
  const script = options.script ?? join(packageRoot, 'scripts', 'serve.mjs')
  const version = options.version ?? JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
  if (![node, script].every(isAbsolute)) throw new Error('Dashboard autostart requires absolute Node and package paths')
  return {
    platform, home, node, script, version,
    exec: options.exec ?? ((file, args, extra = {}) => {
      try { return { status: 0, stdout: execFileSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 10000, ...extra }) } }
      catch (error) { return { status: error.status ?? 1, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() || error.message } }
    }),
    spawn: options.spawn ?? ((file, args, settings) => {
      const child = spawn(file, args, settings)
      child.unref()
      return child
    }),
    spawnSync: options.spawnSync ?? spawnSync,
    fetch: options.fetch ?? globalThis.fetch,
    portAvailable: options.portAvailable ?? portAvailable,
    kill: options.kill ?? process.kill,
    readProcessCommand: options.readProcessCommand ?? (platform === 'win32'
      ? windowsProcessCommand
      : pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, -1)),
    listProcessIds: options.listProcessIds ?? (platform === 'win32'
      ? windowsProcessIds
      : () => readdirSync('/proc', { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(entry => Number(entry.name))),
    delay: options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
    readinessAttempts: options.readinessAttempts ?? 50,
    readinessInterval: options.readinessInterval ?? 100,
    uid: options.uid ?? (() => process.getuid?.()),
    env: options.env ?? process.env,
  }
}

function dataDirectory(o) { return join(o.home, '.local', 'share', 'prumo') }
function preferencePath(o) { return join(dataDirectory(o), 'dashboard.json') }
function launchDetached(o) {
  const cwd = dataDirectory(o)
  mkdirSync(cwd, { recursive: true })
  return o.spawn(o.node, command(o.node, o.script).slice(1), { cwd, env: o.env, detached: true, stdio: 'ignore', windowsHide: true })
}

function launchRegistered(o, entry) {
  if (entry.mechanism !== 'windows-startup') return launchDetached(o).pid ?? null
  mkdirSync(dataDirectory(o), { recursive: true })
  const result = o.exec('wscript.exe', ['//B', '//Nologo', entry.path], { env: o.env, cwd: dataDirectory(o) })
  if (result.status !== 0) throw new Error(commandFailure('wscript.exe', result))
  return null
}
function readPreference(o) {
  try { return JSON.parse(readFileSync(preferencePath(o), 'utf8')) }
  catch { return {} }
}
function writePreference(o, value) {
  const file = preferencePath(o)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, file)
}

async function portAvailable(port = DASHBOARD_PORT) {
  return await new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', error => resolve(error.code !== 'EADDRINUSE'))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

export async function dashboardHealth(options = {}) {
  const o = defaults(options)
  try {
    const response = await o.fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (response.ok) {
      const health = await response.json()
      if (health.product === 'prumo' && health.mode === 'global' && health.readOnly === true) return { state: 'running', health }
      return { state: 'conflict', health }
    }
  } catch {}
  return { state: await o.portAvailable(DASHBOARD_PORT) ? 'stopped' : 'conflict', health: null }
}

function windowsRecord(o) {
  return { mechanism: 'schtasks', path: TASK_NAME, content: command(o.node, o.script).map(quoteWindows).join(' ') }
}
function windowsStartupRecord(o) {
  const path = join(o.env.APPDATA ?? join(o.home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Prumo Dashboard.vbs')
  const launch = command(o.node, o.script).map(quoteWindows).join(' ').replaceAll('"', '""')
  return { mechanism: 'windows-startup', path, content: `CreateObject("WScript.Shell").Run "${launch}", 0, False\r\n` }
}
function macRecord(o) {
  const path = join(o.home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  const args = command(o.node, o.script).map(value => `    <string>${xml(value)}</string>`).join('\n')
  return { mechanism: 'launchd', path, content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${LABEL}</string>\n  <key>ProgramArguments</key><array>\n${args}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n</dict></plist>\n` }
}
function systemdRecord(o) {
  const path = join(o.home, '.config', 'systemd', 'user', 'prumo-dashboard.service')
  const exec = command(o.node, o.script).map(quoteService).join(' ')
  return { mechanism: 'systemd', path, content: `[Unit]\nDescription=Prumo Dashboard\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${exec}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n` }
}
function xdgRecord(o) {
  const path = join(o.env.XDG_CONFIG_HOME ?? join(o.home, '.config'), 'autostart', 'prumo-dashboard.desktop')
  const exec = command(o.node, o.script).map(quoteService).join(' ')
  return { mechanism: 'xdg', path, content: `[Desktop Entry]\nType=Application\nName=Prumo Dashboard\nExec=${exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n` }
}
function systemdAvailable(o) { return o.exec('systemctl', ['--user', 'show-environment']).status === 0 }
function record(o, preferred) {
  if (o.platform === 'win32') return preferred === 'windows-startup' ? windowsStartupRecord(o) : windowsRecord(o)
  if (o.platform === 'darwin') return macRecord(o)
  if (o.platform === 'linux') {
    if (preferred === 'systemd') return systemdRecord(o)
    if (preferred === 'xdg') return xdgRecord(o)
    return systemdAvailable(o) ? systemdRecord(o) : xdgRecord(o)
  }
  throw new Error(`Unsupported platform: ${o.platform}`)
}
function writeRecord(entry) {
  mkdirSync(dirname(entry.path), { recursive: true })
  writeFileSync(entry.path, entry.content)
}
function runChecked(o, file, args, allowed = []) {
  const result = o.exec(file, args)
  if (result.status !== 0 && !allowed.includes(result.status)) throw new Error(`${file} ${args.join(' ')} failed`)
  return result
}

function commandFailure(label, result) {
  const detail = result.stderr?.trim() || result.stdout?.trim()
  return `${label} failed with status ${result.status}${detail ? `: ${detail}` : ''}`
}

const failures = (...items) => items.filter(Boolean).join('; ')

function registered(o, mechanism) {
  if (mechanism === 'schtasks') return o.exec('schtasks', ['/Query', '/TN', TASK_NAME]).status === 0
  const entry = record(o, mechanism)
  return existsSync(entry.path)
}

export async function dashboardStatus(options = {}) {
  const o = defaults(options)
  const preference = readPreference(o)
  const entry = record(o, preference.mechanism)
  const process = await dashboardHealth(o)
  return {
    enabled: preference.enabled === true,
    disabled: preference.enabled === false,
    mechanism: entry.mechanism,
    registered: registered(o, entry.mechanism),
    process: process.state,
    conflict: process.state === 'conflict',
    version: process.health?.version ?? o.version,
    port: DASHBOARD_PORT,
    url: DASHBOARD_URL,
  }
}

export const dashboardNeedsRepair = status => !status.disabled && (status.conflict || !status.registered || status.process !== 'running')

export async function enableDashboard(options = {}) {
  const o = defaults(options)
  const health = await dashboardHealth(o)
  if (health.state === 'conflict') return { ok: false, conflict: true, ...(await dashboardStatus(o)) }
  const preference = readPreference(o)
  let schedulerFailure
  let entry = record(o, preference.mechanism)
  if (entry.mechanism === 'schtasks') {
    const present = registered(o, entry.mechanism)
    const created = o.exec('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', TASK_NAME, '/TR', entry.content])
    if (created.status === 0) {
      if (health.state !== 'running') runChecked(o, 'schtasks', ['/Run', '/TN', TASK_NAME])
    } else {
      schedulerFailure = commandFailure('schtasks /Create', created)
      if (present && o.exec('schtasks', ['/Delete', '/F', '/TN', TASK_NAME]).status !== 0) {
        return { ok: false, error: failures(schedulerFailure, 'Unable to replace or remove the managed Task Scheduler entry'), ...(await dashboardStatus(o)) }
      }
      entry = windowsStartupRecord(o)
    }
  }
  if (entry.mechanism === 'launchd') {
    writeRecord(entry)
    const domain = `gui/${o.uid()}`
    o.exec('launchctl', ['bootout', domain, entry.path])
    runChecked(o, 'launchctl', ['bootstrap', domain, entry.path])
    if (health.state !== 'running') runChecked(o, 'launchctl', ['kickstart', `${domain}/${LABEL}`])
  } else if (entry.mechanism === 'systemd') {
    writeRecord(entry)
    runChecked(o, 'systemctl', ['--user', 'daemon-reload'])
    runChecked(o, 'systemctl', ['--user', 'enable', '--now', 'prumo-dashboard.service'])
  } else if (entry.mechanism !== 'schtasks') {
    try { writeRecord(entry) }
    catch (error) {
      writePreference(o, { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script })
      return { ok: false, error: failures(schedulerFailure, `Startup registration failed: ${error.message}`), ...(await dashboardStatus(o)) }
    }
    let pid = fallbackPid(o, preference, health)
    if (health.state !== 'running') {
      try { pid = launchRegistered(o, entry) }
      catch (error) {
        writePreference(o, { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script })
        return { ok: false, error: failures(schedulerFailure, `Startup process failed: ${error.message}`), ...(await dashboardStatus(o)) }
      }
    }
    writePreference(o, { enabled: true, mechanism: entry.mechanism, pid, node: o.node, script: o.script })
    const ready = await waitForDashboard(o)
    const resolvedPid = ready.state === 'running'
      ? await waitForFallbackPid(o, { ...preference, pid, node: o.node, script: o.script }, ready)
      : pid
    if (resolvedPid !== pid) writePreference(o, { enabled: true, mechanism: entry.mechanism, pid: resolvedPid, node: o.node, script: o.script })
    const status = await dashboardStatus(o)
    const ok = status.process === 'running' && Boolean(resolvedPid)
    if (ok && ready.health?.version && ready.health.version !== o.version) return restartDashboard(o)
    return { ...status, ok, ...(!ok && { error: failures(schedulerFailure, `Startup readiness failed: ${status.process}${resolvedPid ? '' : ', managed process not found'}`) }) }
  }
  writePreference(o, { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script })
  await waitForDashboard(o)
  const status = await dashboardStatus(o)
  if (status.process === 'running' && health.health?.version && status.version !== o.version) return restartDashboard(o)
  return { ...status, ok: status.process === 'running' }
}

async function waitForDashboard(o, version) {
  let health
  for (let attempt = 0; attempt < o.readinessAttempts; attempt += 1) {
    health = await dashboardHealth(o)
    if (health.state !== 'stopped' && (health.state !== 'running' || !version || health.health?.version === version)) return health
    if (attempt + 1 < o.readinessAttempts) await o.delay(o.readinessInterval)
  }
  return health
}

async function waitForDashboardStop(o) {
  for (let attempt = 0; attempt < o.readinessAttempts; attempt += 1) {
    const health = await dashboardHealth(o)
    if (health.state !== 'running') return health.state === 'stopped'
    if (attempt + 1 < o.readinessAttempts) await o.delay(o.readinessInterval)
  }
  return false
}

async function waitForFallbackPid(o, preference, health) {
  const deadline = Date.now() + o.readinessAttempts * o.readinessInterval
  for (let attempt = 0; attempt < o.readinessAttempts; attempt += 1) {
    const pid = fallbackPid(o, preference, health)
    if (pid || health.state !== 'running' || Date.now() >= deadline) return pid
    if (attempt + 1 < o.readinessAttempts) await o.delay(o.readinessInterval)
  }
  return null
}

function managedFallbackPid(o, pid, preference) {
  try {
    const cmdline = o.readProcessCommand(pid)
    const expected = command(preference.node, preference.script)
    if (Array.isArray(cmdline)) return cmdline.length === expected.length && cmdline.every((value, index) => value === expected[index])
    const executable = value => String(value ?? '').replaceAll('/', '\\').toLowerCase()
    if (executable(cmdline.executable) !== executable(preference.node)) return false
    const windows = expected.map(value => value.replaceAll('/', '\\'))
    const quoted = windows.map(quoteWindows).join(' ')
    const minimal = windows.map(value => /[\s"]/.test(value) ? quoteWindows(value) : value).join(' ')
    const quotedExecutable = [quoteWindows(windows[0]), ...windows.slice(1).map(value => /[\s"]/.test(value) ? quoteWindows(value) : value)].join(' ')
    // WScript can insert extra separators; spaces inside quoted paths remain significant.
    const normalized = String(cmdline.commandLine ?? '').replaceAll('/', '\\').replace(/"[^"]*"|[ \t]+/g,
      token => token.startsWith('"') ? token : ' ').trim()
    return [quoted, minimal, quotedExecutable].some(value => value.toLowerCase() === normalized.toLowerCase())
  } catch { return false }
}

function fallbackPid(o, preference, health) {
  if (health.state !== 'running') return null
  const reportedPid = health.health?.pid
  if (Number.isInteger(reportedPid) && reportedPid > 0 && managedFallbackPid(o, reportedPid, preference)) return reportedPid
  if (preference.pid && managedFallbackPid(o, preference.pid, preference)) return preference.pid
  let pids = []
  try { pids = o.listProcessIds(preference.script ?? o.script) } catch {}
  for (const pid of pids) if (managedFallbackPid(o, pid, preference)) return pid
  return null
}

export async function disableDashboard(options = {}) {
  const o = defaults(options)
  const preference = readPreference(o)
  const entry = record(o, preference.mechanism)
  const health = await dashboardHealth(o)
  let complete = true
  if (entry.mechanism === 'schtasks') {
    const present = registered(o, entry.mechanism)
    if (present) {
      const stopped = o.exec('schtasks', ['/End', '/TN', TASK_NAME])
      if (health.state === 'running' && stopped.status !== 0) complete = false
      complete = o.exec('schtasks', ['/Delete', '/F', '/TN', TASK_NAME]).status === 0 && complete
    }
  } else if (entry.mechanism === 'launchd') {
    const stopped = o.exec('launchctl', ['bootout', `gui/${o.uid()}`, entry.path])
    if (health.state === 'running' && stopped.status !== 0) complete = false
    rmSync(entry.path, { force: true })
  } else if (entry.mechanism === 'systemd') {
    if (existsSync(entry.path)) complete = o.exec('systemctl', ['--user', 'disable', '--now', 'prumo-dashboard.service']).status === 0
    rmSync(entry.path, { force: true })
    o.exec('systemctl', ['--user', 'daemon-reload'])
  } else {
    rmSync(entry.path, { force: true })
    const pid = fallbackPid(o, preference, health)
    if (pid) {
      try { o.kill(pid) } catch { complete = false }
    } else if (health.state === 'running') complete = false
  }
  writePreference(o, { enabled: false, mechanism: entry.mechanism, node: o.node, script: o.script })
  return { ok: complete, conflict: false, ...(await dashboardStatus(o)) }
}

export async function restartDashboard(options = {}) {
  const o = defaults(options)
  const preference = readPreference(o)
  if (preference.enabled !== true) return { ok: true, skipped: true, ...(await dashboardStatus(o)) }
  let health = await dashboardHealth(o)
  if (health.state === 'conflict') return { ok: false, conflict: true, ...(await dashboardStatus(o)) }
  let schedulerFailure
  let entry = record(o, preference.mechanism)
  if (entry.mechanism === 'schtasks') {
    const present = registered(o, entry.mechanism)
    if (present && health.state === 'running') {
      if (o.exec('schtasks', ['/End', '/TN', TASK_NAME]).status !== 0) return { ok: false, ...(await dashboardStatus(o)) }
      health = await dashboardHealth(o)
    }
    const created = o.exec('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', TASK_NAME, '/TR', entry.content])
    if (created.status === 0) runChecked(o, 'schtasks', ['/Run', '/TN', TASK_NAME])
    else {
      schedulerFailure = commandFailure('schtasks /Create', created)
      if (present && o.exec('schtasks', ['/Delete', '/F', '/TN', TASK_NAME]).status !== 0) {
        return { ok: false, error: failures(schedulerFailure, 'Unable to replace or remove the managed Task Scheduler entry'), ...(await dashboardStatus(o)) }
      }
      entry = windowsStartupRecord(o)
    }
  }
  if (entry.mechanism === 'launchd') {
    writeRecord(entry)
    const domain = `gui/${o.uid()}`
    const stopped = o.exec('launchctl', ['bootout', domain, entry.path])
    if (health.state === 'running' && stopped.status !== 0) return { ok: false, ...(await dashboardStatus(o)) }
    runChecked(o, 'launchctl', ['bootstrap', domain, entry.path])
    runChecked(o, 'launchctl', ['kickstart', '-k', `${domain}/${LABEL}`])
  } else if (entry.mechanism === 'systemd') {
    writeRecord(entry)
    runChecked(o, 'systemctl', ['--user', 'daemon-reload'])
    runChecked(o, 'systemctl', ['--user', 'enable', 'prumo-dashboard.service'])
    runChecked(o, 'systemctl', ['--user', 'restart', 'prumo-dashboard.service'])
  } else if (entry.mechanism !== 'schtasks') {
    try { writeRecord(entry) }
    catch (error) {
      writePreference(o, { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script })
      return { ok: false, error: failures(schedulerFailure, `Startup registration failed: ${error.message}`), ...(await dashboardStatus(o)) }
    }
    let pid = fallbackPid(o, preference, health)
    if (!pid && health.state === 'running') pid = await waitForFallbackPid(o, { ...preference, pid: null, node: o.node, script: o.script }, health)
    if (health.state === 'running' && !pid) {
      return { ok: false, error: failures(schedulerFailure, 'Startup ownership verification failed: managed process not found'), ...(await dashboardStatus(o)) }
    }
    if (pid) {
      try { o.kill(pid) }
      catch (error) {
        return { ok: false, error: failures(schedulerFailure, `Startup process stop failed: ${error.message}`), ...(await dashboardStatus(o)) }
      }
      if (!await waitForDashboardStop(o)) {
        return { ok: false, error: failures(schedulerFailure, 'Startup process did not stop before restart'), ...(await dashboardStatus(o)) }
      }
    }
    let nextPid
    try { nextPid = launchRegistered(o, entry) }
    catch (error) {
      writePreference(o, { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script })
      return { ok: false, error: failures(schedulerFailure, `Startup process failed: ${error.message}`), ...(await dashboardStatus(o)) }
    }
    writePreference(o, { enabled: true, mechanism: entry.mechanism, pid: nextPid, node: o.node, script: o.script })
    const ready = await waitForDashboard(o, o.version)
    if (ready.state === 'running') nextPid = await waitForFallbackPid(o, { pid: nextPid, node: o.node, script: o.script }, ready)
    writePreference(o, { enabled: true, mechanism: entry.mechanism, pid: nextPid, node: o.node, script: o.script })
    const status = await dashboardStatus(o)
    const ok = ready.state === 'running' && ready.health?.version === o.version && Boolean(nextPid)
    return { ...status, ok, ...(!ok && { error: failures(schedulerFailure, `Startup readiness failed: ${ready.state}${nextPid ? '' : ', managed process not found'}`) }) }
  }
  writePreference(o, { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script })
  const ready = await waitForDashboard(o, o.version)
  const status = await dashboardStatus(o)
  return { ...status, ok: ready.state === 'running' && ready.health?.version === o.version }
}

export function runDashboardForeground(options = {}) {
  const o = defaults(options)
  return o.spawnSync(o.node, command(o.node, o.script).slice(1), { stdio: 'inherit', windowsHide: true }).status ?? 1
}
