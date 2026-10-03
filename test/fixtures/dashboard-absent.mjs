import net from 'node:net'
import { EventEmitter } from 'node:events'

// Testes de instalação sem dashboard devem observar ausência sem consultar a porta do usuário.
const fetchOriginal = globalThis.fetch
globalThis.fetch = async (url, ...args) => String(url).includes('127.0.0.1:4949')
  ? Promise.reject(new Error('dashboard isolado ausente')) : fetchOriginal(url, ...args)
const connect = net.createConnection
net.createConnection = (options, ...args) => {
  if (options?.host !== '127.0.0.1' || options?.port !== 4949) return connect(options, ...args)
  const socket = new EventEmitter()
  socket.unref = socket.destroy = socket.setTimeout = () => socket
  queueMicrotask(() => socket.emit('error', Object.assign(new Error('dashboard isolado ausente'), { code: 'ECONNREFUSED' })))
  return socket
}
