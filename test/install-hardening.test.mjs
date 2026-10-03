import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { installedPoFirstLanguage, planInstall, applyInstall, restoreInstall } from '../lib/install.mjs'

const nodeFs = createRequire(import.meta.url)('node:fs')
const temporaryRoot = realpathSync(tmpdir())
const temporary = prefix => mkdtempSync(join(temporaryRoot, prefix))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function fixture(t, prefix = 'prumo-install-hardening-', apply = true) {
  const home = temporary(prefix)
  const project = join(home, 'project')
  const config = join(home, '.claude')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(config, { recursive: true })
  const settings = join(config, 'settings.json')
  writeFileSync(settings, JSON.stringify({ permissions: { deny: ['Read(secret)'] } }) + '\n')
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: config,
    PRUMO_HOME: join(home, 'data'),
    PRUMO_LANG: 'en',
  }
  const plan = planInstall({ harness: 'claude', home, cwd: project, env, lang: 'en' })
  const applied = apply ? applyInstall(plan) : null
  if (apply) assert.ok(applied.backup, 'o fixture precisa produzir um backup real')
  t.after(() => {
    assert.ok(home.startsWith(join(temporaryRoot, prefix)))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return { home, config, cwd: project, env, plan, backup: applied?.backup, settings }
}

test('restore recusa um alvo fora das raízes registradas antes de alterar arquivos', t => {
  const f = fixture(t)
  const outside = temporary('prumo-restore-outside-')
  const target = join(outside, 'protected.txt')
  writeFileSync(target, 'conteúdo protegido')
  t.after(() => {
    assert.ok(outside.startsWith(join(temporaryRoot, 'prumo-restore-outside-')))
    rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const manifestFile = join(f.backup, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const entry = manifest.files.find(item => item.original !== null && !item.copiedData)
  assert.ok(entry, 'o fixture precisa conter um arquivo original no manifesto')
  entry.file = target
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))

  assert.throws(() => restoreInstall(f.backup, { home: f.home, env: f.env }), /Backup target is outside the configured locations/)
  assert.equal(readFileSync(target, 'utf8'), 'conteúdo protegido')
  assert.match(readFileSync(f.settings, 'utf8'), /PO First/)
})

test('restore recusa caminho original adulterado e backup ligado sem desfazer a instalação', t => {
  const f = fixture(t)
  const manifestFile = join(f.backup, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const entry = manifest.files.find(item => item.original !== null && !item.copiedData)
  assert.ok(entry, 'o fixture precisa conter um arquivo original no manifesto')
  entry.original = '../fora-do-backup'
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  assert.throws(() => restoreInstall(f.backup, { home: f.home, env: f.env }), /Invalid backup file path/)
  assert.match(readFileSync(f.settings, 'utf8'), /PO First/)

  const linkedBackup = join(dirname(f.backup), 'backup-ligado')
  symlinkSync(f.backup, linkedBackup, process.platform === 'win32' ? 'junction' : 'dir')
  t.after(() => rmSync(linkedBackup, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  assert.throws(() => restoreInstall(linkedBackup, { home: f.home, env: f.env }), /Linked path requires/)
  assert.equal(existsSync(f.settings), true)
})

test('atualização preserva link relativo interno e dados nas duas raízes Unix', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t, 'prumo-install-relative-internal-', false)
  const marker = join(f.config, 'skills', 'prumo', '.prumo-install.json')
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ product: 'prumo', version: '1.3.16', harness: 'claude', lang: 'en' }))
  const source = join(f.home, '.local', 'share', 'graph-foreman', 'work', '.specs')
  const state = join(source, 'graph', 'run', 'state.json')
  const bytes = '{"estado":"preservar"}\n'
  mkdirSync(dirname(state), { recursive: true })
  writeFileSync(state, bytes)
  const target = 'graph/run'
  symlinkSync(target, join(source, 'current-run'), 'dir')
  const result = applyInstall(planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: f.env, lang: 'en' }))
  assert.ok(result.backup, 'a atualização registra backup antes de copiar os dados')
  assert.ok(result.groups.every(group => group.status !== 'conflict'), JSON.stringify(result.groups))
  const manifest = JSON.parse(readFileSync(join(result.backup, 'manifest.json'), 'utf8'))
  const relocation = manifest.relocations.find(entry => entry.source === source)
  assert.ok(relocation)
  assert.equal(relocation.preserveSource, true)
  assert.notEqual(realpathSync(relocation.destination), realpathSync(source))
  for (const root of [source, relocation.destination, join(result.backup, relocation.backup)]) {
    assert.equal(readlinkSync(join(root, 'current-run')), target, 'o alvo interno conserva sua representação relativa')
    assert.equal(realpathSync(join(root, 'current-run')), realpathSync(join(root, 'graph', 'run')))
    assert.equal(readFileSync(join(root, 'current-run', 'state.json'), 'utf8'), bytes)
    assert.equal(readFileSync(join(root, 'graph', 'run', 'state.json'), 'utf8'), bytes)
  }
})

