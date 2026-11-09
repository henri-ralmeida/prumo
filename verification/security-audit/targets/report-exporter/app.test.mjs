import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const apiKey = JSON.parse(fs.readFileSync(path.join(here, 'config', 'settings.json'), 'utf8')).apiKey

test('lists reports, exports one and downloads it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-exporter-'))
  const server = createApp({ exportsDir: dir })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-api-key': apiKey, 'content-type': 'application/json' }

  assert.equal((await fetch(`${base}/reports`)).status, 401)
  const list = await (await fetch(`${base}/reports`, { headers })).json()
  assert.deepEqual(list, ['q3-sales'])

  const created = await fetch(`${base}/exports`, { method: 'POST', headers, body: JSON.stringify({ reportId: 'q3-sales', filename: 'q3.csv' }) })
  assert.equal(created.status, 201)
  assert.equal((await created.json()).rows, 3)

  const file = await fetch(`${base}/downloads/q3.csv`, { headers })
  assert.equal(file.status, 200)
  assert.match(await file.text(), /^REGION,UNITS,REVENUE\n/)
  assert.equal((await fetch(`${base}/downloads/missing.csv`, { headers })).status, 404)

  const bad = await fetch(`${base}/exports`, { method: 'POST', headers, body: JSON.stringify({ reportId: '../x', filename: 'a.csv' }) })
  assert.equal(bad.status, 400)
})
