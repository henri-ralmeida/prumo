/** Lê a estimativa humana opcional de uma tarefa (minutos); qualquer outro formato é ignorado em silêncio. */
export function taskManualEstimateMinutes(task) {
  const value = task?.manualEstimate
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : null
}

/** Calcula o ganho técnico somente com intervalos de atividade registrados, nunca com envelopes de tempo decorrido. */
export function calculateGain(analysis, tasks = {}, eventsComplete = false) {
  // Os intervalos atuais de planejamento têm apenas início e fim, sem telemetria de trabalho ativo.
  const activeKinds = new Set(['exec', 'review'])
  const mergeDuration = (intervals) => {
    const ordered = intervals
      .filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to) && to > from)
      .sort((left, right) => left[0] - right[0] || left[1] - right[1])
    let total = 0, from = null, to = null
    for (const [nextFrom, nextTo] of ordered) {
      if (from == null) { from = nextFrom; to = nextTo; continue }
      if (nextFrom <= to) to = Math.max(to, nextTo)
      else { total += to - from; from = nextFrom; to = nextTo }
    }
    return from == null ? 0 : total + to - from
  }
  const per = Array.isArray(analysis?.per) ? analysis.per : []
  const taskIntervals = per.map((item) => (item.spans ?? [])
    .filter(([kind, from, to]) => activeKinds.has(kind) && Number.isFinite(from) && Number.isFinite(to) && to > from)
    .map(([, from, to]) => [from, to]))
  const oneAtATimeMs = taskIntervals.reduce((total, intervals) => total + mergeDuration(intervals), 0)
  const withPrumoMs = mergeDuration(taskIntervals.flat())
  const historyComplete = eventsComplete === true
  const measured = historyComplete && oneAtATimeMs > 0 && withPrumoMs > 0
  const rawCriticalPathMs = Number.isFinite(analysis?.cpLen) && analysis.cpLen > 0 ? analysis.cpLen : null
  const unmeasuredPlanning = per.some((item) => (item.spans ?? []).some(([kind]) => kind === 'plan')) ||
    (analysis?.phasePlanning ?? []).some((attempt) => attempt.duration > 0)
  // O caminho crítico não pode exceder o trabalho aferido dos agentes. Se exceder,
  // a fonte ainda contém um envelope não aferido; omita-o se o planejamento puder contaminá-lo.
  const criticalPathMs = historyComplete && analysis?.criticalPathMeasured === true &&
    !unmeasuredPlanning && rawCriticalPathMs != null && rawCriticalPathMs <= oneAtATimeMs
    ? rawCriticalPathMs : null

  // Estimativa humana: só existe quando o plano traz manualEstimate; nunca é derivada do tempo dos agentes.
  const countedEntries = Object.entries(tasks ?? {}).filter(([, task]) => task?.state !== 'skipped')
  const counted = countedEntries.map(([, task]) => task)
  const estimatedIds = new Set(countedEntries.filter(([, task]) => taskManualEstimateMinutes(task) != null).map(([id]) => id))
  const estimates = counted.map(taskManualEstimateMinutes).filter((minutes) => minutes != null)
  const humanEstimateMs = estimates.length ? estimates.reduce((total, minutes) => total + minutes, 0) * 60_000 : null
  // A comparação visual usa só o tempo aferido das MESMAS tarefas estimadas, e só quando todas foram aferidas.
  const sameTaskTimes = per.map((item, index) => [item?.id, mergeDuration(taskIntervals[index])])
    .filter(([id, ms]) => estimatedIds.has(id) && ms > 0)
  const humanComparedMs = measured && estimatedIds.size > 0 && sameTaskTimes.length === estimatedIds.size
    ? sameTaskTimes.reduce((total, [, ms]) => total + ms, 0) : null

  return {
    oneAtATimeMs: measured ? oneAtATimeMs : null,
    withPrumoMs: measured ? withPrumoMs : null,
    savingsMs: measured ? Math.max(0, oneAtATimeMs - withPrumoMs) : null,
    factor: measured ? oneAtATimeMs / withPrumoMs : null,
    criticalPathMs,
    partial: Boolean(!historyComplete || analysis?.unmeasuredActivity || per.some((item) => item.unmeasured || (item.spans ?? []).some(([kind]) => kind === 'plan')) || analysis?.phasePlanning?.length),
    runActive: Boolean(analysis?.anyLive),
    historyComplete,
    humanEstimateMs,
    humanEstimateTasks: estimates.length,
    humanComparedMs,
    countedTasks: counted.length,
  }
}

