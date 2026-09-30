import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renameHistoricalTasks } from './task-id-migration.mjs'

const mapping = { T17: 'T11a', T25: 'T12a' }

function fixture() {
  const state = { taskIdAliases: { antigo: 'T17' }, tasks: {
    T11: { id: 'T11', state: 'done', deps: [], attempts: [] },
    T12: { id: 'T12', state: 'done', deps: [], attempts: [] },
    T17: { id: 'T17', state: 'done', deps: ['T11'], attempts: [{ result: 'Aprovado', digest: 'assinado-T17' }],
      validations: [{ ok: true, evidence: 'Evidência T17', digest: 'validacao-T17' }],
      taskPlan: { steps: ['Preservar T17 no texto'], digest: 'plano-T17' } },
    T25: { id: 'T25', state: 'skipped', deps: ['T17'], skipReason: 'Fora do escopo' },
    T29: { id: 'T29', state: 'pending', deps: ['T25'] },
  } }
  const plan = { tasks: Object.values(state.tasks).map(({ id, deps }) => ({ id, deps: [...deps], title: `Entrega ${id}` })) }
  const events = [
    { task: 'T17', text: 'T17 foi aprovado', evidence: { detail: 'T17 comprovado' },
      targets: ['T17', 'T25'], changes: { added: ['T17'], updated: ['T25'], preserved: ['T11'] } },
    { task: 'T25', originalTask: 'origem-anterior', taskId: 'T17', deps: ['T17'], members: ['T17', 'T25'],
      changes: { metadataUpdated: ['T25'], revokedAuthorizationTasks: ['T17'] } },
  ]
  return { state, plan, events }
}

test('renomeia IDs e referências sem mutar originais nem provas históricas', () => {
  const original = fixture()
  const before = structuredClone(original)
  const { state, plan, events } = renameHistoricalTasks(original.state, original.plan, original.events, mapping)
  assert.deepEqual(original, before)
  assert.deepEqual(Object.keys(state.tasks), ['T11', 'T12', 'T11a', 'T12a', 'T29'])
  assert.deepEqual(state.tasks.T11a, { ...before.state.tasks.T17, id: 'T11a', deps: ['T11'] })
  assert.deepEqual(state.tasks.T12a, { ...before.state.tasks.T25, id: 'T12a', deps: ['T11a'] })
  assert.deepEqual(state.tasks.T29.deps, ['T12a'])
  assert.deepEqual(plan.tasks.map(({ id, deps }) => [id, deps]), [
    ['T11', []], ['T12', []], ['T11a', ['T11']], ['T12a', ['T11a']], ['T29', ['T12a']],
  ])
  assert.deepEqual(state.taskIdAliases, { antigo: 'T11a', T17: 'T11a', T25: 'T12a' })
  assert.deepEqual(events[0], { ...before.events[0], task: 'T11a', originalTask: 'T17',
    targets: ['T11a', 'T12a'], changes: { added: ['T11a'], updated: ['T12a'], preserved: ['T11'] } })
  assert.deepEqual(events[1], { ...before.events[1], task: 'T12a', taskId: 'T11a', deps: ['T11a'], members: ['T11a', 'T12a'],
    changes: { metadataUpdated: ['T12a'], revokedAuthorizationTasks: ['T11a'] } })
})

test('rodada de fase fechada conserva alvos e digest assinados, resolvidos por aliases', () => {
  const original = fixture()
  const round = { targets: ['T17', 'T25'], endedAt: '2026-01-01T00:00:00Z', digest: 'fase-assinada',
    evidence: 'A discussão incluiu T17 e T25' }
  original.state.phaseWorkflows = { F1: { id: 'F1', discussionAttempts: [round], planningAttempts: [] } }
  const before = structuredClone(original)
  const { state } = renameHistoricalTasks(original.state, original.plan, original.events, mapping)
  assert.deepEqual(original, before)
  assert.deepEqual(state.phaseWorkflows.F1.discussionAttempts[0], round)
  for (const id of round.targets) assert.ok(state.tasks[state.taskIdAliases[id]])
})

test('mapeamento completo mantém os doze IDs antigos como aliases', () => {
  const all = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
    `T${index + 17}`, `T${index < 8 ? 11 : 12}${String.fromCharCode(97 + (index < 8 ? index : index - 8))}`,
  ]))
  const original = fixture()
  for (let id = 18; id <= 28; id += 1) {
    if (id === 25) continue
    original.state.tasks[`T${id}`] = { id: `T${id}`, state: 'done', deps: [id < 25 ? 'T11' : 'T12'] }
    original.plan.tasks.push({ id: `T${id}`, deps: [id < 25 ? 'T11' : 'T12'], title: `Entrega T${id}` })
  }
  const { state } = renameHistoricalTasks(original.state, original.plan, original.events, all)
  for (const [oldId, newId] of Object.entries(all)) {
    assert.equal(state.taskIdAliases[oldId], newId)
    assert.equal(state.tasks[newId].id, newId)
    assert.equal(state.tasks[oldId], undefined)
  }
})

