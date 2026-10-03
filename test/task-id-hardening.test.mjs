import test from 'node:test'
import assert from 'node:assert/strict'
import { renameHistoricalTasks, normalizeLegacyPlanIdentifiers } from '../scripts/task-id-migration.mjs'
import { taskIdentifierProblem, phaseIdentifierProblem } from '../scripts/task-identifiers.mjs'
import { taskPlanDigest, phasePlanningContext } from '../scripts/validation.mjs'

const task = (id, deps = []) => ({ id, deps })
const issue = (tasks, existingIds) => taskIdentifierProblem(tasks, existingIds)?.message ?? null

test('padronização legada remapeia referências sem alterar provas assinadas ou estados', () => {
  const proof = { phaseBinding: { phaseId: 'F0' }, digest: 'prova-original', phaseId:'F0', scope:'escopo-original' }
  const state = {plan:{phases:[{id:'F0'},{id:'F1'}]}, tasks:{
    T01:{id:'T01',phase:'F0',deps:[],state:'done',taskPlan:proof},
    HO1:{id:'HO1',phase:'F1',deps:['T01'],state:'pending'},
  },phaseWorkflows:{F0:{id:'F0',planningAttempts:[{endedAt:'2026-01-01',targets:['T01'],context:'assinado'}]}}}
  proof.scope = phasePlanningContext(state, state.tasks.T01)
  const plan = {phases:state.plan.phases,tasks:Object.values(state.tasks)}
  const events = [{task:'T01',phase:'F0',targets:['HO1'],text:'T01 é texto histórico',nested:{beforeTask:'HO1',beforePhase:'F1'}}]
  const before = structuredClone({state,plan,events})
  const result=normalizeLegacyPlanIdentifiers(state,plan,events,{T01:'T1',HO1:'T2'},{F0:'F1',F1:'F2'})
  assert.equal(taskPlanDigest(result.state.tasks.T1.taskPlan),taskPlanDigest(proof))
  assert.equal(result.state.tasks.T1.taskPlan.phaseBinding.phaseId,'F0')
  assert.equal(result.state.tasks.T1.taskPlan.phaseId,'F1')
  assert.equal(result.state.tasks.T1.taskPlan.scope,phasePlanningContext(result.state,result.state.tasks.T1))
  assert.equal(result.state.tasks.T1.state,'done')
  assert.deepEqual(result.state.tasks.T2.deps,['T1'])
  assert.equal(result.state.tasks.T2.phase,'F2')
  assert.deepEqual(result.state.phaseWorkflows.F1.planningAttempts[0].targets,['T1'])
  assert.equal(result.events[0].originalTask,'T01')
  assert.equal(result.events[0].originalPhase,'F0')
  assert.equal(result.events[0].text,events[0].text)
  assert.deepEqual(result.events[0].nested,{beforeTask:'T2',beforePhase:'F2'})
  assert.deepEqual(result.state.taskIdAliases,{T01:'T1',HO1:'T2'})
  assert.deepEqual({state,plan,events},before)
})

test('renumeração na mesma fase preserva contratos válidos sem revalidar contratos antigos', () => {
  const state = { plan: { phases: [{ id: 'F1' }] }, taskIdAliases: { T1: 'T2', antigo: 'T2' }, tasks: {
    T2: { id: 'T2', phase: 'F1', deps: [], state: 'done', taskPlan: { phaseId: 'F1', summary: 'Entrega aprovada' } },
    T3: { id: 'T3', phase: 'F1', deps: ['T2'], state: 'done', taskPlan: { phaseId: 'F1', scope: 'contrato-desatualizado' } },
    T4: { id: 'T4', phase: 'F1', deps: ['T2'], state: 'blocked', blockReason: 'Aguarda decisão', attempts: [{ agent: 'executor', startedAt: '2026-01-01', inputReceipt: [{ task: 'T2', digest: 'prova-original' }] }] },
  } }
  state.tasks.T2.taskPlan.scope = phasePlanningContext(state, state.tasks.T2)
  const plan = { phases: state.plan.phases, tasks: Object.values(state.tasks) }
  const result = normalizeLegacyPlanIdentifiers(state, plan, [], { T2: 'T1', T3: 'T2', T4: 'T3' })
  assert.equal(result.state.tasks.T1.taskPlan.scope, phasePlanningContext(result.state, result.state.tasks.T1))
  assert.equal(taskPlanDigest(result.state.tasks.T1.taskPlan), taskPlanDigest(state.tasks.T2.taskPlan))
  assert.equal(result.state.tasks.T2.taskPlan.scope, 'contrato-desatualizado')
  assert.deepEqual(result.state.taskIdAliases, { antigo: 'T1', T4: 'T3' })
  assert.deepEqual(result.state.tasks.T3, { ...state.tasks.T4, id: 'T3', deps: ['T1'] })
  for (const field of ['taskPlan', 'executionAuthorization']) {
    const signed = structuredClone(state)
    signed.tasks.T4[field] = {}
    assert.throws(() => normalizeLegacyPlanIdentifiers(signed, plan, [], { T4: 'T5' }), /contrato ativo/)
  }
})

