import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { ensureGlobalCliContent, globalCliContentCurrent, globalCliState, launchUpdate, npmLatestVersion, updateGlobalCli, updateGlobalCliFromPackage } from '../lib/update.mjs'
import { packageDistributionFiles } from '../scripts/package-content.mjs'
import { stopDashboardForUpdate } from '../lib/autostart.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version
const nodeFs = createRequire(import.meta.url)('node:fs')

function temporary(prefix) {
  return mkdtempSync(join(resolve(tmpdir()), prefix))
}

function child(code, stderr = '') {
  const process = new EventEmitter()
  process.stderr = new EventEmitter()
  queueMicrotask(() => {
    if (stderr) process.stderr.emit('data', Buffer.from(stderr))
    process.emit('exit', code, null)
    process.emit('close', code, null)
  })
  return process
}

function copyDistributedPackage(source, destination) {
  for (const name of packageDistributionFiles(source)) {
    const target = join(destination, name)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(source, name), target)
  }
}

function copyPackageForTest(source, destination) {
  copyDistributedPackage(source, destination)
  const baseline = join(source, 'scripts', 'release-baseline.json')
  if (existsSync(baseline)) {
    mkdirSync(join(destination, 'scripts'), { recursive: true })
    copyFileSync(baseline, join(destination, 'scripts', 'release-baseline.json'))
  }
}

function simulatedNpmRoot(f, options) {
  return options.env.npm_config_prefix === f.env.npm_config_prefix
    ? f.globalRoot
    : join(options.env.npm_config_prefix, process.platform === 'win32' ? 'node_modules' : 'lib', 'node_modules')
}

