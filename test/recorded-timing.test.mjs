import test from 'node:test'
import assert from 'node:assert/strict'
import { recordedAgentTiming } from '../scripts/recorded-timing.mjs'

const at = minutes => new Date(Date.UTC(2026, 0, 1) + minutes * 60000).toISOString()
const round = (agent, intervals = []) => ({ agent, startedAt: at(0), endedAt: at(30), activityIntervals: intervals })

test('três agentes em paralelo somam 90 minutos ativos e 30 minutos corridos', () => {
  const tasks = Object.fromEntries(['A', 'B', 'C'].map(id => [id, { state: 'pending', planningAttempts: [
    round(id, [{ role: 'planning', agent: id, startedAt: at(0), endedAt: at(30) }]),
  ] }]))
  const result = recordedAgentTiming({ tasks }, [], Date.parse(at(60))).roles.planning
  assert.equal(result.measuredMs, 90 * 60000)
  assert.equal(result.elapsedMs, 30 * 60000)
  assert.equal(result.hasActivityRecords, true)
})

test('espera entra somente no tempo corrido e STOP congela o trabalho ativo', () => {
  const state = { tasks: { A: { state: 'running', attempts: [{ n: 1, agent: 'executor', startedAt: at(0),
    activityIntervals: [{ role: 'execution', agent: 'executor', startedAt: at(5), endedAt: at(15) }] }] } } }
  for (const minutes of [30, 60]) {
    const result = recordedAgentTiming(state, [], Date.parse(at(minutes))).roles.execution
    assert.equal(result.measuredMs, 10 * 60000)
    assert.equal(result.elapsedMs, minutes * 60000)
  }
})

test('duração sem atividade não vira trabalho medido; um START novo pode ter zero segundos', () => {
  const state = { tasks: { A: { state: 'pending', discussionAttempts: [round('discutidor')] } } }
  let result = recordedAgentTiming(state, [], Date.parse(at(30))).roles.discussion
  assert.equal(result.elapsedMs, 30 * 60000)
  assert.equal(result.measuredMs, 0)
  assert.equal(result.hasActivityRecords, false)
  state.tasks.A.discussionAttempts[0].activityIntervals = [{ role: 'discussion', startedAt: at(30), endedAt: at(30) }]
  result = recordedAgentTiming(state, [], Date.parse(at(30))).roles.discussion
  assert.equal(result.hasActivityRecords, true)
  assert.equal(result.measuredMs, 0)
  for (const startedAt of ['inválido', at(60)]) {
    state.tasks.A.discussionAttempts[0].activityIntervals = [{ role: 'discussion', startedAt }]
    assert.equal(recordedAgentTiming(state, [], Date.parse(at(30))).roles.discussion.hasActivityRecords, false)
  }
})

test('pausas registradas saem dos dois tempos sem duplicar workers de fase', () => {
  const worker = round('planejador', [{ role: 'planning', startedAt: at(0), endedAt: at(30) }])
  const result = recordedAgentTiming({ runPauseHistory: [{ startedAt: at(10), endedAt: at(20) }],
    tasks: { A: { phase: 'F1', planningAttempts: [worker] } },
    phaseWorkflows: { F1: { planningAttempts: [{ workers: { A: worker } }] } } }, [], Date.parse(at(30))).roles.planning
  assert.equal(result.elapsedMs, 20 * 60000)
  assert.equal(result.measuredMs, 20 * 60000)
})
