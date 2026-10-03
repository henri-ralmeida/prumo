import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { applyInstall, dashboardPackageRoot, detectHarnesses, inspectInstallation, installationFilesCurrent, planInstall, readInstallationMarker, reconcileDashboardInstall, restoreInstall } from '../lib/install.mjs'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('..', import.meta.url))
function temporary(t) {
  const base = fs.realpathSync(tmpdir()), home = fs.mkdtempSync(join(base, 'prumo-install-public-boundary-'))
  t.after(() => { assert.equal(dirname(home), base); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return home
}

test('planejamento na raiz e em subdiretórios respeita destinos temporários e fronteira .git', t => {
  const home = temporary(t), config = join(home, '.claude'), skills = join(config, 'skills')
  const outer = join(home, 'outside'), project = join(outer, 'project'), cwd = join(project, 'src', 'nested')
  for (const directory of [cwd, join(project, '.git'), join(project, '.specs', 'graph'), join(outer, '.specs', 'graph')]) fs.mkdirSync(directory, { recursive: true })
  const options = { harness: 'claude', home, configRoot: config, skillRoots: [skills],
    env: { PRUMO_HOME: join(home, 'data'), GRAPH_FOREMAN_HOME: join(home, 'legacy-data') }, lang: 'en' }
  const nested = planInstall({ ...options, cwd })
  assert.ok(nested.data.some(entry => entry.root === project))
  assert.equal(nested.data.some(entry => entry.root === outer), false, 'o projeto mais próximo impede descoberta de dados do pai')
  const root = planInstall({ ...options, cwd: parse(home).root })
  for (const plan of [nested, root]) for (const target of [...plan.allowedRoots, ...plan.groups.flatMap(group => group.changes.map(change => change.file))]) {
    const child = relative(home, target)
    assert.ok(!isAbsolute(child) && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`), target)
  }
  assert.equal(fs.existsSync(config), false, 'planejar não cria arquivos na raiz real nem nos destinos temporários')
})

test('instalação incompleta conserva ausência de identidade e não confirma arquivos ligados', t => {
  const home = temporary(t), root = join(home, 'skills'), external = join(home, 'external')
  fs.mkdirSync(root); fs.mkdirSync(external)
  const marker = { product: 'prumo', harness: 'claude', version: '1.3.16', lang: 'inválido' }
  const report = inspectInstallation(root, marker)
  assert.equal(report.lang, 'en')
  assert.equal(report.contentId, null)
  fs.symlinkSync(external, join(root, 'prumo'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(installationFilesCurrent(root, marker), false)
  assert.deepEqual(fs.readdirSync(external), [])
})

test('dashboard recusa pacote parcial e utiliza somente pacote global comprovado', async t => {
  const home = temporary(t)
  assert.equal(dashboardPackageRoot(undefined, repository), resolve(repository))
  assert.throws(() => dashboardPackageRoot(repository, undefined), /Global Prumo CLI package is unavailable/)
  assert.throws(() => dashboardPackageRoot(repository, home), /content is incomplete/)
  let inspected
  const result = await reconcileDashboardInstall(1, { sourcePackageRoot: repository, dashboardOptions: { packageRoot: repository },
    status: async options => { inspected = options; return { disabled: true } } })
  assert.equal(result.action, 'disabled')
  assert.equal(inspected.packageRoot, resolve(repository))
})

test('blocos PO First duplicados são consolidados e marcadores invertidos preservam o texto', t => {
  const home = temporary(t), config = join(home, '.codex'), instructions = join(config, 'AGENTS.md')
  fs.mkdirSync(config)
  const block = '<!-- po-first:start -->\nantigo\n<!-- po-first:end -->'
  fs.writeFileSync(instructions, `prefixo\n${block}\n${block}\nsufixo\n`)
  const options = { harness: 'codex', home, cwd: home, env: { CODEX_HOME: config }, lang: 'en' }
  const planned = planInstall(options)
  const change = planned.groups.flatMap(group => group.changes).find(item => item.file === instructions)
  assert.equal(change.after.toString().split('<!-- po-first:start -->').length - 1, 1)
  assert.match(change.after.toString(), /prefixo[\s\S]*sufixo/)
  const invalid = '<!-- po-first:end -->\n<!-- po-first:start -->'
  fs.writeFileSync(instructions, invalid)
  assert.ok(planInstall(options).groups.some(group => group.conflicts.some(message => message.includes('Malformed PO First block'))))
  assert.equal(fs.readFileSync(instructions, 'utf8'), invalid)
  const dsh = planInstall({ harness: 'dsh', home, cwd: home, env: { DSH_HOME: '~' }, lang: 'en' })
  assert.ok(dsh.groups.flatMap(group => group.changes).some(item => item.file === join(home, 'AGENTS.md')))
})

test('marcador inválido não é recuperado por backups ilegíveis ou de outra instalação', t => {
  const home = temporary(t), root = join(home, 'skills'), marker = join(root, 'prumo', '.prumo-install.json')
  const data = join(home, '.local/share/prumo')
  fs.mkdirSync(dirname(marker), { recursive: true }); fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(marker, '{inválido')
  fs.writeFileSync(join(data, 'installations.json'), JSON.stringify([{ harness: 'claude', config: join(home, '.claude'), roots: [root], projects: [] }]))
  const read = () => readInstallationMarker(root, { home, harness: 'claude' })
  assert.throws(read)
  for (const [name, value] of [['broken', '{inválido'], ['other-home', { product: 'prumo', home: join(home, 'other'), files: [] }], ['bad-files', { product: 'prumo', home, files: {} }]]) {
    const folder = join(data, 'backups', name)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(join(folder, 'manifest.json'), typeof value === 'string' ? value : JSON.stringify(value))
  }
  assert.throws(read)
  assert.equal(fs.readFileSync(marker, 'utf8'), '{inválido')
})

test('metadados malformados e diretórios com nome de executável não autorizam instalação existente', t => {
  const home = temporary(t), root = join(home, 'skills'), marker = join(root, 'prumo/.prumo-install.json')
  fs.mkdirSync(dirname(marker), { recursive: true })
  for (const value of [null, { product: 'outro', harness: 'claude', version: '1.3.16' }, { product: 'prumo', harness: 'desconhecido', version: '1.3.16' }, { product: 'prumo', harness: 'claude', version: 7 }, { product: 'prumo', harness: 'claude', version: 'inválida' },
    { product: 'prumo', harness: 'claude', version: ['1.3.16'] }, { product: 'prumo', harness: 'claude', version: [['1.3.16']] }]) {
    const content = JSON.stringify(value)
    fs.writeFileSync(marker, content)
    assert.throws(() => readInstallationMarker(root, { home, harness: 'claude' }))
    assert.equal(fs.readFileSync(marker, 'utf8'), content)
  }
  fs.mkdirSync(join(home, process.platform === 'win32' ? 'claude.CMD' : 'claude'))
  assert.deepEqual(detectHarnesses({ home, cwd: home, env: { PATH: home, PATHEXT: '.CMD' } }), [])
})

test('backup com versão array não autoriza recuperação nem migração e backup íntegro string recupera metadados', t => {
  const home = temporary(t), root = join(home, '.claude/skills'), marker = join(root, 'prumo/.prumo-install.json'), data = join(home, '.local/share/prumo')
  fs.mkdirSync(dirname(marker), { recursive: true }); fs.mkdirSync(data, { recursive: true })
  const malformed = JSON.stringify({ product: 'prumo', harness: 'claude', version: ['1.3.16'] })
  fs.writeFileSync(marker, malformed)
  fs.writeFileSync(join(data, 'installations.json'), JSON.stringify([{ harness: 'claude', config: join(home, '.claude'), roots: [root], projects: [] }]))
  const save = (name, version) => {
    const folder = join(data, 'backups', name), bytes = Buffer.from(JSON.stringify({ product: 'prumo', harness: 'claude', version }))
    fs.mkdirSync(join(folder, 'files'), { recursive: true }); fs.writeFileSync(join(folder, 'files/0'), bytes)
    fs.writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ product: 'prumo', home, files: [{ file: marker, original: 'files/0', beforeHash: createHash('sha256').update(bytes).digest('hex') }] }))
  }
  save('array', [['1.3.16']])
  assert.throws(() => readInstallationMarker(root, { home, harness: 'claude' }))
  const legacy = join(home, 'legacy/run/.specs/graph/run/state.json')
  fs.mkdirSync(dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, 'estado da outra ferramenta')
  const plan = planInstall({ harness: 'claude', home, cwd: home, env: { GRAPH_FOREMAN_HOME: join(home, 'legacy'), PRUMO_HOME: join(home, 'current') }, lang: 'en' })
  assert.equal(plan.data.some(entry => entry.action === 'migrate'), false)
  save('valid', '1.3.16')
  const recovered = readInstallationMarker(root, { home, harness: 'claude' })
  assert.equal(recovered.version, '1.3.16')
  assert.equal(typeof recovered.version, 'string')
  assert.equal(fs.readFileSync(marker, 'utf8'), malformed)
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'estado da outra ferramenta')
})

test('links sem alvo preservam origem e recusam cópia incompatível com o sistema', t => {
  const home = temporary(t), snapshot = join(home, 'snapshot'), source = join(snapshot, 'state.txt'), missing = join(home, 'missing'), link = join(snapshot, 'dangling')
  fs.mkdirSync(snapshot); fs.writeFileSync(source, 'estado original')
  fs.symlinkSync(missing, link, process.platform === 'win32' ? 'junction' : 'dir')
  const target = join(home, 'configuration.txt')
  fs.writeFileSync(target, 'configuração original')
  const result = applyInstall({ home, allowedRoots: [home], groups: [{ name: 'snapshot', snapshots: [snapshot], conflicts: [], cleanup: [],
    changes: [{ file: target, before: Buffer.from('configuração original'), after: Buffer.from('nova configuração') }] }] })
  assert.equal(fs.readFileSync(source, 'utf8'), 'estado original')
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
  if (result.groups[0].status === 'conflict') assert.equal(fs.readFileSync(target, 'utf8'), 'configuração original')
  else assert.equal(fs.readFileSync(target, 'utf8'), 'nova configuração')
})

test('migração identifica link externo sem alvo e recusa link para dados de execução', t => {
  const home = temporary(t), root = join(home, '.claude/skills'), source = join(home, 'legacy/run'), destination = join(home, 'data/run')
  fs.mkdirSync(join(root, 'prumo'), { recursive: true }); fs.writeFileSync(join(root, 'prumo/.prumo-install.json'), JSON.stringify({ product: 'prumo', harness: 'claude', version: '1.3.16' }))
  const state = join(source, '.specs/graph/run/state.json')
  fs.mkdirSync(dirname(state), { recursive: true }); fs.writeFileSync(state, 'estado original')
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  const options = { harness: 'claude', home, cwd: home, env: { GRAPH_FOREMAN_HOME: join(home, 'legacy'), PRUMO_HOME: join(home, 'data') }, lang: 'en' }
  fs.symlinkSync(join(home, 'missing'), join(source, 'external'), type)
  const external = planInstall(options).groups.find(group => group.name === 'workspace:run')
  assert.ok(external.changes.some(change => change.file === join(destination, 'external') && change.link === 'file'))
  fs.symlinkSync(join(home, 'missing'), join(source, '.specs/external-ref'), type)
  const safe = planInstall(options), workspace = safe.groups.find(group => group.name === 'workspace:run')
  const applied = applyInstall({ ...safe, groups: [workspace] })
  assert.equal(fs.readFileSync(state, 'utf8'), 'estado original')
  if (applied.groups[0].status === 'installed') assert.equal(fs.readFileSync(join(destination, '.specs/graph/run/state.json'), 'utf8'), 'estado original')
  else assert.equal(fs.existsSync(join(destination, '.specs')), false)
  fs.symlinkSync(source, join(source, 'root-link'), type)
  const rootLink = planInstall(options).groups.find(group => group.name === 'workspace:run')
  assert.ok(rootLink.changes.some(change => change.file === join(destination, 'root-link') && change.after.toString() === destination))
  fs.mkdirSync(join(source, 'attempt')); fs.writeFileSync(join(source, 'attempt/generated.txt'), 'execução atual')
  fs.symlinkSync(join(source, 'attempt'), join(source, 'unsafe'), type)
  assert.match(planInstall(options).groups.find(group => group.name === 'workspace:run').conflicts.join('\n'), /references execution data/)
  fs.unlinkSync(join(source, 'unsafe'))
  fs.symlinkSync(join(source, 'missing'), join(source, '.specs/dangling-internal'), type)
  assert.match(planInstall(options).groups.find(group => group.name === 'workspace:run').conflicts.join('\n'), /references execution data/)
  assert.equal(fs.readFileSync(state, 'utf8'), 'estado original')
  assert.equal(fs.readFileSync(join(source, 'attempt/generated.txt'), 'utf8'), 'execução atual')
})

test('plano alterado durante callback não remove o segundo workspace', t => {
  const home = temporary(t)
  const groups = ['first', 'second'].map(name => {
    const sourceRoot = join(home, name), source = join(sourceRoot, '.specs'), destinationRoot = join(home, `new-${name}`), destination = join(destinationRoot, '.specs'), bytes = Buffer.from(name)
    fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(join(source, 'state.json'), bytes)
    const stamp = createHash('sha256').update('state.json\0').update(`file\0${bytes.length}\0`).update(createHash('sha256').update(bytes).digest('hex')).digest('hex')
    return { name: `workspace:${name}`, snapshots: [], conflicts: [], changes: [], cleanup: [], relocation: { source, destination, stamp, workspaceSource: sourceRoot, workspaceDestination: destinationRoot, preserveSource: true } }
  })
  const result = applyInstall({ home, allowedRoots: [home], groups }, { onProgress: () => { groups[1].name = 'workspace:changed' } })
  assert.equal(result.groups[0].status, 'installed')
  assert.equal(result.groups[1].status, 'conflict')
  assert.match(result.groups[1].errors.join('\n'), /Workspace changed during installation/)
  assert.equal(fs.readFileSync(join(home, 'second/.specs/state.json'), 'utf8'), 'second')
  assert.equal(fs.existsSync(join(home, 'new-second/.specs')), false)
})

test('espaço de dados já compartilhado conserva histórico em vez de planejar migração duplicada', t => {
  const home = temporary(t), root = join(home, '.claude/skills'), data = join(home, 'shared'), workspace = join(data, 'run')
  fs.mkdirSync(join(root, 'prumo'), { recursive: true })
  fs.writeFileSync(join(root, 'prumo/.prumo-install.json'), JSON.stringify({ product: 'prumo', harness: 'claude', version: '1.3.16' }))
  const state = join(workspace, '.specs/graph/run/state.json')
  fs.mkdirSync(dirname(state), { recursive: true }); fs.writeFileSync(state, 'histórico compartilhado')
  const plan = planInstall({ harness: 'claude', home, cwd: home, env: { PRUMO_HOME: data, GRAPH_FOREMAN_HOME: data }, lang: 'en' })
  assert.ok(plan.data.some(entry => entry.root === workspace && entry.action === 'preserve-in-place'))
  assert.equal(plan.groups.some(group => group.name.startsWith('workspace:')), false)
  assert.equal(fs.readFileSync(state, 'utf8'), 'histórico compartilhado')
})

for (const scenario of ['cross-volume', 'copy-denied', 'backup-corrupt', 'source-backup-corrupt', 'source-backup-extra', 'source-backup-renamed', 'move-denied', 'saved-changed', 'destination-corrupt', 'source-changed', 'rollback-destination-changed']) {
  test(`relocação preserva dados e informa falha em ${scenario}`, t => {
    const base = fs.realpathSync(tmpdir()), home = fs.mkdtempSync(join(base, 'prumo-install-fault-boundary-'))
    t.after(() => {
      t.mock.restoreAll(); syncBuiltinESMExports()
      assert.equal(dirname(home), base)
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const sourceRoot = join(home, 'legacy'), source = join(sourceRoot, '.specs')
    const destinationRoot = join(home, 'current'), destination = join(destinationRoot, '.specs')
    const state = join(source, 'state.json'), bytes = Buffer.from('estado original')
    const late = join(home, 'late.txt')
    fs.writeFileSync(late, 'configuração original')
    fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(state, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const stamp = createHash('sha256').update('state.json\0').update(`file\0${bytes.length}\0`).update(digest).digest('hex')
    const rename = fs.renameSync, copy = fs.copyFileSync
    let injected = false
    t.mock.method(fs, 'renameSync', (from, to, ...args) => {
      if (resolve(to) === late && scenario === 'rollback-destination-changed') {
        injected = true; fs.writeFileSync(join(destination, 'state.json'), 'edição concorrente'); throw new Error('gravação posterior negada')
      }
      if (resolve(from) === source) {
        if (['cross-volume', 'copy-denied', 'backup-corrupt'].includes(scenario)) {
          injected = true
          throw Object.assign(new Error('volumes diferentes'), { code: 'EXDEV' })
        }
        if (scenario === 'move-denied') { injected = true; throw Object.assign(new Error('movimento negado'), { code: 'EACCES' }) }
        const result = rename(from, to, ...args)
        if (scenario === 'saved-changed') { injected = true; fs.writeFileSync(join(to, 'state.json'), 'edição concorrente') }
        return result
      }
      return rename(from, to, ...args)
    })
    t.mock.method(fs, 'copyFileSync', (from, to, ...args) => {
      if (resolve(from) === state && scenario === 'copy-denied') { injected = true; throw new Error('cópia negada') }
      const result = copy(from, to, ...args)
      if (resolve(from) === state && ['backup-corrupt', 'source-backup-corrupt'].includes(scenario)) { injected = true; fs.writeFileSync(to, 'backup incompleto') }
      if (resolve(from) === state && scenario === 'source-backup-extra') { injected = true; fs.writeFileSync(join(dirname(to), 'extra.txt'), 'entrada inesperada') }
      if (resolve(from) === state && scenario === 'source-backup-renamed') { injected = true; rename(to, join(dirname(to), 'renamed.txt')) }
      if (resolve(to) === join(destination, 'state.json')) {
        if (scenario === 'destination-corrupt') { injected = true; fs.writeFileSync(to, 'destino incompleto') }
        if (scenario === 'source-changed') { injected = true; fs.writeFileSync(state, 'edição concorrente') }
      }
      return result
    })
    syncBuiltinESMExports()
    const result = applyInstall({ home, allowedRoots: [home], groups: [{ name: 'workspace:fault', snapshots: [], conflicts: [],
      changes: scenario === 'rollback-destination-changed' ? [{ file: late, before: Buffer.from('configuração original'), after: Buffer.from('configuração nova') }] : [], cleanup: [],
      relocation: { source, destination, stamp, workspaceSource: sourceRoot, workspaceDestination: destinationRoot, preserveSource: ['source-changed', 'source-backup-corrupt', 'source-backup-extra', 'source-backup-renamed'].includes(scenario) } }] })
    assert.equal(injected, true, 'a contraprova precisa atingir a falha de armazenamento prevista')
    if (scenario === 'cross-volume') {
      assert.equal(result.groups[0].status, 'installed')
      assert.equal(fs.readFileSync(join(destination, 'state.json'), 'utf8'), bytes.toString())
      assert.equal(fs.existsSync(source), false)
    } else if (scenario === 'rollback-destination-changed') {
      assert.equal(result.groups[0].status, 'conflict')
      assert.match(result.groups[0].errors.join('\n'), /restore manually/)
      assert.equal(fs.readFileSync(join(destination, 'state.json'), 'utf8'), 'edição concorrente')
      assert.equal(fs.readFileSync(join(result.backup, 'relocations/0/state.json'), 'utf8'), bytes.toString())
      assert.equal(fs.readFileSync(late, 'utf8'), 'configuração original')
    } else {
      assert.equal(result.groups[0].status, 'conflict', JSON.stringify(result))
      assert.equal(fs.existsSync(destination), false)
      assert.equal(fs.readFileSync(state, 'utf8'), ['source-changed', 'saved-changed'].includes(scenario) ? 'edição concorrente' : bytes.toString())
      const messages = result.groups[0].errors.join('\n')
      assert.match(messages, /integrity|changed|negad/i)
    }
  })
}

test('falha ao verificar limpeza temporária pode ser recuperada pelo backup sem reverter dados de execução', t => {
  const home = temporary(t), file = join(home, 'configuration.txt'), state = join(home, 'state.json')
  fs.writeFileSync(file, 'antes'); fs.writeFileSync(state, 'execução atual')
  const lstat = fs.lstatSync
  let injected = false
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    if (String(path).startsWith(`${file}.prumo-`) && !fs.existsSync(path)) { injected = true; throw new Error('limpeza indisponível') }
    return lstat(path, ...args)
  })
  syncBuiltinESMExports()
  const result = applyInstall({ home, allowedRoots: [home], groups: [{ name: 'configuration', snapshots: [], conflicts: [], cleanup: [],
    changes: [{ file, before: Buffer.from('antes'), after: Buffer.from('depois') }] }] })
  t.mock.restoreAll(); syncBuiltinESMExports()
  assert.equal(injected, true)
  assert.equal(result.groups[0].status, 'conflict')
  assert.match(result.groups[0].errors.join('\n'), /limpeza indisponível/)
  assert.equal(restoreInstall(result.backup, { home }), 1)
  assert.equal(fs.readFileSync(file, 'utf8'), 'antes')
  assert.equal(fs.readFileSync(state, 'utf8'), 'execução atual')
})

for (const scenario of ['changed-target', 'changed-type']) test(`troca de link recusa corrida de ${scenario} sem substituir o alvo atual`, t => {
  const home = temporary(t), file = join(home, 'link'), before = join(home, 'before'), concurrent = join(home, 'concurrent'), regular = join(home, 'regular.txt')
  for (const directory of [before, concurrent]) { fs.mkdirSync(directory); fs.writeFileSync(join(directory, 'dados.txt'), directory) }
  fs.writeFileSync(regular, 'arquivo comum')
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  fs.symlinkSync(before, file, type)
  const symlink = fs.symlinkSync, lstat = fs.lstatSync
  let switched = false, injected = false
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  t.mock.method(fs, 'symlinkSync', (target, destination, ...args) => {
    const result = symlink(target, destination, ...args)
    if (String(destination).startsWith(`${file}.prumo-`)) {
      switched = true
      if (scenario === 'changed-target') { injected = true; fs.unlinkSync(file); symlink(concurrent, file, type) }
    }
    return result
  })
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    if (resolve(path) === file && scenario === 'changed-type' && switched && !injected) { injected = true; return lstat(regular, ...args) }
    return lstat(path, ...args)
  })
  syncBuiltinESMExports()
  const result = applyInstall({ home, allowedRoots: [home], groups: [{ name: 'link', snapshots: [], conflicts: [], cleanup: [],
    changes: [{ file, before: Buffer.from(before), after: Buffer.from(concurrent), link: type }] }] })
  assert.equal(injected, true)
  assert.equal(result.groups[0].status, 'conflict')
  assert.match(result.groups[0].errors.join('\n'), /changed|manual recovery/)
  assert.equal(fs.realpathSync(file), fs.realpathSync(scenario === 'changed-target' ? concurrent : before))
  for (const directory of [before, concurrent]) assert.equal(fs.readFileSync(join(directory, 'dados.txt'), 'utf8'), directory)
})

for (const scenario of ['before-write', 'after-write', 'during-rollback', 'restore-denied', 'snapshot-denied']) test(`alteração de configuração preserva edição concorrente em ${scenario}`, t => {
  const home = temporary(t), first = join(home, 'first.txt'), second = join(home, 'second.txt')
  fs.writeFileSync(first, 'antes'); fs.writeFileSync(second, 'segundo original')
  const rename = fs.renameSync, read = fs.readFileSync, copy = fs.copyFileSync
  let injected = false, reads = 0
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (resolve(path) === first && scenario === 'before-write' && ++reads === 2) { injected = true; fs.writeFileSync(first, 'edição concorrente') }
    return read(path, ...args)
  })
  t.mock.method(fs, 'renameSync', (from, to, ...args) => {
    if (resolve(to) === first && scenario === 'after-write') {
      const result = rename(from, to, ...args); injected = true; fs.writeFileSync(first, 'edição concorrente'); return result
    }
    if (resolve(to) === second && scenario === 'during-rollback') {
      injected = true; fs.writeFileSync(first, 'edição concorrente'); throw new Error('segunda gravação negada')
    }
    return rename(from, to, ...args)
  })
  t.mock.method(fs, 'copyFileSync', (from, to, ...args) => {
    if (resolve(from) === first && scenario === 'snapshot-denied') { injected = true; throw new Error('snapshot negado') }
    return copy(from, to, ...args)
  })
  syncBuiltinESMExports()
  const result = applyInstall({ home, allowedRoots: [home], groups: [{ name: 'configuration', snapshots: scenario === 'snapshot-denied' ? [first] : [], conflicts: [], cleanup: [],
    changes: [{ file: first, before: Buffer.from('antes'), after: Buffer.from('depois') }, { file: second, before: Buffer.from('segundo original'), after: Buffer.from('segundo novo') }] }] })
  t.mock.restoreAll(); syncBuiltinESMExports()
  if (scenario === 'restore-denied') {
    t.mock.method(fs, 'renameSync', (from, to, ...args) => { if (resolve(to) === first) { injected = true; throw new Error('restauração negada') } return rename(from, to, ...args) })
    syncBuiltinESMExports()
    assert.throws(() => restoreInstall(result.backup, { home }), /restauração negada/)
    assert.equal(fs.readFileSync(first, 'utf8'), 'depois')
  } else {
    assert.equal(result.groups[0].status, 'conflict')
    assert.equal(fs.readFileSync(first, 'utf8'), scenario === 'snapshot-denied' ? 'antes' : 'edição concorrente')
    assert.equal(fs.readFileSync(second, 'utf8'), 'segundo original')
  }
  assert.equal(injected, true, 'a contraprova precisa atingir a fronteira da gravação')
})
