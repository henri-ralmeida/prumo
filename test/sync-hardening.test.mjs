import test from 'node:test'
import assert from 'node:assert/strict'
import {
  auditSyncPlan,
  citedWaitingTasks,
  contractChanges,
  displayIdentifier,
  formatContractChange,
  formatValidationSummary,
  sanitizeChanges,
  sanitizeDiagnostics,
  sanitizeTaskIds,
  summarizeContractValue,
} from '../scripts/sync-plan-audit.mjs'

test('resumos limitam arrays, objetos, textos e valores que não podem ser serializados', () => {
  const longArray = Array.from({ length: 33 }, (_, index) => `item-${index}`)
  const arraySummary = summarizeContractValue('tags', longArray)
  assert.equal(arraySummary.type, 'array')
  assert.equal(arraySummary.count, 33)
  assert.equal(arraySummary.truncated, true)
  assert.equal(arraySummary.items.length, 32)

  const largeObject = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key-${index}`, index]))
  const objectSummary = summarizeContractValue('metadata', largeObject)
  assert.equal(objectSummary.type, 'object')
  assert.equal(objectSummary.count, 33)
  assert.equal(objectSummary.truncated, true)

  const hostile = { value: 'preservar', toJSON() { throw new Error('não serializar') } }
  const hostileSummary = summarizeContractValue('metadata', hostile)
  assert.equal(hostileSummary.type, 'object')
  assert.equal(hostileSummary.truncated, true)
  const bigintSummary = summarizeContractValue('metadata', { value: 1n })
  assert.equal(bigintSummary.type, 'object')
  assert.equal(bigintSummary.truncated, true)
  const undefinedJson = summarizeContractValue('metadata', { toJSON() { return undefined } })
  assert.equal(typeof undefinedJson.toJSON, 'function')

  const longItemArray = summarizeContractValue('tags', Array.from({ length: 3 }, () =>
    Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`key-${index}`, 'x'.repeat(160)]))))
  assert.equal(longItemArray.type, 'array')
  assert.equal(longItemArray.truncated, true)

  assert.deepEqual(summarizeContractValue('metadata', undefined), null)
  assert.equal(summarizeContractValue('metadata', null), null)
  assert.equal(summarizeContractValue('metadata', false), false)
  assert.equal(summarizeContractValue('metadata', 7), 7)
})

test('sumário de validação preserva prosa, vazio, tipos desconhecidos e etapas sem kind', () => {
  assert.deepEqual(summarizeContractValue('validation', 'Inspecionar documento'), { type: 'prose', length: 21 })
  assert.deepEqual(summarizeContractValue('validation', null), { type: 'empty', count: 0 })
  assert.deepEqual(summarizeContractValue('validation', { mode: 'legacy' }), { type: 'object' })
  assert.deepEqual(summarizeContractValue('validation', [{ run: 'a' }, { kind: 'functional' }]), {
    type: 'steps', count: 2, kinds: { unknown: 1, functional: 1 },
  })
})

test('contractChanges marca todos os índices alterados e limita o diagnóstico', () => {
  const before = { validation: Array.from({ length: 33 }, (_, index) => ({ kind: 'functional', run: `old-${index}`, expect: 'passa' })) }
  const after = { validation: Array.from({ length: 33 }, (_, index) => ({ kind: 'functional', run: `new-${index}`, expect: 'passa' })) }
  const change = contractChanges(before, after).at(0)
  assert.equal(change.changedSteps.count, 33)
  assert.equal(change.changedSteps.indices.length, 32)
  assert.equal(change.changedSteps.truncated, true)
  assert.match(formatContractChange(change), /33 checks \(indices .*…\)/)

  const prose = contractChanges({ validation: 'antes' }, { validation: null }).at(0)
  assert.equal(formatContractChange(prose), 'validation prose (5 chars) -> empty')
  assert.equal(formatContractChange({ field: 'title', before: 'a', after: 'b' }), 'title "a" -> "b"')
  assert.equal(formatContractChange({ field: 'validation', before: { type: 'steps', count: 1, kinds: {} }, after: { type: 'steps', count: 1, kinds: {} }, changedSteps: { count: 0, indices: [] } }),
    'validation 1 checks -> 1 checks')
})

test('citações de espera tratam ids conhecidos, ids descobertos e entradas inválidas', () => {
  assert.deepEqual(citedWaitingTasks(undefined), [])
  assert.deepEqual(citedWaitingTasks('   '), [])
  assert.deepEqual(citedWaitingTasks('waiting for T2-foo and T99', [null, 'T2-foo', 'T25', 't25']), ['T2-foo', 'T99'])
  assert.deepEqual(citedWaitingTasks('aguardando T25; histórico menciona T26. espera T27', ['T25', 'T26']), ['T25', 'T27'])
  assert.deepEqual(citedWaitingTasks('T25 será executada depois', ['T25']), [])
})

test('sanitização reduz identificadores e mantém opcionais controlados', () => {
  const ids = Array.from({ length: 40 }, (_, index) => `T${index}-${'x'.repeat(130 + index)}`)
  const bounded = sanitizeTaskIds(ids)
  assert.equal(bounded.type, 'identifiers')
  assert.equal(bounded.count, 40)
  assert.equal(bounded.items.length, 32)
  assert.equal(bounded.truncated, true)
  const arrayLike = sanitizeTaskIds({ map: () => ids })
  assert.equal(arrayLike.count, 40)
  assert.equal(arrayLike.truncated, true)
  assert.deepEqual(sanitizeChanges([{ task: 42, field: 'title' }]), [{ task: '42', field: 'title' }])

  const diagnostics = sanitizeDiagnostics({
    blockReasonContradictions: [{
      task: ids[0], cited: ids, missingDeps: ids, plannedMissingDeps: ids,
      backEdgesBefore: ids, backEdgesAfter: ids,
    }],
    newLeaves: [{ task: ids[1], dependents: ids }],
    preDiscussionFunctionalContracts: [{ task: ids[2], indices: Array.from({ length: 33 }, (_, index) => index + 1) }],
    invalidatedWorkflows: [
      { scope: 'phase', workflow: 'w'.repeat(200), id: ids[3], task: ids[4], roundId: 'r'.repeat(200), decisionId: 'd'.repeat(200), cause: 'c'.repeat(200) },
      { scope: 'task', workflow: undefined, id: 'T1', cause: undefined },
    ],
  })
  assert.equal(diagnostics.blockReasonContradictions[0].missingDeps.type, 'identifiers')
  assert.equal(diagnostics.newLeaves[0].dependents.type, 'identifiers')
  assert.equal(diagnostics.preDiscussionFunctionalContracts[0].truncated, true)
  assert.deepEqual(diagnostics.invalidatedWorkflows[1], { scope: 'task', workflow: '', id: 'T1', cause: '' })
  assert.equal(diagnostics.invalidatedWorkflows[0].workflow.type, 'string')
  assert.equal(diagnostics.invalidatedWorkflows[0].roundId.type, 'string')
  assert.equal(diagnostics.invalidatedWorkflows[0].decisionId.type, 'string')

  const missingLists = sanitizeDiagnostics({
    blockReasonContradictions: [{ task: 'T1' }],
    newLeaves: [{ task: 'T2' }],
  })
  assert.deepEqual(missingLists.blockReasonContradictions[0].cited, [])
  assert.deepEqual(missingLists.newLeaves[0].dependents, [])

  const empty = sanitizeDiagnostics()
  assert.deepEqual(empty, { blockReasonContradictions: [], newLeaves: [], preDiscussionFunctionalContracts: [], invalidatedWorkflows: [] })
})

test('auditoria cobre validação inválida, folhas duplicadas e ciclo no grafo persistido', () => {
  const stateTasks = {
    T1: { id: 'T1', deps: [], blockReason: 'waiting for T2' },
    T2: { id: 'T2', deps: ['T3'] },
    T3: { id: 'T3', deps: ['T2', 'T1'] },
    T4: { id: 'T4', deps: [] },
    T5: { id: 'T5', deps: 'não é lista', validation: 'prosa' },
  }
  const planTasks = [
    { id: 'T1', deps: [] },
    { id: 'T2' },
    { id: 'T3', deps: [] },
    { id: 'T4', deps: ['T1'] },
    { id: 'T5', validation: [{ kind: 'static', run: 'lint', expect: 'passa' }] },
  ]
  const audit = auditSyncPlan({ stateTasks, planTasks, added: ['T6', 't6', { id: 'T7' }, 'T7', 'T1'] })
  assert.equal(audit.blockReasonContradictions.length, 1)
  assert.deepEqual(audit.blockReasonContradictions[0].backEdgesBefore, ['T2'])
  assert.deepEqual(audit.newLeaves, [
    { task: 'T6', dependents: [], severity: 'info' },
    { task: 'T7', dependents: [], severity: 'info' },
  ])
  assert.deepEqual(audit.preDiscussionFunctionalContracts, [])
})

test('auditoria reconhece crescimento funcional somente antes da discussão', () => {
  const stateTasks = {
    T1: { id: 'T1', phase: 'F1', validation: [{ kind: 'functional', run: 'old', expect: 'passa' }] },
  }
  const planTasks = [{
    id: 'T1', phase: 'F1', validation: [
      { kind: 'functional', run: 'old', expect: 'passa' },
      { kind: 'functional', run: 'new', expect: 'passa' },
    ],
  }]
  assert.deepEqual(auditSyncPlan({ stateTasks, planTasks, effectiveTasks: { T1: { effective: 'discussing' } } }).preDiscussionFunctionalContracts, [{
    task: 'T1', effective: 'discussing', count: 2, added: 1, indices: [2], severity: 'warning',
  }])
  assert.deepEqual(auditSyncPlan({
    stateTasks: { T1: { id: 'T1', phase: 'F1', validation: 'prosa' } },
    planTasks,
    effectiveTasks: { T1: { effective: 'ready_for_discussion' } },
  }).preDiscussionFunctionalContracts, [{
    task: 'T1', effective: 'ready_for_discussion', count: 2, added: 2, indices: [1, 2], severity: 'warning',
  }])

  const alternateChecks = auditSyncPlan({
    stateTasks: { T2: { id: 'T2', phase: 'F1', validation: [{ kind: 'functional', run: '', expect: 'expectativa' }] } },
    planTasks: [{ id: 'T2', phase: 'F1', validation: [
      { kind: 'functional', run: '', expect: 'expectativa' },
      { kind: 'functional', run: 'check', expect: '' },
      { kind: 'functional', run: '', expect: '' },
    ] }],
    effectiveTasks: { T2: { effective: 'ready_for_discussion' } },
  })
  assert.equal(alternateChecks.preDiscussionFunctionalContracts.length, 1)
})

test('auditoria preserva o caminho sem contradição e diferencia avisos fortes de simples', () => {
  const clean = auditSyncPlan({
    stateTasks: { T1: { id: 'T1', deps: ['T2'], blockReason: 'waiting for T2' } },
    planTasks: [{ id: 'T1', deps: ['T2'] }, { id: 'T2', deps: [] }],
  })
  assert.deepEqual(clean.blockReasonContradictions, [])

  const warning = auditSyncPlan({
    stateTasks: { T1: { id: 'T1', deps: [], blockReason: 'waiting for T2' } },
    planTasks: [{ id: 'T1', deps: [] }, { id: 'T2', deps: [] }],
    added: ['T2'],
  })
  assert.equal(warning.blockReasonContradictions[0].severity, 'warning')
  assert.equal(warning.newLeaves[0].severity, 'warning')

  const fallback = auditSyncPlan({
    stateTasks: { T9: { id: 'T9', deps: [], blockReason: 'waiting for T2' } },
    planTasks: [{ id: 'T2', deps: [] }],
  })
  assert.equal(fallback.blockReasonContradictions[0].plannedMissingDeps[0], 'T2')
})

test('auditoria aceita entradas ausentes e normaliza dependências não listadas', () => {
  const result = auditSyncPlan({
    stateTasks: { T1: null },
    planTasks: [{ id: 'T2', deps: 'não é lista' }],
  })
  assert.deepEqual(result, { blockReasonContradictions: [], newLeaves: [], preDiscussionFunctionalContracts: [] })
  assert.deepEqual(auditSyncPlan().newLeaves, [])
  assert.deepEqual(auditSyncPlan({ stateTasks: null, planTasks: [] }).newLeaves, [])
  const unknownAdded = auditSyncPlan({ added: [{}] })
  assert.equal(unknownAdded.newLeaves[0].task, undefined)
})

test('auditoria recusa lista nula e mantém busca finita em ciclos sem atingir a tarefa bloqueada', () => {
  assert.throws(() => auditSyncPlan({ planTasks: null }), TypeError)
  const result = auditSyncPlan({
    stateTasks: {
      T1: { deps: [], blockReason: 'waiting for T2' },
      T2: { deps: ['T3'] },
      T3: { deps: ['T2'] },
    },
    planTasks: [{ id: 'T1', deps: [] }, { id: 'T2', deps: ['T3'] }, { id: 'T3', deps: ['T2'] }],
  })
  assert.deepEqual(result.blockReasonContradictions[0].backEdgesBefore, [])
  assert.deepEqual(result.blockReasonContradictions[0].backEdgesAfter, [])
  assert.equal(result.blockReasonContradictions[0].severity, 'warning')
})

test('formatValidationSummary cobre formatos suportados e desconhecidos', () => {
  assert.equal(formatValidationSummary(null), 'null')
  assert.equal(formatValidationSummary('prosa'), 'prosa')
  assert.equal(formatValidationSummary({ type: 'steps', count: 2, kinds: {} }), '2 checks')
  assert.equal(formatValidationSummary({ type: 'steps', count: 2 }), '2 checks')
  assert.equal(formatValidationSummary({ type: 'steps', count: 2, kinds: { static: 1, functional: 1 } }), '2 checks (static:1,functional:1)')
  assert.equal(formatValidationSummary({ type: 'prose', length: 5 }), 'prose (5 chars)')
  assert.equal(formatValidationSummary({ type: 'empty' }), 'empty')
  assert.equal(formatValidationSummary({ type: 'custom' }), 'custom')
  assert.equal(formatValidationSummary({}), 'unknown')
})

test('displayIdentifier preserva valores não textuais e limita ids longos', () => {
  assert.equal(displayIdentifier(null), 'null')
  assert.equal(displayIdentifier(7), '7')
  assert.equal(displayIdentifier('T1'), 'T1')
  assert.equal(displayIdentifier('x'.repeat(129)), '<task id length 129>')
})

test('resumos compactos preservam conteúdo e distinguem alteração de título de validação', () => {
  assert.deepEqual(summarizeContractValue('tags', ['A', 'B']), ['A', 'B'])
  assert.deepEqual(contractChanges({ title: 'Antes' }, { title: 'Depois' }), [
    { field: 'title', before: 'Antes', after: 'Depois' },
  ])
  assert.equal(formatContractChange({
    field: 'validation', before: { type: 'steps', count: 2 }, after: { type: 'steps', count: 2 },
    changedSteps: { count: 1, indices: [2], truncated: false },
  }), 'validation content changed in 1 check (indices 2)')
  assert.equal(formatContractChange({
    field: 'validation', before: { type: 'steps', count: 2 }, after: { type: 'steps', count: 2 },
    changedSteps: { count: 33, indices: [1, 2], truncated: true },
  }), 'validation content changed in 33 checks (indices 1,2,…)')
  const result = auditSyncPlan({
    stateTasks: {
      T1: { phase: 'P1', validation: [{ kind: 'functional', run: 'check' }], blockReason: 'sem espera por tarefa' },
    },
    planTasks: [{ id: 'T1', phase: 'P1', validation: [] }],
    effectiveTasks: { T1: { effective: 'discussing' } },
  })
  assert.deepEqual(result.preDiscussionFunctionalContracts, [])
  assert.deepEqual(result.blockReasonContradictions, [])
})
