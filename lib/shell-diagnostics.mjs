import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs'

/** A named plugin alone is not evidence that it blocked a command. */
export function diagnoseShellFilter({ config, evidence } = {}) {
  const read = path => {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) throw new Error('Shell diagnostic input must be a regular file')
      if (stat.size > 65536) throw new Error('Shell diagnostic input exceeds 64 KiB')
      const data = Buffer.alloc(65537)
      let size = 0, count
      while (size < data.length && (count = readSync(fd, data, size, data.length - size, null))) size += count
      if (size > 65536) throw new Error('Shell diagnostic input exceeds 64 KiB')
      try { return JSON.parse(data.subarray(0, size).toString('utf8')) }
      catch { throw new Error('Shell diagnostic input is not valid JSON') }
    } finally { closeSync(fd) }
  }
  const relevant = command => {
    const tokens = (command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(token => token.replace(/^["']|["']$/g, ''))
    if (tokens[0] === '&') tokens.shift()
    const program = tokens.shift()?.split(/[\\/]/).at(-1)
    return /^(?:prumo|prumo\.mjs)(?:\.cmd|\.exe)?$/.test(program ?? '') || /^(?:node|bun)(?:\.exe)?$/.test(program ?? '') && /^(?:engine|prumo)\.mjs$/.test(tokens[0]?.split(/[\\/]/).at(-1) ?? '') || /^(?:npx|bunx)(?:\.cmd|\.exe)?$/.test(program ?? '') && tokens[0] === 'prumo'
  }
  if (evidence) {
    const value = read(evidence)
    if (value?.plugin === 'lean-ctx' && value.decision === 'blocked' && typeof value.command === 'string' && relevant(value.command)) return 'Recorded lean-ctx block: adjust the allowed command list for the approved Prumo command; do not bypass the shell filter.'
  }
  if (config) {
    const value = read(config)
    const allowed = value?.plugins?.['lean-ctx']?.allowedCommands
    if (Array.isArray(allowed) && allowed.every(item => typeof item === 'string')) return 'Accessible lean-ctx allowed command configuration found. Compare the approved Prumo command with that list; a runtime block has not been established.'
  }
  return 'No accessible lean-ctx configuration or relevant block evidence; no shell filter detection claimed.'
}
