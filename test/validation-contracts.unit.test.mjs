import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validationContract, assertUnavailableResources, assertDiscovery, assertDiscussionBoundary,
  discoveryDigest, assertTaskPlan, taskPlanDigest, assertValidation,
} from '../scripts/validation.mjs'

const step = () => ({ kind: 'functional', run: 'node comportamento.cjs', expect: 'O comportamento aprovado é preservado' })
const task = () => ({ id: 'T1', validation: [step()], touches: ['src'] })
const plan = () => ({ research: [{ source: 'src', findings: 'Contrato inspecionado' }], decisions: [],
  steps: ['Implementar a regra aprovada'], verification: [{ criterion: 'Resultado observável', check: 1 }], openQuestions: [] })
const discovery = () => ({ research: [{ source: 'contrato', findings: 'Regra confirmada' }],
  questions: [{ question: 'Preservar a regra?', answer: 'Sim', channel: 'native', round: 1 }],
  coverage: Object.fromEntries(['problem', 'affected', 'outcome', 'currentBehavior', 'desiredBehavior', 'rules', 'exceptions', 'scope', 'acceptance'].map(k => [k, 'Contexto confirmado'])),
  decisions: [], deferred: [], executionBoundary: { deferredToExecutor: ['T1'], prematureTaskWork: [] }, closure: 'Regras confirmadas' })
const label = value => JSON.stringify(value) ?? 'undefined'
const empty = [undefined, null, '', ' ', 0, false, [], {}]

