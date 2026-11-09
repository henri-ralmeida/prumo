import test from 'node:test'
import assert from 'node:assert/strict'

let createApp
try {
  ;({ createApp } = await import('./server.mjs'))
} catch {
  createApp = null
}

async function start() {
  const server = createApp()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, json: await res.json() }
  }
  return { server, call }
}

test('catalogue search filters by name', { skip: !createApp && 'node:sqlite unavailable' }, async (t) => {
  const { server, call } = await start()
  t.after(() => server.close())
  const all = await call('GET', '/products')
  assert.equal(all.json.length, 4)
  const mugs = await call('GET', '/products?q=mug')
  assert.deepEqual(mugs.json.map((p) => p.sku), ['MUG-01'])
})

test('checkout totals, coupon single use and order lookup', { skip: !createApp && 'node:sqlite unavailable' }, async (t) => {
  const { server, call } = await start()
  t.after(() => server.close())
  const first = await call('POST', '/checkout', { customer: 'dana@example.test', items: [{ sku: 'MUG-01', qty: 2 }], coupon: 'WELCOME10' })
  assert.equal(first.status, 201)
  assert.equal(first.json.totalCents, 4500)
  const second = await call('POST', '/checkout', { customer: 'dana@example.test', items: [{ sku: 'MUG-01', qty: 1 }], coupon: 'WELCOME10' })
  assert.equal(second.status, 422)
  const plain = await call('POST', '/checkout', { customer: 'dana@example.test', items: [{ sku: 'TEA-02', qty: 1 }] })
  assert.equal(plain.json.totalCents, 1800)
  const order = await call('GET', `/orders/${plain.json.orderId}?customer=dana@example.test`)
  assert.equal(order.json.customer, 'dana@example.test')
  assert.equal((await call('POST', '/checkout', { customer: 'x', items: [] })).status, 400)
  assert.equal((await call('POST', '/checkout', { customer: 'dana@example.test', items: [{ sku: 'NOPE', qty: 1 }] })).status, 404)
})
