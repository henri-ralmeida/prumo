import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertDiscussionBoundary,
  assertDiscovery,
  assertPhaseTaskPlan,
  assertTaskPlan,
  assertUnavailableResources,
  assertValidation,
  currentPlanningScope,
  discoveryDigest,
  executionInputReceipt,
  hasCurrentTaskPlan,
  hasCurrentTaskScope,
  phaseRequiredInputs,
  phasePlanningContext,
  planningContext,
  taskPlanDigest,
  usesCurrentPlanning,
  runValidation,
  validationContract,
  validationDirectories,
} from '../scripts/validation.mjs'

const step = (overrides = {}) => ({
  kind: 'functional',
  run: 'node check.cjs',
  expect: 'o comportamento aprovado passa',
  ...overrides,
})

const task = (validation = [step()]) => ({
  validation,
  attempts: [{}],
  validations: [{ by: 'review', agent: 'revisor' }],
  contractRevision: 0,
  scopeRevision: 0,
  stateRevision: 0,
})

function discovery() {
  return {
    research: [{ source: 'contrato', findings: 'Regra observada' }],
    questions: [{ question: 'Preservar a regra?', answer: 'Sim', channel: 'native', round: 1 }],
    coverage: Object.fromEntries([
      'problem', 'affected', 'outcome', 'currentBehavior', 'desiredBehavior',
      'rules', 'exceptions', 'scope', 'acceptance',
    ].map(field => [field, 'Contexto confirmado'])),
    decisions: [],
    deferred: [],
    executionBoundary: { deferredToExecutor: ['T1'], prematureTaskWork: [] },
    closure: 'Nenhuma dúvida consequencial permanece',
  }
}

function plan() {
  return {
    research: [{ source: 'contrato', findings: 'Regra observada' }],
    decisions: [],
    steps: ['Executar a regra aprovada'],
    verification: [{ criterion: 'O comportamento aprovado passa', check: 1 }],
    openQuestions: [],
  }
}

function temporary(t, label = 'prumo-validation-hardening-') {
  const root = mkdtempSync(join(tmpdir(), label))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function git(root, ...args) {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
}

function gitRepository(t) {
  const root = temporary(t, 'prumo-validation-git-')
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'hardening@example.invalid')
  git(root, 'config', 'user.name', 'Prumo Hardening')
  return root
}

test('validação exige cwd absoluto, existente e sem caminho Windows consumido pelo shell', t => {
  const root = temporary(t)
  const value = task()

  assert.throws(() => validationDirectories(value, 'projeto-relativo'), /absolute --cwd/)
  assert.throws(() => validationDirectories(value, 'C:projeto'), /Windows path/)
  assert.throws(() => validationDirectories(value, join(root, 'ausente')), /ENOENT|not a directory/)

  mkdirSync(join(root, 'projeto'))
  assert.deepEqual(validationDirectories(value, join(root, 'projeto')), [join(root, 'projeto')])
})

test('recibo aceita código de saída explicitamente aprovado e preserva stdout e stderr', async t => {
  const root = temporary(t)
  writeFileSync(join(root, 'check.cjs'), "console.log('saida observavel'); console.error('diagnostico'); process.exit(7)\n")
  const value = task([step({ expectedExitCodes: [7] })])

  const receipt = {
    ...await runValidation(value, root),
    by: 'review',
    agent: 'revisor',
    attempt: 1,
    evidence: 'A execução observável passou',
  }

  assert.equal(receipt.checks.length, 1)
  assert.equal(receipt.checks[0].exitCode, 7)
  assert.equal(receipt.checks[0].error, null)
  assert.equal(receipt.checks[0].signal, null)
  assert.match(receipt.checks[0].stdout, /saida observavel/)
  assert.match(receipt.checks[0].stderr, /diagnostico/)
  assert.doesNotThrow(() => assertValidation(value, receipt))

  const revisionsOmitted = structuredClone(receipt)
  delete revisionsOmitted.contractRevision
  delete revisionsOmitted.scopeRevision
  delete revisionsOmitted.stateRevision
  assert.doesNotThrow(() => assertValidation(value, revisionsOmitted))

  const incomplete = structuredClone(receipt)
  incomplete.checks = []
  assert.throws(() => assertValidation(value, incomplete), /not all validation commands completed/)

  const failed = structuredClone(receipt)
  failed.checks = [{ run: step().run, kind: 'functional', expect: step().expect, exitCode: 3, error: null, signal: null }]
  assert.throws(() => assertValidation(value, failed), /exit 3/)

  const notRun = structuredClone(failed)
  notRun.checks[0].exitCode = undefined
  assert.throws(() => assertValidation(value, notRun), /exit not run/)

  const defaultKindTask = task([step({ kind: undefined })])
  defaultKindTask.validationMode = 'inspection'
  defaultKindTask.inspectionReason = 'A inspeção cobre a evidência.'
  const defaultKindReceipt = {
    ...receipt,
    contract: validationContract(defaultKindTask).key,
    checks: [{ run: step().run, kind: 'static', expect: step().expect, exitCode: undefined, error: null, signal: null }],
  }
  assert.throws(() => assertValidation(defaultKindTask, defaultKindReceipt), /exit not run/)

  const twoStepTask = task([step(), step({ run: 'node second.cjs' })])
  const partialReceipt = {
    ...receipt,
    contract: validationContract(twoStepTask).key,
    checks: [{ run: step().run, kind: 'functional', expect: step().expect, exitCode: 3, error: null, signal: null }],
  }
  assert.throws(() => assertValidation(twoStepTask, partialReceipt), /exit 3/)
})