test('restore reconstitui relocação interrompida e remove origem vazia', t => {
  const f = fixture(t, 'prumo-install-relocation-recovery-', false)
  const marker = join(f.config, 'skills', 'prumo', '.prumo-install.json')
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ product: 'prumo', version: '1.3.16', harness: 'claude', lang: 'en' }))

  const sourceRoot = join(f.home, '.local', 'share', 'graph-foreman', 'work')
  const source = join(sourceRoot, '.specs')
  const state = join(source, 'graph', 'run', 'state.json')
  mkdirSync(dirname(state), { recursive: true })
  writeFileSync(state, '{"estado":"preservar"}\n')
  const externalDirectory = join(f.home, 'destino-externo')
  const externalFile = join(externalDirectory, 'valor.txt')
  mkdirSync(externalDirectory, { recursive: true })
  writeFileSync(externalFile, 'fora da origem')
  const relativeDirectoryLink = join(source, 'link-diretorio')
  try { symlinkSync(relative(source, externalDirectory), relativeDirectoryLink, 'dir') } catch (error) {
    if (process.platform !== 'win32') throw error
    symlinkSync(externalDirectory, relativeDirectoryLink, 'junction')
  }
  const topDirectoryLink = join(sourceRoot, 'link-topo')
  try { symlinkSync(relative(sourceRoot, externalDirectory), topDirectoryLink, 'dir') } catch (error) {
    if (process.platform !== 'win32') throw error
    symlinkSync(externalDirectory, topDirectoryLink, 'junction')
  }
  try { symlinkSync(relative(source, externalFile), join(source, 'link-arquivo'), 'file') } catch (error) {
    if (process.platform !== 'win32') throw error
  }
  const result = applyInstall(planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: f.env, lang: 'en' }))
  assert.ok(result.backup, 'a migração precisa deixar um backup transacional')

  const manifestFile = join(result.backup, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const relocation = manifest.relocations.find(entry => entry.source === source)
  assert.ok(relocation, 'o manifesto precisa registrar a relocação')
  assert.equal(relocation.preserveSource, true)

  rmSync(source, { recursive: true, force: true })
  mkdirSync(join(source, 'vazio', 'aninhado'), { recursive: true })
  relocation.preserveSource = false
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))

  assert.ok(restoreInstall(result.backup, { home: f.home, env: f.env }) > 0)
  assert.equal(readFileSync(state, 'utf8'), '{"estado":"preservar"}\n')
  assert.equal(existsSync(relocation.destination), false)
  assert.equal(readFileSync(externalFile, 'utf8'), 'fora da origem')
})

