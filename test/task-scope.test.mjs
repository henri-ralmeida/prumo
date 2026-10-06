import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { assertExplicitScope, scopePath, insideTouches, scopeConflicts, captureScopeBaseline, verifyTaskScope } from '../scripts/task-scope.mjs'

test('contratos explícitos exigem escopo seguro e mantêm contratos históricos', () => {
  assert.doesNotThrow(() => assertExplicitScope({}))
  for (const task of [{ writeScope: 'files', touches: ['src'] }, { writeScope: 'read-only', touches: [] }, { writeScope: 'unknown', touches: [] }]) assert.doesNotThrow(() => assertExplicitScope(task, 'explicit'))
  assert.throws(() => assertExplicitScope({}, 'invalid'))
  assert.throws(() => assertExplicitScope({}, 'explicit'))
  for (const touches of [null, ['../x'], ['/x'], ['C:x'], [''], [1], ['a\0b']]) assert.throws(() => assertExplicitScope({ writeScope: 'files', touches }, 'explicit'))
  assert.throws(() => assertExplicitScope({ writeScope: 'files', touches: [] }, 'explicit'))
  assert.throws(() => assertExplicitScope({ writeScope: 'read-only', touches: ['x'] }, 'explicit'))
  for (const sharedResources of [null, [null], [{ id: '' }], [{ id: 'x', access: 'bad' }]]) assert.throws(() => assertExplicitScope({ sharedResources }))
  assert.doesNotThrow(() => assertExplicitScope({ sharedResources: [{ id: 'db', access: 'read' }] }))
  assert.equal(scopePath('./src\\file'), 'src/file')
  assert.equal(insideTouches('src/file', ['src']), true)
  assert.equal(insideTouches('src2/file', ['src']), false)
  assert.equal(insideTouches('any', ['.']), true)
  assert.equal(insideTouches('SRC/file', ['src']), process.platform === 'win32')
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    assert.equal(insideTouches('SRC/file', ['src']), false)
    Object.defineProperty(process, 'platform', { value: 'win32' })
    assert.equal(insideTouches('SRC/file', ['src']), true)
  } finally { Object.defineProperty(process, 'platform', platform) }
})

test('nomes especiais de arquivos continuam visíveis na conferência do escopo', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'prumo-scope-proto-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['-C', cwd, 'init']).status, 0)
  const baseline = captureScopeBaseline(cwd)
  writeFileSync(join(cwd, '__proto__'), 'delivery')
  assert.equal(Object.hasOwn(captureScopeBaseline(cwd).files, '__proto__'), true)
  assert.throws(() => verifyTaskScope({ writeScope: 'files', touches: ['src'] }, baseline), /outside approved touches: __proto__/)
})

test('recursos aceitam leituras concorrentes e serializam qualquer escrita', () => {
  assert.deepEqual(scopeConflicts({}, {}), { paths: [], resources: [] })
  const a = { touches: ['src'], sharedResources: [{ id: 'db', access: 'read' }] }
  assert.deepEqual(scopeConflicts(a, { touches: ['src/file'], sharedResources: [{ id: 'db', access: 'read' }] }), { paths: ['src'], resources: [] })
  assert.deepEqual(scopeConflicts(a, { touches: ['src2'], sharedResources: [{ id: 'db', access: 'write' }] }), { paths: [], resources: ['db'] })
  assert.deepEqual(scopeConflicts({ touches: ['src/file'], sharedResources: [{ id: 'db', access: 'write' }] }, a), { paths: ['src/file'], resources: ['db'] })
  assert.deepEqual(scopeConflicts(a, { sharedResources: [{ id: 'different', access: 'write' }] }).resources, [])
  assert.deepEqual(scopeConflicts(a, {}), { paths: [], resources: [] })
})

