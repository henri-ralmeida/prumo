import http from 'node:http'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'

// Uma falha de inicialização deve ser diagnosticada sem ocupar uma porta real.
http.createServer = () => {
  const server = new EventEmitter()
  server.listen = () => {
    queueMicrotask(() => server.emit('error', Object.assign(new Error('falha de inicialização simulada'), { code: 'EIO' })))
    return server
  }
  return server
}
syncBuiltinESMExports()