for (const field of ['run', 'expect']) for (const value of empty) test(`contrato rejeita ${field}=${label(value)}`, () => {
  const t = task(); t.validation[0][field] = value
  assert.throws(() => validationContract(t), /nonempty run and expect/)
})
const invalidOptions = {
  kind: [null, '', 'inspection', 'lint', 0, false, [], {}],
  cacheable: [null, '', 'true', 0, 1, [], {}],
  expectedExitCodes: [null, [], [-1], [256], [1.5], ['0'], [null], [true], {}, 0],
  env: [null, [], '', 0, false, { 'INVALID-NAME': 'x' }, { '1NAME': 'x' }, { '': 'x' }, { MODE: null }, { MODE: 1 }, { MODE: false }, { MODE: 'a\0b' }],
  shell: [null, '', ' ', 0, false, [], {}],
  timeoutMs: [null, '', '10', -1, 1.5, 2147483648, Infinity, NaN, false, [], {}],
}
for (const [field, values] of Object.entries(invalidOptions)) for (const value of values) test(`opção de execução rejeita ${field}=${label(value)}`, () => {
  const t = task(); t.validation[0][field] = value
  assert.throws(() => validationContract(t), /step kind|cacheable|expectedExitCodes|env must|shell must|timeoutMs/)
})
for (const path of ['../src', 'src/../x', 'src\\..\\x', '/tmp/file', '\\tmp\\file', '//host/share', '\\\\host\\share', 'C:/src', 'C:\\src', 'C:src', 'a\0b', '', ' ']) {
  test(`cache não aceita caminho inseguro ${label(path)}`, () => {
    const t = task(); t.validation.unshift({ kind: 'static', run: 'node lint.cjs', expect: 'Arquivos válidos', cacheable: true, cachePaths: [path] })
    assert.throws(() => validationContract(t), /safe relative paths/)
  })
  test(`plano não escreve fora do escopo por ${label(path)}`, () => {
    const p = plan(); p.writes = [path]
    assert.throws(() => assertTaskPlan(task(), p), /safe relative paths|outside task touches/)
  })
}
for (const path of ['src/a.mjs', 'src', 'src/nested/a.mjs', './src/a.mjs', 'src\\a.mjs']) test(`escrita autorizada aceita ${path}`, () => {
  const p = plan(); p.writes = [path]; assert.doesNotThrow(() => assertTaskPlan(task(), p))
})
for (const path of ['src-other/a.mjs', 'src2/a.mjs', 'docs/a.md', 'a.mjs']) test(`prefixo semelhante não autoriza ${path}`, () => {
  const p = plan(); p.writes = [path]; assert.throws(() => assertTaskPlan(task(), p), /outside task touches/)
})
for (const value of [null, '', {}, ['secret'], ['database', 'secret'], [1]]) test(`recursos indisponíveis rejeitam ${label(value)}`, () => {
  assert.throws(() => assertUnavailableResources({ unavailable: value }), /unavailable/)
})
for (const resource of ['database', 'network', 'credential', 'external-service', 'production-data', 'manual-inspection']) test(`recurso conhecido ${resource} é válido`, () => {
  assert.doesNotThrow(() => assertUnavailableResources({ unavailable: [resource] }))
})
for (const value of [undefined, null, '', ' ', [], {}]) test(`execução funcional rejeita validação ${label(value)}`, () => {
  assert.throws(() => validationContract({ validation: value }), /nonempty array/)
})
for (const kind of ['static', undefined]) test(`checagem ${label(kind)} sozinha não aprova comportamento`, () => {
  assert.throws(() => validationContract({ validation: [{ ...step(), kind }] }), /executable functional check/)
})
for (const value of empty) test(`inspeção exige justificativa ${label(value)}`, () => {
  assert.throws(() => validationContract({ validationMode: 'inspection', inspectionReason: value, validation: 'Inspecionar documentação' }), /inspectionReason/)
})
for (const field of ['summary', 'steps', 'research', 'verification', 'openQuestions', 'decisions']) {
  const values = field === 'summary' ? empty.filter(v => v !== undefined) : [undefined, null, '', false, {}]
  for (const value of values) test(`plano rejeita ${field}=${label(value)}`, () => {
    const p = plan(); p[field] = value; assert.throws(() => assertTaskPlan(task(), p), /task plan/)
  })
}
for (const field of ['source', 'findings']) for (const value of empty) test(`pesquisa do plano exige ${field}=${label(value)}`, () => {
  const p = plan(); p.research[0][field] = value; assert.throws(() => assertTaskPlan(task(), p), /research/)
})
for (const field of ['question', 'answer']) for (const value of empty) test(`decisão do plano exige ${field}=${label(value)}`, () => {
  const p = plan(); p.decisions = [{ question: 'Qual regra?', answer: 'A aprovada', [field]: value }]; assert.throws(() => assertTaskPlan(task(), p), /decisions/)
})
for (const value of [undefined, null, 0, -1, 2, '1', '', 'inspection', false, {}]) test(`verificação exige índice válido ${label(value)}`, () => {
  const p = plan(); p.verification[0].check = value; assert.throws(() => assertTaskPlan(task(), p), /verification/)
})
for (const value of [undefined, null, '', ' ', 0, false, [], {}]) test(`verificação exige critério observável ${label(value)}`, () => {
  const p = plan(); p.verification[0].criterion = value; assert.throws(() => assertTaskPlan(task(), p), /verification/)
})
for (const value of [null, '', 'later', 0, true, [], {}, { beforeTask: '' }, { beforePhase: '' }, { beforeTask: 'T2', beforePhase: 'F2' }, { beforeTask: 'T2', extra: true }]) test(`pergunta rejeita prazo ambíguo ${label(value)}`, () => {
  const p = plan(); p.openQuestions = [{ question: 'Qual opção?', blocking: false, decideBy: value }]; assert.throws(() => assertTaskPlan(task(), p), /openQuestions/)
})
for (const value of empty) test(`pergunta bloqueante exige resposta ${label(value)}`, () => {
  const p = plan(); p.openQuestions = [{ question: 'Qual opção?', blocking: true, answer: value }]; assert.throws(() => assertTaskPlan(task(), p), /openQuestions|blocking questions/)
})
for (const field of Object.keys(discovery().coverage)) for (const value of empty) test(`descoberta exige cobertura ${field}=${label(value)}`, () => {
  const d = discovery(); d.coverage[field] = value; assert.throws(() => assertDiscovery(d), /coverage/)
})
for (const field of ['question', 'answer', 'channel', 'round']) {
  const values = field === 'round' ? [undefined, null, 0, -1, 1.5, '1', false, [], {}] : empty
  for (const value of values) test(`descoberta exige pergunta ${field}=${label(value)}`, () => {
    const d = discovery(); d.questions[0][field] = value; assert.throws(() => assertDiscovery(d), /answered question/)
  })
}
for (const field of ['research', 'questions', 'coverage', 'decisions', 'deferred', 'executionBoundary', 'closure']) for (const value of [undefined, null, '', false, 0]) test(`descoberta rejeita ${field}=${label(value)}`, () => {
  const d = discovery(); d[field] = value; assert.throws(() => assertDiscovery(d), /discovery/)
})
for (const ids of [[], ['T2'], ['T1', 'T2']]) test(`limite da discussão recusa alvos ${label(ids)}`, () => {
  assert.throws(() => assertDiscussionBoundary(discovery(), ids), /every discussion target/)
})
test('trabalho prematuro exige aceite e pertence aos alvos atuais', () => {
  const d = discovery(); d.executionBoundary.prematureTaskWork = [{ task: 'T1', action: 'Entregou implementação' }]
  assert.throws(() => assertDiscussionBoundary(d, ['T1']), /explicit user approval/)
  assert.doesNotThrow(() => assertDiscussionBoundary(d, ['T1'], { acceptPremature: true }))
  d.executionBoundary.prematureTaskWork[0].task = 'T2'
  assert.throws(() => assertDiscussionBoundary(d, ['T1'], { acceptPremature: true }), /current discussion target/)
})
for (const field of ['research', 'decisions', 'steps', 'verification', 'openQuestions', 'writes', 'phaseBinding', 'unresolvedInputs']) test(`identidade do plano detecta alteração em ${field}`, () => {
  const p = plan(), before = taskPlanDigest(p); p[field] = [{ changed: true }]; assert.notEqual(taskPlanDigest(p), before)
})
for (const field of ['summary', 'recordedAt', 'agent', 'digest']) test(`identidade do plano ignora apresentação ${field}`, () => {
  const p = plan(), before = taskPlanDigest(p); p[field] = 'Informação de apresentação'; assert.equal(taskPlanDigest(p), before)
})
test('identidades preservam ordem de listas e ignoram ordem de chaves', () => {
  const p = plan(); assert.equal(taskPlanDigest(p), taskPlanDigest(Object.fromEntries(Object.entries(p).reverse())))
  p.steps = ['A', 'B']; const a = taskPlanDigest(p); p.steps.reverse(); assert.notEqual(taskPlanDigest(p), a)
  const d = discovery(); assert.equal(discoveryDigest(d), discoveryDigest(Object.fromEntries(Object.entries(d).reverse())))
})
const receipt = t => ({ evidence: 'Regra verificada', contract: validationContract(t).key, checks: [{ ...step(), exitCode: 0, signal: null, error: null }] })
for (const field of ['evidence', 'contract', 'checks']) for (const value of [undefined, null, '', false, 0]) test(`recibo rejeita ${field}=${label(value)}`, () => {
  const t = task(), r = receipt(t); r[field] = value; assert.throws(() => assertValidation(t, r), /evidence|receipt|checks/)
})
for (const field of ['run', 'expect', 'kind', 'exitCode', 'signal', 'error']) for (const value of field === 'exitCode' ? [null, 1, -1, '0'] : ['signal', 'error'].includes(field) ? ['alterado', 1] : ['alterado', false, 1]) test(`recibo rejeita checagem adulterada ${field}=${label(value)}`, () => {
  const t = task(), r = receipt(t); r.checks[0][field] = value; assert.throws(() => assertValidation(t, r), /validation check/)
})
for (const field of ['contractRevision', 'scopeRevision']) test(`recibo anterior à mudança de ${field} não aprova`, () => {
  const t = { ...task(), [field]: 2 }, r = { ...receipt(t), [field]: 1 }; assert.throws(() => assertValidation(t, r), /changed|refreshed/)
})
test('pausa posterior preserva verificação concluída se contrato e escopo permanecem atuais', () => {
  const t = { ...task(), stateRevision: 2 }, r = { ...receipt(t), stateRevision: 1 }
  assert.doesNotThrow(() => assertValidation(t, r))
})
for (const checks of [[], [null], [{ ...step(), exitCode: 0 }, { ...step(), exitCode: 0 }]]) test(`recibo incompleto ou excedente ${label(checks)} é recusado com diagnóstico`, () => {
  const t = task(), r = receipt(t); r.checks = checks; assert.throws(() => assertValidation(t, r), /not all|validation check/)
})
for (const code of [0, 1, 2, 127, 255]) test(`recibo respeita código de saída aprovado ${code}`, () => {
  const t = task(); t.validation[0].expectedExitCodes = [code]; const r = receipt(t); r.checks[0].exitCode = code
  assert.doesNotThrow(() => assertValidation(t, r)); r.checks[0].exitCode = (code + 1) % 256; assert.throws(() => assertValidation(t, r), /validation check/)
})
