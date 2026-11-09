import test from 'node:test'
import assert from 'node:assert/strict'

let createApp
try {
  ;({ createApp } = await import('./server.mjs'))
} catch {
  createApp = null
}
const skip = !createApp && 'node:sqlite unavailable'

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
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : null }
  }
  const signUp = async (email) => {
    await call('POST', '/auth/register', { body: { email, password: 'long-password-1' } })
    return (await call('POST', '/auth/login', { body: { email, password: 'long-password-1' } })).json.token
  }
  return { server, call, signUp }
}

test('notes are private to their owner', { skip }, async (t) => {
  const { server, call, signUp } = await start()
  t.after(() => server.close())
  const a = await signUp('a@example.test')
  const b = await signUp('b@example.test')
  const created = await call('POST', '/notes', { token: a, body: { title: 'Groceries', body: 'milk' } })
  assert.equal(created.status, 201)
  const id = created.json.id
  assert.equal((await call('GET', `/notes/${id}`, { token: a })).json.body, 'milk')
  assert.equal((await call('GET', `/notes/${id}`, { token: b })).status, 404)
  assert.equal((await call('PUT', `/notes/${id}`, { token: b, body: { title: 'x', body: 'y' } })).status, 404)
  assert.equal((await call('DELETE', `/notes/${id}`, { token: b })).status, 404)
  assert.equal((await call('GET', '/notes')).status, 401)
  assert.equal((await call('PUT', `/notes/${id}`, { token: a, body: { title: 'Groceries 2', body: 'eggs' } })).status, 200)
  assert.equal((await call('GET', '/notes?q=2', { token: a })).json.length, 1)
  assert.equal((await call('GET', "/notes?q=' OR 1=1 --", { token: a })).json.length, 0)
  assert.equal((await call('DELETE', `/notes/${id}`, { token: a })).status, 204)
})

test('input validation and login throttling', { skip }, async (t) => {
  const { server, call, signUp } = await start()
  t.after(() => server.close())
  const token = await signUp('c@example.test')
  assert.equal((await call('POST', '/notes', { token, body: { title: '', body: 'x' } })).status, 400)
  assert.equal((await call('POST', '/notes', { token, body: { title: 'x'.repeat(201), body: 'x' } })).status, 400)
  assert.equal((await call('POST', '/auth/register', { body: { email: 'bad', password: 'long-password-1' } })).status, 400)
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/auth/login', { body: { email: 'c@example.test', password: 'wrong-wrong-1' } })).status, 401)
  }
  assert.equal((await call('POST', '/auth/login', { body: { email: 'c@example.test', password: 'long-password-1' } })).status, 429)
})
