import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { installationBundle } from '../scripts/installation-bundle.mjs'
import { initializeLegacyPlanFixture } from './fixtures/legacy-plan-init.mjs'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/engine.mjs')

function fixture(t, { requireReview = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-engine-hardening-'))
  const root = join(home, 'workspace')
  const project = join(home, 'project')
  mkdirSync(root)
  mkdirSync(project)
  writeFileSync(join(project, 'check.cjs'), "console.log('comportamento verificado')\n")
  const plan = {
    name: 'Contrato de hardening',
    planningMode: 'task',
    requireReview,
    tasks: [{ id: 'T1', title: 'Entrega', validation: [
      { kind: 'functional', run: 'node check.cjs', expect: 'o comportamento aprovado passa' },
    ] }],
  }
  const planPath = join(root, 'plan.json')
  writeFileSync(planPath, JSON.stringify(plan))
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PRUMO_HOME: home,
    PRUMO_ROOT: root,
    GRAPH_ROOT: root,
    GRAPH_FOREMAN_HOME: home,
    PRUMO_LANG: 'en',
  }
  const graph = join(root, '.specs', 'graph')
  const statePath = join(graph, 'hardening', 'state.json')
  const eventsPath = join(graph, 'hardening', 'events.ndjson')
  const currentPath = join(graph, 'CURRENT')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const cli = (...args) => spawnSync(process.execPath, [engine, ...args], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  })
  const output = result => `${result.stdout ?? ''}${result.stderr ?? ''}`
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const save = value => writeFileSync(statePath, JSON.stringify(value))
  const snapshot = () => [
    existsSync(statePath) ? readFileSync(statePath, 'utf8') : null,
    existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : null,
    existsSync(currentPath) ? readFileSync(currentPath, 'utf8') : null,
  ]
  const init = () => cli('init', '--plan', planPath, '--run', 'hardening')
  const writePlan = value => writeFileSync(planPath, JSON.stringify(value))
  return { home, root, project, planPath, graph, env, writePlan, statePath, eventsPath, currentPath, cli, output, state, save, snapshot, init }
}

function makeLegacy(f) {
  const state = f.state()
  const task = state.tasks.T1
  task.discussionRequired = false
  task.discoveryRequired = false
  task.planningRequired = false
  task.discussionAttempts = []
  task.discussionSkips = []
  task.planningAttempts = []
  task.planningHistory = []
  task.planningSkips = []
  state.authorizations = []
  f.save(state)
}

test('init recusa IDs novos fora do padrão e sync-plan preserva o registro ao recusar nova fase inválida', t => {
  const f=fixture(t)
  const original=JSON.parse(readFileSync(f.planPath,'utf8'))
  for(const id of ['HO1','REL1','T01','T0','T1a']) {
    f.writePlan({...original,tasks:[{...original.tasks[0],id}]})
    const before=f.snapshot(),result=f.init()
    assert.notEqual(result.status,0)
    assert.match(f.output(result),/must use T1/)
    assert.deepEqual(f.snapshot(),before)
  }
  for(const id of ['F0','F1B','P1','F2']) {
    f.writePlan({...original,phases:[{id,title:'Fase'}]})
    const before=f.snapshot(),result=f.init()
    assert.notEqual(result.status,0)
    assert.match(f.output(result),/next sequential identifier F1/)
    assert.deepEqual(f.snapshot(),before)
  }
  const valid={...original,phases:[{id:'F1',title:'Fase'}]}
  f.writePlan(valid);assert.equal(f.init().status,0)
  f.writePlan({...valid,phases:[...valid.phases,{id:'F3',title:'Fase adicional'}]})
  const before=f.snapshot(),rejected=f.cli('sync-plan','--plan',f.planPath,'--run','hardening')
  assert.notEqual(rejected.status,0)
  assert.match(f.output(rejected),/next sequential identifier F2/)
  assert.deepEqual(f.snapshot(),before)
  f.writePlan({...valid,phases:[...valid.phases,{id:'F2',title:'Fase adicional'}]})
  assert.equal(f.cli('sync-plan','--plan',f.planPath,'--run','hardening').status,0)
})

test('comandos incompatíveis com tarefa pendente preservam contrato e histórico', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const before = f.snapshot()
  const cases = [
    [['authorize', '--scope', 'invalido', '--confirmed-by-user'], /authorize needs --scope/],
    [['plan-task', 'T1'], /plan-task needs --agent/],
    [['finish-discussion', 'T1'], /finish-discussion needs --context/],
    [['skip-planning', 'T1', '--reason', 'escolha explícita', '--confirmed-by-user'], /needs a completed discussion/],
    [['skip-phase-discussion', 'P1', '--reason', 'escolha explícita', '--confirmed-by-user'], /task planning/],
    [['skip-phase-planning', 'P1', '--reason', 'escolha explícita', '--confirmed-by-user'], /task planning/],
    [['progress', 'T1', '--step', '1', '--agent', 'executor'], /pending, not running/],
    [['fail', 'T1', '--reason', 'falha'], /pending, not running or reviewing/],
    [['retry', 'T1'], /pending, not failed/],
  ]
  for (const [args, expected] of cases) {
    const result = f.cli(...args)
    assert.equal(result.status, 1, f.output(result))
    assert.match(f.output(result), expected)
    assert.deepEqual(f.snapshot(), before, args.join(' '))
  }
})

test('tentativa histórica sem posição começa no primeiro passo e não permite retrocesso', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  let state = f.state()
  state.tasks.T1.taskPlan = { steps: ['Implementar', 'Verificar'] }
  f.save(state)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor').status, 0)
  state = f.state()
  delete state.tasks.T1.attempts.at(-1).executionStep
  f.save(state)
  const advanced = f.cli('progress', 'T1', '--step', '2', '--agent', 'executor')
  assert.equal(advanced.status, 0, f.output(advanced))
  assert.equal(f.state().tasks.T1.attempts.at(-1).executionStep, 2)
  const before = f.snapshot()
  const backwards = f.cli('progress', 'T1', '--step', '1', '--agent', 'executor')
  assert.equal(backwards.status, 1, f.output(backwards))
  assert.match(f.output(backwards), /cannot move backwards/)
  assert.deepEqual(f.snapshot(), before)
})

test('retry respeita o limite de tentativas e o plano aprovado antes de alterar histórico', t => {
  const f = fixture(t)
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.tasks[0].maxAttempts = 1
  approved.tasks.push({ ...approved.tasks[0], id: 'T2', title: 'Outra entrega aprovada' })
  f.writePlan(approved)
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor').status, 0)
  assert.equal(f.cli('fail', 'T1', '--reason', 'checagem falhou').status, 0)
  let before = f.snapshot()
  const capped = f.cli('retry', 'T1')
  assert.equal(capped.status, 1, f.output(capped))
  assert.match(f.output(capped), /already has 1 attempts \(cap 1\)/)
  assert.deepEqual(f.snapshot(), before)
  approved.tasks = approved.tasks.filter(task => task.id !== 'T1')
  f.writePlan(approved)
  before = f.snapshot()
  const removed = f.cli('retry', 'T1', '--force')
  assert.equal(removed.status, 1, f.output(removed))
  assert.match(f.output(removed), /approved plan no longer contains T1/)
  assert.deepEqual(f.snapshot(), before)
})

test('pergunta delegada ao executor não bloqueia discussão nem início da entrega', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.tasks.T1.taskPlan = { openQuestions: [{ question: 'Qual detalhe local da implementação?',
    blocking: false, decideBy: 'executor' }] }
  f.save(state)
  const begun = f.cli('begin-discussion', 'T1')
  assert.equal(begun.status, 0, f.output(begun))
  assert.doesNotMatch(f.output(begun), /scheduled question/)
  makeLegacy(f)
  const legacy = f.state()
  legacy.tasks.T1.state = 'pending'
  f.save(legacy)
  const started = f.cli('start', 'T1', '--agent', 'executor')
  assert.equal(started.status, 0, f.output(started))
  assert.equal(f.state().tasks.T1.state, 'running')
  assert.equal(f.state().tasks.T1.taskPlan.openQuestions[0].answer, undefined)
})

test('discussão duplicada é recusada e exclusão explícita encerra a rodada sem conclusão fictícia', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('begin-discussion', 'T1').status, 0)
  const before = f.snapshot()
  const duplicate = f.cli('begin-discussion', 'T1')
  assert.equal(duplicate.status, 1, f.output(duplicate))
  assert.match(f.output(duplicate), /already has an open discussion/)
  assert.deepEqual(f.snapshot(), before)
  const skipped = f.cli('skip', 'T1', '--reason', 'Entrega dispensada explicitamente')
  assert.equal(skipped.status, 0, f.output(skipped))
  const task = f.state().tasks.T1
  assert.equal(task.state, 'skipped')
  assert.equal(task.discussionAttempts.at(-1).result, 'skipped')
  assert.ok(task.discussionAttempts.at(-1).endedAt)
  assert.equal(task.attempts.length, 0)
})

test('migração de estado antigo sem listas opcionais conserva uma cópia exata e adota os gates', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.schemaVersion = 0
  state.plan.planningMode = 'phase'
  delete state.plan.phases
  delete state.phaseWorkflows
  delete state.tasks.T1.attempts
  delete state.tasks.T1.planningRequired
  f.save(state)
  const original = readFileSync(f.statePath, 'utf8')
  const result = f.cli('migrate')
  assert.equal(result.status, 0, f.output(result))
  const migrated = f.state()
  assert.deepEqual(migrated.phaseWorkflows, {})
  assert.equal(migrated.tasks.T1.discussionRequired, true)
  assert.equal(migrated.tasks.T1.planningRequired, true)
  assert.equal(readFileSync(join(dirname(f.statePath), `state.pre-migrate-v${migrated.schemaVersion}.json`), 'utf8'), original)
})