for (const [name, change, error] of [
  ['colisão com tarefa existente', f => { f.state.tasks.T11a = { id: 'T11a', state: 'done', deps: [] } }, /Identificador já utilizado/],
  ['dois IDs no mesmo destino', f => { f.state.tasks.T18 = { id: 'T18', state: 'done', deps: [] }; f.plan.tasks.push({ id: 'T18', deps: [] }) }, /Identificador já utilizado/],
  ['destino sem tarefa pai', f => { delete f.state.tasks.T11 }, /Tarefa original ausente/],
  ['alias conflitante com tarefa', f => { f.state.taskIdAliases.T11 = 'T17' }, /Alias conflita com uma tarefa existente/],
  ['alias com destino inexistente', f => { f.state.taskIdAliases.antigo = 'T999' }, /Alias aponta para uma tarefa ausente/],
  ['tarefa renomeada ativa', f => { f.state.tasks.T17.state = 'running' }, /ainda está ativa/],
  ['contrato ativo dependente', f => { f.state.tasks.T29.taskPlan = { digest: 'assinado' }; f.state.tasks.T29.deps = ['T17'] }, /contrato ativo assinado/],
  ['rodada de fase aberta', f => { f.state.phaseWorkflows = { F1: { id: 'F1', planningAttempts: [{ targets: ['T17'] }] } } }, /rodada aberta/],
  ['alvo histórico irrecuperável', f => { f.state.phaseWorkflows = { F1: { id: 'F1', planningAttempts: [
    { targets: ['T999'], endedAt: '2026-01-01T00:00:00Z', digest: 'assinado' },
  ] } } }, /Alvo histórico ausente/],
]) test(`recusa ${name} sem mutar as entradas`, () => {
  const original = fixture()
  change(original)
  const before = structuredClone(original)
  const selectedMapping = name === 'dois IDs no mesmo destino' ? { ...mapping, T18: 'T11a' } : mapping
  assert.throws(() => renameHistoricalTasks(original.state, original.plan, original.events, selectedMapping), error)
  assert.deepEqual(original, before)
})

test('recusa renomear o pai e a filha na mesma migração', () => {
  const original = fixture()
  original.state.tasks.T1 = { id: 'T1', state: 'done', deps: [] }
  original.plan.tasks.push({ id: 'T1', deps: [], title: 'Pai do pai' })
  const before = structuredClone(original)
  assert.throws(() => renameHistoricalTasks(original.state, original.plan, original.events,
    { T11: 'T1a', T17: 'T11a' }), /precisa manter seu identificador/)
  assert.deepEqual(original, before)
})

test('engine consulta contrato pelo alias antigo e mantém contagens após migração isolada', t => {
  const home = mkdtempSync(join(tmpdir(), 'prumo-rename-test-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const root = join(home, 'workspace')
  mkdirSync(root)
  const engine = resolve(dirname(fileURLToPath(import.meta.url)), 'engine.mjs')
  const planPath = join(root, 'plan.json')
  const validation = [{ kind: 'functional', run: 'node -e 0', expect: 'A verificação passa' }]
  const plan = { name: 'Migração isolada', planningMode: 'task', tasks: Array.from({ length: 29 }, (_, index) => {
    const id = `T${index + 1}`
    return { id, title: `Entrega ${id}`, deps: id === 'T17' ? ['T11'] : id === 'T25' ? ['T12']
      : id === 'T29' ? ['T17'] : [], validation }
  }) }
  writeFileSync(planPath, JSON.stringify(plan))
  const env = { ...process.env, PRUMO_HOME: home, PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  const run = (...args) => {
    const result = spawnSync(process.execPath, [engine, ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000, windowsHide: true })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }
  run('init', '--plan', planPath, '--run', 'rename-test')
  const runDir = join(root, '.specs', 'graph', 'rename-test')
  const statePath = join(runDir, 'state.json')
  const eventsPath = join(runDir, 'events.ndjson')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.tasks.T11.state = 'done'
  state.tasks.T12.state = 'done'
  state.tasks.T17.state = 'done'
  state.tasks.T25.state = 'skipped'
  state.tasks.T25.skipReason = 'Fora do escopo'
  assert.equal(state.tasks.T29.taskPlan, undefined, 'a tarefa futura não tem artefato de planejamento assinado')
  const events = readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const migrated = renameHistoricalTasks(state, plan, events, mapping)
  writeFileSync(statePath, JSON.stringify(migrated.state))
  writeFileSync(planPath, JSON.stringify(migrated.plan))
  writeFileSync(eventsPath, migrated.events.map(event => JSON.stringify(event)).join('\n') + '\n')

  const oldId = JSON.parse(run('show-contract', 'T17', '--run', 'rename-test'))
  const newId = JSON.parse(run('show-contract', 'T11a', '--run', 'rename-test'))
  assert.equal(oldId.task, 'T11a')
  assert.deepEqual(oldId, newId)
  assert.match(run('runs'), /rename-test\s+3\/29 done/)
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).tasks.T29.deps, ['T11a'])
})
