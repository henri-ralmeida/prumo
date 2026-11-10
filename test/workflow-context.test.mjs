import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fixture } from './fixtures/approved-graph.mjs'
import { taskBrief } from '../scripts/run-metadata.mjs'

test('contrato localiza o estado e a descoberta aprovada da fase sem alterar o histórico', t => {
  const f = fixture(t, { phase: true })
  assert.equal(JSON.parse(f.ok('show-contract', 'T1')).phaseContext.discovery, null)
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  const before = f.state(), events = f.events()
  const shown = JSON.parse(f.ok('show-contract', 'T1', '--full'))
  assert.equal(shown.run, 'audit')
  assert.equal(shown.statePath, join(f.root, '.specs/graph/audit/state.json'))
  assert.equal(shown.phaseContext.phase, 'F1')
  assert.equal(shown.phaseContext.discovery.digest, before.phaseWorkflows.F1.discovery.digest)
  assert.deepEqual(shown.phaseContext.discovery.coverage, before.phaseWorkflows.F1.discovery.coverage)
  assert.deepEqual(f.state(), before)
  assert.equal(f.events(), events)
  const task = fixture(t)
  assert.equal(JSON.parse(task.ok('show-contract', 'T1')).phaseContext, null)
})

test('brief de revisão usa o projeto da tarefa e conserva o projeto padrão para contratos antigos', () => {
  const state = { plan: { cwd: '/projeto/principal' }, tasks: {} }
  const task = { id: 'T1', project: '/projeto/entrega' }
  const brief = taskBrief(state, task, 'reviewer', tokens => tokens.join(' '))
  assert.equal(brief.contract.project, task.project)
  assert.match(brief.commands.at(-1), /--cwd \/projeto\/entrega$/)
  delete task.project
  assert.match(taskBrief(state, task, 'reviewer', tokens => tokens.join(' ')).commands.at(-1), /--cwd \/projeto\/principal$/)
})

for (const lang of ['en', 'pt-BR']) test(`ready avisa sobre validações paralelas no mesmo projeto sem bloquear a execução em ${lang}`, t => {
  const f = fixture(t, { lang, tasks: [{ id: 'T1', touches: ['a'] }, { id: 'T2', touches: ['b'] }] })
  f.skipTaskPlan('T1'); f.skipTaskPlan('T2')
  const before = f.state(), events = f.events()
  const output = f.ok('ready')
  assert.match(output, lang === 'en' ? /T1.*T2.*share validation project/ : /T1.*T2.*compartilham o projeto de validação/)
  assert.ok(output.includes(f.project))
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('start', 'T1', '--agent', 'executor-a')
  assert.match(f.ok('ready'), /T1.*T2|T2.*T1/)
  f.ok('start', 'T2', '--agent', 'executor-b')
  assert.equal(f.state().tasks.T2.state, 'running')
})

for (const scenario of ['projetos diferentes', 'dependência', 'um executor', 'inspeção sem comandos']) test(`ready não avisa compartilhamento paralelo com ${scenario}`, t => {
  const inspection = scenario === 'inspeção sem comandos'
    ? { validationMode: 'inspection', inspectionReason: 'Conferir somente o documento, sem compilar ou executar testes.', validation: 'Conferir o conteúdo aprovado' } : {}
  const f = fixture(t, { tasks: [{ id: 'T1', ...inspection }, { id: 'T2', ...inspection, ...(scenario === 'dependência' ? { deps: ['T1'] } : {}) }] })
  if (scenario === 'projetos diferentes') {
    const other = join(f.home, 'other'); mkdirSync(other)
    f.plan.tasks[1].validation = [{ ...f.plan.tasks[1].validation[0], cwd: other }]
  }
  f.writePlan(); f.ok('sync-plan', '--plan', f.source)
  if (scenario === 'um executor') f.ok('set-agent-limit', '--max', '1', '--actor', 'user', '--confirmed-by-user')
  f.skipTaskPlan('T1')
  if (scenario !== 'dependência') f.skipTaskPlan('T2')
  assert.doesNotMatch(f.ok('ready'), /share validation project|compartilham o projeto de validação/)
})

