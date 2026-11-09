import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCvss4, scoreCvss4, Cvss4Error } from '../scripts/cvss4.mjs'

const P = 'CVSS:4.0/'
const BASE_HIGH = 'AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'

// Scores read in the official FIRST calculator; a mismatch means the port or its lookup table drifted.
const OFFICIAL = {
  'AV:L/AC:L/AT:P/PR:H/UI:N/VC:H/VI:L/VA:N/SC:N/SI:N/SA:N': 5.6,
  'AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N': 8.6,
  'AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N': 7.1,
  'AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N': 6.3,
  'AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N': 9.3,
  'AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N': 9.3,
  'AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N': 8.7,
  'AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:H/VA:N/SC:N/SI:N/SA:N': 8.7,
  'AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:L/VA:N/SC:N/SI:N/SA:N': 8.3,
  'AV:N/AC:L/AT:P/PR:N/UI:N/VC:L/VI:L/VA:N/SC:N/SI:N/SA:N': 6.3,
  'AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:L/VA:N/SC:N/SI:N/SA:N': 6.3,
  'AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N/CR:H': 6.3,
  'AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N/CR:H/IR:H': 6.3,
  // The maximum severity vector is the top row of the lookup table, so it needs no interpolation.
  'AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H': 10,
  'AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/E:A': 10,
}
for (const [vector, score] of Object.entries(OFFICIAL)) test(`official score ${score} for ${vector}`, () => assert.equal(scoreCvss4(P + vector).score, score))

// Threat, environmental, supplemental and boundary vectors confirmed in the official FIRST calculator: [vector, score, severity].
const CROSSCHECKED = [
  ['AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H', 10, 'critical'],
  ['AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:P', 8.9, 'high'],
  ['AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:U', 8.1, 'high'],
  ['AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N/E:U', 4.9, 'medium'],
  ['AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N/MAV:A', 8.5, 'high'],
  ['AV:N/AC:L/AT:N/PR:N/UI:N/VC:L/VI:L/VA:N/SC:N/SI:N/SA:N/MVC:H/MVI:H', 9.3, 'critical'],
  ['AV:A/AC:L/AT:N/PR:L/UI:P/VC:H/VI:L/VA:N/SC:L/SI:L/SA:N/MSI:S', 8.2, 'high'],
  ['AV:N/AC:H/AT:N/PR:N/UI:A/VC:H/VI:H/VA:L/SC:N/SI:N/SA:N/E:P/CR:H/IR:M/AR:L', 6.4, 'medium'],
  ['AV:L/AC:L/AT:N/PR:N/UI:P/VC:L/VI:L/VA:L/SC:N/SI:N/SA:N/S:P/AU:Y/R:A/V:C/RE:H/U:Red', 4.8, 'medium'],
  ['AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:N/VA:N/SC:H/SI:H/SA:H/E:A/CR:H/MSI:S/MSA:S', 9.5, 'critical'],
  ['AV:P/AC:H/AT:N/PR:H/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N', 1, 'low'],
  ['AV:N/AC:L/AT:N/PR:L/UI:N/VC:N/VI:L/VA:N/SC:N/SI:N/SA:N/MAV:L/MPR:N/MVC:L/MVI:H', 7, 'high'],
]
for (const [vector, score, severity] of CROSSCHECKED) test(`official score ${score} (${severity}) for ${vector}`, () => {
  const result = scoreCvss4(P + vector)
  assert.equal(result.score, score)
  assert.equal(result.severity, severity)
})

test('severity bands follow the CVSS v4.0 qualitative scale', () => {
  const band = vector => scoreCvss4(P + vector).severity
  assert.equal(band(BASE_HIGH), 'critical')
  assert.equal(band('AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N'), 'high')
  assert.equal(band('AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N'), 'medium')
  assert.equal(band('AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N'), 'low')
})

test('o menor macrovetor mantém nota positiva e mensagens preservam parâmetros ausentes', () => {
  const vector = P + 'AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:L/VA:L/SC:L/SI:L/SA:L/E:U/CR:L/IR:L/AR:L'
  assert.equal(scoreCvss4(vector).score, 0.1)
  assert.equal(scoreCvss4(vector).severity, 'low')
  assert.equal(new Cvss4Error('{0}: {1}', 'vector').message, 'vector: {1}')
})

test('no impact on any vulnerable or subsequent system scores 0.0 and none', () => {
  assert.deepEqual(scoreCvss4(P + 'AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N'), { score: 0, severity: 'none', nomenclature: 'CVSS-B' })
  // A modified impact metric can bring impact back into a vector whose base impact is none.
  assert.ok(scoreCvss4(P + 'AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N/MVC:H').score > 0)
})

