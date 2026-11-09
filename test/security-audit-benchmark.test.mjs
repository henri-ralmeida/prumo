import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scoreReport, validateReport } from '../verification/security-audit/score.mjs'
import { scoreCvss4 } from '../scripts/cvss4.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const bench = path.join(root, 'verification', 'security-audit')
const score = path.join(bench, 'score.mjs')
const targetsDir = path.join(bench, 'targets')
const keyOf = (name) => JSON.parse(fs.readFileSync(path.join(bench, 'answer-key', `${name}.json`), 'utf8'))
const targets = fs.readdirSync(targetsDir).sort()

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-bench-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function finding(id, severity, cwe, title, extra = {}) {
  return { id, severity, title, cwe, taskRefs: ['T1'], attackPath: `path for ${title}`, evidence: 'observed', reproduction: 'curl', remediation: 'fix', ...extra }
}

function report(findings) {
  return { summary: 'benchmark', environment: 'local 127.0.0.1', tools: ['curl'], findings }
}

function perfectReport(name) {
  return report(keyOf(name).vulnerabilities.map((v, i) => finding(`F${i + 1}`, v.severity, v.cwe, `Issue involving ${v.matchHints[0]}`, { taskRefs: v.taskRefs })))
}

function run(args) {
  const r = spawnSync(process.execPath, [score, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function scoreOf(t, name, rep) {
  let parsed
  try {
    parsed = typeof rep === 'string' ? JSON.parse(rep) : rep
  } catch {
    return { code: 2, result: null }
  }
  if (validateReport(parsed).length) return { code: 2, result: null }
  return { code: 0, result: scoreReport(keyOf(name), parsed) }
}

const vulnerable = targets.filter((n) => keyOf(n).kind === 'vulnerable')

test('every target has an answer key and the layout is complete', () => {
  assert.equal(targets.length, 5)
  for (const name of targets) {
    for (const file of ['README.md', 'prumo-run.json', 'server.mjs', 'app.test.mjs']) {
      assert.ok(fs.existsSync(path.join(targetsDir, name, file)), `${name}/${file}`)
    }
    const key = keyOf(name)
    assert.equal(key.target, name)
    const run = JSON.parse(fs.readFileSync(path.join(targetsDir, name, 'prumo-run.json'), 'utf8'))
    assert.ok(run.tasks.length >= 3 && run.tasks.length <= 6)
    for (const v of key.vulnerabilities) for (const ref of v.taskRefs) assert.ok(run.tasks.some((task) => task.id === ref), `${name}: ${ref}`)
  }
})

test('targets stay blind: no answer-key reference or revealing vocabulary, loopback only', () => {
  const banned = /vulnerab|inject|\bidor\b|ssrf|bypass|insecure|todo security|\bcwe\b|answer-key|exploit/i
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  for (const file of walk(targetsDir)) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), banned, path.relative(bench, file))
  }
  for (const name of targets) {
    const server = fs.readFileSync(path.join(targetsDir, name, 'server.mjs'), 'utf8')
    assert.match(server, /listen\(Number\(process\.env\.PORT \|\| 0\), '127\.0\.0\.1'/)
    assert.doesNotMatch(server, /0\.0\.0\.0/)
  }
})

for (const name of vulnerable) {
  test(`perfect report for ${name} scores recall 1 with exact severities`, (t) => {
    const { code, result } = scoreOf(t, name, perfectReport(name))
    assert.equal(code, 0)
    assert.equal(result.recall, 1)
    assert.equal(result.precision, 1)
    assert.equal(result.missed.length, 0)
    assert.equal(result.falsePositives.length, 0)
    assert.equal(result.severity.exact, result.planted)
  })
}

test('empty report scores recall 0 on a vulnerable target and exits 0', (t) => {
  const { code, result } = scoreOf(t, 'invoice-api', report([]))
  assert.equal(code, 0)
  assert.equal(result.recall, 0)
  assert.equal(result.missed.length, 3)
  assert.equal(result.precision, null)
  const file = path.join(tmp(t), 'report.json')
  fs.writeFileSync(file, JSON.stringify(report([])))
  const cli = run(['--target', 'invoice-api', '--report', file, '--json'])
  assert.equal(cli.code, 0)
  assert.equal(JSON.parse(cli.out).results[0].recall, 0)
})

test('control target: empty report is clean, medium+ finding is a false positive', (t) => {
  assert.equal(scoreOf(t, 'notes-clean', report([])).result.falsePositives.length, 0)
  const noisy = report([
    finding('F1', 'high', 'CWE-89', 'SQL injection in /notes search'),
    finding('F2', 'low', 'CWE-1104', 'Outdated dependency policy'),
    finding('F3', 'low', 'CWE-204', 'User enumeration on /auth/register'),
    finding('F4', 'high', 'CWE-204', 'User enumeration on /auth/register rated too high')
  ])
  const { result } = scoreOf(t, 'notes-clean', noisy)
  assert.deepEqual(result.falsePositives.map((f) => f.id).sort(), ['F1', 'F4'])
  assert.deepEqual(result.acceptable.map((f) => f.id), ['F3'])
  assert.deepEqual(result.extras.map((f) => f.id), ['F2'])
  assert.equal(result.recall, null)
})

test('CWE family matches, unrelated CWE with the same hint does not', (t) => {
  const family = scoreOf(t, 'invoice-api', report([finding('F1', 'medium', 'CWE-285', 'Missing check on /invoices/:id')]))
  assert.equal(family.result.detected[0].key, 'invoice-read-without-owner-check')
  assert.equal(family.result.severity.withinOne, 1)
  assert.equal(family.result.severity.exact, 0)
  const wrong = scoreOf(t, 'invoice-api', report([finding('F1', 'high', 'CWE-79', 'Reflected markup on /invoices/:id')]))
  assert.equal(wrong.result.detected.length, 0)
  assert.equal(wrong.result.falsePositives.length, 1)
  const noHint = scoreOf(t, 'invoice-api', report([finding('F1', 'high', 'CWE-639', 'Something unrelated', { attackPath: 'x', evidence: 'y' })]))
  assert.equal(noHint.result.detected.length, 0)
})

test('a second finding for an already detected item is a duplicate, not a false positive', (t) => {
  const { result } = scoreOf(t, 'invoice-api', report([
    finding('F1', 'high', 'CWE-639', 'Invoice read on /invoices/:id'),
    finding('F2', 'high', 'CWE-639', 'Same flaw seen again on /invoices/:id')
  ]))
  assert.equal(result.detected.length, 1)
  assert.deepEqual(result.duplicates.map((d) => d.id), ['F2'])
  assert.equal(result.falsePositives.length, 0)
})

test('invalid reports and usage errors exit 2', (t) => {
  const bad = [
    '{not json',
    JSON.stringify({ summary: 's', environment: 'e' }),
    JSON.stringify(report([finding('F1', 'severe', 'CWE-89', 'x')])),
    JSON.stringify(report([finding('F1', 'high', 'sql', 'x')])),
    JSON.stringify(report([{ ...finding('F1', 'high', 'CWE-89', 'x'), taskRefs: 'T1' }])),
    JSON.stringify(report([finding('F1', 'high', 'CWE-89', 'x'), finding('F1', 'low', 'CWE-89', 'y')])),
    JSON.stringify({ ...report([]), tools: 'curl' })
  ]
  for (const content of bad) assert.equal(scoreOf(t, 'invoice-api', content).code, 2, content)
  const file = path.join(tmp(t), 'report.json')
  fs.writeFileSync(file, JSON.stringify({ summary: 's' }))
  assert.equal(run(['--target', 'invoice-api', '--report', file]).code, 2)
  assert.equal(run(['--target', 'invoice-api']).code, 2)
})

test('--all scores a directory of reports and prints human output', (t) => {
  const dir = tmp(t)
  fs.writeFileSync(path.join(dir, 'invoice-api.json'), JSON.stringify(perfectReport('invoice-api')))
  fs.writeFileSync(path.join(dir, 'notes-clean.json'), JSON.stringify(report([finding('F1', 'high', 'CWE-89', 'SQL issue')])))
  const json = JSON.parse(run(['--all', dir, '--json']).out)
  assert.equal(json.results.length, 2)
  assert.equal(json.skipped.length, 3)
  assert.equal(json.summary.detected, 3)
  assert.equal(json.summary.controlFalsePositives, 1)
  const human = run(['--all', dir])
  assert.equal(human.code, 0)
  assert.match(human.out, /Target invoice-api/)
  assert.match(human.out, /recall: 100%/)
  assert.match(human.out, /No report for: /)
  fs.writeFileSync(path.join(dir, 'coupon-checkout.json'), '{}')
  assert.equal(run(['--all', dir]).code, 2)
})

function runTargetTests(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', 'app.test.mjs'], { cwd: path.join(targetsDir, name), stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    child.on('close', (code) => resolve({ code, output }))
  })
}