test('perguntas futuras não tratam históricos ausentes como atividade já iniciada', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  const baseline = f.state()
  baseline.plan.planningMode = 'phase'
  baseline.plan.phases = [{ id: 'P1', title: 'Fase futura' }]
  baseline.tasks.T2 = { id: 'T2', title: 'Entrega futura', phase: 'P1', state: 'pending', deps: [],
    validation: structuredClone(baseline.tasks.T1.validation), planningRequired: false }
  baseline.tasks.T1.taskPlan = { openQuestions: [{ question: 'Qual regra aplicar na entrega futura?',
    blocking: false, decideBy: { beforeTask: 'T2' } }] }
  for (const workflow of [
    { id: 'P1', state: 'pending' },
    { id: 'P1', state: 'pending', planningAttempts: [{ endedAt: '2026-01-01T00:00:00Z' }] },
  ]) {
    const state = structuredClone(baseline)
    state.phaseWorkflows = { P1: workflow }
    f.save(state)
    const before = f.snapshot()
    const result = f.cli('ready')
    assert.equal(result.status, 0, f.output(result))
    assert.match(f.output(result), /open question/)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('planejador recusa execução incompatível e contrato importado inválido sem alterar tentativa', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  const baseline = f.state()
  for (const [kind, expected] of [
    ['running', /must be pending/],
    ['paused-without-executor', /original executor/],
    ['invalid-contract', /validation/],
  ]) {
    const state = structuredClone(baseline), task = state.tasks.T1
    if (kind === 'running') task.state = 'running'
    if (kind === 'paused-without-executor') {
      task.state = 'blocked'; task.stateBeforeBlock = 'running'; task.planningRequired = true
    }
    if (kind === 'invalid-contract') task.validation = []
    f.save(state)
    const before = f.snapshot(), result = f.cli('plan-task', 'T1', '--agent', 'planner')
    assert.equal(result.status, 1, f.output(result))
    assert.match(f.output(result), expected)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('refresh-contract usa a fonte persistida e exige fonte explícita quando ela não existe', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const before = f.snapshot(), same = f.cli('refresh-contract', 'T1')
  assert.equal(same.status, 0, f.output(same))
  assert.match(f.output(same), /already matches/)
  assert.deepEqual(f.snapshot(), before)
  const state = f.state()
  delete state.plan.source
  f.save(state)
  const withoutSource = f.snapshot(), result = f.cli('refresh-contract', 'T1')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /refresh-contract needs --plan/)
  assert.deepEqual(f.snapshot(), withoutSource)
})

test('conclusão validada libera a dependência registrada sem marcar a entrega dependente como concluída', t => {
  const f = fixture(t, { requireReview: false })
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.tasks.push({ ...approved.tasks[0], id: 'T2', title: 'Entrega dependente', deps: ['T1'] })
  f.writePlan(approved)
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  const state = f.state()
  Object.assign(state.tasks.T2, { discussionRequired: false, discoveryRequired: false, planningRequired: false })
  f.save(state)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor').status, 0)
  const validation = f.cli('validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Comportamento aprovado verificado')
  assert.equal(validation.status, 0, f.output(validation))
  const done = f.cli('done', 'T1')
  assert.equal(done.status, 0, f.output(done))
  assert.match(f.output(done), /unlocked: T2/)
  assert.equal(f.state().tasks.T2.state, 'pending')
  assert.equal(f.state().tasks.T2.attempts.length, 0)
})

test('escopo de fase ausente em estado importado não cria autorização nem rodada', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  const state = f.state()
  state.plan.planningMode = 'phase'
  delete state.plan.phases
  delete state.phaseWorkflows
  f.save(state)
  const before = f.snapshot()
  for (const args of [
    ['authorize', '--scope', 'phase:P1', '--confirmed-by-user'],
    ['begin-phase-discussion', 'P1'],
    ['plan-phase', 'P1', '--agent', 'planner'],
  ]) {
    const result = f.cli(...args)
    assert.equal(result.status, 1, f.output(result))
    assert.match(f.output(result), /unknown phase/)
    assert.deepEqual(f.snapshot(), before)
  }
  const ready = f.cli('ready')
  assert.equal(ready.status, 0, f.output(ready))
  assert.deepEqual(f.snapshot(), before)
})

test('migração adiada distingue tarefa sem tentativa de execução atual já registrada', t => {
  const f = fixture(t)
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.tasks.push({ ...approved.tasks[0], id: 'T2', title: 'Outra entrega' })
  f.writePlan(approved)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('begin-discussion', 'T1').status, 0)
  const baseline = f.state()
  delete baseline.plan.planningMode
  for (const started of [false, true]) {
    const state = structuredClone(baseline), task = state.tasks.T2
    if (started) {
      task.state = 'running'; task.agent = 'executor'
      task.attempts = [{ agent: 'executor', startedAt: '2026-01-01T00:00:00Z' }]
    } else delete task.attempts
    f.save(state)
    const before = f.snapshot(), result = f.cli('start', 'T2', '--agent', 'executor')
    assert.equal(result.status, 1, f.output(result))
    assert.match(f.output(result), started ? /must be pending|is running/ : /migration is blocked/)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('dependências convergentes não tornam entregas independentes seguras para editar o mesmo caminho', t => {
  const f = fixture(t)
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  const task = approved.tasks[0]
  approved.tasks = [
    { ...task, id: 'T1', deps: ['T2', 'T3'], touches: ['src/shared'] },
    { ...task, id: 'T2', deps: ['T4'] },
    { ...task, id: 'T3', deps: ['T4'] },
    { ...task, id: 'T4' },
    { ...task, id: 'T5', touches: ['src/shared'] },
  ]
  f.writePlan(approved)
  const result = f.init()
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /T1 and T5 can run in parallel but both touch/)
  assert.deepEqual(f.snapshot(), [null, null, null])
})

test('parser de instalação antiga com opção escalar mantém a pergunta de bloqueio utilizável', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const install = join(f.home, 'scalar-option-installation')
  for (const [name, bytes] of installationBundle('en')) {
    const path = join(install, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  writeFileSync(join(install, 'scripts', 'engine-args.mjs'),
    'export function parseEngineArgs() { return { _: ["T1"], question: "Qual regra aprovar?", option: " Preservar contrato ", reason: "Decisão pendente" } }\n')
  assert.equal(readFileSync(join(install, 'scripts', 'engine.mjs'), 'utf8'), readFileSync(engine, 'utf8'))
  const original = structuredClone(f.state().tasks.T1)
  const result = spawnSync(process.execPath, [join(install, 'scripts', 'engine.mjs'), 'block', 'T1'], {
    cwd: f.project, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.status, 0, f.output(result))
  const task = f.state().tasks.T1
  assert.equal(task.state, 'blocked')
  assert.equal(task.blockQuestion, 'Qual regra aprovar?')
  assert.deepEqual(task.blockOptions, ['Preservar contrato'])
  assert.deepEqual(task.attempts, original.attempts)
  assert.deepEqual(task.validation, original.validation)
})

test('sincronização interpreta descrição histórica ausente como descrição vazia sem invalidar trabalho', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  delete state.plan.description
  f.save(state)
  const task = structuredClone(state.tasks.T1)
  const result = f.cli('sync-plan', '--plan', f.planPath)
  assert.equal(result.status, 0, f.output(result))
  assert.deepEqual(f.state().tasks.T1, task)
  assert.equal(f.state().plan.planningRevision, state.plan.planningRevision ?? 1)
})

test('listagem informa migração pendente sem modificar rodadas ou selecionar execução', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('begin-discussion', 'T1').status, 0)
  const state = f.state()
  delete state.plan.planningMode
  f.save(state)
  const before = f.snapshot(), result = f.cli('runs')
  assert.equal(result.status, 0, f.output(result))
  assert.match(f.output(result), /hardening.*migration required/)
  assert.deepEqual(f.snapshot(), before)
})

test('dispensa de tarefa histórica sem lista de fases não cria fases nem tentativas', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  const state = f.state()
  state.plan.planningMode = 'phase'
  delete state.plan.phases
  delete state.phaseWorkflows
  f.save(state)
  const skipped = f.cli('skip', 'T1', '--reason', 'Entrega dispensada explicitamente')
  assert.equal(skipped.status, 0, f.output(skipped))
  const current = f.state()
  assert.equal(current.tasks.T1.state, 'skipped')
  assert.equal(current.tasks.T1.attempts.length, 0)
  assert.equal(current.plan.phases, undefined)
  assert.equal(current.phaseWorkflows, undefined)
})

test('adoção de estado importado sem tentativas não grava rodada parcial nem repara o campo', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  const state = f.state()
  delete state.tasks.T1.attempts
  f.save(state)
  const before = f.snapshot(), result = f.cli('begin-discussion', 'T1', '--adopt-legacy')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /TypeError/)
  assert.deepEqual(f.snapshot(), before)
})

test('migração apenas de schema conserva discussão aberta sem alterar a estrutura atual', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('begin-discussion', 'T1').status, 0)
  const state = f.state(), originalSchema = state.schemaVersion
  state.schemaVersion = originalSchema - 1
  f.save(state)
  const before = readFileSync(f.statePath, 'utf8'), task = structuredClone(state.tasks.T1)
  const result = f.cli('migrate')
  assert.equal(result.status, 0, f.output(result))
  const current = f.state()
  assert.equal(current.schemaVersion, originalSchema)
  assert.equal(current.plan.planningMode, 'task')
  assert.deepEqual(current.tasks.T1, task)
  assert.equal(current.tasks.T1.state, 'discussing')
  assert.equal(readFileSync(join(dirname(f.statePath), `state.pre-migrate-v${originalSchema}.json`), 'utf8'), before)
})

test('init recusa nomes de execução que poderiam atravessar diretórios antes de criar estado', t => {
  const f = fixture(t)
  const result = f.cli('init', '--plan', f.planPath, '--run', '../fora-do-grafo')

  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /invalid run name/)
  assert.equal(existsSync(f.graph), false)
  assert.deepEqual(f.snapshot(), [null, null, null])
})

test('init valida forma do plano antes de criar qualquer run', t => {
  const f = fixture(t)
  const validTask = { id: 'T1', title: 'Entrega', validation: [{ kind: 'functional', run: 'node check.cjs', expect: 'passa' }] }
  const cases = [
    ['sem tarefas', { name: 'sem tarefas', planningMode: 'task', tasks: [] }],
    ['modo inválido', { name: 'modo inválido', planningMode: 'outro', tasks: [validTask] }],
    ['fase duplicada', { name: 'fase duplicada', planningMode: 'phase', phases: [{ id: 'P1' }, { id: 'P1' }], tasks: [{ ...validTask, phase: 'P1' }] }],
    ['tarefa sem id', { name: 'tarefa sem id', planningMode: 'task', tasks: [{ title: 'Entrega', validation: validTask.validation }] }],
    ['tarefa sem título', { name: 'tarefa sem título', planningMode: 'task', tasks: [{ id: 'T1', validation: validTask.validation }] }],
    ['id duplicado', { name: 'id duplicado', planningMode: 'task', tasks: [validTask, { ...validTask }] }],
    ['fase ausente', { name: 'fase ausente', planningMode: 'phase', phases: [{ id: 'P1' }], tasks: [{ ...validTask, phase: 'P2' }] }],
    ['contrato inválido', { name: 'contrato inválido', planningMode: 'task', tasks: [{ id: 'T1', title: 'Entrega', validation: [] }] }],
    ['dependência ausente', { name: 'dependência ausente', planningMode: 'task', tasks: [{ ...validTask, deps: ['T9'] }] }],
    ['dependências herdadas', { name: 'dependências herdadas', planningMode: 'task', tasks: [{ ...validTask, deps: ['constructor', 'toString', '__proto__'] }] }],
    ['ciclo', { name: 'ciclo', planningMode: 'task', tasks: [{ ...validTask, deps: ['T2'] }, { id: 'T2', title: 'Outra', deps: ['T1'], validation: validTask.validation }] }],
  ]
  for (const [index, [label, plan]] of cases.entries()) {
    f.writePlan(plan)
    const result = f.cli('init', '--plan', f.planPath, '--run', `invalid-${index}`)
    assert.notEqual(result.status, 0, `${label}\n${f.output(result)}`)
  }
})