test('aplicação limpa pastas legadas vazias e rejeita alterações inesperadas', t => {
  const home = temporary('prumo-install-cleanup-')
  t.after(() => {
    assert.ok(home.startsWith(join(temporaryRoot, 'prumo-install-cleanup-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const missing = join(home, 'missing')
  const empty = join(home, 'empty', 'nested')
  const discarded = join(home, 'discarded')
  mkdirSync(empty, { recursive: true })
  mkdirSync(join(discarded, 'keep'), { recursive: true })
  const plan = {
    home,
    allowedRoots: [home],
    groups: [{ name: 'cleanup', snapshots: [], changes: [], conflicts: [], cleanup: [
      missing,
      empty,
      { path: discarded, discard: true, originalEntries: ['keep'] },
    ] }],
  }
  const result = applyInstall(plan)
  assert.equal(result.groups[0].status, 'installed')
  assert.equal(existsSync(empty), false)
  assert.equal(existsSync(discarded), false)

  const fileFolder = join(home, 'file-folder')
  mkdirSync(fileFolder, { recursive: true })
  writeFileSync(join(fileFolder, 'unexpected.txt'), 'mudança')
  const fileResult = applyInstall({
    home,
    allowedRoots: [home],
    groups: [{ name: 'cleanup-file', snapshots: [], changes: [], conflicts: [], cleanup: [{ path: fileFolder, optionalWhenEmpty: false }] }],
  })
  assert.equal(fileResult.groups[0].status, 'conflict')
  assert.match(fileResult.groups[0].errors.join('\n'), /Legacy skill changed during installation/)

  const linkFolder = join(home, 'link-folder')
  const linkTarget = join(home, 'link-target')
  mkdirSync(linkTarget, { recursive: true })
  mkdirSync(linkFolder, { recursive: true })
  symlinkSync(linkTarget, join(linkFolder, 'foreign'), process.platform === 'win32' ? 'junction' : 'dir')
  const linkResult = applyInstall({
    home,
    allowedRoots: [home],
    groups: [{ name: 'cleanup-link', snapshots: [], changes: [], conflicts: [], cleanup: [{ path: linkFolder, optionalWhenEmpty: true }] }],
  })
  assert.equal(linkResult.groups[0].status, 'conflict')

  const discardFolder = join(home, 'discard-with-data')
  mkdirSync(join(discardFolder, '.specs'), { recursive: true })
  writeFileSync(join(discardFolder, '.specs', 'run.txt'), 'execução')
  const discardResult = applyInstall({
    home,
    allowedRoots: [home],
    groups: [{ name: 'cleanup-discard-data', snapshots: [], changes: [], conflicts: [], cleanup: [{ path: discardFolder, discard: true, originalEntries: ['.specs'] }] }],
  })
  assert.equal(discardResult.groups[0].status, 'conflict')
})

test('aplicação usa cópia quando a relocação atravessa volumes disponíveis', t => {
  if (process.platform === 'win32' || !existsSync('/dev/shm')) return t.skip('EXDEV exige dois volumes Unix disponíveis')
  const home = temporary('prumo-install-exdev-')
  const sourceRoot = mkdtempSync('/dev/shm/prumo-install-exdev-')
  t.after(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(sourceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const source = join(sourceRoot, '.specs')
  const destinationRoot = join(home, 'destination')
  const destination = join(destinationRoot, '.specs')
  const file = join(source, 'state.json')
  mkdirSync(source, { recursive: true })
  const bytes = Buffer.from('{"estado":"cross-volume"}\n')
  writeFileSync(file, bytes)
  const fileHash = createHash('sha256').update(bytes).digest('hex')
  const stamp = createHash('sha256').update('state.json\0').update(`file\0${bytes.length}\0`).update(fileHash).digest('hex')
  const result = applyInstall({
    home,
    allowedRoots: [home, sourceRoot, destinationRoot],
    groups: [{
      name: 'workspace:cross-volume', snapshots: [], changes: [], conflicts: [], cleanup: [],
      relocation: { source, destination, stamp, workspaceSource: sourceRoot, workspaceDestination: destinationRoot, preserveSource: false },
    }],
  })
  assert.equal(result.groups[0].status, 'installed')
  assert.equal(existsSync(source), false)
  assert.equal(readFileSync(join(destination, 'state.json'), 'utf8'), bytes.toString())
})

test('aplicação desfaz relocação quando a origem muda durante a cópia', t => {
  const f = fixture(t, 'prumo-install-relocation-race-', false)
  const marker = join(f.config, 'skills', 'prumo', '.prumo-install.json')
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ product: 'prumo', version: '1.3.16', harness: 'claude', lang: 'en' }))
  const sourceRoot = join(f.home, '.local', 'share', 'graph-foreman', 'race')
  const source = join(sourceRoot, '.specs')
  const state = join(source, 'graph', 'run', 'state.json')
  mkdirSync(dirname(state), { recursive: true })
  writeFileSync(state, 'antes')
  const plan = planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: f.env, lang: 'en' })
  const result = applyInstall(plan, { onProgress: event => { if (event.kind === 'workspace' && event.name === 'race') writeFileSync(state, 'durante') } })
  const group = result.groups.find(item => item.name === 'workspace:race')
  assert.equal(group.status, 'conflict')
  assert.equal(readFileSync(state, 'utf8'), 'durante')
  assert.equal(existsSync(join(f.home, '.local', 'share', 'prumo', 'race', '.specs')), false)
})

test('aplicação restaura uma relocação já aplicada quando uma alteração posterior falha', t => {
  const home = temporary('prumo-install-relocation-rollback-')
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const sourceRoot = join(home, 'legacy')
  const source = join(sourceRoot, '.specs')
  const destinationRoot = join(home, 'current')
  const destination = join(destinationRoot, '.specs')
  const state = join(source, 'state.json')
  mkdirSync(source, { recursive: true })
  writeFileSync(state, 'estado original')
  const bytes = readFileSync(state)
  const fileHash = createHash('sha256').update(bytes).digest('hex')
  const stamp = createHash('sha256').update('state.json\0').update(`file\0${bytes.length}\0`).update(fileHash).digest('hex')
  const result = applyInstall({
    home,
    allowedRoots: [home],
    groups: [{
      name: 'workspace:rollback', snapshots: [], conflicts: [], cleanup: [],
      relocation: { source, destination, stamp, workspaceSource: sourceRoot, workspaceDestination: destinationRoot, preserveSource: false },
      changes: [{ file: join(destination, 'after-relocation.txt'), before: Buffer.from('valor esperado'), after: Buffer.from('novo valor') }],
    }],
  })
  assert.equal(result.groups[0].status, 'conflict')
  assert.equal(readFileSync(state, 'utf8'), 'estado original')
  assert.equal(existsSync(destination), false)
})

test('aplicação restaura relocação quando a cópia encontra entrada especial Unix', async t => {
  if (process.platform === 'win32') return t.skip('socket Unix não existe como entrada de diretório no Windows')
  const home = temporary('ps-')
  const sourceRoot = join(home, 's')
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const source = join(sourceRoot, '.specs')
  const destination = join(home, 'current', '.specs')
  mkdirSync(source, { recursive: true })
  const socket = join(source, 'x')
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  const stamp = createHash('sha256').digest('hex')
  const result = applyInstall({
    home,
    allowedRoots: [home],
    groups: [{ name: 'workspace:socket', snapshots: [], changes: [], conflicts: [], cleanup: [],
      relocation: { source, destination, stamp, workspaceSource: sourceRoot, workspaceDestination: dirname(destination), preserveSource: false } }],
  })
  await new Promise(resolve => server.close(resolve))
  assert.equal(result.groups[0].status, 'conflict')
  assert.equal(existsSync(source), true)
})

test('restore valida limites do manifesto e recupera arquivos e links íntegros', t => {
  const f = fixture(t, 'prumo-install-manifest-boundaries-')
  const makeBackup = (name, extra = {}) => {
    const directory = join(dirname(f.backup), name)
    mkdirSync(directory, { recursive: true })
    const manifest = { product: 'prumo', version: '2.3.2', home: f.home, allowedRoots: [f.home], relocations: [], files: [], ...extra }
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return directory
  }
  const rejectManifest = (name, extra, pattern) => assert.throws(() => restoreInstall(makeBackup(name, extra), { home: f.home, env: f.env }), pattern)

  assert.throws(() => restoreInstall(join(f.home, '.local', 'share', 'prumo', 'backups'), { home: f.home, env: f.env }), /Choose a Prumo backup/)
  rejectManifest('manifest-product', { product: 'outro' }, /Invalid Prumo backup/)
  const noRoots = makeBackup('manifest-no-roots', { allowedRoots: undefined })
  assert.equal(restoreInstall(noRoots, { home: f.home, env: f.env }), 0)
  rejectManifest('manifest-relative-root', { allowedRoots: ['relativo'] }, /Invalid Prumo backup/)
  const noRelocations = makeBackup('manifest-no-relocations', { relocations: null })
  assert.equal(restoreInstall(noRelocations, { home: f.home, env: f.env }), 0)
  rejectManifest('manifest-object-relocations', { relocations: {} }, /Invalid Prumo backup/)
  rejectManifest('manifest-invalid-relocation', { relocations: [{}] }, /Invalid Prumo workspace backup/)

  const outsideBackup = makeBackup('manifest-outside-relocation', { relocations: [{ source: f.home, destination: f.home, backup: '../fora', preserveSource: false, applied: true }] })
  assert.throws(() => restoreInstall(outsideBackup, { home: f.home, env: f.env }), /Invalid Prumo workspace backup/)

  const pendingSource = join(f.home, 'pending-source')
  const pendingDestination = join(f.home, 'pending-destination')
  const pending = makeBackup('manifest-pending-relocation', { relocations: [{ source: pendingSource, destination: pendingDestination, backup: 'relocations/0', preserveSource: false }] })
  mkdirSync(join(pending, 'relocations', '0'), { recursive: true })
  mkdirSync(pendingDestination, { recursive: true })
  writeFileSync(join(pending, 'relocations', '0', 'state.txt'), 'estado pendente')
  writeFileSync(join(pendingDestination, 'state.txt'), 'estado pendente')
  assert.equal(restoreInstall(pending, { home: f.home, env: f.env }), 1)
  assert.equal(readFileSync(join(pendingSource, 'state.txt'), 'utf8'), 'estado pendente')

  const notAppliedSource = join(f.home, 'not-applied-source')
  const notApplied = makeBackup('manifest-not-applied', { relocations: [{ source: notAppliedSource, destination: join(f.home, 'not-applied-destination'), backup: 'relocations/0', preserveSource: false, applied: false }] })
  assert.equal(restoreInstall(notApplied, { home: f.home, env: f.env }), 0)

  const mismatch = makeBackup('manifest-mismatch-relocation', { relocations: [{ source: join(f.home, 'mismatch-source'), destination: join(f.home, 'mismatch-destination'), backup: 'relocations/0', preserveSource: false, applied: true }] })
  mkdirSync(join(mismatch, 'relocations', '0'), { recursive: true })
  mkdirSync(join(f.home, 'mismatch-destination'), { recursive: true })
  writeFileSync(join(mismatch, 'relocations', '0', 'state.txt'), 'backup')
  writeFileSync(join(f.home, 'mismatch-destination', 'state.txt'), 'alterado')
  assert.throws(() => restoreInstall(mismatch, { home: f.home, env: f.env }), /Workspace changed since this backup/)

  const missingDestination = makeBackup('manifest-missing-relocation-file', { relocations: [{ source: join(f.home, 'missing-source'), destination: join(f.home, 'missing-destination'), backup: 'relocations/0', preserveSource: false, applied: true }] })
  mkdirSync(join(missingDestination, 'relocations', '0'), { recursive: true })
  mkdirSync(join(f.home, 'missing-destination'), { recursive: true })
  writeFileSync(join(missingDestination, 'relocations', '0', 'state.txt'), 'backup')
  assert.throws(() => restoreInstall(missingDestination, { home: f.home, env: f.env }), /Workspace changed since this backup/)

  const nonEmptySource = join(f.home, 'nonempty-source')
  const nonEmpty = makeBackup('manifest-nonempty-source', { relocations: [{ source: nonEmptySource, destination: join(f.home, 'nonempty-destination'), backup: 'relocations/0', preserveSource: false, applied: true }] })
  mkdirSync(join(nonEmpty, 'relocations', '0'), { recursive: true })
  mkdirSync(join(f.home, 'nonempty-destination'), { recursive: true })
  mkdirSync(nonEmptySource, { recursive: true })
  writeFileSync(join(nonEmpty, 'relocations', '0', 'state.txt'), 'backup')
  writeFileSync(join(f.home, 'nonempty-destination', 'state.txt'), 'backup')
  writeFileSync(join(nonEmptySource, 'live.txt'), 'ainda vivo')
  assert.throws(() => restoreInstall(nonEmpty, { home: f.home, env: f.env }), /Legacy workspace is no longer empty/)

  rejectManifest('manifest-invalid-link', { files: [{ file: join(f.home, 'link.txt'), link: 'socket', original: null, beforeHash: null, afterHash: null, applied: true }] }, /Invalid backup link type/)
  const absent = makeBackup('manifest-absent-file', { files: [{ file: join(f.home, 'absent.txt'), original: null, beforeHash: null, afterHash: 'unused', applied: false }] })
  assert.equal(restoreInstall(absent, { home: f.home, env: f.env }), 0)

  const integrity = makeBackup('manifest-integrity', { files: [{ file: join(f.home, 'after.txt'), original: 'files/0', beforeHash: digest(Buffer.from('before')), afterHash: digest(Buffer.from('after')), applied: true }] })
  mkdirSync(join(integrity, 'files'), { recursive: true })
  writeFileSync(join(integrity, 'files', '0'), 'wrong backup')
  writeFileSync(join(f.home, 'after.txt'), 'after')
  assert.throws(() => restoreInstall(integrity, { home: f.home, env: f.env }), /Backup integrity check failed/)

  const oldTarget = join(f.home, 'old-target-dir')
  const newTarget = join(f.home, 'new-target-dir')
  const linkFile = join(f.home, 'managed-link')
  mkdirSync(oldTarget, { recursive: true })
  mkdirSync(newTarget, { recursive: true })
  writeFileSync(join(oldTarget, 'preservar.txt'), 'dados antigos')
  writeFileSync(join(newTarget, 'preservar.txt'), 'dados atuais')
  const linkType = 'junction'
  symlinkSync(newTarget, linkFile, linkType)
  const linkBytes = Buffer.from(readlinkSync(linkFile).replace(/^\\\\\?\\/, ''))
  const oldBytes = Buffer.from(oldTarget)
  const linked = makeBackup('manifest-linked-file', { files: [{ file: linkFile, link: linkType, original: 'files/0', beforeHash: digest(oldBytes), afterHash: digest(linkBytes), applied: true }] })
  mkdirSync(join(linked, 'files'), { recursive: true })
  writeFileSync(join(linked, 'files', '0'), oldBytes)
  assert.equal(restoreInstall(linked, { home: f.home, env: f.env }), 1)
  assert.equal(realpathSync(linkFile), realpathSync(oldTarget))
  assert.equal(readFileSync(join(oldTarget, 'preservar.txt'), 'utf8'), 'dados antigos')
  assert.equal(readFileSync(join(newTarget, 'preservar.txt'), 'utf8'), 'dados atuais')
})

test('restore substitui link de arquivo quando o sistema permite e preserva os alvos', t => {
  const f = fixture(t, 'prumo-install-file-link-')
  const oldTarget = join(f.home, 'old-target.txt')
  const newTarget = join(f.home, 'new-target.txt')
  const linkFile = join(f.home, 'managed-file-link')
  writeFileSync(oldTarget, 'dados antigos')
  writeFileSync(newTarget, 'dados atuais')
  try { symlinkSync(newTarget, linkFile, 'file') } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error.code)) return t.skip('link de arquivo exige privilégio habilitado no Windows')
    throw error
  }
  const linked = join(dirname(f.backup), 'manifest-file-link')
  mkdirSync(join(linked, 'files'), { recursive: true })
  writeFileSync(join(linked, 'manifest.json'), JSON.stringify({
    product: 'prumo', version: '2.3.2', home: f.home, allowedRoots: [f.home], relocations: [],
    files: [{ file: linkFile, link: 'file', original: 'files/0', beforeHash: digest(Buffer.from(oldTarget)), afterHash: digest(Buffer.from(readlinkSync(linkFile).replace(/^\\\\\?\\/, ''))), applied: true }],
  }, null, 2))
  writeFileSync(join(linked, 'files', '0'), oldTarget)

  assert.equal(restoreInstall(linked, { home: f.home, env: f.env }), 1)
  assert.equal(realpathSync(linkFile), realpathSync(oldTarget))
  assert.equal(readFileSync(oldTarget, 'utf8'), 'dados antigos')
  assert.equal(readFileSync(newTarget, 'utf8'), 'dados atuais')
})

