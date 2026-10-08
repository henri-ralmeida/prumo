import net from 'node:net'
import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

// A instalação testada não deve abrir abas no navegador real de quem executa a suíte.
const execFile = childProcess.execFile
childProcess.execFile = (file, args, options, callback) => {
  if (!['rundll32.exe', 'open', 'xdg-open'].includes(file)) return execFile(file, args, options, callback)
  callback(new Error('navegador isolado indisponível'))
}
syncBuiltinESMExports()

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
