import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { planInstall, applyInstall } from '../lib/install.mjs'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engine = join(source, 'scripts/engine.mjs'), cli = join(source, 'bin/prumo.mjs')
const commands = ['init', 'migrate', 'sync-plan', 'status', 'ready', 'graph', 'runs', 'show-contract', 'show-check', 'authorize',
  'begin-phase-discussion', 'skip-phase-discussion', 'finish-phase-discussion', 'plan-phase', 'skip-phase-planning', 'finish-phase-planning',
  'begin-discussion', 'skip-discussion', 'finish-discussion', 'plan-task', 'skip-planning', 'finish-planning', 'start', 'progress',
  'review', 'review-progress', 'refresh-contract', 'validate', 'done', 'fail', 'retry', 'block', 'unblock', 'skip', 'note']

function fixture(t) {
  const base = realpathSync(tmpdir())
  const home = mkdtempSync(join(base, 'prumo-command-tests-')), root = join(home, 'workspace')
  mkdirSync(root)
  t.after(() => {
    assert.equal(dirname(home), base)
    assert.ok(home.startsWith(join(base, 'prumo-command-tests-')))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const env = { ...process.env, HOME: home, USERPROFILE: home, PRUMO_HOME: home, PRUMO_ROOT: root,
    GRAPH_ROOT: root, GRAPH_FOREMAN_HOME: home, PRUMO_LANG: 'en', CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), DSH_HOME: join(home, '.dsh') }
  const run = (script, ...args) => {
    const r = spawnSync(process.execPath, [script, ...args], { env, cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true })
    assert.ifError(r.error)
    return { ...r, output: r.stdout + r.stderr }
  }
  const command = (...args) => run(engine, ...args)
  const ok = (...args) => { const r = command(...args); assert.equal(r.status, 0, r.output); return r }
  const graphDir = join(root, '.specs/graph'), statePath = join(graphDir, 'example/state.json')
  const planPath = join(root, 'plan.json')
  writeFileSync(join(root, 'behavior.cjs'), "require('node:assert/strict').equal(2 + 2, 4); console.log('Comportamento verificado');\n")
  const plan = { name: 'Contrato dos comandos', planningMode: 'task', tasks: [{ id: 'T1', title: 'Verificar comportamento',
    validation: [{ kind: 'functional', run: 'node behavior.cjs', expect: 'A regra aprovada passa' }] }] }
  writeFileSync(planPath, JSON.stringify(plan))
  const init = () => ok('init', '--plan', planPath, '--run', 'example')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const snapshot = () => [readFileSync(statePath, 'utf8'), readFileSync(join(graphDir, 'example/events.ndjson'), 'utf8'), readFileSync(join(graphDir, 'CURRENT'), 'utf8')]
  const prepare = () => {
    ok('authorize', '--scope', 'run', '--confirmed-by-user')
    ok('skip-discussion', 'T1', '--reason', 'Contrato já confirmado', '--confirmed-by-user')
    ok('plan-task', 'T1', '--agent', 'planner')
    const artifact = join(root, 'task-plan.json')
    writeFileSync(artifact, JSON.stringify({ research: [{ source: planPath, findings: 'Regra aprovada inspecionada' }], decisions: [],
      steps: ['Verificar a regra', 'Entregar o resultado'], verification: [{ criterion: 'Resultado aprovado', check: 1 }], openQuestions: [] }))
    ok('finish-planning', 'T1', '--plan', artifact)
  }
  return { home, root, env, run, command, ok, init, prepare, state, snapshot, plan, planPath, graphDir, statePath }
}

test('todos os comandos rejeitam opção desconhecida sem alterar estado, histórico ou seleção', async t => {
  const f = fixture(t); f.init()
  for (const command of commands) await t.test(`${command}: rejeição atômica de argumento`, () => {
    const before = f.snapshot(), result = f.command(command, '--typo')
    assert.equal(result.status, 1, result.output); assert.match(result.output, /Unknown option/)
    assert.deepEqual(f.snapshot(), before)
  })
})
test('nomes herdados de Object não acionam comandos', t => {
  const f = fixture(t); f.init(); const before = f.snapshot()
  for (const name of ['constructor', 'toString', '__proto__']) {
    const result = f.command(name); assert.equal(result.status, 1); assert.match(result.output, /Unknown engine command/)
    assert.doesNotMatch(result.output, /TypeError|stack/); assert.deepEqual(f.snapshot(), before)
  }
})

test('argumentos excedentes não executam nenhum comando nem alteram a seleção', async t => {
  const f = fixture(t); f.init()
  for (const command of commands) await t.test(`${command}: argumentos excedentes preservam dados`, () => {
    const before = f.snapshot(), result = f.command(command, 'T1', 'T2')
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /positional argument/)
    assert.deepEqual(f.snapshot(), before)
  })
})

