import test from 'node:test'
import assert from 'node:assert/strict'
import { updateProgress } from '../lib/update-progress.mjs'

function fixture(options = {}) {
  let output = '', tick, cancelled = 0, unref = 0
  const stream = { isTTY: true, columns: 40, write(text) { output += text }, ...options }
  const progress = updateProgress({ stream, schedule(callback) { tick = callback; return { unref() { unref++ } } }, cancel() { cancelled++ } })
  return { stream, progress, output: () => output, tick: () => tick(), counts: () => ({ cancelled, unref }) }
}

test('trilha preserva etapas concluídas, anima a etapa atual e encerra o timer', () => {
  const f = fixture()
  f.progress.start('Atualizando CLI', 'CLI atualizado')
  f.tick()
  f.progress.finish()
  f.progress.start('Atualizando Codex', 'Codex atualizado')
  f.progress.suspend()
  f.progress.finish()
  f.progress.success('Prumo atualizado', '2.11.6')
  f.progress.clear()
  assert.match(f.output(), /✓ CLI atualizado\n/)
  assert.match(f.output(), /✓ Codex atualizado\n/)
  assert.match(f.output(), /✓ Prumo atualizado\nPrumo v2\.11\.6\n$/)
  assert.doesNotMatch(f.output(), /%|={3}/)
  assert.deepEqual(f.counts(), { cancelled: 2, unref: 2 })
})

test('falhas e substituições de etapa nunca são apresentadas como sucesso', () => {
  const f = fixture()
  f.progress.start('CLI')
  f.progress.start('Codex')
  f.progress.clear()
  f.progress.suspend()
  assert.match(f.output(), /! CLI\n/)
  assert.match(f.output(), /! Codex\n$/)
  assert.doesNotMatch(f.output(), /✓/)
})

test('trilha respeita a largura atual, caracteres Unicode e rótulos com quebras', () => {
  const f = fixture()
  f.progress.start('Atualizando configuração muito longa com acentuação e detalhes\n\x1b')
  f.stream.columns = 12
  f.tick()
  f.progress.finish()
  const lines = f.output().split('\r\x1b[2K').filter(Boolean)
  assert.equal(Array.from(lines[0]).length, 39)
  assert.equal(Array.from(lines[1]).length, 11)
  assert.equal(Array.from(lines[2].trimEnd()).length, 11)
  assert.ok(lines.every(line => !line.includes('\x1b')))
  f.stream.columns = 1
  f.progress.start('teste')
  f.progress.finish(false)
  assert.match(f.output(), /…\n$/)
})

test('saída redirecionada usa linhas estáticas sem controle de cursor nem animação', () => {
  const f = fixture({ isTTY: false, columns: undefined })
  f.progress.start('Atualizando CLI', 'CLI atualizado')
  f.progress.suspend()
  f.progress.success('Concluído', '2.11.6')
  assert.equal(f.output(), '· Atualizando CLI\n✓ CLI atualizado\n✓ Concluído\nPrumo v2.11.6\n')
  assert.deepEqual(f.counts(), { cancelled: 0, unref: 0 })
})

test('prévia não inicia a trilha e o construtor aceita as opções padrão', () => {
  updateProgress().clear()
  let output = ''
  const progress = updateProgress({ enabled: false, stream: { write(text) { output += text } } })
  progress.start('Não executar')
  progress.clear()
  assert.equal(output, '')
})
