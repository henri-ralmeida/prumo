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