test('comando sem run selecionada informa a pré-condição sem criar arquivos', t => {
  const f = fixture(t)
  const missing = f.cli()
  assert.equal(missing.status, 1, f.output(missing))
  assert.match(f.output(missing), /unknown engine command/i)
  const result = f.cli('status')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /no run selected/i)
  assert.equal(existsSync(f.graph), false)
})

test('raiz explícita inexistente falha antes de interpretar o comando', t => {
  const f = fixture(t)
  f.env.PRUMO_ROOT = join(f.home, 'workspace-ausente')
  const result = f.cli('runs')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /PRUMO_ROOT points to/)
})

test('CURRENT ilegível não impede consulta com --run explícito', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))
  rmSync(f.currentPath)
  mkdirSync(f.currentPath)
  const result = f.cli('status', '--run', 'hardening')
  assert.equal(result.status, 0, f.output(result))
})

test('init não sobrescreve run existente sem --force', t => {
  const f = fixture(t)
  const first = f.init()
  assert.equal(first.status, 0, f.output(first))
  const before = f.snapshot()
  const second = f.init()
  assert.equal(second.status, 1, f.output(second))
  assert.match(f.output(second), /already exists/i)
  assert.deepEqual(f.snapshot(), before)
})

test('autorizações inválidas e confirmações ausentes falham sem alterar estado, eventos ou seleção', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))

  const cases = [
    ['authorize', '--confirmed-by-user'],
    ['authorize', '--scope', 'run'],
    ['authorize', '--scope', 'phase:INEXISTENTE', '--confirmed-by-user'],
    ['authorize', '--scope', 'tasks:T1,T1', '--confirmed-by-user'],
    ['authorize', '--scope', 'tasks:T1,INEXISTENTE', '--confirmed-by-user'],
    ['authorize', '--scope', 'tasks:constructor', '--confirmed-by-user'],
    ['authorize', '--scope', 'tasks:__proto__', '--confirmed-by-user'],
    ['authorize', '--scope', 'tasks:', '--confirmed-by-user'],
    ['authorize', '--scope', 'phase:P1:extra', '--confirmed-by-user'],
    ['authorize', '--scope', 'tasks:T1', '--mode', 'desconhecido', '--confirmed-by-user'],
    ['authorize', '--scope', 'tasks:T1', '--channel', '   ', '--confirmed-by-user'],
  ]
  for (const args of cases) {
    const before = f.snapshot()
    const result = f.cli(...args)
    assert.equal(result.status, 1, `${args.join(' ')}\n${f.output(result)}`)
    assert.deepEqual(f.snapshot(), before, `falha de autorização gravou dados: ${args.join(' ')}`)
  }
})

test('comandos desconhecidos e dispensa sem justificativa preservam os dados da execução', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const before = f.snapshot()
  for (const args of [
    ['comando-inexistente'], ['constructor'],
    ['authorize', '--scope', 'grupo:T1', '--confirmed-by-user'],
    ['skip-discussion', 'T1', '--confirmed-by-user'],
  ]) {
    const result = f.cli(...args)
    assert.equal(result.status, 1, f.output(result))
    assert.deepEqual(f.snapshot(), before)
  }
})

