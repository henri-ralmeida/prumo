import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(repo, '.github/scripts/published-update-summary.ps1')

function assertUpdateDiagnostics(source) {
  // A publicação dos diagnósticos deve acompanhar quem executa as atualizações, independentemente do nome do job.
  const jobs = source.replaceAll('\r\n', '\n').split(/^  [\w-]+:[ \t]*$/m).slice(1)
    .filter(job => /^\s*PRUMO_TEST_SUITE: published[ \t]*$/m.test(job))
  assert.ok(jobs.length, 'A matriz deve executar os cenários de atualização publicados')
  for (const job of jobs) {
    const steps = job.split(/^      - /m).slice(1)
    const summary = steps.find(step => /^\s*run: .*published-update-summary\.ps1 /m.test(step))
    assert.ok(summary, 'O job de atualização deve publicar seu resumo')
    assert.match(summary, /^\s*if: always\(\)[ \t]*$/m)
    assert.match(summary, /^\s*shell: pwsh[ \t]*$/m)
    assert.match(summary, /-ResultsPath "\.test-output\/published-update-results\.json"/)
    const artifact = steps.find(step => /^uses: actions\/upload-artifact@/m.test(step) && /^\s*name: verification-/m.test(step))
    assert.ok(artifact, 'O job deve preservar os resultados completos no artefato de verificação')
    assert.match(artifact, /^\s*if: always\(\)[ \t]*$/m)
    assert.match(artifact, /^\s*path: \|\n\s*\.test-output\//m)
  }
}

test('jobs de atualização publicam o resumo mesmo quando o teste falha', () => {
  assertUpdateDiagnostics(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8'))
})

test('verificação aceita renomear o job e recusa perder diagnósticos após falha', () => {
  const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n')
  assertUpdateDiagnostics(workflow.replace(/^  published:/m, '  historical-updates:').replaceAll('\n', '\r\n'))
  for (const invalid of [
    workflow.replace('always()\n        shell: pwsh', 'success()\n        shell: pwsh'),
    workflow.replace('published-update-results.json', 'published-update-results-wrong.json'),
    workflow.replace('name: verification-published-', 'name: omitted-published-'),
  ]) assert.throws(() => assertUpdateDiagnostics(invalid), assert.AssertionError)
})

test('resumo identifica versão e erro, preserva resultados e suporta sucesso ou interrupção', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'prumo-update-summary-'))
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, '.test-output'))
  const resultsPath = join(root, '.test-output/published-update-results-1.json')
  const summary = join(root, 'job-summary.md')
  const run = () => {
    const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-ResultsPath', resultsPath], {
      cwd: root, env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return readFileSync(join(root, '.test-output/published-update-summary.md'), 'utf8')
  }
  assert.match(run(), /Nenhum resultado de versão foi gravado/)
  const results = [
    { version: '1.3.6', status: 1, candidateVersion: '2.11.1', output: 'iniciando\nError: EPERM rename dashboard.json.tmp <arquivo>\nfim' },
    { version: '1.3.8', status: 0, candidateVersion: '2.11.1', output: 'sucesso' },
    { version: '1.3.9', status: null, candidateVersion: '2.11.1', output: '' },
    { version: '1.4.0', status: 1, candidateVersion: '2.11.1', output: 'detalhe adicional'.repeat(500) },
  ]
  writeFileSync(resultsPath, JSON.stringify(results))
  const before = readFileSync(resultsPath, 'utf8')
  const report = run()
  assert.match(report, /Versões verificadas: 4; falhas: 3/)
  assert.match(report, /npm 1\.3\.6 → 2\.11\.1/)
  assert.match(report, /Error: EPERM rename dashboard\.json\.tmp &lt;arquivo&gt;/)
  assert.doesNotMatch(report, /### npm 1\.3\.8|iniciando|\nfim/)
  assert.match(report, /Processo encerrado sem sa&#237;da; status: /)
  assert.match(report, /adicional[^\n]*…/)
  assert.ok(report.length < 5000)
  assert.ok(readFileSync(summary, 'utf8').trimEnd().endsWith(report.trimEnd()))
  assert.equal(readFileSync(resultsPath, 'utf8'), before)
  writeFileSync(resultsPath, JSON.stringify([results[1]]))
  const success = run()
  assert.match(success, /Versões verificadas: 1; falhas: 0/)
  assert.doesNotMatch(success, /### npm|EPERM/)
  writeFileSync(resultsPath, JSON.stringify([]))
  assert.match(run(), /Versões verificadas: 0; falhas: 0/)
})
