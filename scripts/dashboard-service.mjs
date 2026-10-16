// O lancador conserva stderr e o resultado do processo sem manter um terminal aberto e recria o dashboard após uma queda.
import { spawn } from 'node:child_process'
import { closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { openDashboardErrorLog, recordDashboardEvent } from './dashboard-diagnostics.mjs'
import { dashboardDisabled, dashboardPortServed, serverPort, stopRequestedSince, superviseDashboard } from './dashboard-supervisor.mjs'

const home = homedir()
const args = process.argv.slice(2)

function launch() {
  let fd
  try { fd = openDashboardErrorLog({ home }) }
  catch (error) { recordDashboardEvent('log-unavailable', { message: error.message }, { home }) }
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'inherit', fd ?? 'inherit'], windowsHide: true,
    })
    if (fd !== undefined) closeSync(fd)
    child.once('spawn', () => recordDashboardEvent('process-started', { launcherPid: process.pid }, { home, pid: child.pid }))
    child.once('error', error => {
      recordDashboardEvent('launch-error', { code: error.code, message: error.message }, { home })
      resolve({ error })
    })
    child.once('close', (code, signal) => {
      recordDashboardEvent('process-exit', { code, signal, launcherPid: process.pid }, { home, pid: child.pid })
      resolve({ code, signal })
    })
  })
}

// PRUMO_DASHBOARD_RESTART_LIMIT=0 desliga a recriação, por exemplo para diagnosticar uma queda.
const configured = Number(process.env.PRUMO_DASHBOARD_RESTART_LIMIT ?? 'default')
const result = await superviseDashboard({
  launch, record: (event, fields) => recordDashboardEvent(event, fields, { home }),
  disabled: () => dashboardDisabled(home), stopRequested: since => stopRequestedSince(home, since),
  portServed: dashboardPortServed, port: serverPort(args),
  limit: Number.isInteger(configured) && configured >= 0 ? configured : undefined,
})
process.exitCode = result.error ? 1 : result.code ?? 1