test('aplicação restaura link anterior quando uma limpeza posterior falha sem tocar os alvos', t => {
  const home = temporary('prumo-install-link-rollback-')
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const originalTarget = join(home, 'original-target')
  const replacementTarget = join(home, 'replacement-target')
  const linkFile = join(home, 'managed-link')
  const cleanup = join(home, 'legacy')
  mkdirSync(originalTarget, { recursive: true })
  mkdirSync(replacementTarget, { recursive: true })
  writeFileSync(join(originalTarget, 'dados.txt'), 'original')
  writeFileSync(join(replacementTarget, 'dados.txt'), 'substituto')
  mkdirSync(cleanup, { recursive: true })
  writeFileSync(join(cleanup, 'mudanca.txt'), 'não descartar')
  const linkType = 'junction'
  symlinkSync(originalTarget, linkFile, linkType)
  const result = applyInstall({
    home,
    allowedRoots: [home],
    groups: [{
      name: 'link-rollback', snapshots: [], conflicts: [],
      changes: [{ file: linkFile, link: linkType, before: Buffer.from(originalTarget), after: Buffer.from(replacementTarget) }],
      cleanup: [{ path: cleanup, discard: true, originalEntries: [] }],
    }],
  })

  assert.equal(result.groups[0].status, 'conflict')
  assert.match(result.groups[0].errors.join('\n'), /Legacy workspace changed during installation/)
  assert.equal(realpathSync(linkFile), realpathSync(originalTarget))
  assert.equal(readFileSync(join(originalTarget, 'dados.txt'), 'utf8'), 'original')
  assert.equal(readFileSync(join(replacementTarget, 'dados.txt'), 'utf8'), 'substituto')
  assert.equal(readFileSync(join(cleanup, 'mudanca.txt'), 'utf8'), 'não descartar')
})

