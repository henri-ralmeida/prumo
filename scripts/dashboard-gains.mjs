export const DEFAULT_GAIN_ASSUMPTIONS = Object.freeze({ execution: 5, review: 3, retry: 3 })

export function gainAssumptionKey(root, run) {
  return 'prumo.gain-assumptions.v1:' + encodeURIComponent(String(root ?? 'default')) + ':' + encodeURIComponent(String(run ?? ''))
}

/** Calcula o ganho técnico somente com intervalos de atividade registrados, nunca com envelopes de tempo decorrido. */
export function calculateGain(analysis, tasks = {}, assumptions = DEFAULT_GAIN_ASSUMPTIONS, eventsComplete = false) {
  // Os intervalos atuais de planejamento têm apenas início e fim, sem telemetria de trabalho ativo.
  const activeKinds = new Set(['exec', 'review'])
  const maxMinutesPerEvent = 1440
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
  const minutes = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0
      ? Math.min(maxMinutesPerEvent, number)
      : fallback
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

  const values = Object.values(tasks ?? {})
  let executionCount = 0, reviewCount = 0, retryCount = 0
  for (const task of values) {
    const attempts = Array.isArray(task?.attempts) ? task.attempts.length : 0
    executionCount += attempts
    retryCount += Math.max(0, attempts - 1)
    const reviewVerdicts = Array.isArray(task?.validations) ? task.validations.filter((item) => item?.by === 'review').length : 0
    const reviewDispatches = Array.isArray(task?.attempts) ? task.attempts.filter((attempt) => attempt?.reviewStartedAt).length : 0
    reviewCount += Math.max(reviewVerdicts, reviewDispatches)
  }
  const eventCounts = { execution: executionCount, review: reviewCount, retry: retryCount }
  const perEventMinutes = {
    execution: minutes(assumptions?.execution, DEFAULT_GAIN_ASSUMPTIONS.execution),
    review: minutes(assumptions?.review, DEFAULT_GAIN_ASSUMPTIONS.review),
    retry: minutes(assumptions?.retry, DEFAULT_GAIN_ASSUMPTIONS.retry),
  }
  const estimatesMs = Object.fromEntries(Object.keys(eventCounts).map((kind) =>
    [kind, eventCounts[kind] * perEventMinutes[kind] * 60_000]))
  const manualEstimateMs = Object.values(estimatesMs).reduce((total, value) => total + value, 0)
  const retryScenarioMs = retryCount > 0
    ? retryCount * (perEventMinutes.execution + perEventMinutes.review + perEventMinutes.retry) * 60_000
    : null

  return {
    oneAtATimeMs: measured ? oneAtATimeMs : null,
    withPrumoMs: measured ? withPrumoMs : null,
    savingsMs: measured ? Math.max(0, oneAtATimeMs - withPrumoMs) : null,
    factor: measured ? oneAtATimeMs / withPrumoMs : null,
    criticalPathMs,
    partial: Boolean(!historyComplete || analysis?.unmeasuredActivity || per.some((item) => item.unmeasured || (item.spans ?? []).some(([kind]) => kind === 'plan')) || analysis?.phasePlanning?.length),
    runActive: Boolean(analysis?.anyLive),
    historyComplete,
    eventCounts,
    perEventMinutes,
    estimatesMs,
    manualEstimateMs,
    retryScenarioMs,
  }
}

/** Renderiza o cartão de ganho com o tradutor, formatador e escapador de HTML do dashboard. */
export function renderGainPanel(gain, tr, fmtMs, esc, locale = 'en') {
  const maxMinutesPerEvent = 1440
  const eventCount = (count) => count === 1 ? tr('1 event') : tr('{0} events', count)
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
  const scenario = gain.retryScenarioMs == null
    ? `<p class="gain-scenario">${esc(tr('No retries recorded; no planning scenario is estimated.'))}</p>`
    : `<p class="gain-scenario">${esc(tr('Scenario only: if planning avoided all recorded retries, estimated manual coordination avoided would be {0}.', fmtMs(gain.retryScenarioMs)))} ${esc(tr('This is hypothetical and is excluded from measured savings.'))}</p>`
  const fields = [
    ['execution', 'Execution command', gain.eventCounts.execution],
    ['review', 'Review command', gain.eventCounts.review],
    ['retry', 'Retry coordination', gain.eventCounts.retry],
  ].map(([kind, label]) => `<label class="gain-input">${esc(tr(label))}<span><input type="number" min="0" max="${maxMinutesPerEvent}" step="1" value="${gain.perEventMinutes[kind]}" aria-label="${esc(tr('Minutes per event for {0}', tr(label)))}" data-gain-minutes="${kind}" oninput="updateGainEstimate()" onchange="updateGainEstimate()"> ${esc(tr('min / event'))}</span><small id="gain${kind[0].toUpperCase()}${kind.slice(1)}Summary" aria-live="polite" aria-atomic="true">${esc(eventCount(gain.eventCounts[kind]))} · ${esc(fmtMs(gain.estimatesMs[kind]))}</small></label>`).join('')
  return `<section class="gcard gain" id="gainPanel">
    <div class="gh"><b>${esc(tr('Parallel gain'))}</b><span>${esc(status)}</span></div>
    <div class="gain-grid">
      <div><span>${esc(tr('One agent at a time'))}</span><strong>${shown(gain.oneAtATimeMs)}</strong><small>${esc(tr('sum of recorded agent intervals'))}</small></div>
      <div><span>${esc(tr('With Prumo'))}</span><strong>${shown(gain.withPrumoMs)}</strong><small>${esc(tr('union of recorded activity intervals; overlaps count once'))}</small></div>
      <div><span>${esc(tr('Measured savings'))}</span><strong>${shown(gain.savingsMs)}</strong></div>
      <div><span>${esc(tr('Parallel factor'))}</span><strong>${esc(factor)}</strong></div>
    </div>
    ${critical}
    <p class="gline gain-note">${esc(stateNote)}</p>
    <div class="gain-human">
      <div class="gh"><b>${esc(tr('Manual coordination estimate'))}</b><span class="gain-badge">${esc(tr('ESTIMATE · not a measurement'))}</span></div>
      <p class="gline">${esc(tr('Estimated time to write and dispatch execution, review, and retry commands. Counts come from this run; assumptions are editable.'))}</p>
      <div class="gain-inputs">${fields}</div>
      <p class="gain-total"><span>${esc(tr('Estimated manual coordination time'))}</span><strong id="gainManualTotal" aria-live="polite" aria-atomic="true">${esc(fmtMs(gain.manualEstimateMs))}</strong></p>
      <div id="gainScenario" aria-live="polite" aria-atomic="true">${scenario}</div>
    </div>
  </section>`
}

/** Atualiza somente a estimativa para preservar o campo em edição e o foco. */
export function renderGainEstimate(gain, tr, fmtMs, esc) {
  const scenario = gain.retryScenarioMs == null
    ? `<p class="gain-scenario">${esc(tr('No retries recorded; no planning scenario is estimated.'))}</p>`
    : `<p class="gain-scenario">${esc(tr('Scenario only: if planning avoided all recorded retries, estimated manual coordination avoided would be {0}.', fmtMs(gain.retryScenarioMs)))} ${esc(tr('This is hypothetical and is excluded from measured savings.'))}</p>`
  return { total: esc(fmtMs(gain.manualEstimateMs)), scenario }
}
