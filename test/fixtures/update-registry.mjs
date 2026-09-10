import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

const pkg = JSON.parse(readFileSync(process.env.PRUMO_TEST_PACKAGE, 'utf8'))
const archive = readFileSync(process.env.PRUMO_TEST_ARCHIVE)
const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
let metadataRequests = 0
const server = createServer((req, res) => {
  if (existsSync(process.env.PRUMO_TEST_FAILURE)) { res.writeHead(503); res.end('Registry unavailable'); return }
  if (req.url === '/package.tgz') { res.end(archive); return }
  if (decodeURIComponent(req.url.split('?')[0]) !== `/${pkg.name}`) { res.writeHead(404); res.end('{}'); return }
  writeFileSync(process.env.PRUMO_TEST_REQUESTS, String(++metadataRequests))
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ name: pkg.name, 'dist-tags': { latest: pkg.version }, versions: { [pkg.version]: { ...pkg, dist: { tarball: `http://127.0.0.1:${server.address().port}/package.tgz`, integrity } } } }))
})
server.listen(0, '127.0.0.1', () => process.send({ url: `http://127.0.0.1:${server.address().port}` }))
process.on('disconnect', () => server.close())