test('falha ao iniciar o shell fica no recibo e não pode aprovar a validação', async t => {
  const root = temporary(t)
  const value = task([step({ shell: join(root, 'shell-inexistente.exe') })])
  const receipt = {
    ...await runValidation(value, root),
    by: 'review',
    agent: 'revisor',
    attempt: 1,
    evidence: 'A tentativa de validação foi registrada',
  }

  assert.equal(receipt.checks.length, 1)
  assert.ok(receipt.checks[0].error || receipt.checks[0].exitCode !== 0)
  assert.throws(() => assertValidation(value, receipt), /validation check 1\/1/)
})

test('checagem cacheável fora de um repositório continua executando e nunca reutiliza por engano', async t => {
  const root = temporary(t)
  const counter = join(root, 'contador')
  writeFileSync(join(root, 'check.cjs'), "const fs=require('node:fs');fs.appendFileSync('contador','x');\n")
  const value = task([step({ kind: 'static', cacheable: true, cachePaths: ['check.cjs'] })])
  value.validationMode = 'inspection'
  value.inspectionReason = 'A inspeção estática é suficiente para este artefato.'

  const first = {
    ...await runValidation(value, root),
    by: 'review',
    agent: 'revisor',
    attempt: 1,
    evidence: 'Primeira inspeção',
  }
  const second = {
    ...await runValidation(value, root, first),
    by: 'review',
    agent: 'revisor',
    attempt: 1,
    evidence: 'Segunda inspeção',
  }

  assert.equal(first.checks[0].workspaceRevision, null)
  assert.equal(second.checks[0].workspaceRevision, null)
  assert.equal(second.checks[0].reusedAt, undefined)
  assert.equal(readFileSync(counter, 'utf8'), 'xx')
})

test('cache de inspeção usa revisão Git, reaproveita recibo e aceita ambiente explícito', async t => {
  const root = gitRepository(t)
  writeFileSync(join(root, 'check.cjs'), "if (process.env.PRUMO_HARDENING !== 'ok') process.exit(2)\n")
  writeFileSync(join(root, 'extra.txt'), 'não rastreado')
  git(root, 'add', 'check.cjs')
  git(root, 'commit', '-qm', 'base')

  const value = task([step({
    kind: undefined,
    cacheable: true,
    cachePaths: ['check.cjs'],
    env: { PRUMO_HARDENING: 'ok', path: process.env.PATH ?? '' },
    timeoutMs: 0,
  })])
  value.validationMode = 'inspection'
  value.inspectionReason = 'A inspeção estática confirma o artefato.'
  const first = {
    ...await runValidation(value, root),
    by: 'review', agent: 'revisor', attempt: 1, evidence: 'Primeira inspeção',
  }
  assert.ok(first.checks[0].workspaceRevision)

  const previous = structuredClone(first)
  delete previous.contractRevision
  delete previous.scopeRevision
  delete previous.stateRevision
  const events = []
  const second = {
    ...await runValidation(value, root, previous, event => events.push(event)),
    by: 'review', agent: 'revisor', attempt: 1, evidence: 'Reuso confirmado',
  }
  assert.equal(second.checks[0].reusedAt !== undefined, true)
  assert.equal(events.at(-1).status, 'reused')

  const wholeWorkspace = task([step({
    kind: undefined,
    cacheable: true,
    env: { PRUMO_HARDENING: 'ok', path: process.env.PATH ?? '' },
    timeoutMs: 0,
  })])
  wholeWorkspace.validationMode = 'inspection'
  wholeWorkspace.inspectionReason = 'A inspeção considera todo o repositório.'
  const wholeReceipt = await runValidation(wholeWorkspace, root)
  assert.ok(wholeReceipt.checks[0].workspaceRevision)
})

