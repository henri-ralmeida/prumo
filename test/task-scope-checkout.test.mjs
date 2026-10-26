import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureScopeBaseline, scopeEvidenceRequirement, verifyTaskScope } from '../scripts/task-scope.mjs'

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'prumo-scope-checkout-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const git = (...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  const commit = () => { git('add', '.'); git('commit', '-m', 'fixture'); return git('rev-parse', 'HEAD') }
  return { cwd, git, commit, write: (path, text) => writeFileSync(join(cwd, path), text) }
}

test('contexto Git explica a recusa sem transformar mudança de commit em violação de escopo', t => {
  const f = repository(t)
  f.git('symbolic-ref', 'HEAD', 'refs/heads/origem')
  f.write('allowed', 'base'); f.write('other', 'base')
  const initialHead = f.commit(), baseline = captureScopeBaseline(f.cwd)
  assert.equal(baseline.head, initialHead)
  assert.equal(baseline.branch, 'origem')
  const task = { agent: 'executor', writeScope: 'files', touches: ['allowed'] }
  f.git('checkout', '-b', 'entrega')
  f.write('allowed', 'entrega aprovada')
  const currentHead = f.commit()
  const receipt = verifyTaskScope(task, baseline)
  assert.deepEqual(receipt.paths, ['allowed'])
  assert.deepEqual(receipt.gitContext, { baselineHead: initialHead, currentHead, baselineBranch: 'origem', currentBranch: 'entrega' })
  f.write('other', 'fora do contrato')
  const changed = captureScopeBaseline(f.cwd)
  assert.throws(() => verifyTaskScope(task, baseline), error => {
    assert.match(error.message, /outside approved touches: other/)
    assert.ok(error.message.includes(initialHead))
    assert.ok(error.message.includes(currentHead))
    assert.match(error.message, /baseline branch origem; current branch entrega/)
    assert.ok(error.message.includes(baseline.files.other))
    assert.ok(error.message.includes(changed.files.other))
    return true
  })
  f.git('rm', '-f', 'other')
  assert.throws(() => verifyTaskScope(task, baseline), /other: baseline [a-f0-9]{64}; current absent/)
})

test('somente leitura aceita checkout de entrega concorrente apenas com atribuição independente e registrada', t => {
  const f = repository(t)
  f.write('other', 'base')
  const initialHead = f.commit(), baseline = captureScopeBaseline(f.cwd)
  f.write('other', 'entrega de outra tarefa')
  const deliveryHead = f.commit()
  f.git('checkout', '--detach', initialHead)
  f.git('checkout', '--detach', deliveryHead)
  const task = { agent: 'executor', writeScope: 'read-only', touches: [] }
  assert.equal(captureScopeBaseline(f.cwd).branch, null)
  const evidence = { agent: 'reviewer', evidence: 'Inspeção do arquivo other atribui a entrega à tarefa concorrente registrada.' }
  assert.throws(() => verifyTaskScope(task, baseline), /outside approved touches: other/)
  assert.throws(() => verifyTaskScope(task, baseline, evidence), /outside approved touches: other/)
  assert.match(scopeEvidenceRequirement(task, baseline, [['other']]), /concurrent delivery scopes/)
  assert.throws(() => verifyTaskScope(task, baseline, { ...evidence, agent: 'executor' }, [['other']]), /outside/)
  const receipt = verifyTaskScope(task, baseline, evidence, [['other']])
  assert.deepEqual(receipt.excludedPaths, ['other'])
  assert.deepEqual(receipt.independentEvidence, evidence)
  f.write('own-write', 'escrita indevida da tarefa somente leitura')
  f.commit()
  assert.throws(() => verifyTaskScope(task, baseline, evidence, [['other']]), /outside approved touches: own-write/)
})

test('baseline legada e repositório sem commit mantêm verificação de arquivos sem exigir HEAD', t => {
  const f = repository(t)
  const baseline = captureScopeBaseline(f.cwd)
  assert.equal(baseline.method, 'git')
  assert.equal(baseline.head, null)
  const task = { agent: 'executor', writeScope: 'files', touches: ['allowed'] }
  f.write('allowed', 'entrega ainda sem commit')
  delete baseline.head
  delete baseline.branch
  const receipt = verifyTaskScope(task, baseline)
  assert.deepEqual(receipt.gitContext, { baselineHead: null, currentHead: null, baselineBranch: null,
    currentBranch: f.git('symbolic-ref', '--short', 'HEAD') })
  assert.deepEqual(receipt.paths, ['allowed'])
  f.write('other', 'escrita fora do escopo')
  assert.throws(() => verifyTaskScope(task, baseline), error => {
    assert.match(error.message, /outside approved touches: other/)
    assert.match(error.message, /baseline branch unavailable/)
    assert.match(error.message, /other: baseline absent; current [a-f0-9]{64}/)
    return true
  })
})