test('aplicação recupera link anterior quando a renomeação temporária falha', t => {
  const home = temporary('prumo-install-link-rename-failure-')
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const originalTarget = join(home, 'original-target')
  const replacementTarget = join(home, 'replacement-target')
  const linkFile = join(home, 'managed-link')
  mkdirSync(originalTarget, { recursive: true })
  mkdirSync(replacementTarget, { recursive: true })
  writeFileSync(join(originalTarget, 'dados.txt'), 'original')
  writeFileSync(join(replacementTarget, 'dados.txt'), 'substituto')
  const linkType = 'junction'
  symlinkSync(originalTarget, linkFile, linkType)
  const originalRename = nodeFs.renameSync
  let renameAttempted = false
  nodeFs.renameSync = (from, to, ...options) => {
    if (resolve(to) === resolve(linkFile) && String(from).includes('.prumo-')) {
      renameAttempted = true
      const error = new Error('falha simulada de renomeação')
      error.code = 'EACCES'
      throw error
    }
    return originalRename(from, to, ...options)
  }
  syncBuiltinESMExports()
  let result
  try {
    result = applyInstall({
      home,
      allowedRoots: [home],
      groups: [{ name: 'link-rename-failure', snapshots: [], conflicts: [], cleanup: [],
        changes: [{ file: linkFile, link: linkType, before: Buffer.from(originalTarget), after: Buffer.from(replacementTarget) }] }],
    })
  } finally {
    nodeFs.renameSync = originalRename
    syncBuiltinESMExports()
  }

  assert.equal(renameAttempted, true, 'a contraprova precisa falhar na renomeação do link temporário')
  assert.equal(result.groups[0].status, 'conflict')
  assert.match(result.groups[0].errors.join('\n'), /falha simulada de renomeação/)
  assert.equal(realpathSync(linkFile), realpathSync(originalTarget))
  assert.equal(readFileSync(join(originalTarget, 'dados.txt'), 'utf8'), 'original')
  assert.equal(readFileSync(join(replacementTarget, 'dados.txt'), 'utf8'), 'substituto')
})

