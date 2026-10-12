import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitDirectoryEvidence, scopeFileDigest } from '../scripts/git-directory-evidence.mjs'
import { createHash } from 'node:crypto'

test('scope fingerprints stream file bytes without changing historical digests and refuse unstable identities', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'prumo-scope-file-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const path = join(root, 'payload'), data = Buffer.from('Observable payload')
  fs.writeFileSync(path, data)
  const mode = fs.statSync(path).mode
  const probe = () => scopeFileDigest(root, 'payload', mode)
  const original = { lstatSync: fs.lstatSync, fstatSync: fs.fstatSync, readSync: fs.readSync, closeSync: fs.closeSync }
  const restore = () => { Object.assign(fs, original); syncBuiltinESMExports() }
  t.after(restore)
  assert.equal(probe(), createHash('sha256').update(data).update(String(mode)).digest('hex'))
  try {
    fs.lstatSync = (...args) => { const stat = original.lstatSync(...args); stat.isFile = () => false; return stat }
    syncBuiltinESMExports(); assert.throws(probe, /not a regular file/); restore()
    for (const field of ['dev', 'ino', 'isFile']) {
      fs.fstatSync = (...args) => { const stat = original.fstatSync(...args); if (field === 'isFile') stat.isFile = () => false; else stat[field]++; return stat }
      syncBuiltinESMExports(); assert.throws(probe, /path changed/); restore()
    }
    for (const field of ['size', 'mtimeNs', 'ctimeNs', 'dev', 'ino']) {
      let calls = 0
      fs.fstatSync = (...args) => { const stat = original.fstatSync(...args); if (++calls === 2) stat[field]++; return stat }
      syncBuiltinESMExports(); assert.throws(probe, /changed during capture/); restore()
    }
    for (const field of ['dev', 'ino']) {
      let calls = 0
      fs.lstatSync = (value, options) => { const stat = original.lstatSync(value, options); if (options?.bigint && ++calls === 2) stat[field]++; return stat }
      syncBuiltinESMExports(); assert.throws(probe, /changed during capture/); restore()
    }
    fs.readSync = (fd, chunk) => { chunk.fill(0); return chunk.length }
    syncBuiltinESMExports(); assert.throws(probe, /changed during capture/); restore()
    fs.readSync = () => 0
    syncBuiltinESMExports(); assert.throws(probe, /changed during capture/); restore()
    fs.readSync = () => { throw new Error('Read denied') }
    syncBuiltinESMExports(); assert.throws(probe, /Read denied/); restore()
    fs.readSync = () => { throw Object.assign(new Error('Gone'), { code: 'ENOENT' }) }
    syncBuiltinESMExports(); assert.throws(probe, /changed during capture/)
    restore()
    fs.closeSync = fd => { original.closeSync(fd); throw new Error('Close denied') }
    syncBuiltinESMExports(); assert.throws(probe, /Close denied/)
  } finally { restore() }
})

test('Windows short-name and case aliases identify the same nested repository without accepting a parent root', t => {
  if (process.platform !== 'win32') return t.skip('Windows directory aliases')
  const root = fs.mkdtempSync(join(tmpdir(), 'prumo-nested-directory-alias-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const nested = join(root, 'nested')
  fs.mkdirSync(nested)
  assert.equal(childProcess.spawnSync('git', ['init', nested], { encoding: 'utf8' }).status, 0)
  const short = childProcess.spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `for %I in ("${root}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
  assert.equal(short.status, 0, short.stderr)
  const alias = short.stdout.trim().toLowerCase()
  assert.ok(alias)
  const before = gitDirectoryEvidence(root, 'nested')
  assert.deepEqual(gitDirectoryEvidence(alias, 'nested'), before)
  fs.writeFileSync(join(nested, 'payload.txt'), 'Observable source')
  assert.deepEqual(gitDirectoryEvidence(alias, 'nested'), gitDirectoryEvidence(root, 'nested'))
  fs.mkdirSync(join(nested, 'ordinary'))
  assert.throws(() => gitDirectoryEvidence(alias, 'nested/ordinary'), /own root/)
})

test('nested evidence refuses forged inventory, replaced handles and unsafe tracked paths while accepting partial reads', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'prumo-nested-hardening-')))
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
    forged(args => args.includes('--show-toplevel'), payload + '\n')
    assert.throws(probe, /own root/); restore()
    let roots = 0
    fs.lstatSync = (path, options) => {
      const stat = original.lstatSync(path, options)
      if (path === repository && options?.bigint && ++roots === 1) stat.dev++
      return stat
    }; syncBuiltinESMExports()
    assert.throws(probe, /own root/); restore()
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
