import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDashboardEvents, recordDashboardEvent } from '../scripts/dashboard-diagnostics.mjs'
import { language } from '../scripts/i18n.mjs'
import { packageIdentity } from '../scripts/installation-bundle.mjs'
import { parseWindowsCommandLine } from './windows-argv.mjs'

export const DASHBOARD_PORT = 4949
export const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`
const TASK_NAME = 'Prumo Dashboard'
const LABEL = 'dev.prumo.dashboard'

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const quoteWindows = value => `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
const quoteService = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
const command = (node, script, lang) => [node, script, '--global', '--port', String(DASHBOARD_PORT), ...(lang ? ['--lang', lang] : [])]

// WMI pelo Windows Script Host responde em cerca de um segundo mesmo quando powershell.exe trava na
// inicialização, e as verificações de posse dependem dele; PowerShell fica apenas como fallback. Texto não ASCII é
// escapado como sequências JSON \u porque cscript escreve na página de códigos do console.
const WINDOWS_PROCESS_QUERY = String.raw`function q(v) {
  if (v === null || v === undefined) return 'null'
  var s = String(v), o = '"'
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    if (c === 34 || c === 92) o += '\\' + s.charAt(i)
    else if (c < 32 || c > 126) { var h = c.toString(16); while (h.length < 4) h = '0' + h; o += '\\u' + h }
    else o += s.charAt(i)
  }
  return o + '"'
}
var a = WScript.Arguments
var filter = a.length > 1 && a(0) === 'pid' ? 'ProcessId = ' + parseInt(a(1), 10) : "Name = 'node.exe'"
var e = new Enumerator(GetObject('winmgmts:').ExecQuery('SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE ' + filter))
var out = []
for (; !e.atEnd(); e.moveNext()) { var p = e.item(); out.push('{"pid":' + p.ProcessId + ',"executable":' + q(p.ExecutablePath) + ',"commandLine":' + q(p.CommandLine) + '}') }
WScript.Echo('[' + out.join(',') + ']')
`

function windowsProcessQuery(args) {
  const file = join(tmpdir(), 'prumo-process-query-v1.js')
  let current
  try { current = readFileSync(file, 'utf8') } catch { /* primeiro uso */ }
  if (current !== WINDOWS_PROCESS_QUERY) {
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, WINDOWS_PROCESS_QUERY)
    renameSync(temp, file)
  }
  const output = execFileSync('cscript.exe', ['//Nologo', '//E:jscript', file, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  const processes = JSON.parse(output.trim())
  if (!Array.isArray(processes)) throw new Error('Invalid process query output')
  return processes
}

function windowsProcessCommand(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id < 1) throw new Error('Invalid process id')
  try {
    const [found] = windowsProcessQuery(['pid', String(id)])
    if (!found) throw new Error('Process not found')
    return { executable: found.executable, commandLine: found.commandLine }
          } catch { /* Windows Script Host indisponível: recorra ao PowerShell */ }
  const source = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $p=Get-CimInstance Win32_Process -Filter "ProcessId = ${id}"; if ($null -eq $p) { exit 1 }; @{ executable = $p.ExecutablePath; commandLine = $p.CommandLine } | ConvertTo-Json -Compress`
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], { encoding: 'utf8', windowsHide: true, timeout: 10000 }))
}

function windowsProcessIds(script) {
  const normalize = value => String(value ?? '').replaceAll('/', '\\').toLowerCase()
  try {
    return windowsProcessQuery(['name']).filter(entry => normalize(entry.commandLine).includes(normalize(script))).map(entry => Number(entry.pid))
          } catch { /* Windows Script Host indisponível: recorra ao PowerShell */ }
  const literal = script.replaceAll("'", "''")
  const source = `$needle='${literal}'; Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\\').ToLowerInvariant().Contains($needle.Replace('/', '\\').ToLowerInvariant()) } | Select-Object -ExpandProperty ProcessId`
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    .trim().split(/\s+/).filter(Boolean).map(Number)
}