test('falhas secundárias na troca de link preservam diagnóstico original e dados dos alvos', t => {
  for (const scenario of ['changed', 'restore', 'cleanup']) {
    const home = temporary('prumo-install-link-secondary-')
    t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    const before = join(home, 'original'), after = join(home, 'replacement'), file = join(home, 'managed-link')
    for (const path of [before, after]) { mkdirSync(path); writeFileSync(join(path, 'dados.txt'), path) }
    const type = 'junction'
    symlinkSync(before, file, type)
    const rename = nodeFs.renameSync, link = nodeFs.symlinkSync, unlink = nodeFs.unlinkSync
    nodeFs.renameSync = (from, to, ...args) => {
      if (resolve(to) === resolve(file) && String(from).includes('.prumo-')) {
        if (scenario === 'changed') writeFileSync(file, 'arquivo concorrente')
        throw new Error('falha primária de renomeação')
      }
      return rename(from, to, ...args)
    }
    nodeFs.symlinkSync = (target, destination, ...args) => {
      if (scenario === 'restore' && resolve(destination) === resolve(file)) throw new Error('falha secundária de restauração')
      return link(target, destination, ...args)
    }
    nodeFs.unlinkSync = (target, ...args) => {
      if (scenario === 'cleanup' && String(target).startsWith(`${file}.prumo-`)) throw new Error('falha secundária de limpeza')
      return unlink(target, ...args)
    }
    syncBuiltinESMExports()
    let result
    try {
      result = applyInstall({ home, allowedRoots: [home], groups: [{ name: 'secondary-link-failure', snapshots: [],
        conflicts: [], cleanup: [], changes: [{ file, link: type, before: Buffer.from(before), after: Buffer.from(after) }] }] })
    } finally {
      nodeFs.renameSync = rename; nodeFs.symlinkSync = link; nodeFs.unlinkSync = unlink
      syncBuiltinESMExports()
    }
    const errors = result.groups[0].errors.join('\n')
    assert.equal(result.groups[0].status, 'conflict')
    assert.match(errors, /falha primária de renomeação/)
    if (scenario === 'changed') { assert.match(errors, /manual recovery required/); assert.equal(readFileSync(file, 'utf8'), 'arquivo concorrente') }
    if (scenario === 'restore') assert.match(errors, /Previous link could not be restored: falha secundária de restauração/)
    if (scenario === 'cleanup') { assert.match(errors, /Temporary link cleanup failed: falha secundária de limpeza/); assert.equal(realpathSync(file), realpathSync(before)) }
    for (const path of [before, after]) assert.equal(readFileSync(join(path, 'dados.txt'), 'utf8'), path)
  }
})

test('idioma instalado desconhecido não é inferido de conteúdo arbitrário', t => {
  const f = fixture(t, 'prumo-install-language-boundary-', false)
  const file = join(f.config, 'output-styles', 'po-first.md')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'instruções sem bloco de idioma')
  assert.equal(installedPoFirstLanguage('claude', f.config), undefined)
})

