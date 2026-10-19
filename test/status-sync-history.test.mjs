import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './fixtures/approved-graph.mjs'

for (const lang of ['en', 'pt-BR']) test(`status explica mudancas de fase e fonte sem gravar estado (${lang})`, t => {
  const f = fixture(t, { phase: true, lang, tasks: [{ id: 'T1' }, { id: 'T2', phase: 'F2' }] })
  for (const phase of ['F1', 'F2']) {
    f.ok('begin-phase-discussion', phase)
    f.ok('finish-phase-discussion', phase, '--context', f.discovery(phase))
  }
  f.plan.tasks[0].phase = 'F2'
  f.plan.tasks[1].phase = 'F1'
  f.writePlan()
  f.ok('sync-plan', '--plan', f.source, '--confirm-invalidation')
  const at = JSON.parse(f.events().trim().split('\n').filter(line => JSON.parse(line).type === 'plan_sync').at(-1)).at
  const before = f.state(), events = f.events()
  const status = f.ok('status')
  assert.match(status, lang === 'en' ? /T1 moved from F1 to F2 at .*phase F1 round 1 refers to them/ : /T1 saíram de F1 para F2 em .*rodada 1 da fase F1 se refere a elas/)
  assert.match(status, lang === 'en' ? /T2 moved from F2 to F1/ : /T2 saíram de F2 para F1/)
  assert.ok(status.includes(at))
  assert.ok(status.includes(f.source))
  assert.match(status, lang === 'en' ? /WARNING: plan source is outside/ : /AVISO: a fonte do plano está fora/)
  assert.deepEqual(f.state(), before)
  assert.equal(f.events(), events)
  const canonical = join(f.root, '.specs/graph/plans')
  mkdirSync(canonical)
  const source = join(canonical, 'entrega.plan.json')
  writeFileSync(source, JSON.stringify(f.plan))
  f.ok('sync-plan', '--plan', source)
  const synced = f.ok('status')
  assert.ok(synced.includes(source))
  assert.doesNotMatch(synced, /WARNING: plan source is outside|AVISO: a fonte do plano está fora/)
  const path = join(f.root, '.specs/graph/audit/events.ndjson')
  writeFileSync(path, events + '\nregistro antigo incompleto\n' + JSON.stringify({ type: 'plan_sync', at }) + '\n')
  assert.match(f.ok('status'), /T1.*F1.*F2/)
  const legacy = f.state()
  delete legacy.plan.source
  f.importState(legacy)
  rmSync(path)
  assert.match(f.ok('status'), /T1/)
  assert.equal(readFileSync(join(f.root, '.specs/graph/audit/state.json'), 'utf8'), JSON.stringify(legacy))
})

