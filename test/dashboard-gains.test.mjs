import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createTranslator, messages } from '../scripts/i18n.mjs'
import { commandMetricsForRun, calculateGain, renderGainPanel, renderManualCoordination, taskManualEstimateMinutes } from '../scripts/dashboard-gains.mjs'

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const fmtMs = (value) => {
  if (value == null) return '—'
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}`
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`
}
const localizer = (lang) => createTranslator(messages, lang)
const spans = (...values) => values.map(([kind, from, to]) => [kind, from, to])

test('67 disparos elegiveis estimam 3h21 e comandos excluidos nao alteram barras nem economia', () => {
  const analysis = { per: [{ spans: spans(['exec', 0, 60000]) }, { spans: spans(['review', 0, 60000]) }] }
  const byCommand = { start: 33, review: 27, 'plan-task': 4, 'plan-phase': 3, 'begin-discussion': 8, retry: 8, status: 162 }
  const options = { commandMetrics: { complete: true, byCommand } }
  const before = JSON.stringify(options)
  const gain = calculateGain(analysis, {}, true, options)
  assert.equal(commandMetricsForRun({}, options).total, 245, 'a auditoria original continua preservada')
  assert.equal(gain.commandTotal, 67)
  assert.deepEqual(gain.commandCounts, { planning: 7, execution: 33, review: 27 })
  assert.equal(gain.manualCoordinationMs, 201 * 60000)
  assert.equal(gain.savingsMs, 60000)
  assert.equal(gain.combinedEstimateMs, 202 * 60000)
  assert.equal(JSON.stringify(options), before)
  const moreExcluded = calculateGain(analysis, {}, true, { commandMetrics: { complete: true, byCommand: { ...byCommand, retry: 9999, status: 9999, note: 9999, 'begin-discussion': 9999 } } })
  assert.equal(renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc), renderGainPanel(moreExcluded, localizer('pt-BR'), fmtMs, esc), 'comandos excluídos não afetam nenhum valor ou segmento')
  const manual = renderManualCoordination(gain, localizer('pt-BR'), fmtMs, esc)
  assert.match(manual, /<strong>3h21<\/strong>/)
  assert.match(manual, /Comandos de planejamento[^]*Comandos de execução[^]*Comandos de revisão/)
  assert.equal((manual.match(/<div><span>/g) ?? []).length, 3)
  assert.doesNotMatch(manual, /gain-badge|retry|status|begin-discussion|novas tentativas|Demais comandos|Comandos de discussão/)
  for (const anyLive of [false, true]) assert.doesNotMatch(renderGainPanel({ ...gain, runActive: anyLive }, localizer('pt-BR'), fmtMs, esc), /gain-status|até agora|execução concluída/)
})

test('comandos sem eventos contam tentativas de fase e aceitam timestamp alternativo', () => {
  const phase = commandMetricsForRun({}, {
    phaseWorkflows: { F1: { planningAttempts: [{}], discussionAttempts: [{}, {}] }, F2: {} },
    events: [{ type: 'task_start', ts: '2026-01-01T00:00:00Z' }],
  })
  assert.equal(phase.byCommand.start, 1)
  assert.equal(phase.byCommand['plan-phase'], undefined, 'eventos presentes não usam a contagem legada de fases')

  const legacy = commandMetricsForRun({}, {
    phaseWorkflows: { F1: { planningAttempts: [{}], discussionAttempts: [{}, {}] }, F2: {} },
  })
  assert.equal(legacy.byCommand['plan-phase'], 1)
  assert.equal(legacy.byCommand['begin-phase-discussion'], 2)
})

