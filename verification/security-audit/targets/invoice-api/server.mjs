import http from 'node:http'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  const candidate = crypto.scryptSync(password, salt, 32)
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'))
}

export function createApp({ signingKey = crypto.randomBytes(32).toString('hex') } = {}) {
  const users = new Map()
  const invoices = new Map()
  let nextUser = 1
  let nextInvoice = 1000

  const sign = (data) => crypto.createHmac('sha256', signingKey).update(data).digest('base64url')

  function issueToken(user) {
    const head = b64({ alg: 'HS256', typ: 'JWT' })
    const body = b64({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })
    return `${head}.${body}.${sign(`${head}.${body}`)}`
  }

  function readToken(token) {
    const parts = String(token || '').split('.')
    if (parts.length < 2) return null
    try {
      const header = unb64(parts[0])
      const payload = unb64(parts[1])
      if (header.alg !== 'none' && sign(`${parts[0]}.${parts[1]}`) !== parts[2]) return null
      if (payload.exp < Math.floor(Date.now() / 1000)) return null
      return users.get(payload.sub) || null
    } catch {
      return null
    }
  }

  function addUser({ email, password, name, role = 'customer' }) {
    const user = { id: nextUser++, email, name, role, passwordHash: hashPassword(password) }
    users.set(user.id, user)
    return user
  }

  function addInvoice(ownerId, { amount, description }) {
    const invoice = { id: nextInvoice++, ownerId, amount, description, status: 'open', createdAt: new Date().toISOString() }
    invoices.set(invoice.id, invoice)
    return invoice
  }

  const publicUser = ({ passwordHash, ...rest }) => rest

  const ana = addUser({ email: 'ana@example.test', password: crypto.randomBytes(12).toString('hex'), name: 'Ana Souza' })
  addUser({ email: 'admin@example.test', password: crypto.randomBytes(12).toString('hex'), name: 'Ops Admin', role: 'admin' })
  addInvoice(ana.id, { amount: 1500, description: 'Annual plan' })

  async function readJson(req) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (!chunks.length) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const path = url.pathname
      let body = {}
      if (req.method === 'POST' || req.method === 'PATCH') body = await readJson(req)

      if (req.method === 'POST' && path === '/auth/register') {
        const { email, password, name } = body
        if (typeof email !== 'string' || !email.includes('@') || typeof password !== 'string' || password.length < 8) {
          return send(res, 400, { error: 'invalid input' })
        }
        if ([...users.values()].some((u) => u.email === email)) return send(res, 409, { error: 'email taken' })
        return send(res, 201, publicUser(addUser({ email, password, name: String(name || '') })))
      }

      if (req.method === 'POST' && path === '/auth/login') {
        const user = [...users.values()].find((u) => u.email === body.email)
        if (!user || !checkPassword(String(body.password || ''), user.passwordHash)) {
          return send(res, 401, { error: 'invalid credentials' })
        }
        return send(res, 200, { token: issueToken(user) })
      }

      const auth = (req.headers.authorization || '').replace(/^Bearer /, '')
      const me = readToken(auth)
      if (!me) return send(res, 401, { error: 'unauthenticated' })

      if (req.method === 'GET' && path === '/invoices') {
        return send(res, 200, [...invoices.values()].filter((i) => i.ownerId === me.id))
      }

      if (req.method === 'POST' && path === '/invoices') {
        if (!Number.isFinite(body.amount) || body.amount <= 0) return send(res, 400, { error: 'invalid amount' })
        return send(res, 201, addInvoice(me.id, { amount: body.amount, description: String(body.description || '') }))
      }

      const one = path.match(/^\/invoices\/(\d+)$/)
      if (req.method === 'GET' && one) {
        const invoice = invoices.get(Number(one[1]))
        if (!invoice) return send(res, 404, { error: 'not found' })
        return send(res, 200, invoice)
      }

      if (req.method === 'GET' && path === '/users/me') return send(res, 200, publicUser(me))

      if (req.method === 'PATCH' && path === '/users/me') {
        Object.assign(me, body)
        return send(res, 200, publicUser(me))
      }

      if (req.method === 'GET' && path === '/admin/invoices') {
        if (me.role !== 'admin') return send(res, 403, { error: 'forbidden' })
        return send(res, 200, [...invoices.values()])
      }

      return send(res, 404, { error: 'not found' })
    } catch {
      return send(res, 400, { error: 'bad request' })
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp()
  server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
    console.log(`listening http://127.0.0.1:${server.address().port}`)
  })
}