test('cache de inspeção não aprova revisão Git sem HEAD', async t => {
  const root = gitRepository(t)
  writeFileSync(join(root, 'check.cjs'), 'process.exit(0)\n')
  const value = task([step({ kind: undefined, cacheable: true, timeoutMs: 0 })])
  value.validationMode = 'inspection'
  value.inspectionReason = 'A inspeção deve executar quando o repositório ainda não tem commit.'
  const receipt = await runValidation(value, root)
  assert.equal(receipt.checks[0].workspaceRevision, null)
  assert.equal(receipt.checks[0].exitCode, 0)
})

test('validação usa o shell padrão quando ComSpec não está disponível', async t => {
  const root = temporary(t)
  writeFileSync(join(root, 'check.cjs'), 'process.exit(0)\n')
  const value = task([step({ kind: undefined, timeoutMs: 0 })])
  value.validationMode = 'inspection'
  value.inspectionReason = 'A inspeção cobre a execução sem alteração.'
  const comSpecKeys = Object.keys(process.env).filter(key => key.toLowerCase() === 'comspec')
  const originals = comSpecKeys.map(key => [key, process.env[key]])
  try {
    for (const [key] of originals) delete process.env[key]
    const receipt = await runValidation(value, root)
    assert.equal(receipt.checks[0].exitCode, 0)
  } finally {
    for (const [key, original] of originals) process.env[key] = original
  }
})