test('ganho mantém defaults quando a telemetria opcional está ausente', () => {
  const sparse = calculateGain({ per: [{}], sharedSpans: null, phasePlanning: [{ activityTiming: 'explicit' }] }, null, true, { commandMetrics: {} })
  assert.equal(sparse.oneAtATimeMs, null)
  assert.equal(sparse.manualCoordinationMs, 0)
  assert.equal(calculateGain(null, {}, false).oneAtATimeMs, null)

  const gainMarkup = renderGainPanel({ historyComplete: true, oneAtATimeMs: 1000, withPrumoMs: 1000,
    savingsMs: 0, factor: 1, combinedEstimateMs: null }, localizer('en'), fmtMs, esc)
  assert.match(gainMarkup, /Fixed assumption of 3 minutes per command/)

  const manualMarkup = renderManualCoordination({}, localizer('en'), fmtMs, esc)
  assert.match(manualMarkup, /No command recorded yet/)
  assert.match(manualMarkup, /0 commands/)
  const partialManual = renderManualCoordination({ commandCounts: { planning: 1 }, commandTotal: 1 }, localizer('en'), fmtMs, esc)
  assert.match(partialManual, /1 command/)
})

test('START e STOP incluem discussão e planejamento de fase uma vez e a barra base soma 100%', () => {
  const gain = calculateGain({ per: [{ id: 'A', spans: spans(['discussion', 0, 10000], ['exec', 20000, 30000]) }, { id: 'B', spans: spans(['review', 20000, 30000]) }],
    sharedSpans: spans(['planning', 10000, 20000]) }, {}, true, { commandMetrics: { byCommand: { start: 1 }, complete: true } })
  assert.equal(gain.oneAtATimeMs, 40000)
  assert.equal(gain.withPrumoMs, 30000)
  assert.equal(gain.savingsMs, 10000)
  assert.equal(gain.combinedEstimateMs, 190000)
  const rendered = renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.match(rendered, /class="seq" style="width:100%"/)
  const lower = rendered.match(/class="par" style="width:([\d.]+)%"><\/i><i class="save" style="width:([\d.]+)%"><\/i><i class="est" style="width:([\d.]+)%"/)
  assert.ok(lower)
  assert.equal(lower.slice(1).reduce((sum, width) => sum + Number(width), 0), 100)
  assert.match(rendered, /Sem prumo<\/span><strong>3m40<\/strong>/)
  const labels = ['Sem prumo', 'Fator de paralelismo', 'No prumo', 'Economia aferida', 'Economia estimada']
  assert.deepEqual(labels.map(label => rendered.indexOf(`${label}</span>`)).every((index, position, positions) => index >= 0 && (position === 0 || index > positions[position - 1])), true)
  assert.equal((rendered.match(/class="gain-prumo"/g) ?? []).length, 3)
})

test('ganho medido soma o trabalho por tarefa e une intervalos paralelos, sem contar bloqueios', () => {
  const analysis = {
    per: [
      { id: 'A', agentTime: 30_000, spans: spans(['exec', 0, 10_000], ['exec', 30_000, 40_000], ['review', 50_000, 60_000]), blocks: [[10_000, 27_000], [15_000, 30_000]] },
      { id: 'B', agentTime: 20_000, spans: spans(['plan', 5_000, 15_000], ['exec', 25_000, 35_000]) },
    ],
    cpLen: 35_000,
    anyLive: true,
  }
  const tasks = {
    A: { attempts: [{}, {}], validations: [{ by: 'review' }, { by: 'review' }] },
    B: { attempts: [{}], validations: [{ by: 'review' }] },
  }
  const gain = calculateGain(analysis, tasks, true)
  assert.equal(gain.oneAtATimeMs, 40_000)
  assert.equal(gain.withPrumoMs, 35_000)
  assert.equal(gain.savingsMs, 5_000)
  assert.equal(gain.factor, 40_000 / 35_000)
  assert.equal(gain.criticalPathMs, null, 'an unmeasured planning envelope cannot leak into the critical path')
  assert.equal(gain.partial, true, 'planning envelopes without progress telemetry are marked as unmeasured')
  assert.equal(gain.runActive, true)
})