function fixture(t, prefix = 'prumo-update-hardening-') {
  const home = temporary(prefix)
  const external = temporary('prumo-update-external-')
  const globalRoot = join(home, 'global', 'lib', 'node_modules')
  const target = join(globalRoot, '@henri-ralmeida', 'prumo')
  const temporaryRoot = join(home, 'temporary-root')
  mkdirSync(target, { recursive: true })
  mkdirSync(temporaryRoot, { recursive: true })
  writeFileSync(join(target, 'old-package.txt'), 'versão anterior')
  const env = { ...process.env, npm_config_prefix: join(home, 'npm-prefix'), npm_config_cache: join(home, 'npm-cache') }
  const calls = []
  const runSync = (command, args, options) => {
    calls.push({ kind: 'sync', command, args, options })
    return { status: 0, stdout: globalRoot, stderr: '' }
  }
  t.after(() => {
    assert.ok(home.startsWith(join(resolve(tmpdir()), prefix)))
    assert.ok(external.startsWith(join(resolve(tmpdir()), 'prumo-update-external-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(external, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  return { home, external, globalRoot, target, temporaryRoot, env, calls, runSync }
}

test('update recusa pacote global ligado antes de executar npm', async t => {
  const f = fixture(t)
  writeFileSync(join(f.external, 'old-package.txt'), 'fora do pacote')
  rmSync(f.target, { recursive: true, force: true })
  symlinkSync(f.external, f.target, process.platform === 'win32' ? 'junction' : 'dir')

  await assert.rejects(updateGlobalCliFromPackage(repository, {
    env: f.env,
    temporaryRoot: f.temporaryRoot,
    runSync: f.runSync,
    run: () => { throw new Error('npm não deveria ser executado') },
  }), /Global Prumo CLI package path is linked/)
  assert.equal(f.calls.length, 1, 'a verificação do caminho deve ocorrer antes do npm')
  assert.equal(readFileSync(join(f.external, 'old-package.txt'), 'utf8'), 'fora do pacote')
  assert.deepEqual(readdirSync(f.temporaryRoot), [])
})

test('versões array são recusadas antes de executar npm ou alterar pacote global', async t => {
  const f = fixture(t, 'prumo-update-version-type-'), source = join(f.home, 'source')
  copyPackageForTest(repository, source)
  const metadataPath = join(source, 'package.json'), metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  let invoked = false
  const forbidden = () => { invoked = true; throw new Error('npm não deve executar') }
  for (const version of [[metadata.version], [[metadata.version]]]) {
    await assert.rejects(updateGlobalCli(version, { run: forbidden }), /Invalid Prumo version/)
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, version }))
    const before = readFileSync(metadataPath, 'utf8')
    await assert.rejects(updateGlobalCliFromPackage(source, { run: forbidden, runSync: forbidden, temporaryRoot: f.temporaryRoot }), /Invalid local Prumo CLI package/)
    assert.equal(readFileSync(metadataPath, 'utf8'), before)
  }
  assert.equal(invoked, false)
  assert.equal(readFileSync(join(f.target, 'old-package.txt'), 'utf8'), 'versão anterior')
  assert.deepEqual(readdirSync(f.temporaryRoot), [])
})

test('falha ao empacotar preserva o pacote global e limpa a área temporária', async t => {
  const f = fixture(t, 'prumo-update-pack-failure-')
  const run = (command, args, options) => {
    f.calls.push({ kind: 'npm', command, args, options })
    return child(1, 'falha simulada no empacotamento')
  }

  await assert.rejects(updateGlobalCliFromPackage(repository, {
    env: f.env,
    temporaryRoot: f.temporaryRoot,
    runSync: f.runSync,
    run,
  }), /Unable to pack the local Prumo CLI package/)
  assert.equal(readFileSync(join(f.target, 'old-package.txt'), 'utf8'), 'versão anterior')
  assert.deepEqual(readdirSync(f.temporaryRoot), [])
  assert.equal(f.calls.filter(call => call.kind === 'npm').length, 1)
})

test('falha na validação isolada preserva o pacote anterior e não inicia a troca global', async t => {
  const f = fixture(t, 'prumo-update-validation-failure-')
  const run = (command, args, options) => {
    f.calls.push({ kind: 'npm', command, args, options })
    if (args.includes('pack')) {
      writeFileSync(join(options.cwd, 'prumo.tgz'), 'arquivo de pacote')
      return child(0)
    }
    return child(1, 'falha simulada na validação isolada')
  }

  await assert.rejects(updateGlobalCliFromPackage(repository, {
    env: f.env,
    temporaryRoot: f.temporaryRoot,
    runSync: f.runSync,
    run,
  }), /Unable to validate the local Prumo CLI package in an isolated installation/)
  assert.equal(readFileSync(join(f.target, 'old-package.txt'), 'utf8'), 'versão anterior')
  assert.deepEqual(readdirSync(f.temporaryRoot), [])
  assert.deepEqual(f.calls.filter(call => call.kind === 'npm').map(call => call.args.includes('pack') ? 'pack' : 'install'), ['pack', 'install'])
})

test('verificação global falha com árvore regular e restaura todos os bytes anteriores', async t => {
  const f = fixture(t, 'prumo-update-rollback-')
  mkdirSync(join(f.target, 'nested'), { recursive: true })
  writeFileSync(join(f.target, 'nested', 'old.txt'), 'dado anterior')
  const previous = {
    old: readFileSync(join(f.target, 'old-package.txt')),
    nested: readFileSync(join(f.target, 'nested', 'old.txt')),
  }
  const npmCalls = []
  const runSync = (command, args, options) => {
    f.calls.push({ kind: 'sync', command, args, options })
    const prefix = options.env.npm_config_prefix
    const root = prefix === f.env.npm_config_prefix
      ? f.globalRoot
      : join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib', 'node_modules')
    return { status: 0, stdout: root, stderr: '' }
  }
  const run = (command, args, options) => {
    npmCalls.push({ command, args, options })
    f.calls.push({ kind: 'npm', command, args, options })
    if (args.includes('pack')) {
      writeFileSync(join(options.cwd, 'prumo.tgz'), 'arquivo de pacote')
      return child(0)
    }

    const prefix = options.env.npm_config_prefix
    const root = prefix === f.env.npm_config_prefix
      ? f.globalRoot
      : join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib', 'node_modules')
    const destination = join(root, '@henri-ralmeida', 'prumo')
    rmSync(destination, { recursive: true, force: true })
    copyDistributedPackage(repository, destination)
    if (prefix === f.env.npm_config_prefix) writeFileSync(join(destination, 'bin', 'prumo.mjs'), 'conteúdo adulterado')
    return child(0)
  }

  await assert.rejects(updateGlobalCliFromPackage(repository, {
    env: f.env,
    temporaryRoot: f.temporaryRoot,
    runSync,
    run,
  }), /Global Prumo CLI package verification failed after installation/)

  assert.deepEqual({
    old: readFileSync(join(f.target, 'old-package.txt')),
    nested: readFileSync(join(f.target, 'nested', 'old.txt')),
  }, previous)
  assert.deepEqual(npmCalls.map(call => call.args.includes('pack') ? 'empacotar' : call.options.env.npm_config_prefix === f.env.npm_config_prefix ? 'global' : 'isolado'), ['empacotar', 'isolado', 'global'])
  assert.deepEqual(readdirSync(f.temporaryRoot), [])
})

test('runner npm propaga saída não zero, interrupção e erro síncrono', async t => {
  await assert.rejects(updateGlobalCli('versão inválida', { env: {}, run: () => { throw new Error('não deveria iniciar') } }), /Invalid Prumo version/)
  const failing = new EventEmitter()
  failing.stderr = new EventEmitter()
  const failed = updateGlobalCli('2.3.2', {
    platform: 'linux',
    env: {},
    run: () => {
      queueMicrotask(() => {
        failing.stderr.emit('data', Buffer.from('falha de transporte'))
        failing.emit('exit', 2, null)
      })
      return failing
    },
  })
  assert.equal(await failed, 2)

  const noCode = new EventEmitter()
  noCode.stderr = new EventEmitter()
  const fallbackCode = updateGlobalCli('2.3.2', {
    platform: 'linux', env: {},
    run: () => { queueMicrotask(() => noCode.emit('exit', null, null)); return noCode },
  })
  assert.equal(await fallbackCode, 1)

  const interrupted = new EventEmitter()
  interrupted.stderr = new EventEmitter()
  await assert.rejects(updateGlobalCli('2.3.2', {
    platform: 'linux', env: {},
    run: () => { queueMicrotask(() => interrupted.emit('exit', null, 'SIGTERM')); return interrupted },
  }), /interrupted/)

  const f = fixture(t, 'prumo-update-runner-')
  await assert.rejects(updateGlobalCliFromPackage(repository, {
    env: f.env,
    temporaryRoot: f.temporaryRoot,
    runSync: f.runSync,
    run: () => { throw new Error('runner síncrono indisponível') },
  }), /runner síncrono indisponível/)

  const childSignal = new EventEmitter()
  childSignal.stderr = new EventEmitter()
  await assert.rejects(updateGlobalCliFromPackage(repository, {
    env: f.env,
    temporaryRoot: f.temporaryRoot,
    runSync: f.runSync,
    run: (_command, args, options) => {
      if (args.includes('pack')) writeFileSync(join(options.cwd, 'prumo.tgz'), 'arquivo de pacote')
      queueMicrotask(() => childSignal.emit('exit', null, 'SIGTERM'))
      return childSignal
    },
  }), /interrupted/)

  const childNoCode = new EventEmitter()
  childNoCode.stderr = new EventEmitter()
  await assert.rejects(updateGlobalCliFromPackage(repository, {
    env: f.env,
    temporaryRoot: f.temporaryRoot,
    runSync: f.runSync,
    run: (_command, args, options) => {
      if (args.includes('pack')) writeFileSync(join(options.cwd, 'prumo.tgz'), 'arquivo de pacote')
      queueMicrotask(() => childNoCode.emit('exit', null, null))
      return childNoCode
    },
  }), /Unable to pack the local Prumo CLI package/)
})

test('estado global e identidade recusam resultados incompletos sem inventar versão', async t => {
  const f = fixture(t, 'prumo-update-state-boundary-')
  const target = f.target
  assert.deepEqual(globalCliState(repository, { run: () => ({ status: 1, stdout: '' }) }), { running: false, version: null, packageRoot: null })
  assert.deepEqual(globalCliState(target, {
    run: () => ({ status: 0, stdout: f.globalRoot }),
    read: () => { throw new Error('package ausente') },
  }), { running: true, version: null, packageRoot: null })
  assert.deepEqual(globalCliState(target, {
    run: () => ({ status: 0, stdout: f.globalRoot }),
    read: () => '{}',
  }), { running: true, version: null, packageRoot: null })

  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'outro-pacote', version: '2.3.2' }))
  assert.equal(globalCliContentCurrent(repository, target), false)
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@henri-ralmeida/prumo', version: '0.0.1' }))
  assert.equal(globalCliContentCurrent(repository, target), false)
  writeFileSync(join(target, 'package.json'), '{quebrado')
  assert.equal(globalCliContentCurrent(repository, target), false)
  assert.equal(globalCliContentCurrent(null, target), false)

  await assert.rejects(updateGlobalCliFromPackage(repository, {
    env: f.env,
    temporaryRoot: f.temporaryRoot,
    runSync: () => ({ status: 1, stdout: '' }),
    run: () => { throw new Error('npm não deveria iniciar') },
  }), /Unable to verify the global Prumo CLI installation path/)
})