/** Renderiza o cartão de ganho com o tradutor, formatador e escapador de HTML do dashboard. */
export function renderGainPanel(gain, tr, fmtMs, esc, locale = 'en') {
  const shown = (value) => esc(value == null ? tr('Not measured') : fmtMs(value))
  const factor = gain.factor == null ? tr('Not measured') : `${gain.factor.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`
  const status = gain.runActive ? tr('so far') : tr('Run completed')
  const stateNote = !gain.historyComplete
    ? tr('Event history is incomplete; technical gain is not measured.')
    : gain.oneAtATimeMs == null
    ? tr('No recorded agent activity is available for a technical gain calculation.')
    : gain.partial
      ? tr('Only evidenced activity intervals are counted; unmeasured periods are omitted.')
      : tr('Only evidenced activity intervals are counted; waiting time is excluded.')
  const critical = gain.criticalPathMs == null ? ''
    : `<p class="gline gain-critical"><b>${esc(tr('Critical path'))}:</b> ${shown(gain.criticalPathMs)} · ${esc(tr('lower limit from measured dependent work'))}</p>`
  const ratio = (scale) => (value) => scale > 0 && value > 0 ? Math.max(0.5, Math.min(100, (100 * value) / scale)).toFixed(2) : '0'
  // A estimativa só ganha barra frente ao tempo aferido das mesmas tarefas; nunca na escala da execução inteira.
  const humanScale = ratio(Math.max(gain.humanEstimateMs ?? 0, gain.humanComparedMs ?? 0))
  const humanBars = gain.humanComparedMs == null ? '' : `<div class="gain-bars" aria-hidden="true">
      <div class="gbar"><span>${esc(tr('Human estimate'))}</span><span class="gbar-track"><i class="est" style="width:${humanScale(gain.humanEstimateMs)}%"></i></span></div>
      <div class="gbar"><span>${esc(tr('Agents on the same tasks'))}</span><span class="gbar-track"><i class="seq" style="width:${humanScale(gain.humanComparedMs)}%"></i></span></div></div>`
  const human = gain.humanEstimateMs == null ? ''
    : `<div class="gain-human" data-kind="estimate"><span class="gain-badge">${esc(tr('estimate · not measured'))}</span>
      <p><b>${esc(tr('Human estimate'))}: ${esc(fmtMs(gain.humanEstimateMs))}</b> ${esc(tr('Sum of the manual estimates recorded in the plan for {0} of {1} tasks. It is not a measurement.', gain.humanEstimateTasks, gain.countedTasks))}</p>${humanBars}</div>`
  // Barras proporcionais do tempo aferido: escala da execução inteira, sem a estimativa.
  const pct = ratio(gain.oneAtATimeMs ?? 0)
  const bars = gain.oneAtATimeMs == null || !(gain.oneAtATimeMs > 0) ? '' : `<div class="gain-bars" aria-hidden="true">
      <div class="gbar"><span>${esc(tr('One agent at a time'))}</span><span class="gbar-track"><i class="seq" style="width:${pct(gain.oneAtATimeMs)}%"></i></span></div>
      <div class="gbar"><span>${esc(tr('With Prumo'))}</span><span class="gbar-track"><i class="par" style="width:${pct(gain.withPrumoMs)}%"></i><i class="save" style="width:${pct(gain.savingsMs)}%"></i></span></div>
    </div>`
  return `<section class="gcard gain" id="gainPanel" aria-labelledby="gainTitle">
    <div class="gh"><b id="gainTitle">${esc(tr('Parallel gain'))}</b><span class="gain-status${gain.runActive ? ' live' : ''}">${esc(status)}</span></div>
    <div class="gain-grid">
      <div><span>${esc(tr('One agent at a time'))}</span><strong>${shown(gain.oneAtATimeMs)}</strong><small>${esc(tr('sum of recorded agent intervals'))}</small></div>
      <div><span>${esc(tr('With Prumo'))}</span><strong>${shown(gain.withPrumoMs)}</strong><small>${esc(tr('union of recorded activity intervals; overlaps count once'))}</small></div>
      <div class="gain-save"><span>${esc(tr('Measured savings'))}</span><strong>${shown(gain.savingsMs)}</strong></div>
      <div><span>${esc(tr('Parallel factor'))}</span><strong>${esc(factor)}</strong></div>
    </div>
    ${bars}
    ${critical}
    ${human}
    <p class="gline gain-note">${esc(stateNote)}</p>
  </section>`
}
