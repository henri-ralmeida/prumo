import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAtomicState } from '../scripts/atomic-state.mjs'

for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOSPC']) {
  test(`atomic state handles ${code} without losing the old state`, (t) => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'prumo-atomic-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'state.json')
    fs.writeFileSync(file, 'old')
    const rename = fs.renameSync
    let calls = 0
    const mock = t.mock.method(fs, 'renameSync', (...args) => {
      calls++
      if (calls <= 2 || code === 'ENOSPC') throw Object.assign(new Error(code), { code })
      return rename(...args)
    })
    if (code === 'ENOSPC') {
      assert.throws(() => writeAtomicState(file, 'new'), /ENOSPC/)
      assert.equal(calls, 1)
      assert.equal(fs.readFileSync(file, 'utf8'), 'old')
    } else {
      writeAtomicState(file, 'new')
      assert.equal(calls, 3)
      assert.equal(fs.readFileSync(file, 'utf8'), 'new')
    }
    mock.mock.restore()
    assert.deepEqual(fs.readdirSync(dir), ['state.json'])
  })
}
test('persistent lock exhausts bounded retries and preserves state', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'prumo-atomic-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'state.json')
  fs.writeFileSync(file, 'old')
  let calls = 0
  t.mock.method(fs, 'renameSync', () => { calls++; throw Object.assign(new Error('locked'), { code: 'EPERM' }) })
  assert.throws(() => writeAtomicState(file, 'new'), /locked/)
  assert.equal(calls, 5)
  assert.equal(fs.readFileSync(file, 'utf8'), 'old')
  assert.deepEqual(fs.readdirSync(dir), ['state.json'])
})

test('espaço insuficiente durante a escrita temporária preserva o arquivo e identifica a falha', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'prumo-atomic-')), file = join(dir, 'state.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, '{"old":true}')
  const write = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    if (String(path).endsWith('.tmp')) {
      write(path, '{"partial":')
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    }
    return write(path, ...args)
  })
  assert.throws(() => writeAtomicState(file, '{"new":true}', { validateJson: true }), error =>
    error.code === 'ENOSPC' && error.prumoAtomicFile === file)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}')
  assert.deepEqual(fs.readdirSync(dir), ['state.json'])
})

for (const partial of ['{"invalid":', '{}']) test('gravação JSON recusa conteúdo temporário diferente ou incompleto', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'prumo-atomic-')), file = join(dir, 'state.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, '{"old":true}')
  const write = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', (path, contents, ...args) =>
    write(path, String(path).endsWith('.tmp') ? partial : contents, ...args))
  assert.throws(() => writeAtomicState(file, '{"new":true}', { validateJson: true }))
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}')
  assert.deepEqual(fs.readdirSync(dir), ['state.json'])
})

test('falha ao remover arquivo temporário preserva o erro original e o estado anterior', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'prumo-atomic-')), file = join(dir, 'state.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, '{"old":true}')
  const remove = fs.rmSync
  const removal = t.mock.method(fs, 'rmSync', (path, ...args) => {
    if (String(path).endsWith('.tmp')) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
    return remove(path, ...args)
  })
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) })
  assert.throws(() => writeAtomicState(file, '{"new":true}', { validateJson: true }),
    error => error.code === 'ENOSPC' && error.prumoAtomicFile === file)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}')
  removal.mock.restore()
})
