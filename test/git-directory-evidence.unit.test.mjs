import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitDirectoryEvidence } from '../scripts/git-directory-evidence.mjs'

test('nested evidence refuses forged inventory, replaced handles and unsafe tracked paths while accepting partial reads', t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'prumo-nested-hardening-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const repository = join(root, 'nested'), payload = join(repository, 'payload.txt')
  fs.mkdirSync(repository)
  assert.equal(childProcess.spawnSync('git', ['init', repository], { encoding: 'utf8' }).status, 0)
  fs.writeFileSync(payload, 'Observable untracked content')
  fs.mkdirSync(join(repository, 'ordinary'))
  const original = { spawnSync: childProcess.spawnSync, fstatSync: fs.fstatSync, realpathSync: fs.realpathSync, readSync: fs.readSync, lstatSync: fs.lstatSync }
  const restore = () => { childProcess.spawnSync = original.spawnSync; Object.assign(fs, Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'spawnSync'))); syncBuiltinESMExports() }
  const probe = () => gitDirectoryEvidence(root, 'nested')
  const forged = (match, stdout) => {
    childProcess.spawnSync = (cmd, args, options) => match(args) ? { status: 0, stdout } : original.spawnSync(cmd, args, options)
    syncBuiltinESMExports()
  }
  try {
    const baseline = probe().digest
    forged(args => args.includes('--stage'), '160000 abc 0\tchild\0')
    assert.throws(probe, /separate evidence coverage/); restore()
    forged(args => args.includes('--stage'), '100644 abc 0\t..\/outside\0')
    assert.throws(probe, /safe repository-relative/); restore()
    forged(args => args.includes('--others'), 'ordinary\0')
    assert.throws(probe, /not a regular file/); restore()
    forged(args => args.includes('--others'), 'ordinary/\0')
    assert.throws(probe, /safe repository-relative/); restore()
    childProcess.spawnSync = () => ({ status: 1, stdout: '' }); syncBuiltinESMExports()
    assert.throws(probe, /evidence unavailable/); restore()
    for (const dimension of ['ino', 'dev']) {
      fs.fstatSync = (...args) => { const stat = original.fstatSync(...args); stat[dimension]++; return stat }; syncBuiltinESMExports()
      assert.throws(probe, /path changed/); restore()
    }
    fs.fstatSync = (...args) => { const stat = original.fstatSync(...args); stat.isFile = () => false; return stat }; syncBuiltinESMExports()
    assert.throws(probe, /path changed/); restore()
    fs.realpathSync = path => path === payload ? join(repository, 'elsewhere') : original.realpathSync(path); syncBuiltinESMExports()
    assert.throws(probe, /path changed/); restore()
    fs.readSync = (fd, bytes, offset, length, position) => original.readSync(fd, bytes, offset, Math.min(length, 3), position); syncBuiltinESMExports()
    assert.equal(probe().digest, baseline); restore()
    forged(args => args.includes('--stage'), '100644 abc 0\tpayload.txt\0')
    fs.lstatSync = (path, options) => { if (path === payload) throw new Error('Tracked path denied'); return original.lstatSync(path, options) }; syncBuiltinESMExports()
    assert.throws(probe, /Tracked path denied/); restore()
    const size = fs.statSync(payload).size
    assert.throws(() => gitDirectoryEvidence(root, 'nested', { bytes: 8 * 1024 * 1024 - size + 1, files: 0 }), /reading limit/)
    forged(args => args.includes('--binary'), 'x'.repeat(8 * 1024 * 1024 + 1))
    assert.throws(probe, /reading limit/); restore()
  } finally { restore() }
})
