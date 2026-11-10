import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fixture } from './fixtures/approved-graph.mjs'
import { captureDelivery, checkDelivery } from '../scripts/delivery-evidence.mjs'
import { gitDirectoryEvidence } from '../scripts/git-directory-evidence.mjs'

for (const git of [false, true]) test(`escopo aprovado com muitos arquivos pequenos preserva inspeção completa ${git ? 'com Git' : 'sem Git'}`, t => {
  const f = fixture(t, { git, tasks: [{ id: 'T1', touches: ['out/'] }] })
  mkdirSync(join(f.project, 'out'))
  for (let index = 0; index < 262; index++) writeFileSync(join(f.project, 'out', `file-${String(index).padStart(3, '0')}.txt`), 'Resultado aprovado\n')
  if (git) { f.gitCommand('add', 'out'); f.gitCommand('commit', '-m', 'Record approved files') }
  const task = f.state().tasks.T1
  const baseline = captureDelivery(task, f.project)
  assert.equal(Object.keys(baseline.files).length, 262)
  task.attempts = [{ deliveryBaseline: baseline }]
  const state = f.state(); state.tasks.T1 = task
  writeFileSync(join(f.project, 'out/file-261.txt'), 'T1: metadado interno indevido\n')
  assert.throws(() => checkDelivery(state, task, f.project), /file-261|T1/)
  writeFileSync(join(f.project, 'out/file-261.txt'), 'Resultado aprovado\n')
  if (git) {
    f.skipTaskPlan(); f.ok('start', 'T1', '--agent', 'executor')
    assert.equal(Object.keys(f.state().tasks.T1.attempts.at(-1).deliveryBaseline.files).length, 262)
    f.ok('review', 'T1', '--agent', 'reviewer')
    f.ok('validate', 'T1', '--ok', '--cwd', f.project, '--evidence', 'Revisão independente de todos os arquivos e verificação funcional')
    f.ok('done', 'T1')
    assert.equal(f.state().tasks.T1.state, 'done')
  }
})

test('evidência de repositório aninhado captura muitos arquivos e mantém o limite de bytes', t => {
  const f = fixture(t, { git: true })
  const nested = join(f.project, 'vendor'); mkdirSync(nested)
  assert.equal(spawnSync('git', ['init', nested], { windowsHide: true }).status, 0)
  for (let index = 0; index < 262; index++) writeFileSync(join(nested, `file-${index}.txt`), 'Resultado aprovado\n')
  const before = gitDirectoryEvidence(f.project, 'vendor')
  assert.equal(before.untrackedFiles, 262)
  writeFileSync(join(nested, 'file-261.txt'), 'Resultado atualizado\n')
  const after = gitDirectoryEvidence(f.project, 'vendor')
  assert.equal(after.untrackedFiles, 262)
  assert.notEqual(after.digest, before.digest)
  assert.throws(() => gitDirectoryEvidence(f.project, 'vendor', { bytes: 8 * 1024 * 1024 }), /reading limit/)
})
