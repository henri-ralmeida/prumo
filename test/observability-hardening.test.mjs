import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { writeAtomicState } from '../scripts/atomic-state.mjs'
import { newCommandRecord, recordCommand, readCommandMetrics } from '../scripts/command-metrics.mjs'
import { dashboardDiagnostics, readDashboardEvents, recordDashboardEvent } from '../scripts/dashboard-diagnostics.mjs'
import { releaseHistory, releaseNotes } from '../lib/release-notes.mjs'
import { isReadyForReview } from '../scripts/review-readiness.mjs'

function temporary(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'prumo-observation-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); fs.rmSync(root, { recursive: true, force: true }) })
  return root
}
function replace(t, name, fn) {
  const previous = fs[name]
  fs[name] = fn
  syncBuiltinESMExports()
  t.after(() => { fs[name] = previous; syncBuiltinESMExports() })
  return previous
}

test('gravação atômica preserva o destino quando o Windows mantém o arquivo bloqueado', t => {
  const root = temporary(t), file = join(root, 'state.json')
  fs.writeFileSync(file, 'original')
  let attempts = 0
  replace(t, 'renameSync', () => { attempts++; throw Object.assign(new Error('bloqueado'), { code: 'EBUSY' }) })
  assert.throws(() => writeAtomicState(file, 'novo'), /bloqueado/)
  assert.equal(attempts, 5)
  assert.equal(fs.readFileSync(file, 'utf8'), 'original')
  assert.deepEqual(fs.readdirSync(root), ['state.json'])
})

test('erro original de gravação permanece mesmo quando a limpeza temporária falha', t => {
  const root = temporary(t), file = join(root, 'state.json')
  replace(t, 'renameSync', () => { throw Object.assign(new Error('destino inválido'), { code: 'EINVAL' }) })
  const remove = replace(t, 'rmSync', (...args) => {
    if (String(args[0]).endsWith('.tmp')) throw new Error('limpeza bloqueada')
    return remove(...args)
  })
  assert.throws(() => writeAtomicState(file, 'novo'), /destino inválido/)
  assert.equal(fs.existsSync(file), false)
})

test('métricas são opcionais e não inventam comandos para arquivos inválidos ou duplicados', t => {
  const root = temporary(t)
  fs.mkdirSync(join(root, 'state.json'))
  assert.equal(recordCommand(root, newCommandRecord('init'), 0), false)
  fs.mkdirSync(join(root, '.command-metrics.ndjson'))
  assert.equal(readCommandMetrics(root).total, 0)
  fs.rmSync(join(root, '.command-metrics.ndjson'), { recursive: true })
  const base = { ...newCommandRecord('init'), finishedAt: new Date().toISOString(), exitCode: 0 }
  const invalid = [null, { ...base, id: 'inválido' }, { ...base, command: 1 }, { ...base, command: 'Init' },
    { ...base, startedAt: 'inválido' }, { ...base, finishedAt: null }, { ...base, exitCode: 0.5 }, { ...base, exitCode: -1 }]
  const older = { ...newCommandRecord('execute'), startedAt: '2020-01-01T00:00:00Z', finishedAt: '2020-01-01T00:01:00Z', exitCode: 0 }
  const file = join(root, '.command-metrics.ndjson')
  fs.writeFileSync(file, [JSON.stringify(base), JSON.stringify(base), ...invalid.map(JSON.stringify), '{', JSON.stringify(older), ''].join('\n'))
  const result = readCommandMetrics(root)
  assert.equal(result.total, 2)
  assert.equal(result.complete, false)
  assert.equal(result.startedAt, older.startedAt)
  result.byCommand.init = 99
  assert.equal(readCommandMetrics(root).byCommand.init, 1)
  const read = replace(t, 'readFileSync', (...args) => {
    if (args[0] === file) throw new Error('leitura bloqueada')
    return read(...args)
  })
  fs.appendFileSync(file, '\n')
  assert.equal(readCommandMetrics(root).total, 0)
})

test('cache de métricas limitado continua correto ao alternar muitos planos', t => {
  const root = temporary(t)
  for (let index = 0; index < 34; index++) {
    const run = join(root, String(index))
    fs.mkdirSync(run)
    fs.writeFileSync(join(run, 'state.json'), '{}')
    assert.equal(recordCommand(run, newCommandRecord('init'), 0), true)
    assert.equal(readCommandMetrics(run).complete, true)
  }
  assert.equal(readCommandMetrics(join(root, '0')).total, 1)
})

test('diagnósticos limitam entradas e registram sinais sem depender de Error', t => {
  const home = temporary(t), proc = new EventEmitter()
  proc.pid = 42
  const exits = []
  proc.exit = code => exits.push(code)
  dashboardDiagnostics({ home, processRef: proc })
  proc.emit('uncaughtExceptionMonitor', 'falha', 'origem')
  proc.emit('warning', 'aviso')
  proc.emit('SIGTERM')
  proc.emit('SIGINT')
  proc.emit('exit', 0)
  assert.deepEqual(exits, [143, 130])
  assert.equal(readDashboardEvents({ home, limit: 0 }).length, 5)
  assert.equal(readDashboardEvents({ home, limit: -1 }).length, 1)
  assert.equal(readDashboardEvents({ home })[0].message, 'falha')
  const blocked = join(home, 'blocked')
  fs.writeFileSync(blocked, 'arquivo')
  assert.doesNotThrow(() => recordDashboardEvent('warning', {}, { home: blocked }))
})

test('versão desconhecida e ausência de intervalo de execução não inventam resultado', () => {
  assert.deepEqual(releaseNotes('0.0.0'), [])
  assert.deepEqual(releaseHistory(undefined, '0.0.0'), [{ version: '0.0.0', sections: [] }])
  assert.equal(isReadyForReview({ state: 'running', attempts: [{ activityTiming: 'explicit' }] }), false)
})
