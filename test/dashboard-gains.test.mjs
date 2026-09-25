import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createTranslator, messages } from '../scripts/i18n.mjs'
import { calculateGain, renderGainPanel, taskManualEstimateMinutes } from '../scripts/dashboard-gains.mjs'

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
  assert.match(html, /so far/)
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
  assert.match(html, /completed/)
  assert.doesNotMatch(html, /4h/)
  const htmlPt = renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.match(htmlPt, /<span class="gain-status">execução concluída<\/span>/)
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
test('sem atividade suficiente mostra não aferido e não fabrica economia, mantendo até agora na run ativa', () => {
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
  assert.match(html, /até agora/)
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
    assert.doesNotMatch(html, /Manual coordination|Coordenação manual|Execution command|Comando de execução|Retry coordination/i)
    assert.match(html, /sum of recorded agent intervals|soma dos intervalos registrados dos agentes/)
    assert.match(html, /union of recorded activity intervals|união dos intervalos de atividade registrados/)
  }
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
  assert.match(html, /Run completed/)
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
  assert.doesNotMatch(measuredBars, /class="est"/, 'the estimate never shares the whole-run scale')
  assert.match(humanBlock, /estimativa · não é medição/)
  assert.match(humanBlock, /class="est" style="width:100\.00%"[\s\S]*Agentes nas mesmas tarefas[\s\S]*class="seq" style="width:33\.33%"/)

  // Se uma tarefa estimada não tem tempo aferido, não há base comparável: sem barra, só o texto rotulado.
  const partial = calculateGain({ per: [{ id: 'A', spans: spans(['exec', 0, 600_000]) }, { id: 'B', spans: [] }] }, tasks, true)
  assert.equal(partial.humanComparedMs, null)
  const partialHtml = renderGainPanel(partial, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.match(partialHtml, /Estimativa humana: 1h00/)
  assert.doesNotMatch(partialHtml, /class="est"|Agentes nas mesmas tarefas/)
})
