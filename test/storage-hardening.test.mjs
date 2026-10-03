import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  findRoot,
  globalGraphRoots,
  graphRoots,
  inside,
  legacyExecutionPending,
  storageHome,
} from '../scripts/storage.mjs'

function temporary(t, label = 'prumo-storage-hardening-') {
  const root = mkdtempSync(join(tmpdir(), label))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function graph(root) {
  mkdirSync(join(root, '.specs', 'graph'), { recursive: true })
}

test('legado pendente só bloqueia a migração quando há trabalho não terminal iniciado', () => {
  const active = [
    { plan: {}, tasks: { T1: { state: 'running', attempts: [] } } },
    { plan: { planningMode: 'legacy' }, tasks: { T1: { state: 'pending', attempts: [{}] } } },
    { tasks: { T1: { state: 'blocked', attempts: [] } } },
  ]
  for (const state of active) assert.equal(legacyExecutionPending(state), true)

  for (const state of [
    {},
    { plan: {}, tasks: {} },
    { plan: { planningMode: 'task' }, tasks: { T1: { state: 'running', attempts: [{}] } } },
    { plan: { planningMode: 'phase' }, tasks: { T1: { state: 'planning', attempts: [] } } },
    { plan: {}, tasks: { T1: { state: 'pending', attempts: [] } } },
    { plan: {}, tasks: { T1: { state: 'failed', attempts: [] } } },
    { plan: {}, tasks: { T1: { state: 'done', attempts: [{}] } } },
    { plan: {}, tasks: { T1: { state: 'skipped', attempts: [{}] } } },
  ]) assert.equal(legacyExecutionPending(state), false)
})

test('findRoot preserva raízes centrais, locais, migradas e rejeita alvos explícitos fora do escopo', t => {
  const home = temporary(t)
  const central = join(home, 'central')
  const centralProject = join(central, 'central-project')
  mkdirSync(join(centralProject, 'nested'), { recursive: true })
  assert.equal(storageHome({ PRUMO_HOME: central }, home), resolve(central))
  assert.equal(findRoot({ PRUMO_HOME: central }, join(centralProject, 'nested'), home), centralProject)

  const local = join(home, 'legacy-project')
  graph(local)
  mkdirSync(join(local, 'nested', 'deeper'), { recursive: true })
  const localEnv = { PRUMO_HOME: central }
  assert.equal(findRoot(localEnv, join(local, 'nested', 'deeper'), home), local)

  const migratedParent = join(home, 'legacy-store')
  const migratedSource = join(migratedParent, 'moved-project')
  const migrated = join(central, 'moved-project')
  graph(migrated)
  mkdirSync(migratedSource, { recursive: true })
  assert.equal(findRoot({ PRUMO_HOME: central, PRUMO_ROOT: migratedSource, GRAPH_FOREMAN_HOME: migratedParent }, home), migrated)

  const centralRoot = join(central, 'new-project')
  mkdirSync(centralRoot, { recursive: true })
  assert.equal(findRoot({ PRUMO_HOME: central, PRUMO_ROOT: centralRoot }, home), centralRoot)

  const explicitLegacy = join(home, 'explicit-legacy')
  graph(explicitLegacy)
  assert.equal(findRoot({ PRUMO_HOME: central, PRUMO_ROOT: explicitLegacy }, home), explicitLegacy)

  assert.throws(() => findRoot({ PRUMO_HOME: central, PRUMO_ROOT: join(home, 'missing') }, home), /does not exist/)
  const outside = join(home, 'outside')
  mkdirSync(outside)
  assert.throws(() => findRoot({ PRUMO_HOME: central, PRUMO_ROOT: outside }, home), /must be a central workspace/)
})

test('inside distingue a raiz, filhos e caminhos irmãos', t => {
  const root = temporary(t)
  assert.equal(inside(root, root), true)
  assert.equal(inside(root, join(root, 'child')), true)
  assert.equal(inside(root, join(root, 'child', 'file.txt')), true)
  assert.equal(inside(root, join(root, '..', 'sibling')), false)
  assert.equal(inside(root, root + '-sibling'), false)
})

test('inside recusa caminhos em unidades Windows diferentes', () => {
  if (process.platform !== 'win32') return
  assert.equal(inside('C:\\protected', 'D:\\foreign'), false)
})

test('globalGraphRoots consolida centrais e registro, ignora entradas inválidas e desambigua raízes', t => {
  const home = temporary(t)
  const central = join(home, 'custom-central')
  const centralAlpha = join(central, 'alpha')
  const centralBeta = join(central, 'beta')
  graph(centralAlpha)
  graph(centralBeta)

  const registeredParent = join(home, 'registered')
  const registeredAlpha = join(registeredParent, 'alpha')
  graph(registeredAlpha)
  const missing = join(home, 'missing')
  const registry = join(home, '.local', 'share', 'prumo')
  mkdirSync(registry, { recursive: true })
  writeFileSync(join(registry, 'installations.json'), JSON.stringify([
    null,
    { projects: ['relative', 17, missing, registeredAlpha, registeredAlpha] },
    { invalid: true },
  ]))

  const result = globalGraphRoots({ PRUMO_HOME: central }, home)
  const paths = result.roots.map(item => item.path)
  assert.deepEqual(new Set(paths), new Set([centralAlpha, centralBeta, registeredAlpha]))
  const alphaNames = result.roots.filter(item => item.path.endsWith(`${separator()}alpha`)).map(item => item.name).sort()
  assert.deepEqual(alphaNames, ['alpha', 'alpha-2'])
  assert.ok(result.warnings.some(warning => warning.includes('invalid installation registry entry')))
  assert.ok(result.warnings.some(warning => warning.includes('relative')))
  assert.ok(result.warnings.some(warning => warning.includes(String(17))))
  assert.ok(result.warnings.some(warning => warning.includes('missing')))

  writeFileSync(join(registry, 'installations.json'), '{')
  const malformed = globalGraphRoots({ PRUMO_HOME: central }, home)
  assert.ok(malformed.warnings.some(warning => warning.includes('Could not read installation registry')))

  writeFileSync(join(registry, 'installations.json'), JSON.stringify({ projects: [] }))
  const nonArray = globalGraphRoots({ PRUMO_HOME: central }, home)
  assert.ok(nonArray.warnings.some(warning => warning.includes('Could not read installation registry')))
})

test('globalGraphRoots permanece vazio quando as centrais ainda não existem', t => {
  const home = temporary(t)
  const result = globalGraphRoots({ PRUMO_HOME: join(home, 'custom') }, home)
  assert.deepEqual(result.roots, [])
  assert.deepEqual(result.warnings, [])
})

test('graphRoots mantém a raiz selecionada mesmo quando há diretórios inválidos no central', t => {
  const root = temporary(t)
  const central = join(root, 'central')
  mkdirSync(join(central, 'valid', '.specs', 'graph'), { recursive: true })
  mkdirSync(join(central, '.invalid', '.specs', 'graph'), { recursive: true })
  writeFileSync(join(central, 'file.txt'), 'ignorar')
  const roots = graphRoots(root, central)
  assert.equal(roots[0].path, root)
  assert.ok(roots.some(item => item.path === join(central, 'valid')))
  assert.equal(roots.some(item => item.path.includes('.invalid')), false)
})

test('graphRoots ignora a própria raiz quando o central é seu diretório pai', t => {
  const parent = temporary(t)
  const root = join(parent, 'workspace')
  graph(root)
  const roots = graphRoots(root, parent)
  assert.deepEqual(roots, [{ name: 'workspace', path: root, graphDir: join(root, '.specs', 'graph') }])
})

test('globalGraphRoots registra falha ao ler uma central que é arquivo', t => {
  const home = temporary(t)
  const centralFile = join(home, 'central-file')
  writeFileSync(centralFile, 'não é diretório')
  const result = globalGraphRoots({ PRUMO_HOME: centralFile }, home)
  assert.ok(result.warnings.some(warning => warning.includes(centralFile)))
})

function separator() {
  return process.platform === 'win32' ? '\\' : '/'
}

test('seleção exige workspace quando não há raiz explícita e preserva aliases repetidos', t => {
  const home = temporary(t)
  assert.equal(storageHome({}, home), join(home, '.local', 'share', 'prumo'))
  assert.throws(() => findRoot({}, home, home), /Select a workspace/)
  const selected = join(home, 'legacy', 'alpha')
  const central = join(home, 'central')
  graph(selected)
  graph(join(central, 'alpha'))
  graph(join(central, 'alpha-2'))
  const roots = graphRoots(selected, central)
  assert.equal(new Set(roots.map(item => item.name)).size, roots.length)
  assert.equal(roots[0].path, selected)
  assert.equal(roots.filter(item => item.name.startsWith('alpha')).length, 3)
})
