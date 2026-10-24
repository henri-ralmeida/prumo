import { constants, lstatSync, openSync, closeSync, fstatSync, realpathSync, readSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { insideTouches, externalTouchPaths } from './task-scope.mjs'
import { safeRepositoryPath, gitInventoryPath, evidenceLocation, gitDirectoryEvidence } from './git-directory-evidence.mjs'

const MAX_FILE = 1024 * 1024, MAX_TOTAL = 8 * MAX_FILE, MAX_FILES = 256
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const safeEvidencePath = safeRepositoryPath
export function assertEvidenceContract(task) {
  const touches = (task.touches ?? []).filter(path => !externalTouchPaths(task).includes(path))
  if (task.deliveries !== undefined && !Array.isArray(task.deliveries)) throw new Error('deliveries must be an array')
  for (const path of task.deliveries ?? []) {
    safeEvidencePath(path)
    if (!insideTouches(path, touches)) throw new Error('Deliveries must be inside approved touches')
  }
  const rules = task.textRules
  if (rules !== undefined) {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).some(key => !['patterns', 'exceptions'].includes(key))) throw new Error('Invalid textRules')
    if (rules.patterns !== undefined && (!Array.isArray(rules.patterns) || rules.patterns.length > 64 || rules.patterns.some(value => typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f]/.test(value)))) throw new Error('textRules.patterns requires bounded literal strings')
    if (rules.exceptions !== undefined && (!Array.isArray(rules.exceptions) || rules.exceptions.length > 64)) throw new Error('Invalid textRules.exceptions')
    for (const item of rules.exceptions ?? []) {
      if (!item || Object.keys(item).some(key => !['path', 'line', 'identifier'].includes(key)) || typeof item.identifier !== 'string' || !item.identifier.trim() || item.identifier.length > 128 || !Number.isSafeInteger(item.line) || item.line < 0) throw new Error('Exceptions require path, line (0 for filename) and identifier')
      safeEvidencePath(item.path)
      if (!insideTouches(item.path, touches)) throw new Error('Text exceptions must be inside approved touches')
    }
  }
  const numeric = task.numericProvenance
  if (numeric !== undefined) {
    if (!numeric || Object.keys(numeric).some(key => !['manifest', 'sources'].includes(key)) || !Array.isArray(numeric.sources) || !numeric.sources.length || numeric.sources.length > 64) throw new Error('numericProvenance requires manifest and approved sources')
    safeEvidencePath(numeric.manifest)
    if (!insideTouches(numeric.manifest, touches)) throw new Error('Provenance manifest must be inside approved touches')
    numeric.sources.forEach(safeEvidencePath)
  }
}
function readSafe(root, path, budget, allowLargeBinary = false) {
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
  // }finally sem separador evita um ramo de whitespace no V8; o fechamento continua incondicional.
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (stat.dev !== expected.dev || stat.ino !== expected.ino || realpathSync(absolute) !== absolute) throw new Error(`Evidence path changed: ${path}`)
    if (!stat.isFile() || (!allowLargeBinary && stat.size > MAX_FILE) ||
        (!allowLargeBinary && budget.bytes + Number(stat.size) > MAX_TOTAL)) throw new Error(`Evidence reading limit: ${path}`)
    const unchanged = bytes => {
      const after = fstatSync(fd, { bigint: true }), location = lstatSync(evidenceLocation(root, path), { bigint: true })
      if (after.dev !== stat.dev || after.ino !== stat.ino || location.dev !== stat.dev || location.ino !== stat.ino ||
          after.size !== stat.size || BigInt(bytes) !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs)
        throw new Error(`Evidence changed during capture: ${path}`)
    }
    if (stat.size > MAX_FILE) {
      // Hash large binary deliveries in bounded chunks; a digest is identity evidence, not content approval.
      const chunk = Buffer.alloc(64 * 1024), digest = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0, binary = false, count
      do {
        count = readSync(fd, chunk, 0, chunk.length, bytes)
        bytes += count
        if (BigInt(bytes) > stat.size) throw new Error(`Evidence changed during capture: ${path}`)
        const data = chunk.subarray(0, count)
        digest.update(data)
        if (!binary) {
          if (data.includes(0)) binary = true
          else { try { decoder.decode(data, { stream: true }) } catch { binary = true } }
        }
      } while (count)
      if (!binary) { try { decoder.decode() } catch { binary = true } }
      unchanged(bytes)
      if (!binary) throw new Error(`Evidence reading limit: ${path}; text exceeds 1 MiB and requires bounded independent inspection`)
      return { binary: true, size: bytes, digest: digest.digest('hex'), digestMethod: 'sha256',
        identity: { device: stat.dev.toString(), inode: stat.ino.toString() } }
    }
    // Bound the actual read as well as stat: growth cannot allocate an unbounded buffer.
    const data = Buffer.alloc(MAX_FILE + 1)
    let bytes = 0, count
    do { count = readSync(fd, data, bytes, data.length - bytes, bytes); bytes += count } while (count && bytes < data.length)
    if (bytes > MAX_FILE || ((!allowLargeBinary || !(data.subarray(0, bytes).includes(0) || !isUtf8(data.subarray(0, bytes)))) &&
        (budget.bytes += bytes) > MAX_TOTAL)) throw new Error(`Evidence reading limit: ${path}`)
    unchanged(bytes)
    return data.subarray(0, bytes)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Evidence changed during capture: ${path}`)
    throw error
  }finally { closeSync(fd) }
}
function deliveryFiles(task, cwd) {
  const touches = task.touches.filter(path => !externalTouchPaths(task).includes(path))
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
    for (const path of touches) walk(path.replace(/[\\/]+$/, ''))
    return [...new Set([...paths, ...(task.deliveries ?? [])])].sort()
  }
  return [...new Set([...result.stdout.split('\0').filter(path => path && insideTouches(path, touches)), ...(task.deliveries ?? [])])].sort()
}
export function captureDelivery(task, cwd, content = false, declaredOnly = false) {
  cwd = task.project ?? cwd
  assertEvidenceContract(task)
  const externalPaths = externalTouchPaths(task)
  for (const path of externalPaths) {
    if (/^[A-Za-z]:(?![/\\])/.test(path) || /[\x00-\x1f]/.test(path) || path.replaceAll('\\', '/').split('/').includes('..'))
      throw new Error('Evidence paths must be safe repository-relative paths')
  }
  if (!(task.touches ?? []).length) return { files: {}, limitation: 'No approved file scope; identifier content check unavailable.' }
  if (!cwd) {
    if (task.deliveries?.length || task.numericProvenance) throw new Error('Declared evidence requires a recorded project cwd')
    return { files: {}, limitation: 'Project cwd unknown; identifier content check unavailable.' }
  }
  const paths = [...new Set((declaredOnly ? task.deliveries ?? [] : deliveryFiles(task, cwd)).map(declaredOnly ? safeEvidencePath : gitInventoryPath))]
  if (paths.length > MAX_FILES) throw new Error('Delivery file count exceeds reading limit')
  const budget = { bytes: 0, files: paths.length }, files = Object.create(null), nestedRepositories = []
  for (const path of paths) {
    try {
      if (lstatSync(evidenceLocation(cwd, path)).isDirectory()) {
        nestedRepositories.push(gitDirectoryEvidence(cwd, path, budget))
        continue
      }
      const data = readSafe(cwd, path, budget, true)
      files[path] = Buffer.isBuffer(data) ? { digest: hash(data.toString('base64')), ...(data.includes(0) || !isUtf8(data) ? { binary: true } : { lineHashes: data.toString('utf8').split(/\r?\n/).map(hash), ...(content ? { lines: data.toString('utf8').split(/\r?\n/) } : {}) }) } : data
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const limitations = []
  if (externalPaths.length) limitations.push('External paths are not captured by repository evidence; independent inspection is required.')
  if (nestedRepositories.length) limitations.push('Nested repository source text and ignored files require independent inspection.')
  if (Object.values(files).some(file => file.digestMethod === 'sha256')) limitations.push('Large binary files are fingerprinted in bounded memory, not inspected as text; independent inspection is required.')
  return { files, ...(externalPaths.length ? { externalPaths } : {}),
    ...(nestedRepositories.length ? { nestedRepositories } : {}), ...(limitations.length ? { limitation: limitations.join(' ') } : {}) }
}
function csharpFormattingText(text) {
  // Apenas a posicao de formato numerico deixa de ser metadado; comentarios e texto comum continuam inspecionados.
  let previousEnd = 0
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|\$*("{3,})[\s\S]*?(?:\1|$)|'(?:\\.|[^'\\\r\n])*'|(?:\$@|@\$|@)"(?:""|[^"])*"|\$?"(?:\\.|[^"\\\r\n])*"/g, (token, raw, offset) => {
    const prefix = text.slice(previousEnd, offset)
    previousEnd = offset + token.length
    if (raw || !/^(?:\$@|@\$|@|\$)?"/.test(token)) return token
    const quote = token.indexOf('"'), content = token.slice(quote + 1, -1)
    if (/^[BCDEFGNPRX]\d+$/i.test(content) &&
        /\.\s*ToString\s*\(\s*$/.test(prefix) && /^\s*[,)]/.test(text.slice(offset + token.length)))
      return token.slice(0, quote + 1) + ' '.repeat(content.length) + '"'
    const interpolated = token.slice(0, quote).includes('$')
    const composite = /(?:^|[^\p{L}\p{N}_.])(?:(?:string|(?:System\.)?String)\s*\.\s*Format|(?:System\.)?Console\s*\.\s*Write(?:Line)?)\s*\(\s*$/u.test(prefix) && /^\s*,/.test(text.slice(offset + token.length))
    return token.replace(/(?<!\{)\{([^{}:"'\r\n]+):([BCDEFGNPRX]\d+)\}(?!\})/gi, (placeholder, expression, format) => {
      if (!interpolated && !(composite && /^\d+(?:\s*,\s*-?\d+)?$/.test(expression))) return placeholder
      return placeholder.slice(0, -format.length - 1) + ' '.repeat(format.length) + '}'
    })
  })
}
export function assertReviewedDelivery(task, delivery) {
  const attempt = task.attempts?.at(-1)
  const reviewed = attempt?.reviewDelivery?.fingerprint ?? attempt?.reviewProgress?.deliveryFingerprint
  const content = attempt?.reviewDelivery?.contentFingerprint
  // A revisao acompanha o conteudo apresentado; commits equivalentes e entregas sem Git continuam validos.
  // Tentativas antigas sem identidade capturada preservam as exigencias de evidencia independente existentes.
  if (task.state === 'reviewing' && reviewed != null &&
      (content == null ? reviewed !== delivery.fingerprint : content !== delivery.contentFingerprint))
    throw new Error('Delivery changed since review; restore the reviewed content or inspect the current delivery and record review-progress (legacy criteria: block, then unblock --reviewer) before validating again')
}
export function checkDelivery(state, task, cwd) {
  cwd = task.project ?? cwd
  assertEvidenceContract(task)
  const baseline = task.attempts?.at(-1)?.deliveryBaseline
  if (!baseline && !task.deliveries?.length) return { fingerprint: null, binaryPaths: [], limitation: 'Legacy attempt has no content baseline or declared deliveries; identifier inspection unavailable.' }
  const current = captureDelivery(task, cwd, true, !baseline)
  const declaredPaths = new Set((task.deliveries ?? []).map(safeEvidencePath))
  const protectedIdentifiers = new Set([...Object.keys(state.tasks), state.run, state.plan.name, ...(task.textRules?.patterns ?? [])].filter(Boolean).map(value => value.toLowerCase()))
  const identifiers = [...new Set([...protectedIdentifiers, ...(state.plan.phases ?? []).map(phase => phase.id)].filter(Boolean).map(value => value.toLowerCase()))]
  const matches = (text, formattedText) => identifiers.filter(identifier => {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + '(?=$|[^\\p{L}\\p{N}])', 'iu').test(protectedIdentifiers.has(identifier) ? text : formattedText)
  })
  const findings = [], binaryPaths = []
  const report = (path, line, text, formattedText = text) => { for (const identifier of matches(text, formattedText)) {
    if (!(task.textRules?.exceptions ?? []).some(item => safeEvidencePath(item.path) === path && item.line === line && item.identifier.toLowerCase() === identifier)) findings.push({ path, line })
  } }
  for (const [path, file] of Object.entries(current.files)) {
    const old = baseline?.files?.[path]
    if (!old || old.digest !== file.digest || declaredPaths.has(path)) report(path, 0, path)
    if (file.binary) { binaryPaths.push(path); continue }
    if (old?.digest === file.digest && !declaredPaths.has(path)) continue
    const formattedLines = /\.cs$/i.test(path) ? csharpFormattingText(file.lines.join('\n')).split('\n') : file.lines
    const existing = new Map()
    for (const line of declaredPaths.has(path) ? [] : old?.lineHashes ?? []) existing.set(line, (existing.get(line) ?? 0) + 1)
    file.lines.forEach((line, index) => {
      const lineHash = hash(line)
      const count = existing.get(lineHash) ?? 0
      if (count) existing.set(lineHash, count - 1)
      else report(path, index + 1, line, formattedLines[index])
    })
  }
  if (findings.length) throw new Error('Delivery identifiers refused: ' + [...new Set(findings.map(item => `${item.path}:${item.line}`))].join(', '))
  const fingerprints = Object.fromEntries(Object.entries(current.files).map(([path, { lines, ...file }]) => [path, file]))
  // Entre revisoes, bytes identicos continuam equivalentes mesmo se o sistema substituir o arquivo.
  // A identidade fisica permanece no fingerprint original para detectar trocas durante a validacao.
  const contentFiles = Object.fromEntries(Object.entries(fingerprints).map(([path, { identity, ...file }]) => [path, file]))
  return { fingerprint: hash({ ...current, files: fingerprints }), contentFingerprint: hash({ ...current, files: contentFiles }), binaryPaths,
    ...(current.nestedRepositories ? { nestedRepositories: current.nestedRepositories } : {}),
    limitation: baseline ? current.limitation : 'Legacy attempt has no content baseline; only declared deliveries were checked.' }
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
  cwd = task.project ?? cwd
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
