import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './fixtures/approved-graph.mjs'
import { assertReviewedDelivery } from '../scripts/delivery-evidence.mjs'

test('validacao recusa checkout anterior a entrega enviada a revisao e aceita o mesmo conteudo em outro commit', t => {
  const f = fixture(t, { git: true, tasks: [{ id: 'T1', touches: ['check.cjs', 'delivery.cjs'] }] })
  writeFileSync(join(f.project, 'delivery.cjs'), 'module.exports = "antes"\n')
  writeFileSync(join(f.project, 'check.cjs'), 'require("node:assert/strict").equal(require("./delivery.cjs"), "antes")\n')
  f.gitCommand('add', '.'); f.gitCommand('commit', '-m', 'Comportamento anterior')
  const baseline = f.gitCommand('rev-parse', 'HEAD').trim()
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor')
  const delivered = 'require("node:assert/strict").equal(require("./delivery.cjs"), "depois")\n'
  writeFileSync(join(f.project, 'delivery.cjs'), 'module.exports = "depois"\n')
  writeFileSync(join(f.project, 'check.cjs'), delivered)
  f.gitCommand('add', '.'); f.gitCommand('commit', '-m', 'Entrega')
  f.ok('review', 'T1', '--agent', 'revisor')
  f.ok('validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Conteudo atual inspecionado')
  const first = f.state().tasks.T1.validations.at(-1)
  f.gitCommand('checkout', '--detach', baseline)
  f.rejects(/Delivery changed since review/, 'validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Checkout antigo')
  assert.equal(f.state().tasks.T1.validations.at(-1).ok, false)
  assert.match(readFileSync(join(f.project, 'delivery.cjs'), 'utf8'), /antes/)
  assert.deepEqual(f.state().tasks.T1.validations.at(-2), first)
  writeFileSync(join(f.project, 'check.cjs'), delivered)
  writeFileSync(join(f.project, 'delivery.cjs'), 'module.exports = "depois"\n')
  f.ok('validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Mesmo conteudo ainda sem commit')
  f.gitCommand('add', '.'); f.gitCommand('commit', '-m', 'Conteudo equivalente')
  f.ok('validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Mesmo conteudo em novo commit')
  assert.equal(f.state().tasks.T1.attempts.length, 1)
})

test('entrega sem Git exige nova revisao explicita depois de mudar e preserva o historico', t => {
  const f = fixture(t, { tasks: [{ id: 'T1', touches: ['check.cjs'] }] })
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'revisor')
  const attempt = f.state().tasks.T1.attempts[0]
  writeFileSync(join(f.project, 'check.cjs'), "require('node:assert/strict').equal(2, 2)\n")
  f.rejects(/Delivery changed since review/, 'validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Conteudo mudou')
  f.ok('review-progress', 'T1', '--step', '1', '--agent', 'revisor')
  f.ok('validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Novo conteudo inspecionado')
  const current = f.state().tasks.T1
  assert.equal(current.attempts.length, 1)
  assert.equal(current.attempts[0].startedAt, attempt.startedAt)
  assert.equal(current.attempts[0].reviewProgressHistory[0].deliveryFingerprint, attempt.reviewProgress.deliveryFingerprint)
  assert.equal(current.validations.at(-2).ok, false)
  assert.equal(current.validations.at(-1).ok, true)
})

test('vinculo de entrega preserva tentativas legadas e exige identidade quando disponivel', () => {
  assert.doesNotThrow(() => assertReviewedDelivery({ state: 'running' }, { fingerprint: 'atual' }))
  assert.doesNotThrow(() => assertReviewedDelivery({ state: 'reviewing', attempts: [{}] }, { fingerprint: 'atual' }))
  assert.doesNotThrow(() => assertReviewedDelivery({ state: 'reviewing', attempts: [{ reviewDelivery: { fingerprint: null } }] }, { fingerprint: null }))
  assert.doesNotThrow(() => assertReviewedDelivery({ state: 'running', attempts: [{ reviewDelivery: { fingerprint: 'anterior' } }] }, { fingerprint: 'atual' }))
  assert.doesNotThrow(() => assertReviewedDelivery({ state: 'reviewing', attempts: [{ reviewDelivery: { fingerprint: 'atual' } }] }, { fingerprint: 'atual' }))
  assert.throws(() => assertReviewedDelivery({ state: 'reviewing', attempts: [{ reviewProgress: { deliveryFingerprint: 'anterior' } }] }, { fingerprint: 'atual' }), /Delivery changed since review/)
})

