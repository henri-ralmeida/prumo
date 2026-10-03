import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runCoverage } from '../tools/run-coverage.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'prumo-coverage-runner-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'lib/app.mjs'), 'export const app = 1\n')
  return root
}

test('coleta preserva preloads, exige manifesto e propaga falhas dos testes', t => {
  const root = fixture(t), calls = []
  assert.equal(runCoverage({ root, collect: true, env: { NODE_OPTIONS: '--trace-warnings', PRUMO_TEST_CONCURRENCY: '4' },
    run: (...args) => { calls.push(args); return { status: 7 } } }), 7)
  const [command, args, options] = calls[0]
  assert.equal(command, process.execPath)
  assert.ok(args.includes('--check-coverage=false'))
  assert.ok(args.includes('--test-concurrency=4'))
  assert.match(options.env.NODE_OPTIONS, /^--trace-warnings --import=/)
  assert.equal(options.env.PRUMO_TEST_COVERAGE_FLUSH, '1')
  assert.equal(options.cwd, root)
  assert.equal(Object.keys(JSON.parse(readFileSync(join(root, '.test-output/coverage/source-manifest.json'), 'utf8'))).length, 1)
  const normal = []
  assert.equal(runCoverage({ root, env: {}, run: (...args) => { normal.push(args); return { status: 0 } } }), 0)
  assert.ok(normal[0][1].includes('--test-concurrency=1'))
  assert.ok(!normal[0][1].includes('--check-coverage=false'))
})

test('coleta recusa concorrencia invalida e conserva erro ou sinal do subprocesso', t => {
  const root = fixture(t)
  for (const value of ['0', '5', '1.5', 'invalid'])
    assert.throws(() => runCoverage({ root, env: { PRUMO_TEST_CONCURRENCY: value }, run: () => { throw new Error('nao deve iniciar') } }), /Concorrencia/)
  const error = new Error('spawn indisponivel')
  assert.throws(() => runCoverage({ root, env: {}, run: () => ({ error }) }), error)
  assert.throws(() => runCoverage({ root, env: {}, run: () => ({ signal: 'SIGTERM' }) }), /interrompida/)
  assert.equal(runCoverage({ root, env: {}, run: () => ({ status: null }) }), 1)
})

test('entrada publica de cobertura recusa configuracao invalida antes da suite', () => {
  const runner = fileURLToPath(new URL('../tools/run-coverage.mjs', import.meta.url))
  for (const args of [[], ['--collect']]) {
    const result = spawnSync(process.execPath, [runner, ...args], { env: { ...process.env, PRUMO_TEST_CONCURRENCY: '0' }, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Concorrencia/)
  }
})
