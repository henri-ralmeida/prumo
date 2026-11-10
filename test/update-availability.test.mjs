import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { launchUpdate } from '../lib/update.mjs'
import { dashboardHealth, dashboardStatus, stopDashboardForUpdate } from '../lib/autostart.mjs'
import { HARNESSES } from '../lib/install.mjs'

for (const harness of HARNESSES) test(`idioma explícito já instalado não exige atualização nem reinício: ${harness}`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-kiro-idempotente-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const config = join(home, `.${harness}`), root = join(config, 'skills')
  mkdirSync(join(root, 'prumo'), { recursive: true })
  const po = harness === 'kiro' ? join(config, 'steering', 'po-first.md')
    : harness === 'claude' ? join(config, 'output-styles', 'po-first.md')
    : join(config, harness === 'copilot' ? 'copilot-instructions.md' : 'AGENTS.md')
  mkdirSync(join(po, '..'), { recursive: true })
  writeFileSync(join(root, 'prumo', '.prumo-install.json'), JSON.stringify({ product: 'prumo', harness, version: '2.12.1', lang: 'pt-BR' }))
  writeFileSync(po, '<!-- po-first:start -->\n## Texto entregue junto ao produto\n<!-- po-first:end -->\n')
  let reported = false
  const request = { cwd: home, projects: [], sourceVersion: '2.12.1', globalVersion: '2.12.1', lang: 'pt-BR' }
  const deps = {
    discover: () => [{ harness, config, roots: [root] }], latestVersion: () => '2.12.1',
    filesCurrent: () => true, status: async () => ({ enabled: true, process: 'running', registered: true, version: '2.12.1', contentCurrent: true, lang: 'pt-BR' }),
    onCurrent: () => { reported = true }, run: () => assert.fail('Atualização dispensável iniciou o npm'),
    repair: () => assert.fail('Dashboard correto não deve reiniciar'),
  }
  const code = await launchUpdate(request, deps)
  assert.equal(code, 0); assert.equal(reported, true)
  let updates = 0
  const run = () => {
    updates++
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => child.emit('close', 0, null))
    return child
  }
  const update = overrides => launchUpdate(request, { ...deps, run, ...overrides })
  await update({ filesCurrent: () => false })
  assert.equal(updates, 1, 'Arquivos alterados continuam exigindo reparo')
  await launchUpdate({ ...request, lang: 'en' }, { ...deps, run })
  assert.equal(updates, 2, 'Uma mudança real de idioma continua atualizando')
  writeFileSync(po, '<!-- po-first:start -->\n## Text delivered with the product\n<!-- po-first:end -->\n')
  await update({})
  assert.equal(updates, 3, 'O idioma divergente do PO First também exige atualização')
  await launchUpdate({ ...request, lang: 'en' }, { ...deps, run })
  assert.equal(updates, 4, 'O idioma divergente do motor exige atualização mesmo com PO First correto')
  writeFileSync(po, '<!-- po-first:start -->\n## Texto entregue junto ao produto\n<!-- po-first:end -->\n')
  await launchUpdate({ ...request, pendingUpdate: true }, { ...deps, run })
  assert.equal(updates, 5, 'Uma atualização interrompida não deve ser dispensada')
  let repaired
  await update({ status: async options => {
    assert.equal(options.lang, 'pt-BR')
    return { enabled: true, process: 'running', registered: true, version: '2.12.1', contentCurrent: false }
  }, repair: async options => { repaired = options; return { ok: true } } })
  assert.equal(repaired.lang, 'pt-BR', 'O reparo deve preservar o idioma solicitado')
  assert.equal(updates, 5, 'Um reparo apenas do dashboard dispensa download')
  await update({ status: async () => ({ disabled: true, enabled: false, process: 'stopped' }) })
  assert.equal(updates, 5, 'A preferência de desativação permanece respeitada')
})

test('resposta Prumo em 2,4 segundos não é conflito de porta', async t => {
  const timers = new Set()
  const server = createServer((request, response) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(request.url === '/api/health'
        ? { product: 'prumo', mode: 'global', readOnly: true, pid: 1234, version: '2.12.1' }
        : { version: '2.12.1', contentId: 'isolado', path: '/isolado' }))
    }, request.url === '/api/health' ? 2400 : 0)
    timers.add(timer)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const address = `http://127.0.0.1:${server.address().port}`
  const health = await dashboardHealth({ contentId: 'isolado',
    fetch: (url, options) => fetch(address + new URL(url).pathname, options),
    portAvailable: async () => false, delay: async () => {},
  })
  assert.equal(health.state, 'running')
  assert.equal(health.slow, true)
  assert.ok(health.responseMs >= 1200)
})

for (const platform of ['win32', 'linux', 'darwin']) test(`porta lenta, parada e ocupada preserva processos desconhecidos: ${platform}`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-porta-isolada-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const kills = []
  const options = { home, platform, version: '2.12.1', contentId: 'isolado', env: {}, uid: () => 1234,
    exec: () => ({ status: 1, stdout: '' }), delay: async () => {}, kill: pid => kills.push(pid),
    fetch: async () => { throw new DOMException('prazo esgotado', 'TimeoutError') }, portAvailable: async () => false }
  let status = await dashboardStatus(options)
  assert.equal(status.process, 'unresponsive')
  assert.equal(status.conflict, false)
  let stopped = await stopDashboardForUpdate(options)
  assert.equal(stopped.ok, false)
  assert.match(stopped.error, /Ownership is unverified/)
  const foreign = { ...options, fetch: async () => ({ ok: true, json: async () => ({ product: 'outro-serviço' }) }) }
  status = await dashboardStatus(foreign)
  assert.equal(status.process, 'conflict')
  assert.equal(status.conflict, true)
  stopped = await stopDashboardForUpdate(foreign)
  assert.equal(stopped.ok, false)
  assert.match(stopped.error, /another program/)
  status = await dashboardStatus({ ...options, portAvailable: async () => true })
  assert.equal(status.process, 'stopped')
  assert.equal(status.conflict, false)
  assert.deepEqual(kills, [])
})
