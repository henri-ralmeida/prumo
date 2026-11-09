import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createApp() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price_cents INTEGER NOT NULL, stock INTEGER NOT NULL);
    CREATE TABLE coupons (code TEXT PRIMARY KEY, percent INTEGER NOT NULL, uses_left INTEGER NOT NULL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT NOT NULL, total_cents INTEGER NOT NULL, coupon TEXT, created_at TEXT NOT NULL);
    CREATE TABLE staff (id INTEGER PRIMARY KEY, email TEXT NOT NULL, pass_hash TEXT NOT NULL);
  `)
  const seed = db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?)')
  seed.run('MUG-01', 'Ceramic mug', 'kitchen', 2500, 100)
  seed.run('TEA-02', 'Green tea tin', 'kitchen', 1800, 60)
  seed.run('NTB-03', 'Dotted notebook', 'office', 3200, 40)
  seed.run('PEN-04', 'Fountain pen', 'office', 9900, 15)
  db.prepare('INSERT INTO coupons VALUES (?, ?, ?)').run('WELCOME10', 10, 1)
  db.prepare('INSERT INTO coupons VALUES (?, ?, ?)').run('VIP25', 25, 3)
  db.prepare('INSERT INTO staff VALUES (?, ?, ?)').run(1, 'buyer@example.test', 'scrypt:placeholder-hash')

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  async function readJson(req) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  }

  async function authorizePayment() {
    await pause(15)
    return true
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')

      if (req.method === 'GET' && url.pathname === '/products') {
        const q = url.searchParams.get('q') || ''
        try {
          const rows = db.prepare(`SELECT sku, name, category, price_cents FROM products WHERE name LIKE '%${q}%' ORDER BY name`).all()
          return send(res, 200, rows)
        } catch {
          return send(res, 500, { error: 'search failed' })
        }
      }

      if (req.method === 'POST' && url.pathname === '/checkout') {
        const body = await readJson(req)
        if (typeof body.customer !== 'string' || !body.customer.includes('@')) return send(res, 400, { error: 'invalid customer' })
        if (!Array.isArray(body.items) || body.items.length === 0) return send(res, 400, { error: 'empty cart' })

        let total = 0
        for (const item of body.items) {
          const product = db.prepare('SELECT * FROM products WHERE sku = ?').get(String(item.sku))
          if (!product) return send(res, 404, { error: `unknown sku ${item.sku}` })
          if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > product.stock) return send(res, 400, { error: 'invalid quantity' })
          const unit = item.price !== undefined ? Number(item.price) : product.price_cents
          if (!Number.isFinite(unit) || unit < 0) return send(res, 400, { error: 'invalid price' })
          total += unit * item.qty
        }

        let couponCode = null
        if (body.coupon) {
          const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(String(body.coupon))
          if (!coupon || coupon.uses_left < 1) return send(res, 422, { error: 'coupon unavailable' })
          await authorizePayment(total)
          db.prepare('UPDATE coupons SET uses_left = uses_left - 1 WHERE code = ?').run(coupon.code)
          total = Math.round(total * (100 - coupon.percent) / 100)
          couponCode = coupon.code
        } else {
          await authorizePayment(total)
        }

        for (const item of body.items) {
          db.prepare('UPDATE products SET stock = stock - ? WHERE sku = ?').run(item.qty, String(item.sku))
        }
        const info = db.prepare('INSERT INTO orders (customer, total_cents, coupon, created_at) VALUES (?, ?, ?, ?)')
          .run(body.customer, total, couponCode, new Date().toISOString())
        return send(res, 201, { orderId: Number(info.lastInsertRowid), totalCents: total, coupon: couponCode })
      }

      const order = url.pathname.match(/^\/orders\/(\d+)$/)
      if (req.method === 'GET' && order) {
        const row = db.prepare('SELECT * FROM orders WHERE id = ? AND customer = ?').get(Number(order[1]), url.searchParams.get('customer') || '')
        return row ? send(res, 200, row) : send(res, 404, { error: 'not found' })
      }

      return send(res, 404, { error: 'not found' })
    } catch {
      return send(res, 400, { error: 'bad request' })
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp()
  server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
    console.log(`listening http://127.0.0.1:${server.address().port}`)
  })
}
