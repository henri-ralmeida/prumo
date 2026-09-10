import { emitKeypressEvents, cursorTo, moveCursor, clearScreenDown } from 'node:readline'

export function selectHarnesses(harnesses, { input = process.stdin, output = process.stdout, t = value => value } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('Interactive selection needs a terminal; use --all or choose a harness flag')
  const selected = new Set(harnesses)
  let cursor = 0
  let lines = 0
  const raw = input.isRaw ?? false
  return new Promise((resolve, reject) => {
    const render = () => {
      if (lines) { moveCursor(output, 0, -lines); cursorTo(output, 0); clearScreenDown(output) }
      const rows = [t('Choose environments to install:'), ...harnesses.map((name, index) => `${index === cursor ? '>' : ' '} [${selected.has(name) ? 'x' : ' '}] ${name}`), t('Arrows: move | Space: select | A: all/none | Enter: install | Esc: cancel')]
      output.write(rows.join('\n') + '\n')
      lines = rows.reduce((count, row) => count + Math.max(1, Math.ceil(row.length / (output.columns || 80))), 0)
    }
    const finish = (error, value) => {
      input.removeListener('keypress', keypress)
      input.removeListener('end', ended)
      input.setRawMode(raw)
      input.pause()
      error ? reject(error) : resolve(value)
    }
    const ended = () => finish(new Error('Installation selection cancelled'))
    const keypress = (text, key = {}) => {
      if (key.name === 'escape' || key.ctrl && ['c', 'd'].includes(key.name)) return ended()
      if (key.name === 'up') cursor = (cursor + harnesses.length - 1) % harnesses.length
      else if (key.name === 'down') cursor = (cursor + 1) % harnesses.length
      else if (key.name === 'space' || text === ' ') {
        const name = harnesses[cursor]
        selected.has(name) ? selected.delete(name) : selected.add(name)
      } else if (text?.toLowerCase() === 'a') {
        if (selected.size === harnesses.length) selected.clear()
        else for (const name of harnesses) selected.add(name)
      } else if (key.name === 'return') {
        if (selected.size) return finish(null, harnesses.filter(name => selected.has(name)))
      } else return
      render()
    }
    emitKeypressEvents(input)
    input.setRawMode(true)
    input.on('keypress', keypress)
    input.once('end', ended)
    input.resume()
    render()
  })
}
