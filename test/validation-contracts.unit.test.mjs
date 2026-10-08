import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validationContract, assertValidationEnvironment, assertUnavailableResources, assertDiscovery, assertDiscussionBoundary,
  discoveryDigest, assertTaskPlan, taskPlanDigest, assertValidation, planningContext, hasCurrentTaskPlan, hasCurrentTaskScope,
} from '../scripts/validation.mjs'

const step = () => ({ kind: 'functional', run: 'node comportamento.cjs', expect: 'O comportamento aprovado é preservado' })

test('requiresEnv aceita nomes portáveis e integra a identidade do contrato sem exigir valores no plano', () => {
  const base = { validation: [step()] }
  const required = { validation: [{ ...step(), requiresEnv: ['PRUMO_ENV', '_PORTABLE_2'] }] }
  assert.notEqual(validationContract(base).key, validationContract(required).key)
  assert.doesNotThrow(() => validationContract({ validation: [{ ...step(), requiresEnv: [] }] }))
  for (const requiresEnv of [null, '', {}, [''], ['with space'], ['1INVALID'], [null], [1], ['VAR\0']])
    assert.throws(() => validationContract({ validation: [{ ...step(), requiresEnv }] }), /requiresEnv/)
})

test('requiresEnv considera vazio ausente e step.env prevalece sem expor valores', () => {
  for (const platform of ['linux', 'win32']) {
    const value = { validation: [{ ...step(), requiresEnv: ['PRUMO_ENV', 'SECOND_ENV'] }] }
    for (const env of [{}, { undefined: 'configured' }, { PRUMO_ENV: '' }, { PRUMO_ENV: '  ' }, { PRUMO_ENV: null }])
      assert.throws(() => assertValidationEnvironment(value, env, platform), /PRUMO_ENV, SECOND_ENV/)
    value.validation[0].env = { PRUMO_ENV: '  ', SECOND_ENV: 'configured' }
    assert.throws(() => assertValidationEnvironment(value, { PRUMO_ENV: 'synthetic-inherited' }, platform), error => {
      assert.doesNotMatch(error.message, /synthetic-inherited|configured|SECOND_ENV/)
      return /PRUMO_ENV/.test(error.message)
    })
    value.validation[0].env.PRUMO_ENV = 'configured'
    assert.equal(assertValidationEnvironment(value, {}, platform)[0].PRUMO_ENV, 'configured')
  }
  const value = { validation: [{ ...step(), requiresEnv: ['PRUMO_ENV'], env: { prumo_env: 'override' } }] }
  const env = assertValidationEnvironment(value, { PRUMO_ENV: 'inherited', OTHER: 'retained' }, 'win32')[0]
  assert.equal(env.prumo_env, 'override')
  assert.equal(env.PRUMO_ENV, undefined)
  assert.equal(env.OTHER, 'retained')
  assert.throws(() => assertValidationEnvironment(value, {}, 'linux'), /PRUMO_ENV/)
  const special = { validation: [{ ...step(), requiresEnv: ['__proto__'],
    env: Object.fromEntries([['__proto__', 'configured']]) }] }
  assert.equal(assertValidationEnvironment(special, {}, 'win32')[0].__proto__, 'configured')
  assert.doesNotThrow(() => assertValidationEnvironment({ validationMode: 'inspection',
    inspectionReason: 'O artefato requer somente inspeção.', validation: 'Inspecionar o resultado.' }, {}))
})
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

test('prazo para a própria tarefa exige resposta na validação inicial e identifica a pergunta', () => {
  const p = plan()
  p.openQuestions = [{ question: 'Regra a decidir na execução?', blocking: false, decideBy: 'executor' },
    { question: 'Decidir antes desta tarefa?', blocking: false, decideBy: { beforeTask: 'T1' } }]
  assert.throws(() => assertTaskPlan(task(), p), /(?:task T1 plan open question 2 targets its own task|pergunta aberta 2 do plano da tarefa T1 aponta para a própria tarefa).*beforeTask.*Decidir antes desta tarefa\?/)
  assert.doesNotThrow(() => assertTaskPlan(task(), p, { checkSelfDeadline: false }), 'Consultar um contrato já registrado não impõe retroativamente a nova regra de entrada.')
  p.openQuestions[1].answer = 'Regra confirmada.'
  assert.doesNotThrow(() => assertTaskPlan(task(), p))
  delete p.openQuestions[1].answer
  p.openQuestions[1].decideBy = { beforeTask: 'T2' }
  assert.doesNotThrow(() => assertTaskPlan(task(), p), 'A pergunta futura para outra tarefa permanece permitida.')
})

test('consulta histórica preserva o escopo registrado e continua recusando contratos inválidos', () => {
  const t = { ...task(), planningRequired: true, discoveryRequired: false, attempts: [], deps: [], state: 'pending' }
  const state = { plan: { name: 'Contratos', planningMode: 'task' }, tasks: { T1: t } }
  t.taskPlan = { ...plan(), planner: 'planejador', completedAt: '2026-10-08T00:00:00Z', attempt: 1,
    scope: planningContext(state, t, { scopeOnly: true, attempt: 1 }),
    openQuestions: [{ question: 'Decisão histórica?', blocking: false, decideBy: { beforeTask: 'T1' } }] }
  assert.equal(hasCurrentTaskScope(state, t, 1), true)
  assert.equal(hasCurrentTaskPlan(state, t), true)
  t.taskPlan.steps = []
  assert.equal(hasCurrentTaskScope(state, t, 1), false)
  assert.equal(hasCurrentTaskPlan(state, t), false)
})

test('diagnóstico de pergunta mantém um trecho limitado e sem quebras de linha', () => {
  const p = plan()
  p.openQuestions = [{ question: 'Qual\n regra? ' + 'x'.repeat(180), blocking: false, decideBy: { beforeTask: 'T1' } }]
  assert.throws(() => assertTaskPlan(task(), p), error => {
    assert.ok(error.message.endsWith(('Qual regra? ' + 'x'.repeat(180)).slice(0, 120)))
    assert.ok(!error.message.includes('\n'))
    return true
  })
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
