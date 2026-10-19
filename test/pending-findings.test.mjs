import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fixture, check } from './fixtures/approved-graph.mjs'
import { validationProjectMismatch } from '../scripts/task-scope.mjs'

test('plan-phase imprime JSON copiavel com vinculo da rodada e entradas pendentes por tarefa', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2', deps: ['T1'] }] })
  f.ok('begin-phase-discussion', 'F1')
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  const output = f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans)
  const round = f.state().phaseWorkflows.F1.planningAttempts.at(-1)
  assert.ok(round.requiredInputs.T2.length > 0)
  const blocks = [...output.matchAll(/Copy these fields into task-plan-(T\d+)\.json:\s*```json\s*([\s\S]*?)\s*```/g)]
  assert.deepEqual(blocks.map(match => match[1]), ['T1', 'T2'])
  for (const [, id, json] of blocks) assert.deepEqual(JSON.parse(json), {
    phaseBinding: { phaseId: 'F1', discussionRoundId: round.discussionRoundId, plannerRound: round.n },
    unresolvedInputs: round.requiredInputs[id],
  })
})

test('alterar uma dependencia preserva planos e aceites das tarefas inalteradas da fase', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] })
  f.ok('skip', 'T3', '--reason', 'Dependencia dispensada explicitamente')
  f.planPhase()
  const before = f.state()
  f.plan.tasks[1].deps = ['T3']; f.writePlan(); f.ok('sync-plan', '--plan', f.source, '--confirm-invalidation')
  assert.deepEqual(f.state().tasks.T1, before.tasks.T1)
  assert.ok(before.tasks.T1.taskPlan)
  assert.deepEqual(f.state().tasks.T1.taskPlan, before.tasks.T1.taskPlan)
  assert.ok(!f.state().phaseWorkflows.F1.contractConfirmationRequired.tasks.includes('T1'))
  assert.deepEqual(f.state().phaseWorkflows.F1.contractConfirmationRequired.tasks, ['T2'])
  f.ok('begin-phase-discussion', 'F1')
  assert.deepEqual(f.state().phaseWorkflows.F1.discussionAttempts.at(-1).confirmsContract.map(item => item.task), ['T2'])
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans)
  f.artifacts('F1'); f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans)
  assert.deepEqual(f.state().tasks.T1, before.tasks.T1)
  f.ok('start', 'T1', '--agent', 'executor')
})

test('planejamento aberto reaproveita artefato inalterado e reconfirma somente o contrato alterado', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] })
  f.ok('skip', 'T3', '--reason', 'Dependencia dispensada explicitamente')
  f.ok('begin-phase-discussion', 'F1'); f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans); f.artifacts('F1')
  const unchangedPath = join(f.plans, 'task-plan-T1.json'), original = readFileSync(unchangedPath, 'utf8')
  const before = f.state()
  f.plan.tasks[1].deps = ['T3']; f.writePlan(); f.ok('sync-plan', '--plan', f.source, '--confirm-invalidation')
  f.ok('begin-phase-discussion', 'F1')
  const round = f.state().phaseWorkflows.F1.discussionAttempts.at(-1)
  assert.deepEqual(round.confirmsContract.map(item => item.task), ['T2'])
  f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
  f.ok('plan-phase', 'F1', '--agent', 'planner', '--plan-dir', f.plans)
  f.artifacts('F1'); writeFileSync(unchangedPath, original)
  f.ok('finish-phase-planning', 'F1', '--plan-dir', f.plans, '--reuse-unchanged-plans')
  assert.deepEqual(f.state().tasks.T1.taskPlan.research, JSON.parse(original).research)
  assert.deepEqual(f.state().tasks.T1.taskPlan.reusedFrom, JSON.parse(original).phaseBinding)
  assert.deepEqual(f.state().tasks.T1.executionAuthorization, before.tasks.T1.executionAuthorization)
  assert.equal(f.state().tasks.T2.executionAuthorization, undefined)
})

for (const legacy of [false, true]) test(`sincronizacao preserva confirmacoes pendentes, formato legado ${legacy}`, t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }, { id: 'T4' }] })
  f.ok('skip', 'T3', '--reason', 'Dependencia dispensada pelo usuario')
  f.ok('skip', 'T4', '--reason', 'Dependencia dispensada pelo usuario')
  f.planPhase()
  f.plan.tasks[0].deps = ['T3']
  f.plan.tasks[1].deps = ['T3']; f.writePlan(); f.ok('sync-plan', '--plan', f.source, '--confirm-invalidation')
  const unchanged = f.state().tasks.T1
  if (legacy) {
    const imported = f.state(); delete imported.phaseWorkflows.F1.contractConfirmationRequired.tasks; f.importState(imported)
  }
  f.ok('begin-phase-discussion', 'F1')
  f.plan.tasks[1].deps = ['T4']; f.writePlan(); f.ok('sync-plan', '--plan', f.source)
  const expected = ['T1', 'T2']
  assert.deepEqual(f.state().phaseWorkflows.F1.contractConfirmationRequired.tasks, expected)
  assert.deepEqual(f.state().tasks.T1, unchanged)
  f.ok('begin-phase-discussion', 'F1')
  assert.deepEqual(f.state().phaseWorkflows.F1.discussionAttempts.at(-1).confirmsContract.map(item => item.task), expected)
})

