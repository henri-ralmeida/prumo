import test from 'node:test'
import assert from 'node:assert/strict'
import { contractDrift, preservedContractDrift, preservesCompletedContract } from '../scripts/contract-drift.mjs'

function fixture(state) {
  const task = { id: 'T1', title: 'Entrega aprovada', phase: null, deps: [], tags: [], validation: '', touches: [] }
  return { source: { name: 'Plano aprovado', tasks: [structuredClone(task)] },
    persisted: { plan: { name: 'Plano aprovado' }, tasks: { T1: { ...task, state } } } }
}

test('somente contratos encerrados preservam diferenças, sem alterar fonte ou estado', () => {
  for (const status of ['done', 'skipped', 'pending', 'failed', 'blocked', 'running', 'reviewing', undefined]) {
    const { source, persisted } = fixture(status)
    source.tasks[0].validationMode = 'inspection'
    source.tasks[0].inspectionReason = 'Normalização posterior ao encerramento'
    const before = JSON.stringify({ source, persisted })
    const full = contractDrift(persisted, { plan: source })
    assert.deepEqual(full.tasks, [{ task: 'T1', fields: ['validationMode', 'inspectionReason'] }])
    const terminal = ['done', 'skipped'].includes(status)
    assert.equal(preservesCompletedContract(persisted.tasks.T1), terminal)
    assert.equal(preservedContractDrift(persisted, full.tasks[0]), terminal)
    assert.deepEqual(contractDrift(persisted, { plan: source, preserveCompleted: true }).tasks, terminal ? [] : full.tasks)
    assert.equal(JSON.stringify({ source, persisted }), before)
  }
  assert.equal(preservesCompletedContract(), false)
})

test('preservação não oculta tarefa ausente ou nova nem decisão global diferente', () => {
  const { source, persisted } = fixture('done')
  source.name = 'Outro plano aprovado'
  source.tasks = [{ ...source.tasks[0], id: 'T2' }]
  const drift = contractDrift(persisted, { plan: source, preserveCompleted: true })
  assert.deepEqual(drift.planFields, ['name'])
  assert.deepEqual(drift.tasks, [
    { task: 'T2', fields: ['notSynchronized'] },
    { task: 'T1', fields: ['missingFromApprovedPlan'] },
  ])
  for (const change of drift.tasks) assert.equal(preservedContractDrift(persisted, change), false)
  assert.equal(preservedContractDrift(persisted, { task: 'T1', fields: ['notSynchronized'] }), false)
  assert.equal(preservedContractDrift({}, { task: 'T1', fields: ['title'] }), false)
})

test('contrato concluído sem diferenças continua sem divergência acionável', () => {
  const { source, persisted } = fixture('skipped')
  assert.deepEqual(contractDrift(persisted, { plan: source, preserveCompleted: true }), { available: true, planFields: [], tasks: [] })
})

test('mudança de projeto de uma tarefa pendente exige sincronização', () => {
  const { source, persisted } = fixture('pending')
  source.tasks[0].project = 'outro-projeto'
  assert.deepEqual(contractDrift(persisted, { plan: source, preserveCompleted: true }).tasks,
    [{ task: 'T1', fields: ['project'] }])
})