test('planInstall valida harness, alvo ausente, settings e limites de idioma', t => {
  const f = fixture(t, 'prumo-install-plan-boundaries-', false)
  assert.throws(() => planInstall({ harness: 'inexistente', home: f.home, cwd: f.cwd, env: f.env }), /Choose exactly one/)
  assert.equal(installedPoFirstLanguage('inexistente', f.config), undefined)
  assert.equal(installedPoFirstLanguage('claude', null), undefined)

  const emptyHome = temporary('prumo-install-no-target-')
  const emptyProject = join(emptyHome, 'project')
  mkdirSync(join(emptyProject, '.git'), { recursive: true })
  t.after(() => rmSync(emptyHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  assert.throws(() => planInstall({ harness: 'claude', home: emptyHome, cwd: emptyProject, env: {}, skillRoots: [] }), /No Prumo installations found/)

  writeFileSync(f.settings, '[]')
  const invalidSettings = planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: f.env, lang: 'en' })
  assert.match(invalidSettings.groups.find(group => group.name === 'po-first:claude').conflicts.join('\n'), /Expected a settings object/)
  const localSettings = join(f.cwd, '.claude', 'settings.json')
  mkdirSync(dirname(localSettings), { recursive: true })
  writeFileSync(localSettings, '{quebrado')
  const localPlan = planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: f.env, lang: 'en' })
  assert.ok(localPlan.warnings.some(warning => warning.includes('Unreadable local settings')))

  const override = join(f.config, 'AGENTS.override.md')
  mkdirSync(f.config, { recursive: true })
  writeFileSync(override, '')
  assert.equal(installedPoFirstLanguage('codex', f.config), undefined)
  const agents = join(f.config, 'AGENTS.md')
  writeFileSync(agents, 'texto sem marcadores')
  assert.equal(installedPoFirstLanguage('codex', f.config), undefined)
  const noOverride = join(f.home, 'codex-no-override')
  mkdirSync(noOverride, { recursive: true })
  assert.equal(installedPoFirstLanguage('codex', noOverride), undefined)
  const activeOverride = join(f.home, 'codex-active-override')
  mkdirSync(activeOverride, { recursive: true })
  writeFileSync(join(activeOverride, 'AGENTS.override.md'), '<!-- po-first:start -->\n## Text delivered with the product\n<!-- po-first:end -->')
  assert.equal(installedPoFirstLanguage('codex', activeOverride), 'en')
  const unreadable = join(f.config, 'output-styles', 'po-first.md')
  mkdirSync(unreadable, { recursive: true })
  assert.equal(installedPoFirstLanguage('claude', f.config), undefined)
})

test('applyInstall cobre alterações nulas, prévia e tipos de arquivo inconsistentes', t => {
  const home = temporary('prumo-install-change-boundaries-')
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const existing = join(home, 'existing.txt')
  writeFileSync(existing, 'antes')
  const preview = applyInstall({
    home, allowedRoots: [home],
    groups: [{ name: 'preview-conflict', snapshots: [], changes: [], cleanup: [], conflicts: ['conflito'] }],
  }, { dryRun: true })
  assert.equal(preview.groups[0].status, 'conflict')

  const result = applyInstall({
    home, allowedRoots: [home],
    groups: [{ name: 'changes', snapshots: [], cleanup: [], conflicts: [], changes: [
      { file: existing, before: Buffer.from('antes'), after: null },
      { file: join(home, 'new.txt'), before: null, after: Buffer.from('novo') },
    ] }],
  })
  assert.equal(result.groups[0].status, 'installed')
  assert.equal(existsSync(existing), false)
  assert.equal(readFileSync(join(home, 'new.txt'), 'utf8'), 'novo')

  const linkTarget = join(home, 'new-link-target')
  const newLink = join(home, 'new-link')
  mkdirSync(linkTarget, { recursive: true })
  writeFileSync(join(linkTarget, 'dados.txt'), 'não tocar')
  const linkType = 'junction'
  const linkResult = applyInstall({
    home, allowedRoots: [home],
    groups: [{ name: 'new-link', snapshots: [], cleanup: [], conflicts: [], changes: [{ file: newLink, before: null, after: Buffer.from(linkTarget), link: linkType }] }],
  })
  assert.equal(linkResult.groups[0].status, 'installed')
  assert.equal(realpathSync(newLink), realpathSync(linkTarget))
  assert.equal(readFileSync(join(linkTarget, 'dados.txt'), 'utf8'), 'não tocar')

  const mismatch = join(home, 'mismatch.txt')
  writeFileSync(mismatch, 'regular')
  const mismatchResult = applyInstall({
    home, allowedRoots: [home],
    groups: [{ name: 'link-type', snapshots: [], cleanup: [], conflicts: [], changes: [{ file: mismatch, before: Buffer.from('regular'), after: Buffer.from('novo'), link: 'file' }] }],
  })
  assert.equal(mismatchResult.groups[0].status, 'conflict')
  assert.match(mismatchResult.groups[0].errors.join('\n'), /File type changed during installation/)

  const invalidRelocation = applyInstall({
    home, allowedRoots: [home],
    groups: [{ name: 'invalid-relocation', snapshots: [], changes: [], cleanup: [], conflicts: [],
      relocation: { source: join(home, 'missing-source'), destination: join(home, 'missing-destination'), stamp: 'stamp', workspaceSource: home, workspaceDestination: home, preserveSource: false } }],
  })
  assert.equal(invalidRelocation.groups[0].status, 'conflict')
  assert.match(invalidRelocation.groups[0].errors.join('\n'), /Workspace changed during installation/)

  const source = join(home, 'source')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'state.txt'), 'estado')
  const destination = join(home, 'destination')
  mkdirSync(destination, { recursive: true })
  const destinationExists = applyInstall({
    home, allowedRoots: [home],
    groups: [{ name: 'relocation-destination-exists', snapshots: [], changes: [], cleanup: [], conflicts: [],
      relocation: { source, destination, stamp: 'qualquer', workspaceSource: home, workspaceDestination: home, preserveSource: false } }],
  })
  assert.equal(destinationExists.groups[0].status, 'conflict')
  rmSync(destination, { recursive: true, force: true })
  const stampMismatch = applyInstall({
    home, allowedRoots: [home],
    groups: [{ name: 'relocation-stamp-mismatch', snapshots: [], changes: [], cleanup: [], conflicts: [],
      relocation: { source, destination, stamp: 'incorreto', workspaceSource: home, workspaceDestination: home, preserveSource: false } }],
  })
  assert.equal(stampMismatch.groups[0].status, 'conflict')
})

