import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { captureDelivery, checkDelivery } from '../scripts/delivery-evidence.mjs'

function fixture(t, { declared = true } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'prumo-format-')))
  const cwd = join(home, 'project'), root = join(home, 'store', 'workspace'), run = join(root, '.specs', 'graph', 'format-check')
  mkdirSync(join(cwd, 'out'), { recursive: true }); mkdirSync(run, { recursive: true })
  assert.equal(spawnSync('git', ['init', cwd], { encoding: 'utf8', windowsHide: true }).status, 0)
  const task = { id: 'T1', phase: 'F2', title: 'Resultado financeiro', touches: ['out'], deps: [], state: 'pending',
    planningRequired: false, discussionRequired: false, discoveryRequired: false, attempts: [], validations: [], notes: [],
    validation: [{ kind: 'functional', run: 'node --version', expect: 'Node executa' }] }
  if (declared) task.deliveries = ['out/Program.cs', 'out/F2.cs', 'out/example.txt']
  const state = { schemaVersion: 1, run: 'format-check', createdAt: '2026-10-19T12:00:00Z',
    plan: { name: 'financial-output', planningMode: 'task', phases: [{ id: 'F2', title: 'Resultados' }], maxAgents: 3, requireReview: true, cwd }, tasks: { T1: task } }
  const write = (text, path = 'out/Program.cs') => writeFileSync(join(cwd, path), text)
  const statePath = join(run, 'state.json'), eventsPath = join(run, 'events.ndjson')
  const save = () => writeFileSync(statePath, JSON.stringify(state))
  save(); writeFileSync(eventsPath, ''); writeFileSync(join(dirname(run), 'CURRENT'), state.run)
  const cli = (lang, ...args) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/engine.mjs', import.meta.url)), ...args], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: { ...process.env, PRUMO_HOME: dirname(root), PRUMO_ROOT: root, PRUMO_RUN: state.run, PRUMO_LANG: lang },
    })
    assert.ifError(result.error)
    return result
  }
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  if (!declared) task.attempts.push({ deliveryBaseline: captureDelivery(task, cwd) })
  return { cwd, task, state, write, save, cli, statePath, eventsPath, check: () => checkDelivery(state, task, cwd) }
}

test('formatos numericos C# sao aceitos somente na posicao de formato', t => {
  const f = fixture(t)
  f.state.plan.phases.push(...['N2', 'P1', 'D4', 'X2', 'E3', 'B2', 'C2', 'G3', 'R2'].map(id => ({ id })))
  const before = JSON.stringify(f.state)
  for (const source of [
    'Console.WriteLine($"Total: {amount:F2}");',
    'Console.WriteLine($"Total: {amount,12:f2}");',
    'Console.WriteLine($@"Total: {report.Amount:F2}");',
    'Console.WriteLine(@$"Total: {report.Amount:F2}");',
    'var total = amount.ToString("F2");',
    'var total = amount . ToString ( @"F2", culture);',
    'var total = string.Format("Total {0:F2} / {1,12:F2}", amount, other);',
    'var total = string.Format(@"Total {0:F2}", amount);',
    'var other = "unrelated"; /* comentario sem metadados */ var total = $"{amount:F2}";',
    'var quote = \'"\'; var total = $"{amount:F2}";',
    'var text = "\\"quoted\\""; var total = $"{amount:F2}";',
    'var text = @"a ""quote"""; var total = $"{amount:F2}";',
    'var text = """unrelated raw text"""; var total = $"{amount:F2}";',
    'var total = $"{amount:N2} {amount:P1} {amount:D4} {amount:X2} {amount:E3}";',
    'var total = $"{amount:B2} {amount:C2} {amount:G3} {amount:R2}";',
    'var total = amount.ToString("F2", culture);',
    'var total = string.Format("{0, -12:F2}", amount);',
    'Console.WriteLine("Total {0:F2}", amount);',
    'var total = System.String.Format("{0:F2}", amount);',
    'Console.Write("{0:F2}", amount);',
    'System.Console.WriteLine("{0:F2}", amount);',
  ]) {
    f.write(source)
    assert.ok(f.check().fingerprint, source)
    assert.equal(readFileSync(join(f.cwd, 'out/Program.cs'), 'utf8'), source)
  }
  assert.equal(JSON.stringify(f.state), before)
})