test('nomenclature reflects the metric groups set and ignores X and supplemental metrics', () => {
  const nomenclature = suffix => scoreCvss4(P + BASE_HIGH + suffix).nomenclature
  assert.equal(nomenclature(''), 'CVSS-B')
  assert.equal(nomenclature('/E:X/CR:X'), 'CVSS-B')
  assert.equal(nomenclature('/E:P'), 'CVSS-BT')
  assert.equal(nomenclature('/CR:L'), 'CVSS-BE')
  assert.equal(nomenclature('/MAV:A'), 'CVSS-BE')
  assert.equal(nomenclature('/E:P/MSI:S'), 'CVSS-BTE')
  assert.equal(nomenclature('/S:P/AU:Y/R:A/V:C/RE:H/U:Red'), 'CVSS-B')
  assert.equal(scoreCvss4(P + BASE_HIGH + '/S:P/AU:Y/R:A/V:C/RE:H/U:Red').score, scoreCvss4(P + BASE_HIGH).score)
})

test('threat, environmental and safety metrics move the score in the documented direction', () => {
  const base = scoreCvss4(P + BASE_HIGH).score
  assert.ok(scoreCvss4(P + BASE_HIGH + '/E:U').score < base)
  assert.ok(scoreCvss4(P + BASE_HIGH + '/E:P').score < base)
  assert.ok(scoreCvss4(P + BASE_HIGH + '/E:U').score < scoreCvss4(P + BASE_HIGH + '/E:P').score)
  assert.equal(scoreCvss4(P + BASE_HIGH + '/E:A').score, base)
  assert.ok(scoreCvss4(P + BASE_HIGH + '/CR:L/IR:L/AR:L').score < base)
  assert.ok(scoreCvss4(P + BASE_HIGH + '/MAV:P').score < base)
  assert.ok(scoreCvss4(P + BASE_HIGH + '/MSI:S').score >= base)
  assert.equal(scoreCvss4(P + BASE_HIGH + '/MSI:S/MSA:S').severity, 'critical')
})

test('parseCvss4 returns the metrics set and accepts every optional group in order', () => {
  assert.deepEqual(parseCvss4(P + BASE_HIGH), { AV: 'N', AC: 'L', AT: 'N', PR: 'N', UI: 'N', VC: 'H', VI: 'H', VA: 'H', SC: 'N', SI: 'N', SA: 'N' })
  assert.equal(parseCvss4(P + BASE_HIGH + '/E:P/CR:H/MSI:S/S:N/U:Green').MSI, 'S')
})

test('parseCvss4 refuses a malformed vector and names the problem', () => {
  const refuse = (vector, pattern) => assert.throws(() => parseCvss4(vector, 'v'), error => error instanceof Cvss4Error && pattern.test(error.message) && typeof error.template === 'string', String(vector))
  for (const vector of [undefined, null, 5, '', 'CVSS:3.1/AV:N', 'AV:N/AC:L', 'CVSS:3.1']) refuse(vector, /must start with CVSS:4\.0\//)
  refuse(P + 'AC:L/AV:N/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N', /base metric AV is missing or out of order/)
  refuse(P + 'AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N', /base metric SA is missing/)
  refuse('CVSS:4.0', /base metric AV is missing/)
  refuse(P + BASE_HIGH.replace('AV:N', 'AV:Z'), /metric AV has an invalid value "Z"/)
  refuse(P + BASE_HIGH.replace('AV:N', 'AV'), /metric AV has an invalid value ""/)
  refuse(P + BASE_HIGH.replace('AV:N', 'AV:N:extra'), /metric AV has an invalid value/)
  refuse(P + BASE_HIGH.replace('SI:N', 'SI:S'), /metric SI has an invalid value "S"/)
  refuse(P + BASE_HIGH + '/E:Q', /metric E has an invalid value "Q"/)
  refuse(P + BASE_HIGH + '/ZZ:H', /unknown, repeated or misordered metric "ZZ:H"/)
  refuse(P + BASE_HIGH + '/E:P/E:P', /misordered metric "E:P"/)
  refuse(P + BASE_HIGH + '/CR:H/E:P', /misordered metric "E:P"/)
  refuse(P + BASE_HIGH + '/E:P:X', /misordered metric "E:P:X"/)
  refuse(P + BASE_HIGH + '/', /misordered metric ""/)
  refuse(P + BASE_HIGH + '/E', /metric E has an invalid value ""/)
})

test('scoreCvss4 rejects what parseCvss4 rejects instead of scoring it', () => {
  assert.throws(() => scoreCvss4('CVSS:4.0/AV:N'), Cvss4Error)
})
