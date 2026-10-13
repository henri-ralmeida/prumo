import { createConnection } from 'node:net'

export function dashboardPortClosed(port, connect = createConnection) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(2000)
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('error', error => {
      // Uma conexao interrompida durante a parada ainda nao comprova que a porta foi liberada.
      if (error.code === 'ECONNREFUSED') resolve(true)
      else if (error.code === 'ECONNRESET') resolve(false)
      else reject(error)
    })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('isolated dashboard port did not respond')) })
  })
}