test('histórico sem confirmação completa não mede nem exibe um envelope de 115h', () => {
  const elapsed = 115 * 60 * 60_000
  const gain = calculateGain({
    per: [{ id: 'T', agentTime: elapsed, spans: spans(['exec', 1_000, 1_000 + elapsed]) }],
    cpLen: elapsed,
  }, { T: { attempts: [{}], validations: [] } })
  assert.equal(gain.historyComplete, false)
  assert.equal(gain.oneAtATimeMs, null)
  assert.equal(gain.withPrumoMs, null)
  assert.equal(gain.savingsMs, null)
  assert.equal(gain.criticalPathMs, null)
  const html = renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.match(html, /Não aferido/)
  assert.doesNotMatch(html, /115h/)
})

test('envelope de fase de 115h e total legado não entram; caminho crítico contaminado é omitido', () => {
  const gain = calculateGain({
    per: [{ id: 'A', agentTime: 115 * 60 * 60_000, spans: spans(['exec', 1_000, 21_000]) }],
    phasePlanning: [{ start: 0, elapsed: 115 * 60 * 60_000, duration: 0 }],
    cpLen: 115 * 60 * 60_000,
    unmeasuredActivity: true,
    anyLive: true,
  }, { A: { attempts: [], validations: [] } }, true)
  assert.equal(gain.oneAtATimeMs, 20_000)
  assert.equal(gain.withPrumoMs, 20_000)
  assert.equal(gain.savingsMs, 0)
  assert.equal(gain.criticalPathMs, null)
  assert.equal(gain.partial, true)
  const html = renderGainPanel(gain, localizer('en'), fmtMs, esc, 'en')
  assert.doesNotMatch(html, /115h/)
  assert.match(html, /20s/)
  assert.doesNotMatch(html, /gain-status|so far|Run completed/)
  assert.match(html, /unmeasured periods are omitted/)
})

test('envelope de planejamento de tarefa sem telemetria não vira atividade medida', () => {
  const elapsed = 115 * 60 * 60_000
  const gain = calculateGain({
    per: [{ id: 'A', agentTime: elapsed, spans: spans(['plan', 1_000, 1_000 + elapsed]) }],
    cpLen: elapsed,
  }, { A: { planningAttempts: [{ startedAt: 1_000, endedAt: 1_000 + elapsed }], attempts: [], validations: [] } }, true)
  assert.equal(gain.oneAtATimeMs, null)
  assert.equal(gain.withPrumoMs, null)
  assert.equal(gain.savingsMs, null)
  assert.equal(gain.criticalPathMs, null)
  assert.equal(gain.partial, true)
  const html = renderGainPanel(gain, localizer('en'), fmtMs, esc, 'en')
  assert.match(html, /Not measured/)
  assert.doesNotMatch(html, /115h/)
})

test('revisão aferida em 20s continua em 20s mesmo se done veio horas depois', () => {
  const fourHours = 4 * 60 * 60_000
  const gain = calculateGain({
    per: [{ id: 'T', agentTime: fourHours, spans: spans(['review', 1_000, 21_000]) }],
    cpLen: 20_000,
    criticalPathMeasured: true,
    endAt: fourHours,
    wall: fourHours,
    anyLive: false,
  }, { T: { attempts: [{ startedAt: 1_000, endedAt: fourHours }], validations: [{ by: 'review', at: 21_000 }] } }, true)
  assert.equal(gain.oneAtATimeMs, 20_000)
  assert.equal(gain.withPrumoMs, 20_000)
  assert.equal(gain.savingsMs, 0)
  assert.equal(gain.criticalPathMs, 20_000)
  const html = renderGainPanel(gain, localizer('en'), fmtMs, esc, 'en')
  assert.match(html, /20s/)
  assert.doesNotMatch(html, /gain-status|Run completed/)
  assert.doesNotMatch(html, /4h/)
  const htmlPt = renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.doesNotMatch(htmlPt, /gain-status|execução concluída/)
  assert.doesNotMatch(htmlPt, />concluídas<\/span>/)
})