test('comandos de tarefa e fase recusam identificadores inexistentes sem gravar', async t => {
  const task = fixture(t), phase = fixture(t)
  phase.plan.planningMode = 'phase'
  phase.plan.phases = [{ id: 'F1', title: 'Entrega' }]
  phase.plan.tasks[0].phase = 'F1'
  writeFileSync(phase.planPath, JSON.stringify(phase.plan))
  for (const f of [task, phase]) { f.init(); f.ok('authorize', '--scope', 'run', '--confirmed-by-user') }
  const required = {
    'show-check': ['--check', '1', '--attempt', '1'],
    'finish-phase-discussion': ['--context', phase.planPath],
    'plan-phase': ['--agent', 'planner'],
    'finish-phase-planning': ['--plan-dir', phase.root],
    'finish-discussion': ['--context', task.planPath],
    'plan-task': ['--agent', 'planner'],
    'finish-planning': ['--plan', task.planPath],
    start: ['--agent', 'executor'], progress: ['--step', '1', '--agent', 'executor'],
    review: ['--agent', 'reviewer'], 'review-progress': ['--step', '1', '--agent', 'reviewer'],
    validate: ['--ok', '--evidence', 'Comportamento verificado', '--cwd', task.root],
    unblock: ['--answer', 'Decisão aprovada'], note: ['--text', 'Registro'],
  }
  const scoped = commands.filter(command => !['init', 'migrate', 'sync-plan', 'status', 'ready', 'graph', 'runs', 'authorize'].includes(command))
  for (const command of scoped) await t.test(`${command}: alvo inexistente preserva dados`, () => {
    const f = command.includes('phase') ? phase : task
    const before = f.snapshot()
    const reason = ['fail', 'skip', 'block'].includes(command) || command.startsWith('skip-')
      ? ['--reason', 'Decisão aprovada', ...(command.startsWith('skip-') ? ['--confirmed-by-user'] : [])] : []
    const result = f.command(command, 'INEXISTENTE', ...(required[command] ?? reason))
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /unknown (task|phase) "INEXISTENTE"/)
    assert.doesNotMatch(result.output, /TypeError|ReferenceError/)
    assert.deepEqual(f.snapshot(), before)
  })
})

