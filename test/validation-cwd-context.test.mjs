import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './fixtures/approved-graph.mjs'

test('contrato preserva barras invertidas Windows sem consumir escapes no init e no sync', t => {
  const windows = 'C:\\work\\test\\new-project'
  const f = fixture(t, { tasks: [{ id: 'T1', validation: [{ kind: 'functional', run: 'node --version', expect: 'Node executa', cwd: windows }] }] })
  assert.equal(f.state().tasks.T1.validation[0].cwd, windows)
  f.plan.tasks[0].summary = 'Preservar o caminho aprovado e seu significado.'
  f.writePlan(); f.ok('sync-plan', '--plan', f.source)
  assert.equal(f.state().tasks.T1.validation[0].cwd, windows)
})

for (const lang of ['en', 'pt-BR']) test(`cada verificação executa no cwd aprovado e informa seu diretório em ${lang}`, t => {
  const f = fixture(t, { lang })
  const other = join(f.home, 'other project'); mkdirSync(other)
  const run = "require('node:fs').writeFileSync('ran.txt', process.cwd())\n"
  writeFileSync(join(f.project, 'check.cjs'), run); writeFileSync(join(other, 'check.cjs'), run)
  const directories = [f.project, other.replaceAll('\\', '/')]
  f.plan.tasks[0].validation = directories.map(cwd => ({ kind: 'functional', run: 'node check.cjs', expect: 'Executar no projeto aprovado', cwd }))
  f.writePlan(); f.ok('sync-plan', '--plan', f.source)
  f.skipTaskPlan(); f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  const output = f.ok('validate', 'T1', '--ok', '--cwd', f.project, '--evidence', 'Cada verificação foi executada no projeto previsto')
  for (const [index, cwd] of directories.entries()) {
    assert.equal(readFileSync(join(cwd, 'ran.txt'), 'utf8').replaceAll('\\', '/'), cwd.replaceAll('\\', '/'))
    assert.ok(output.includes((lang === 'en' ? `Validation check ${index + 1}/2 directory: ` : `Diretório da verificação ${index + 1}/2: `) + cwd))
  }
  const checks = f.state().tasks.T1.validations.at(-1).checks
  assert.deepEqual(checks.map(check => check.cwd), directories)
})
