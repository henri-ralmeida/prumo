// Aspas equivalentes nao mudam a identidade do dashboard. Compare os argumentos
// interpretados pelo Windows e recuse uma linha truncada antes de encerrar o processo.
export function parseWindowsCommandLine(line) {
  if (typeof line !== 'string' || line.includes('\0')) return null
  const args = []
  let index = 0
  while (index < line.length) {
    while (/[ \t]/.test(line[index] ?? '')) index++
    if (index === line.length) break
    let value = '', quoted = false
    while (index < line.length && (quoted || !/[ \t]/.test(line[index]))) {
      let slashes = 0
      while (line[index] === '\\') { slashes++; index++ }
      if (line[index] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2))
        if (slashes % 2) { value += '"'; index++ }
        else if (quoted && line[index + 1] === '"') { value += '"'; index += 2 }
        else { quoted = !quoted; index++ }
      } else {
        value += '\\'.repeat(slashes)
        if (index < line.length && (quoted || !/[ \t]/.test(line[index]))) value += line[index++]
      }
    }
    if (quoted) return null
    args.push(value)
  }
  return args
}
