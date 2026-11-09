/*
 * CVSS v4.0 offline calculator (zero dependencies).
 *
 * The MacroVector lookup table, the maximal-severity tables and the interpolation algorithm are ported from the FIRST
 * reference implementation, https://github.com/FIRSTdotorg/cvss-v4-calculator (cvss_lookup.js, max_composed.js,
 * max_severity.js, cvss_score.js and metrics.js), licensed under the BSD 2-Clause License:
 *
 * Copyright (c) 2023 FIRST.ORG, Inc., Red Hat, and contributors
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/** A refusal carries its message template and values so callers can translate it without parsing text. */
export class Cvss4Error extends Error {
  constructor(template, ...params) {
    super(template.replace(/\{(\d+)\}/g, (all, index) => params[index] ?? all))
    this.template = template
    this.params = params
  }
}

export const CVSS4_BASE_METRICS = [['AV', ['N', 'A', 'L', 'P']], ['AC', ['L', 'H']], ['AT', ['N', 'P']], ['PR', ['N', 'L', 'H']], ['UI', ['N', 'P', 'A']], ['VC', ['H', 'L', 'N']], ['VI', ['H', 'L', 'N']], ['VA', ['H', 'L', 'N']], ['SC', ['H', 'L', 'N']], ['SI', ['H', 'L', 'N']], ['SA', ['H', 'L', 'N']]]
export const CVSS4_OPTIONAL_METRICS = [
  ['E', ['X', 'A', 'P', 'U']], ['CR', ['X', 'H', 'M', 'L']], ['IR', ['X', 'H', 'M', 'L']], ['AR', ['X', 'H', 'M', 'L']],
  ['MAV', ['X', 'N', 'A', 'L', 'P']], ['MAC', ['X', 'L', 'H']], ['MAT', ['X', 'N', 'P']], ['MPR', ['X', 'N', 'L', 'H']], ['MUI', ['X', 'N', 'P', 'A']],
  ['MVC', ['X', 'H', 'L', 'N']], ['MVI', ['X', 'H', 'L', 'N']], ['MVA', ['X', 'H', 'L', 'N']], ['MSC', ['X', 'H', 'L', 'N']], ['MSI', ['X', 'H', 'L', 'N', 'S']], ['MSA', ['X', 'H', 'L', 'N', 'S']],
  ['S', ['X', 'N', 'P']], ['AU', ['X', 'N', 'Y']], ['R', ['X', 'A', 'U', 'I']], ['V', ['X', 'D', 'C']], ['RE', ['X', 'L', 'M', 'H']], ['U', ['X', 'Clear', 'Green', 'Amber', 'Red']],
]

/** Parses a CVSS v4.0 vector: base metrics in the official order, then the optional metrics in order; every refusal names the metric. `at` labels the vector in messages. */
export function parseCvss4(vector, at = 'vector') {
  const bad = (template, ...params) => { throw new Cvss4Error(template, at, ...params) }
  const parts = typeof vector === 'string' ? vector.split('/') : []
  if (parts[0] !== 'CVSS:4.0') bad('{0} must start with CVSS:4.0/ followed by the base metrics')
  const metrics = {}
  let cursor = 1
  for (const [name, values] of CVSS4_BASE_METRICS) {
    const [key, value, ...rest] = (parts[cursor] ?? '').split(':')
    if (key !== name) bad('{0}: base metric {1} is missing or out of order', name)
    if (rest.length || !values.includes(value)) bad('{0}: metric {1} has an invalid value "{2}"', name, value ?? '')
    metrics[name] = value
    cursor++
  }
  let position = 0
  for (; cursor < parts.length; cursor++) {
    const [key, value, ...rest] = parts[cursor].split(':')
    const found = CVSS4_OPTIONAL_METRICS.findIndex(([name]) => name === key)
    if (found < position || rest.length) bad('{0}: unknown, repeated or misordered metric "{1}"', parts[cursor])
    if (!CVSS4_OPTIONAL_METRICS[found][1].includes(value)) bad('{0}: metric {1} has an invalid value "{2}"', key, value ?? '')
    metrics[key] = value
    position = found + 1
  }
  return metrics
}