test('padronização recusa colisões, nomes inválidos e trabalho aberto sem mudar entradas', () => {
  const state={plan:{phases:[{id:'F0'}]},tasks:{A:{id:'A',state:'pending',phase:'F0',deps:[]},B:{id:'B',state:'pending',phase:'F0',deps:[]}}}
  const plan={phases:state.plan.phases,tasks:Object.values(state.tasks)}
  for(const mapping of [{A:'T1',B:'T1'},{A:'HO1'},{X:'T1'}]) assert.throws(()=>normalizeLegacyPlanIdentifiers(state,plan,[],mapping,{F0:'F1'}))
  for(const fields of [{taskPlan:{digest:'assinado'}},{executionAuthorization:{}},{attempts:[{}]},{state:'running'},{discussionAttempts:[{}]},{planningAttempts:[{}]}]) {
    const input=structuredClone(state);Object.assign(input.tasks.A,fields);const before=structuredClone(input)
    assert.throws(()=>normalizeLegacyPlanIdentifiers(input,plan,[],{A:'T1',B:'T2'},{F0:'F1'}))
    assert.deepEqual(input,before)
  }
  const open=structuredClone(state);open.phaseWorkflows={F0:{discussionAttempts:[{}]}}
  assert.throws(()=>normalizeLegacyPlanIdentifiers(open,plan,[],{A:'T1',B:'T2'},{F0:'F1'}))
})

test('padronização mantém referências antigas resolvíveis e aceita planos sem fases', () => {
  const state={plan:{},tasks:{A:{id:'A',state:'skipped',deps:[]},T2:{id:'T2',state:'pending',deps:['A']}},taskIdAliases:{legado:'A'},value:null,enabled:false}
  const plan={tasks:Object.values(state.tasks)}
  const events=[{task:'A',originalTask:'origem',phase:'F0',originalPhase:'fase-original',data:[null,3,false]},{}]
  const result=normalizeLegacyPlanIdentifiers(state,plan,events,{A:'T1'})
  assert.deepEqual(result.state.taskIdAliases,{legado:'T1',A:'T1'})
  assert.deepEqual(result.state.tasks.T2.deps,['T1'])
  assert.equal(result.events[0].originalTask,'origem')
  assert.equal(result.events[0].originalPhase,'fase-original')
  assert.deepEqual(result.events[0].data,[null,3,false])
  assert.deepEqual(normalizeLegacyPlanIdentifiers({plan:{},tasks:{}},{tasks:[]},[]).plan.phases,[])
  const unchanged={id:'T1',state:'pending'}
  assert.equal(normalizeLegacyPlanIdentifiers({plan:{},tasks:{T1:unchanged}},{tasks:[unchanged]},[]).state.tasks.T1.state,'pending')
  const phased={plan:{phases:[{id:'F0'}]},tasks:{T1:{id:'T1',state:'done',phase:'F0'}},phaseWorkflows:{F0:{planningAttempts:[{}]}}}
  assert.throws(()=>normalizeLegacyPlanIdentifiers(phased,{phases:phased.plan.phases,tasks:Object.values(phased.tasks)},[],{},{F0:'F1'}))
  phased.phaseWorkflows.F0.planningAttempts=[{endedAt:'2026-01-01'}]
  const moved=normalizeLegacyPlanIdentifiers(phased,{phases:phased.plan.phases,tasks:Object.values(phased.tasks)},[{phase:'F0',originalPhase:'original'}],{},{F0:'F1'})
  assert.equal(moved.events[0].originalPhase,'original')
})

test('identificadores iniciais distinguem plano sequencial, legado e entradas inválidas', () => {
  assert.equal(issue([]), null)
  assert.match(issue([task('A1'), task('B2')]), /must use T1/)
  assert.equal(issue([task('T2'), task('T1')]), null)

  assert.match(issue([task('T1'), task('A1')]), /cannot mix/)
  assert.match(issue([task('T01')]), /without suffixes/)
  assert.match(issue([task('t1')]), /without suffixes/)
  assert.match(issue([task('T1a')]), /without suffixes/)
  assert.match(issue([task('T1'), task('T3')]), /sequential/)
})