test('aprovação em outro repositório exige revisão independente mesmo em contrato legado com revisão opcional', t => {
  const f = fixture(t, { git: true }), other = join(f.home, 'other')
  mkdirSync(other)
  assert.equal(spawnSync('git', ['init', other], { windowsHide: true }).status, 0)
  writeFileSync(join(other, 'check.cjs'), "require('node:assert/strict').equal(1, 1)\n")
  f.plan.requireReview = false
  f.plan.tasks[0].validation = [{ ...f.plan.tasks[0].validation[0], cwd: other }]
  f.writePlan(); f.ok('sync-plan', '--plan', f.source)
  const legacy = f.state()
  delete legacy.tasks.T1.touches
  f.importState(legacy)
  f.skipTaskPlan(); f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
  const before = f.state()
  const events = f.events()
  f.rejects(/--scope-evidence/, 'validate', 'T1', '--ok', '--evidence', 'Autorrelato', '--scope-evidence', 'O próprio executor conferiu')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.ok('validate', 'T1', '--ok', '--evidence', 'Verificação independente', '--scope-evidence', 'Revisor conferiu check.cjs no outro repositório')
  assert.equal(f.state().tasks.T1.validations.at(-1).validationProjectEvidence.agent, 'reviewer')
  f.ok('done', 'T1')
})

test('validação entre repositórios mantém inspeção independente sem baseline Git na tentativa legada', t => {
  const f = fixture(t, { git: true, tasks: [{ id: 'T1', writeScope: 'files', touches: ['out.txt'] }] })
  const other = join(f.home, 'other'); mkdirSync(other)
  assert.equal(spawnSync('git', ['init', other], { windowsHide: true }).status, 0)
  writeFileSync(join(other, 'check.cjs'), "require('node:assert/strict').equal(1, 1)\n")
  f.plan.scopePolicy = 'explicit'
  f.plan.tasks[0].validation = [{ ...f.plan.tasks[0].validation[0], cwd: other }]
  f.writePlan(); f.ok('sync-plan', '--plan', f.source)
  f.skipTaskPlan(); f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
  const legacy = f.state()
  delete legacy.tasks.T1.attempts.at(-1).scopeBaseline
  f.importState(legacy)
  f.ok('review', 'T1', '--agent', 'reviewer')
  const before = f.state(), events = f.events()
  f.rejects(/--scope-evidence/, 'validate', 'T1', '--ok', '--evidence', 'Relato sem inspeção de escopo')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('validate', 'T1', '--ok', '--evidence', 'Entrega inspecionada', '--scope-evidence', 'Revisor conferiu os caminhos e a atribuição no outro repositório')
  const scope = f.state().tasks.T1.validations.at(-1).scopeCheck
  assert.equal(scope.method, 'independent-review')
  assert.equal(scope.agent, 'reviewer')
  assert.match(scope.evidence, /caminhos e a atribuição/)
  f.ok('done', 'T1')
})

test('validação legada reconfere a evidência quando o comando deixa o escopo aprovado vazio', t => {
  const f = fixture(t, { git: true, tasks: [{ id: 'T1', writeScope: 'files', touches: ['out.txt'] }] })
  const file = join(f.project, 'out.txt'), other = join(f.home, 'other')
  writeFileSync(file, 'base\n'); f.gitCommand('add', '.'); f.gitCommand('commit', '-m', 'Base da entrega')
  mkdirSync(other)
  assert.equal(spawnSync('git', ['init', other], { windowsHide: true }).status, 0)
  writeFileSync(join(other, 'check.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'base\\n')`)
  f.plan.scopePolicy = 'explicit'
  f.plan.tasks[0].validation = [{ ...f.plan.tasks[0].validation[0], cwd: other }]
  f.writePlan(); f.ok('sync-plan', '--plan', f.source)
  f.skipTaskPlan(); f.ok('authorize', '--scope', 'tasks:T1', '--confirmed-by-user'); f.ok('start', 'T1', '--agent', 'executor')
  const legacy = f.state()
  delete legacy.tasks.T1.attempts.at(-1).deliveryBaseline
  f.importState(legacy)
  writeFileSync(file, 'entrega nova\n')
  f.ok('review', 'T1', '--agent', 'reviewer')
  f.rejects(/--scope-evidence/, 'validate', 'T1', '--ok', '--cwd', other, '--evidence', 'Verificação em outro projeto')
  assert.equal(f.state().tasks.T1.validations.at(-1).ok, false)
  assert.equal(f.state().tasks.T1.state, 'reviewing')
  writeFileSync(file, 'entrega nova\n')
  f.ok('validate', 'T1', '--ok', '--cwd', other, '--evidence', 'Verificação independente', '--scope-evidence', 'Revisor inspecionou out.txt e a restauração feita pelo comando')
  assert.equal(f.state().tasks.T1.validations.at(-1).validationProjectEvidence.agent, 'reviewer')
  f.ok('done', 'T1')
})
