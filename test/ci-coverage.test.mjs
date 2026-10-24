import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverageHtml } from '../.github/scripts/coverage-html.mjs'
import { runCiBatch } from '../.github/scripts/run-ci-batch.mjs'
import { runCoverageCommand } from '../tools/coverage.mjs'

test('runner real coleta JSON sem HTML e a consolidação mantém cobertura completa e gera a apresentação', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'prumo-ci-json-')))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const repo = fileURLToPath(new URL('..', import.meta.url))
  for (const directory of ['lib', 'scripts', 'test/fixtures']) mkdirSync(join(root, directory), { recursive: true })
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(root, 'lib/app.mjs'), 'export const valid = true\n')
  writeFileSync(join(root, 'test/flow.test.mjs'), 'import {valid} from "../lib/app.mjs"; if (!valid) throw new Error("recusado")\n')
  writeFileSync(join(root, 'test/fixtures/coverage-flush.mjs'), '')
  writeFileSync(join(root, '.c8rc.json'), JSON.stringify({ all: true, include: ['lib/**/*.mjs'], exclude: [], extension: ['.mjs'], reporter: ['json', 'json-summary', 'html'], 'reports-dir': '.test-output/coverage', 'temp-directory': '.test-output/coverage/tmp' }))
  let output = ''
  const env = { ...process.env, PRUMO_CI_TEST_FILES: '["test/flow.test.mjs"]', PRUMO_TEST_PARTITIONED: '1' }
  delete env.NODE_TEST_CONTEXT
  const result = runCiBatch({ root, env,
    run(executable, args, options) { const result = spawnSync(executable, args, { ...options, stdio: 'pipe', encoding: 'utf8' }); output += result.stdout + result.stderr; return result } })
  assert.equal(result, 0)
  assert.ok(existsSync(join(root, '.test-output/coverage/coverage-final.json')))
  assert.equal(existsSync(join(root, '.test-output/coverage/index.html')), false)
  assert.equal(runCoverageCommand('merge', join(root, '.test-output/coverage'), root), 0, output)
  const summary = JSON.parse(readFileSync(join(root, '.test-output/coverage-merged/coverage-summary.json'), 'utf8'))
  for (const metric of ['lines', 'functions', 'branches', 'statements']) assert.equal(summary[metric].pct, 100)
  coverageHtml(root)
  assert.ok(existsSync(join(root, '.test-output/coverage-merged/index.html')))
})

test('a consolidação gera HTML a partir dos contadores completos sem modificar os resultados', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'prumo-ci-html-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, '.test-output/coverage-merged')
  mkdirSync(directory, { recursive: true })
  const source = join(root, 'source.mjs')
  writeFileSync(source, 'export const valid = true\n')
  const position = { start: { line: 1, column: 0 }, end: { line: 1, column: 24 } }
  const data = { [source]: { path: source, statementMap: { 0: position }, fnMap: {}, branchMap: {}, s: { 0: 1 }, f: {}, b: {} } }
  const file = join(directory, 'coverage-final.json'), before = JSON.stringify(data)
  writeFileSync(file, before)
  coverageHtml(root)
  assert.ok(existsSync(join(directory, 'index.html')))
  assert.equal(readFileSync(file, 'utf8'), before)
  writeFileSync(file, 'inválido')
  assert.throws(() => coverageHtml(root))
})

test('workflow compartilha o mesmo candidato e mantém gates e diagnósticos sem duplicar relatórios', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n')
  assert.equal(workflow.match(/run: node \.github\/scripts\/prepare-ci-candidate\.mjs/g)?.length, 1)
  assert.equal(workflow.match(/name: ci-candidate/g)?.length, 3)
  assert.equal(workflow.match(/PRUMO_CI_CANDIDATE_SHA256: \$\{\{ needs\.prepare\.outputs\.candidate_sha256 \}\}/g)?.length, 2)
  assert.doesNotMatch(workflow, /run: npm pack/)
  assert.match(workflow, /run: bun run coverage:merge\n      - run: node \.github\/scripts\/coverage-html\.mjs/)
  assert.match(workflow, /needs: \[test, published, package\]/)
  assert.match(workflow, /!\.test-output\/coverage\/\*\*/)
  assert.match(workflow, /\.test-output\/coverage\/source-manifest.json/)
  const config = JSON.parse(readFileSync(join(repo, '.c8rc.json')))
  for (const key of ['lines', 'functions', 'branches', 'statements']) assert.equal(config[key], 100)
  assert.equal(config['per-file'], true)
})
