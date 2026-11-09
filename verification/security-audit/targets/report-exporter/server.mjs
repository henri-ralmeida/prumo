import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const settings = JSON.parse(fs.readFileSync(path.join(root, 'config', 'settings.json'), 'utf8'))

export function createApp({ exportsDir = path.join(root, 'exports') } = {}) {
  fs.mkdirSync(exportsDir, { recursive: true })

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type })
    res.end(type === 'application/json' ? JSON.stringify(body) : body)
  }

  async function readJson(req) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  }

  function runConverter(reportId, filename) {
    const command = `node "${path.join(root, 'bin', 'convert.mjs')}" ${reportId} ${filename}`
    return new Promise((resolve, reject) => {
      exec(command, { cwd: exportsDir, env: { ...process.env, EXPORTS_DIR: exportsDir, DATA_DIR: path.join(root, 'data') } }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout.trim())
      })
    })
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.headers['x-api-key'] !== settings.apiKey) return send(res, 401, { error: 'unauthorized' })

      if (req.method === 'GET' && url.pathname === '/reports') {
        const names = fs.readdirSync(path.join(root, 'data')).filter((n) => n.endsWith('.csv')).map((n) => n.replace(/\.csv$/, ''))
        return send(res, 200, names)
      }

      if (req.method === 'POST' && url.pathname === '/exports') {
        const { reportId, filename } = await readJson(req)
        if (typeof reportId !== 'string' || !/^[a-z0-9-]+$/.test(reportId)) return send(res, 400, { error: 'invalid report' })
        if (typeof filename !== 'string' || !filename.trim()) return send(res, 400, { error: 'invalid filename' })
        if (!fs.existsSync(path.join(root, 'data', `${reportId}.csv`))) return send(res, 404, { error: 'unknown report' })
        const rows = await runConverter(reportId, filename.trim())
        return send(res, 201, { filename: filename.trim(), rows: Number(rows) })
      }

      if (req.method === 'GET' && url.pathname.startsWith('/downloads/')) {
        const name = decodeURIComponent(url.pathname.slice('/downloads/'.length))
        const file = path.join(exportsDir, name)
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' })
        return send(res, 200, fs.readFileSync(file), 'application/octet-stream')
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
