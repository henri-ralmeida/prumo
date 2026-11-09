import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 32), Buffer.from(hash, 'hex'))
}

export function createApp({ logFile = process.env.LOG_FILE || path.join(root, 'logs', 'access.log') } = {}) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const accounts = new Map()
  const sessions = new Map()
  const hooks = []
  const deliveries = []

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  async function readJson(req) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  }

  function record(req) {
    const line = `${new Date().toISOString()} ${req.method} ${req.url} auth=${req.headers.authorization || '-'} ua=${req.headers['user-agent'] || '-'}\n`
    fs.appendFileSync(logFile, line)
  }

  async function deliver(hook, event) {
    const startedAt = Date.now()
    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(3000)
      })
      const text = await response.text()
      deliveries.push({ hookId: hook.id, eventId: event.id, status: response.status, responsePreview: text.slice(0, 200), ms: Date.now() - startedAt })
    } catch (error) {
      deliveries.push({ hookId: hook.id, eventId: event.id, status: 0, responsePreview: String(error.message).slice(0, 200), ms: Date.now() - startedAt })
    }
  }

  return http.createServer(async (req, res) => {
    try {
      record(req)
      const url = new URL(req.url, 'http://localhost')
      const body = req.method === 'POST' ? await readJson(req) : {}

      if (req.method === 'POST' && url.pathname === '/auth/register') {
        if (typeof body.email !== 'string' || typeof body.password !== 'string' || body.password.length < 8) return send(res, 400, { error: 'invalid input' })
        if (accounts.has(body.email)) return send(res, 409, { error: 'email taken' })
        accounts.set(body.email, { email: body.email, passwordHash: hashPassword(body.password) })
        return send(res, 201, { email: body.email })
      }

      if (req.method === 'POST' && url.pathname === '/auth/login') {
        const account = accounts.get(body.email)
        if (!account || !checkPassword(String(body.password || ''), account.passwordHash)) return send(res, 401, { error: 'invalid credentials' })
        const token = crypto.randomBytes(24).toString('hex')
        sessions.set(token, account.email)
        return send(res, 200, { token })
      }

      const owner = sessions.get((req.headers.authorization || '').replace(/^Bearer /, ''))
      if (!owner) return send(res, 401, { error: 'unauthenticated' })

      if (req.method === 'POST' && url.pathname === '/webhooks') {
        let target
        try { target = new URL(body.url) } catch { return send(res, 400, { error: 'invalid url' }) }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') return send(res, 400, { error: 'invalid url' })
        const hook = { id: hooks.length + 1, owner, url: target.href }
        hooks.push(hook)
        return send(res, 201, hook)
      }

      if (req.method === 'GET' && url.pathname === '/webhooks') {
        return send(res, 200, hooks.filter((h) => h.owner === owner))
      }

      if (req.method === 'POST' && url.pathname === '/events') {
        const event = { id: crypto.randomUUID(), type: String(body.type || 'generic'), payload: body.payload ?? null }
        const mine = hooks.filter((h) => h.owner === owner)
        await Promise.all(mine.map((h) => deliver(h, event)))
        return send(res, 202, { eventId: event.id, deliveries: mine.length })
      }

      if (req.method === 'GET' && url.pathname === '/deliveries') {
        const ids = new Set(hooks.filter((h) => h.owner === owner).map((h) => h.id))
        return send(res, 200, deliveries.filter((d) => ids.has(d.hookId)))
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