// MacroVector (EQ1..EQ6) -> base score.
const LOOKUP = {
  "100000": 9.8, "100001": 9.5, "100010": 9.4, "100011": 8.7, "100020": 9.1, "100021": 8.1,
  "100100": 9.4, "100101": 8.9, "100110": 8.6, "100111": 7.4, "100120": 7.7, "100121": 6.4,
  "100200": 8.7, "100201": 7.5, "100210": 7.4, "100211": 6.3, "100220": 6.3, "100221": 4.9,
  "101000": 9.4, "101001": 8.9, "101010": 8.8, "101011": 7.7, "101020": 7.6, "101021": 6.7,
  "101100": 8.6, "101101": 7.6, "101110": 7.4, "101111": 5.8, "101120": 5.9, "101121": 5,
  "101200": 7.2, "101201": 5.7, "101210": 5.7, "101211": 5.2, "101220": 5.2, "101221": 2.5,
  "102001": 8.3, "102011": 7, "102021": 5.4, "102101": 6.5, "102111": 5.8, "102121": 2.6,
  "102201": 5.3, "102211": 2.1, "102221": 1.3, "110000": 9.5, "110001": 9, "110010": 8.8,
  "110011": 7.6, "110020": 7.6, "110021": 7, "110100": 9, "110101": 7.7, "110110": 7.5,
  "110111": 6.2, "110120": 6.1, "110121": 5.3, "110200": 7.7, "110201": 6.6, "110210": 6.8,
  "110211": 5.9, "110220": 5.2, "110221": 3, "111000": 8.9, "111001": 7.8, "111010": 7.6,
  "111011": 6.7, "111020": 6.2, "111021": 5.8, "111100": 7.4, "111101": 5.9, "111110": 5.7,
  "111111": 5.7, "111120": 4.7, "111121": 2.3, "111200": 6.1, "111201": 5.2, "111210": 5.7,
  "111211": 2.9, "111220": 2.4, "111221": 1.6, "112001": 7.1, "112011": 5.9, "112021": 3,
  "112101": 5.8, "112111": 2.6, "112121": 1.5, "112201": 2.3, "112211": 1.3, "112221": 0.6,
  "200000": 9.3, "200001": 8.7, "200010": 8.6, "200011": 7.2, "200020": 7.5, "200021": 5.8,
  "200100": 8.6, "200101": 7.4, "200110": 7.4, "200111": 6.1, "200120": 5.6, "200121": 3.4,
  "200200": 7, "200201": 5.4, "200210": 5.2, "200211": 4, "200220": 4, "200221": 2.2,
  "201000": 8.5, "201001": 7.5, "201010": 7.4, "201011": 5.5, "201020": 6.2, "201021": 5.1,
  "201100": 7.2, "201101": 5.7, "201110": 5.5, "201111": 4.1, "201120": 4.6, "201121": 1.9,
  "201200": 5.3, "201201": 3.6, "201210": 3.4, "201211": 1.9, "201220": 1.9, "201221": 0.8,
  "202001": 6.4, "202011": 5.1, "202021": 2, "202101": 4.7, "202111": 2.1, "202121": 1.1,
  "202201": 2.4, "202211": 0.9, "202221": 0.4, "210000": 8.8, "210001": 7.5, "210010": 7.3,
  "210011": 5.3, "210020": 6, "210021": 5, "210100": 7.3, "210101": 5.5, "210110": 5.9,
  "210111": 4, "210120": 4.1, "210121": 2, "210200": 5.4, "210201": 4.3, "210210": 4.5,
  "210211": 2.2, "210220": 2, "210221": 1.1, "211000": 7.5, "211001": 5.5, "211010": 5.8,
  "211011": 4.5, "211020": 4, "211021": 2.1, "211100": 6.1, "211101": 5.1, "211110": 4.8,
  "211111": 1.8, "211120": 2, "211121": 0.9, "211200": 4.6, "211201": 1.8, "211210": 1.7,
  "211211": 0.7, "211220": 0.8, "211221": 0.2, "212001": 5.3, "212011": 2.4, "212021": 1.4,
  "212101": 2.4, "212111": 1.2, "212121": 0.5, "212201": 1, "212211": 0.3, "212221": 0.1,
  "000000": 10, "000001": 9.9, "000010": 9.8, "000011": 9.5, "000020": 9.5, "000021": 9.2,
  "000100": 10, "000101": 9.6, "000110": 9.3, "000111": 8.7, "000120": 9.1, "000121": 8.1,
  "000200": 9.3, "000201": 9, "000210": 8.9, "000211": 8, "000220": 8.1, "000221": 6.8,
  "001000": 9.8, "001001": 9.5, "001010": 9.5, "001011": 9.2, "001020": 9, "001021": 8.4,
  "001100": 9.3, "001101": 9.2, "001110": 8.9, "001111": 8.1, "001120": 8.1, "001121": 6.5,
  "001200": 8.8, "001201": 8, "001210": 7.8, "001211": 7, "001220": 6.9, "001221": 4.8,
  "002001": 9.2, "002011": 8.2, "002021": 7.2, "002101": 7.9, "002111": 6.9, "002121": 5,
  "002201": 6.9, "002211": 5.5, "002221": 2.7, "010000": 9.9, "010001": 9.7, "010010": 9.5,
  "010011": 9.2, "010020": 9.2, "010021": 8.5, "010100": 9.5, "010101": 9.1, "010110": 9,
  "010111": 8.3, "010120": 8.4, "010121": 7.1, "010200": 9.2, "010201": 8.1, "010210": 8.2,
  "010211": 7.1, "010220": 7.2, "010221": 5.3, "011000": 9.5, "011001": 9.3, "011010": 9.2,
  "011011": 8.5, "011020": 8.5, "011021": 7.3, "011100": 9.2, "011101": 8.2, "011110": 8,
  "011111": 7.2, "011120": 7, "011121": 5.9, "011200": 8.4, "011201": 7, "011210": 7.1,
  "011211": 5.2, "011220": 5, "011221": 3, "012001": 8.6, "012011": 7.5, "012021": 5.2,
  "012101": 7.1, "012111": 5.2, "012121": 2.9, "012201": 6.3, "012211": 2.9, "012221": 1.7,
}