test('lacuna de atividade torna caminho crítico não aferido mesmo com histórico completo', () => {
  const elapsed = 115 * 60 * 60_000
  const gain = calculateGain({
    per: [{ id: 'T', agentTime: 20_000, spans: spans(['exec', 1_000, 21_000]) }],
    cpLen: elapsed,
    criticalPathMeasured: false,
    unmeasuredActivity: true,
  }, { T: { attempts: [{}], validations: [] } }, true)
  assert.equal(gain.oneAtATimeMs, 20_000)
  assert.equal(gain.criticalPathMs, null)
  const html = renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.doesNotMatch(html, /115h|caminho crítico/i)
})
test('sem atividade suficiente mostra não aferido e não fabrica economia, sem selo na run ativa', () => {
  const gain = calculateGain({
    per: [{ id: 'T', agentTime: 0, unmeasured: true, spans: [] }],
    phasePlanning: [{ elapsed: 115 * 60 * 60_000, duration: 0 }],
    unmeasuredActivity: true,
    anyLive: true,
  }, { T: { attempts: [{}], validations: [] } }, true)
  assert.equal(gain.oneAtATimeMs, null)
  assert.equal(gain.withPrumoMs, null)
  assert.equal(gain.savingsMs, null)
  assert.equal(gain.factor, null)
  assert.equal(gain.humanEstimateMs, null)
  const html = renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.doesNotMatch(html, /gain-status|até agora/)
  assert.match(html, /Não aferido/)
  assert.match(html, /não há atividade de agente registrada suficiente/i)
  assert.doesNotMatch(html, /115h|0s/)
})

test('sem manualEstimate não há estimativa humana nem minutos editáveis por evento', () => {
  const analysis = { per: [{ id: 'T', spans: spans(['exec', 0, 10_000]) }], cpLen: 10_000 }
  const gain = calculateGain(analysis, { T: { attempts: [{}, {}], validations: [{ by: 'review', ok: false }, { by: 'review', ok: true }] } }, true)
  assert.equal(gain.humanEstimateMs, null)
  assert.equal(gain.humanEstimateTasks, 0)
  for (const lang of ['en', 'pt-BR']) {
    const html = renderGainPanel(gain, localizer(lang), fmtMs, esc, lang)
    assert.doesNotMatch(html, /<input|<button|data-gain-minutes|gain-human|Human estimate|Estimativa humana/)
    assert.match(html, /Estimated savings|Economia estimada/)
    assert.match(html, /measured sequential work plus estimated manual coordination|trabalho sequencial aferido.*coordenação manual estimada/)
    assert.match(html, /union of recorded activity intervals|união dos intervalos de atividade registrados/)
  }
})

test('apenas disparos de planejamento execução e revisão entram na estimativa', () => {
  const options = { events: [
    { type: 'task_start', at: '2026-01-01T00:00:00Z' },
    { type: 'task_validation_started', at: '2026-01-01T00:01:00Z' },
    { type: 'task_validate', at: '2026-01-01T00:01:01Z' },
    { type: 'phase_eligible', at: '2026-01-01T00:01:02Z' },
    { type: 'task_retry', at: '2026-01-01T00:02:00Z' },
    { type: 'task_note', at: '2026-01-01T00:03:01Z' },
  ], commandMetrics: { startedAt: '2026-01-01T00:03:00Z', complete: false, byCommand: { note: 1, status: 2, 'plan-phase': 1, 'begin-discussion': 1, validate: 1 } } }
  const gain = calculateGain({ per: [{ spans: [['exec', 0, 60_000]] }] }, {}, true, options)
  assert.equal(gain.commandTotal, 2)
  assert.deepEqual(gain.commandCounts, { planning: 1, execution: 1, review: 0 })
  assert.equal(gain.commandsByName.note, undefined, 'notas não contribuem para a estimativa')
  assert.equal(gain.commandsByName.validate, undefined, 'comandos técnicos ficam fora da estimativa')
  assert.equal(gain.manualCoordinationMs, 6 * 60_000)
  assert.equal(gain.savingsMs, 0)
  assert.equal(gain.combinedEstimateMs, 6 * 60_000)
  assert.equal(gain.commandsComplete, false)
})

