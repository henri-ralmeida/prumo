import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { resolve, relative, dirname, isAbsolute } from 'node:path'
import { gitInventoryPath, gitDirectoryEvidence, scopeFileDigest } from './git-directory-evidence.mjs'

export const scopePath = value => {
  const normalized = value.replace(/\\/g, '/').split('/').filter(part => part && part !== '.').join('/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
export function externalTouchPaths(task) {
  return (task.touches ?? []).filter(path => /^(?:[/\\]|[A-Za-z]:)/.test(path))
}
export function insideTouches(path, touches) {
  const candidate = scopePath(path)
  return touches.some(value => { const prefix = scopePath(value); return prefix === '' || candidate === prefix || candidate.startsWith(prefix + '/') })
}
export function assertExplicitScope(task, policy) {
  if (task.project !== undefined && (typeof task.project !== 'string' || !isAbsolute(task.project) || task.project.includes('\0')))
    throw new Error('task project must be an absolute Git repository root')
  if (policy !== undefined && policy !== 'explicit') throw new Error('scopePolicy must be explicit when present')
  if (policy === 'explicit') {
    if (!['files', 'read-only', 'unknown'].includes(task.writeScope)) throw new Error('explicit scope requires writeScope files, read-only or unknown')
    if (!Array.isArray(task.touches) || task.touches.some(path => typeof path !== 'string' || !path.trim() || /^(?:[/\\]|[A-Za-z]:)/.test(path) || path.includes('\0') || path.replace(/\\/g, '/').split('/').includes('..')))
      throw new Error('explicit scope requires safe repository-relative touches: paths are relative to the task project, or the run project directory; for another repository declare task.project with its absolute Git root; touches must not contain .. or absolute paths')
    if (task.writeScope === 'files' && !task.touches.length) throw new Error('files scope requires nonempty touches')
    if (task.writeScope !== 'files' && task.touches.length) throw new Error('read-only and unknown scope require empty touches')
  }
  if (task.sharedResources !== undefined && (!Array.isArray(task.sharedResources) || task.sharedResources.some(resource => !resource || typeof resource.id !== 'string' || !resource.id.trim() || !['read', 'write'].includes(resource.access))))
    throw new Error('sharedResources requires nonempty id and access read or write')
}
export function sameProject(task, other, defaultProject) {
  const key = value => {
    if (!value) return ''
    let path = resolve(value)
    try { path = realpathSync.native(path) } catch { /* O início verifica a raiz Git antes de executar. */ }
    return process.platform === 'win32' ? path.toLowerCase() : path
  }
  return key(task.project ?? defaultProject) === key(other.project ?? defaultProject)
}
// As verificações podem usar outro projeto; a evidência de escopo continua presa ao contrato aprovado.
export function validationProjectMismatch(task, defaultProject, validationCwd) {
  const project = task.project ?? defaultProject
  if (!project || !validationCwd || sameProject({ project }, { project: validationCwd })) return null
  const root = cwd => {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true })
    return result.status === 0 ? result.stdout.trim() : null
  }
  const approved = root(project), actual = root(validationCwd)
  if (!approved || !actual || sameProject({ project: approved }, { project: actual })) return null
  return { project: resolve(approved), validationProject: resolve(actual), validationCwd: resolve(validationCwd) }
}
export function scopeConflicts(task, other, defaultProject) {
  const paths = sameProject(task, other, defaultProject) ? (task.touches ?? []).filter(path => (other.touches ?? []).some(candidate => insideTouches(path, [candidate]) || insideTouches(candidate, [path]))) : []
  const resources = (task.sharedResources ?? []).filter(resource => (other.sharedResources ?? []).some(candidate => candidate.id === resource.id && (resource.access === 'write' || candidate.access === 'write'))).map(resource => resource.id)
  return { paths, resources: [...new Set(resources)] }
}
export function captureScopeBaseline(cwd) {
  try {
    if (!cwd) throw new Error('project directory is unknown')
    const root = realpathSync.native(resolve(cwd))
    const git = (...args) => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); if (result.status !== 0) throw new Error('Git repository snapshot is unavailable'); return result.stdout }
    const repository = realpathSync.native(git('rev-parse', '--show-toplevel').trim())
    if (relative(root, repository) !== '') throw new Error('project directory must be the Git repository root')
    // HEAD contextualiza trocas de checkout; somente o conteúdo determina mudanças de escopo.
    const revision = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', windowsHide: true })
    const head = revision.status === 0 ? revision.stdout.trim() : null
    const files = Object.create(null), nestedRepositories = []
    for (const entry of new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))) {
      const path = gitInventoryPath(entry)
      const absolute = resolve(root, path)
      try {
        for (let parent = dirname(absolute); parent !== root; parent = dirname(parent)) {
          if (lstatSync(parent).isSymbolicLink()) throw new Error('A parent directory is a symbolic link; independent scope evidence is required')
        }
        const stat = lstatSync(absolute)
        if (stat.isDirectory()) {
          const snapshot = gitDirectoryEvidence(root, path)
          files[path] = snapshot.digest
          nestedRepositories.push(path)
          continue
        }
        files[path] = stat.isSymbolicLink() ? createHash('sha256').update(readlinkSync(absolute)).update(String(stat.mode)).digest('hex') : scopeFileDigest(root, path, stat.mode)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return { method: 'git', cwd: root, head, files, ...(nestedRepositories.length ? { nestedRepositories } : {}),
      limitation: 'Ignored files are not included in the Git scope check.' + (nestedRepositories.length ? ' Nested repositories require independent inspection; their directory scope is fingerprinted.' : '') }
  } catch (error) { return { method: 'unavailable', limitation: error.message } }
}
// A falta de argumento deve ser detectada antes dos comandos; alterações reais continuam sujeitas ao gate final.
export function scopeEvidenceRequirement(task, baseline, concurrentScopes = []) {
  if (externalTouchPaths(task).length) return 'External approved paths require independent scope evidence'
  const current = captureScopeBaseline(baseline?.cwd)
  if (baseline?.method !== 'git' || current.method !== 'git') return 'Git scope unavailable'
  if (baseline.nestedRepositories?.length || current.nestedRepositories?.length) return 'Nested repositories require independent scope evidence'
  const paths = [...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])].filter(path => baseline.files[path] !== current.files[path])
  if (paths.some(path => (task.writeScope !== 'files' || !insideTouches(path, task.touches)) && concurrentScopes.some(scope => insideTouches(path, scope))))
    return 'changes outside approved touches overlap concurrent delivery scopes'
  return null
}
export function verifyTaskScope(task, baseline, independentEvidence, concurrentScopes = []) {
  const externalPaths = externalTouchPaths(task)
  const fileScope = task.writeScope === 'files' || (task.writeScope === undefined && externalPaths.length > 0)
  const touches = (task.touches ?? []).filter(path => !externalPaths.includes(path))
  if (externalPaths.length && (!independentEvidence?.evidence?.trim() || !independentEvidence.agent || independentEvidence.agent === task.agent))
    throw new Error('External approved paths require an independent reviewer --scope-evidence with inspected paths and method')
  const current = captureScopeBaseline(baseline?.cwd)
  if (baseline?.method !== 'git' || current.method !== 'git') {
    if (!independentEvidence?.evidence?.trim() || !independentEvidence.agent || independentEvidence.agent === task.agent)
      throw new Error('Scope check unavailable; an independent reviewer must provide --scope-evidence with the inspected delivery paths and method')
    return { method: 'independent-review', limitation: baseline?.limitation ?? current.limitation, ...independentEvidence,
      ...(externalPaths.length ? { externalPaths, externalLimitation: 'External paths are not captured by repository evidence; independent inspection is required.' } : {}) }
  }
  const paths = [...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])].filter(path => baseline.files[path] !== current.files[path])
  const excludedPaths = paths.filter(path => !fileScope || !insideTouches(path, touches)).filter(path =>
    independentEvidence?.evidence?.trim() && independentEvidence.agent && independentEvidence.agent !== task.agent && concurrentScopes.some(scope => insideTouches(path, scope)))
  const outside = paths.filter(path => (!fileScope || !insideTouches(path, touches)) && !excludedPaths.includes(path))
  const gitContext = { baselineHead: baseline.head ?? null, currentHead: current.head ?? null }
  if (outside.length) throw new Error('Delivery changes are outside approved touches: ' + outside.join(', ') + '. These changes may belong to another task or be absorbed by a new attempt; --force does not apply to scope. Git scope context: baseline HEAD ' + (gitContext.baselineHead ?? 'unavailable') + '; current HEAD ' + (gitContext.currentHead ?? 'unavailable') + '. HEAD changes alone do not establish authorship.')
  if ((baseline.nestedRepositories?.length || current.nestedRepositories?.length) &&
      (!independentEvidence?.evidence?.trim() || !independentEvidence.agent || independentEvidence.agent === task.agent))
    throw new Error('Nested repositories require an independent reviewer --scope-evidence with inspected paths and method')
  return { method: 'git', paths, excludedPaths, gitContext, ...(excludedPaths.length || externalPaths.length || current.nestedRepositories?.length || baseline.nestedRepositories?.length ? { independentEvidence } : {}),
    ...(externalPaths.length ? { externalPaths, externalLimitation: 'External paths are not captured by repository evidence; independent inspection is required.' } : {}),
    // O commit pode mudar a ordem do inventário sem mudar arquivos ou permissões.
    fingerprint: createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(current.files).sort().map(path => [path, current.files[path]])))).digest('hex'),
    legacyFingerprint: createHash('sha256').update(JSON.stringify(current.files)).digest('hex'),
    // Recibos antigos podem usar a ordem da baseline seguida dos arquivos novos; todos os hashes e modos continuam na comparação.
    baselineOrderFingerprint: createHash('sha256').update(JSON.stringify(Object.fromEntries(
      [...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])].filter(path => Object.hasOwn(current.files, path)).map(path => [path, current.files[path]])))).digest('hex'),
    newFilesFirstFingerprint: createHash('sha256').update(JSON.stringify(Object.fromEntries(
      [...Object.keys(current.files).filter(path => !Object.hasOwn(baseline.files, path)), ...Object.keys(baseline.files)]
        .filter(path => Object.hasOwn(current.files, path)).map(path => [path, current.files[path]])))).digest('hex'),
    limitation: current.limitation }
}