test('fases novas exigem F1, F2 e sequência; somente identificadores persistidos são legados', () => {
  assert.equal(phaseIdentifierProblem([]),null)
  assert.equal(phaseIdentifierProblem([{id:'F1'},{id:'F2'}]),null)
  for(const id of ['F0','F01','F1B','P1','f1','F2'])assert.ok(phaseIdentifierProblem([{id}]))
  assert.equal(phaseIdentifierProblem([{id:'F0'},{id:'F1B'},{id:'F1'}],['F0','F1B']),null)
  assert.equal(phaseIdentifierProblem([{id:'F1'},{id:'F2'},{id:'F3'}],['F1','F2']),null)
  assert.ok(phaseIdentifierProblem([{id:'F1'},{id:'F4'}],['F1']))
})

test('ampliações aceitas preservam a sequência, o pai e a ligação por dependências', () => {
  assert.equal(issue([task('T1'), task('T1a', ['T1'])], ['T1']), null)
  assert.match(issue([task('T1'), task('T1a', ['T1'])], ['legado']), /must extend/)
  assert.equal(issue([task('T1'), task('T1b', ['T1']), task('T1a', ['T1'])], ['T1']), null,
    'a ordem da entrada não muda a próxima extensão')
  assert.equal(issue([task('T1'), task('T1a', ['T1']), task('T1b', ['T1'])], ['T1', 'T1a']), null)
  assert.match(issue([task('T1'), task('T1a', ['T1'])], ['T1', 'T1z']), /all extension suffixes/)
  assert.match(issue([task('T1'), task('T1A', ['T1'])], ['T1']), /lowercase suffix/)
  assert.match(issue([task('T1'), task('T1b', ['T1'])], ['T1']), /next extension/)
  assert.match(issue([task('T2'), task('T1a', ['T2'])], ['T2']), /no existing parent/)
  assert.match(issue([task('T1'), task('T1a')], ['T1']), /linked to its parent/)
  assert.equal(issue([task('T1', ['T1a']), task('T1a')], ['T1']), null,
    'a ligação indireta que alcança a filha continua válida')
  assert.equal(issue([task('T1'), task('T1a', ['T1'])], ['T1', 'T2a', 'T3']), null)
})

test('a validação rejeita formato novo, ciclos desconectados e pais ausentes', () => {
  assert.match(issue([task('T0'),task('T0a',['T0'])],['T0']),/must extend/)
  assert.match(issue([task('T01'),task('T01a',['T01'])],['T01']),/must extend/)
  assert.match(issue([task('A1'), task('T1')], ['T1']), /must extend/)
  assert.match(issue([task('T1'), task('T1A')], ['T1']), /must extend/)
  assert.match(issue([task('T1'), task('T1a', ['MISSING'])], ['T1']), /linked to its parent/)

  const cycle = [task('T1', ['T9']), task('T9', ['T1']), task('T1a')]
  assert.match(issue(cycle, ['T1', 'T9']), /linked to its parent/)
})

const migrationFixture = ({ aliases = { legado: 'T1' }, phases = true, noAliases = false } = {}) => {
  const state = {
    ...(noAliases ? {} : { taskIdAliases: aliases }),
    tasks: {
      T1: { id: 'T1', state: 'done', deps: [], attempts: [] },
      T2: { id: 'T2', state: 'skipped', deps: [], skipReason: 'Fora do escopo' },
      T3: { id: 'T3', state: 'pending', deps: ['T2'], discussionAttempts: [{ endedAt: null }] },
      T4: { id: 'T4', state: 'pending', deps: [], taskPlan: { digest: 'plano-T4' } },
      T5: { id: 'T5', state: 'pending', deps: [], executionAuthorization: { digest: 'auth-T5' } },
    },
  }
  state.tasks.T4.deps = undefined
  const plan = { tasks: Object.values(state.tasks).map(({ id, deps }) => ({ id, deps: [...(deps ?? [])], title: `Entrega ${id}` })) }
  plan.tasks.find(item => item.id === 'T4').deps = undefined
  if (phases) {
    state.phaseWorkflows = {
      F1: {
        discussionAttempts: [{ targets: ['T1', 'T3'], endedAt: '2026-01-01T00:00:00Z', digest: 'fechado' }],
        planningAttempts: [{ targets: ['T3'], endedAt: null }],
      },
      F2: { planningAttempts: [{ targets: null, endedAt: '2026-01-02T00:00:00Z' }] },
      F3: { discussionAttempts: [{ targets: ['T3'], endedAt: '2026-01-03T00:00:00Z' }] },
      F4: { planningAttempts: [{ targets: null, endedAt: null }] },
    }
  }
  const events = [
    {
      task: 'T1', taskId: 'T1', tasks: ['T1', 'T3'], targets: ['T1'], members: ['T1'], deps: ['T1'],
      blockedBy: 'T1', planningBlockedBy: 'T1', added: ['T1'], updated: ['T1'], preserved: ['T1'],
      metadataUpdated: ['T1'], revokedAuthorizationTasks: ['T1'], text: 'T1 é histórico',
      nested: { task: 'T1', label: 'T1', list: ['T1'], empty: null, number: 4 },
    },
    { task: 'T1', originalTask: 'origem explícita', changes: { updated: ['T1'] } },
    { task: 'T3', text: 'T3 permanece igual' },
    { text: 'evento sem tarefa', value: false, empty: null },
  ]
  return { state, plan, events }
}

