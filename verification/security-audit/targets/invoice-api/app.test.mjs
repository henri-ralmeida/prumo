import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './server.mjs'

async function start() {
  const server = createApp()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, { body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, json: await res.json() }
  }
  return { server, call }
}

test('customer registers, logs in and manages own invoices', async (t) => {
  const { server, call } = await start()
  t.after(() => server.close())
  const reg = await call('POST', '/auth/register', { body: { email: 'bia@example.test', password: 'correct-horse-1', name: 'Bia' } })
  assert.equal(reg.status, 201)
  assert.equal(reg.json.role, 'customer')
  assert.equal(reg.json.passwordHash, undefined)
  const bad = await call('POST', '/auth/login', { body: { email: 'bia@example.test', password: 'wrong-password' } })
  assert.equal(bad.status, 401)
  const login = await call('POST', '/auth/login', { body: { email: 'bia@example.test', password: 'correct-horse-1' } })
  const token = login.json.token
  const created = await call('POST', '/invoices', { token, body: { amount: 250, description: 'Setup' } })
  assert.equal(created.status, 201)
  const fetched = await call('GET', `/invoices/${created.json.id}`, { token })
  assert.equal(fetched.json.amount, 250)
  const list = await call('GET', '/invoices', { token })
  assert.equal(list.json.length, 1)
})

test('profile update and admin listing', async (t) => {
  const { server, call } = await start()
  t.after(() => server.close())
  await call('POST', '/auth/register', { body: { email: 'caio@example.test', password: 'correct-horse-2', name: 'Caio' } })
  const { json: { token } } = await call('POST', '/auth/login', { body: { email: 'caio@example.test', password: 'correct-horse-2' } })
  const patched = await call('PATCH', '/users/me', { token, body: { name: 'Caio Lima' } })
  assert.equal(patched.json.name, 'Caio Lima')
  assert.equal((await call('GET', '/admin/invoices', { token })).status, 403)
  assert.equal((await call('GET', '/invoices')).status, 401)
})
