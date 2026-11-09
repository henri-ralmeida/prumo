import http from 'node:http'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const MAX_BODY = 64 * 1024
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 5
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex')

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 32).toString('hex')}`
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':')
  const expected = Buffer.from(hash, 'hex')
  return crypto.timingSafeEqual(crypto.scryptSync(password, Buffer.from(salt, 'hex'), expected.length), expected)
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'))

export function createApp() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
  `)
  const failures = new Map()

  const send = (res, status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'"
    })
    res.end(JSON.stringify(body))
  }

  async function readJson(req) {
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 })
      chunks.push(c)
    }
    if (!chunks.length) return {}
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error('bad body'), { status: 400 })
    return parsed
  }

  function validNote(body) {
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const text = typeof body.body === 'string' ? body.body : ''
    if (!title || title.length > 200 || text.length > 10000) return null
    return { title, text }
  }

  function throttled(key) {
    const entry = failures.get(key)
    if (!entry) return false
    if (Date.now() - entry.since > LOGIN_WINDOW_MS) {
      failures.delete(key)
      return false
    }
    return entry.count >= LOGIN_MAX_FAILURES
  }

  function noteFailure(key) {
    const entry = failures.get(key)
    if (!entry || Date.now() - entry.since > LOGIN_WINDOW_MS) failures.set(key, { count: 1, since: Date.now() })
    else entry.count++
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {}

      if (req.method === 'POST' && url.pathname === '/auth/register') {
        if (typeof body.email !== 'string' || !EMAIL.test(body.email) || typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) {
          return send(res, 400, { error: 'invalid input' })
        }
        try {
          db.prepare('INSERT INTO users (email, pass_hash) VALUES (?, ?)').run(body.email.toLowerCase(), hashPassword(body.password))
        } catch {
          return send(res, 409, { error: 'email already registered' })
        }
        return send(res, 201, { ok: true })
      }

      if (req.method === 'POST' && url.pathname === '/auth/login') {
        const email = typeof body.email === 'string' ? body.email.toLowerCase() : ''
        const key = `${email}|${req.socket.remoteAddress}`
        if (throttled(key)) return send(res, 429, { error: 'too many attempts' })
        const user = db.prepare('SELECT id, pass_hash FROM users WHERE email = ?').get(email)
        const ok = verifyPassword(String(body.password || ''), user ? user.pass_hash : DUMMY_HASH)
        if (!user || !ok) {
          noteFailure(key)
          return send(res, 401, { error: 'invalid credentials' })
        }
        failures.delete(key)
        const token = crypto.randomBytes(32).toString('base64url')
        db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, Date.now() + SESSION_TTL_MS)
        return send(res, 200, { token })
      }

      const header = req.headers.authorization || ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : ''
      const session = token ? db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) : undefined
      if (!session || session.expires_at < Date.now()) return send(res, 401, { error: 'unauthenticated' })
      const userId = session.user_id

      if (req.method === 'GET' && url.pathname === '/notes') {
        const q = (url.searchParams.get('q') || '').slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)
        const rows = db.prepare("SELECT id, title, updated_at FROM notes WHERE user_id = ? AND title LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 100").all(userId, `%${q}%`)
        return send(res, 200, rows)
      }

      if (req.method === 'POST' && url.pathname === '/notes') {
        const note = validNote(body)
        if (!note) return send(res, 400, { error: 'invalid note' })
        const info = db.prepare('INSERT INTO notes (user_id, title, body, updated_at) VALUES (?, ?, ?, ?)').run(userId, note.title, note.text, new Date().toISOString())
        return send(res, 201, { id: Number(info.lastInsertRowid) })
      }

      const match = url.pathname.match(/^\/notes\/(\d{1,12})$/)
      if (match) {
        const id = Number(match[1])
        const row = db.prepare('SELECT id, title, body, updated_at FROM notes WHERE id = ? AND user_id = ?').get(id, userId)
        if (!row) return send(res, 404, { error: 'not found' })
        if (req.method === 'GET') return send(res, 200, row)
        if (req.method === 'PUT') {
          const note = validNote(body)
          if (!note) return send(res, 400, { error: 'invalid note' })
          db.prepare('UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(note.title, note.text, new Date().toISOString(), id, userId)
          return send(res, 200, { id })
        }
        if (req.method === 'DELETE') {
          db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(id, userId)
          return send(res, 204, {})
        }
      }

      return send(res, 404, { error: 'not found' })
    } catch (error) {
      return send(res, error.status || 400, { error: 'bad request' })
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp()
  server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
    console.log(`listening http://127.0.0.1:${server.address().port}`)
  })
}
