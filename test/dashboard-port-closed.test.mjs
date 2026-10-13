import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { dashboardPortClosed } from './fixtures/dashboard-port-closed.mjs'

function connection(event, code) {
  return () => {
    const socket = new EventEmitter()
    socket.setTimeout = () => {}
    socket.destroy = () => {}
    queueMicrotask(() => socket.emit(event, Object.assign(new Error(code), { code })))
    return socket
  }
}

test('a parada exige porta recusada; reset transitorio nao encerra nem aprova a verificacao', async () => {
  assert.equal(await dashboardPortClosed(4949, connection('error', 'ECONNRESET')), false)
  assert.equal(await dashboardPortClosed(4949, connection('error', 'ECONNREFUSED')), true)
  assert.equal(await dashboardPortClosed(4949, connection('connect')), false)
  await assert.rejects(dashboardPortClosed(4949, connection('error', 'EACCES')), { code: 'EACCES' })
  await assert.rejects(dashboardPortClosed(4949, connection('timeout')), /did not respond/)
})

test('uma porta real so fica liberada depois do servidor encerrar', async () => {
  const server = createServer(socket => socket.end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try { assert.equal(await dashboardPortClosed(port), false) }
  finally { await new Promise(resolve => server.close(resolve)) }
  assert.equal(await dashboardPortClosed(port), true)
})
