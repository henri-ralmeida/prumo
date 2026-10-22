// Cada etapa mantém seu resultado visível; uma etapa interrompida nunca recebe marca de sucesso.
export function updateProgress({ enabled = true, stream = process.stdout, color = (_code, text) => text,
  schedule = setInterval, cancel = clearInterval } = {}) {
  let active = null
  let timer = null
  let frame = 0
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  const line = (symbol, label, code) => {
    const width = Math.max(1, (stream.columns || 80) - 1)
    const text = `${symbol} ${label}`.replace(/[\r\n\x1b]/g, ' ')
    const letters = Array.from(text)
    const clipped = letters.length > width ? letters.slice(0, width - 1).join('') + '…' : text
    return color(code, clipped, stream)
  }
  const erase = () => stream.write('\r\x1b[2K')
  const paint = () => { erase(); stream.write(line(frames[frame++ % frames.length], active.label, '33')) }
  const stop = () => { if (timer !== null) { cancel(timer); timer = null } }
  const finish = (ok = true) => {
    if (!active) return
    stop()
    if (stream.isTTY) erase()
    stream.write(line(ok ? '✓' : '!', ok ? active.done : active.label, ok ? '32' : '31') + '\n')
    active = null
  }
  return {
    start(label, done = label) {
      if (!enabled) return
      finish(false)
      active = { label, done }
      if (stream.isTTY) {
        paint()
        timer = schedule(paint, 100)
        timer.unref()
      } else stream.write(line('·', label, '33') + '\n')
    },
    finish,
    suspend() { stop(); if (active && stream.isTTY) erase() },
    clear() { finish(false) },
    success(message, version) {
      finish()
      stream.write(`${color('32', `✓ ${message}`, stream)}\nPrumo v${version}\n`)
    },
  }
}
