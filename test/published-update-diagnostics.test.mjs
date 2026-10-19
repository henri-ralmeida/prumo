import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(repo, '.github/scripts/published-update-summary.ps1')

test('jobs de atualização publicam o resumo mesmo quando o teste falha', () => {
  const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8').split('  published-windows:')[1].split('  coverage:')[0]
  assert.match(workflow, /if: always\(\)\n        shell: pwsh\n        run: .*published-update-summary\.ps1 -ResultsPath "\.test-output\/published-update-results-\$\{\{ matrix\.shard \}\}\.json"/)
  assert.match(workflow, /name: verification-windows-published[\s\S]*path: \|\n            \.test-output\//)
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
