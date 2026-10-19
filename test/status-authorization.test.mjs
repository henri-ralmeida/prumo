import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixtures/approved-graph.mjs'

for (const lang of ['en', 'pt-BR']) test(`status pede autorizacao somente para trabalho nao terminado (${lang})`, t => {
  const f = fixture(t, { lang, tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] })
  const current = f.state()
  current.tasks.T1.state = 'done'
  current.tasks.T2.state = 'skipped'
  for (const task of Object.values(current.tasks)) delete task.executionAuthorization
  f.importState(current)
  const row = (status, id) => status.split('\n').find(line => new RegExp(`^  ${id} `).test(line))
  const status = f.ok('status')
  const label = lang === 'en' ? 'authorization required' : 'autorização necessária'
  assert.ok(row(status, 'T3').includes(label))
  for (const id of ['T1', 'T2']) assert.ok(!row(status, id).includes(label))
  delete current.authorizations
  f.importState(current)
  const unscoped = f.ok('status')
  const missing = lang === 'en' ? 'no authorization scope recorded' : 'sem escopo de autorização registrado'
  assert.ok(row(unscoped, 'T3').includes(missing))
  for (const id of ['T1', 'T2']) assert.ok(!row(unscoped, id).includes(missing))
  f.ok('authorize', '--scope', 'tasks:T3', '--confirmed-by-user')
  assert.match(row(f.ok('status'), 'T3'), lang === 'en' ? /authorized auto/ : /autorizada auto/)
})

