#!/usr/bin/env node
// Scores a security-audit report against the answer key of a benchmark target.
//   node verification/security-audit/score.mjs --target <name> --report <report.json> [--json]
//   node verification/security-audit/score.mjs --all <dir-with-<target>.json-reports> [--json]
// Scoring is a measurement, not a gate: exit 0 for any valid report, exit 2 for an invalid report or usage.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cvssBand, SEVERITY_FLOOR_CLASSES } from '../../scripts/security-audit.mjs'
import { scoreCvss4 } from '../../scripts/cvss4.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const KEY_DIR = path.join(here, 'answer-key')
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical']
const rank = (severity) => SEVERITIES.indexOf(severity)

class UsageError extends Error {}

export function validateReport(report) {
  const errors = []
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0
  if (!isObject(report)) return ['report must be a JSON object']
  if (!nonEmpty(report.summary)) errors.push('summary must be a non-empty string')
  if (!nonEmpty(report.environment)) errors.push('environment must be a non-empty string')
  if (report.tools !== undefined && !(Array.isArray(report.tools) && report.tools.every((t) => typeof t === 'string'))) {
    errors.push('tools must be an array of strings when present')
  }
  if (report.revalidates !== undefined && !(Array.isArray(report.revalidates) && report.revalidates.every((id) => typeof id === 'string'))) errors.push('revalidates must be an array of finding ids when present')
  if (!Array.isArray(report.findings)) return [...errors, 'findings must be an array']
  const ids = new Set()
  report.findings.forEach((finding, i) => {
    const at = `findings[${i}]`
    if (!isObject(finding)) return errors.push(`${at} must be an object`)
    if (!nonEmpty(finding.id)) errors.push(`${at}.id must be a non-empty string`)
    else if (ids.has(finding.id)) errors.push(`${at}.id "${finding.id}" is duplicated`)
    else ids.add(finding.id)
    if (!SEVERITIES.includes(finding.severity)) errors.push(`${at}.severity must be one of ${SEVERITIES.join('|')}`)
    if (!nonEmpty(finding.title)) errors.push(`${at}.title must be a non-empty string`)
    if (typeof finding.cwe !== 'string' || !/^CWE-\d+$/.test(finding.cwe)) errors.push(`${at}.cwe must look like "CWE-89"`)
    if (!Array.isArray(finding.taskRefs) || !finding.taskRefs.every((t) => typeof t === 'string')) errors.push(`${at}.taskRefs must be an array of task ids`)
    for (const field of ['attackPath', 'evidence', 'reproduction', 'remediation']) {
      if (!nonEmpty(finding[field])) errors.push(`${at}.${field} must be a non-empty string`)
    }
    if (finding.location !== undefined && typeof finding.location !== 'string') errors.push(`${at}.location must be a string when present`)
    validateScoring(finding, at, errors)
  })
  return errors
}

// The score of a finding is the one the offline calculator derives from its vector (environmental vector when present), never the one the auditor wrote.
const calculatedScore = (cvss) => scoreCvss4(cvss.environmental?.vector ?? cvss.vector).score

