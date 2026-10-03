import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { packageIdentity } from '../scripts/installation-bundle.mjs'
import { planningContext } from '../scripts/validation.mjs'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const task = fields => ({ id: 'T1', title: 'Contrato', state: 'pending', phase: null, tags: [], touches: [], deps: [], notes: [], attempts: [], validations: [],
  planningRequired: false, validationMode: 'inspection', inspectionReason: 'Conferir o contrato persistido', validation: 'Inspecionar', ...fields })
function fixture(t, { copy = false } = {}) {
  const base = realpathSync(tmpdir()), home = mkdtempSync(join(base, 'prumo-query-hardening-'))
  const root = join(home, 'central', 'project'), graph = join(root, '.specs', 'graph'), run = join(graph, 'query')
  mkdirSync(run, { recursive: true })
  const statePath = join(run, 'state.json'), eventsPath = join(run, 'events.ndjson'), current = join(graph, 'CURRENT'), source = join(home, 'plan.json')
  writeFileSync(current, 'query'); writeFileSync(eventsPath, '{"event":"preservado","unknown":true}\n')
  const plan = { name: 'Consultas', description: 'Contrato aprovado', planningMode: 'task', phases: [], tasks: [task()] }
  const state = { schemaVersion: 1, plan: { ...plan, source }, tasks: { T1: task() }, unknown: { preserve: true } }
  delete state.plan.tasks
  const save = value => writeFileSync(statePath, JSON.stringify(value, null, 1))
  save(state); writeFileSync(source, JSON.stringify(plan))
  const packageRoot = copy ? join(home, 'package') : pkg
  if (copy) cpSync(join(pkg, 'scripts'), join(packageRoot, 'scripts'), { recursive: true })
  const cli = (args, { env = {}, preload } = {}) => {
    const result = spawnSync(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), join(packageRoot, 'scripts', 'engine.mjs'), ...args], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: dirname(root), PRUMO_ROOT: root, GRAPH_ROOT: root,
        GRAPH_FOREMAN_HOME: join(home, 'legacy'), PRUMO_LANG: 'en', ...env }, encoding: 'utf8', timeout: 30000, windowsHide: true,
    })
    assert.ifError(result.error)
    return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }
  const snapshot = () => [statePath, eventsPath, current, source].map(path => readFileSync(path, 'utf8'))
  const query = (args, expected = 0, options) => {
    const before = snapshot(), result = cli(args, options)
    assert.equal(result.status, expected, result.output)
    assert.deepEqual(snapshot(), before, 'consultas e referências inválidas preservam contrato, estado, histórico e seleção')
    return result
  }
  t.after(() => { assert.equal(dirname(home), base); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { home, root, graph, run, state, plan, source, statePath, packageRoot, save, cli, query, snapshot }
}

test('consultas de contrato exibem diferenças atuais e históricas sem reescrever contratos desconhecidos', t => {
  const f = fixture(t)
  const read = (...args) => JSON.parse(f.query(['show-contract', 'T1', ...args]).stdout)
  assert.deepEqual(read().fields, [])
  f.plan.description = 'Descrição alterada'; writeFileSync(f.source, JSON.stringify(f.plan))
  const globals = read('--diff')
  assert.deepEqual(globals.fields, ['plan.description'])
  assert.deepEqual(globals.before.task, {})
  assert.equal(globals.after.plan.description, 'Descrição alterada')
  assert.match(f.query(['status']).output, /approved plan fields: description/)
  f.plan.tasks = []; writeFileSync(f.source, JSON.stringify(f.plan))
  assert.equal(read('--diff').after, null)
  delete f.state.plan.source
  f.state.tasks.T1.contractHistory = [{ at: '2026-01-01', fields: ['task'], before: { extra: 'antes' }, after: { extra: 'depois' } }]
  f.save(f.state)
  assert.deepEqual(read('--diff').after, { extra: 'depois' })
  f.state.tasks.T1.contractHistory = [{ fields: ['title'], before: {}, after: {} }]; f.save(f.state)
  assert.deepEqual(read('--diff').before, { plan: {}, task: {} })
  f.state.plan.source = f.source; f.save(f.state); writeFileSync(f.source, '{')
  assert.deepEqual(read('--diff').before, { plan: {}, task: {} })
  f.query(['show-contract', 'missing'], 1)
  f.query(['show-contract', 'T1', '--run', '../outside'], 1)
})

test('show-check preserva recibos legados e exibe saída, sinal e erro sem executar novamente', t => {
  const f = fixture(t)
  const checks = [
    { stdout: 42, stderr: null, error: 'erro registrado', signal: 'SIGTERM', reusedAt: '2026-01-01' },
    { stdout: 'saída sem quebra', stderr: 'erro sem quebra', run: 'comando antigo', cwd: 'local antigo', exitCode: 2 },
    { stdout: 'saída\n', stderr: 'erro\n', exitCode: 0 },
  ]
  f.state.tasks.T1.validations = [{ attempt: 2, checks: [] }, { attempt: 1, checks }]; f.save(f.state)
  const first = f.query(['show-check', 'T1', '--check', '1', '--attempt', '1'])
  assert.match(first.output, /unknown; reused yes/)
  assert.match(first.output, /not recorded/)
  assert.match(first.output, /SIGTERM/)
  assert.match(first.output, /erro registrado/)
  for (const index of ['2', '3']) {
    const result = f.query(['show-check', 'T1', '--check', index, '--attempt', '1'])
    assert.match(result.output, /saída/); assert.match(result.output, /erro/)
  }
  for (const args of [['--check', '4', '--attempt', '1'], ['--check', '1', '--attempt', '2'], ['--check', '0', '--attempt', '1']])
    f.query(['show-check', 'T1', ...args], 1)
})

test('status distingue origem sem metadados, identidade incompleta e instalação íntegra sem alterar estado', t => {
  const f = fixture(t, { copy: true }), marker = join(f.packageRoot, '.prumo-install.json'), metadata = join(f.packageRoot, 'package.json')
  writeFileSync(metadata, '{}')
  assert.match(f.query(['status']).output, /unknown version/)
  rmSync(metadata)
  assert.match(f.query(['status']).output, /unknown version/)
  writeFileSync(marker, JSON.stringify({ product: 'other' }))
  assert.match(f.query(['status']).output, /source checkout/)
  writeFileSync(marker, JSON.stringify({ product: 'prumo', version: '2.4.0', engineHash: 'different', lang: 'unsupported' }))
  const incomplete = f.query(['status', '--verify-install'])
  assert.match(incomplete.output, /content identifier missing/)
  assert.match(incomplete.output, /harness not recorded/)
  assert.match(incomplete.output, /running engine.mjs differs/)
  assert.match(incomplete.output, /content identifier unavailable/)
  for (const name of ['README.md', 'README.pt-BR.md', 'LICENSE', 'SKILL.md']) cpSync(join(pkg, name), join(f.packageRoot, name))
  cpSync(join(pkg, 'references'), join(f.packageRoot, 'references'), { recursive: true })
  const identity = packageIdentity('pt-BR', { packageRoot: f.packageRoot })
  writeFileSync(marker, JSON.stringify({ product: 'prumo', version: '2.4.0', harness: 'codex', lang: 'pt-BR', ...identity }))
  assert.match(f.query(['status', '--verify-install']).output, /installed files match/)
  const preload = join(f.home, 'unreadable-engine.mjs')
  writeFileSync(preload, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const read = fs.readFileSync
let loaded = false
fs.readFileSync = (path, ...args) => {
  if (String(path).endsWith('engine.mjs') && args.length === 0) {
    if (loaded) throw new Error('arquivo temporariamente indisponível')
    loaded = true
  }
  return read(path, ...args)
}
syncBuiltinESMExports()
`)
  assert.match(f.query(['status', '--verify-install'], 0, { preload }).output, /content identifier unavailable/)
  writeFileSync(marker, JSON.stringify({ product: 'prumo', version: '2.4.0', harness: 'codex', contentId: 'outdated' }))
  assert.match(f.query(['status', '--verify-install']).output, /installed files differ/)
  f.plan.tasks = []; writeFileSync(f.source, JSON.stringify(f.plan))
  assert.match(f.query(['status']).output, /missing from the approved plan/)
})

test('estimativas e referências de caminho informam entradas inválidas e alternativas sem tocar execução existente', t => {
  const f = fixture(t)
  mkdirSync(join(f.home, 'src')); writeFileSync(join(f.home, 'src', 'file.mjs'), '')
  writeFileSync(join(f.home, 'plain-file'), '')
  const inaccessible = join(f.home, 'absent')
  const touchPlan = { name: 'Caminhos', planningMode: 'task', tasks: [{ ...task(), validation: [
    { kind: 'functional', run: 'node --version', expect: 'Versão disponível', cwd: f.home }, { kind: 'functional', run: 'node --version', expect: 'Versão disponível', cwd: inaccessible },
  ], touches: [null, '', '\0', '../outside', 'plain-file/child', 'src/fiel.mjs', 'src/fiel.mjs/child', 'src/file.mjs', 'new-directory/file'] }] }
  const planPath = join(f.home, 'touches.json'); writeFileSync(planPath, JSON.stringify(touchPlan))
  const before = f.snapshot(), result = f.cli(['init', '--plan', planPath, '--run', 'paths'])
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /only repository-relative/)
  assert.match(result.output, /closest existing path: src\/file.mjs/)
  assert.match(result.output, /inaccessible validation repository/)
  assert.deepEqual(f.snapshot().filter((_, index) => index !== 2), before.filter((_, index) => index !== 2))
  writeFileSync(planPath, JSON.stringify({ ...touchPlan, tasks: [task({ touches: ['new-file'] })] }))
  assert.equal(f.cli(['init', '--plan', planPath, '--run', 'plain-path']).status, 0)
  for (const [index, value] of [0, 1.5, {}, 'PT', 'PT2M', 'PT1H', '2h60', '99999999999999999h', '1h30'].entries()) {
    const plan = { name: 'Estimativa', planningMode: 'task', tasks: [task({ manualEstimate: value })] }
    writeFileSync(planPath, JSON.stringify(plan))
    const valid = ['PT2M', 'PT1H', '1h30'].includes(value)
    const response = f.cli(['init', '--plan', planPath, '--run', `estimate${index}`])
    assert.equal(response.status, valid ? 0 : 1, response.output)
    if (valid) assert.ok(JSON.parse(readFileSync(join(f.graph, `estimate${index}`, 'state.json'), 'utf8')).tasks.T1.manualEstimate > 0)
    else assert.equal(existsSync(join(f.graph, `estimate${index}`, 'state.json')), false)
  }
  assert.equal(readFileSync(f.statePath, 'utf8'), before[0])
  mkdirSync(join(f.home, 'blocked-dir'))
  const preload = join(f.home, 'unreadable-directory.mjs')
  writeFileSync(preload, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const read = fs.readdirSync
fs.readdirSync = (path, ...args) => {
  if (String(path).endsWith('blocked-dir')) throw Object.assign(new Error('diretório indisponível'), { code: 'EACCES' })
  return read(path, ...args)
}
syncBuiltinESMExports()
`)
  writeFileSync(planPath, JSON.stringify({ ...touchPlan, tasks: [task({ touches: ['blocked-dir/new-file'] })] }))
  const unavailable = f.cli(['init', '--plan', planPath, '--run', 'unreadable-path'], { preload })
  assert.equal(unavailable.status, 0, unavailable.output)
  assert.match(unavailable.output, /new file or folder is allowed/)
  assert.equal(readFileSync(f.statePath, 'utf8'), before[0])
})

test('planejamento sem escrita anuncia os limites e mantém verificação sem recurso opcional', t => {
  const f = fixture(t)
  const owner = f.state.tasks.T1 = task({ state: 'planning', planningRequired: true, planner: 'planner', planningHistory: [],
    discoveryRequired: false, discussionRequired: false, planningAttempts: [] })
  owner.planningAttempts.push({ n: 1, agent: 'planner', startedAt: '2026-01-01', attempt: 1, context: planningContext(f.state, owner) })
  f.save(f.state)
  const artifact = join(f.home, 'task-plan.json')
  writeFileSync(artifact, JSON.stringify({ research: [{ source: f.statePath, findings: 'Contrato conferido' }], decisions: [],
    steps: ['Inspecionar contrato'], openQuestions: [], writes: [] }))
  assert.match(f.query(['finish-planning', 'T1', '--plan', artifact], 1).output, /task plan verification must map observable criteria/)
  writeFileSync(artifact, JSON.stringify({ research: [{ source: f.statePath, findings: 'Contrato conferido' }], decisions: [],
    steps: ['Inspecionar contrato'], verification: [{ criterion: 'Contrato preservado', check: 'inspection' }], openQuestions: [], writes: [] }))
  const planned = f.cli(['finish-planning', 'T1', '--plan', artifact])
  assert.equal(planned.status, 0, planned.output)
  assert.match(planned.output, /declares no writes/)
  assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).tasks.T1.state, 'pending')
  const status = f.query(['status'])
  assert.equal(status.output.includes('Manual inspection pending'), false)
  const state = JSON.parse(readFileSync(f.statePath, 'utf8'))
  state.tasks.T1.taskPlan.verification[0].requires = ['manual-inspection']; f.save(state)
  assert.match(f.query(['status']).output, /Manual inspection pending/)
})