test('sobreposição exige autorização explícita e --allow-overlap funciona na inicialização', t => {
  const f = fixture(t)
  f.plan.tasks[0].touches = ['src']
  f.plan.tasks.push({ ...f.plan.tasks[0], id: 'T2' })
  writeFileSync(f.planPath, JSON.stringify(f.plan))
  const result = f.command('init', '--plan', f.planPath, '--run', 'example')
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /allow-overlap/)
  assert.equal(existsSync(f.statePath), false)
  f.ok('init', '--plan', f.planPath, '--run', 'example', '--allow-overlap')
  assert.deepEqual(Object.keys(f.state().tasks).sort(), ['T1', 'T2'])
})
test('runs lista execuções e ignora diretórios de planos e arquivos avulsos sem gravar', t => {
  const f = fixture(t)
  assert.match(f.ok('runs').output, /no runs/)
  f.init(); mkdirSync(join(f.graphDir, 'plans')); writeFileSync(join(f.graphDir, 'unrelated.txt'), 'Preservar')
  const before = f.snapshot(), entries = readdirSync(f.graphDir)
  assert.match(f.ok('runs').output, /example\s+0\/1 done/)
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(readdirSync(f.graphDir), entries)
})
test('runs mantém execuções saudáveis visíveis diante de estado inválido', t => {
  const f = fixture(t); f.init(); const before = f.snapshot()
  for (const [name, contents] of [['damaged', '{'], ['incomplete', '{}'], ['.draft', '{}'], ['future', JSON.stringify({ schemaVersion: 999 })]]) {
    mkdirSync(join(f.graphDir, name)); writeFileSync(join(f.graphDir, name, 'state.json'), contents)
  }
  const result = f.ok('runs')
  assert.match(result.output, /example\s+0\/1 done/); assert.match(result.stderr, /damaged|incomplete/)
  assert.deepEqual(f.snapshot(), before)
})
test('consultas e migração de schema atual preservam os dados', t => {
  const f = fixture(t); f.init(); const before = f.snapshot()
  for (const args of [['status'], ['ready'], ['graph'], ['show-contract', 'T1'], ['migrate', '--check'], ['migrate']]) {
    f.ok(...args); assert.deepEqual(f.snapshot(), before)
  }
})
test('fluxo completo registra progresso, verificação independente, evidência e conclusão', t => {
  const f = fixture(t); f.init(); f.prepare()
  f.ok('start', 'T1', '--agent', 'executor')
  f.ok('progress', 'T1', '--step', '2', '--agent', 'executor')
  f.ok('note', 'T1', '--text', 'A regra aprovada foi entregue')
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('review-progress', 'T1', '--step', '1', '--agent', 'reviewer')
  const before = f.snapshot(), conflicting = f.command('validate', 'T1', '--ok', '--failed', '--evidence', 'Ambígua', '--cwd', f.root)
  assert.equal(conflicting.status, 1); assert.deepEqual(f.snapshot(), before)
  f.ok('validate', 'T1', '--ok', '--evidence', 'O comportamento foi executado e passou', '--cwd', f.root)
  assert.match(f.ok('show-check', 'T1', '--check', '1', '--attempt', '1').output, /Comportamento verificado/)
  f.ok('done', 'T1'); assert.equal(f.state().tasks.T1.state, 'done')
  assert.match(f.ok('runs').output, /1\/1 done/)
})
test('falha, nova tentativa e pausa conservam a identidade do plano', t => {
  const f = fixture(t); f.init(); f.prepare(); const planned = f.state().tasks.T1.taskPlan
  f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('fail', 'T1', '--reason', 'Resultado ainda divergente')
  f.ok('retry', 'T1'); f.ok('start', 'T1', '--agent', 'executor2')
  f.ok('block', 'T1', '--reason', 'Decisão necessária', '--question', 'Preservar regra?', '--option', 'Sim', '--option', 'Não')
  const before = f.snapshot(); assert.notEqual(f.command('unblock', 'T1').status, 0); assert.deepEqual(f.snapshot(), before)
  f.ok('unblock', 'T1', '--answer', 'Sim'); assert.equal(f.state().tasks.T1.state, 'running')
  assert.deepEqual(f.state().tasks.T1.taskPlan, planned); assert.equal(f.state().tasks.T1.attempts.length, 2)
  f.ok('skip', 'T1', '--reason', 'Usuário cancelou a entrega'); assert.equal(f.state().tasks.T1.state, 'skipped')
})
test('CLI recusa flags sem efeito antes de instalar, restaurar ou iniciar serviço', async t => {
  const f = fixture(t)
  for (const command of ['install', 'doctor', 'update', 'status', 'dashboard', 'restore']) await t.test(`${command} não aceita --check`, () => {
    const args = command === 'restore' ? ['restore', join(f.home, 'backup')] : [command]
    const r = f.run(cli, ...args, '--check'); assert.equal(r.status, 1); assert.match(r.output, /does not accept --check/)
    assert.equal(existsSync(join(f.home, '.local/share/prumo')), false)
  })
  const r = f.run(cli, 'restore', join(f.home, 'backup'), '--dry-run')
  assert.equal(r.status, 1); assert.match(r.output, /does not accept --dry-run/)
})
test('CLI oferece ajuda e versão e consulta dashboard isolado sem instalar nada', t => {
  const f = fixture(t), version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version
  assert.equal(f.run(cli, '--version').stdout.trim(), version)
  assert.match(f.run(cli, '--help').stdout, /prumo install|prumo dashboard/)
  for (const action of ['status', 'logs']) {
    const r = f.run(cli, 'dashboard', action); assert.equal(r.status, 0, r.output)
  }
})
test('motor instalado inclui as dependências e executa comandos fora do checkout', t => {
  const f = fixture(t), config = join(f.home, '.codex')
  mkdirSync(config); writeFileSync(join(config, 'config.toml'), '# Ambiente isolado para verificar instalação\n')
  const planned = planInstall({ harness: 'codex', home: f.home, cwd: f.root, env: f.env, lang: 'en' })
  const installed = applyInstall(planned)
  assert.ok(installed.groups.every(g => g.status !== 'conflict'), JSON.stringify(installed.groups))
  const installedEngine = join(f.home, '.agents/skills/prumo/scripts/engine.mjs')
  const r = f.run(installedEngine, 'runs'); assert.equal(r.status, 0, r.output); assert.match(r.output, /no runs/)
  const dashboard = join(dirname(installedEngine), 'serve.mjs')
  const rejected = f.run(dashboard, '--global', '--dry-run')
  assert.equal(rejected.status, 1, rejected.output)
  assert.match(rejected.output, /Unknown dashboard option/)
  assert.doesNotMatch(rejected.output, /ERR_MODULE_NOT_FOUND/)
})