test('functional tests of every target pass', async () => {
  const results = await Promise.all(targets.map(async (name) => ({ name, ...(await runTargetTests(name)) })))
  for (const r of results) assert.equal(r.code, 0, `${r.name}\n${r.output}`)
})

const OFFICIAL = { 'profile-update-assigns-role': [8.6, 'high'], 'export-filename-reaches-shell': [9.3, 'critical'], 'callback-address-unrestricted': [6.3, 'high'], 'session-token-written-to-log': [5.6, 'high'], 'token-accepts-unsigned-header': [9.3, 'critical'] }

test('answer keys carry the official CVSS v4.0 score, and the severity follows the band or a declared class floor', () => {
  const band = (score) => (score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'info')
  const seen = new Set()
  for (const name of vulnerable) {
    for (const v of keyOf(name).vulnerabilities) {
      seen.add(v.key)
      assert.match(v.cvss.vector, /^CVSS:4\.0\/AV:[NALP]\/AC:[LH]\/AT:[NP]\/PR:[NLH]\/UI:[NPA]\/VC:[HLN]\/VI:[HLN]\/VA:[HLN]\/SC:[HLN]\/SI:[HLN]\/SA:[HLN]$/, v.key)
      assert.equal(scoreCvss4(v.cvss.vector).score, v.cvss.score, `${v.key}: the stored score is the one the offline calculator derives`)
      assert.ok(v.acceptedSeverities.includes(v.severity), `${v.key}: the expected severity is accepted`)
      assert.equal(Object.hasOwn(v, 'cvssEnvironmental'), false, `${v.key}: no pending environmental score`)
      if (v.severityFloor) assert.ok(['ssrf-internal', 'rce', 'auth-bypass', 'credential-exposure'].includes(v.severityFloor), v.key)
      else assert.equal(v.severity, band(v.cvss.score), `${v.key}: severity follows the band of ${v.cvss.score}`)
    }
  }
  for (const [key, [scoreValue, severity]] of Object.entries(OFFICIAL)) {
    const entry = vulnerable.flatMap((name) => keyOf(name).vulnerabilities).find((v) => v.key === key)
    assert.deepEqual([entry.cvss.score, entry.severity], [scoreValue, severity], key)
  }
  const ssrf = keyOf('webhook-relay').vulnerabilities.find((v) => v.key === 'callback-address-unrestricted')
  assert.deepEqual([ssrf.cvss.score, ssrf.severity, ssrf.severityFloor, ssrf.acceptedSeverities], [6.3, 'high', 'ssrf-internal', ['high']])
  assert.deepEqual(keyOf('report-exporter').vulnerabilities.find((v) => v.key === 'export-filename-reaches-shell').acceptedSeverities, ['critical', 'high'])
  assert.deepEqual(keyOf('webhook-relay').vulnerabilities.find((v) => v.key === 'session-token-written-to-log').acceptedSeverities, ['high'], 'the credential floor needs no medium alternative')
  assert.ok(['CWE-602', 'CWE-915'].every((cwe) => [keyOf('coupon-checkout').vulnerabilities.find((v) => v.key === 'client-supplied-unit-price-trusted')].some((v) => v.cwe === cwe || v.cweFamily.includes(cwe))), 'client-trusted price accepts both CWE-602 and CWE-915')
  assert.equal(seen.size, 12)
})