test('instalação com parser divergente recusa comando sem handler antes de gravar dados', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const install = join(f.home, 'installation')
  for (const [name, bytes] of installationBundle('en')) {
    const path = join(install, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  // A dependência adulterada representa uma instalação parcial; o motor mantém seus bytes originais.
  writeFileSync(join(install, 'scripts', 'engine-args.mjs'), 'export function parseEngineArgs() { return { _: [] } }\n')
  const before = f.snapshot()
  const result = spawnSync(process.execPath, [join(install, 'scripts', 'engine.mjs'), 'sem-handler'], {
    cwd: f.project, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /usage: engine\.mjs/)
  assert.deepEqual(f.snapshot(), before)
})

test('dependência de métricas defeituosa não transforma uma consulta bem-sucedida em falha', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const install = join(f.home, 'installation')
  for (const [name, bytes] of installationBundle('en')) {
    const path = join(install, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  const metrics = join(install, 'scripts', 'command-metrics.mjs')
  const source = readFileSync(metrics, 'utf8').replace('export function recordCommand(', 'export function originalRecordCommand(')
  writeFileSync(metrics, source + '\nexport function recordCommand() { throw new Error("metrics dependency failed") }\n')
  const before = f.snapshot()
  const result = spawnSync(process.execPath, [join(install, 'scripts', 'engine.mjs'), 'status'], {
    cwd: f.project, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.status, 0, f.output(result))
  assert.match(f.output(result), /run: hardening/)
  assert.doesNotMatch(f.output(result), /metrics dependency failed/)
  assert.deepEqual(f.snapshot(), before)
})

test('dependência de validação sem checks não produz uma aprovação nem perde a tentativa', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  for (const command of ['skip-discussion', 'skip-planning'])
    assert.equal(f.cli(command, 'T1', '--reason', 'Contrato aceito', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor').status, 0)
  assert.equal(f.cli('review', 'T1', '--agent', 'revisor').status, 0)
  const before = f.state().tasks.T1.attempts[0]
  const install = join(f.home, 'installation')
  for (const [name, bytes] of installationBundle('en')) {
    const path = join(install, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  const validation = join(install, 'scripts', 'validation.mjs')
  const source = readFileSync(validation, 'utf8').replace('export async function runValidation(', 'export async function originalRunValidation(')
  writeFileSync(validation, source + '\nexport async function runValidation(...args) { const result = await originalRunValidation(...args); delete result.checks; return result }\n')
  const result = spawnSync(process.execPath, [join(install, 'scripts', 'engine.mjs'), 'validate', 'T1', '--ok',
    '--evidence', 'Comportamento verificado', '--cwd', f.project], {
    cwd: f.project, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /receipt has no checks/)
  assert.equal(f.state().tasks.T1.validations.at(-1).ok, false)
  assert.equal(f.state().tasks.T1.state, 'reviewing')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
  assert.equal(f.state().tasks.T1.attempts[0].startedAt, before.startedAt)
})

test('saída sem código de término exibe diagnóstico desconhecido e nunca aprova a checagem', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  for (const command of ['skip-discussion', 'skip-planning'])
    assert.equal(f.cli(command, 'T1', '--reason', 'Contrato aceito', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor').status, 0)
  assert.equal(f.cli('review', 'T1', '--agent', 'revisor').status, 0)
  const install = join(f.home, 'installation')
  for (const [name, bytes] of installationBundle('en')) {
    const path = join(install, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  const validation = join(install, 'scripts', 'validation.mjs')
  const source = readFileSync(validation, 'utf8').replace('export async function runValidation(', 'export async function originalRunValidation(')
  writeFileSync(validation, source + '\nexport async function runValidation(...args) { const result = await originalRunValidation(...args); result.checks[0].exitCode = null; return result }\n')
  const result = spawnSync(process.execPath, [join(install, 'scripts', 'engine.mjs'), 'validate', 'T1', '--ok',
    '--evidence', 'Checagem sem status confiável', '--cwd', f.project, '--tail', '1'], {
    cwd: f.project, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /output tail.*exit unknown/)
  const receipt = f.state().tasks.T1.validations.at(-1)
  assert.equal(receipt.ok, false)
  assert.equal(receipt.checks[0].exitCode, null)
  assert.match(receipt.checks[0].stdout, /comportamento verificado/)
  assert.equal(f.state().tasks.T1.attempts.length, 1)
})

test('autorização por fase alcança somente suas tarefas e preserva outras fases', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.plan.phases = [{ id: 'P1' }, { id: 'P2' }]
  state.tasks.T1.phase = 'P1'
  state.tasks.T2 = { ...structuredClone(state.tasks.T1), id: 'T2', phase: 'P2' }
  f.save(state)
  const result = f.cli('authorize', '--scope', 'phase:P1', '--confirmed-by-user')
  assert.equal(result.status, 0, f.output(result))
  assert.deepEqual(f.state().authorizations.at(-1).taskIds, ['T1'])
  assert.equal(f.state().tasks.T1.executionAuthorization.scope, 'phase:P1')
  assert.equal(f.state().tasks.T2.executionAuthorization, undefined)
})

test('autorização manual grava escopo de tarefa somente após confirmação', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))
  const result = f.cli('authorize', '--scope', 'tasks:T1', '--mode', 'manual', '--channel', 'cli', '--confirmed-by-user')
  assert.equal(result.status, 0, f.output(result))
  const state = f.state()
  assert.equal(state.tasks.T1.executionAuthorization.mode, 'manual')
  assert.equal(state.tasks.T1.executionAuthorization.scope, 'tasks:T1')
  assert.equal(state.authorizations.at(-1).confirmedByUser, true)
})

test('confirmação manual recusa canal vazio e recompõe recibos históricos sem apagar datas desconhecidas', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  for (const command of ['skip-discussion', 'skip-planning'])
    assert.equal(f.cli(command, 'T1', '--reason', 'Contrato aceito', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('authorize', '--scope', 'run', '--mode', 'manual', '--confirmed-by-user').status, 0)
  const before = f.snapshot()
  const invalid = f.cli('start', 'T1', '--agent', 'executor', '--channel', ' ', '--confirmed-by-user')
  assert.equal(invalid.status, 1, f.output(invalid))
  assert.match(f.output(invalid), /confirmation channel must be nonempty/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('review', 'T1', '--agent', 'revisor', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('fail', 'T1', '--reason', 'Correção delimitada necessária').status, 0)
  const state = f.state(), attempt = state.tasks.T1.attempts.at(-1)
  attempt.manualConfirmations = [{ action: 'review', at: '2026-01-03T00:00:00Z', channel: 'known' }]
  attempt.manualDispatchConfirmation = { at: 'data desconhecida', channel: 'dispatch-legacy' }
  attempt.manualReviewConfirmation = { at: '2026-01-02T00:00:00Z', channel: 'review-legacy' }
  attempt.manualRetryConfirmation = { at: 'data desconhecida', channel: 'retry-legacy' }
  attempt.manualResumeConfirmation = { at: '2026-01-01T00:00:00Z', channel: 'resume-legacy' }
  f.save(state)
  const retry = f.cli('retry', 'T1', '--confirmed-by-user')
  assert.equal(retry.status, 0, f.output(retry))
  const history = f.state().tasks.T1.attempts.at(-1).manualConfirmations
  assert.deepEqual(history.map(item => item.channel),
    ['resume-legacy', 'review-legacy', 'known', 'dispatch-legacy', 'retry-legacy', 'cli'])
  assert.equal(history[3].at, 'data desconhecida')
  assert.equal(history[4].at, 'data desconhecida')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
})

test('execução legada pausada exige nova autorização após mudança aprovada sem perder tentativa', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  assert.equal(f.cli('authorize', '--scope', 'run', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor').status, 0)
  assert.equal(f.cli('block', 'T1', '--reason', 'Contrato será atualizado').status, 0)
  const originalAttempt = structuredClone(f.state().tasks.T1.attempts[0])
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.tasks[0].title = 'Entrega com contrato atualizado'
  f.writePlan(approved)
  const sync = f.cli('sync-plan', '--plan', f.planPath)
  assert.equal(sync.status, 0, f.output(sync))
  const before = f.snapshot(), denied = f.cli('unblock', 'T1')
  assert.equal(denied.status, 1, f.output(denied))
  assert.match(f.output(denied), /no execution authorization/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.cli('authorize', '--scope', 'run', '--confirmed-by-user').status, 0)
  const resumed = f.cli('unblock', 'T1')
  assert.equal(resumed.status, 0, f.output(resumed))
  assert.equal(f.state().tasks.T1.state, 'running')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
  assert.equal(f.state().tasks.T1.attempts[0].startedAt, originalAttempt.startedAt)
  assert.equal(f.state().tasks.T1.authorizationHistory.length, 1)
})

test('histórico de autorização de outra tarefa impede execução sem escopo em importação antiga', t => {
  const f = fixture(t)
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.tasks.push({ ...structuredClone(approved.tasks[0]), id: 'T2', title: 'Outra entrega' })
  f.writePlan(approved)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.authorizations = []
  state.tasks.T2.authorizationHistory = [{ scope: 'tasks:T2', mode: 'auto', confirmedByUser: true,
    at: '2026-01-01T00:00:00Z', revokedAt: '2026-01-02T00:00:00Z' }]
  f.save(state)
  const before = f.snapshot(), result = f.cli('start', 'T1', '--agent', 'executor')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /no execution authorization/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.state().tasks.T1.attempts.length, 0)
  assert.equal(f.state().tasks.T2.authorizationHistory.length, 1)
})

test('fingerprint defeituoso não permite planejar sobre dependência que voltou a ficar pendente', t => {
  const f = fixture(t)
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.tasks[0].deps = ['T2']
  approved.tasks.push({ id: 'T2', title: 'Entrada da entrega', validation: approved.tasks[0].validation })
  f.writePlan(approved)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('skip', 'T2', '--reason', 'Entrada dispensada explicitamente').status, 0)
  assert.equal(f.cli('skip-discussion', 'T1', '--reason', 'Contrato aceito', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('plan-task', 'T1', '--agent', 'planejador').status, 0)
  const state = f.state(), context = state.tasks.T1.planningAttempts.at(-1).context
  state.tasks.T2.state = 'pending'
  f.save(state)
  const install = join(f.home, 'installation')
  for (const [name, bytes] of installationBundle('en')) {
    const path = join(install, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  const validation = join(install, 'scripts', 'validation.mjs')
  const source = readFileSync(validation, 'utf8').replace('export function planningContext(', 'export function originalPlanningContext(')
  writeFileSync(validation, source + `\nexport function planningContext() { return ${JSON.stringify(context)} }\n`)
  const before = f.snapshot()
  const result = spawnSync(process.execPath, [join(install, 'scripts', 'engine.mjs'), 'finish-planning', 'T1', '--plan', f.planPath], {
    cwd: f.project, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /dependencies are no longer complete/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.state().tasks.T1.taskPlan, undefined)
  assert.equal(f.state().tasks.T1.planningAttempts.length, 1)
})

test('revisão e planejamento incompletos são recusados sem criar uma tentativa', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const before = f.snapshot()
  for (const [args, pattern] of [
    [['review', 'T1'], /review needs --agent/],
    [['review', 'T1', '--agent', 'revisor'], /not running/],
    [['review-progress', 'T1', '--step', '1', '--agent', 'revisor'], /not in review/],
    [['finish-planning', 'T1'], /needs --plan/],
  ]) {
    const result = f.cli(...args)
    assert.equal(result.status, 1, f.output(result))
    assert.match(f.output(result), pattern)
    assert.deepEqual(f.snapshot(), before)
  }
  const state = f.state()
  state.tasks.T1.state = 'planning'
  f.save(state)
  const missing = f.snapshot(), result = f.cli('finish-planning', 'T1', '--plan', f.planPath)
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /needs an open round/)
  assert.deepEqual(f.snapshot(), missing)
})

test('retomada recusa resposta sem pergunta e planejamento sem o planejador original', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('block', 'T1', '--reason', 'Pausa sem decisão pendente').status, 0)
  let before = f.snapshot(), result = f.cli('unblock', 'T1', '--answer', 'Sim')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /requires a current block question/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.cli('unblock', 'T1').status, 0)
  assert.equal(f.cli('begin-discussion', 'T1').status, 0)
  assert.equal(f.cli('block', 'T1', '--reason', 'Pesquisa pausada').status, 0)
  assert.equal(f.cli('unblock', 'T1').status, 0)
  assert.equal(f.state().tasks.T1.state, 'pending')
  assert.equal(f.cli('skip-discussion', 'T1', '--reason', 'Contrato aceito', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('plan-task', 'T1', '--agent', 'planejador').status, 0)
  assert.equal(f.cli('block', 'T1', '--reason', 'Planejamento pausado').status, 0)
  const state = f.state()
  state.tasks.T1.planningAttempts.at(-1).agent = 'outro'
  f.save(state)
  before = f.snapshot(); result = f.cli('unblock', 'T1')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /original planner/)
  assert.deepEqual(f.snapshot(), before)
})

test('autorização resolve nome legado e inspeção documental exige um critério explícito', t => {
  const f = fixture(t)
  const plan = JSON.parse(readFileSync(f.planPath, 'utf8'))
  delete plan.tasks[0].validation
  plan.tasks[0].validationMode = 'inspection'
  plan.tasks[0].inspectionReason = 'O contrato descreve conteúdo documental que será inspecionado.'
  f.writePlan(plan)
  const before = f.snapshot(), missing = f.init()
  assert.equal(missing.status, 1, f.output(missing))
  assert.match(f.output(missing), /inspection validation must not be empty/)
  assert.deepEqual(f.snapshot(), before)
  plan.tasks[0].validation = 'Revisar o conteúdo documental contra o contrato aprovado.'
  f.writePlan(plan)
  const initialized = f.init()
  assert.equal(initialized.status, 0, f.output(initialized))
  assert.equal(f.state().tasks.T1.validation, plan.tasks[0].validation)
  const state = f.state()
  state.taskIdAliases = { entrega: 'T1' }
  f.save(state)
  const authorization = f.cli('authorize', '--scope', 'tasks:entrega', '--confirmed-by-user')
  assert.equal(authorization.status, 0, f.output(authorization))
  assert.deepEqual(f.state().authorizations.at(-1).taskIds, ['T1'])
  assert.equal(f.state().tasks.T1.executionAuthorization.scope, 'tasks:T1')
})

test('sync preserva validação de entrega terminal mesmo se a fonte histórica omitir o campo', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('skip', 'T1', '--reason', 'Entrega dispensada explicitamente').status, 0)
  const before = f.state().tasks.T1
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  delete approved.tasks[0].validation
  f.writePlan(approved)
  const result = f.cli('sync-plan', '--plan', f.planPath)
  assert.equal(result.status, 0, f.output(result))
  assert.deepEqual(f.state().tasks.T1, before)
  assert.deepEqual(f.state().tasks.T1.validation, before.validation)
})

test('sync durante migração adiada preserva discussão legada e valida a mudança aprovada', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('begin-discussion', 'T1').status, 0)
  const state = f.state()
  delete state.plan.planningMode
  f.save(state)
  const original = structuredClone(state.tasks.T1.discussionAttempts)
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.tasks[0].title = 'Contrato atualizado durante discussão'
  f.writePlan(approved)
  const result = f.cli('sync-plan', '--plan', f.planPath)
  assert.equal(result.status, 0, f.output(result))
  assert.match(f.output(result), /Migration deferred/)
  assert.deepEqual(f.state().tasks.T1.discussionAttempts, original)
  assert.equal(f.state().tasks.T1.title, approved.tasks[0].title)
  assert.equal(f.state().plan.planningMode, undefined)
})

test('diagnóstico de migração lê campos ausentes sem gravar reparo automático', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const baseline = f.state()
  for (const variant of ['missing-tasks', 'phase-without-list', 'legacy-without-attempts']) {
    const state = structuredClone(baseline)
    state.schemaVersion = 0
    if (variant === 'missing-tasks') { delete state.tasks; state.plan = {} }
    if (variant === 'phase-without-list') { state.plan.planningMode = 'phase'; delete state.plan.phases }
    if (variant === 'legacy-without-attempts') {
      delete state.plan.planningMode
      delete state.tasks.T1.attempts
    }
    f.save(state)
    const before = f.snapshot(), result = f.cli('migrate', '--check')
    assert.equal(result.status, 0, f.output(result))
    assert.match(f.output(result), /needs schema migration/)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('artefatos sem arrays obrigatórios são rejeitados e arrays vazios válidos preservam o contrato', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('skip-discussion', 'T1', '--reason', 'Contrato aceito', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('plan-task', 'T1', '--agent', 'planejador').status, 0)
  const artifact = { research: [{ source: 'Contrato', findings: 'Comportamento confirmado' }], decisions: [],
    steps: ['Implementar o comportamento aprovado e verificar sua entrega'],
    verification: [{ criterion: 'o comportamento aprovado passa', check: 1 }], openQuestions: [] }
  const path = join(f.project, 'task-plan.json')
  for (const field of ['decisions', 'openQuestions']) {
    const invalid = structuredClone(artifact)
    delete invalid[field]
    writeFileSync(path, JSON.stringify(invalid))
    const before = f.snapshot(), result = f.cli('finish-planning', 'T1', '--plan', path)
    assert.equal(result.status, 1, f.output(result))
    assert.match(f.output(result), /decisions|openQuestions/)
    assert.deepEqual(f.snapshot(), before)
  }
  const sparse = f.state()
  delete sparse.plan.phases
  f.save(sparse)
  writeFileSync(path, JSON.stringify({ ...artifact, openQuestions: [{ question: 'Qual regra futura?',
    blocking: false, decideBy: { beforePhase: 'inexistente' } }] }))
  const before = f.snapshot(), invalidDeadline = f.cli('finish-planning', 'T1', '--plan', path)
  assert.equal(invalidDeadline.status, 1, f.output(invalidDeadline))
  assert.match(f.output(invalidDeadline), /unknown phase/)
  assert.deepEqual(f.snapshot(), before)
  writeFileSync(path, JSON.stringify(artifact))
  const result = f.cli('finish-planning', 'T1', '--plan', path)
  assert.equal(result.status, 0, f.output(result))
  assert.deepEqual(f.state().tasks.T1.taskPlan.decisions, [])
  assert.deepEqual(f.state().tasks.T1.taskPlan.openQuestions, [])
  const state = f.state()
  delete state.tasks.T1.planningAttempts.at(-1).artifactCount
  f.save(state)
  assert.match(f.output(f.cli('status')), /planning round T1.*artifacts 1\/1/)
  delete state.tasks.T1.taskPlan
  f.save(state)
  assert.match(f.output(f.cli('status')), /planning round T1.*artifacts 0\/1/)
  state.tasks.T1.taskPlan = { startedAt: 'outra rodada' }
  f.save(state)
  assert.match(f.output(f.cli('status')), /planning round T1.*artifacts 0\/1/)
})

test('status mantém compatibilidade com pergunta antiga sem prazo declarado', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.tasks.T1.taskPlan = { openQuestions: [{ question: 'Detalhe a decidir na implementação', blocking: false }] }
  f.save(state)
  const before = f.snapshot(), result = f.cli('status')
  assert.equal(result.status, 0, f.output(result))
  assert.doesNotMatch(f.output(result), /open question .*Detalhe a decidir/)
  assert.deepEqual(f.snapshot(), before)
})

test('fase ainda não adotada em estado importado não aparece pronta para executar', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.legacyPhaseAdoption = true
  state.tasks.T1.phase = 'P1'
  state.phaseWorkflows = { P1: { id: 'P1', state: 'pending', adoptedLegacy: false } }
  f.save(state)
  const before = f.snapshot(), graph = f.cli('graph')
  assert.equal(graph.status, 0, f.output(graph))
  assert.equal(JSON.parse(graph.stdout).derived.T1.effective, 'pending')
  assert.deepEqual(f.snapshot(), before)
})

test('status identifica discussão ativa e conserva referências legadas encadeadas na consulta', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('begin-discussion', 'T1').status, 0)
  const state = f.state()
  state.taskIdAliases = { antigo: 'intermediario', intermediario: 'T1' }
  f.save(state)
  const before = f.snapshot(), status = f.cli('status')
  assert.equal(status.status, 0, f.output(status))
  assert.match(f.output(status), /@orchestrator.*discussing/)
  const contract = f.cli('show-contract', 'antigo')
  assert.equal(contract.status, 0, f.output(contract))
  assert.match(f.output(contract), /T1/)
  assert.deepEqual(f.snapshot(), before)
})