// Highest-severity vectors of each equivalence-class level, composed to find the reference vector of a MacroVector.
const MAX_COMPOSED = {
  eq1: { 0: ['AV:N/PR:N/UI:N/'], 1: ['AV:A/PR:N/UI:N/', 'AV:N/PR:L/UI:N/', 'AV:N/PR:N/UI:P/'], 2: ['AV:P/PR:N/UI:N/', 'AV:A/PR:L/UI:P/'] },
  eq2: { 0: ['AC:L/AT:N/'], 1: ['AC:H/AT:N/', 'AC:L/AT:P/'] },
  eq3: {
    0: { 0: ['VC:H/VI:H/VA:H/CR:H/IR:H/AR:H/'], 1: ['VC:H/VI:H/VA:L/CR:M/IR:M/AR:H/', 'VC:H/VI:H/VA:H/CR:M/IR:M/AR:M/'] },
    1: { 0: ['VC:L/VI:H/VA:H/CR:H/IR:H/AR:H/', 'VC:H/VI:L/VA:H/CR:H/IR:H/AR:H/'], 1: ['VC:L/VI:H/VA:L/CR:H/IR:M/AR:H/', 'VC:L/VI:H/VA:H/CR:H/IR:M/AR:M/', 'VC:H/VI:L/VA:H/CR:M/IR:H/AR:M/', 'VC:H/VI:L/VA:L/CR:M/IR:H/AR:H/', 'VC:L/VI:L/VA:H/CR:H/IR:H/AR:M/'] },
    2: { 1: ['VC:L/VI:L/VA:L/CR:H/IR:H/AR:H/'] },
  },
  eq4: { 0: ['SC:H/SI:S/SA:S/'], 1: ['SC:H/SI:H/SA:H/'], 2: ['SC:L/SI:L/SA:L/'] },
  eq5: { 0: ['E:A/'], 1: ['E:P/'], 2: ['E:U/'] },
}
// Depth of each MacroVector level, in steps of 0.1.
const MAX_SEVERITY = {
  eq1: { 0: 1, 1: 4, 2: 5 },
  eq2: { 0: 1, 1: 2 },
  eq3eq6: { 0: { 0: 7, 1: 6 }, 1: { 0: 8, 1: 8 }, 2: { 1: 10 } },
  eq4: { 0: 6, 1: 5, 2: 4 },
  eq5: { 0: 1, 1: 1, 2: 1 },
}
const LEVELS = {
  AV: { N: 0, A: 0.1, L: 0.2, P: 0.3 }, PR: { N: 0, L: 0.1, H: 0.2 }, UI: { N: 0, P: 0.1, A: 0.2 },
  AC: { L: 0, H: 0.1 }, AT: { N: 0, P: 0.1 },
  VC: { H: 0, L: 0.1, N: 0.2 }, VI: { H: 0, L: 0.1, N: 0.2 }, VA: { H: 0, L: 0.1, N: 0.2 },
  SC: { H: 0.1, L: 0.2, N: 0.3 }, SI: { S: 0, H: 0.1, L: 0.2, N: 0.3 }, SA: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
  CR: { H: 0, M: 0.1, L: 0.2 }, IR: { H: 0, M: 0.1, L: 0.2 }, AR: { H: 0, M: 0.1, L: 0.2 },
}
const DISTANCE_METRICS = Object.keys(LEVELS)