test('revisão mantém progresso desconhecido para contratos legados e recusa recibo sem tentativa sem gravar estado', t => {
  const f = fixture(t)
  for (const validation of ['Inspecionar', []]) {
    f.state.tasks.T1 = task({ state: 'running', agent: 'executor', attempts: [{ agent: 'executor', reviewProgress: { stale: true } }], validation })
    if (Array.isArray(validation)) delete f.state.tasks.T1.validationMode
    f.save(f.state)
    const reviewed = f.cli(['review', 'T1', '--agent', 'reviewer'])
    assert.equal(reviewed.status, 0, reviewed.output)
    const persisted = JSON.parse(readFileSync(f.statePath, 'utf8'))
    assert.equal(persisted.tasks.T1.state, 'reviewing')
    assert.equal(persisted.tasks.T1.attempts[0].reviewProgress, undefined)
    assert.equal(persisted.unknown.preserve, true)
  }
  f.state.tasks.T1 = task({ state: 'reviewing', reviewer: 'reviewer', attempts: [],
    validation: [{ kind: 'functional', run: 'node --version', expect: 'Versão disponível' }] })
  f.save(f.state)
  f.query(['review-progress', 'T1', '--step', '1', '--agent', 'reviewer'], 1)
  f.state.tasks.T1 = task({ state: 'running', agent: 'executor', attempts: [] }); f.save(f.state)
  f.query(['review', 'T1', '--agent', 'reviewer'], 1)
  f.state.tasks.T1 = task({ state: 'blocked', stateBeforeBlock: 'reviewing', agent: 'executor', reviewer: 'reviewer', attempts: [] })
  f.save(f.state)
  assert.match(f.query(['unblock', 'T1', '--reviewer', 'reviewer'], 1).output, /cannot resume without an open attempt/)
})

