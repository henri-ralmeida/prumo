import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { assertExplicitScope, scopePath, insideTouches, scopeConflicts, sameProject, captureScopeBaseline, verifyTaskScope } from '../scripts/task-scope.mjs'

function engineFixture(t, tasks, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-scope-engine-'))
  const root = join(home, 'root'), project = join(home, 'project')
  mkdirSync(root); mkdirSync(project)
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const source = join(root, 'plan.json')
  const plan = { name: 'Escopo aprovado', scopePolicy: 'explicit', planningMode: 'task', ...extra,
    tasks: tasks.map(task => ({ writeScope: 'files', touches: [task.id], title: task.id,
      validation: [{ kind: 'functional', run: 'node -e "process.exit(0)"', expect: 'O comportamento aprovado passa' }], ...task })) }
  const writePlan = () => writeFileSync(source, JSON.stringify(plan))
  writePlan()
  const engine = new URL('../scripts/engine.mjs', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')
  const cli = (...args) => spawnSync(process.execPath, [engine, ...args], { cwd: project,
    env: { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: 'en' }, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const ok = (...args) => { const r = cli(...args); assert.equal(r.status, 0, r.stdout + r.stderr); return r }
  const rejected = (pattern, ...args) => { const r = cli(...args); assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, pattern); return r }
  const statePath = join(root, '.specs/graph/scope/state.json')
  return { plan, source, project, writePlan, cli, ok, rejected,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    save: value => writeFileSync(statePath, JSON.stringify(value)) }
}

test('projetos diferentes isolam caminhos, mas recursos compartilhados permanecem globais', () => {
  const a = { project: join(tmpdir(), 'repo-a'), touches: ['src'], sharedResources: [{ id: 'db', access: 'write' }] }
  const b = { project: join(tmpdir(), 'repo-b'), touches: ['src'], sharedResources: [{ id: 'db', access: 'read' }] }
  assert.deepEqual(scopeConflicts(a, b), { paths: [], resources: ['db'] })
  assert.deepEqual(scopeConflicts(a, { ...b, project: a.project }).paths, ['src'])
  assert.equal(sameProject(a, { touches: ['src'] }, a.project), true)
  assert.equal(sameProject({}, {}), true)
  for (const project of ['', 'relative/repo', null, 1, '/repo\0'])
    assert.throws(() => assertExplicitScope({ project }), /absolute Git repository root/)
  assert.doesNotThrow(() => assertExplicitScope({ project: a.project }))
  assert.throws(() => assertExplicitScope({ writeScope: 'files', touches: ['../neighbor'] }, 'explicit'), /task.project.*absolute Git root/)
})

test('execução usa o projeto aprovado sem cwd e valida a entrega no repositório correto', async t => {
  const f = engineFixture(t, [{ id: 'T1', touches: ['src'] }, { id: 'T2', touches: ['src'] }])
  const repoB = join(f.project, '..', 'neighbor')
  mkdirSync(repoB)
  for (const repo of [f.project, repoB]) {
    assert.equal(spawnSync('git', ['init', repo], { encoding: 'utf8', windowsHide: true }).status, 0)
    mkdirSync(join(repo, 'src'))
  }
  f.plan.tasks[0].project = f.project
  f.plan.tasks[1].project = repoB
  f.writePlan()
  f.ok('init', '--plan', f.source, '--run', 'scope')
  f.ok('authorize', '--scope', 'run', '--confirmed-by-user')
  for (const id of ['T1', 'T2']) {
    f.ok('skip-discussion', id, '--reason', 'Contrato aprovado', '--confirmed-by-user')
    f.ok('skip-planning', id, '--reason', 'Escopo suficiente', '--confirmed-by-user')
    f.ok('start', id, '--agent', `executor-${id}`)
  }
  assert.equal(f.state().tasks.T2.attempts[0].scopeBaseline.cwd, fs.realpathSync.native(repoB))
  assert.deepEqual(f.state().tasks.T2.attempts[0].concurrentScopes, [])
  writeFileSync(join(repoB, 'src', 'result.txt'), 'Entrega aprovada')
  f.ok('review', 'T2', '--agent', 'revisor')
  f.ok('validate', 'T2', '--ok', '--evidence', 'Entrega conferida')
  assert.deepEqual(f.state().tasks.T2.validations.at(-1).scopeCheck.paths, ['src/result.txt'])
  assert.match(f.ok('validate', 'T2', '--ok', '--cwd', f.project, '--evidence', 'Inspeção na raiz aprovada').stdout, /differs from task project/)
  const { contractDrift } = await import('../scripts/contract-drift.mjs')
  f.plan.tasks[1].project = f.project
  assert.ok(contractDrift(f.state(), { plan: f.plan }).tasks.find(task => task.task === 'T2').fields.includes('project'))
})

test('projeto inacessível recusa início sem criar tentativa', t => {
  const f = engineFixture(t, [{ id: 'T1', project: join(tmpdir(), 'prumo-root-that-does-not-exist') }])
  f.ok('init', '--plan', f.source, '--run', 'scope')
  f.ok('authorize', '--scope', 'run', '--confirmed-by-user')
  f.ok('skip-discussion', 'T1', '--reason', 'Aprovado', '--confirmed-by-user')
  f.ok('skip-planning', 'T1', '--reason', 'Escopo suficiente', '--confirmed-by-user')
  f.rejected(/accessible Git repository root/, 'start', 'T1', '--agent', 'executor')
  assert.equal(f.state().tasks.T1.attempts.length, 0)
})

test('motor recusa limites e escopos inválidos e serializa recursos compartilhados de escrita', t => {
  const f = engineFixture(t, [{ id: 'T1' }, { id: 'T2' }])
  for (const maxAgents of [0, -1, 1.5, '3', null]) {
    f.plan.maxAgents = maxAgents; f.writePlan()
    f.rejected(/maxAgents must be a positive integer/, 'init', '--plan', f.source, '--run', 'invalid')
  }
  delete f.plan.maxAgents
  delete f.plan.tasks[0].writeScope; f.writePlan()
  f.rejected(/explicit scope requires writeScope/, 'init', '--plan', f.source, '--run', 'invalid')
  f.plan.tasks[0].writeScope = 'files'
  f.plan.tasks[0].sharedResources = [{ id: 'database', access: 'read' }]
  f.plan.tasks[1].sharedResources = [{ id: 'database', access: 'write' }]
  f.writePlan()
  f.rejected(/share write resources: database/, 'init', '--plan', f.source, '--run', 'invalid')
  f.ok('init', '--plan', f.source, '--run', 'scope', '--allow-overlap')
  assert.deepEqual(f.state().tasks.T1.sharedResources, [{ id: 'database', access: 'read' }])
  f.ok('authorize', '--scope', 'run', '--confirmed-by-user')
  for (const id of ['T1', 'T2']) {
    f.ok('skip-discussion', id, '--reason', 'Contrato confirmado', '--confirmed-by-user')
    f.ok('skip-planning', id, '--reason', 'Escopo suficiente', '--confirmed-by-user')
  }
  f.ok('start', 'T1', '--agent', 'executor-one')
  f.rejected(/Execution scope conflicts with T1: database/, 'start', 'T2', '--agent', 'executor-two')
  f.ok('block', 'T1', '--reason', 'Recurso externo pendente')
  const historical = f.state()
  delete historical.tasks.T1.attempts.at(-1).concurrentScopes
  f.save(historical)
  f.ok('unblock', 'T1')
  assert.deepEqual(f.state().tasks.T1.attempts.at(-1).concurrentScopes, [])
  delete f.plan.scopePolicy; f.writePlan()
  f.ok('sync-plan', '--plan', f.source, '--allow-overlap')
  assert.equal(f.state().plan.scopePolicy, 'explicit', 'sincronizar plano antigo não pode remover a regra de escopo')
  f.plan.tasks[1].deps = ['T1']; f.writePlan()
  f.ok('init', '--plan', f.source, '--run', 'ordered')
  f.plan.tasks[0].deps = ['T2']; delete f.plan.tasks[1].deps; f.writePlan()
  f.ok('init', '--plan', f.source, '--run', 'reverse-ordered')
})

test('sem Git, execução exige evidência independente e done reconfere a atribuição do revisor', t => {
  const f = engineFixture(t, [{ id: 'T1' }])
  f.ok('init', '--plan', f.source, '--run', 'scope')
  f.ok('authorize', '--scope', 'run', '--confirmed-by-user')
  f.ok('skip-discussion', 'T1', '--reason', 'Contrato confirmado', '--confirmed-by-user')
  f.ok('skip-planning', 'T1', '--reason', 'Escopo suficiente', '--confirmed-by-user')
  f.rejected(/not running or reviewing/, 'validate', 'T1', '--ok', '--evidence', 'Ainda não executada')
  f.ok('start', 'T1', '--agent', 'executor')
  f.rejected(/independent reviewer/, 'validate', 'T1', '--ok', '--cwd', f.project, '--evidence', 'Verificação funcional')
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('validate', 'T1', '--ok', '--cwd', f.project, '--evidence', 'Verificação funcional', '--scope-evidence', 'Inspeção independente dos arquivos entregues')
  assert.equal(f.state().tasks.T1.validations.at(-1).scopeCheck.method, 'independent-review')
  const receipt = f.state()
  f.ok('done', 'T1')
  assert.equal(f.state().tasks.T1.state, 'done')
  receipt.tasks.T1.validations.at(-1).scopeCheck.agent = 'other-reviewer'
  f.save(receipt)
  f.rejected(/independent reviewer/, 'done', 'T1')
  receipt.tasks.T1.validations.at(-1).scopeCheck.independentEvidence = { agent: 'reviewer', evidence: 'Inspeção independente confirmada' }
  f.save(receipt)
  f.ok('done', 'T1')
  assert.equal(f.state().tasks.T1.state, 'done')
})

test('validação do executor sem revisão obrigatória ainda confere escopo Git antes de concluir', t => {
  const f = engineFixture(t, [{ id: 'T1', touches: ['delivery'] }], { requireReview: false })
  assert.equal(spawnSync('git', ['-C', f.project, 'init']).status, 0)
  f.ok('init', '--plan', f.source, '--run', 'scope')
  f.ok('authorize', '--scope', 'run', '--confirmed-by-user')
  f.ok('skip-discussion', 'T1', '--reason', 'Contrato confirmado', '--confirmed-by-user')
  f.ok('skip-planning', 'T1', '--reason', 'Escopo suficiente', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
  writeFileSync(join(f.project, 'delivery'), 'Resultado verificado')
  f.ok('validate', 'T1', '--ok', '--cwd', f.project, '--evidence', 'Verificação funcional e conferência Git')
  assert.equal(f.state().tasks.T1.validations.at(-1).by, 'executor')
  assert.equal(f.state().tasks.T1.validations.at(-1).scopeCheck.method, 'git')
  f.ok('done', 'T1')
  assert.equal(f.state().tasks.T1.state, 'done')
})

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