test('dashboard recusa argumentos inválidos antes de abrir serviço ou criar preferências', async t => {
  const f = fixture(t), dashboard = join(source, 'scripts/serve.mjs')
  const cases = [
    ['--global', '--dry-run'], ['--global', '--port'], ['--global', '--port', '-1'],
    ['--global', '--port', '65536'], ['--global', '--run', '../fora'],
    ['--global', '--sync-plan'], ['--global', '--global'], ['--global', 'extra'],
  ]
  for (const args of cases) await t.test(args.join(' '), () => {
    const result = f.run(dashboard, ...args)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /ERROR:/)
    assert.doesNotMatch(result.output, /ERR_MODULE_NOT_FOUND|RangeError|TypeError|listening/)
    assert.equal(existsSync(join(f.home, '.local/share/prumo/dashboard.json')), false)
  })
})
test('gravações concorrentes conservam todas as notas e o histórico', async t => {
  const f = fixture(t); f.init()
  const notes = Array.from({ length: 8 }, (_, i) => `Registro independente ${i + 1}`)
  const results = await Promise.all(notes.map(text => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [engine, 'note', 'T1', '--text', text], { env: f.env, cwd: f.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', c => { output += c }); child.stderr.on('data', c => { output += c })
    const timer = setTimeout(() => child.kill(), 20000)
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolveResult({ code, output }) })
  })))
  for (const result of results) assert.equal(result.code, 0, result.output)
  assert.deepEqual(f.state().tasks.T1.notes.map(n => n.text).sort(), [...notes].sort())
  const events = readFileSync(join(f.graphDir, 'example/events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(e => e.type === 'task_note').length, notes.length)
  assert.equal(existsSync(join(f.graphDir, 'example/.lock')), false)
})

for (const code of ['ENOENT', 'EACCES']) test(`bloqueio ${code}: liberação concorrente é recuperável, falha de acesso é preservada`, t => {
  const f = fixture(t); f.init()
  const before = f.snapshot(), bootstrap = join(f.root, 'lock-fault.mjs'), injected = join(f.root, 'lock-fault-recorded')
  writeFileSync(bootstrap, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const mkdir = fs.mkdirSync, stat = fs.statSync
let collision = true, pending = false
fs.mkdirSync = (path, ...args) => {
  if (String(path).endsWith('.lock') && collision) {
    collision = false; pending = true
    throw Object.assign(new Error('Bloqueio ocupado'), { code: 'EEXIST' })
  }
  return mkdir(path, ...args)
}
fs.statSync = (path, ...args) => {
  if (String(path).endsWith('.lock') && pending) {
    pending = false
    fs.writeFileSync(${JSON.stringify(injected)}, 'Falha injetada')
    throw Object.assign(new Error('Falha de bloqueio ${code}'), { code: ${JSON.stringify(code)} })
  }
  return stat(path, ...args)
}
syncBuiltinESMExports()
`)
  const result = f.run('--import', pathToFileURL(bootstrap).href, engine, 'note', 'T1', '--text', 'Registro preservado')
  assert.equal(existsSync(injected), true, `O caminho de falha precisa ter sido executado: ${result.output}`)
  if (code === 'ENOENT') {
    assert.equal(result.status, 0, result.output)
    assert.deepEqual(f.state().tasks.T1.notes.map(note => note.text), ['Registro preservado'])
    assert.equal(existsSync(join(f.graphDir, 'example/.lock')), false)
  } else {
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /EACCES/)
    assert.deepEqual(f.snapshot(), before)
  }
})