function defaults(options = {}, { identityRequired = true } = {}) {
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const packageRoot = options.packageRoot ?? fileURLToPath(new URL('..', import.meta.url))
  const node = options.node ?? process.execPath
  const script = options.script ?? join(packageRoot, 'scripts', 'serve.mjs')
  const version = options.version ?? JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
  const env = options.env ?? process.env
  const savedLanguage = options.lang === undefined && !env.PRUMO_LANG ? readPreference({ home }).lang : undefined
  const persistedLanguage = ['en', 'pt-BR'].includes(savedLanguage) ? savedLanguage : undefined
  const lang = language(options.lang ?? persistedLanguage, env)
  const langArg = options.lang !== undefined || persistedLanguage !== undefined || env.PRUMO_LANG ? lang : undefined
  const identity = options.contentId ? { contentId: options.contentId, engineHash: options.engineHash ?? null }
    : identityRequired ? packageIdentity(lang, { packageRoot }) : {}
  if (![node, script].every(isAbsolute)) throw new Error('Dashboard autostart requires absolute Node and package paths')
  return {
    platform, home, node, script, version, lang, langArg, packageRoot, ...identity,
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
    // A inicializacao fria no Windows pode demorar; aguarde por ate 30 segundos sem declarar sucesso antes da prontidao.
    readinessAttempts: options.readinessAttempts ?? (platform === 'win32' ? 300 : 50),
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
  return o.spawn(o.node, command(o.node, o.script, o.langArg).slice(1), { cwd, env: o.env, detached: true, stdio: 'ignore', windowsHide: true })
}

async function launchRegistered(o) {
  // O comando inicia o dashboard diretamente para guardar seu PID; o registro de login permanece instalado.
  const child = launchDetached(o)
  if (typeof child.once !== 'function') return child.pid ?? null
  return await new Promise((resolve, reject) => {
    // A falha inicial deve ser informada ao comando; erros posteriores não podem encerrá-lo.
    child.on('error', reject)
    child.once('spawn', () => resolve(child.pid ?? null))
  })
}
function readPreference(o) {
  try { return JSON.parse(readFileSync(preferencePath(o), 'utf8')) }
  catch { return {} }
}
function writePreference(o, value, { persistLanguage = true } = {}) {
  const file = preferencePath(o)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(persistLanguage ? { ...value, lang: o.lang } : value, null, 2)}\n`)
  renameSync(temp, file)
}

async function portAvailable(port = DASHBOARD_PORT) {
  return await new Promise(resolve => {
    // As verificações de prontidão não podem reservar a porta enquanto o dashboard inicia.
    const socket = net.createConnection({ port, host: '127.0.0.1' })
    const finish = available => { socket.destroy(); resolve(available) }
    socket.unref()
    socket.once('connect', () => finish(false))
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'))
    socket.setTimeout(1200, () => finish(false))
  })
}

export async function dashboardHealth(options = {}) {
  return readDashboardHealth(defaults(options))
}

async function readDashboardHealth(o) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await o.fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/health`, { signal: AbortSignal.timeout(1200) })
      if (response.ok) {
        const health = await response.json()
        if (health.product === 'prumo' && health.mode === 'global' && health.readOnly === true) {
          let about = null
          try {
            const details = await o.fetch(`http://127.0.0.1:${DASHBOARD_PORT}/api/about`, { signal: AbortSignal.timeout(1200) })
            if (details.ok) about = await details.json()
          } catch { /* dashboards antigos expõem health, mas não a identidade do pacote */ }
          return { state: 'running', health, about }
        }
        return { state: 'conflict', health }
      }
    } catch {}
    if (await o.portAvailable(DASHBOARD_PORT)) return { state: 'stopped', health: null }
    if (attempt < 2) await o.delay(o.readinessInterval)
  }
  return { state: 'conflict', health: null }
}