test('registro completo mantém comandos com falha e não duplica tentativas sem eventos', () => {
  const result = commandMetricsForRun({ T1: { attempts: [{}, {}] } }, { commandMetrics: { complete: true, byCommand: { init: 1, retry: 1, validate: 2, status: 3, constructor: 1 } } })
  assert.equal(result.total, 8)
  assert.equal(result.counts.execution, 0)
  assert.equal(result.counts.retry, 1)
  assert.equal(result.complete, true)
})

test('fase gera um comando de planejamento e ganho combinado nunca é apresentado como medição', () => {
  const gain = calculateGain({ per: [{ spans: [['exec', 0, 60_000]] }, { spans: [['exec', 0, 60_000]] }] }, {}, true, { events: [{ type: 'phase_planning', at: '2026-01-01T00:00:00Z' }, { type: 'task_note', at: '2026-01-01T00:01:00Z' }] })
  assert.equal(gain.commandTotal, 1)
  assert.equal(gain.commandCounts.planning, 1)
  assert.equal(gain.savingsMs, 60_000)
  assert.equal(gain.combinedEstimateMs, 240_000)
  const html = renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.match(html, /Economia estimada<\/span><strong>4m00<\/strong>/)
  assert.match(html, /Premissa fixa de 3 minutos por comando/)
  assert.match(html, /No prumo/)
  const widths = [...html.matchAll(/width:([\d.]+)%/g)].map(match => Number(match[1]))
  assert.equal(widths[0], 100, 'Sem prumo ocupa toda a base')
  assert.ok(Math.abs(widths.slice(1, 4).reduce((sum, width) => sum + width, 0) - 100) < 0.02, 'as parcelas usam a mesma escala sem exceder a barra')
})

test('manualEstimate por tarefa soma minutos válidos, ignora o resto em silêncio e sai rotulado como estimativa', () => {
  assert.equal(taskManualEstimateMinutes({ manualEstimate: 45 }), 45)
  assert.equal(taskManualEstimateMinutes({ manualEstimate: '30' }), 30)
  for (const value of [undefined, null, -5, 'PT4H', '4h', NaN, Infinity, {}, []]) assert.equal(taskManualEstimateMinutes({ manualEstimate: value }), null)
  assert.equal(taskManualEstimateMinutes(null), null)

  const analysis = { per: [{ id: 'A', spans: spans(['exec', 0, 60_000]) }, { id: 'B', spans: spans(['exec', 0, 60_000]) }] }
  const tasks = {
    A: { state: 'done', manualEstimate: 120 }, B: { state: 'done', manualEstimate: 'oops' },
    C: { state: 'done', manualEstimate: 30 }, S: { state: 'skipped', manualEstimate: 999 },
  }
  const gain = calculateGain(analysis, tasks, true)
  assert.equal(gain.humanEstimateMs, 150 * 60_000, 'skipped tasks and invalid values stay out')
  assert.equal(gain.humanEstimateTasks, 2)
  assert.equal(gain.countedTasks, 3)
  for (const [lang, label, badge, coverage] of [
    ['en', /Human estimate: 2h30/, /estimate · not measured/, /for 2 of 3 tasks\. It is not a measurement\./],
    ['pt-BR', /Estimativa humana: 2h30/, /estimativa · não é medição/, /para 2 de 3 tarefas\. Não é medição\./],
  ]) {
    const html = renderGainPanel(gain, localizer(lang), fmtMs, esc, lang)
    assert.match(html, label)
    assert.match(html, badge)
    assert.match(html, coverage)
    assert.match(html, /class="gain-human" data-kind="estimate"/)
    assert.doesNotMatch(html, /<input|data-gain-minutes/)
  }
})

