import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEngineArgs } from '../scripts/engine-args.mjs'

// Lista do contrato público, independente da tabela usada pelo parser.
const commands = ['init', 'migrate', 'sync-plan', 'status', 'ready', 'graph', 'runs', 'show-contract', 'show-check', 'authorize',
  'begin-phase-discussion', 'skip-phase-discussion', 'finish-phase-discussion', 'plan-phase', 'skip-phase-planning', 'finish-phase-planning',
  'begin-discussion', 'skip-discussion', 'finish-discussion', 'plan-task', 'skip-planning', 'finish-planning', 'start', 'progress',
  'review', 'review-progress', 'refresh-contract', 'validate', 'done', 'fail', 'retry', 'block', 'unblock', 'skip', 'note',
  'pause-replanning', 'set-agent-limit']

test('reaproveitamento explícito é limitado ao fechamento do planejamento de fase', () => {
  assert.deepEqual(parseEngineArgs('finish-phase-planning', ['F1', '--plan-dir', 'plans', '--reuse-unchanged-plans']),
    { _: ['F1'], 'plan-dir': 'plans', 'reuse-unchanged-plans': true })
  assert.throws(() => parseEngineArgs('plan-task', ['T1', '--reuse-unchanged-plans']), /Unknown option/)
})

test('start --cwd explica o comando válido e exige registro bem-sucedido antes do despacho', () => {
  assert.throws(() => parseEngineArgs('start', ['T1', '--agent', 'executor', '--cwd', '/projeto']),
    /start does not support --cwd; use start <task> --agent <executor> --run <run>.*wait for success before dispatching/)
  assert.deepEqual(parseEngineArgs('start', ['T1', '--agent', 'executor', '--run', 'run']), { _: ['T1'], agent: 'executor', run: 'run' })
})

for (const command of commands) {
  test(`${command}: opção desconhecida não executa ação`, () => assert.throws(() => parseEngineArgs(command, ['--typo']), /Unknown option/))
  test(`${command}: opção herdada não é comando nem flag`, () => assert.throws(() => parseEngineArgs(command, ['--constructor']), /Unknown option/))
  test(`${command}: run precisa de valor`, () => assert.throws(() => parseEngineArgs(command, ['--run']), /requires a value/))
  test(`${command}: outra opção não serve como nome da execução`, () => assert.throws(() => parseEngineArgs(command, ['--run', '--force']), /requires a value/))
  test(`${command}: run repetido não seleciona silenciosamente outra execução`, () => assert.throws(() => parseEngineArgs(command, ['--run', 'A', '--run', 'B']), /Duplicate option/))
  test(`${command}: argumentos excedentes não são ignorados`, () => assert.throws(() => parseEngineArgs(command, ['T1', 'T2']), /positional/))
  test(`${command}: nome da execução com espaços é preservado para validação posterior`, () => assert.equal(parseEngineArgs(command, ['--run', 'nome com espaços']).run, 'nome com espaços'))
}
for (const command of [undefined, '', 'typo', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) test(`comando não registrado ${String(command)} é recusado`, () => {
  assert.throws(() => parseEngineArgs(command, []), /Unknown engine command/)
})
const stringOptions = {
  init: ['plan', 'cwd'], 'sync-plan': ['plan', 'cwd'], 'show-check': ['check', 'attempt'], authorize: ['scope', 'mode', 'channel'],
  'finish-phase-discussion': ['context'], 'plan-phase': ['agent', 'plan-dir'], 'finish-phase-planning': ['plan-dir'],
  'begin-phase-discussion': ['agent'], 'begin-discussion': ['agent'],
  'pause-replanning': ['reason'], 'set-agent-limit': ['max', 'actor'],
  'finish-discussion': ['context'], 'plan-task': ['agent', 'context'], 'finish-planning': ['plan'],
  start: ['agent', 'executor'], progress: ['agent', 'step'], review: ['agent'], 'review-progress': ['agent', 'step'],
  'refresh-contract': ['plan'], validate: ['evidence', 'summary', 'cwd', 'tail'], fail: ['reason'],
  block: ['reason', 'question', 'option'], unblock: ['answer', 'reviewer'], skip: ['reason'], note: ['text'],
  'skip-phase-discussion': ['reason'], 'skip-phase-planning': ['reason'], 'skip-discussion': ['reason'], 'skip-planning': ['reason'],
}
for (const [command, options] of Object.entries(stringOptions)) for (const flag of options) {
  test(`${command}: --${flag} sem valor é recusado`, () => assert.throws(() => parseEngineArgs(command, [`--${flag}`]), /requires a value/))
  test(`${command}: --${flag} preserva texto literal`, () => {
    const text = 'Valor $literal; com espaços e acentos'
    assert.deepEqual(parseEngineArgs(command, [`--${flag}`, text])[flag], flag === 'option' ? [text] : text)
  })
}
test('block permite várias opções, em ordem', () => assert.deepEqual(parseEngineArgs('block', ['T1', '--option', 'A', '--option', 'B']).option, ['A', 'B']))
test('validate recusa dois vereditos simultâneos', () => assert.throws(() => parseEngineArgs('validate', ['T1', '--ok', '--failed']), /only one/))
test('flag booleana não consome tarefa seguinte', () => assert.deepEqual(parseEngineArgs('start', ['--confirmed-by-user', 'T1', '--agent', 'executor'])._, ['T1']))

test('init preserva a exceção explícita para sobreposição aprovada', () => {
  assert.equal(parseEngineArgs('init', ['--allow-overlap'])['allow-overlap'], true)
})

for (const command of commands.filter(command => command !== 'sync-plan')) {
  test(`${command}: --dry-run sem suporte não deve executar gravações reais`, () => {
    assert.throws(() => parseEngineArgs(command, ['--dry-run']), /Unknown option/)
  })
}

test('sync-plan aceita prévia e confirmação explícita sem consumir argumentos', () => {
  assert.deepEqual(parseEngineArgs('sync-plan', ['--dry-run', '--confirm-invalidation']),
    { _: [], 'dry-run': true, 'confirm-invalidation': true })
  assert.throws(() => parseEngineArgs('sync-plan', ['--dry-run', '--dry-run']), /Duplicate option/)
})

for (const [command, options] of Object.entries(stringOptions)) for (const flag of options.filter(flag => flag !== 'option')) {
  if (flag === 'agent' && ['plan-phase', 'begin-phase-discussion'].includes(command)) continue
  test(`${command}: repetir --${flag} não troca silenciosamente a entrada`, () => {
    assert.throws(() => parseEngineArgs(command, [`--${flag}`, 'A', `--${flag}`, 'B']), /Duplicate option/)
  })
}

for (const command of ['plan-phase', 'begin-phase-discussion']) test(`${command}: preserva agentes por alvo sem substituir os anteriores`, () => {
  assert.deepEqual(parseEngineArgs(command, ['F1', '--agent', 'T1=a', '--agent', 'T2=b', '--agent', 'T3=c']).agent,
    ['T1=a', 'T2=b', 'T3=c'])
})