test('migração remapeia estado, plano, aliases, eventos e preserva provas fechadas', () => {
  const original = migrationFixture()
  const before = structuredClone(original)
  const result = renameHistoricalTasks(original.state, original.plan, original.events, { T1: 'T2a' })

  assert.deepEqual(original, before)
  assert.equal(result.state.tasks.T2a.id, 'T2a')
  assert.equal(result.state.tasks.T2a.deps.length, 0)
  assert.equal(result.state.tasks.T3.deps[0], 'T2')
  assert.equal(result.state.taskIdAliases.legado, 'T2a')
  assert.equal(result.state.taskIdAliases.T1, 'T2a')
  assert.deepEqual(result.plan.tasks.map(item => item.id), ['T2a', 'T2', 'T3', 'T4', 'T5'])
  assert.deepEqual(result.state.phaseWorkflows.F1.discussionAttempts[0].targets, ['T1', 'T3'])
  assert.equal(result.events[0].task, 'T2a')
  assert.equal(result.events[0].originalTask, 'T1')
  assert.equal(result.events[0].nested.task, 'T2a')
  assert.equal(result.events[0].text, 'T1 é histórico')
  assert.equal(result.events[1].originalTask, 'origem explícita')
  assert.equal(result.events[2].task, 'T3')
  assert.equal(result.events[3].value, false)
})

test('migração também aceita estado sem aliases nem fluxos de fase', () => {
  const original = migrationFixture({ noAliases: true, phases: false })
  const result = renameHistoricalTasks(original.state, original.plan, original.events, { T1: 'T2a' })
  assert.deepEqual(result.state.taskIdAliases, { T1: 'T2a' })
  assert.equal(result.state.phaseWorkflows, undefined)
})

const rejectionCases = [
  ['origem ausente', fixture => {}, { T999: 'T2a' }, /Tarefa ausente/],
  ['origem ativa', fixture => { fixture.state.tasks.T1.state = 'running' }, { T1: 'T2a' }, /ainda está ativa/],
  ['destino inválido', fixture => {}, { T1: 'T2A' }, /T2A/],
  ['destino já existente', fixture => { fixture.state.tasks.T2a = { id: 'T2a', state: 'done', deps: [] } }, { T1: 'T2a' }, /Identificador já utilizado/],
  ['destino repetido', fixture => { fixture.state.tasks.T6 = { id: 'T6', state: 'done', deps: [] }; fixture.plan.tasks.push({ id: 'T6', deps: [] }) }, { T1: 'T2a', T6: 'T2a' }, /Identificador já utilizado/],
  ['pai ausente', fixture => {}, { T1: 'T99a' }, /Tarefa original ausente/],
  ['pai renomeado junto', fixture => {}, { T1: 'T2a', T2: 'T3a' }, /precisa manter seu identificador/],
  ['ausente do plano', fixture => { fixture.plan.tasks = fixture.plan.tasks.filter(item => item.id !== 'T1') }, { T1: 'T2a' }, /ausente do plano/],
  ['contrato ativo dependente', fixture => { fixture.state.tasks.T3.deps = ['T1']; fixture.state.tasks.T3.taskPlan = { digest: 'ativo' } }, { T1: 'T2a' }, /contrato ativo assinado/],
  ['rodada de fase aberta', fixture => { fixture.state.phaseWorkflows = { F1: { planningAttempts: [{ targets: ['T1'] }] } } }, { T1: 'T2a' }, /rodada aberta/],
  ['alias conflitante', fixture => { fixture.state.taskIdAliases.T2 = 'T1' }, { T1: 'T2a' }, /Alias conflita/],
  ['alias sem destino', fixture => { fixture.state.taskIdAliases.legado = 'T999' }, { T1: 'T2a' }, /Alias aponta/],
  ['alvo fechado irrecuperável', fixture => { fixture.state.phaseWorkflows = { F1: { planningAttempts: [{ targets: ['T999'], endedAt: 'fechado' }] } } }, { T1: 'T2a' }, /Alvo histórico ausente/],
]

for (const [name, change, mapping, error] of rejectionCases) {
  test(`migração rejeita ${name} sem mutar as entradas`, () => {
    const original = migrationFixture()
    change(original)
    const before = structuredClone(original)
    assert.throws(() => renameHistoricalTasks(original.state, original.plan, original.events, mapping), error)
    assert.deepEqual(original, before)
  })
}