test('preflight rejeita metadados, baseline e diretório global não gerenciado', async t => {
  const f = fixture(t, 'prumo-update-preflight-')
  rmSync(f.target, { recursive: true, force: true })
  writeFileSync(f.target, 'arquivo no lugar do pacote')
  await assert.rejects(updateGlobalCliFromPackage(repository, {
    env: f.env, temporaryRoot: f.temporaryRoot, runSync: f.runSync,
    run: () => { throw new Error('npm não deveria iniciar') },
  }), /is not a managed directory/)
  rmSync(f.target, { recursive: true, force: true })
  mkdirSync(f.target, { recursive: true })
  writeFileSync(join(f.target, 'old-package.txt'), 'versão anterior')

  const invalid = temporary('prumo-update-invalid-source-')
  const baseline = temporary('prumo-update-invalid-baseline-')
  t.after(() => {
    rmSync(invalid, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(baseline, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  copyPackageForTest(repository, invalid)
  writeFileSync(join(invalid, 'package.json'), JSON.stringify({ name: '@henri-ralmeida/prumo', version: 'sem-versão' }))
  await assert.rejects(updateGlobalCliFromPackage(invalid, { env: f.env, temporaryRoot: f.temporaryRoot, runSync: f.runSync, run: () => { throw new Error('npm não deveria iniciar') } }), /Invalid local Prumo CLI package/)

  copyPackageForTest(repository, baseline)
  rmSync(join(baseline, 'scripts', 'release-baseline.json'), { force: true })
  mkdirSync(join(baseline, 'scripts', 'release-baseline.json'))
  await assert.rejects(updateGlobalCliFromPackage(baseline, { env: f.env, temporaryRoot: f.temporaryRoot, runSync: f.runSync, run: () => { throw new Error('npm não deveria iniciar') } }), /Release baseline is linked or not a regular file/)

  const linkedTree = fixture(t, 'prumo-update-linked-tree-')
  symlinkSync(linkedTree.external, join(linkedTree.target, 'linked-entry'), process.platform === 'win32' ? 'junction' : 'dir')
  const linkedRunSync = (_command, _args, options) => ({ status: 0, stdout: simulatedNpmRoot(linkedTree, options), stderr: '' })
  const linkedRun = (_command, args, options) => {
    if (args.includes('pack')) {
      writeFileSync(join(options.cwd, 'prumo.tgz'), 'arquivo de pacote')
      return child(0)
    }
    copyDistributedPackage(repository, join(simulatedNpmRoot(linkedTree, options), '@henri-ralmeida', 'prumo'))
    return child(0)
  }
  await assert.rejects(updateGlobalCliFromPackage(repository, { env: linkedTree.env, temporaryRoot: linkedTree.temporaryRoot, runSync: linkedRunSync, run: linkedRun }), /Package tree contains a linked path/)

  const linkedSource = join(linkedTree.external, 'linked-source')
  symlinkSync(repository, linkedSource, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(updateGlobalCliFromPackage(linkedSource, { env: linkedTree.env, temporaryRoot: linkedTree.temporaryRoot, runSync: linkedTree.runSync, run: () => { throw new Error('npm não deveria iniciar') } }), /Local Prumo CLI package path is linked/)

  if (process.platform !== 'win32') {
    const special = fixture(t, 'prumo-update-special-tree-')
    const socket = join(special.target, 'special-entry')
    const server = createServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
    const specialSync = (_command, _args, options) => ({ status: 0, stdout: simulatedNpmRoot(special, options), stderr: '' })
    const specialRun = (_command, args, options) => {
      if (args.includes('pack')) {
        writeFileSync(join(options.cwd, 'prumo.tgz'), 'arquivo de pacote')
        return child(0)
      }
      copyDistributedPackage(repository, join(simulatedNpmRoot(special, options), '@henri-ralmeida', 'prumo'))
      return child(0)
    }
    await assert.rejects(updateGlobalCliFromPackage(repository, { env: special.env, temporaryRoot: special.temporaryRoot, runSync: specialSync, run: specialRun }), /Package tree contains an invalid path/)
    await new Promise(resolve => server.close(resolve))
  }
})

test('empacotamento ambíguo e instalação global rejeitada preservam o pacote anterior', async t => {
  const ambiguous = fixture(t, 'prumo-update-ambiguous-')
  const ambiguousRun = (_command, args, options) => {
    if (args.includes('pack')) {
      writeFileSync(join(options.cwd, 'um.tgz'), 'um')
      writeFileSync(join(options.cwd, 'dois.tgz'), 'dois')
      return child(0)
    }
    return child(0)
  }
  await assert.rejects(updateGlobalCliFromPackage(repository, { env: ambiguous.env, temporaryRoot: ambiguous.temporaryRoot, runSync: ambiguous.runSync, run: ambiguousRun }), /archive is missing, unsafe or ambiguous/)
  assert.equal(readFileSync(join(ambiguous.target, 'old-package.txt'), 'utf8'), 'versão anterior')

  const failed = fixture(t, 'prumo-update-global-failure-')
  const runSync = (_command, _args, options) => ({ status: 0, stdout: simulatedNpmRoot(failed, options), stderr: '' })
  const run = (_command, args, options) => {
    if (args.includes('pack')) {
      writeFileSync(join(options.cwd, 'prumo.tgz'), 'arquivo de pacote')
      return child(0)
    }
    const destination = join(simulatedNpmRoot(failed, options), '@henri-ralmeida', 'prumo')
    rmSync(destination, { recursive: true, force: true })
    if (options.env.npm_config_prefix !== failed.env.npm_config_prefix) copyDistributedPackage(repository, destination)
    return options.env.npm_config_prefix === failed.env.npm_config_prefix ? child(1, 'falha global') : child(0)
  }
  await assert.rejects(updateGlobalCliFromPackage(repository, { env: failed.env, temporaryRoot: failed.temporaryRoot, runSync, run }), /Unable to install the local Prumo CLI package globally/)
  assert.equal(readFileSync(join(failed.target, 'old-package.txt'), 'utf8'), 'versão anterior')

  const changed = fixture(t, 'prumo-update-target-changed-')
  let stateReads = 0
  const changedSync = (_command, _args, options) => {
    stateReads++
    const root = simulatedNpmRoot(changed, options)
    if (stateReads === 2) {
      rmSync(changed.target, { recursive: true, force: true })
      writeFileSync(changed.target, 'alvo trocado')
    }
    return { status: 0, stdout: root, stderr: '' }
  }
  const changedRun = (_command, args, options) => {
    if (args.includes('pack')) {
      writeFileSync(join(options.cwd, 'prumo.tgz'), 'arquivo de pacote')
      return child(0)
    }
    const destination = join(simulatedNpmRoot(changed, options), '@henri-ralmeida', 'prumo')
    rmSync(destination, { recursive: true, force: true })
    copyDistributedPackage(repository, destination)
    return child(0)
  }
  await assert.rejects(updateGlobalCliFromPackage(repository, { env: changed.env, temporaryRoot: changed.temporaryRoot, runSync: changedSync, run: changedRun }), /not a managed package directory/)
})

test('rollback denuncia quando o alvo global vira um link durante a instalação', async t => {
  const f = fixture(t, 'prumo-update-rollback-link-')
  const external = join(f.external, 'foreign-package')
  mkdirSync(external, { recursive: true })
  writeFileSync(join(external, 'foreign.txt'), 'processo alheio')
  const runSync = (_command, _args, options) => ({ status: 0, stdout: simulatedNpmRoot(f, options), stderr: '' })
  const run = (_command, args, options) => {
    if (args.includes('pack')) {
      writeFileSync(join(options.cwd, 'prumo.tgz'), 'arquivo de pacote')
      return child(0)
    }
    const destination = join(simulatedNpmRoot(f, options), '@henri-ralmeida', 'prumo')
    rmSync(destination, { recursive: true, force: true })
    if (options.env.npm_config_prefix !== f.env.npm_config_prefix) copyDistributedPackage(repository, destination)
    else symlinkSync(external, destination, process.platform === 'win32' ? 'junction' : 'dir')
    return child(0)
  }
  await assert.rejects(updateGlobalCliFromPackage(repository, { env: f.env, temporaryRoot: f.temporaryRoot, runSync, run }), /rollback could not restore/)
  assert.equal(readFileSync(join(external, 'foreign.txt'), 'utf8'), 'processo alheio')
})

test('update sem pacote global falha antes de declarar conteúdo atualizado', async t => {
  assert.equal(await launchUpdate({ cwd: repository, projects: [], updateCli: false }, { discover: () => [] }), null)
  const sourceWithoutGlobal = new EventEmitter()
  sourceWithoutGlobal.stderr = new EventEmitter()
  assert.equal(await launchUpdate({ cwd: repository, projects: [], updateCli: true, sourceVersion: packageVersion }, {
    discover: () => [], latestVersion: () => packageVersion,
    run: () => { queueMicrotask(() => sourceWithoutGlobal.emit('close', 0, null)); return sourceWithoutGlobal },
  }), 0)
  await assert.rejects(ensureGlobalCliContent(repository, { packageRoot: null }), /unavailable after installation/)
  const childProcess = new EventEmitter()
  childProcess.stderr = new EventEmitter()
  await assert.rejects(launchUpdate({ cwd: repository, projects: [], updateCli: true }, {
    discover: () => [],
    run: () => { queueMicrotask(() => childProcess.emit('close', null, 'SIGTERM')); return childProcess },
  }), /interrupted/)

  const noCode = new EventEmitter()
  noCode.stderr = new EventEmitter()
  assert.equal(await launchUpdate({ cwd: repository, projects: [], updateCli: true }, {
    discover: () => [],
    run: () => { queueMicrotask(() => noCode.emit('close', null, null)); return noCode },
  }), 1)

  const dashboard = mkdtempSync(join(resolve(tmpdir()), 'prumo-update-dashboard-process-'))
  const root = join(dashboard, 'skills')
  mkdirSync(join(root, 'prumo'), { recursive: true })
  writeFileSync(join(root, 'prumo', '.prumo-install.json'), JSON.stringify({ product: 'prumo', harness: 'claude', version: packageVersion }))
  try {
    await assert.rejects(launchUpdate({ cwd: dashboard, projects: [], updateCli: true, sourceVersion: packageVersion, globalVersion: packageVersion }, {
      discover: () => [{ harness: 'claude', roots: [root] }],
      latestVersion: () => packageVersion, filesCurrent: () => true,
      status: async () => ({ enabled: true, process: 'stopped', registered: true, version: packageVersion }),
      repair: async () => ({ ok: false, process: 'dead' }),
    }), /Dashboard restart failed: dead/)
  } finally {
    rmSync(dashboard, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('primeira instalação global remove pacote parcial após falha sem inventar backup anterior', async t => {
  const f = fixture(t, 'prumo-update-first-install-')
  rmSync(f.target, { recursive: true, force: true })
  const witness = join(f.globalRoot, 'pacote-alheio.txt')
  writeFileSync(witness, 'preservado')
  const runSync = (_command, _args, options) => ({ status: 0, stdout: simulatedNpmRoot(f, options), stderr: '' })
  const run = (_command, args, options) => {
    if (args.includes('pack')) {
      writeFileSync(join(options.cwd, 'prumo.tgz'), 'arquivo de pacote')
      return child(0)
    }
    const destination = join(simulatedNpmRoot(f, options), '@henri-ralmeida', 'prumo')
    copyDistributedPackage(repository, destination)
    if (options.env.npm_config_prefix === f.env.npm_config_prefix) {
      writeFileSync(join(destination, 'bin', 'prumo.mjs'), 'pacote incompleto')
    }
    return child(0)
  }
  await assert.rejects(updateGlobalCliFromPackage(repository, {
    env: f.env, temporaryRoot: f.temporaryRoot, runSync, run,
  }), /Global Prumo CLI package verification failed/)
  assert.equal(existsSync(f.target), false, 'sem versão anterior o rollback devolve o alvo ao estado ausente')
  assert.equal(readFileSync(witness, 'utf8'), 'preservado')
  assert.deepEqual(readdirSync(f.temporaryRoot), [])
})

test('parada para atualização aceita pacote histórico sem exigir arquivos da candidata', async t => {
  const f = fixture(t, 'prumo-update-historical-stop-')
  const packageRoot = join(f.home, 'old-package')
  copyDistributedPackage(repository, packageRoot)
  rmSync(join(packageRoot, 'scripts', 'contract-drift.mjs'))
  const script = join(packageRoot, 'scripts', 'serve.mjs')
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@henri-ralmeida/prumo', version: '1.3.2' }))
  mkdirSync(join(f.home, '.local', 'share', 'prumo'), { recursive: true })
  writeFileSync(join(f.home, '.local', 'share', 'prumo', 'dashboard.json'), JSON.stringify({
    enabled: true, mechanism: 'xdg', node: process.execPath, script,
  }))
  let running = true
  const killed = []
  const options = { packageRoot, home: f.home, platform: 'linux', env: {},
    listProcessIds: () => [76543],
    readProcessCommand: () => [process.execPath, script, '--global', '--port', '4949'],
    kill: pid => { killed.push(pid); running = false },
    fetch: async url => {
      if (!running) throw new Error('encerrado')
      return { ok: true, json: async () => String(url).endsWith('/api/about')
        ? { product: 'prumo', version: '1.3.2' }
        : { product: 'prumo', version: '1.3.2', mode: 'global', readOnly: true } }
    },
    portAvailable: async () => !running,
    delay: async () => {}, readinessAttempts: 2,
  }
  assert.equal(existsSync(join(packageRoot, 'scripts', 'contract-drift.mjs')), false)
  const foreign = await stopDashboardForUpdate({ ...options,
    readProcessCommand: () => [process.execPath, join(f.external, 'serve.mjs'), '--global', '--port', '4949'],
  })
  assert.equal(foreign.ok, false)
  assert.match(foreign.error, /ownership verification failed/)
  assert.deepEqual(killed, [], 'a ausência dos arquivos novos não autoriza encerrar um processo alheio')
  assert.deepEqual(await stopDashboardForUpdate(options), { ok: true, stopped: true })
  assert.deepEqual(killed, [76543], 'somente o processo com executável e comando comprovados pode ser encerrado')
})

test('npm sem diagnóstico e árvore de tipo desconhecido falham antes da troca global', async t => {
  assert.throws(() => npmLatestVersion({ run: () => ({ status: 1, stdout: '', stderr: '' }) }), /Unable to read npm latest version/)
  const f = fixture(t, 'prumo-update-special-entry-')
  const special = join(f.target, 'old-package.txt')
  const lstat = nodeFs.lstatSync
  nodeFs.lstatSync = (path, ...args) => resolve(path) === resolve(special)
    ? { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false }
    : lstat(path, ...args)
  syncBuiltinESMExports()
  let installed = 0
  const run = (_command, args, options) => {
    if (args.includes('pack')) { writeFileSync(join(options.cwd, 'prumo.tgz'), 'pacote'); return child(0) }
    installed++
    copyDistributedPackage(repository, join(simulatedNpmRoot(f, options), '@henri-ralmeida', 'prumo'))
    return child(0)
  }
  try {
    await assert.rejects(updateGlobalCliFromPackage(repository, { env: f.env, temporaryRoot: f.temporaryRoot, run,
      runSync: (_command, _args, options) => ({ status: 0, stdout: simulatedNpmRoot(f, options), stderr: '' }),
    }), /Package tree contains an invalid path/)
  } finally { nodeFs.lstatSync = lstat; syncBuiltinESMExports() }
  assert.equal(installed, 1, 'a instalação isolada pode validar o pacote, mas o alvo desconhecido não pode ser substituído')
  assert.equal(readFileSync(special, 'utf8'), 'versão anterior')
  assert.deepEqual(readdirSync(f.temporaryRoot), [])
})

test('refresh detecta alteração concorrente após verificar o pacote sem sobrescrever o novo conteúdo', async t => {
  const f = fixture(t, 'prumo-update-concurrent-refresh-')
  const engine = join(f.target, 'scripts', 'engine.mjs')
  const read = nodeFs.readFileSync
  let reads = 0
  nodeFs.readFileSync = (path, ...args) => {
    if (resolve(path) === resolve(engine) && ++reads === 4) {
      writeFileSync(engine, read(engine, 'utf8') + '\n// alteração concorrente preservada\n')
    }
    return read(path, ...args)
  }
  syncBuiltinESMExports()
  const run = (_command, args, options) => {
    if (args.includes('pack')) { writeFileSync(join(options.cwd, 'prumo.tgz'), 'pacote'); return child(0) }
    const destination = join(simulatedNpmRoot(f, options), '@henri-ralmeida', 'prumo')
    rmSync(destination, { recursive: true, force: true })
    copyDistributedPackage(repository, destination)
    return child(0)
  }
  try {
    await assert.rejects(ensureGlobalCliContent(repository, { packageRoot: f.target }, 'en', {
      env: f.env, temporaryRoot: f.temporaryRoot, run,
      runSync: (_command, _args, options) => ({ status: 0, stdout: simulatedNpmRoot(f, options), stderr: '' }),
    }), /Global Prumo CLI content still differs after installation/)
  } finally { nodeFs.readFileSync = read; syncBuiltinESMExports() }
  assert.equal(reads, 4, 'a contraprova altera o arquivo somente na leitura posterior à verificação da atualização')
  assert.match(readFileSync(engine, 'utf8'), /alteração concorrente preservada/)
  assert.deepEqual(readdirSync(f.temporaryRoot), [])
})
