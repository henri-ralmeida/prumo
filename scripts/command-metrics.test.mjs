import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { spawnSync } from 'node:child_process'
import { newCommandRecord, recordCommand, readCommandMetrics } from './command-metrics.mjs'
import { parseEngineArgs } from './engine-args.mjs'

async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'prumo-metrics-'))
  const run = join(root, 'run')
  mkdirSync(run)
  try { await fn(run) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('só registra em execução com state.json existente', () => fixture(run => {
  assert.equal(recordCommand(run, newCommandRecord('status'), 1), false)
  assert.deepEqual(readCommandMetrics(run), { byCommand: {}, total: 0, startedAt: null, complete: false })
  writeFileSync(join(run, 'state.json'), '{}')
  assert.equal(recordCommand(run, newCommandRecord('init'), 0), true)
  assert.equal(readCommandMetrics(run).complete, true)
}))

test('conta sucesso e falha uma vez por ID, sem alterar estado ou eventos', () => fixture(run => {
  writeFileSync(join(run, 'state.json'), '{"value":1}')
  writeFileSync(join(run, 'events.ndjson'), 'evento\n')
  const init = newCommandRecord('init')
  const note = newCommandRecord('note')
  const status = newCommandRecord('status')
  assert.equal(recordCommand(run, init, 0), true)
  assert.equal(recordCommand(run, note, 1), true)
  assert.equal(recordCommand(run, status, 0), true)
  const file = join(run, '.command-metrics.ndjson')
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  appendFileSync(file, lines[1] + '\n')
  const metrics = readCommandMetrics(run)
  assert.deepEqual(metrics.byCommand, { init: 1, note: 1, status: 1 })
  assert.equal(metrics.total, 3)
  assert.equal(metrics.complete, true)
  assert.equal(metrics.startedAt, [init, note, status].map(record => record.startedAt).sort()[0])
  assert.equal(readFileSync(join(run, 'state.json'), 'utf8'), '{"value":1}')
  assert.equal(readFileSync(join(run, 'events.ndjson'), 'utf8'), 'evento\n')
  for (const line of lines) assert.deepEqual(Object.keys(JSON.parse(line)), ['id', 'command', 'startedAt', 'finishedAt', 'exitCode'])
}))

test('cache devolve cópia e atualiza ao receber novos registros', () => fixture(run => {
  writeFileSync(join(run, 'state.json'), '{}')
  recordCommand(run, newCommandRecord('init'), 0)
  const first = readCommandMetrics(run)
  first.byCommand.init = 99
  assert.equal(readCommandMetrics(run).byCommand.init, 1)
  recordCommand(run, newCommandRecord('status'), 0)
  assert.equal(readCommandMetrics(run).total, 2)
}))

test('histórico anterior e linha corrompida deixam cobertura parcial', () => fixture(run => {
  writeFileSync(join(run, 'state.json'), '{}')
  recordCommand(run, newCommandRecord('status'), 0)
  assert.equal(readCommandMetrics(run).complete, false)
  appendFileSync(join(run, '.command-metrics.ndjson'), '{incompleto\n')
  const metrics = readCommandMetrics(run)
  assert.equal(metrics.total, 1)
  assert.equal(metrics.complete, false)
}))

test('nome herdado é contado sem herdar valor e não é comando reconhecido pelo motor', () => fixture(run => {
  writeFileSync(join(run, 'state.json'), '{}')
  recordCommand(run, newCommandRecord('init'), 0)
  recordCommand(run, newCommandRecord('constructor'), 1)
  const metrics = readCommandMetrics(run)
  assert.equal(metrics.byCommand.constructor, 1)
  assert.equal(metrics.total, 2)
  assert.throws(() => parseEngineArgs('constructor', []), /Unknown engine command/)
  assert.deepEqual(parseEngineArgs('status', []), { _: [] })
}))

test('gravações concorrentes preservam uma linha por comando', () => fixture(async run => {
  writeFileSync(join(run, 'state.json'), '{}')
  recordCommand(run, newCommandRecord('init'), 0)
  const source = `const { workerData, parentPort } = require('node:worker_threads'); import(workerData.moduleUrl).then(({ newCommandRecord, recordCommand }) => parentPort.postMessage(recordCommand(workerData.run, newCommandRecord('status'), 0))).catch(error => { throw error })`
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { run, moduleUrl: new URL('./command-metrics.mjs', import.meta.url).href } })
    worker.once('error', reject)
    worker.once('message', resolve)
  })))
  assert.deepEqual(outcomes, Array(8).fill(true))
  const metrics = readCommandMetrics(run)
  assert.equal(metrics.total, 9)
  assert.equal(metrics.byCommand.status, 8)
  assert.equal(metrics.complete, true)
}))

test('hook do motor conta consultas e falha reconhecida sem alterar estado ou eventos', () => fixture(run => {
  const workspace = join(run, 'workspace')
  const graph = join(workspace, '.specs', 'graph')
  const selectedRun = join(graph, 'metrics')
  mkdirSync(selectedRun, { recursive: true })
  const statePath = join(selectedRun, 'state.json')
  const eventsPath = join(selectedRun, 'events.ndjson')
  writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1, run: 'metrics', plan: { name: 'Teste', planningMode: 'task', phases: [] },
    tasks: { item: { id: 'item', title: 'Item', state: 'done', deps: [], attempts: [], validations: [], notes: [] } },
  }))
  writeFileSync(eventsPath, 'evento\n')
  const beforeState = readFileSync(statePath)
  const beforeEvents = readFileSync(eventsPath)
  const engine = fileURLToPath(new URL('./engine.mjs', import.meta.url))
  const invoke = extra => spawnSync(process.execPath, [engine, 'status', '--run', 'metrics', ...extra], {
    env: { ...process.env, PRUMO_ROOT: workspace }, encoding: 'utf8',
  })
  const first = invoke([])
  const second = invoke([])
  const failed = invoke(['--opcao-invalida'])
  assert.equal(first.error, undefined)
  assert.equal(second.error, undefined)
  assert.equal(failed.error, undefined)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(failed.status, 1)
  const metrics = readCommandMetrics(selectedRun)
  assert.deepEqual(metrics.byCommand, { status: 3 })
  assert.equal(metrics.total, 3)
  assert.equal(metrics.complete, false)
  const entries = readFileSync(join(selectedRun, '.command-metrics.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(entries.map(entry => entry.exitCode), [0, 0, 1])
  assert.deepEqual(readFileSync(statePath), beforeState)
  assert.deepEqual(readFileSync(eventsPath), beforeEvents)
}))