for (const [lang, explicitProject] of [['en', true], ['pt-BR', false]]) test(`validate e done avisam projeto divergente sem recusar em ${lang}, projeto explicito ${explicitProject}`, t => {
  const f = fixture(t, { git: true, lang, tasks: [{ id: 'T1', writeScope: 'files', touches: ['out.txt'] }] })
  if (explicitProject) f.plan.tasks[0].project = f.project
  f.plan.scopePolicy = 'explicit'; f.writePlan(); f.ok('sync-plan', '--plan', f.source)
  const other = join(f.home, 'other'); mkdirSync(other)
  const git = (...args) => { const r = spawnSync('git', ['-C', other, ...args], { windowsHide: true, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr) }
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(other, 'check.cjs'), "require('node:assert/strict').equal(1, 1)\n")
  git('add', '.'); git('commit', '-m', 'Base')
  f.plan.tasks[0].validation = [{ ...check, cwd: other }]; f.writePlan()
  assert.match(f.ok('sync-plan', '--plan', f.source), lang === 'en' ? /different Git repositor/ : /repositórios Git diferentes/)
  assert.equal(validationProjectMismatch({ project: other }, f.project, other), null)
  const subdir = join(other, 'nested'); mkdirSync(subdir)
  assert.equal(validationProjectMismatch({ project: other }, f.project, subdir), null)
  assert.equal(validationProjectMismatch({}, undefined, other), null)
  assert.equal(validationProjectMismatch({}, f.project, undefined), null)
  assert.equal(validationProjectMismatch({}, join(f.home, 'missing'), other), null)
  assert.equal(validationProjectMismatch({}, f.project, join(f.home, 'missing')), null)
  f.skipTaskPlan(); f.ok('authorize', '--scope', 'run', '--confirmed-by-user')
  f.ok('start', 'T1', '--agent', 'executor')
  writeFileSync(join(other, 'out.txt'), 'Entrega em outro repositorio\n')
  f.ok('review', 'T1', '--agent', 'reviewer')
  const output = f.ok('validate', 'T1', '--ok', '--cwd', other, '--evidence', 'Verificacao funcional executada em outro projeto')
  assert.match(output, lang === 'en' ? /WARNING:.*different Git repositor/ : /AVISO:.*repositórios Git diferentes/)
  const receipt = f.state().tasks.T1.validations.at(-1)
  assert.deepEqual(receipt.scopeCheck.paths, [])
  assert.equal(receipt.validationProjectMismatches[0].validationCwd, other)
  const historical = f.state()
  delete historical.tasks.T1.validations.at(-1).validationProjectMismatches
  f.importState(historical)
  assert.match(f.ok('done', 'T1'), lang === 'en' ? /different Git repositor/ : /repositórios Git diferentes/)
  assert.equal(f.state().tasks.T1.state, 'done')
})

test('avisos de sintaxe e inspecao sao bilingues sem executar comandos durante sincronizacao', t => {
  const f = fixture(t, { lang: 'pt-BR', tasks: [{ id: 'T1', validationMode: 'inspection', inspectionReason: 'Somente conteudo documental.', validation: [{ run: 'Inspecionar os resultados', expect: 'Explicacao corresponde ao contrato' }] }] })
  const before = f.state(), events = f.events()
  assert.doesNotMatch(f.ok('sync-plan', '--plan', f.source, '--dry-run'), /parece texto de inspeção/)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  const command = fixture(t, { lang: 'pt-BR', tasks: [{ id: 'T1', validation: [{ ...check, run: 'Inspecionar os resultados' }] }] })
  const commandState = command.state(), commandEvents = command.events()
  assert.match(command.ok('sync-plan', '--plan', command.source, '--dry-run'), /parece texto de inspeção/)
  assert.deepEqual(command.state(), commandState); assert.equal(command.events(), commandEvents)
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  assert.match(f.ok('review-progress', 'T1', '--step', '1', '--agent', 'reviewer'), /--evidence <observações>/)
  const current = f.state(), currentEvents = f.events()
  assert.match(f.ok('review-progress', 'T1', '--step', '1', '--agent', 'reviewer'), /nenhuma flag.*comprova/)
  assert.deepEqual(f.state(), current); assert.equal(f.events(), currentEvents)
  assert.match(f.ok('review-progress', 'T1', '--help'), /--evidence <observações>/)
  assert.match(f.ok('review-progress', '--help'), /--evidence <observações>/)
})

