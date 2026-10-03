import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWindowsCommandLine } from '../lib/windows-argv.mjs'

test('Windows interpreta aspas parciais, espacos e argumentos vazios de forma equivalente', () => {
  for (const line of [
    '"C:\\Program Files\\node.exe" "C:\\prumo\\serve.mjs" --global --port 4949',
    '"C:\\Program Files\\node.exe" C:\\prumo\\serve.mjs "--global" "--port" "4949"',
    '\t"C:\\Program Files\\node.exe" C:\\prumo\\serve.mjs --g"lob"al\t--port 4949\t',
  ]) assert.deepEqual(parseWindowsCommandLine(line), ['C:\\Program Files\\node.exe', 'C:\\prumo\\serve.mjs', '--global', '--port', '4949'])
  assert.deepEqual(parseWindowsCommandLine('node "" "a b"'), ['node', '', 'a b'])
  assert.deepEqual(parseWindowsCommandLine(''), [])
  assert.deepEqual(parseWindowsCommandLine(' \t'), [])
})

test('Windows preserva barras e aspas escapadas sem inventar argumentos', () => {
  assert.deepEqual(parseWindowsCommandLine(String.raw`node "ab\"c" "\\" d`), ['node', 'ab"c', '\\', 'd'])
  assert.deepEqual(parseWindowsCommandLine(String.raw`node a\\\b d"e f"g h`), ['node', String.raw`a\\\b`, 'de fg', 'h'])
  assert.deepEqual(parseWindowsCommandLine(String.raw`node a"b"" c d"`), ['node', 'ab" c d'])
  assert.deepEqual(parseWindowsCommandLine('node path\\'), ['node', 'path\\'])
})

test('linha truncada, NUL ou tipo invalido nao comprova posse de processo', () => {
  for (const line of [undefined, null, {}, 'node "script', 'node script\0 --global']) assert.equal(parseWindowsCommandLine(line), null)
})
