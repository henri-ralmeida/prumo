import test from 'node:test'
import assert from 'node:assert/strict'
import { isReadyForReview, isReviewRejected } from '../scripts/review-readiness.mjs'

import { rejectionCases } from './fixtures/review-rejection.mjs'

test('reprovação só é exibida após resultado concluído e não atravessa tentativas ou nova atividade', () => {
  for (const [value, expected] of rejectionCases()) {
    const before = JSON.stringify(value)
    assert.equal(isReviewRejected(value), expected, before)
    assert.equal(JSON.stringify(value), before)
  }
})

const task = () => ({ state:'running', attempts:[{activityTiming:'explicit',activityIntervals:[{role:'execution',startedAt:'2026-01-01T09:00:00Z',endedAt:'2026-01-01T09:10:00Z'}]}] })
test('STOP de execucao abre espera por revisao sem criar atividade de Revisor', () => {
  const ready=task(), before=JSON.stringify(ready)
  assert.equal(isReadyForReview(ready),true)
  assert.equal(JSON.stringify(ready),before)
  delete ready.attempts[0].activityIntervals[0].endedAt
  assert.equal(isReadyForReview(ready),false)
  ready.attempts[0].activityIntervals[0].endedAt='2026-01-01T09:10:00Z'
  ready.state='reviewing';ready.attempts[0].reviewStartedAt='2026-01-01T10:00:00Z'
  assert.equal(isReadyForReview(ready),false)
})
test('fechamento pela pausa conserva execução e um STOP posterior ainda libera revisão', () => {
  const value = task(), interval = value.attempts[0].activityIntervals[0]
  interval.closedBy = 'run-pause'
  assert.equal(isReadyForReview(value), false)
  value.attempts[0].activityIntervals.push({ role: 'execution', startedAt: '2026-01-01T09:20:00Z', endedAt: '2026-01-01T09:30:00Z' })
  assert.equal(isReadyForReview(value), true)
})
test('espera nao e inferida sem STOP comprovado ou para tarefas fora da execucao', () => {
  for (const state of ['blocked','failed','done','pending','skipped']) { const input=task();input.state=state;assert.equal(isReadyForReview(input),false) }
  for (const intervals of [[],[{role:'planning',startedAt:'2026-01-01T09:00:00Z',endedAt:'2026-01-01T09:10:00Z'}],[{role:'execution',startedAt:'invalido',endedAt:'2026-01-01T09:10:00Z'}]]) { const input=task();input.attempts[0].activityIntervals=intervals;assert.equal(isReadyForReview(input),false) }
  const legacy=task();delete legacy.attempts[0].activityTiming;assert.equal(isReadyForReview(legacy),false)
  const missingIntervals=task();delete missingIntervals.attempts[0].activityIntervals;assert.equal(isReadyForReview(missingIntervals),false)
  assert.equal(isReadyForReview(task(),{requireReview:false}),false)
})
