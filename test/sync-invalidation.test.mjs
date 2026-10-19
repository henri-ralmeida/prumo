import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './fixtures/approved-graph.mjs'

for (const lang of ['en', 'pt-BR']) test(`sincronizacao exige aceite antes de invalidar discussao concluida (${lang})`, t => {
  for (const propose of [false, true]) {
    const f = fixture(t, { phase: true, lang })
    f.ok('begin-phase-discussion', 'F1')
    f.ok('finish-phase-discussion', 'F1', '--context', f.discovery('F1'))
    f.plan.tasks[0].title = 'Entrega corrigida'
    f.writePlan()
    const before = f.state(), events = f.events()
    const flags = propose ? ['--propose'] : []
    f.ok('sync-plan', '--plan', f.source, ...flags, '--dry-run')
    const refused = f.rejects(/--confirm-invalidation/, 'sync-plan', '--plan', f.source, ...flags)
    assert.match(refused, /F1/)
    assert.deepEqual(f.state(), before)
    assert.equal(f.events(), events)
    assert.equal(existsSync(join(f.root, '.specs/graph/audit/state.pre-sync.json')), false)
    f.ok('sync-plan', '--plan', f.source, ...flags, '--confirm-invalidation')
    assert.equal(f.state().tasks.T1.title, 'Entrega corrigida')
    assert.ok(f.state().phaseWorkflows.F1.contractConfirmationRequired)
    assert.equal(f.state().phaseWorkflows.F1.discussionAttempts[0].roundId, before.phaseWorkflows.F1.discussionAttempts[0].roundId)
    const fresh = fixture(t, { phase: true, lang })
    fresh.plan.tasks[0].title = 'Entrega atualizada'
    fresh.writePlan()
    fresh.ok('sync-plan', '--plan', fresh.source, ...flags)
    assert.equal(fresh.state().tasks.T1.title, 'Entrega atualizada')
  }
})