test('inspeção sem revisão obrigatória exige agente e registra critérios percorridos antes de aprovar', t => {
  const f = fixture(t, { requireReview: false })
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.tasks[0].validation = 'Documento coerente com o contrato aprovado.'
  approved.tasks[0].validationMode = 'inspection'
  approved.tasks[0].inspectionReason = 'O resultado esperado é um documento, cuja qualidade exige inspeção.'
  f.writePlan(approved)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('skip-discussion', 'T1', '--reason', 'Contrato aceito', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('plan-task', 'T1', '--agent', 'planejador').status, 0)
  const path = join(f.project, 'task-plan.json')
  writeFileSync(path, JSON.stringify({ research: [{ source: 'Documento', findings: 'Critério inspecionado' }],
    decisions: [], steps: ['Inspecionar o documento contra o contrato'],
    verification: [{ criterion: approved.tasks[0].validation, check: 'inspection' }], openQuestions: [] }))
  assert.equal(f.cli('finish-planning', 'T1', '--plan', path).status, 0)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor').status, 0)
  let before = f.snapshot()
  const wrongAgent = f.cli('review-progress', 'T1', '--agent', 'outro', '--step', '1')
  assert.equal(wrongAgent.status, 1, f.output(wrongAgent))
  assert.match(f.output(wrongAgent), /current reviewing agent/)
  assert.deepEqual(f.snapshot(), before)
  const checked = f.cli('review-progress', 'T1', '--agent', 'executor', '--step', '1')
  assert.equal(checked.status, 0, f.output(checked))
  const validation = f.cli('validate', 'T1', '--ok', '--evidence', 'Documento inspecionado contra o contrato')
  assert.equal(validation.status, 0, f.output(validation))
  const receipt = f.state().tasks.T1.validations.at(-1)
  assert.equal(receipt.ok, true)
  assert.equal(receipt.by, 'executor')
  assert.deepEqual(receipt.checks, [])
  assert.equal(f.state().tasks.T1.attempts.at(-1).reviewProgress.traversed, 1)
})

test('perguntas malformadas introduzidas durante checagem impedem aprovação sem perder resultado executado', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  for (const command of ['skip-discussion', 'skip-planning'])
    assert.equal(f.cli(command, 'T1', '--reason', 'Contrato aceito', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor').status, 0)
  assert.equal(f.cli('review', 'T1', '--agent', 'revisor').status, 0)
  writeFileSync(join(f.project, 'check.cjs'), `const fs = require('node:fs')
const path = ${JSON.stringify(f.statePath)}
const state = JSON.parse(fs.readFileSync(path, 'utf8'))
state.tasks.T1.taskPlan = { openQuestions: {} }
fs.writeFileSync(path, JSON.stringify(state))
`)
  const result = f.cli('validate', 'T1', '--ok', '--evidence', 'Checagem executada', '--cwd', f.project)
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /entries is not a function/)
  const task = f.state().tasks.T1, receipt = task.validations.at(-1)
  assert.equal(receipt.ok, false)
  assert.ok(Array.isArray(receipt.checks), `${f.output(result)}\n${receipt.error}`)
  assert.equal(receipt.checks[0].exitCode, 0)
  assert.equal(task.state, 'reviewing')
  assert.equal(task.attempts.length, 1)
  assert.deepEqual(task.taskPlan.openQuestions, {})
})

test('atividade de fase em importação incompleta não fabrica tarefas nem apaga a rodada', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  delete state.tasks
  state.plan.planningMode = 'phase'
  state.plan.phases = [{ id: 'P1' }]
  state.phaseWorkflows = { P1: { id: 'P1', state: 'discussing', planningAttempts: [],
    discussionAttempts: [{ n: 1, startedAt: '2026-01-01T00:00:00Z', targets: [] }] } }
  f.save(state)
  for (const command of ['activity-start', 'activity-stop']) {
    const result = f.cli(command, 'P1', '--scope', 'phase', '--role', 'discussion', '--agent', 'orquestrador')
    assert.equal(result.status, 0, f.output(result))
  }
  const after = f.state()
  assert.equal(Object.hasOwn(after, 'tasks'), false)
  assert.equal(after.phaseWorkflows.P1.discussionAttempts.length, 1)
  assert.ok(after.phaseWorkflows.P1.discussionAttempts[0].activityIntervals[0].endedAt)
  const before = f.snapshot(), queried = f.cli('status')
  assert.equal(queried.status, 1, f.output(queried))
  assert.deepEqual(f.snapshot(), before)
})

test('autorização de registro legado usa a chave existente e conserva seu alias de consulta', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.tasks.T1.id = 'entrega'
  state.taskIdAliases = { entrega: 'T1' }
  f.save(state)
  const result = f.cli('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  assert.equal(result.status, 0, f.output(result))
  assert.deepEqual(Object.keys(f.state().tasks), ['T1'])
  assert.deepEqual(f.state().authorizations.at(-1).taskIds, ['T1'])
  const before = f.snapshot(), contract = f.cli('show-contract', 'entrega')
  assert.equal(contract.status, 0, f.output(contract))
  assert.match(f.output(contract), /entrega/)
  assert.deepEqual(f.snapshot(), before)
})

test('tentativa legada sem lista de dependências não conclui sem recibo de validação', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor').status, 0)
  const state = f.state()
  delete state.tasks.T1.deps
  f.save(state)
  const before = f.snapshot(), result = f.cli('done', 'T1')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /no passing validation/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.state().tasks.T1.attempts.length, 1)
})

test('skip-discussion e skip-planning registram decisões explícitas antes da execução', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))

  const skippedDiscussion = f.cli('skip-discussion', 'T1', '--reason', 'Contrato já está claro', '--confirmed-by-user')
  assert.equal(skippedDiscussion.status, 0, f.output(skippedDiscussion))
  const afterDiscussion = f.state().tasks.T1
  assert.equal(afterDiscussion.discussionSkips.at(-1).confirmedByUser, true)
  assert.equal(afterDiscussion.state, 'pending')

  const skippedPlanning = f.cli('skip-planning', 'T1', '--reason', 'Execução manual autorizada', '--confirmed-by-user')
  assert.equal(skippedPlanning.status, 0, f.output(skippedPlanning))
  const afterPlanning = f.state().tasks.T1
  assert.equal(afterPlanning.planningSkips.at(-1).confirmedByUser, true)
  assert.equal(afterPlanning.state, 'pending')
  const events = readFileSync(f.eventsPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.slice(-2).map(event => event.type), ['task_discussion_skipped', 'task_planning_skipped'])
})

test('manualEstimate aceita formatos de duração e rejeita valores inválidos antes de criar o run', t => {
  const f = fixture(t)
  const values = [45, '4h', '4h30', '90m', '45min', 'PT4H30M']
  f.writePlan({
    name: 'Estimativas válidas', planningMode: 'task', requireReview: true,
    tasks: values.map((manualEstimate, index) => ({ id: `T${index + 1}`, title: `Entrega ${index + 1}`, manualEstimate,
      validation: [{ kind: 'functional', run: 'node check.cjs', expect: 'passa' }] })),
  })
  const valid = f.cli('init', '--plan', f.planPath, '--run', 'estimativas')
  assert.equal(valid.status, 0, f.output(valid))

  const invalid = fixture(t)
  invalid.writePlan({
    name: 'Estimativa inválida', planningMode: 'task', tasks: [{ id: 'T1', title: 'Entrega', manualEstimate: '2h60',
      validation: [{ kind: 'functional', run: 'node check.cjs', expect: 'passa' }] }],
  })
  const rejected = invalid.cli('init', '--plan', invalid.planPath, '--run', 'estimativa-invalida')
  assert.notEqual(rejected.status, 0, invalid.output(rejected))
  assert.match(invalid.output(rejected), /manualEstimate/)
  assert.deepEqual(invalid.snapshot(), [null, null, null])
})

test('comandos legados resolvem alias de tarefa antes da leitura do contrato', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))
  const state = f.state()
  state.taskIdAliases = { legado: 'T1' }
  f.save(state)
  const missing = f.cli('show-contract')
  assert.equal(missing.status, 1, f.output(missing))
  const result = f.cli('show-contract', 'legado')
  assert.equal(result.status, 0, f.output(result))
  assert.equal(JSON.parse(result.stdout).task, 'T1')
})

test('IDs herdados do protótipo são rejeitados sem criar estado', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))

  for (const id of ['toString', 'constructor']) {
    const before = f.snapshot()
    const result = f.cli('start', id, '--agent', 'executor')
    assert.equal(result.status, 1, `${id}\n${f.output(result)}`)
    assert.match(f.output(result), new RegExp(`(?:unknown task|${id} is undefined, not pending)`, 'i'))
    assert.deepEqual(f.snapshot(), before, `a tarefa herdada gravou estado: ${id}`)
  }
})

test('lookup exige propriedade própria, mas preserva tarefas legadas toString e constructor', t => {
  const f = fixture(t)
  f.writePlan({
    name: 'IDs especiais',
    planningMode: 'task',
    requireReview: false,
    tasks: [
      { id: 'toString', title: 'Texto', validation: [{ kind: 'functional', run: 'node check.cjs', expect: 'passa' }] },
      { id: 'constructor', title: 'Construtor', validation: [{ kind: 'functional', run: 'node check.cjs', expect: 'passa' }] },
    ],
  })
  const init = initializeLegacyPlanFixture(f.cli, f.planPath, f.root, 'hardening')
  assert.equal(init.status, 0, f.output(init))
  for (const id of ['toString', 'constructor']) {
    const result = f.cli('show-contract', id)
    assert.equal(result.status, 0, `${id}\n${f.output(result)}`)
    assert.equal(JSON.parse(result.stdout).task, id)
  }

  const before = f.snapshot()
  const absent = f.cli('start', '__proto__', '--agent', 'executor')
  assert.equal(absent.status, 1, f.output(absent))
  assert.match(f.output(absent), /unknown task/i)
  assert.deepEqual(f.snapshot(), before)
})

