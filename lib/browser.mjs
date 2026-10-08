import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'

export const BOARD_URL = 'http://localhost:4949'

export async function openDashboardBrowser({ platform = process.platform, run = execFile } = {}) {
  // O navegador padrão recebe somente o endereço local fixo, sem executar um shell.
  const command = platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', BOARD_URL]]
    : platform === 'darwin' ? ['open', [BOARD_URL]] : ['xdg-open', [BOARD_URL]]
  await new Promise((resolve, reject) => {
    // No Windows, um navegador persistente não deve manter a pasta de instalação ocupada.
    run(command[0], command[1], { cwd: tmpdir(), windowsHide: true, timeout: 10000 }, error => error ? reject(error) : resolve())
  })
}
