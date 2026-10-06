import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'

test('histórico recupera leituras interrompidas sem modificar eventos completos ou campos desconhecidos', { timeout: 30000 }, async t => {
  const base = realpathSync(tmpdir()), home = mkdtempSync(join(base, 'prumo-history-faults-'))
  const central = join(home, 'central'), graph = join(central, 'project', '.specs', 'graph', 'demo')
  mkdirSync(graph, { recursive: true })
  const stateFile = join(graph, 'state.json'), eventsFile = join(graph, 'events.ndjson')
  const originalState = JSON.stringify({ plan: { name: 'Histórico' }, tasks: {}, unknown: { keep: true } })
  writeFileSync(stateFile, originalState)
  let events = JSON.stringify({ sequence: 1, unknown: 'preservado' }) + '\n'
  writeFileSync(eventsFile, events)
  const faultFile = join(home, 'fault.json'), preload = join(home, 'faults.mjs')
  writeFileSync(faultFile, '"none"')
  writeFileSync(preload, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { ServerResponse } from 'node:http'
import { takeCoverage } from 'node:v8'
const original = { ...fs }, files = new Map()
let previous, stats = 0
const mode = () => JSON.parse(original.readFileSync(${JSON.stringify(faultFile)}, 'utf8'))
const eventPath = p => typeof p === 'string' && p.endsWith('events.ndjson')
fs.openSync = (p, ...args) => { const fd = original.openSync(p, ...args); files.set(fd, p); return fd }
fs.closeSync = fd => { files.delete(fd); return original.closeSync(fd) }
fs.readFileSync = (p, ...args) => {
  if (eventPath(files.get(p))) {
    if (mode() === 'initial-error') throw new Error('leitura inicial interrompida')
    if (mode() === 'non-error') throw null
  }
  return original.readFileSync(p, ...args)
}
fs.readSync = (fd, buffer, offset, length, position) => {
  if (eventPath(files.get(fd))) {
    const active = mode()
    if (active === 'tail-error' && Number.isInteger(position)) throw new Error('cauda interrompida')
    if (active === 'tail-zero' && position === 0) return 0
    if (active === 'added-zero' && position > 0) return 0
  }
  return original.readSync(fd, buffer, offset, length, position)
}
fs.statSync = (p, ...args) => {
  if (eventPath(p)) {
    const active = mode()
    if (active !== previous) { previous = active; stats = 0 }
    if (active === 'final-stat-error' && ++stats === 2) throw new Error('arquivo indisponível durante a leitura')
  }
  return original.statSync(p, ...args)
}
const end = ServerResponse.prototype.end
const destroy = ServerResponse.prototype.destroy
ServerResponse.prototype.destroy = function (...args) {
  const result = destroy.apply(this, args)
  if (process.env.NODE_V8_COVERAGE && process.env.PRUMO_TEST_COVERAGE_FLUSH === '1') takeCoverage()
  return result
}
ServerResponse.prototype.end = function (...args) {
  if (mode() === 'response-error' && String(args[0]).includes('<html')) {
    this.flushHeaders()
    throw new Error('resposta interrompida')
  }
  return end.apply(this, args)
}
syncBuiltinESMExports()
`)
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href,
    fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url)), '--global', '--port', '0'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: central, PRUMO_ROOT: '', GRAPH_ROOT: '', PRUMO_LANG: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await closed
    assert.equal(dirname(home), base)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  let output = ''
  child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
  const deadline = Date.now() + 10000
  while (!/localhost:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await setTimeout(20)
  const port = output.match(/localhost:(\d+)/)?.[1]
  assert.ok(port && port !== '0', output)
  const request = path => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) })
  const query = '/api/events?root=project&run=demo&after=0'
  const fault = value => writeFileSync(faultFile, JSON.stringify(value))
  const reset = async () => { rmSync(eventsFile); await request(query); writeFileSync(eventsFile, events) }
  const read = async () => { const res = await request(query); return { status: res.status, body: await res.json() } }
  for (const mode of ['initial-error', 'tail-error', 'non-error']) {
    await reset(); fault(mode)
    assert.equal((await read()).status, 500)
    assert.equal(readFileSync(eventsFile, 'utf8'), events)
    fault('none')
    assert.equal((await read()).body.events[0].unknown, 'preservado')
  }
  await reset(); fault('tail-zero')
  assert.equal((await read()).body.events.length, 1)
  events += JSON.stringify({ sequence: 2 }) + '\n'; writeFileSync(eventsFile, events)
  fault('none'); assert.equal((await read()).body.events.length, 2)
  events += JSON.stringify({ sequence: 3 }) + '\n'; writeFileSync(eventsFile, events)
  fault('tail-zero'); assert.equal((await read()).body.events.length, 3)
  fault('none'); await reset(); await read()
  events += JSON.stringify({ sequence: 4 }) + '\n'; writeFileSync(eventsFile, events)
  fault('added-zero'); assert.equal((await read()).body.complete, false)
  fault('none'); assert.equal((await read()).body.events.length, 4)
  await reset(); fault('final-stat-error')
  assert.equal((await read()).body.complete, false)
  fault('none'); assert.equal((await read()).body.complete, true)
  fault('response-error'); await assert.rejects(async () => { const response = await request('/index.html'); await response.text() })
  fault('none'); assert.equal((await request('/index.html')).status, 200)
  assert.equal(readFileSync(eventsFile, 'utf8'), events)
  assert.equal(readFileSync(stateFile, 'utf8'), originalState)
})

async function isolatedServer(t, { layout = 'workspace', args = [], preload = '', initialize = () => {} } = {}) {
  const base = realpathSync(tmpdir()), home = mkdtempSync(join(base, 'prumo-server-startup-'))
  const central = join(home, 'central'), root = join(central, 'project'), graph = join(root, '.specs', 'graph')
  mkdirSync(graph, { recursive: true })
  initialize(home, graph)
  const original = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))
  const pkg = layout === 'global' ? join(home, 'node_modules', 'prumo') : join(home, 'package')
  cpSync(dirname(original), join(pkg, 'scripts'), { recursive: true })
  cpSync(fileURLToPath(new URL('../lib', import.meta.url)), join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', version: '2.3.2' }))
  if (layout === 'installed') writeFileSync(join(pkg, '.prumo-install.json'), '{}')
  const importFile = join(home, 'preload.mjs')
  writeFileSync(importFile, preload.replaceAll('FAULT_FILE', JSON.stringify(join(home, 'fault.json'))))
  const child = spawn(process.execPath, ['--import', pathToFileURL(importFile).href, join(pkg, 'scripts', 'serve.mjs'), '--port', '0', ...args], {
    cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: central, PRUMO_ROOT: root, GRAPH_ROOT: '', PRUMO_LANG: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  t.after(async () => {
    if (child.exitCode === null) child.kill()
    await closed
    assert.equal(dirname(home), base)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  let output = ''
  child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
  const deadline = Date.now() + 10000
  while (!/localhost:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await setTimeout(20)
  const port = output.match(/localhost:(\d+)/)?.[1]
  assert.ok(port && port !== '0', output)
  return { home, graph, output: () => output, get: async path => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) })
    return { status: response.status, body: await response.json() }
  } }
}

test('API identifica pacote global e cópia instalada com execução fixada sem CURRENT', { timeout: 30000 }, async t => {
  for (const layout of ['global', 'installed']) {
    const server = await isolatedServer(t, { layout, args: ['--run', 'demo'] })
    assert.equal((await server.get('/api/about')).body.origin, layout)
    const history = await server.get('/api/changelog')
    assert.equal(history.status, 200)
    assert.ok(history.body.some(release => release.version === '2.3.1'), 'o histórico publicado funciona nas cópias global e instalada, fora do checkout')
    mkdirSync(join(server.graph, 'demo'))
    const path = join(server.graph, 'demo', 'state.json'), state = JSON.stringify({ plan: { name: layout }, tasks: {}, keep: layout })
    writeFileSync(path, state)
    assert.equal((await server.get('/api/state')).body.keep, layout)
    assert.equal(readFileSync(path, 'utf8'), state)
  }
})

test('sincronização espera execução e fonte disponíveis, registra falhas sem descartar estado e tenta novamente', { timeout: 30000 }, async t => {
  const server = await isolatedServer(t, { args: ['--sync-plan'], preload: `
import cp from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
cp.execFile = (...args) => {
  const mode = JSON.parse(fs.readFileSync(FAULT_FILE, 'utf8'))
  const callback = args.at(-1)
  queueMicrotask(() => mode === 'stdout' ? callback(new Error('erro'), 'falha pelo stdout', '')
    : mode === 'message' ? callback(new Error('falha pela mensagem'), '', '')
    : callback(null, mode === 'empty' ? '' : mode === 'changed' ? 'contrato sincronizado' : 'already matches plan', ''))
}
syncBuiltinESMExports()
` })
  assert.equal((await server.get('/api/state')).status, 404)
  await setTimeout(1100)
  writeFileSync(join(server.graph, 'CURRENT'), 'demo')
  await setTimeout(1100)
  mkdirSync(join(server.graph, 'demo'))
  const path = join(server.graph, 'demo', 'state.json'), source = join(server.home, 'source.json')
  const state = JSON.stringify({ plan: { name: 'Sincronização', source }, tasks: {}, unknown: true })
  writeFileSync(path, state)
  await setTimeout(1100)
  writeFileSync(join(server.home, 'fault.json'), '"stdout"')
  writeFileSync(source, '{}')
  for (const mode of ['stdout', 'message', 'success', 'empty', 'changed']) {
    writeFileSync(join(server.home, 'fault.json'), JSON.stringify(mode))
    writeFileSync(source, JSON.stringify({ mode }))
    const deadline = Date.now() + 5000
    while (['stdout', 'message'].includes(mode) && !server.output().includes(mode === 'stdout' ? 'falha pelo stdout' : 'falha pela mensagem') && Date.now() < deadline) await setTimeout(20)
    if (['success', 'empty', 'changed'].includes(mode)) await setTimeout(1100)
    else assert.ok(server.output().includes(mode === 'stdout' ? 'falha pelo stdout' : 'falha pela mensagem'), server.output())
    if (mode === 'changed') assert.ok(server.output().includes('contrato sincronizado'), server.output())
    assert.equal((await server.get('/api/state')).body.unknown, true)
    assert.equal(readFileSync(path, 'utf8'), state)
  }
  if (process.env.NODE_V8_COVERAGE && process.env.PRUMO_TEST_COVERAGE_FLUSH === '1') await setTimeout(100)
})

test('inicialização diagnostica workspace ausente e recupera leitura transitória de CURRENT', { timeout: 30000 }, async t => {
  const server = await isolatedServer(t, { initialize(home, graph) {
    writeFileSync(join(graph, 'CURRENT'), 'demo')
    mkdirSync(join(graph, 'demo'))
    writeFileSync(join(graph, 'demo', 'state.json'), JSON.stringify({ plan: { name: 'Preservado' }, tasks: {} }))
  }, preload: `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const read = fs.readFileSync
let pending = true
fs.readFileSync = (path, ...args) => {
  if (pending && String(path).endsWith('CURRENT')) { pending = false; throw new Error('CURRENT temporariamente indisponível') }
  return read(path, ...args)
}
syncBuiltinESMExports()
` })
  assert.match(server.output(), /Could not read current run/)
  assert.equal((await server.get('/api/health')).status, 200)
  assert.equal((await server.get('/api/state')).body.plan.name, 'Preservado')
  const missing = join(server.home, 'missing')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url)), '--port', '0'], {
    cwd: server.home, env: { ...process.env, HOME: server.home, USERPROFILE: server.home, PRUMO_HOME: join(server.home, 'central'), PRUMO_ROOT: missing, PRUMO_LANG: 'en' },
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /does not exist/)
  assert.equal(readFileSync(join(server.graph, 'CURRENT'), 'utf8'), 'demo')
})

test('porta ocupada identifica instalações conhecidas e tolera identidade incompleta ou serviço indisponível', { timeout: 30000 }, t => {
  const base = realpathSync(tmpdir()), home = mkdtempSync(join(base, 'prumo-occupied-faults-'))
  const preload = join(home, 'occupied.mjs'), identity = join(home, 'identity.json')
  t.after(() => { assert.equal(dirname(home), base); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  writeFileSync(preload, `
import { Server } from 'node:http'
import { readFileSync } from 'node:fs'
Server.prototype.listen = function () {
  queueMicrotask(() => this.emit('error', Object.assign(new Error('porta ocupada'), { code: 'EADDRINUSE' })))
  return this
}
globalThis.fetch = async () => {
  const about = JSON.parse(readFileSync(${JSON.stringify(identity)}, 'utf8'))
  if (about === 'unavailable') throw new Error('serviço indisponível')
  return { ok: true, json: async () => about }
}
`)
  for (const about of ['unavailable', { product: 'other' }, ...['global', 'installed', 'workspace', 'unexpected', 'repository'].map(origin => ({ product: 'prumo', origin })),
    { product: 'prumo', origin: 'repository', commit: 'abcdef', version: '2.3.2', contentId: 'identidade', path: 'pacote' }]) {
    writeFileSync(identity, JSON.stringify(about))
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
      fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url)), '--global', '--port', '0', '--run', 'demo'], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: join(home, 'central'), PRUMO_LANG: 'en' },
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Port 0 is used/)
    assert.match(result.stderr, /To run a second dashboard/)
    assert.equal(result.stderr.includes('add --run'), false)
    if (about?.product === 'prumo') assert.match(result.stderr, /Prumo/)
    else assert.match(result.stderr, /unidentified process/)
  }
})
