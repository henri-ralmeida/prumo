// O lancador conserva stderr e o resultado do processo sem manter um terminal aberto.
import { spawn } from 'node:child_process'
import { closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { openDashboardErrorLog, recordDashboardEvent } from './dashboard-diagnostics.mjs'

let fd
const home = homedir()
try { fd = openDashboardErrorLog({ home }) }
catch (error) { recordDashboardEvent('log-unavailable', { message: error.message }, { home }) }

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: ['ignore', 'inherit', fd ?? 'inherit'], windowsHide: true,
})
if (fd !== undefined) closeSync(fd)
child.once('spawn', () => recordDashboardEvent('process-started', { launcherPid: process.pid }, { home, pid: child.pid }))
child.once('error', error => {
  recordDashboardEvent('launch-error', { code: error.code, message: error.message }, { home })
  process.exitCode = 1
})
child.once('close', (code, signal) => {
  recordDashboardEvent('process-exit', { code, signal, launcherPid: process.pid }, { home, pid: child.pid })
  process.exitCode = process.exitCode ?? code ?? 1
})
