import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { selectHarnesses } from '../lib/prompt.mjs'

function terminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  input.isTTY = output.isTTY = true
  input.isRaw = false
  input.setRawMode = value => { input.isRaw = value }
  output.columns = 80
  let text = ''
  output.on('data', chunk => { text += chunk })
  return { input, output, text: () => text }
}

test('checkbox menu supports all, a subset and one harness, restoring terminal state', async () => {
  const names = ['claude', 'kiro', 'codex']
  for (const [keys, expected] of [['\r', names], ['\u001b[B \r', ['claude', 'codex']], ['a\r\u001b[B \r', ['kiro']]]) {
    const io = terminal()
    const result = selectHarnesses(names, io)
    assert.equal(io.input.isRaw, true)
    io.input.write(keys)
    assert.deepEqual(await result, expected)
    assert.equal(io.input.isRaw, false)
    assert.equal(io.input.listenerCount('keypress'), 0)
    assert.match(io.text(), /\[x\] claude/)
  }
})

test('checkbox cancellation and noninteractive input never select an installation', async () => {
  const io = terminal()
  const result = selectHarnesses(['claude'], io)
  io.input.write('\u0003')
  await assert.rejects(result, /cancelled/)
  assert.equal(io.input.isRaw, false)
  assert.throws(() => selectHarnesses(['claude'], { input: new PassThrough(), output: new PassThrough() }), /needs a terminal/)
})
