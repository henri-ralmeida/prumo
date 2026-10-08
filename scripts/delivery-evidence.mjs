import { constants, lstatSync, openSync, closeSync, fstatSync, realpathSync, readSync, readdirSync } from 'node:fs'
import { resolve, posix } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { insideTouches } from './task-scope.mjs'

const MAX_FILE = 1024 * 1024, MAX_TOTAL = 8 * MAX_FILE, MAX_FILES = 256
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function safeEvidencePath(path) {
  if (typeof path !== 'string' || !path || /[\x00-\x1f]/.test(path) || /^(?:[/\\]|[A-Za-z]:)/.test(path) || path.replaceAll('\\', '/').split('/').some(part => part === '..' || part === ''))
    throw new Error('Evidence paths must be safe repository-relative paths')
  return posix.normalize(path.replaceAll('\\', '/'))
}
export function assertEvidenceContract(task) {
  if (task.deliveries !== undefined && !Array.isArray(task.deliveries)) throw new Error('deliveries must be an array')
  for (const path of task.deliveries ?? []) {
    safeEvidencePath(path)
    if (!insideTouches(path, task.touches ?? [])) throw new Error('Deliveries must be inside approved touches')
  }
  const rules = task.textRules
  if (rules !== undefined) {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).some(key => !['patterns', 'exceptions'].includes(key))) throw new Error('Invalid textRules')
    if (rules.patterns !== undefined && (!Array.isArray(rules.patterns) || rules.patterns.length > 64 || rules.patterns.some(value => typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f]/.test(value)))) throw new Error('textRules.patterns requires bounded literal strings')
    if (rules.exceptions !== undefined && (!Array.isArray(rules.exceptions) || rules.exceptions.length > 64)) throw new Error('Invalid textRules.exceptions')
    for (const item of rules.exceptions ?? []) {
      if (!item || Object.keys(item).some(key => !['path', 'line', 'identifier'].includes(key)) || typeof item.identifier !== 'string' || !item.identifier.trim() || item.identifier.length > 128 || !Number.isSafeInteger(item.line) || item.line < 0) throw new Error('Exceptions require path, line (0 for filename) and identifier')
      safeEvidencePath(item.path)
      if (!insideTouches(item.path, task.touches ?? [])) throw new Error('Text exceptions must be inside approved touches')
    }
  }
  const numeric = task.numericProvenance
  if (numeric !== undefined) {
    if (!numeric || Object.keys(numeric).some(key => !['manifest', 'sources'].includes(key)) || !Array.isArray(numeric.sources) || !numeric.sources.length || numeric.sources.length > 64) throw new Error('numericProvenance requires manifest and approved sources')
    safeEvidencePath(numeric.manifest)
    if (!insideTouches(numeric.manifest, task.touches ?? [])) throw new Error('Provenance manifest must be inside approved touches')
    numeric.sources.forEach(safeEvidencePath)
  }
}
function readSafe(root, path, budget) {
  path = safeEvidencePath(path)
  root = realpathSync(root)
  const absolute = resolve(root, path)
  // safeEvidencePath excludes absolute paths and parent traversal before resolution.
  let current = root
  for (const part of path.split('/')) {
    current = resolve(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Evidence link refused: ${path}`)
  }
  // Windows file IDs can exceed Number's integer precision. Compare exact IDs.
  const expected = lstatSync(absolute, { bigint: true })
  if (!expected.isFile()) throw new Error(`Evidence is not a regular file: ${path}`)
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (stat.dev !== expected.dev || stat.ino !== expected.ino || realpathSync(absolute) !== absolute) throw new Error(`Evidence path changed: ${path}`)
    if (!stat.isFile() || stat.size > MAX_FILE || budget.bytes + Number(stat.size) > MAX_TOTAL) throw new Error(`Evidence reading limit: ${path}`)
    // Bound the actual read as well as stat: growth cannot allocate an unbounded buffer.
    const data = Buffer.alloc(MAX_FILE + 1)
    let bytes = 0, count
    do { count = readSync(fd, data, bytes, data.length - bytes, bytes); bytes += count } while (count && bytes < data.length)
    if (bytes > MAX_FILE || (budget.bytes += bytes) > MAX_TOTAL) throw new Error(`Evidence reading limit: ${path}`)
    return data.subarray(0, bytes)
  } finally { closeSync(fd) }
}
function deliveryFiles(task, cwd) {
  const result = spawnSync('git', ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: MAX_TOTAL })
  if (result.status !== 0) {
    const paths = []
    let visited = 0
    const walk = path => {
      if (++visited > 4096) throw new Error('Delivery traversal exceeds reading limit')
      path = safeEvidencePath(path)
      const absolute = resolve(cwd, path)
      let stat
      try { stat = lstatSync(absolute) } catch (error) { if (error.code === 'ENOENT') return; throw error }
      if (stat.isDirectory()) {
        for (const entry of readdirSync(absolute)) walk(path === '.' ? entry : path + '/' + entry)
      } else paths.push(path)
      if (paths.length > MAX_FILES) throw new Error('Delivery file count exceeds reading limit')
    }
    for (const path of task.touches) walk(path.replace(/[\\/]+$/, ''))
    return [...new Set([...paths, ...(task.deliveries ?? [])])].sort()
  }
  return [...new Set([...result.stdout.split('\0').filter(path => path && insideTouches(path, task.touches)), ...(task.deliveries ?? [])])].sort()
}
export function captureDelivery(task, cwd, content = false, declaredOnly = false) {
  assertEvidenceContract(task)
  if (!(task.touches ?? []).length) return { files: {}, limitation: 'No approved file scope; identifier content check unavailable.' }
  if (!cwd) {
    if (task.deliveries?.length || task.numericProvenance) throw new Error('Declared evidence requires a recorded project cwd')
    return { files: {}, limitation: 'Project cwd unknown; identifier content check unavailable.' }
  }
  const paths = [...new Set((declaredOnly ? task.deliveries ?? [] : deliveryFiles(task, cwd)).map(safeEvidencePath))]
  if (paths.length > MAX_FILES) throw new Error('Delivery file count exceeds reading limit')
  const budget = { bytes: 0 }, files = Object.create(null)
  for (const path of paths) {
    try {
      const data = readSafe(cwd, path, budget)
      files[path] = { digest: hash(data.toString('base64')), ...(data.includes(0) || !isUtf8(data) ? { binary: true } : { lineHashes: data.toString('utf8').split(/\r?\n/).map(hash), ...(content ? { lines: data.toString('utf8').split(/\r?\n/) } : {}) }) }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return { files }
}
export function checkDelivery(state, task, cwd) {
  assertEvidenceContract(task)
  const baseline = task.attempts?.at(-1)?.deliveryBaseline
  if (!baseline && !task.deliveries?.length) return { fingerprint: null, binaryPaths: [], limitation: 'Legacy attempt has no content baseline or declared deliveries; identifier inspection unavailable.' }
  const current = captureDelivery(task, cwd, true, !baseline)
  const declaredPaths = new Set((task.deliveries ?? []).map(safeEvidencePath))
  const identifiers = [...new Set([...Object.keys(state.tasks), ...(state.plan.phases ?? []).map(phase => phase.id), state.run, state.plan.name, ...(task.textRules?.patterns ?? [])].filter(Boolean).map(value => value.toLowerCase()))]
  const matches = text => identifiers.filter(identifier => {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + '(?=$|[^\\p{L}\\p{N}])', 'iu').test(text)
  })
  const findings = [], binaryPaths = []
  const report = (path, line, text) => { for (const identifier of matches(text)) {
    if (!(task.textRules?.exceptions ?? []).some(item => safeEvidencePath(item.path) === path && item.line === line && item.identifier.toLowerCase() === identifier)) findings.push({ path, line })
  } }
  for (const [path, file] of Object.entries(current.files)) {
    const old = baseline?.files?.[path]
    if (!old || old.digest !== file.digest || declaredPaths.has(path)) report(path, 0, path)
    if (file.binary) { binaryPaths.push(path); continue }
    if (old?.digest === file.digest && !declaredPaths.has(path)) continue
    const existing = new Map()
    for (const line of declaredPaths.has(path) ? [] : old?.lineHashes ?? []) existing.set(line, (existing.get(line) ?? 0) + 1)
    file.lines.forEach((line, index) => {
      const lineHash = hash(line)
      const count = existing.get(lineHash) ?? 0
      if (count) existing.set(lineHash, count - 1)
      else report(path, index + 1, line)
    })
  }
  if (findings.length) throw new Error('Delivery identifiers refused: ' + [...new Set(findings.map(item => `${item.path}:${item.line}`))].join(', '))
  const fingerprints = Object.fromEntries(Object.entries(current.files).map(([path, { lines, ...file }]) => [path, file]))
  return { fingerprint: hash({ ...current, files: fingerprints }), binaryPaths, limitation: baseline ? current.limitation : 'Legacy attempt has no content baseline; only declared deliveries were checked.' }
}
function pointerValue(value, pointer) {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/')) || /~(?![01])/.test(pointer)) throw new Error('Invalid provenance JSON pointer')
  for (const token of pointer === '' ? [] : pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, token)) throw new Error('Provenance location does not exist')
    value = value[token]
  }
  return value
}
export function verifyNumericProvenance(task, cwd) {
  if (!task.numericProvenance) return null
  assertEvidenceContract(task)
  const budget = { bytes: 0 }, documents = new Map()
  const read = path => {
    safeEvidencePath(path)
    if (!documents.has(path)) {
      const data = readSafe(cwd, path, budget)
      try { documents.set(path, { data: data.toString('base64'), value: JSON.parse(data.toString('utf8')) }) }
      catch { throw new Error(`Invalid provenance JSON: ${path}`) }
    }
    return documents.get(path).value
  }
  const manifest = read(task.numericProvenance.manifest)
  if (!Array.isArray(manifest.claims) || !manifest.claims.length || manifest.claims.length > 256) throw new Error('Numeric provenance requires nonempty bounded claims')
  for (const claim of manifest.claims) {
    if (!claim || !task.numericProvenance.sources.includes(claim.source) || !claim.result || !insideTouches(claim.result.source, task.touches)) throw new Error('Invalid or unapproved provenance reference')
    const source = pointerValue(read(claim.source), claim.pointer)
    let calculated
    if (claim.operation === 'value') calculated = source
    else if (claim.operation === 'count' && Array.isArray(source)) calculated = source.length
    else if (claim.operation === 'sum' && Array.isArray(source) && source.every(value => typeof value === 'number' && Number.isFinite(value))) calculated = source.reduce((total, value) => total + value, 0)
    else throw new Error('Provenance calculation requires value, array count or numeric array sum')
    const output = pointerValue(read(claim.result.source), claim.result.pointer)
    if (typeof calculated !== 'number' || !Number.isFinite(calculated) || calculated !== claim.value || output !== calculated) throw new Error('Numeric provenance result diverges from source or declared value')
  }
  return { fingerprint: hash([...documents].map(([path, document]) => [path, document.data])), claims: manifest.claims.length, method: 'declared-json-calculation' }
}
