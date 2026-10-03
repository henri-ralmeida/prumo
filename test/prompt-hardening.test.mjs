import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { selectHarnesses } from '../lib/prompt.mjs'
import { isReadyForReview } from '../scripts/review-readiness.mjs'

function terminal() {
  const input = new PassThrough(), output = new PassThrough()
  input.isTTY = output.isTTY = true
  input.setRawMode = value => { input.isRaw = value }
  let text = ''
  output.on('data', chunk => { text += chunk })
  return { input, output, text: () => text }
}

test('selecao restaura modo raw ausente e alterna todos apos escolha parcial', async () => {
  const io = terminal(), names = ['claude', 'kiro', 'codex', 'dsh']
  const result = selectHarnesses(names, io)
  const before = io.text()
  io.input.emit('keypress', 'z')
  assert.equal(io.text(), before, 'uma tecla desconhecida nao altera nem redesenha a selecao')
  io.input.write('\u001b[A A\r')
  assert.deepEqual(await result, names, 'marcar todos recupera tambem o ultimo ambiente desmarcado')
  assert.equal(io.input.isRaw, false)
  assert.equal(io.input.listenerCount('keypress'), 0)
  assert.equal(io.input.listenerCount('end'), 0)
})

test('Esc e fim da entrada cancelam sem deixar terminal raw nem listeners', async () => {
  for (const end of [input => input.emit('keypress', undefined, { name: 'escape' }), input => input.emit('end')]) {
    const io = terminal()
    io.input.isRaw = true
    const result = selectHarnesses(['claude'], io)
    end(io.input)
    await assert.rejects(result, /cancelled/)
    assert.equal(io.input.isRaw, true, 'restaure a configuracao anterior do terminal')
    assert.equal(io.input.listenerCount('keypress'), 0)
    assert.equal(io.input.listenerCount('end'), 0)
  }
})

test('atividade de revisao ja iniciada nao retorna a fila pronta para revisar', () => {
  const task = { state: 'running', attempts: [{ activityTiming: 'explicit', reviewStartedAt: '2026-01-01T10:00:00Z',
    activityIntervals: [{ role: 'execution', startedAt: '2026-01-01T09:00:00Z', endedAt: '2026-01-01T09:10:00Z' }] }] }
  const before = structuredClone(task)
  assert.equal(isReadyForReview(task), false)
  assert.deepEqual(task, before)
})