/** Effective value of a metric: unset exposure and requirements take the worst case, and a modified metric overrides the base one. */
function effective(metrics, name) {
  const selected = metrics[name] ?? 'X'
  if (name === 'E' && selected === 'X') return 'A'
  if (['CR', 'IR', 'AR'].includes(name) && selected === 'X') return 'H'
  const modified = metrics['M' + name]
  return modified !== undefined && modified !== 'X' ? modified : selected
}

function macroVector(metrics) {
  const m = name => effective(metrics, name)
  const eq1 = m('AV') === 'N' && m('PR') === 'N' && m('UI') === 'N' ? 0 : (m('AV') === 'N' || m('PR') === 'N' || m('UI') === 'N') && m('AV') !== 'P' ? 1 : 2
  const eq2 = m('AC') === 'L' && m('AT') === 'N' ? 0 : 1
  const eq3 = m('VC') === 'H' && m('VI') === 'H' ? 0 : m('VC') === 'H' || m('VI') === 'H' || m('VA') === 'H' ? 1 : 2
  const eq4 = m('MSI') === 'S' || m('MSA') === 'S' ? 0 : m('SC') === 'H' || m('SI') === 'H' || m('SA') === 'H' ? 1 : 2
  const eq5 = { A: 0, P: 1, U: 2 }[m('E')]
  const eq6 = m('CR') === 'H' && m('VC') === 'H' || m('IR') === 'H' && m('VI') === 'H' || m('AR') === 'H' && m('VA') === 'H' ? 0 : 1
  return `${eq1}${eq2}${eq3}${eq4}${eq5}${eq6}`
}

const toMap = text => Object.fromEntries(text.split('/').filter(Boolean).map(pair => pair.split(':')))