test('ganho com bloqueio e tarefas paralelas: bloqueio fora das contas, paralelo conta uma vez', () => {
  // A trabalha 0–10s, fica bloqueada 10–40s (sem span) e volta 40–50s; B roda em paralelo 5–25s.
  const analysis = {
    per: [
      { id: 'A', spans: spans(['exec', 0, 10_000], ['exec', 40_000, 50_000]), blocks: [[10_000, 40_000]] },
      { id: 'B', spans: spans(['exec', 5_000, 20_000], ['review', 20_000, 25_000]) },
    ],
    cpLen: 20_000, criticalPathMeasured: true, anyLive: false,
  }
  const gain = calculateGain(analysis, { A: { state: 'done' }, B: { state: 'done' } }, true)
  assert.equal(gain.oneAtATimeMs, 40_000, 'one at a time sums each task: 20s + 20s')
  assert.equal(gain.withPrumoMs, 35_000, 'with Prumo is the union 0–25s + 40–50s; the block is excluded')
  assert.equal(gain.savingsMs, 5_000)
  assert.equal(gain.factor, 40_000 / 35_000)
  assert.equal(gain.criticalPathMs, 20_000)
  assert.equal(gain.runActive, false)
  const html = renderGainPanel(gain, localizer('en'), fmtMs, esc, 'en')
  assert.doesNotMatch(html, /gain-status|Run completed/)
  assert.match(html, /class="gain-bars"/)
  assert.match(html, /<i class="par" style="width:87\.50%"><\/i><i class="save" style="width:12\.50%"><\/i>/, 'bars share one scale')
})