test('Git confere novos, removidos e alterados sem atribuir sujeira anterior inalterada', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'prumo-scope-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => { const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr) }
  git('init'); writeFileSync(join(cwd, 'old'), 'old'); git('add', 'old')
  writeFileSync(join(cwd, 'dirty'), 'preexisting')
  const baseline = captureScopeBaseline(cwd)
  assert.equal(baseline.method, 'git', baseline.limitation)
  const task = { agent: 'executor', writeScope: 'files', touches: ['old', 'new'] }
  writeFileSync(join(cwd, 'new'), 'new'); rmSync(join(cwd, 'old'))
  assert.deepEqual(verifyTaskScope(task, baseline).paths, ['old', 'new'])
  writeFileSync(join(cwd, 'dirty'), 'changed')
  assert.throws(() => verifyTaskScope(task, baseline), /outside/)
  const evidence = { agent: 'reviewer', evidence: 'Outro executor alterou dirty, conforme revisão independente' }
  assert.throws(() => verifyTaskScope(task, baseline, evidence), /outside/)
  assert.deepEqual(verifyTaskScope(task, baseline, evidence, [['dirty']]).excludedPaths, ['dirty'])
  assert.throws(() => verifyTaskScope(task, baseline, { ...evidence, agent: 'executor' }, [['dirty']]), /outside/)
  assert.throws(() => verifyTaskScope({ ...task, writeScope: 'read-only' }, baseline), /outside/)
  mkdirSync(join(cwd, 'nested'))
  assert.equal(captureScopeBaseline(join(cwd, 'nested')).method, 'unavailable')
  writeFileSync(join(cwd, 'nested/file'), 'nested')
  const originalStat = fs.lstatSync
  const statMock = t.mock.method(fs, 'lstatSync', path => {
    if (String(path).endsWith('nested')) return { isSymbolicLink: () => true }
    return originalStat(path)
  }); syncBuiltinESMExports()
  assert.match(captureScopeBaseline(cwd).limitation, /symbolic link/)
  statMock.mock.restore(); syncBuiltinESMExports()
  const readMock = t.mock.method(fs, 'readFileSync', () => { throw new Error('read failed') }); syncBuiltinESMExports()
  assert.match(captureScopeBaseline(cwd).limitation, /read failed/)
  readMock.mock.restore(); syncBuiltinESMExports()
  const directoryMock = t.mock.method(fs, 'lstatSync', () => ({ isDirectory: () => true })); syncBuiltinESMExports()
  assert.match(captureScopeBaseline(cwd).limitation, /submodule/)
  directoryMock.mock.restore(); syncBuiltinESMExports()
  const linkMock = t.mock.method(fs, 'lstatSync', path => String(path).endsWith('dirty') ? { isDirectory: () => false, isSymbolicLink: () => true, mode: 0 } : originalStat(path))
  const targetMock = t.mock.method(fs, 'readlinkSync', () => 'target'); syncBuiltinESMExports()
  assert.equal(captureScopeBaseline(cwd).method, 'git')
  linkMock.mock.restore(); targetMock.mock.restore(); syncBuiltinESMExports()
})

test('ausência de Git requer evidência independente e mantém limitação explícita', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'prumo-no-git-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  assert.equal(captureScopeBaseline().method, 'unavailable')
  const baseline = captureScopeBaseline(cwd)
  assert.equal(baseline.method, 'unavailable')
  const task = { agent: 'executor' }
  assert.throws(() => verifyTaskScope(task, baseline), /independent reviewer/)
  assert.throws(() => verifyTaskScope(task, baseline, { agent: 'executor', evidence: 'inspected' }), /independent reviewer/)
  const receipt = verifyTaskScope(task, baseline, { agent: 'reviewer', evidence: 'inspected paths' })
  assert.equal(receipt.method, 'independent-review')
  assert.ok(receipt.limitation)
  assert.equal(verifyTaskScope(task, undefined, { agent: 'reviewer', evidence: 'inspected' }).method, 'independent-review')
})

