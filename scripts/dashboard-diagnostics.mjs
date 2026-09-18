import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_BYTES = 256 * 1024
const paths = home => {
  const directory = join(home, '.local', 'share', 'prumo')
  return { directory, file: join(directory, 'dashboard-events.ndjson') }
}

export function recordDashboardEvent(event, fields = {}, { home = homedir(), pid = process.pid, version, port } = {}) {
  try {
    const { directory, file } = paths(home)
    mkdirSync(directory, { recursive: true })
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      rmSync(`${file}.previous`, { force: true })
      renameSync(file, `${file}.previous`)
    }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid, version, port, event, ...fields })}\n`)
  } catch { /* Diagnóstico indisponível não pode derrubar nem bloquear o servidor. */ }
}

export function readDashboardEvents({ home = homedir(), limit = 30 } = {}) {
  const { file } = paths(home)
  const events = []
  for (const candidate of [`${file}.previous`, file]) {
    if (!existsSync(candidate)) continue
    for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try { events.push(JSON.parse(line)) } catch { events.push({ event: 'invalid-log-entry', message: line.slice(0, 500) }) }
    }
  }
  return events.slice(-Math.max(1, Math.min(Number(limit) || 30, 200)))
}

export function dashboardDiagnostics({ home = homedir(), processRef = process, version, port } = {}) {
  const record = (event, fields = {}) => recordDashboardEvent(event, fields, { home, pid: processRef.pid, version, port })
  processRef.on('uncaughtExceptionMonitor', (error, origin) => record('fatal', {
    origin, code: error?.code, message: String(error?.message ?? error).slice(0, 2000),
  }))
  processRef.on('warning', warning => record('warning', {
    name: warning?.name, code: warning?.code, message: String(warning?.message ?? warning).slice(0, 2000),
  }))
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) processRef.on(signal, () => {
    record('signal', { signal })
    processRef.exit(code)
  })
  processRef.on('exit', code => record('exit', { code }))
  return record
}