function windowsRecord(o) {
  return { mechanism: 'schtasks', path: TASK_NAME, content: command(o.node, o.script, o.langArg).map(quoteWindows).join(' ') }
}
function windowsStartupRecord(o) {
  const path = join(o.env.APPDATA ?? join(o.home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Prumo Dashboard.vbs')
  const launch = command(o.node, o.script, o.langArg).map(quoteWindows).join(' ').replaceAll('"', '""')
  return { mechanism: 'windows-startup', path, content: `CreateObject("WScript.Shell").Run "${launch}", 0, False\r\n` }
}
function macRecord(o) {
  const path = join(o.home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
  const args = command(o.node, o.script, o.langArg).map(value => `    <string>${xml(value)}</string>`).join('\n')
  return { mechanism: 'launchd', path, content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${LABEL}</string>\n  <key>ProgramArguments</key><array>\n${args}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n</dict></plist>\n` }
}
function systemdRecord(o) {
  const path = join(o.home, '.config', 'systemd', 'user', 'prumo-dashboard.service')
  const exec = command(o.node, o.script, o.langArg).map(quoteService).join(' ')
  return { mechanism: 'systemd', path, content: `[Unit]\nDescription=Prumo Dashboard\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${exec}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n` }
}
function xdgRecord(o) {
  const path = join(o.env.XDG_CONFIG_HOME ?? join(o.home, '.config'), 'autostart', 'prumo-dashboard.desktop')
  const exec = command(o.node, o.script, o.langArg).map(quoteService).join(' ')
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
// Um processo só é encerrado depois que a linha de comando comprova que ele é o dashboard gerenciado; estas
// mensagens informam ao usuário o que fazer com um processo que ficou em execução.
const conflictFailure = () => `Port ${DASHBOARD_PORT} is used by another program that is not the Prumo dashboard, so it was not stopped. Close that program or free the port, then run prumo dashboard enable`
function ownershipFailure(health) {
  const pid = health.health?.pid
  return Number.isInteger(pid) && pid > 0
    ? `Startup ownership verification failed: managed process not found; the dashboard on port ${DASHBOARD_PORT} (pid ${pid}) is not the Prumo process managed by this installation, so it was not stopped. Stop process ${pid}, then run prumo dashboard enable`
    : `Startup ownership verification failed: managed process not found; the dashboard on port ${DASHBOARD_PORT} did not report a verifiable Prumo process, so it was not stopped. Stop it, then run prumo dashboard enable`
}

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
  if (preference.enabled === true && process.state === 'stopped' && preference.pid) {
    const latest = readDashboardEvents({ home: o.home, limit: 1 }).at(-1)
    if (latest?.event !== 'stale-process' || latest.pid !== preference.pid) recordDashboardEvent('stale-process', {
      message: 'The registered dashboard process is no longer running', mechanism: entry.mechanism,
    }, { home: o.home, pid: preference.pid, version: o.version, port: DASHBOARD_PORT })
  }
  return {
    enabled: preference.enabled === true,
    disabled: preference.enabled === false,
    mechanism: entry.mechanism,
    registered: registered(o, entry.mechanism),
    process: process.state,
    conflict: process.state === 'conflict',
    version: process.about?.version ?? process.health?.version ?? o.version,
    contentId: process.about?.contentId ?? null,
    contentCurrent: dashboardMatchesPackage(o, process),
    origin: process.about?.origin ?? null,
    path: process.about?.path ?? null,
    port: DASHBOARD_PORT,
    url: DASHBOARD_URL,
  }
}

export { readDashboardEvents }

export const dashboardNeedsRepair = status => !status.disabled && (status.conflict || !status.registered || status.process !== 'running' || status.contentCurrent === false)

function dashboardMatchesPackage(o, health) {
  return health?.state === 'running' && health.health?.version === o.version &&
    health.about?.version === o.version && health.about?.contentId === o.contentId
}

export async function enableDashboard(options = {}) {
  const o = defaults(options)
  recordDashboardEvent('enable-requested', {}, { home: o.home, version: o.version, port: DASHBOARD_PORT })
  const health = await dashboardHealth(o)
  if (health.state === 'conflict') return { ok: false, conflict: true, error: conflictFailure(), ...(await dashboardStatus(o)) }
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
      const current = health.state === 'running'
        ? { ...preference, enabled: true, mechanism: entry.mechanism, node: preference.node ?? o.node, script: preference.script ?? o.script }
        : { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script }
      writePreference(o, current, { persistLanguage: health.state !== 'running' })
      return { ok: false, error: failures(schedulerFailure, `Startup registration failed: ${error.message}`), ...(await dashboardStatus(o)) }
    }
    let pid = fallbackPid(o, preference, health)
    if (health.state !== 'running') {
      try { pid = await launchRegistered(o) }
      catch (error) {
        writePreference(o, { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script })
        return { ok: false, error: failures(schedulerFailure, `Startup process failed: ${error.message}`), ...(await dashboardStatus(o)) }
      }
    }
    // O idioma do processo atual permanece registrado até a substituição ser confirmada.
    const current = { enabled: true, mechanism: entry.mechanism, pid, node: o.node, script: o.script,
      ...(preference.lang === undefined ? {} : { lang: preference.lang }) }
    const persistLanguage = health.state !== 'running'
    writePreference(o, current, { persistLanguage })
    const ready = await waitForDashboard(o)
    const resolvedPid = ready.state === 'running'
      ? await waitForFallbackPid(o, { ...preference, pid, node: o.node, script: o.script }, ready)
      : pid
    if (resolvedPid !== pid) writePreference(o, { ...current, pid: resolvedPid }, { persistLanguage })
    const status = await dashboardStatus(o)
    const ok = status.process === 'running' && Boolean(resolvedPid)
    if (ok && !dashboardMatchesPackage(o, ready)) return restartDashboard(o)
    return { ...status, ok, ...(!ok && { error: failures(schedulerFailure, `Startup readiness failed: ${status.process}${resolvedPid ? '' : ', managed process not found'}`) }) }
  }
  writePreference(o, { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script })
  const ready = await waitForDashboard(o)
  const status = await dashboardStatus(o)
  if (ready.state === 'running' && !dashboardMatchesPackage(o, ready)) return restartDashboard(o)
  return { ...status, ok: status.process === 'running' }
}

async function waitForDashboard(o, version, { verifyIdentity = false } = {}) {
  let health
  for (let attempt = 0; attempt < o.readinessAttempts; attempt += 1) {
    health = await dashboardHealth(o)
    if (health.state === 'conflict' || health.state === 'running' && (!verifyIdentity || dashboardMatchesPackage(o, health)) || health.state === 'stopped' && attempt + 1 === o.readinessAttempts) return health
    if (attempt + 1 < o.readinessAttempts) await o.delay(o.readinessInterval)
  }
  return health
}

async function waitForDashboardStop(o) {
  for (let attempt = 0; attempt < o.readinessAttempts; attempt += 1) {
    const health = await readDashboardHealth(o)
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
    const previousLang = ['en', 'pt-BR'].includes(preference.lang) ? preference.lang : undefined
    const candidates = [command(preference.node, preference.script, o.langArg),
      command(preference.node, preference.script, previousLang), command(preference.node, preference.script)]
    if (Array.isArray(cmdline)) return candidates.some(args => cmdline.length === args.length && cmdline.every((value, index) => value === args[index]))
    const executable = value => String(value ?? '').replaceAll('/', '\\').toLowerCase()
    if (executable(cmdline.executable) !== executable(preference.node)) return false
    const actual = parseWindowsCommandLine(cmdline.commandLine)
    if (!actual) return false
    // O executavel ja foi comprovado pelo sistema; script e opcoes precisam
    // corresponder ao dashboard registrado, mesmo quando as aspas diferem.
    return candidates.some(args => actual.length === args.length && args.every((value, index) =>
      index === 0 || (index === 1 ? executable(actual[index]) === executable(value) : actual[index] === value)))
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
  recordDashboardEvent('disable-requested', { mechanism: preference.mechanism }, {
    home: o.home, pid: preference.pid, version: o.version, port: DASHBOARD_PORT,
  })
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
  const current = complete
    ? { enabled: false, mechanism: entry.mechanism, node: o.node, script: o.script }
    : { ...preference, enabled: false, mechanism: entry.mechanism }
  writePreference(o, current, { persistLanguage: complete })
  return { ok: complete, conflict: false, ...(await dashboardStatus(o)) }
}

export async function stopDashboardForUpdate(options = {}) {
  // O pacote anterior pode não conter os arquivos da versão nova; a posse é comprovada pelo comando do processo.
  const o = defaults(options, { identityRequired: false })
  const preference = readPreference(o)
  const identity = { ...preference, node: preference.node ?? o.node, script: preference.script ?? o.script }
  const health = await readDashboardHealth(o)
  if (health.state === 'stopped') return { ok: true, stopped: false }
  if (health.state === 'conflict') return { ok: false, error: conflictFailure() }
  const entry = record(o, preference.mechanism)
  try {
    if (entry.mechanism === 'systemd') runChecked(o, 'systemctl', ['--user', 'stop', 'prumo-dashboard.service'])
    else if (entry.mechanism === 'launchd') runChecked(o, 'launchctl', ['bootout', `gui/${o.uid()}`, entry.path])
    else {
      const pid = fallbackPid(o, identity, health)
      if (!pid) return { ok: false, error: ownershipFailure(health) }
      o.kill(pid)
    }
    if (!await waitForDashboardStop(o)) return { ok: false, error: 'Startup process did not stop before restart' }
    return { ok: true, stopped: true }
  } catch (error) { return { ok: false, error: `Startup process stop failed: ${error.message}` } }
}

export async function restartDashboard(options = {}) {
  const o = defaults(options)
  const preference = readPreference(o)
  recordDashboardEvent('restart-requested', { mechanism: preference.mechanism }, {
    home: o.home, pid: preference.pid, version: o.version, port: DASHBOARD_PORT,
  })
  if (preference.enabled !== true) return { ok: true, skipped: true, ...(await dashboardStatus(o)) }
  let health = await dashboardHealth(o)
  if (health.state === 'conflict') return { ok: false, conflict: true, error: conflictFailure(), ...(await dashboardStatus(o)) }
  let schedulerFailure
  let entry = record(o, preference.mechanism)
  if (entry.mechanism === 'schtasks') {
    const present = registered(o, entry.mechanism)
    if (present && health.state === 'running') {
      if (o.exec('schtasks', ['/End', '/TN', TASK_NAME]).status !== 0) return { ok: false, ...(await dashboardStatus(o)) }
      if (!await waitForDashboardStop(o)) return { ok: false, error: 'Startup process did not stop before restart', ...(await dashboardStatus(o)) }
      health = await dashboardHealth(o)
    }
    const created = o.exec('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', TASK_NAME, '/TR', entry.content])
    if (created.status === 0) {
      if (!present && health.state === 'running') {
        const pid = fallbackPid(o, preference, health)
        if (!pid) return { ok: false, error: ownershipFailure(health), ...(await dashboardStatus(o)) }
        try { o.kill(pid) }
        catch (error) { return { ok: false, error: `Startup process stop failed: ${error.message}`, ...(await dashboardStatus(o)) } }
        if (!await waitForDashboardStop(o)) return { ok: false, error: 'Startup process did not stop before restart', ...(await dashboardStatus(o)) }
        health = await dashboardHealth(o)
      }
      runChecked(o, 'schtasks', ['/Run', '/TN', TASK_NAME])
    }
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
    // Até substituir o dashboard em execução, mantenha o pid e o comando que comprovam sua posse.
    const current = { ...preference, enabled: true, mechanism: entry.mechanism, ...(preference.pid && { pid: preference.pid }),
      node: preference.node ?? o.node, script: preference.script ?? o.script }
    try { writeRecord(entry) }
    catch (error) {
      writePreference(o, current, { persistLanguage: false })
      return { ok: false, error: failures(schedulerFailure, `Startup registration failed: ${error.message}`), ...(await dashboardStatus(o)) }
    }
    writePreference(o, current, { persistLanguage: false })
    let pid = fallbackPid(o, preference, health)
    if (!pid && health.state === 'running') pid = await waitForFallbackPid(o, { ...preference, pid: null, node: o.node, script: o.script }, health)
    if (health.state === 'running' && !pid) {
      return { ok: false, error: failures(schedulerFailure, ownershipFailure(health)), ...(await dashboardStatus(o)) }
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
    try { nextPid = await launchRegistered(o) }
    catch (error) {
      writePreference(o, { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script })
      return { ok: false, error: failures(schedulerFailure, `Startup process failed: ${error.message}`), ...(await dashboardStatus(o)) }
    }
    writePreference(o, { enabled: true, mechanism: entry.mechanism, pid: nextPid, node: o.node, script: o.script })
    const ready = await waitForDashboard(o, o.version, { verifyIdentity: true })
    if (ready.state === 'running') nextPid = await waitForFallbackPid(o, { pid: nextPid, node: o.node, script: o.script }, ready)
    writePreference(o, { enabled: true, mechanism: entry.mechanism, pid: nextPid, node: o.node, script: o.script })
    const status = await dashboardStatus(o)
    const ok = dashboardMatchesPackage(o, ready) && Boolean(nextPid)
    return { ...status, ok, ...(!ok && { error: failures(schedulerFailure, `Startup readiness failed: ${ready.state}${nextPid ? '' : ', managed process not found'}`) }) }
  }
  writePreference(o, { enabled: true, mechanism: entry.mechanism, node: o.node, script: o.script })
  const ready = await waitForDashboard(o, o.version, { verifyIdentity: true })
  const status = await dashboardStatus(o)
  return { ...status, ok: dashboardMatchesPackage(o, ready) }
}

export function runDashboardForeground(options = {}) {
  const o = defaults(options)
  return o.spawnSync(o.node, command(o.node, o.script, o.langArg).slice(1), { stdio: 'inherit', windowsHide: true }).status ?? 1
}
