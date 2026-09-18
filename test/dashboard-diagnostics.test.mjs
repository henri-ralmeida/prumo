import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { dashboardDiagnostics, readDashboardEvents, recordDashboardEvent } from '../scripts/dashboard-diagnostics.mjs'

test('diagnóstico limita histórico e não captura a exceção fatal do servidor', t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-diagnostics-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const bus = new EventEmitter()
  bus.pid = 42
  bus.exit = code => { bus.exitCode = code }
  const record = dashboardDiagnostics({ home, processRef: bus, version: 'test', port: 4949 })
  const file = join(home, '.local/share/prumo/dashboard-events.ndjson')
  record('listening')
  assert.equal(bus.listenerCount('uncaughtException'), 0)
  writeFileSync(file, 'x'.repeat(262145))
  record('listening')
  assert.ok(existsSync(`${file}.previous`))
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 42)
  const module = new URL('../scripts/dashboard-diagnostics.mjs', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { dashboardDiagnostics } from ${JSON.stringify(module)}; dashboardDiagnostics({home: ${JSON.stringify(home)}, version:'test', port:4949}); setImmediate(() => { throw new Error('falha isolada'); });`],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.ifError(child.error)
  assert.equal(child.status, 1, 'Não continuar após exceção fatal')
  const events = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(events.some(event => event.event === 'fatal' && event.message === 'falha isolada'))
  assert.ok(events.some(event => event.event === 'exit' && event.code === 1))
})

test('diagnóstico registra sinal, limita leitura e tolera entrada antiga corrompida', t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-diagnostics-history-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const bus = new EventEmitter()
  bus.pid = 84
  bus.exit = code => { bus.exitCode = code }
  dashboardDiagnostics({ home, processRef: bus, version: 'test', port: 4949 })
  bus.emit('SIGTERM')
  assert.equal(bus.exitCode, 143)
  recordDashboardEvent('listening', {}, { home, pid: 85, version: 'test', port: 4949 })
  const file = join(home, '.local/share/prumo/dashboard-events.ndjson')
  writeFileSync(file, `${readFileSync(file, 'utf8')}linha-invalida\n`)
  const events = readDashboardEvents({ home, limit: 2 })
  assert.equal(events.length, 2)
  assert.equal(events[0].event, 'listening')
  assert.equal(events[1].event, 'invalid-log-entry')
  assert.ok(readDashboardEvents({ home, limit: 2000 }).length <= 200)
})