test('contrato textual de inspecao vincula a entrega e permite reabertura publica da revisao', t => {
  const f = fixture(t, { tasks: [{ id: 'T1', touches: ['check.cjs'], validation: 'Inspecionar o conteudo aprovado',
    validationMode: 'inspection', inspectionReason: 'Revisao documental sem alteracao de comportamento' }] })
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'revisor')
  assert.equal(f.state().tasks.T1.attempts[0].reviewProgress, undefined)
  writeFileSync(join(f.project, 'check.cjs'), '// Documento atualizado\n')
  f.rejects(/Delivery changed since review/, 'validate', 'T1', '--ok', '--evidence', 'Conteudo mudou')
  f.ok('block', 'T1', '--reason', 'Nova inspecao necessaria')
  f.ok('unblock', 'T1', '--reviewer', 'novo-revisor')
  f.ok('validate', 'T1', '--ok', '--evidence', 'Novo documento inspecionado independentemente')
  const task = f.state().tasks.T1
  assert.equal(task.attempts.length, 1)
  assert.equal(task.validations.at(-1).ok, true)
  assert.equal(task.blockHistory.length, 1)
})

for (const mode of ['functional', 'inspection']) test(`binario equivalente preserva revisao ${mode} e bytes diferentes exigem nova inspecao`, t => {
  const f = fixture(t, { tasks: [{ id: 'T1', touches: ['delivery.bin'], validationMode: mode,
    ...(mode === 'inspection' ? { inspectionReason: 'Conferir documento binario sem alterar comportamento' } : {}) }] })
  const path = join(f.project, 'delivery.bin'), bytes = Buffer.alloc(1024 * 1024 + 1)
  writeFileSync(path, bytes)
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'revisor')
  if (mode === 'inspection') f.ok('review-progress', 'T1', '--step', '1', '--agent', 'revisor')
  renameSync(path, join(f.project, 'previous.bin'))
  writeFileSync(path, bytes)
  f.ok('validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Mesmo conteudo binario inspecionado')
  bytes[bytes.length - 1] = 1
  writeFileSync(path, bytes)
  f.rejects(/Delivery changed since review|Current review progress is missing or stale/, 'validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Conteudo binario mudou')
  if (mode === 'functional') assert.equal(f.state().tasks.T1.validations.at(-1).ok, false)
})

test('progresso legado sem identidade semantica usa vinculo anterior ate nova revisao', t => {
  const f = fixture(t, { tasks: [{ id: 'T1', touches: ['check.cjs'], validationMode: 'inspection',
    inspectionReason: 'Inspecao documental de contrato legado' }] })
  f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor')
  f.ok('review', 'T1', '--agent', 'revisor')
  f.ok('review-progress', 'T1', '--step', '1', '--agent', 'revisor')
  const legacy = f.state(), attempt = legacy.tasks.T1.attempts[0]
  delete attempt.reviewDelivery
  delete attempt.reviewProgress.contentFingerprint
  f.importState(legacy)
  f.ok('validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Conteudo legado ainda atual')
  writeFileSync(join(f.project, 'check.cjs'), '// Novo documento\n')
  f.rejects(/Current review progress is missing or stale/, 'validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Conteudo mudou')
  f.ok('review-progress', 'T1', '--step', '1', '--agent', 'revisor')
  f.ok('validate', 'T1', '--cwd', f.project, '--ok', '--evidence', 'Nova inspecao preserva historia')
  assert.ok(f.state().tasks.T1.attempts[0].reviewProgress.contentFingerprint)
})