test('revisão Git registra arquivo removido e recusa diretório no hash', async t => {
  const root = gitRepository(t)
  writeFileSync(join(root, 'check.cjs'), 'process.exit(0)\n')
  writeFileSync(join(root, 'gone.cjs'), 'process.exit(0)\n')
  writeFileSync(join(root, 'broken.cjs'), 'process.exit(0)\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'base')

  rmSync(join(root, 'gone.cjs'))
  const missing = task([step({ kind: 'static', cacheable: true, cachePaths: ['gone.cjs'] })])
  missing.validationMode = 'inspection'
  missing.inspectionReason = 'A inspeção verifica o arquivo rastreado.'
  const missingReceipt = await runValidation(missing, root)
  assert.ok(missingReceipt.checks[0].workspaceRevision)

  rmSync(join(root, 'broken.cjs'))
  mkdirSync(join(root, 'broken.cjs'))
  const directory = task([step({ kind: 'static', cacheable: true, cachePaths: ['broken.cjs'] })])
  directory.validationMode = 'inspection'
  directory.inspectionReason = 'A inspeção registra falha de hash.'
  const directoryReceipt = await runValidation(directory, root)
  assert.equal(directoryReceipt.checks[0].workspaceRevision, null)
})

test('limite de saída encerra a verificação e registra ENOBUFS', async t => {
  const root = temporary(t)
  writeFileSync(join(root, 'emit.cjs'), "process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1))\n")
  const value = task([step({ run: 'node emit.cjs', timeoutMs: 0 })])
  const receipt = await runValidation(value, root)
  assert.match(receipt.checks[0].error ?? '', /ENOBUFS/)
})

test('limite de saída permanece idempotente quando chegam vários blocos', async t => {
  const root = temporary(t)
  writeFileSync(join(root, 'emit.cjs'), "process.stdout.write('x'.repeat(3 * 1024 * 1024)); setImmediate(() => process.stdout.write('x'.repeat(3 * 1024 * 1024)))\n")
  const value = task([step({ run: 'node emit.cjs', timeoutMs: 0 })])
  const receipt = await runValidation(value, root)
  assert.match(receipt.checks[0].error ?? '', /ENOBUFS/)
})

test('descoberta aceita confirmações com digest completo e recusa identificação ou digest inválidos', () => {
  const valid = discovery()
  valid.questions[0].confirmsContract = [{ task: 'T1', digest: 'a'.repeat(64) }]
  assert.doesNotThrow(() => assertDiscovery(valid))

  for (const confirmsContract of [
    [{ task: '', digest: 'a'.repeat(64) }],
    [{ task: 'T1', digest: 'curto' }],
    [{ task: 'T1', digest: 'g'.repeat(64) }],
    'T1',
  ]) {
    const invalid = discovery()
    invalid.questions[0].confirmsContract = confirmsContract
    assert.throws(() => assertDiscovery(invalid), /confirmsContract/)
  }
})

test('plano exige recursos indisponíveis válidos em cada critério de verificação', () => {
  const delivery = { id: 'T1', touches: ['src'], validation: [step()] }
  const approved = plan()
  approved.verification[0].requires = ['manual-inspection', 'network']
  assert.doesNotThrow(() => assertTaskPlan(delivery, approved))

  for (const requires of ['network', ['segredo'], ['network', 'desconhecido']]) {
    const invalid = structuredClone(approved)
    invalid.verification[0].requires = requires
    assert.throws(() => assertTaskPlan(delivery, invalid), /verification requires/)
  }
})

test('plano valida caminhos escritos dentro do escopo da tarefa', () => {
  const delivery = { id: 'T1', touches: ['src/'], validation: [step()] }
  const approved = plan()
  approved.writes = ['src', 'src/arquivo.txt']
  assert.doesNotThrow(() => assertTaskPlan(delivery, approved))

  const outside = structuredClone(approved)
  outside.writes = ['docs/arquivo.txt']
  assert.throws(() => assertTaskPlan(delivery, outside), /outside task touches/)

  const nulPath = structuredClone(approved)
  nulPath.writes = ['src/arquivo\u0000.txt']
  assert.throws(() => assertTaskPlan(delivery, nulPath), /writes must be an array/)
})

test('contrato funcional não permite que uma checagem estática seja a única evidência', () => {
  assert.throws(() => validationContract({ validation: [step({ kind: 'static' })] }), /executable functional check/)
})

test('contrato cobre ambiente, timeout sem prazo e validação de caminho Windows', () => {
  assert.doesNotThrow(() => validationContract({
    validation: [step({ kind: undefined, cacheable: true, env: { PRUMO_HARDENING: 'ok' }, timeoutMs: 0 })],
    validationMode: 'inspection',
    inspectionReason: 'A inspeção documenta o comportamento sem execução funcional.',
  }))
  assert.throws(() => validationContract({ validation: [step({ env: null })] }), /env must map/)
  assert.throws(() => validationContract({ validation: [step({ env: { '1INVALID': 'x' } })] }), /env must map/)
  if (process.platform === 'win32')
    assert.throws(() => validationContract({ validation: [step({ run: 'NAME=value node check.cjs' })] }), /environment assignment/)
})

test('planejamento legado sem tentativa permanece fora do fluxo atual', () => {
  const state = { plan: { planningMode: 'other' } }
  assert.equal(usesCurrentPlanning(state, { planningRequired: undefined, attempts: [] }), true)
  assert.equal(usesCurrentPlanning({ plan: { planningMode: 'task' } }, { attempts: [] }), false)
  assert.equal(usesCurrentPlanning(state, { planningRequired: true, attempts: [] }), true)
  assert.equal(usesCurrentPlanning(state, { planningRequired: false, attempts: [] }), false)
})

test('digest de plano ignora entradas que não são objetos de conteúdo', () => {
  assert.equal(taskPlanDigest(null), taskPlanDigest([]))
  assert.notEqual(taskPlanDigest({ steps: ['um'] }), taskPlanDigest({ steps: ['dois'] }))
})

function phasePlanningFixture() {
  const value = task()
  value.id = 'T1'
  value.title = 'Entrega faseada'
  value.deps = []
  value.phase = 'P1'
  value.planningRequired = true
  value.taskPlan = {
    ...plan(),
    planner: 'planejador',
    completedAt: '2026-01-01T00:00:00Z',
    attempt: 1,
    phaseId: 'P1',
    phaseBinding: { discussionRoundId: 'D1' },
  }
  const context = discovery()
  context.roundId = 'D1'
  context.digest = discoveryDigest(context)
  const state = {
    plan: { name: 'Plano', description: 'Contrato', requireReview: false, planningMode: 'phase' },
    tasks: { T1: value },
    phaseWorkflows: {
      P1: {
        discovery: context,
        discussionAttempts: [{ roundId: 'D1', targets: undefined }],
        planningAttempts: [],
      },
    },
  }
  value.taskPlan.phaseDiscoveryDigest = context.digest
  value.taskPlan.scope = phasePlanningContext(state, value)
  return { state, task: value }
}

test('planejamento de fase resolve descoberta herdada e ausência de alvos atuais', () => {
  const { state, task: value } = phasePlanningFixture()
  assert.equal(hasCurrentTaskPlan(state, value), true)
  assert.equal(hasCurrentTaskScope(state, value), true)

  const adoption = structuredClone(state)
  adoption.legacyPhaseAdoption = true
  adoption.phaseWorkflows.P1.adoptedLegacy = false
  assert.equal(hasCurrentTaskScope(adoption, value), false)

  const staleDiscovery = structuredClone(state)
  staleDiscovery.phaseWorkflows.P1.discovery.roundId = 'D2'
  assert.equal(hasCurrentTaskPlan(staleDiscovery, value), false)
  assert.equal(hasCurrentTaskScope(staleDiscovery, value), false)

  const incomplete = structuredClone(value)
  delete incomplete.taskPlan.planner
  assert.equal(hasCurrentTaskScope(state, incomplete), false)

  const missingDiscovery = structuredClone(value)
  delete missingDiscovery.taskPlan.phaseId
  missingDiscovery.discoveryRequired = true
  missingDiscovery.taskPlan.discoveryDigest = 'digest-incorreto'
  assert.equal(hasCurrentTaskScope(state, missingDiscovery), false)
})

test('contratos distinguem inspeção e rejeitam recursos, cache, códigos e prazos inválidos', () => {
  assert.doesNotThrow(() => assertUnavailableResources({ unavailable: ['network', 'manual-inspection'] }))
  assert.doesNotThrow(() => validationContract({
    validationMode: 'inspection',
    inspectionReason: 'A inspeção é a evidência adequada para este artefato.',
    validation: 'prosa registrada pelo revisor',
  }))
  assert.throws(() => assertUnavailableResources({ unavailable: ['segredo'] }), /unavailable/)
  assert.throws(() => validationContract({
    validationMode: 'inspection', inspectionReason: 'Motivo', validation: [],
  }), /inspection validation must not be empty/)
  assert.throws(() => validationContract({ validation: [step({ cacheable: 'sim' })] }), /cacheable/)
  assert.throws(() => validationContract({ validation: [step({ cachePaths: ['check.cjs'] })] }), /cachePaths requires/)
  assert.throws(() => validationContract({
    validation: [step({ kind: undefined, cacheable: true, cachePaths: [] })],
    validationMode: 'inspection', inspectionReason: 'Motivo',
  }), /cachePaths must be a nonempty array/)
  assert.throws(() => validationContract({ validation: [step({ expectedExitCodes: [] })] }), /expectedExitCodes/)
  assert.throws(() => validationContract({ validation: [step({ expectedExitCodes: [256] })] }), /expectedExitCodes/)
  assert.throws(() => validationContract({ validation: [step({ shell: '   ' })] }), /shell/)
  assert.throws(() => validationContract({ validation: [step({ timeoutMs: -1 })] }), /timeoutMs/)
  assert.throws(() => validationContract({ validation: [step({ timeoutMs: 2147483648 })] }), /timeoutMs/)
})

test('descoberta exige fronteira de discussão e só libera trabalho prematuro com aceite', () => {
  const context = discovery()
  context.decisions = [{ question: 'Qual regra se aplica?', answer: 'A regra confirmada', resolvesQuestion: 'Q1' }]
  assert.doesNotThrow(() => assertDiscovery(context))
  assert.doesNotThrow(() => assertDiscussionBoundary(context, ['T1']))

  context.executionBoundary.prematureTaskWork = [{ task: 'T1', action: 'alteração feita antes da execução' }]
  assert.throws(() => assertDiscussionBoundary(context, ['T1']), /explicit user approval/)
  assert.doesNotThrow(() => assertDiscussionBoundary(context, ['T1'], { acceptPremature: true }))

  const wrongTargets = structuredClone(context)
  wrongTargets.executionBoundary.deferredToExecutor = ['T2']
  assert.throws(() => assertDiscussionBoundary(wrongTargets, ['T1']), /defer every discussion target.*expected targets: \[T1\]; received targets: \[T2\]/)
})

test('recusa da descoberta mostra alvos faltantes, extras e antigos sem modificar a entrada', () => {
  for (const received of [[], ['T12e', 'T12f'], ['T13e'], ['T13e', 'T13f', 'T99']]) {
    const context = discovery()
    context.executionBoundary.deferredToExecutor = received
    const before = JSON.stringify(context)
    assert.throws(() => assertDiscussionBoundary(context, ['T13f', 'T13e']), error => {
      assert.ok(error.message.endsWith(`expected targets: [T13e, T13f]; received targets: [${[...received].sort().join(', ')}]`))
      return true
    })
    assert.equal(JSON.stringify(context), before)
  }
  const context = discovery()
  context.executionBoundary.deferredToExecutor = ['T13f', 'T13e', 'T13f']
  assert.doesNotThrow(() => assertDiscussionBoundary(context, ['T13e', 'T13f']))
})

test('planos de inspeção preservam perguntas, decisões e validação de conteúdo', () => {
  const inspectionTask = {
    id: 'T1',
    title: 'Inspeção',
    validationMode: 'inspection',
    inspectionReason: 'O revisor confirma o conteúdo sem executar o artefato.',
    validation: 'evidência textual',
    touches: ['docs'],
  }
  const approved = {
    ...plan(),
    decisions: [{ question: 'Qual limite?', answer: 'O limite aprovado', resolvesQuestion: 'Q1' }],
    verification: [{ criterion: 'O revisor confirma o limite', check: 'inspection' }],
    openQuestions: [
      { question: 'Limite técnico?', blocking: false, decideBy: { beforeTask: 'T2' } },
      { question: 'Limite operacional?', blocking: false, decideBy: { beforePhase: 'P1' } },
      { question: 'Confirmação final?', blocking: true, answer: 'Confirmado', decideBy: 'user-now' },
    ],
    writes: ['docs/limite.md'],
  }
  assert.doesNotThrow(() => assertTaskPlan(inspectionTask, approved))

  const emptySummary = structuredClone(approved)
  emptySummary.summary = '   '
  assert.throws(() => assertTaskPlan(inspectionTask, emptySummary), /summary/)

  const unresolved = structuredClone(approved)
  unresolved.decisions[0].resolvesQuestion = ''
  assert.throws(() => assertTaskPlan(inspectionTask, unresolved), /resolvesQuestion/)

  const unanswered = structuredClone(approved)
  unanswered.openQuestions[2].answer = undefined
  assert.throws(() => assertTaskPlan(inspectionTask, unanswered), /unanswered blocking/)

  const ambiguousDeadline = structuredClone(approved)
  ambiguousDeadline.openQuestions[0].decideBy = { beforeTask: 'T2', beforePhase: 'P1' }
  assert.throws(() => assertTaskPlan(inspectionTask, ambiguousDeadline), /openQuestions/)
})

test('helpers de fase preservam dependências, recibos e diferenças de entradas', () => {
  const dependency = {
    id: 'D1', title: 'Dependência concluída', state: 'done', deps: [], attempts: [{ n: 1 }],
    validations: [{ ok: true, attempt: 1, token: 'token', at: '2026-01-01T00:00:00Z', agent: 'reviewer', evidence: 'passou' }],
  }
  const waiting = { id: 'D2', title: 'Dependência pendente', state: 'pending', phase: 'P2', deps: [] }
  const waived = { id: 'D3', title: 'Dependência dispensada', state: 'skipped', phase: 'P3', deps: [], skipReason: 'Fora do escopo' }
  const current = { id: 'T1', title: 'Tarefa atual', state: 'pending', phase: 'P1', deps: ['D1', 'D2', 'ausente', 'D1'], attempts: [] }
  const state = {
    plan: { name: 'Plano', description: 'Contrato', requireReview: true, planningRevision: 1, planningMode: 'phase' },
    tasks: { T1: current, D1: dependency, D2: waiting, D3: waived },
  }

  assert.deepEqual(phaseRequiredInputs(state, current), [
    { task: 'D2', phase: 'P2', requiredEvidence: 'current terminal receipt for D2' },
    { task: 'ausente', phase: null, requiredEvidence: 'current terminal receipt for ausente' },
  ])
  assert.notEqual(phasePlanningContext(state, current), phasePlanningContext({
    ...state, plan: { ...state.plan, planningRevision: 2 },
  }, current))
  assert.match(planningContext(state, current), /^[a-f0-9]{64}$/)

  const phaseTask = { ...task(), id: 'P-T1', title: 'Tarefa de fase', phase: 'P1', deps: [] }
  const phaseState = {
    plan: { name: 'Plano', description: 'Contrato', requireReview: false, planningMode: 'phase' },
    tasks: { 'P-T1': phaseTask },
  }
  const phasePlan = {
    ...plan(),
    phaseBinding: { phaseId: 'P1', discussionRoundId: 'D1', plannerRound: 1 },
    unresolvedInputs: [],
  }
  const binding = { phaseId: 'P1', discussionRoundId: 'D1', plannerRound: 1 }
  assert.doesNotThrow(() => assertPhaseTaskPlan(phaseState, phaseTask, phasePlan, binding))
  assert.throws(() => assertPhaseTaskPlan(phaseState, phaseTask, phasePlan, binding,
    [{ task: 'D2', phase: 'P2', requiredEvidence: 'recibo atual' }]), /unresolvedInputs differ/)
  const unexpected = structuredClone(phasePlan)
  unexpected.unresolvedInputs = [{ task: 'D2', phase: 'P2', requiredEvidence: 'recibo atual' }]
  assert.throws(() => assertPhaseTaskPlan(phaseState, phaseTask, unexpected, binding), /unresolvedInputs differ/)

  const receipt = executionInputReceipt(state, { ...current, deps: ['D1', 'D3'] })
  assert.equal(receipt.inputs[0].result, 'validated')
  assert.equal(receipt.inputs[1].result, 'waived')
})

test('recibo de execução rejeita dependência não terminal e waiver sem motivo', () => {
  const base = { plan: { name: 'Plano' }, tasks: {} }
  const dependent = { id: 'T1', deps: ['D1'], attempts: [] }
  base.tasks.D1 = { id: 'D1', state: 'running', deps: [], attempts: [] }
  assert.throws(() => executionInputReceipt(base, dependent), /still waiting on: D1/)

  base.tasks.D1 = { id: 'D1', state: 'skipped', deps: [], attempts: [], skipReason: '' }
  assert.throws(() => executionInputReceipt(base, dependent), /skip waiver needs a reason/)
})

test('entradas de fase distinguem a mesma tarefa em fases diferentes e preservam multiplicidade', () => {
  const value = { ...task(), id: 'T1', deps: [] }
  const binding = { phaseId: 'P1', discussionRoundId: 'D1', plannerRound: 1 }
  const approved = { ...plan(), phaseBinding: binding, unresolvedInputs: [] }
  const expected = [
    { task: 'D2', phase: 'P2', requiredEvidence: 'recibo atual' },
    { task: 'D1', phase: 'P3', requiredEvidence: 'recibo atual' },
    { task: 'D1', phase: 'P2', requiredEvidence: 'recibo atual' },
  ]
  assert.throws(() => assertPhaseTaskPlan({}, value, approved, binding, expected), error => {
    assert.match(error.message, /missing \[{"task":"D1","phase":"P2"},{"task":"D1","phase":"P3"},{"task":"D2","phase":"P2"}\]/)
    return true
  })
  approved.unresolvedInputs = [...expected].reverse()
  assert.doesNotThrow(() => assertPhaseTaskPlan({}, value, approved, binding, expected))
  approved.unresolvedInputs.push(expected[0])
  assert.throws(() => assertPhaseTaskPlan({}, value, approved, binding, expected), /unexpected \[{"task":"D2","phase":"P2"}\]/)
})

test('recibo de dispensa sem fase permanece explícito e contexto inclui dependência ausente', () => {
  const value = { ...task(), id: 'T1', title: 'Entrega', deps: ['D1'] }
  const state = { plan: { name: 'Contrato' }, tasks: { D1: { state: 'skipped', skipReason: 'Fora do escopo' } } }
  assert.deepEqual(executionInputReceipt(state, value).inputs, [
    { task: 'D1', phase: null, result: 'waived', reason: 'Fora do escopo' },
  ])
  const missing = { ...state, tasks: {} }
  assert.notEqual(planningContext(state, value), planningContext(missing, value))
  state.tasks.D1.deps = ['D2']
  const ancestorMissing = planningContext(state, value)
  state.tasks.D2 = { id: 'D2', title: 'Entrada ancestral', deps: [] }
  assert.notEqual(planningContext(state, value), ancestorMissing)
})

test('planos atuais preservam skips de fase, skips de tarefa e descoberta registrada', () => {
  const phaseTask = {
    ...task(), id: 'P1-T1', title: 'Tarefa de fase', phase: 'P1', deps: [], attempts: [],
    validations: [], planningRequired: true,
    taskPlan: {
      ...plan(), planner: 'planejador', completedAt: '2026-01-01T00:00:00Z', attempt: 1,
      phaseId: 'P1', phaseDecision: 'skipped', phaseBinding: { discussionRoundId: 'D1' },
      phaseDecisionDigest: 'fase-digest',
    },
  }
  const phaseState = {
    plan: { name: 'Plano', description: 'Contrato', requireReview: false, planningMode: 'phase' },
    tasks: { 'P1-T1': phaseTask },
    phaseWorkflows: { P1: { discussionSkips: [{ decisionId: 'D1', confirmedByUser: true, digest: 'fase-digest' }] } },
  }
  phaseTask.taskPlan.scope = phasePlanningContext(phaseState, phaseTask)
  assert.equal(hasCurrentTaskPlan(phaseState, phaseTask), true)
  assert.equal(hasCurrentTaskScope(phaseState, phaseTask, 1), true)
  phaseTask.phasePlanDefect = true
  assert.equal(hasCurrentTaskPlan(phaseState, phaseTask), false)
  assert.equal(hasCurrentTaskScope(phaseState, phaseTask, 1), false)

  const taskSkip = {
    ...task(), id: 'T2', title: 'Tarefa dispensada', deps: [], attempts: [], validations: [], planningRequired: true,
    taskPlan: {
      ...plan(), planner: 'planejador', completedAt: '2026-01-01T00:00:00Z', attempt: 1,
      discussionDecision: 'skipped', discussionDecisionId: 'D2', discussionDecisionDigest: 'tarefa-digest',
    },
    discussionSkips: [{ decisionId: 'D2', confirmedByUser: true, digest: 'tarefa-digest' }],
  }
  const taskState = {
    plan: { name: 'Plano', description: 'Contrato', requireReview: false, planningMode: 'task' },
    tasks: { T2: taskSkip },
  }
  taskSkip.discussionSkips[0].scope = phasePlanningContext(taskState, taskSkip)
  taskSkip.taskPlan.scope = planningContext(taskState, taskSkip, { scopeOnly: true, attempt: 1 })
  taskSkip.taskPlan.context = planningContext(taskState, taskSkip, { attempt: 1 })
  assert.equal(hasCurrentTaskPlan(taskState, taskSkip), true)
  assert.equal(hasCurrentTaskScope(taskState, taskSkip, 1), true)

  delete taskSkip.taskPlan.discussionDecision
  delete taskSkip.taskPlan.discussionDecisionId
  delete taskSkip.taskPlan.discussionDecisionDigest
  taskSkip.discoveryRequired = true
  taskSkip.discovery = { ...discovery(), digest: '', context: 'descoberta', attempt: 1 }
  taskSkip.discovery.digest = discoveryDigest(taskSkip.discovery)
  taskSkip.taskPlan.discoveryDigest = taskSkip.discovery.digest
  taskSkip.taskPlan.context = taskSkip.discovery.context
  assert.equal(hasCurrentTaskPlan(taskState, taskSkip), true)
  assert.equal(hasCurrentTaskScope(taskState, taskSkip, 1), true)

  const explicitSkip = {
    ...task(), id: 'T3', title: 'Tarefa sem artefato', deps: [], attempts: [], validations: [], planningRequired: true,
  }
  taskState.tasks.T3 = explicitSkip
  const scope = phasePlanningContext(taskState, explicitSkip)
  explicitSkip.planningSkips = [{ decision: 'skipped', confirmedByUser: true, scope }]
  assert.equal(currentPlanningScope(taskState, explicitSkip, 1), scope)
})

test('contexto de planejamento e escopo atual distinguem execução corrente e retry', () => {
  const value = {
    ...task(), id: 'T1', title: 'Tarefa planejada', deps: [], attempts: [], validations: [],
    planningRequired: true,
    taskPlan: { ...plan(), planner: 'planejador', completedAt: '2026-01-01T00:00:00Z', attempt: 1 },
  }
  const state = {
    plan: { name: 'Plano', description: 'Contrato', requireReview: false, planningMode: 'task' },
    tasks: { T1: value },
  }
  value.taskPlan.scope = planningContext(state, value, { scopeOnly: true, attempt: 1 })
  value.taskPlan.context = planningContext(state, value, { attempt: 1 })
  assert.equal(hasCurrentTaskPlan(state, value), true)
  assert.equal(hasCurrentTaskScope(state, value, 1), true)
  assert.equal(currentPlanningScope(state, value, 1), value.taskPlan.scope)

  value.attempts = [{ n: 1, result: 'failed', reason: 'ajustar a execução' }]
  value.taskPlan.scope = planningContext(state, value, { scopeOnly: true, attempt: 1 })
  value.taskPlan.context = planningContext(state, value, { attempt: 1 })
  value.retryPlan = {
    attempt: 2,
    planSourceAttempt: 1,
    failedAttempt: 1,
    reason: 'ajustar a execução',
    context: planningContext(state, value, { attempt: 2 }),
    planContext: value.taskPlan.context,
    planScope: value.taskPlan.scope,
    scope: planningContext(state, value, { scopeOnly: true, attempt: 2 }),
  }
  assert.equal(hasCurrentTaskScope(state, value, 2), true)
  assert.equal(currentPlanningScope(state, value, 2), value.retryPlan.scope)
})

test('assertValidation rejeita contrato, escopo e recibo divergentes', () => {
  const value = task()
  const contract = validationContract(value)
  const validCheck = { run: step().run, kind: 'functional', expect: step().expect, exitCode: 0, error: null, signal: null }
  const receipt = {
    contract: contract.key, contractRevision: 0, scopeRevision: 0, stateRevision: 0,
    checks: [validCheck], evidence: 'A verificação passou',
  }
  assert.doesNotThrow(() => assertValidation(value, receipt))
  for (const [field, message] of [['contractRevision', /contract was refreshed/], ['scopeRevision', /scope changed/]]) {
    const invalid = { ...receipt, [field]: 1 }
    assert.throws(() => assertValidation(value, invalid), message)
  }
  for (const field of ['run', 'kind', 'expect']) {
    const invalid = structuredClone(receipt)
    invalid.checks[0][field] = 'divergente'
    assert.throws(() => assertValidation(value, invalid), /validation check 1\/1/)
  }
  assert.throws(() => assertValidation(value, { ...receipt, evidence: ' ' }), /evidence/)
})