test('lookup de fase também ignora propriedades herdadas', t => {
  const f = fixture(t)
  f.writePlan({
    name: 'Fase especial',
    planningMode: 'phase',
    phases: [{ id: 'toString', title: 'Fase texto' }],
    tasks: [{ id: 'T1', title: 'Entrega', phase: 'toString', validation: [{ kind: 'functional', run: 'node check.cjs', expect: 'passa' }] }],
  })
  const init = initializeLegacyPlanFixture(f.cli, f.planPath, f.root, 'hardening')
  assert.equal(init.status, 0, f.output(init))
  const begun = f.cli('begin-phase-discussion', 'toString')
  assert.equal(begun.status, 0, f.output(begun))

  const before = f.snapshot()
  const absent = f.cli('begin-phase-discussion', 'constructor')
  assert.equal(absent.status, 1, f.output(absent))
  assert.match(f.output(absent), /unknown phase/i)
  assert.deepEqual(f.snapshot(), before)
})

test('start exige agente explícito e consistente antes de iniciar a tarefa', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))
  for (const args of [
    ['start', '--agent', 'executor'],
    ['start', 'T1'],
    ['start', 'T1', '--agent', 'executor', '--executor', 'outro'],
    ['start', 'T1', '--agent', '   '],
  ]) {
    const before = f.snapshot()
    const result = f.cli(...args)
    assert.equal(result.status, 1, `${args.join(' ')}\n${f.output(result)}`)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('start orienta o executor a registrar passos e progress preserva posição repetida', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))
  makeLegacy(f)
  const state = f.state()
  state.tasks.T1.taskPlan = { steps: ['Executar a entrega'] }
  f.save(state)

  const started = f.cli('start', 'T1', '--agent', 'executor')
  assert.equal(started.status, 0, f.output(started))
  assert.match(f.output(started), /report each actual execution step/i)
  const repeated = f.cli('progress', 'T1', '--step', '1', '--agent', 'executor')
  assert.equal(repeated.status, 0, f.output(repeated))
  assert.match(f.output(repeated), /already recorded/i)
  const invalid = f.cli('progress', 'T1', '--step', '2', '--agent', 'executor')
  assert.equal(invalid.status, 1, f.output(invalid))
  assert.match(f.output(invalid), /must be an index/i)
})

test('validate --failed registra o veredito sem executar checagens e mantém a tentativa ativa', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))
  makeLegacy(f)

  for (const args of [
    ['validate', '--ok', '--evidence', 'sem tarefa'],
    ['validate', 'T1', '--evidence', 'sem veredito'],
    ['validate', 'T1', '--ok'],
  ]) {
    const invalid = f.cli(...args)
    assert.equal(invalid.status, 1, `${args.join(' ')}\n${f.output(invalid)}`)
  }

  const started = f.cli('start', 'T1', '--agent', 'executor')
  assert.equal(started.status, 0, f.output(started))
  const before = f.snapshot()
  const failed = f.cli('validate', 'T1', '--failed', '--evidence', 'A revisão encontrou divergência')
  assert.equal(failed.status, 0, f.output(failed))

  const recorded = f.state().tasks.T1
  assert.equal(recorded.state, 'running')
  assert.equal(recorded.validations.at(-1).ok, false)
  assert.equal(recorded.validations.at(-1).by, 'executor')
  assert.equal(recorded.validations.at(-1).checks, undefined)
  const events = readFileSync(f.eventsPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(event => event.type === 'task_check').length, 0)
  assert.equal(events.filter(event => event.type === 'task_validate_started').length, 0)
  assert.equal(events.filter(event => event.type === 'task_validation_started').length, 1)
  assert.equal(events.filter(event => event.type === 'task_validate').length, 1)
  assert.notDeepEqual(f.snapshot(), before)

  const done = f.cli('done', 'T1')
  assert.equal(done.status, 1, f.output(done))
  assert.match(f.output(done), /no passing validation/)
})

test('show-check sem recibo é uma consulta somente leitura', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))
  const before = f.snapshot()

  for (const args of [
    ['show-check', '--check', '1', '--attempt', '1'],
    ['show-check', 'T1', '--check', '0', '--attempt', '1'],
    ['show-check', 'T1', '--check', '1', '--attempt', 'invalido'],
  ]) {
    const invalid = f.cli(...args)
    assert.equal(invalid.status, 1, f.output(invalid))
  }

  const result = f.cli('show-check', 'T1', '--check', '1', '--attempt', '1')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /no stored check/)
  assert.deepEqual(f.snapshot(), before)
})

test('show-check exibe recibo com diagnóstico, sinal e saídas preservadas', t => {
  const f = fixture(t)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))
  const state = f.state()
  state.tasks.T1.validations = [{ attempt: 1, by: 'review', checks: [{
    run: 'node check.cjs', cwd: f.project, exitCode: 3, error: 'falha observável', signal: 'SIGTERM',
    stdout: 'saída sem nova linha', stderr: 'diagnóstico sem nova linha', reusedAt: '2026-01-01T00:00:00Z',
  }] }]
  f.save(state)
  const result = f.cli('show-check', 'T1', '--check', '1', '--attempt', '1')
  assert.equal(result.status, 0, f.output(result))
  assert.match(f.output(result), /reused yes|falha observável|SIGTERM|saída sem nova linha|diagnóstico sem nova linha/)
})

test('comandos sem tarefa e argumentos inválidos falham preservando contrato e seleção', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const before = f.snapshot()
  for (const command of [
    'begin-discussion', 'skip-discussion', 'finish-discussion', 'plan-task', 'skip-planning',
    'finish-planning', 'start', 'progress', 'review', 'review-progress', 'refresh-contract',
    'validate', 'done', 'fail', 'retry', 'block', 'unblock', 'skip', 'note', 'activity-start', 'activity-stop',
    'begin-phase-discussion', 'skip-phase-discussion', 'finish-phase-discussion', 'plan-phase',
    'skip-phase-planning', 'finish-phase-planning',
  ]) {
    const result = f.cli(command)
    assert.equal(result.status, 1, `${command}: ${f.output(result)}`)
    assert.deepEqual(f.snapshot(), before, command)
  }
  for (const args of [[], ['não-existe'], ['status', '--run'], ['init'], ['init', '--run', 'novo']]) {
    const result = f.cli(...args)
    assert.equal(result.status, 1, f.output(result))
    assert.deepEqual(f.snapshot(), before)
  }
})

test('lock abandonado é recuperado antes de gravar uma nota sem remover o contrato', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const lock = join(f.graph, 'hardening', '.lock')
  mkdirSync(lock)
  const old = new Date(Date.now() - 60000)
  utimesSync(lock, old, old)
  const result = f.cli('note', 'T1', '--text', 'Regra preservada')
  assert.equal(result.status, 0, f.output(result))
  assert.equal(existsSync(lock), false)
  assert.equal(f.state().tasks.T1.notes.at(-1).text, 'Regra preservada')
})

test('falhas e disputa de lock preservam o contrato, enquanto liberação concorrente permite recuperação', async t => {
  for (const fault of ['mkdir-denied', 'stat-denied', 'released']) await t.test(fault, t => {
    const f = fixture(t)
    assert.equal(f.init().status, 0)
    const lock = join(f.graph, 'hardening', '.lock')
    if (fault !== 'mkdir-denied') mkdirSync(lock)
    const preload = join(f.home, 'lock-fault.mjs')
    writeFileSync(preload, `import fs from 'node:fs'
import { resolve } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const target = ${JSON.stringify(lock)}
const originalMkdir = fs.mkdirSync, originalStat = fs.statSync
let released = false
fs.mkdirSync = function (path, ...args) {
  if (resolve(path) === target && ${JSON.stringify(fault)} === 'mkdir-denied')
    throw Object.assign(new Error('lock access denied'), { code: 'EACCES' })
  return originalMkdir.call(this, path, ...args)
}
fs.statSync = function (path, ...args) {
  if (resolve(path) === target && ${JSON.stringify(fault)} === 'stat-denied')
    throw Object.assign(new Error('lock metadata denied'), { code: 'EACCES' })
  if (resolve(path) === target && ${JSON.stringify(fault)} === 'released' && !released) {
    released = true
    fs.rmdirSync(target)
    throw Object.assign(new Error('lock released by its owner'), { code: 'ENOENT' })
  }
  return originalStat.call(this, path, ...args)
}
syncBuiltinESMExports()
`)
    f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim()
    const before = f.snapshot(), result = f.cli('note', 'T1', '--text', 'Contrato preservado')
    if (fault === 'released') {
      assert.equal(result.status, 0, f.output(result))
      assert.equal(f.state().tasks.T1.notes.at(-1).text, 'Contrato preservado')
      assert.equal(f.state().tasks.T1.attempts.length, 0)
      assert.equal(existsSync(lock), false)
    } else {
      assert.equal(result.status, 1, f.output(result))
      assert.match(f.output(result), /lock access denied|lock metadata denied/)
      assert.deepEqual(f.snapshot(), before)
    }
  })
})

test('migração concluída por outro escritor durante espera do lock não é aplicada novamente', async t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const migrated = f.state(), legacy = structuredClone(migrated)
  delete legacy.plan.planningMode
  f.save(legacy)
  const lock = join(f.graph, 'hardening', '.lock'), ready = join(f.home, 'waiting-for-lock')
  mkdirSync(lock)
  const preload = join(f.home, 'lock-wait.mjs')
  writeFileSync(preload, `import fs from 'node:fs'
import { resolve } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const original = fs.statSync
fs.statSync = function (path, ...args) {
  if (resolve(path) === ${JSON.stringify(lock)}) fs.writeFileSync(${JSON.stringify(ready)}, 'waiting')
  return original.call(this, path, ...args)
}
syncBuiltinESMExports()
`)
  const env = { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() }
  const child = spawn(process.execPath, [engine, 'note', 'T1', '--text', 'Contrato preservado após disputa'], {
    cwd: f.project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const limit = Date.now() + 5000
  while (!existsSync(ready) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(existsSync(ready), output)
  f.save(migrated)
  assert.equal(dirname(lock), dirname(f.statePath))
  rmdirSync(lock)
  assert.equal(await completed, 0, output)
  assert.equal(f.state().plan.planningMode, 'task')
  assert.equal(f.state().tasks.T1.notes.at(-1).text, 'Contrato preservado após disputa')
  assert.equal(existsSync(join(dirname(f.statePath), 'state.pre-migrate-v1.json')), false)
  const events = readFileSync(f.eventsPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(events.some(event => event.type === 'run_migrated'), false)
})

test('lock ocupado recusa escrita após o prazo sem perder dados', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const lock = join(f.graph, 'hardening', '.lock')
  mkdirSync(lock)
  const before = f.snapshot(), result = f.cli('note', 'T1', '--text', 'Não deve ser gravado')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /locked by another command/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(existsSync(lock), true)
})

test('consulta de execução sem estado informa a falha sem alterar a execução selecionada', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  mkdirSync(join(f.graph, 'sem-estado'))
  const before = f.snapshot(), result = f.cli('status', '--run', 'sem-estado')
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /has no state\.json/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(existsSync(join(f.graph, 'sem-estado', 'state.json')), false)
})

test('migração recusa rodadas de fase abertas sem perder o histórico legado', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  delete state.plan.planningMode
  state.plan.phases = [{ id: 'P1' }]
  state.phaseWorkflows = { P1: {
    id: 'P1', state: 'discussing', discussionAttempts: [{ n: 1 }], planningAttempts: [{ n: 1 }],
  } }
  f.save(state)
  const before = f.snapshot()
  const check = f.cli('migrate', '--check')
  assert.equal(check.status, 0, f.output(check))
  assert.match(f.output(check), /P1: open phase discussion/)
  assert.match(f.output(check), /P1: open phase planning/)
  const result = f.cli('migrate')
  assert.equal(result.status, 1, f.output(result))
  assert.deepEqual(f.snapshot(), before)
})