test('identificadores reais e contextos que nao comprovam formatacao continuam recusados', t => {
  const f = fixture(t)
  for (const source of [
    'var phase = "F2";', 'var phase = "F2"; var total = $"{amount:F2}";',
    'var total = $"F2 {amount:F2}";', 'var total = $"{F2:F2}";', 'var total = $"{T1:F2}";',
    '// var total = $"{amount:F2}";', '/* var total = amount.ToString("F2"); */',
    '/* comentario\nvar total = $"{amount:F2}";\n*/',
    'var literal = "{amount:F2}";', 'var total = $"{{amount:F2}}";',
    'var total = string.Format("{{0:F2}}", amount);',
    'var total = amount.ToString("F2" + " texto");', 'var total = amount.Other("F2");',
    'var literal = "amount.ToString(\\"F2\\")";',
    'var total = $"{amount: F2}";', 'var total = $"{amount:F2 extra}";',
    'var total = $"{amount:Z2}"; // F2', 'var total = "{amount:F2}"; // sem interpolacao',
    'var literal = """{amount:F2}""";', 'var literal = $$"""{{amount:F2}}""";',
    '/* comentario sem fechamento: $"{amount:F2}"', 'var raw = """F2',
    'var total = amount.ToString("F2";', 'var phase = \'F2\';',
    'var total = amount.ToString("F2") + " financial-output";',
    'var literal = "{0:F2}";', 'var literal = Other.Format("{0:F2}", amount);',
    'Console.WriteLine("{0:F2}");', 'var literal = string.Format("{0:F2}");',
    'var literal = Other.String.Format("{0:F2}", amount);',
    'var literal = string.Format("{amount:F2}", amount);',
  ]) {
    f.write(source)
    assert.throws(f.check, /Delivery identifiers refused: out\/Program.cs:/, source)
  }
  f.write('var total = $"{amount:F2}";', 'out/F2.cs')
  assert.throws(f.check, /out\/F2.cs:0/)
  rmSync(join(f.cwd, 'out/F2.cs'))
  f.write('var total = $"{amount:F2}";', 'out/example.txt')
  assert.throws(f.check, /out\/example.txt:1/)
})

test('formatacao nao dispensa padroes explicitos nem excecoes exatas de caminho e linha', t => {
  const f = fixture(t)
  f.write('var total = $"{amount:F2}";')
  f.task.textRules = { patterns: ['F2'] }
  assert.throws(f.check, /out\/Program.cs:1/)
  f.task.textRules.exceptions = [{ path: 'out/Program.cs', line: 1, identifier: 'f2' }]
  assert.ok(f.check().fingerprint)
  f.write('var total = $"{amount:F2}";\nvar phase = "F2";')
  assert.throws(f.check, /out\/Program.cs:2/)
  delete f.task.textRules
  f.state.plan.name = 'F2'
  assert.throws(f.check, /out\/Program.cs:1/)
  f.state.plan.name = 'financial-output'; f.state.run = 'F2'
  assert.throws(f.check, /out\/Program.cs:1/)
  f.state.run = 'format-check'; f.state.tasks.F2 = { id: 'F2' }
  assert.throws(f.check, /out\/Program.cs:1/)
})

for (const lang of ['en', 'pt-BR']) test(`revisao permite formato numerico e preserva recusa de metadados em ${lang}`, t => {
  const f = fixture(t, { declared: false })
  f.task.attempts = []; f.save()
  const start = f.cli(lang, 'start', 'T1', '--agent', 'author')
  assert.equal(start.status, 0, start.stdout + start.stderr)
  f.write('var total = $"{amount:F2}"; // T1')
  const stateBefore = readFileSync(f.statePath), eventsBefore = readFileSync(f.eventsPath)
  const refused = f.cli(lang, 'review', 'T1', '--agent', 'reviewer')
  assert.equal(refused.status, 1, refused.stdout + refused.stderr)
  assert.match(refused.stdout + refused.stderr, /out\/Program.cs:1/)
  assert.deepEqual(readFileSync(f.statePath), stateBefore)
  assert.deepEqual(readFileSync(f.eventsPath), eventsBefore)
  f.write('var total = $"{amount:F2}";')
  const review = f.cli(lang, 'review', 'T1', '--agent', 'reviewer')
  assert.equal(review.status, 0, review.stdout + review.stderr)
  const saved = JSON.parse(readFileSync(f.statePath))
  assert.equal(saved.tasks.T1.state, 'reviewing')
  assert.equal(saved.tasks.T1.reviewer, 'reviewer')
  assert.equal(saved.tasks.T1.attempts.length, 1)
})
