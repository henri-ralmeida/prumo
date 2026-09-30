import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const cache = new Map()

export function newCommandRecord(command) {
  return { id: randomUUID(), command, startedAt: new Date().toISOString() }
}

export function recordCommand(runDir, record, exitCode) {
  try {
    if (!statSync(join(runDir, 'state.json')).isFile()) return false
    const entry = {
      id: record.id,
      command: record.command,
      startedAt: record.startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
    }
    appendFileSync(join(runDir, '.command-metrics.ndjson'), JSON.stringify(entry) + '\n')
    return true
  } catch {
    // A falha da observação não altera o resultado do comando.
    return false
  }
}

function empty() {
  return { byCommand: {}, total: 0, startedAt: null, complete: false }
}

export function readCommandMetrics(runDir) {
  const path = join(runDir, '.command-metrics.ndjson')
  let stat
  try { stat = statSync(path) } catch { cache.delete(path); return empty() }
  if (!stat.isFile()) return empty()
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  const cached = cache.get(path)
  if (cached?.signature === signature) return structuredClone(cached.result)

  const result = empty()
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    const seen = new Set()
    let valid = true
    let first = null
    for (const line of lines) {
      if (!line) continue
      let entry
      try { entry = JSON.parse(line) } catch { valid = false; continue }
      if (typeof entry?.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(entry.id) ||
          typeof entry.command !== 'string' || !/^[a-z][a-z-]*$/.test(entry.command) ||
          !Number.isFinite(Date.parse(entry.startedAt)) || !Number.isFinite(Date.parse(entry.finishedAt)) ||
          !Number.isSafeInteger(entry.exitCode) || entry.exitCode < 0) {
        valid = false
        continue
      }
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      first ??= entry
      result.byCommand[entry.command] = (Object.hasOwn(result.byCommand, entry.command)
        ? result.byCommand[entry.command] : 0) + 1
      result.total++
      if (result.startedAt === null || entry.startedAt < result.startedAt) result.startedAt = entry.startedAt
    }
    result.complete = valid && first?.command === 'init' && first.exitCode === 0
  } catch {
    return empty()
  }
  cache.set(path, { signature, result })
  while (cache.size > 32) cache.delete(cache.keys().next().value)
  return structuredClone(result)
}