test('renderização escapa o catálogo e o builder injeta somente helpers gerados', () => {
  const gain = calculateGain({ per: [], anyLive: false }, {})
  const hostile = (key, ...values) => key === 'Parallel gain' ? '<script>bad()</script>' : localizer('en')(key, ...values)
  const html = renderGainPanel(gain, hostile, fmtMs, esc, 'en')
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>bad/)

  const dashboard = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.match(dashboard, /\/\*PRUMO_GAIN_HELPERS_START\*\/[\s\S]*function calculateGain\([\s\S]*function renderGainPanel\([\s\S]*\/\*PRUMO_GAIN_HELPERS_END\*\//)
  const script = dashboard.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, 'dashboard inline script exists')
  assert.doesNotThrow(() => new vm.Script(script), 'the generated browser script parses')
})

test('a estimativa humana só ganha barra contra o tempo aferido das mesmas tarefas', () => {
  // 4 tarefas aferidas (10 min cada); só A e B têm estimativa, de 30 min cada.
  const analysis = { per: ['A', 'B', 'C', 'D'].map((id) => ({ id, spans: spans(['exec', 0, 600_000]) })) }
  const tasks = { A: { state: 'done', manualEstimate: 30 }, B: { state: 'done', manualEstimate: 30 }, C: { state: 'done' }, D: { state: 'done' } }
  const gain = calculateGain(analysis, tasks, true)
  assert.equal(gain.oneAtATimeMs, 2_400_000)
  assert.equal(gain.humanComparedMs, 1_200_000, 'only the estimated tasks enter the comparison')
  const html = renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  const [measuredBars, humanBlock] = html.split('class="gain-human"')
  assert.match(measuredBars, /Economia estimada/, 'a estimativa global é identificada separadamente')
  assert.match(humanBlock, /estimativa · não é medição/)
  assert.match(humanBlock, /class="est" style="width:100\.00%"[\s\S]*Agentes nas mesmas tarefas[\s\S]*class="seq" style="width:33\.33%"/)

  // Se uma tarefa estimada não tem tempo aferido, não há base comparável: sem barra, só o texto rotulado.
  const partial = calculateGain({ per: [{ id: 'A', spans: spans(['exec', 0, 600_000]) }, { id: 'B', spans: [] }] }, tasks, true)
  assert.equal(partial.humanComparedMs, null)
  const partialHtml = renderGainPanel(partial, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.match(partialHtml, /Estimativa humana: 1h00/)
  assert.doesNotMatch(partialHtml, /Agentes nas mesmas tarefas/)
})

test('coordenação manual estima 3 min fixos por comando, separada da economia aferida', () => {
  const analysis = { per: [{ id: 'A', spans: spans(['exec', 0, 60_000]) }, { id: 'B', spans: spans(['exec', 0, 60_000]) }] }
  const tasks = {
    A: { state: 'done', attempts: [{ reviewStartedAt: 'x' }, { reviewStartedAt: 'y' }, {}], validations: [{ by: 'review' }] },
    B: { state: 'done', attempts: [{}], validations: [{ by: 'review' }, { by: 'executor' }] },
  }
  const gain = calculateGain(analysis, tasks, true)
  assert.deepEqual(gain.commandCounts, { planning: 0, execution: 2, review: 3 }, 'a coordenação de retentativas não entra na estimativa')
  assert.equal(gain.commandTotal, 5)
  assert.equal(gain.minutesPerCommand, 3)
  assert.equal(gain.manualCoordinationMs, 15 * 60_000)
  assert.equal(gain.retryScenarioMs, undefined)
  assert.equal(gain.savingsMs, 60_000, 'the estimate never changes the measured savings')
  for (const [lang, lead, note] of [
    ['en', /If you had to dispatch and re-dispatch every command by hand, you would spend about <strong>15m00<\/strong> just coordinating the agents \(3 min per command × 5 commands\)\./,
      /<strong>Fixed assumption of 3 minutes per command<\/strong>/],
    ['pt-BR', /Se você tivesse que disparar e redisparar cada comando manualmente, gastaria cerca de <strong>15m00<\/strong> só coordenando os agentes \(3 min por comando × 5 comandos\)\./,
      /<strong>Premissa fixa de 3 minutos por comando<\/strong>/],
  ]) {
    const html = renderManualCoordination(gain, localizer(lang), fmtMs, esc)
    assert.match(html, lead)
    assert.doesNotMatch(html, /class="gain-badge"/)
    assert.match(html, note)
    assert.doesNotMatch(html, /manual-scenario/)
    assert.doesNotMatch(html, /Retry coordination|Coordenação de novas tentativas|Discussion command|Comandos de discussão|Other commands|Demais comandos/)
    assert.doesNotMatch(html, /<td>retry<\/td>/)
    assert.doesNotMatch(html, /<input|<button|data-gain-minutes/, 'no editable assumptions and no +/- buttons')
    assert.match(renderGainPanel(gain, localizer(lang), fmtMs, esc, lang), /15m00/, 'a barra principal inclui a estimativa identificada')
  }

  const single = calculateGain({ per: [] }, { A: { attempts: [{}] } }, true)
  assert.match(renderManualCoordination(single, localizer('pt-BR'), fmtMs, esc), /<strong>3m00<\/strong>[^<]*\(3 min por comando × 1 comando\)/)
  assert.doesNotMatch(renderManualCoordination(single, localizer('en'), fmtMs, esc), /manual-scenario/, 'no retry, no scenario line')

  const empty = renderManualCoordination(calculateGain({ per: [] }, {}, true), localizer('en'), fmtMs, esc)
  assert.match(empty, /No command recorded yet; there is nothing to estimate\./)
  assert.match(renderManualCoordination(calculateGain({ per: [] }, {}, true), localizer('pt-BR'), fmtMs, esc),
    /Nenhum comando registrado ainda/)
  assert.equal((empty.match(/<div><span>/g) ?? []).length, 3, 'os três papéis aparecem também quando não há comandos')

  const hostile = (key, ...values) => key === 'Manual coordination estimate' ? '<script>bad()</script>' : localizer('en')(key, ...values)
  assert.doesNotMatch(renderManualCoordination(gain, hostile, fmtMs, esc), /<script>bad/)
})