test('sincronizacao exige remocao explicita de tarefa nunca executada e preserva seu registro', t => {
  const f = fixture(t, { tasks: [{ id: 'T1' }, { id: 'T2' }] })
  const original = f.state().tasks.T2
  f.plan.tasks.pop(); f.writePlan()
  f.rejects(/additive|aditivo/, 'sync-plan', '--plan', f.source)
  f.rejects(/reason|motivo/, 'sync-plan', '--plan', f.source, '--remove', 'T2')
  const before = f.state(), events = f.events()
  assert.match(f.ok('status'), /--remove and --reason.*--dry-run/)
  f.ok('ready')
  f.ok('sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Unificar trabalho ainda nao iniciado', '--dry-run')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  f.ok('sync-plan', '--plan', f.source, '--remove', 'T2', '--reason', 'Unificar trabalho ainda nao iniciado')
  const current = f.state()
  assert.equal(current.tasks.T2, undefined)
  assert.deepEqual(current.removedTasks.T2.task, original)
  assert.equal(current.removedTasks.T2.reason, 'Unificar trabalho ainda nao iniciado')
  assert.match(f.events(), /task_removed/)
  f.ok('ready'); f.ok('status'); f.ok('graph')
  const archived = f.state(); f.ok('migrate'); assert.deepEqual(f.state(), archived)
  f.plan.tasks.push({ ...original, deps: [], validation: [check] }); f.writePlan()
  f.rejects(/removed.*identifier|identificador.*removid/, 'sync-plan', '--plan', f.source)
})

test('progresso de revisao orienta registrar observacoes na validacao sem inventar comprovacao', t => {
  const f = fixture(t, { phase: true, tasks: [{ id: 'T1', validationMode: 'inspection', inspectionReason: 'A entrega altera somente documentacao.', validation: 'Conferir a clareza da explicacao' }] })
  f.planPhase('F1', value => { value.verification = [{ criterion: 'A explicacao corresponde ao comportamento entregue', check: 'inspection' }] })
  f.ok('start', 'T1', '--agent', 'executor'); f.ok('review', 'T1', '--agent', 'reviewer')
  const output = f.ok('review-progress', 'T1', '--step', '1', '--agent', 'reviewer')
  assert.match(output, /validate T1 --ok --evidence/)
  assert.match(output, /not proof|não comprova/)
  f.ok('validate', 'T1', '--ok', '--evidence', 'Explicacao da entrega inspecionada no contexto real')
  const historical = f.state()
  delete historical.tasks.T1.validations.at(-1).validationProjectMismatches
  const withoutChecks = structuredClone(historical)
  delete withoutChecks.tasks.T1.validations.at(-1).checks
  f.importState(withoutChecks)
  const events = f.events()
  f.rejects(/validation receipt has no checks/, 'done', 'T1')
  assert.deepEqual(f.state(), withoutChecks); assert.equal(f.events(), events)
  f.importState(historical)
  f.ok('done', 'T1')
  assert.deepEqual(f.state().tasks.T1.validations, historical.tasks.T1.validations)
})

test('sincronizacao avisa cedo sobre texto sem comando sem recusar sintaxe legitima de shell', t => {
  const f = fixture(t)
  f.plan.tasks[0].validation = [{ ...check, run: 'Inspecionar os previews e conferir os resultados' }]; f.writePlan()
  const before = f.state(), events = f.events()
  assert.match(f.ok('sync-plan', '--plan', f.source, '--dry-run'), /validationMode.*inspection/)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  for (const run of ['echo comportamento aprovado', 'node check.cjs', '"node" check.cjs']) {
    f.plan.tasks[0].validation = [{ ...check, run }]; f.writePlan()
    assert.doesNotMatch(f.ok('sync-plan', '--plan', f.source, '--dry-run'), /validationMode.*inspection/)
  }
})

test('contrato textual de inspecao continua legivel sem exigir um comando de shell', t => {
  const f = fixture(t, { tasks: [{ id: 'T1', writeScope: 'files', touches: ['guide.md'],
    validationMode: 'inspection', inspectionReason: 'A entrega altera somente uma explicacao documental.',
    validation: 'Conferir se a explicacao corresponde ao comportamento aprovado' }] })
  const before = f.state(), events = f.events()
  assert.doesNotMatch(f.ok('sync-plan', '--plan', f.source, '--dry-run'), /looks like inspection prose/)
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
})

for (const validation of ['Contrato textual historico', [null]]) test(`diagnostico preserva contrato terminal e permite continuar outra tarefa: ${JSON.stringify(validation)}`, t => {
  const f = fixture(t, { tasks: [{ id: 'T1' }, { id: 'T2' }] })
  f.ok('skip', 'T1', '--reason', 'Entrega dispensada pelo usuario')
  const original = f.state().tasks.T1
  f.plan.tasks[0].validation = validation; f.writePlan()
  f.ok('sync-plan', '--plan', f.source)
  assert.deepEqual(f.state().tasks.T1, original)
  f.skipTaskPlan('T2'); f.ok('start', 'T2', '--agent', 'executor')
  assert.deepEqual(f.state().tasks.T1, original)
  assert.equal(f.state().tasks.T2.attempts.length, 1)
})