test('planInstall mantém namespaces separados e ignora entradas legadas incompletas', t => {
  const f = fixture(t, 'prumo-install-namespace-boundaries-', false)
  const marker = join(f.config, 'skills', 'prumo', '.prumo-install.json')
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ product: 'prumo', version: '1.3.16', harness: 'claude', lang: 'en' }))

  const nested = { ...f.env, PRUMO_HOME: join(f.home, 'store', 'prumo'), GRAPH_FOREMAN_HOME: join(f.home, 'store') }
  assert.throws(() => planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: nested, lang: 'en' }), /cannot contain each other/)

  const legacyHome = join(f.home, '.local', 'share', 'graph-foreman')
  mkdirSync(legacyHome, { recursive: true })
  writeFileSync(join(legacyHome, 'entry.txt'), 'entrada')
  mkdirSync(join(legacyHome, 'sem-grafo'), { recursive: true })
  const ignored = planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: f.env, lang: 'en' })
  assert.equal(ignored.groups.some(group => group.name.startsWith('workspace:')), false)

  const sourceRoot = join(legacyHome, 'empty')
  const destinationRoot = join(f.home, 'data', 'empty')
  mkdirSync(join(sourceRoot, '.specs', 'graph'), { recursive: true })
  mkdirSync(join(destinationRoot, '.specs', 'graph'), { recursive: true })
  const unchanged = planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: f.env, lang: 'en' })
  assert.equal(unchanged.groups.find(group => group.name === 'workspace:empty')?.relocation, undefined)
  assert.equal(unchanged.data.some(item => item.action === 'migrate' && item.source === sourceRoot), false)

  const executionRoot = join(legacyHome, 'unsafe')
  mkdirSync(join(executionRoot, '.specs', 'graph'), { recursive: true })
  mkdirSync(join(executionRoot, 'attempt'), { recursive: true })
  writeFileSync(join(executionRoot, 'attempt', 'generated.txt'), 'não migrar')
  symlinkSync(join('..', '..', 'attempt'), join(executionRoot, '.specs', 'graph', 'execution-link'), process.platform === 'win32' ? 'junction' : 'dir')
  try { symlinkSync(join('..', '..', 'attempt', 'generated.txt'), join(executionRoot, '.specs', 'graph', 'file-link'), 'file') } catch (error) {
    if (process.platform !== 'win32') throw error
  }
  const unsafe = planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: f.env, lang: 'en' })
  assert.match(unsafe.groups.find(group => group.name === 'workspace:unsafe').conflicts.join('\n'), /Legacy graph references execution data/)

  const rootLink = join(executionRoot, '.specs', 'graph', 'root-link')
  symlinkSync(join('..', '..'), rootLink, process.platform === 'win32' ? 'junction' : 'dir')
  const rootLinkPlan = planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: f.env, lang: 'en' })
  assert.ok(rootLinkPlan.groups.some(group => group.name === 'workspace:unsafe'))

  writeFileSync(marker, JSON.stringify({ product: 'graph-foreman', version: '1.3.16', harness: 'claude', lang: 'en' }))
  const invalidMarker = planInstall({ harness: 'claude', home: f.home, cwd: f.cwd, env: f.env, lang: 'en' })
  assert.equal(invalidMarker.data.some(item => item.source === sourceRoot), false)
})

test('planInstall reporta agentes Kiro inválidos e recursos sem correspondência', t => {
  const home = temporary('prumo-install-kiro-boundaries-')
  const cwd = join(home, 'project')
  const config = join(home, '.kiro')
  const skills = join(config, 'skills')
  const marker = join(skills, 'prumo', '.prumo-install.json')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ product: 'prumo', version: '1.3.16', harness: 'kiro', lang: 'en' }))
  const env = { HOME: home, USERPROFILE: home, KIRO_HOME: config, PRUMO_HOME: join(home, 'data'), PRUMO_LANG: 'en' }
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  writeFileSync(join(config, 'agents'), 'não é pasta')
  const unreadableAgents = planInstall({ harness: 'kiro', home, cwd, env, lang: 'en' })
  assert.ok(unreadableAgents.warnings.some(warning => /ENOTDIR|not a directory|directory/i.test(warning)))

  rmSync(join(config, 'agents'), { force: true })
  mkdirSync(join(config, 'agents'), { recursive: true })
  writeFileSync(join(config, 'agents', 'guide.md'), 'recurso manual')
  writeFileSync(join(config, 'agents', 'invalid.json'), JSON.stringify({ resources: {} }))
  writeFileSync(join(config, 'agents', 'unmatched.json'), JSON.stringify({ resources: [{}] }))
  const agents = planInstall({ harness: 'kiro', home, cwd, env, lang: 'en' })
  assert.ok(agents.warnings.some(warning => warning.includes('Verify default resource inheritance')))
  assert.match(agents.groups.find(group => group.name.endsWith('invalid.json')).conflicts.join('\n'), /Expected a resources array/)
  assert.equal(agents.groups.find(group => group.name.endsWith('unmatched.json')).conflicts.length, 0)

  writeFileSync(join(config, 'agents', 'wildcards.json'), JSON.stringify({ resources: ['skill://**/prumo/**', 'file://*'] }))
  const wildcardAgents = planInstall({ harness: 'kiro', home, cwd, env, lang: 'en' })
  assert.equal(wildcardAgents.groups.find(group => group.name.endsWith('wildcards.json')).conflicts.length, 0)
})
