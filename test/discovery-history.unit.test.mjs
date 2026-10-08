import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactDiscoveries, hydrateDiscoveries } from '../scripts/discovery-history.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'prumo-discovery-history-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('compactacao conserva pesquisa, perguntas, decisoes e ondas apos tres reaberturas', t => {
  const directory = fixture(t)
  const owner = { discussionAttempts: [], planningHistory: [{ round: 1, decision: 'Preservar contrato' }] }
  const state = { phaseWorkflows: { F1: owner } }
  const originals = []
  for (let n = 0; n < 4; n++) {
    hydrateDiscoveries(state, directory)
    const discovery = { roundId: `D${n}`, digest: `digest${n}`, research: [{ findings: 'evidencia' }],
      questions: [{ answer: 'sim' }], decisions: [{ answer: `regra ${n}` }] }
    originals.push(discovery)
    owner.discovery = discovery
    owner.discussionAttempts.push({ roundId: discovery.roundId, endedAt: '2026-01-01', discovery, discoveries: [discovery] })
    compactDiscoveries(state, directory)
    const persisted = JSON.parse(JSON.stringify(state))
    assert.equal(persisted.phaseWorkflows.F1.discussionAttempts.filter(round => round.discovery || round.discoveries).length, 1)
    assert.deepEqual(persisted.phaseWorkflows.F1.discovery, discovery)
  }
  const persisted = JSON.stringify(state)
  hydrateDiscoveries(state, directory)
  assert.equal(JSON.stringify(state), persisted)
  assert.deepEqual(owner.discussionAttempts.map(round => round.discovery), originals)
  assert.deepEqual(owner.discussionAttempts[0].discoveries, [originals[0]])
  assert.deepEqual(owner.planningHistory, [{ round: 1, decision: 'Preservar contrato' }])
})

test('migracao conservadora cobre tarefas legadas e rodadas sem descobertas', t => {
  const directory = fixture(t)
  const discovery = { roundId: 'D1', digest: 'digest', decisions: ['sim'] }
  const state = { tasks: { T1: { discovery, discussionAttempts: [{ roundId: 'D1', endedAt: 'fim' }, { roundId: 'aberta' }, { roundId: 'cancelada', endedAt: 'fim' }] } } }
  compactDiscoveries(state, directory)
  assert.ok(state.tasks.T1.discussionAttempts[0].discoveryArtifact)
  assert.equal(state.tasks.T1.discussionAttempts[1].discoveryArtifact, undefined)
  hydrateDiscoveries(state, directory)
  assert.deepEqual(state.tasks.T1.discussionAttempts[0].discovery, discovery)
  compactDiscoveries({}, directory)
  hydrateDiscoveries({}, directory)
  const waves = { tasks: { T1: { discussionAttempts: [{ endedAt: 'fim', discoveries: [] }, {}] } } }
  compactDiscoveries(waves, directory)
  hydrateDiscoveries(waves, directory)
  assert.deepEqual(waves.tasks.T1.discussionAttempts[0].discoveries, [])
})

test('referencia ausente, adulterada ou fora da execucao fecha validacao e impede escrita', t => {
  const directory = fixture(t)
  for (const reference of ['../../secret.json', `discoveries/${'a'.repeat(64)}.json`, `discoveries/${'b'.repeat(64)}.json`]) {
    if (reference.includes('bbbb')) { mkdirSync(join(directory, 'discoveries'), { recursive: true }); writeFileSync(join(directory, reference), '{}') }
    const state = { phaseWorkflows: { F1: { discussionAttempts: [{ endedAt: 'fim', discoveryArtifact: reference }, {}] } } }
    const before = JSON.stringify(state)
    hydrateDiscoveries(state, directory)
    assert.equal(state.phaseWorkflows.F1.discussionAttempts[0].discovery, undefined)
    assert.equal(JSON.stringify(state), before)
    assert.throws(() => compactDiscoveries(state, directory))
    assert.equal(JSON.stringify(state), before)
  }
})

test('migracao ignora proprietarios vazios e conserva descoberta historica sem digest legado', t => {
  const directory = fixture(t)
  const state = { phaseWorkflows: { F1: {} }, tasks: { T1: { discovery: { roundId: 'other' },
    discussionAttempts: [{ roundId: 'old', endedAt: 'fim', discovery: { decisions: [] } },
      { roundId: 'empty', endedAt: 'fim' }, {}] } } }
  compactDiscoveries(state, directory)
  hydrateDiscoveries(state, directory)
  assert.deepEqual(state.tasks.T1.discussionAttempts[0].discovery, { decisions: [] })
})