function computeScore(metrics) {
  const m = name => effective(metrics, name)
  if (['VC', 'VI', 'VA', 'SC', 'SI', 'SA'].every(name => m(name) === 'N')) return 0
  const key = macroVector(metrics), eq = [...key].map(Number)
  let value = LOOKUP[key]
  const lower = (index, step = 1) => LOOKUP[[...key].map((digit, at) => at === index ? eq[at] + step : digit).join('')] ?? NaN
  // EQ3 and EQ6 move together: the next lower MacroVector depends on both.
  let eq3eq6Lower
  if (eq[2] === 1 && eq[5] === 1 || eq[2] === 0 && eq[5] === 1) eq3eq6Lower = lower(2)
  else if (eq[2] === 1 && eq[5] === 0) eq3eq6Lower = lower(5)
  else if (eq[2] === 0 && eq[5] === 0) {
    const left = lower(5), right = lower(2)
    eq3eq6Lower = left > right ? left : right
  } else eq3eq6Lower = LOOKUP[`${eq[0]}${eq[1]}${eq[2] + 1}${eq[3]}${eq[4]}${eq[5] + 1}`] ?? NaN
  const available = [value - lower(0), value - lower(1), value - eq3eq6Lower, value - lower(3), value - lower(4)]

  // Reference vector: the first composition of the highest vectors that is not below the scored vector on any metric.
  const compose = [MAX_COMPOSED.eq1[eq[0]], MAX_COMPOSED.eq2[eq[1]], MAX_COMPOSED.eq3[eq[2]][eq[5]], MAX_COMPOSED.eq4[eq[3]], MAX_COMPOSED.eq5[eq[4]]]
  const candidates = compose.reduce((all, options) => all.flatMap(prefix => options.map(option => prefix + option)), [''])
  let distance
  for (const candidate of candidates) {
    const max = toMap(candidate)
    distance = Object.fromEntries(DISTANCE_METRICS.map(name => [name, LEVELS[name][m(name)] - LEVELS[name][max[name]]]))
    if (!DISTANCE_METRICS.some(name => distance[name] < 0)) break
  }
  const sum = names => names.reduce((total, name) => total + distance[name], 0)
  const step = 0.1
  const current = [sum(['AV', 'PR', 'UI']), sum(['AC', 'AT']), sum(['VC', 'VI', 'VA', 'CR', 'IR', 'AR']), sum(['SC', 'SI', 'SA']), 0]
  const depth = [MAX_SEVERITY.eq1[eq[0]], MAX_SEVERITY.eq2[eq[1]], MAX_SEVERITY.eq3eq6[eq[2]][eq[5]], MAX_SEVERITY.eq4[eq[3]], 1].map(item => item * step)
  let existing = 0, total = 0
  available.forEach((room, index) => {
    if (Number.isNaN(room)) return
    existing++
    total += index === 4 ? 0 : room * (current[index] / depth[index])
  })
  value -= existing === 0 ? 0 : total / existing
  value = Math.min(10, Math.max(0, value))
  return Math.round(value * 10) / 10
}

const severityOf = score => score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'none'
const isSet = (metrics, name) => metrics[name] !== undefined && metrics[name] !== 'X'

/** Scores a CVSS v4.0 vector offline; the nomenclature reflects which metric groups the vector sets (supplemental metrics never change the score). */
export function scoreCvss4(vector) {
  const metrics = parseCvss4(vector)
  const score = computeScore(metrics)
  const threat = isSet(metrics, 'E')
  const environmental = ['CR', 'IR', 'AR', ...CVSS4_OPTIONAL_METRICS.map(([name]) => name).filter(name => /^M/.test(name))].some(name => isSet(metrics, name))
  return { score, severity: severityOf(score), nomenclature: threat ? (environmental ? 'CVSS-BTE' : 'CVSS-BT') : environmental ? 'CVSS-BE' : 'CVSS-B' }
}