test('acceptedSeverities count as exact and the CVSS difference is reported when the report scores a finding', (t) => {
  const shell = finding('F1', 'high', 'CWE-78', 'Filename reaches exec on /exports', { cvss: { version: '4.0', vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N', score: 8.7, scoreSource: 'estimated' } })
  const { result } = scoreOf(t, 'report-exporter', report([shell]))
  assert.deepEqual([result.detected[0].exact, result.detected[0].severityDelta, result.detected[0].scoreDelta, result.severity.exact], [true, -1, -0.6, 1])
  const wrong = scoreOf(t, 'report-exporter', report([finding('F1', 'medium', 'CWE-78', 'Filename reaches exec on /exports')])).result
  assert.deepEqual([wrong.detected[0].exact, wrong.severity.exact, wrong.severity.withinOne, wrong.detected[0].scoreDelta], [false, 0, 0, undefined])
  const medium = scoreOf(t, 'webhook-relay', report([finding('F1', 'medium', 'CWE-532', 'Authorization header written to access.log')])).result
  assert.equal(medium.detected[0].exact, false, 'a reusable credential in a log is high through the credential-exposure floor, not medium')
  const high = scoreOf(t, 'webhook-relay', report([finding('F1', 'high', 'CWE-532', 'Authorization header written to access.log')])).result
  assert.equal(high.detected[0].exact, true)
  const ssrfMedium = scoreOf(t, 'webhook-relay', report([finding('F1', 'medium', 'CWE-918', 'Callback address reaches internal hosts')])).result
  assert.equal(ssrfMedium.detected[0].exact, false, 'an SSRF with proven internal reach is high through the class floor')
  const environmental = finding('F1', 'high', 'CWE-918', 'Callback address reaches internal hosts', { cvss: { version: '4.0', vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N', score: 6.3, scoreSource: 'calculator', environmental: { vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N/CR:H', score: 6.3 } }, severityFloor: { class: 'ssrf-internal', evidence: 'listener nonce returned' } })
  assert.equal(scoreOf(t, 'webhook-relay', report([environmental])).result.detected[0].scoreDelta, 0)
})

test('the report format 2 fields are validated when present and format 1 stays valid', () => {
  const ok = (extra) => validateReport(report([finding('F1', 'high', 'CWE-89', 'x', extra)]))
  const cvss = { version: '4.0', vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N', score: 8.7, scoreSource: 'calculator' }
  assert.deepEqual(validateReport(report([finding('F1', 'high', 'CWE-89', 'x')])), [], 'format 1')
  assert.deepEqual(ok({ cvss, wstg: ['WSTG-INPV-05'], chainedWith: ['F2'], severityRationale: 'r', location: 'a:1' }), [])
  assert.deepEqual(validateReport({ ...report([]), revalidates: ['F1'] }), [])
  const medium = { ...cvss, vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N' }
  assert.deepEqual(ok({ cvss: medium, severityFloor: { class: 'ssrf-internal', evidence: 'proof' } }), [], 'a floor lifts a medium score to high')
  assert.match(ok({ cvss: medium })[0], /does not match the CVSS band medium/)
  assert.deepEqual(ok({ cvss: { version: '4.0', vector: cvss.vector } }), [], 'the score is optional: the calculator derives it')
  assert.match(ok({ cvss: medium, severityFloor: { class: 'xss', evidence: 'proof' } })[0], /severityFloor must have a class/)
  assert.match(ok({ cvss: { ...cvss, vector: 'AV:N' } })[0], /cvss must have a CVSS:4\.0 vector/)
  assert.match(ok({ cvss: { ...cvss, score: 11 } })[0], /score from 0\.0 to 10\.0/)
  assert.match(ok({ cvss: { ...cvss, vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N' } })[0], /not a valid CVSS:4\.0 vector/)
  assert.match(ok({ wstg: 'x' })[0], /wstg must be an array/)
  assert.match(ok({ chainedWith: [1] })[0], /chainedWith must be an array/)
  assert.match(ok({ severityRationale: 1 })[0], /severityRationale must be a string/)
  assert.match(validateReport({ ...report([]), revalidates: 'F1' })[0], /revalidates must be an array/)
})