test('motor mantém paralelismo disjunto com revisão de atribuição e rejeita entrega externa', t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-scope-cli-')), root = join(home, 'storage'), cwd = join(home, 'project')
  mkdirSync(root); mkdirSync(cwd)
  t.after(() => rmSync(home, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['-C', cwd, 'init']).status, 0)
  const plan = { name: 'Escopo verificável', scopePolicy: 'explicit', planningMode: 'task', tasks: [
    { id: 'T1', title: 'Primeiro arquivo', touches: ['one', 'src'], writeScope: 'files' },
    { id: 'T2', title: 'Segundo arquivo', touches: ['two', 'src2'], writeScope: 'files' },
    { id: 'T3', title: 'Escopo pendente', touches: [], writeScope: 'unknown' },
  ].map(task => ({ ...task, validation: [{ kind: 'functional', run: 'node -e "process.exit(0)"', expect: 'O comportamento é válido' }] })) }
  const source = join(root, 'plan.json'); writeFileSync(source, JSON.stringify(plan))
  const engine = new URL('../scripts/engine.mjs', import.meta.url)
  const cli = (...args) => spawnSync(process.execPath, [engine.pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'), ...args], { cwd, env: { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: 'en' }, encoding: 'utf8' })
  const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.stdout + result.stderr); return result }
  const reject = (pattern, ...args) => { const result = cli(...args); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, pattern) }
  ok('init', '--plan', source, '--run', 'scope')
  writeFileSync(source, JSON.stringify({ ...plan, tasks: plan.tasks.map(task => task.id === 'T2' ? { ...task, touches: ['SRC'] } : task) }))
  if (process.platform === 'win32') reject(/both touch/, 'init', '--plan', source, '--run', 'alias')
  else ok('init', '--plan', source, '--run', 'alias')
  writeFileSync(source, JSON.stringify(plan))
  // A criação de outro cenário não deve mudar o alvo dos comandos desta regressão.
  writeFileSync(join(root, '.specs/graph/CURRENT'), 'scope')
  for (const id of ['T1', 'T2', 'T3']) { ok('skip-discussion', id, '--reason', 'Escopo aprovado', '--confirmed-by-user'); ok('skip-planning', id, '--reason', 'Contrato suficiente', '--confirmed-by-user') }
  reject(/scope/i, 'start', 'T3', '--agent', 'unknown')
  ok('start', 'T1', '--agent', 'first'); ok('block', 'T1', '--reason', 'Aguardando recurso')
  ok('start', 'T2', '--agent', 'second'); ok('unblock', 'T1')
  writeFileSync(join(cwd, 'one'), 'first'); writeFileSync(join(cwd, 'two'), 'second')
  ok('review', 'T1', '--agent', 'reviewer-one')
  reject(/outside/, 'validate', 'T1', '--ok', '--cwd', cwd, '--evidence', 'Inspecionado')
  ok('validate', 'T1', '--ok', '--cwd', cwd, '--evidence', 'Inspecionado', '--scope-evidence', 'two foi entregue por second; one está dentro do escopo')
  const statePath = join(root, '.specs/graph/scope/state.json'), state = () => JSON.parse(readFileSync(statePath))
  assert.deepEqual(state().tasks.T1.validations.at(-1).scopeCheck.excludedPaths, ['two'])
  writeFileSync(join(cwd, 'external'), 'out of scope')
  reject(/outside/, 'done', 'T1')
  reject(/outside/, 'validate', 'T1', '--ok', '--cwd', cwd, '--evidence', 'Inspecionado', '--scope-evidence', 'Declaração independente não autoriza external')
  rmSync(join(cwd, 'external'))
  ok('validate', 'T1', '--ok', '--cwd', cwd, '--evidence', 'Inspecionado', '--scope-evidence', 'two foi entregue por second')
  writeFileSync(join(cwd, 'one'), 'changed after validation')
  reject(/changed after scope validation/, 'done', 'T1')
  ok('validate', 'T1', '--ok', '--cwd', cwd, '--evidence', 'Inspecionado', '--scope-evidence', 'two foi entregue por second'); ok('done', 'T1')
  const graph = JSON.parse(ok('graph').stdout)
  assert.equal(graph.derived.T3.executionReadiness.ready, false)
  assert.ok(graph.derived.T3.executionReadiness.reasons.some(reason => reason.code === 'scope_unknown'))
  ok('fail', 'T2', '--reason', 'Correção necessária'); ok('retry', 'T2'); ok('start', 'T2', '--agent', 'second-retry')
  assert.deepEqual(state().tasks.T2.attempts.at(-1).concurrentScopes, [])
})
