import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const shutdownPath = '/__prumo_test_dashboard_shutdown/token-do-cenario'

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})
const close = server => new Promise(resolve => server.close(resolve))

test('desligamento isolado ignora servidor alheio mesmo quando informa outro PID', async () => {
  const foreign = createServer((request, response) => {
    response.writeHead(request.url === '/api/health' ? 200 : 404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ product: 'prumo', pid: process.pid + 1000 }))
  })
  const port = await listen(foreign)
  try {
    const shutdown = await fetch(`http://127.0.0.1:${port}${shutdownPath}`, { method: 'POST' })
    assert.equal(shutdown.status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200)
  } finally {
    await close(foreign)
  }
})

test('somente dashboard com preload e token do cenário encerra o próprio processo', async () => {
  const probe = createServer()
  const port = await listen(probe)
  await close(probe)
  const child = spawn(process.execPath, ['-e',
    "require('node:http').createServer((request, response) => { response.end('ativo') }).listen(4949, '127.0.0.1', () => console.log('pronto'))"], {
    env: { ...process.env, NODE_OPTIONS: `--import="${new URL('./fixtures/dashboard-port.mjs', import.meta.url).href}"`,
      PRUMO_TEST_DASHBOARD_PORT: String(port), PRUMO_TEST_DASHBOARD_SHUTDOWN_TOKEN: 'token-do-cenario' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  const closed = new Promise(resolve => child.once('close', resolve))
  try {
    const deadline = Date.now() + 10000
    while (!output.includes('pronto')) {
      assert.equal(child.exitCode, null, output)
      if (Date.now() > deadline) throw new Error(`dashboard de teste não iniciou: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await fetch(`http://127.0.0.1:${port}/__prumo_test_dashboard_shutdown/token-errado`, { method: 'POST' })
    assert.equal(child.exitCode, null, 'token errado não encerra o dashboard')
    const shutdown = await fetch(`http://127.0.0.1:${port}${shutdownPath}`, { method: 'POST' })
    assert.equal(shutdown.status, 200)
    assert.equal(await closed, 0)
  } finally {
    if (child.exitCode === null) child.kill()
    await closed
  }
})
