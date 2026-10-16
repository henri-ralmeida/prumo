import test from 'node:test'
import assert from 'node:assert/strict'
import { assertTaskPlan } from '../scripts/validation.mjs'
import { messages, createTranslator } from '../scripts/i18n.mjs'

const task = { id: 'A', title: 'Source', validation: [{ kind: 'functional', run: 'node check.cjs', expect: 'behavior passes' }] }
const planWith = decideBy => ({
  research: [{ source: 'scope.md', findings: 'The approved scope was inspected.' }], decisions: [], steps: ['Deliver the contract.'],
  verification: [{ criterion: 'behavior passes', check: 1 }], openQuestions: [{ question: 'A future question?', blocking: false, decideBy }],
})

test('decideBy invalido lista os valores aceitos em en e pt-BR e os validos continuam aceitos', () => {
  for (const decideBy of ['executor', 'user-now', { beforeTask: 'B' }, { beforePhase: 'F2' }])
    assert.doesNotThrow(() => assertTaskPlan(task, planWith(decideBy)))
  const pt = createTranslator(messages, 'pt-BR')
  const english = 'task plan openQuestions must contain question, blocking boolean, optional nonempty answer, and a valid optional decideBy (accepted values: "executor", "user-now", {"beforeTask":"<task id>"} or {"beforePhase":"<phase id>"})'
  const portuguese = 'openQuestions do plano da tarefa deve conter question, blocking booleano, answer preenchido opcional e decideBy opcional válido (valores aceitos: "executor", "user-now", {"beforeTask":"<id da tarefa>"} ou {"beforePhase":"<id da fase>"})'
  for (const decideBy of ['later', { beforeTask: '' }, { beforeStep: 'B' }, { beforeTask: 'B', beforePhase: 'F2' }, ['executor']]) {
    let message
    try { assertTaskPlan(task, planWith(decideBy)) } catch (error) { message = error.message }
    assert.equal(message, english, JSON.stringify(decideBy))
    assert.equal(pt(message), portuguese)
  }
})
