import { lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs'
import { resolve, posix } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const canonicalRoot = realpathSync.native

export function safeRepositoryPath(path) {
  if (typeof path !== 'string' || !path || /[\x00-\x1f]/.test(path) || /^(?:[/\\]|[A-Za-z]:)/.test(path) || path.replaceAll('\\', '/').split('/').some(part => part === '..' || part === ''))
    throw new Error('Evidence paths must be safe repository-relative paths')
  return posix.normalize(path.replaceAll('\\', '/'))
}

// Only Git inventory may contain a terminal directory separator. Contract paths
// remain strict, and a directory must prove its own Git root before capture.
export function gitInventoryPath(value) {
  return safeRepositoryPath(value.endsWith('/') ? value.slice(0, -1) : value)
}

export function evidenceLocation(root, path) {
  root = canonicalRoot(root)
  path = safeRepositoryPath(path)
  let current = root
  for (const part of path.split('/')) {
    current = resolve(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Evidence link refused: ${path}`)
  }
  return current
}

export function scopeFileDigest(root, path, mode) {
  const absolute = evidenceLocation(root, path), expected = lstatSync(absolute, { bigint: true })
  if (!expected.isFile()) throw new Error(`Evidence is not a regular file: ${path}`)
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd, { bigint: true }), digest = createHash('sha256'), chunk = Buffer.alloc(64 * 1024)
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) throw new Error(`Evidence path changed: ${path}`)
    let bytes = 0, count
    do {
      count = readSync(fd, chunk, 0, chunk.length, bytes)
      bytes += count
      if (BigInt(bytes) > before.size) throw new Error(`Evidence changed during capture: ${path}`)
      digest.update(chunk.subarray(0, count))
    } while (count)
    const after = fstatSync(fd, { bigint: true }), location = lstatSync(evidenceLocation(root, path), { bigint: true })
    if (after.size !== before.size || BigInt(bytes) !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        after.dev !== before.dev || after.ino !== before.ino || location.dev !== before.dev || location.ino !== before.ino)
      throw new Error(`Evidence changed during capture: ${path}`)
    return digest.update(String(mode)).digest('hex')
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Evidence changed during capture: ${path}`)
    throw error
  } finally { closeSync(fd) }
}

export function gitDirectoryEvidence(root, path, budget = { bytes: 0, files: 0 }) {
  const directory = evidenceLocation(root, path)
  const git = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000, windowsHide: true })
    if (result.status !== 0) throw new Error(`Git submodule or nested repository evidence unavailable: ${path}`)
    return result.stdout
  }
  // Windows Git and Node may spell one directory differently (case or 8.3
  // aliases). Exact filesystem identities prove ownership without trusting text.
  const reportedRoot = lstatSync(realpathSync(git('rev-parse', '--show-toplevel').trim()), { bigint: true })
  const expectedRoot = lstatSync(directory, { bigint: true })
  if (!reportedRoot.isDirectory() || reportedRoot.dev !== expectedRoot.dev || reportedRoot.ino !== expectedRoot.ino)
    throw new Error(`Git submodule or nested repository must have its own root: ${path}`)
  evidenceLocation(directory, '.git')
  const head = git('rev-parse', '--revs-only', 'HEAD').trim() || null
  // Disable external diff and text conversion: collecting evidence must not run
  // repository-configured helpers. The index and both diffs cover dirty tracked bytes.
  const index = git('ls-files', '--stage', '-z')
  for (const entry of index.split('\0').filter(Boolean)) {
    const tracked = safeRepositoryPath(entry.slice(entry.indexOf('\t') + 1))
    if (entry.startsWith('160000 ')) throw new Error(`Nested Git links need separate evidence coverage: ${path}/${tracked}`)
    try { evidenceLocation(directory, tracked) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const staged = git('diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv')
  const working = git('diff', '--binary', '--no-ext-diff', '--no-textconv')
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)
  if ((budget.files += untracked.length) > 256) throw new Error('Delivery file count exceeds reading limit')
  budget.bytes += Buffer.byteLength(index) + Buffer.byteLength(staged) + Buffer.byteLength(working)
  if (budget.bytes > 8 * 1024 * 1024) throw new Error(`Evidence reading limit: ${path}`)
  const files = untracked.map(entry => {
    const relative = safeRepositoryPath(entry)
    const absolute = evidenceLocation(directory, relative)
    const expected = lstatSync(absolute, { bigint: true })
    if (!expected.isFile()) throw new Error(`Nested repository untracked evidence is not a regular file: ${path}/${relative}`)
    const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = fstatSync(descriptor, { bigint: true })
      if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino || realpathSync(absolute) !== absolute)
        throw new Error(`Evidence path changed: ${path}/${relative}`)
      const bytes = Buffer.alloc(1024 * 1024 + 1), digest = createHash('sha256')
      let count = 0, chunk
      do { chunk = readSync(descriptor, bytes, count, bytes.length - count, count); count += chunk } while (chunk && count < bytes.length)
      if (count > 1024 * 1024 || (budget.bytes += count) > 8 * 1024 * 1024)
        throw new Error(`Evidence reading limit: ${path}/${relative}`)
      digest.update(bytes.subarray(0, count))
      return { path: relative, digest: digest.digest('hex') }
    } finally { closeSync(descriptor) }
  })
  const digest = createHash('sha256').update(JSON.stringify({ head, index, staged, working, files })).digest('hex')
  return { path, head, digest, untrackedFiles: files.length,
    limitation: 'Nested repository index, tracked diffs and untracked file hashes were captured; source text and ignored files require independent inspection.' }
}
