import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createTranslator, messages } from '../scripts/i18n.mjs'
import { DEFAULT_GAIN_ASSUMPTIONS, calculateGain, gainAssumptionKey, renderGainPanel } from '../scripts/dashboard-gains.mjs'

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
  const gain = calculateGain(analysis, tasks, { execution: 5, review: 2, retry: 3 }, true)
  assert.equal(gain.oneAtATimeMs, 40_000)
  assert.equal(gain.withPrumoMs, 35_000)
  assert.equal(gain.savingsMs, 5_000)
  assert.equal(gain.factor, 40_000 / 35_000)
  assert.equal(gain.criticalPathMs, null, 'an unmeasured planning envelope cannot leak into the critical path')
  assert.equal(gain.partial, true, 'planning envelopes without progress telemetry are marked as unmeasured')
  assert.deepEqual(gain.eventCounts, { execution: 3, review: 3, retry: 1 })
  assert.equal(gain.manualEstimateMs, 24 * 60_000)
  assert.equal(gain.retryScenarioMs, 10 * 60_000)
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
  }, { A: { attempts: [], validations: [] } }, DEFAULT_GAIN_ASSUMPTIONS, true)
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
  }, { A: { planningAttempts: [{ startedAt: 1_000, endedAt: 1_000 + elapsed }], attempts: [], validations: [] } }, DEFAULT_GAIN_ASSUMPTIONS, true)
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
  }, { T: { attempts: [{ startedAt: 1_000, endedAt: fourHours }], validations: [{ by: 'review', at: 21_000 }] } }, DEFAULT_GAIN_ASSUMPTIONS, true)
  assert.equal(gain.oneAtATimeMs, 20_000)
  assert.equal(gain.withPrumoMs, 20_000)
  assert.equal(gain.savingsMs, 0)
  assert.equal(gain.criticalPathMs, 20_000)
  const html = renderGainPanel(gain, localizer('en'), fmtMs, esc, 'en')
  assert.match(html, /20s/)
  assert.match(html, /completed/)
  assert.doesNotMatch(html, /4h/)
  const htmlPt = renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.match(htmlPt, /<span>execução concluída<\/span>/)
  assert.doesNotMatch(htmlPt, /<span>concluídas<\/span>/)
})

test('lacuna de atividade torna caminho crítico não aferido mesmo com histórico completo', () => {
  const elapsed = 115 * 60 * 60_000
  const gain = calculateGain({
    per: [{ id: 'T', agentTime: 20_000, spans: spans(['exec', 1_000, 21_000]) }],
    cpLen: elapsed,
    criticalPathMeasured: false,
    unmeasuredActivity: true,
  }, { T: { attempts: [{}], validations: [] } }, DEFAULT_GAIN_ASSUMPTIONS, true)
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
  }, { T: { attempts: [{}], validations: [] } }, DEFAULT_GAIN_ASSUMPTIONS, true)
  assert.equal(gain.oneAtATimeMs, null)
  assert.equal(gain.withPrumoMs, null)
  assert.equal(gain.savingsMs, null)
  assert.equal(gain.factor, null)
  assert.equal(gain.retryScenarioMs, null)
  const html = renderGainPanel(gain, localizer('pt-BR'), fmtMs, esc, 'pt-BR')
  assert.match(html, /até agora/)
  assert.match(html, /Não aferido/)
  assert.match(html, /não há atividade de agente registrada suficiente/i)
  assert.match(html, /0 eventos/)
  assert.doesNotMatch(html.slice(0, html.indexOf('<div class="gain-human">')), /115h|0s/)
})

test('contagens e cenários humanos usam tarefas sem manualEstimate e distinguem ausência de retry', () => {
  const analysis = { per: [{ id: 'T', spans: spans(['exec', 0, 10_000]) }], cpLen: 10_000 }
  const gain = calculateGain(analysis, { T: { attempts: [{}], validations: [{ by: 'review', ok: true }] } }, DEFAULT_GAIN_ASSUMPTIONS, true)
  assert.deepEqual(gain.perEventMinutes, DEFAULT_GAIN_ASSUMPTIONS)
  assert.deepEqual(gain.eventCounts, { execution: 1, review: 1, retry: 0 })
  assert.equal(gain.manualEstimateMs, 8 * 60_000)
  assert.equal(gain.retryScenarioMs, null)
  for (const lang of ['en', 'pt-BR']) {
    const html = renderGainPanel(gain, localizer(lang), fmtMs, esc, lang)
    assert.match(html, /ESTIMATE|ESTIMATIVA/)
    assert.match(html, /Execution command|Comando de execução/)
    assert.match(html, /Review command|Comando de revisão/)
    assert.match(html, /Retry coordination|Coordenação de retry/)
    assert.match(html, /No retries recorded|Nenhum retry registrado/)
    assert.match(html, /data-gain-minutes="execution" oninput="updateGainEstimate\(\)" onchange="updateGainEstimate\(\)"/)
    assert.match(html, /value="5"/)
    assert.match(html, /sum of recorded agent intervals|soma dos intervalos registrados dos agentes/)
    assert.match(html, /union of recorded activity intervals|união dos intervalos de atividade registrados/)
  }
})

test('estimativas recalculadas anunciam mudanças para leitores de tela', () => {
  const gain = calculateGain({ per: [{ id: 'T', spans: spans(['exec', 0, 10_000]) }] }, {}, DEFAULT_GAIN_ASSUMPTIONS, true)
  const html = renderGainPanel(gain, localizer('en'), fmtMs, esc, 'en')
  for (const id of ['gainExecutionSummary', 'gainReviewSummary', 'gainRetrySummary', 'gainManualTotal', 'gainScenario']) {
    assert.match(html, new RegExp(`(?:<small|<strong|<div) id="${id}" aria-live="polite" aria-atomic="true"`))
  }
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

test('premissas do mesmo run ficam separadas por root', () => {
  assert.notEqual(gainAssumptionKey('root-a', 'same-run'), gainAssumptionKey('root-b', 'same-run'))
  assert.notEqual(gainAssumptionKey('root-a', 'run-a'), gainAssumptionKey('root-a', 'run-b'))
  assert.equal(gainAssumptionKey(undefined, 'same-run'), gainAssumptionKey('default', 'same-run'))
})