test('validate rejeita tamanho de cauda inválido e imprime evidências reais sem interpretar resumos como aprovação', t => {
  const f = fixture(t), script = join(f.home, 'output.cjs')
  writeFileSync(script, "process.stdout.write('linha normal\\nSUMMARY total 2 tests\\n' + 'x'.repeat(1100)); process.stderr.write('erro real'); process.exit(2)\n")
  f.state.plan.requireReview = false
  f.state.tasks.T1 = task({ state: 'running', agent: 'executor', attempts: [{ agent: 'executor' }],
    validationMode: 'functional', validation: [{ kind: 'functional', run: 'node output.cjs', expect: 'Recusar falha real' }] })
  f.save(f.state)
  for (const tail of ['-1', '1.2', '999999999999999999999']) f.query(['validate', 'T1', '--ok', '--evidence', 'Verificar', '--tail', tail], 1)
  const failed = f.cli(['validate', 'T1', '--ok', '--evidence', 'Verificar', '--cwd', f.home, '--tail', '10'])
  assert.equal(failed.status, 1, failed.output)
  assert.match(failed.output, /SUMMARY total 2 tests/)
  assert.match(failed.output, /…x/)
  assert.match(failed.output, /erro real/)
  assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).tasks.T1.validations.at(-1).ok, false)
  assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).unknown.preserve, true)
})

