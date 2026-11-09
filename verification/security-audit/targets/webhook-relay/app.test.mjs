import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from './server.mjs'

test('registered callbacks receive published events', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-relay-'))
  const received = []
  const receiver = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.end('ok')
  })
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r))
  const server = createApp({ logFile: path.join(dir, 'access.log') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.close(); receiver.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, p, { body, token } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, json: await res.json() }
  }

  assert.equal((await call('POST', '/auth/register', { body: { email: 'ops@example.test', password: 'long-enough-1' } })).status, 201)
  assert.equal((await call('POST', '/auth/login', { body: { email: 'ops@example.test', password: 'nope-nope-nope' } })).status, 401)
  const { json: { token } } = await call('POST', '/auth/login', { body: { email: 'ops@example.test', password: 'long-enough-1' } })

  assert.equal((await call('POST', '/webhooks', { token, body: { url: 'ftp://example.test/x' } })).status, 400)
  const hook = await call('POST', '/webhooks', { token, body: { url: `http://127.0.0.1:${receiver.address().port}/in` } })
  assert.equal(hook.status, 201)

  const sent = await call('POST', '/events', { token, body: { type: 'order.paid', payload: { id: 7 } } })
  assert.equal(sent.status, 202)
  assert.equal(sent.json.deliveries, 1)
  assert.equal(received.length, 1)
  assert.equal(received[0].type, 'order.paid')

  const deliveries = await call('GET', '/deliveries', { token })
  assert.equal(deliveries.json[0].status, 200)
  assert.equal((await call('GET', '/webhooks')).status, 401)
})
