import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPhaseTaskPlan, phaseRequiredInputs, executionInputReceipt, phasePlanningContext } from '../scripts/validation.mjs'

function fixture() {
  const task = { id: 'T', phase: 'F2', title: 'Entrega', deps: ['B', 'A'], touches: ['src'], attempts: [],
    validation: [{ kind: 'functional', run: 'node check.cjs', expect: 'Regra aprovada' }] }
  const state = { plan: { name: 'Entrega aprovada', description: 'Regras confirmadas', requireReview: true }, tasks: { T: task,
    A: { ...task, id: 'A', phase: 'F1', state: 'pending', deps: [], attempts: [] },
    B: { ...task, id: 'B', phase: 'F1', state: 'pending', deps: [], attempts: [] } } }
  const binding = { phaseId: 'F2', discussionRoundId: 'D1', plannerRound: 1 }
  const plan = { research: [{ source: 'Contrato', findings: 'Regras inspecionadas' }], decisions: [],
    steps: ['Entregar comportamento aprovado'], verification: [{ criterion: 'Regra aprovada', check: 1 }],
    openQuestions: [], phaseBinding: { ...binding }, unresolvedInputs: phaseRequiredInputs(state, task) }
  return { state, task, plan, binding }
}

test('plano de fase aceita dependências completas em qualquer ordem', () => {
  const f = fixture(); f.plan.unresolvedInputs.reverse()
  assert.doesNotThrow(() => assertPhaseTaskPlan(f.state, f.task, f.plan, f.binding))
})
for (const field of ['phaseId', 'discussionRoundId', 'plannerRound']) for (const value of [undefined, null, '', 0, false, [], {}, 'outra']) {
  test(`plano recusa vínculo divergente ${field}=${JSON.stringify(value)}`, () => {
    const f = fixture(); f.plan.phaseBinding[field] = value
    assert.throws(() => assertPhaseTaskPlan(f.state, f.task, f.plan, f.binding), /binding must match/)
  })
}
for (const inputs of [undefined, null, false, {}, [null], [{}], [{ task: 'A', requiredEvidence: 'Recibo' }]]) {
  test(`plano recusa dependências malformadas ${JSON.stringify(inputs)}`, () => {
    const f = fixture(); f.plan.unresolvedInputs = inputs
    assert.throws(() => assertPhaseTaskPlan(f.state, f.task, f.plan, f.binding), /unresolvedInputs must/)
  })
}
for (const kind of ['missing', 'duplicate', 'other-phase', 'other-task']) test(`plano recusa dependência ${kind} sem alterar entradas`, () => {
  const f = fixture()
  if (kind === 'missing') f.plan.unresolvedInputs.pop()
  else if (kind === 'duplicate') f.plan.unresolvedInputs.push({ ...f.plan.unresolvedInputs[0] })
  else f.plan.unresolvedInputs[0][kind === 'other-phase' ? 'phase' : 'task'] = 'OUTRO'
  const before = structuredClone(f)
  assert.throws(() => assertPhaseTaskPlan(f.state, f.task, f.plan, f.binding), /missing .*unexpected .*expected JSON/)
  assert.deepEqual(f, before)
})
test('plano preserva as dependências capturadas mesmo se elas terminarem durante o planejamento', () => {
  const f = fixture(), expected = structuredClone(f.plan.unresolvedInputs)
  f.state.tasks.A.state = 'done'; f.state.tasks.B.state = 'skipped'
  assert.deepEqual(phaseRequiredInputs(f.state, f.task), [])
  assert.doesNotThrow(() => assertPhaseTaskPlan(f.state, f.task, f.plan, f.binding, expected))
  assert.throws(() => assertPhaseTaskPlan(f.state, f.task, f.plan, f.binding), /unexpected/)
})
for (const state of ['pending', 'planning', 'running', 'reviewing', 'blocked', 'failed']) {
  test(`dependência ${state} não fornece recibo de execução`, () => {
    const f = fixture(); f.task.deps = ['A']; f.state.tasks.A.state = state
    assert.throws(() => executionInputReceipt(f.state, f.task), /still waiting on: A/)
  })
}
for (const reason of [undefined, null, '', ' ', false, 0]) test(`dispensa sem motivo ${JSON.stringify(reason)} não libera execução`, () => {
  const f = fixture(); f.task.deps = ['A']; Object.assign(f.state.tasks.A, { state: 'skipped', skipReason: reason })
  assert.throws(() => executionInputReceipt(f.state, f.task), /skip waiver needs a reason/)
})
for (const receipt of [undefined, null, {}, { ok: false, attempt: 1 }, { ok: true, attempt: 0 }, { ok: true, attempt: 2 }]) {
  test(`dependência concluída exige recibo da tentativa atual ${JSON.stringify(receipt)}`, () => {
    const f = fixture(); f.task.deps = ['A']; Object.assign(f.state.tasks.A, { state: 'done', attempts: [{}], validations: [receipt] })
    assert.throws(() => executionInputReceipt(f.state, f.task), /no current passing validation/)
  })
}
test('recibos ordenam dependências e mudam quando a evidência aprovada muda', () => {
  const f = fixture()
  Object.assign(f.state.tasks.A, { state: 'done', attempts: [{}], validations: [{ ok: true, attempt: 1, evidence: 'Resultado aprovado', token: 'receipt-A' }] })
  Object.assign(f.state.tasks.B, { state: 'skipped', skipReason: 'Escopo cancelado pelo usuário' })
  const before = executionInputReceipt(f.state, f.task)
  assert.deepEqual(before.inputs.map(input => [input.task, input.result]), [['A', 'validated'], ['B', 'waived']])
  f.task.deps.reverse(); assert.deepEqual(executionInputReceipt(f.state, f.task), before)
  f.state.tasks.A.validations[0].evidence = 'Outro resultado aprovado'
  assert.notEqual(executionInputReceipt(f.state, f.task).digest, before.digest)
})
test('contexto de fase inclui dependências transitivas e ignora notas de progresso', () => {
  const f = fixture(); f.task.deps = ['B']; f.state.tasks.B.deps = ['A']
  const before = phasePlanningContext(f.state, f.task)
  f.state.tasks.A.notes = [{ text: 'Progresso' }]
  assert.equal(phasePlanningContext(f.state, f.task), before)
  f.state.tasks.A.title = 'Nova regra aprovada'
  assert.notEqual(phasePlanningContext(f.state, f.task), before)
})
