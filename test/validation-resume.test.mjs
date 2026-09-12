import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runValidation, assertValidation, validationContract } from '../scripts/validation.mjs'

test('only explicit static checks resume in an unchanged Git workspace', async t => {
  const root = mkdtempSync(join(tmpdir(), 'prumo-validation-resume-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const counters = join(root, 'counters')
  mkdirSync(repo)
  mkdirSync(counters)
  writeFileSync(join(repo, 'check.cjs'), `const fs=require('node:fs');const p=require('node:path');const [name,fail]=process.argv.slice(2);const count=p.join(process.env.COUNTERS,name);fs.appendFileSync(count,'x');const marker=p.join(process.env.COUNTERS,'failed');if(fail==='once'&&!fs.existsSync(marker)){fs.writeFileSync(marker,'1');process.exit(7)}\n`)
  writeFileSync(join(repo, 'tracked.txt'), 'unchanged\n')
  for (const args of [
    ['init'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Prumo Test'],
    ['add', '.'], ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  const env = { COUNTERS: counters }
  const task = {
    attempts: [{}], validations: [{ by: 'review', agent: 'reviewer' }], contractRevision: 0, stateRevision: 0,
    validation: [
      { kind: 'static', cacheable: true, env, run: 'node check.cjs static-one', expect: 'passes' },
      { kind: 'functional', env, run: 'node check.cjs functional once', expect: 'observable behavior' },
      { kind: 'static', cacheable: true, env, run: 'node check.cjs static-two', expect: 'passes' },
    ],
  }
  const progress = []
  const first = { ...await runValidation(task, repo, null, event => progress.push(event)), by: 'review', agent: 'reviewer', attempt: 1, evidence: 'first review' }
  assert.deepEqual(progress.map(e => [e.current, e.status]), [[1, 'started'], [1, 'passed'], [2, 'started'], [2, 'failed']])
  progress.length = 0
  assert.throws(() => assertValidation(task, first), /validation check 2\/3 \(functional\) failed: exit 7/)
  const second = { ...await runValidation(task, repo, first, event => progress.push(event)), by: 'review', agent: 'reviewer', attempt: 1, evidence: 'second review' }
  assert.deepEqual(progress.map(e => [e.current, e.status]), [[1, 'reused'], [2, 'started'], [2, 'passed'], [3, 'started'], [3, 'passed']])
  assert.doesNotThrow(() => assertValidation(task, second))
  assert.equal(readFileSync(join(counters, 'static-one'), 'utf8'), 'x')
  assert.equal(readFileSync(join(counters, 'functional'), 'utf8'), 'xx')
  assert.equal(readFileSync(join(counters, 'static-two'), 'utf8'), 'x')
  assert.ok(second.checks[0].reusedAt)
  assert.equal(second.checks[1].reusedAt, undefined)

  writeFileSync(join(repo, 'tracked.txt'), 'changed\n')
  const third = { ...await runValidation(task, repo, second), by: 'review', agent: 'reviewer', attempt: 1, evidence: 'changed workspace' }
  assert.doesNotThrow(() => assertValidation(task, third))
  assert.equal(readFileSync(join(counters, 'static-one'), 'utf8'), 'xx')
  assert.equal(readFileSync(join(counters, 'functional'), 'utf8'), 'xxx')
  assert.equal(readFileSync(join(counters, 'static-two'), 'utf8'), 'xx')
})

test('functional checks cannot be marked cacheable', () => {
  const task = { validation: [{ kind: 'functional', cacheable: true, run: 'node test.cjs', expect: 'behavior' }] }
  assert.throws(() => validationContract(task), /only static validation steps can be cacheable/)
})
