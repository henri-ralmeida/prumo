import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEngineArgs } from '../scripts/engine-args.mjs'

// Lista do contrato público, independente da tabela usada pelo parser.
const commands = ['init', 'migrate', 'sync-plan', 'status', 'ready', 'graph', 'runs', 'show-contract', 'show-check', 'authorize',
  'begin-phase-discussion', 'skip-phase-discussion', 'finish-phase-discussion', 'plan-phase', 'skip-phase-planning', 'finish-phase-planning',
  'begin-discussion', 'skip-discussion', 'finish-discussion', 'plan-task', 'skip-planning', 'finish-planning', 'start', 'progress',
  'review', 'review-progress', 'refresh-contract', 'validate', 'done', 'fail', 'retry', 'block', 'unblock', 'skip', 'note']

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
  init: ['plan'], 'sync-plan': ['plan'], 'show-check': ['check', 'attempt'], authorize: ['scope', 'mode', 'channel'],
  'finish-phase-discussion': ['context'], 'plan-phase': ['agent', 'plan-dir'], 'finish-phase-planning': ['plan-dir'],
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

for (const command of commands) {
  test(`${command}: --dry-run sem suporte não deve executar gravações reais`, () => {
    assert.throws(() => parseEngineArgs(command, ['--dry-run']), /Unknown option/)
  })
}

for (const [command, options] of Object.entries(stringOptions)) for (const flag of options.filter(flag => flag !== 'option')) {
  test(`${command}: repetir --${flag} não troca silenciosamente a entrada`, () => {
    assert.throws(() => parseEngineArgs(command, [`--${flag}`, 'A', `--${flag}`, 'B']), /Duplicate option/)
  })
}