test('linha de progresso preserva agente com aspas nos shells anunciados pelo ambiente', t => {
  const f = fixture(t)
  for (const env of [{ MSYSTEM: '', SHELL: '' }, { MSYSTEM: 'MINGW64', SHELL: '' }, { MSYSTEM: '', SHELL: '/bin/bash' }]) {
    f.state.tasks.T1 = task({ taskPlan: { steps: ['Executar'] } }); f.save(f.state)
    const started = f.cli(['start', 'T1', '--agent', "executor'local"], { env })
    assert.equal(started.status, 0, started.output)
    assert.match(started.output, /report each actual execution step/)
    if (process.platform === 'win32' && !env.MSYSTEM && !env.SHELL) assert.match(started.output, /executor''local/)
    else assert.ok(started.output.includes("executor'\\''local"), started.output)
    const persisted = JSON.parse(readFileSync(f.statePath, 'utf8'))
    assert.equal(persisted.tasks.T1.agent, "executor'local")
    assert.equal(persisted.tasks.T1.attempts[0].executionStep, 1)
  }
})

test('validação reaproveitada apresenta saída legada e recusa recibo com tipo divergente do contrato', t => {
  const f = fixture(t), staticScript = join(f.home, 'static.cjs'), functionalScript = join(f.home, 'functional.cjs')
  const initialized = spawnSync('git', ['init', f.home], { encoding: 'utf8', windowsHide: true })
  assert.ifError(initialized.error)
  assert.equal(initialized.status, 0, initialized.stderr)
  writeFileSync(join(f.home, 'value.txt'), 'entrada preservada')
  writeFileSync(staticScript, "require('fs').appendFileSync('executions.txt', 'executado\\n')\n")
  writeFileSync(functionalScript, "process.stdout.write('resultado funcional\\n'); process.stderr.write('aviso funcional')\n")
  f.state.plan.requireReview = false
  f.state.tasks.T1 = task({ state: 'running', agent: 'executor', attempts: [{ agent: 'executor' }], validationMode: 'functional', validation: [
    { kind: 'static', run: 'node static.cjs', expect: 'Conferir entrada', cacheable: true, cachePaths: ['value.txt'] },
    { kind: 'functional', run: 'node functional.cjs', expect: 'Comportamento aprovado' },
  ] })
  f.save(f.state)
  const validate = () => f.cli(['validate', 'T1', '--ok', '--evidence', 'Resultado real', '--cwd', f.home])
  assert.equal(validate().status, 0)
  const old = JSON.parse(readFileSync(f.statePath, 'utf8'))
  delete old.tasks.T1.validations.at(-1).checks[0].expectedExitCodes; f.save(old)
  const reused = validate()
  assert.equal(reused.status, 0, reused.output)
  assert.match(reused.output, /reused check 1/)
  for (const [stdout, stderr] of [[42, 'cache summary'], ['cache summary', null], ['cache summary\r', 'aviso textual']]) {
    const state = JSON.parse(readFileSync(f.statePath, 'utf8'))
    const check = state.tasks.T1.validations.at(-1).checks[0]
    Object.assign(check, { kind: 'functional', stdout, stderr }); delete check.expectedExitCodes
    f.save(state)
    const response = validate()
    assert.equal(response.status, 1, response.output)
    assert.match(response.output, /reused check 1/)
    assert.match(response.output, /reused yes/)
    assert.match(response.output, /cache summary/)
    assert.equal(readFileSync(join(f.home, 'executions.txt'), 'utf8'), 'executado\n')
    assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).tasks.T1.validations.at(-1).ok, false)
    assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).unknown.preserve, true)
  }
})

test('timeout de validação mostra saída parcial e registra falha sem aprovar evidência incompleta', t => {
  const f = fixture(t)
  writeFileSync(join(f.home, 'wait.cjs'), "process.stdout.write('aguardando resultado\\n'); setInterval(() => {}, 1000)\n")
  f.state.plan.requireReview = false
  f.state.tasks.T1 = task({ state: 'running', agent: 'executor', attempts: [{ agent: 'executor' }], validationMode: 'functional',
    validation: [{ kind: 'functional', run: 'node wait.cjs', expect: 'Resultado no prazo', timeoutMs: 3000 }] })
  f.save(f.state)
  const result = f.cli(['validate', 'T1', '--ok', '--evidence', 'Prazo esgotado', '--cwd', f.home])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /aguardando resultado/)
  assert.match(result.output, /ETIMEDOUT/)
  assert.equal(JSON.parse(readFileSync(f.statePath, 'utf8')).tasks.T1.validations.at(-1).ok, false)
})