test('atividade já aberta continua durante migração adiada e conserva rodadas anteriores', async t => {
  for (const [scope, role] of [['phase', 'discussion'], ['phase', 'planning'],
    ['task', 'discussion'], ['task', 'planning'], ['task', 'execution'], ['task', 'review']]) {
    await t.test(`${scope} ${role}`, t => {
      const f = fixture(t)
      assert.equal(f.init().status, 0)
      const state = f.state()
      delete state.plan.planningMode
      state.plan.phases = [{ id: 'P1' }]
      state.phaseWorkflows = { P1: { id: 'P1', state: 'discussing',
        discussionAttempts: [{ n: 1 }], planningAttempts: [], planningHistory: [] } }
      const target = scope === 'phase' ? state.phaseWorkflows.P1 : state.tasks.T1
      target.state = { discussion: 'discussing', planning: 'planning', execution: 'running', review: 'reviewing' }[role]
      const key = role === 'discussion' ? 'discussionAttempts' : role === 'planning' ? 'planningAttempts' : 'attempts'
      target[key] = [{ n: 1, endedAt: '2026-01-01T00:00:00Z' }, { n: 2 }]
      target.planner = role === 'planning' ? 'responsavel' : null
      target.agent = role === 'execution' ? 'responsavel' : null
      target.reviewer = role === 'review' ? 'responsavel' : null
      f.save(state)
      const id = scope === 'phase' ? 'P1' : 'T1'
      for (const command of ['activity-start', 'activity-stop']) {
        const result = f.cli(command, id, '--scope', scope, '--role', role, '--agent', 'responsavel')
        assert.equal(result.status, 0, f.output(result))
      }
      const after = scope === 'phase' ? f.state().phaseWorkflows.P1 : f.state().tasks.T1
      assert.deepEqual(after[key][0], target[key][0])
      assert.equal(after[key].length, 2)
      assert.equal(after[key][1].activityIntervals.length, 1)
      assert.ok(after[key][1].activityIntervals[0].endedAt)
      assert.equal(f.state().plan.planningMode, undefined)
    })
  }
})

test('decisão histórica de fase responde à pergunta sem exigir resposta repetida', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.tasks.T1.taskPlan = { openQuestions: [{ questionRef: 'T1:plan:regra',
    question: 'Qual regra deve valer?', blocking: true }] }
  f.save(state)
  assert.match(f.output(f.cli('status')), /open question T1:plan:regra/)
  state.phaseWorkflows = { P1: { id: 'P1', discovery: {
    decisions: [{ resolvesQuestion: 'T1:plan:regra', answer: 'Preservar a regra aprovada' }],
  } } }
  f.save(state)
  const before = f.snapshot()
  const result = f.cli('status')
  assert.equal(result.status, 0, f.output(result))
  assert.doesNotMatch(f.output(result), /open question T1:plan:regra/)
  assert.deepEqual(f.snapshot(), before)
})

test('respostas históricas de tarefa preservam referências de perguntas sem metadados opcionais', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const baseline = f.state()
  baseline.tasks.T1.taskPlan = { openQuestions: [{ question: 'Qual regra deve valer?', blocking: false, decideBy: 'user-now' }] }
  f.save(baseline)
  const first = f.cli('status')
  assert.equal(first.status, 0, f.output(first))
  const ref = f.output(first).match(/open question (T1:plan:[a-f0-9]+)/)?.[1]
  assert.ok(ref, f.output(first))
  const decision = { resolvesQuestion: ref, question: 'Qual regra deve valer?', answer: 'Preservar a regra aprovada' }
  for (const source of ['taskPlan', 'discovery', 'planningHistory', 'discussionAttempts']) {
    const state = structuredClone(baseline), task = state.tasks.T1
    if (source === 'taskPlan') task.taskPlan.decisions = [decision]
    if (source === 'discovery') task.discovery = { decisions: [decision], recordedAt: '2026-01-01T00:00:00Z' }
    if (source === 'planningHistory') task.planningHistory = [{ decisions: [decision] }]
    if (source === 'discussionAttempts') task.discussionAttempts = [{ endedAt: '2026-01-01T00:00:00Z', discovery: { decisions: [decision] } }]
    f.save(state)
    const before = f.snapshot(), result = f.cli('status')
    assert.equal(result.status, 0, f.output(result))
    assert.doesNotMatch(f.output(result), new RegExp(`open question ${ref}`))
    assert.deepEqual(f.snapshot(), before)
  }
})

test('prazo malformado em estado importado não autoriza execução nem troca a rodada ativa', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('authorize', '--scope', 'run', '--confirmed-by-user').status, 0)
  const state = f.state()
  state.tasks.T1.taskPlan = { openQuestions: [{ question: 'Qual regra deve valer?',
    blocking: false, decideBy: {}, questionRef: 'T1:plan:invalida' }] }
  state.tasks.T2 = { ...structuredClone(state.tasks.T1), id: 'T2', phase: undefined, state: 'done', taskPlan: undefined }
  f.save(state)
  let before = f.snapshot()
  const start = f.cli('start', 'T1', '--agent', 'executor')
  assert.equal(start.status, 1, f.output(start))
  assert.match(f.output(start), /needs completed current planning/)
  assert.deepEqual(f.snapshot(), before)
  state.tasks.T1.state = 'running'
  f.save(state)
  before = f.snapshot()
  const discussion = f.cli('begin-discussion', 'T1')
  assert.equal(discussion.status, 1, f.output(discussion))
  assert.match(f.output(discussion), /must be ready for discussion/)
  assert.deepEqual(f.snapshot(), before)
})

test('planejamento de tarefa recusa mudanças de gate durante execução e mantém compatibilidade legada', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  for (const legacy of [false, true]) {
    const state = f.state()
    state.tasks.T1.state = legacy ? 'pending' : 'running'
    state.tasks.T1.discussionRequired = !legacy
    state.tasks.T1.planningRequired = !legacy
    f.save(state)
    const before = f.snapshot()
    const cases = legacy ? [
      ['skip-discussion', 'T1', '--reason', 'Dispensa', '--confirmed-by-user'],
      ['skip-planning', 'T1', '--reason', 'Dispensa', '--confirmed-by-user'],
    ] : [
      ['begin-discussion', 'T1'],
      ['skip-discussion', 'T1', '--reason', 'Dispensa', '--confirmed-by-user'],
      ['skip-planning', 'T1', '--reason', 'Dispensa', '--confirmed-by-user'],
      ['plan-task', 'T1', '--agent', 'planejador'],
      ['finish-planning', 'T1', '--plan', f.planPath],
    ]
    for (const args of cases) {
      const result = f.cli(...args)
      assert.equal(result.status, 1, f.output(result))
      assert.deepEqual(f.snapshot(), before)
    }
  }
})

test('comandos de tarefa orientam o planejamento de fase sem alterar os contratos', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.plan.planningMode = 'phase'
  state.plan.phases = [{ id: 'P1' }]
  state.tasks.T1.phase = 'P1'
  state.phaseWorkflows = { P1: { id: 'P1', state: 'pending', discussionAttempts: [], planningAttempts: [] } }
  f.save(state)
  const before = f.snapshot()
  for (const args of [
    ['begin-discussion', 'T1'], ['skip-discussion', 'T1'],
    ['finish-discussion', 'T1', '--context', f.planPath],
    ['plan-task', 'T1', '--agent', 'planejador'], ['skip-planning', 'T1'],
    ['finish-planning', 'T1', '--plan', f.planPath],
  ]) {
    const result = f.cli(...args)
    assert.equal(result.status, 1, f.output(result))
    assert.match(f.output(result), /uses phase planning/)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('nova tarefa citada por bloqueio informa dependência ausente sem liberar a tarefa bloqueada', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('block', 'T1', '--reason', 'aguardando T1a').status, 0)
  const plan = JSON.parse(readFileSync(f.planPath, 'utf8'))
  plan.tasks.push({ id: 'T1a', title: 'Entrega aguardada', summary: 'Verificar a entrega dependente conforme o aceite já aprovado.', deps: ['T1'], validation: plan.tasks[0].validation })
  f.writePlan(plan)
  const result = f.cli('sync-plan', '--plan', f.planPath)
  assert.equal(result.status, 0, f.output(result))
  assert.match(f.output(result), /new leaf task T1a is cited by blocked task T1/)
  assert.equal(f.state().tasks.T1.state, 'blocked')
  assert.equal(f.state().tasks.T1.blockReason, 'aguardando T1a')
  assert.deepEqual(f.state().tasks.T1.deps, [])
  assert.equal(f.state().tasks.T1a.state, 'pending')
})

test('descoberta com contexto obsoleto não encerra rodada nem altera histórico', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('begin-discussion', 'T1').status, 0)
  const state = f.state()
  state.tasks.T1.discussionAttempts.at(-1).context = 'contexto importado de uma versão anterior'
  f.save(state)
  const before = f.snapshot()
  const result = f.cli('finish-discussion', 'T1', '--context', f.planPath)
  assert.equal(result.status, 1, f.output(result))
  assert.match(f.output(result), /discussion is stale/)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.state().tasks.T1.discussionAttempts.at(-1).endedAt, undefined)
})

test('sync recupera plano central quando o histórico não registrou caminho da fonte', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.plan.name = 'Recuperacao'
  delete state.plan.source
  f.save(state)
  const plans = join(f.graph, 'plans')
  mkdirSync(plans, { recursive: true })
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.name = 'Recuperacao'
  const source = join(plans, 'Recuperacao.plan.json')
  writeFileSync(source, JSON.stringify(approved))
  const attempts = structuredClone(state.tasks.T1.attempts)
  const result = f.cli('sync-plan')
  assert.equal(result.status, 0, f.output(result))
  assert.equal(f.state().plan.source, source)
  assert.deepEqual(f.state().tasks.T1.attempts, attempts)
})