// Report format 1 has no scoring fields; format 2 adds them. Both are accepted: the scoring fields are checked only when present.
function validateScoring(finding, at, errors) {
  const { cvss, severityFloor, wstg, chainedWith } = finding
  if (wstg !== undefined && !(Array.isArray(wstg) && wstg.every((id) => typeof id === 'string'))) errors.push(`${at}.wstg must be an array of ids when present`)
  if (chainedWith !== undefined && !(Array.isArray(chainedWith) && chainedWith.every((id) => typeof id === 'string'))) errors.push(`${at}.chainedWith must be an array of finding ids when present`)
  if (finding.severityRationale !== undefined && typeof finding.severityRationale !== 'string') errors.push(`${at}.severityRationale must be a string when present`)
  if (severityFloor !== undefined && !(severityFloor && SEVERITY_FLOOR_CLASSES.includes(severityFloor.class) && typeof severityFloor.evidence === 'string' && severityFloor.evidence.trim())) errors.push(`${at}.severityFloor must have a class (${SEVERITY_FLOOR_CLASSES.join('|')}) and evidence`)
  if (cvss === undefined) return
  if (!cvss || typeof cvss !== 'object' || typeof cvss.vector !== 'string' || !/^CVSS:4\.0\//.test(cvss.vector) || (cvss.score !== undefined && !(cvss.score >= 0 && cvss.score <= 10))) return errors.push(`${at}.cvss must have a CVSS:4.0 vector and, when present, a score from 0.0 to 10.0`)
  let final
  try { final = calculatedScore(cvss) } catch (error) { return errors.push(`${at}.cvss.vector is not a valid CVSS:4.0 vector: ${error.message}`) }
  if (SEVERITIES.includes(finding.severity) && finding.severity !== cvssBand(final) && !(severityFloor && finding.severity === 'high')) errors.push(`${at}.severity ${finding.severity} does not match the CVSS band ${cvssBand(final)} of score ${final}`)
}

const cweMatches = (finding, entry) => finding.cwe === entry.cwe || (entry.cweFamily || []).includes(finding.cwe)

function hintMatches(finding, entry) {
  const haystack = [finding.title, finding.attackPath, finding.evidence, finding.location].filter((v) => typeof v === 'string').join('\n').toLowerCase()
  return (entry.matchHints || []).some((hint) => haystack.includes(String(hint).toLowerCase()))
}

const matches = (finding, entry) => cweMatches(finding, entry) && hintMatches(finding, entry)
const ratio = (n, d) => (d === 0 ? null : n / d)

export function scoreReport(answerKey, report) {
  const findings = report.findings
  const assigned = new Map()
  const detected = []
  const missed = []
  for (const entry of answerKey.vulnerabilities) {
    const candidates = findings.filter((f) => !assigned.has(f.id) && matches(f, entry))
    candidates.sort((a, b) => (b.cwe === entry.cwe) - (a.cwe === entry.cwe) || Math.abs(rank(a.severity) - rank(entry.severity)) - Math.abs(rank(b.severity) - rank(entry.severity)))
    const hit = candidates[0]
    if (!hit) {
      missed.push(entry.key)
      continue
    }
    assigned.set(hit.id, entry.key)
    const delta = rank(hit.severity) - rank(entry.severity)
    const exact = delta === 0 || (entry.acceptedSeverities || []).includes(hit.severity)
    let reportedScore
    try { if (typeof hit.cvss?.vector === 'string') reportedScore = calculatedScore(hit.cvss) } catch { /* an invalid vector is reported by validateScoring */ }
    const item = { key: entry.key, findingId: hit.id, expectedSeverity: entry.severity, reportedSeverity: hit.severity, severityDelta: delta, exact }
    if (typeof reportedScore === 'number' && entry.cvss) Object.assign(item, { expectedScore: entry.cvss.score, reportedScore, scoreDelta: Math.round((reportedScore - entry.cvss.score) * 10) / 10 })
    detected.push(item)
  }
  const detectedKeys = new Set(assigned.values())
  const duplicates = []
  const acceptable = []
  const falsePositives = []
  const extras = []
  for (const finding of findings) {
    if (assigned.has(finding.id)) continue
    const brief = { id: finding.id, severity: finding.severity, cwe: finding.cwe, title: finding.title }
    const duplicateOf = answerKey.vulnerabilities.find((e) => detectedKeys.has(e.key) && matches(finding, e))
    if (duplicateOf) {
      duplicates.push({ ...brief, of: duplicateOf.key })
      continue
    }
    const tolerated = (answerKey.acceptable || []).find((e) => matches(finding, e) && rank(finding.severity) <= rank(e.maxSeverity))
    if (tolerated) {
      acceptable.push({ ...brief, of: tolerated.key })
      continue
    }
    if (rank(finding.severity) >= rank('medium')) falsePositives.push(brief)
    else extras.push(brief)
  }
  const total = answerKey.vulnerabilities.length
  return {
    target: answerKey.target,
    kind: answerKey.kind,
    planted: total,
    reportedFindings: findings.length,
    detected,
    missed,
    falsePositives,
    duplicates,
    acceptable,
    extras,
    severity: {
      evaluated: detected.length,
      exact: detected.filter((d) => d.exact).length,
      withinOne: detected.filter((d) => d.exact || Math.abs(d.severityDelta) <= 1).length
    },
    recall: ratio(detected.length, total),
    precision: ratio(detected.length, detected.length + falsePositives.length)
  }
}

function loadKey(target) {
  const file = path.join(KEY_DIR, `${path.basename(target)}.json`)
  if (!fs.existsSync(file)) throw new UsageError(`no answer key for target "${target}" (${file})`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function loadReport(file) {
  let report
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new UsageError(`cannot read report ${file}: ${error.message}`)
  }
  const errors = validateReport(report)
  if (errors.length) throw new UsageError(`invalid report ${file}:\n  - ${errors.join('\n  - ')}`)
  return report
}

const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`)

function formatHuman(r) {
  const lines = [`Target ${r.target} (${r.kind}): ${r.reportedFindings} finding(s) reported, ${r.planted} planted`]
  lines.push(`  detected: ${r.detected.length}/${r.planted}  recall: ${pct(r.recall)}  precision: ${pct(r.precision)}`)
  for (const d of r.detected) lines.push(`    + ${d.key} <- ${d.findingId} (expected ${d.expectedSeverity}, reported ${d.reportedSeverity}${d.scoreDelta === undefined ? '' : `, CVSS ${d.reportedScore} vs ${d.expectedScore}`})`)
  lines.push(`  missed: ${r.missed.length}`)
  for (const k of r.missed) lines.push(`    - ${k}`)
  lines.push(`  false positives (medium+ without match): ${r.falsePositives.length}`)
  for (const f of r.falsePositives) lines.push(`    ! ${f.id} [${f.severity}] ${f.cwe} ${f.title}`)
  lines.push(`  severity: exact ${r.severity.exact}/${r.severity.evaluated}, within one level ${r.severity.withinOne}/${r.severity.evaluated}`)
  if (r.duplicates.length) lines.push(`  duplicates of detected items: ${r.duplicates.map((d) => d.id).join(', ')}`)
  if (r.acceptable.length) lines.push(`  accepted observations: ${r.acceptable.map((d) => d.id).join(', ')}`)
  if (r.extras.length) lines.push(`  extra low/info findings: ${r.extras.map((d) => d.id).join(', ')}`)
  return lines.join('\n')
}

function aggregate(results) {
  const sum = (f) => results.reduce((n, r) => n + f(r), 0)
  const vulnerable = results.filter((r) => r.planted > 0)
  const detected = sum((r) => r.detected.length)
  const fp = sum((r) => r.falsePositives.length)
  return {
    targets: results.length,
    planted: sum((r) => r.planted),
    detected,
    missed: sum((r) => r.missed.length),
    falsePositives: fp,
    controlFalsePositives: sum((r) => (r.planted === 0 ? r.falsePositives.length : 0)),
    recall: ratio(detected, sum((r) => r.planted)),
    precision: ratio(detected, detected + fp),
    severityExact: ratio(sum((r) => r.severity.exact), sum((r) => r.severity.evaluated)),
    vulnerableTargets: vulnerable.length
  }
}

function parseArgs(argv) {
  const opts = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--target' || a === '--report' || a === '--all') {
      if (i + 1 >= argv.length) throw new UsageError(`${a} requires a value`)
      opts[a.slice(2)] = argv[++i]
    } else throw new UsageError(`unknown argument ${a}`)
  }
  if (opts.all ? opts.target || opts.report : !(opts.target && opts.report)) {
    throw new UsageError('usage: score.mjs --target <name> --report <report.json> | --all <dir> [--json]')
  }
  return opts
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const results = []
  const skipped = []
  if (opts.all) {
    for (const name of fs.readdirSync(KEY_DIR).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort()) {
      const file = path.join(opts.all, `${name}.json`)
      if (!fs.existsSync(file)) {
        skipped.push(name)
        continue
      }
      results.push(scoreReport(loadKey(name), loadReport(file)))
    }
  } else {
    results.push(scoreReport(loadKey(opts.target), loadReport(opts.report)))
  }
  const summary = opts.all ? aggregate(results) : undefined
  if (opts.json) {
    console.log(JSON.stringify({ results, skipped, summary }, null, 2))
    return
  }
  console.log(results.map(formatHuman).join('\n\n'))
  if (skipped.length) console.log(`\nNo report for: ${skipped.join(', ')}`)
  if (summary) {
    console.log(`\nTotal: detected ${summary.detected}/${summary.planted} (recall ${pct(summary.recall)}), false positives ${summary.falsePositives} (control targets: ${summary.controlFalsePositives}), precision ${pct(summary.precision)}, exact severity ${pct(summary.severityExact)}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    console.error(error.message)
    process.exit(2)
  }
}