test('mudança aprovada revoga dispensa de planejamento e conserva a decisão anterior', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  assert.equal(f.cli('skip-discussion', 'T1', '--reason', 'Contrato aceito', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('skip-planning', 'T1', '--reason', 'Execução direta', '--confirmed-by-user').status, 0)
  const before = f.state().tasks.T1
  const approved = JSON.parse(readFileSync(f.planPath, 'utf8'))
  approved.tasks[0].title = 'Entrega com novo comportamento aprovado'
  f.writePlan(approved)
  const result = f.cli('sync-plan', '--plan', f.planPath)
  assert.equal(result.status, 0, f.output(result))
  const task = f.state().tasks.T1
  assert.deepEqual(task.planningSkips, before.planningSkips)
  assert.deepEqual(task.discussionSkips, before.discussionSkips)
  assert.ok(task.contractConfirmationRequired)
  assert.equal(task.state, 'pending')
  const graph = f.cli('graph')
  assert.equal(graph.status, 0, f.output(graph))
  assert.equal(JSON.parse(graph.stdout).derived.T1.effective, 'ready_for_discussion')
})

test('conclusão recusa recibos incompatíveis e só encerra a tentativa com revisão atual válida', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  for (const command of ['skip-discussion', 'skip-planning'])
    assert.equal(f.cli(command, 'T1', '--reason', 'Contrato aceito', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('authorize', '--scope', 'run', '--confirmed-by-user').status, 0)
  assert.equal(f.cli('start', 'T1', '--agent', 'executor').status, 0)
  assert.equal(f.cli('review', 'T1', '--agent', 'revisor').status, 0)
  const checked = f.cli('validate', 'T1', '--ok', '--evidence', 'Comportamento aprovado verificado', '--cwd', f.project)
  assert.equal(checked.status, 0, f.output(checked))
  const baseline = f.state()
  for (const [change, pattern] of [
    [task => { task.state = 'pending' }, /not running or reviewing/],
    [task => { task.validations = [] }, /no passing validation/],
    [task => { task.validations.at(-1).ok = false }, /no passing validation/],
    [task => { task.validations.at(-1).attempt = 2 }, /no passing validation/],
    [task => { task.validations.at(-1).planningScope = 'escopo anterior' }, /scope changed after validation/],
    [task => { delete task.validations.at(-1).by }, /not a reviewer/],
    [task => { task.validations.at(-1).by = 'execution' }, /not a reviewer/],
    [task => { task.reviewer = null }, /current independent reviewer/],
    [task => { task.validations.at(-1).agent = 'outro' }, /current independent reviewer/],
    [task => { task.agent = task.reviewer }, /current independent reviewer/],
    [task => { task.validations.at(-1).checks[0].exitCode = 9 }, /validation check.*functional.*failed/],
  ]) {
    const state = structuredClone(baseline)
    change(state.tasks.T1)
    f.save(state)
    const before = f.snapshot(), result = f.cli('done', 'T1')
    assert.equal(result.status, 1, f.output(result))
    assert.match(f.output(result), pattern)
    assert.deepEqual(f.snapshot(), before)
  }
  f.save(baseline)
  const done = f.cli('done', 'T1')
  assert.equal(done.status, 0, f.output(done))
  assert.equal(f.state().tasks.T1.state, 'done')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
  assert.deepEqual(f.state().tasks.T1.validations, baseline.tasks.T1.validations)
})

test('bloqueio valida pergunta e opções antes de alterar a tarefa e exige resposta para retomada', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const before = f.snapshot()
  for (const args of [
    ['block', 'T1', '--question', ' '],
    ['block', 'T1', '--question', 'Qual regra?', '--option', ' '],
    ['block', 'T1', '--option', 'A'],
    ['unblock', 'T1'],
  ]) {
    const result = f.cli(...args)
    assert.equal(result.status, 1, f.output(result))
    assert.deepEqual(f.snapshot(), before)
  }
  const blocked = f.cli('block', 'T1', '--question', 'Qual regra?', '--option', 'A', '--option', 'A', '--option', 'B')
  assert.equal(blocked.status, 0, f.output(blocked))
  assert.deepEqual(f.state().tasks.T1.blockOptions, ['A', 'B'])
  const paused = f.snapshot()
  const invalid = f.cli('unblock', 'T1', '--answer', ' ')
  assert.equal(invalid.status, 1, f.output(invalid))
  assert.deepEqual(f.snapshot(), paused)
})

test('atividade recusa agente vazio, estado incompatível e rodada ausente', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const before = f.snapshot()
  for (const command of ['activity-start', 'activity-stop']) {
    const result = f.cli(command, 'T1', '--role', 'execution', '--agent', ' ')
    assert.equal(result.status, 1, f.output(result))
    assert.deepEqual(f.snapshot(), before)
    const phase = f.cli(command, 'P1', '--scope', 'phase', '--role', 'review', '--agent', 'revisor')
    assert.equal(phase.status, 1, f.output(phase))
    assert.deepEqual(f.snapshot(), before)
  }
  const incompatible = f.cli('activity-start', 'T1', '--role', 'execution', '--agent', 'executor')
  assert.equal(incompatible.status, 1, f.output(incompatible))
  assert.match(f.output(incompatible), /must be running/)
  const state = f.state()
  state.tasks.T1.state = 'running'
  state.tasks.T1.attempts = []
  f.save(state)
  const noRound = f.cli('activity-start', 'T1', '--role', 'execution', '--agent', 'executor')
  assert.equal(noRound.status, 1, f.output(noRound))
  assert.match(f.output(noRound), /no current execution activity round/)
})

test('planejador legado exige descoberta válida, registra contexto e preserva rodadas substituídas', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const state = f.state()
  state.tasks.T1.discussionRequired = false
  state.tasks.T1.discoveryRequired = true
  f.save(state)
  const before = f.snapshot()
  const missing = f.cli('plan-task', 'T1', '--agent', 'planejador')
  assert.equal(missing.status, 1, f.output(missing))
  assert.match(f.output(missing), /needs --context/)
  assert.deepEqual(f.snapshot(), before)
  const invalid = f.cli('plan-task', 'T1', '--agent', 'planejador', '--context', f.project)
  assert.equal(invalid.status, 1, f.output(invalid))
  assert.deepEqual(f.snapshot(), before)
  const context = {
    research: [{ source: 'Contrato', findings: 'Regra confirmada' }],
    questions: [{ question: 'Preservar a regra?', answer: 'Sim', channel: 'native', round: 1 }],
    coverage: Object.fromEntries([
      'problem', 'affected', 'outcome', 'currentBehavior', 'desiredBehavior',
      'rules', 'exceptions', 'scope', 'acceptance',
    ].map(field => [field, 'Contexto confirmado'])),
    decisions: [], deferred: [],
    executionBoundary: { deferredToExecutor: ['T1'], prematureTaskWork: [] },
    closure: 'Regra confirmada',
  }
  const contextPath = join(f.project, 'discovery.json')
  writeFileSync(contextPath, JSON.stringify(context))
  const begin = f.cli('plan-task', 'T1', '--agent', 'planejador', '--context', contextPath)
  assert.equal(begin.status, 0, f.output(begin))
  assert.equal(f.state().tasks.T1.planningAttempts.length, 1)
  const planning = f.snapshot()
  const artifactDirectory = f.cli('finish-planning', 'T1', '--plan', f.project)
  assert.equal(artifactDirectory.status, 1, f.output(artifactDirectory))
  assert.deepEqual(f.snapshot(), planning)
  context.research[0].findings = 'Nova evidência confirmou o escopo'
  writeFileSync(contextPath, JSON.stringify(context))
  const replaced = f.cli('plan-task', 'T1', '--agent', 'planejador', '--context', contextPath)
  assert.equal(replaced.status, 0, f.output(replaced))
  const rounds = f.state().tasks.T1.planningAttempts
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0].result, 'superseded')
  assert.ok(rounds[0].endedAt)
  assert.equal(rounds[1].agent, 'planejador')
  assert.equal(f.state().tasks.T1.discovery.research[0].findings, context.research[0].findings)
})

test('progresso de revisão sem revisor obrigatório é sequencial e repetição não altera estado', t => {
  const f = fixture(t, { requireReview: false })
  assert.equal(f.init().status, 0)
  makeLegacy(f)
  const start = f.cli('start', 'T1', '--agent', 'executor')
  assert.equal(start.status, 0, f.output(start))
  const first = f.cli('review-progress', 'T1', '--agent', 'executor', '--step', '1')
  assert.equal(first.status, 0, f.output(first))
  assert.equal(f.state().tasks.T1.attempts.at(-1).reviewProgress.traversed, 1)
  const before = f.snapshot()
  const repeated = f.cli('review-progress', 'T1', '--agent', 'executor', '--step', '1')
  assert.equal(repeated.status, 0, f.output(repeated))
  assert.match(f.output(repeated), /already reports 1\/1/)
  assert.deepEqual(f.snapshot(), before)
  const outside = f.cli('review-progress', 'T1', '--agent', 'executor', '--step', '2')
  assert.equal(outside.status, 1, f.output(outside))
  assert.deepEqual(f.snapshot(), before)
})

test('aviso de caminho sugere correção dentro de pasta existente e respeita intermediário que é arquivo', t => {
  const f = fixture(t)
  mkdirSync(join(f.project, 'src'))
  writeFileSync(join(f.project, 'src', 'name.txt'), 'Conteúdo aprovado')
  writeFileSync(join(f.project, 'file'), 'Não é diretório')
  const plan = JSON.parse(readFileSync(f.planPath, 'utf8'))
  plan.tasks[0].touches = ['src/nmae.txt', 'file/novo.txt']
  f.writePlan(plan)
  const init = f.init()
  assert.equal(init.status, 0, f.output(init))
  assert.match(f.output(init), /closest existing path: src\/name.txt/)
  assert.match(f.output(init), /file\/novo.txt/)
  assert.deepEqual(f.state().tasks.T1.touches, plan.tasks[0].touches)
})

test('consulta informa idade de rodada e confirmação pendente sem alterar históricos', t => {
  const f = fixture(t)
  assert.equal(f.init().status, 0)
  const base = f.state()
  for (const [age, expected] of [[120000, /completed for 2m/], [7200000, /completed for 2h/], [NaN, /completed for unknown age/]]) {
    const state = structuredClone(base)
    state.tasks.T1.planningAttempts = [{
      n: 1, startedAt: Number.isNaN(age) ? 'sem-data' : new Date(Date.now() - age).toISOString(),
      endedAt: new Date().toISOString(), result: 'planned', context: 'Contrato anterior',
    }]
    state.phaseWorkflows = { P1: { id: 'P1', contractConfirmationRequired: {} } }
    f.save(state)
    const before = f.snapshot()
    const status = f.cli('status')
    assert.equal(status.status, 0, f.output(status))
    assert.match(f.output(status), expected)
    assert.match(f.output(status), /contract confirmation required for phase P1: current phase tasks/)
    assert.deepEqual(f.snapshot(), before)
  }
})
