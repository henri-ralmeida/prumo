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

  // Coordenação manual: estimativa fixa de 3 min por comando, contada a partir das tentativas e revisões registradas.
  // Nunca entra na economia aferida; é um cenário, não uma medição.
  const minutesPerCommand = 3
  // Cada nova tentativa evitada poupa três comandos: a reexecução, a revisão dela e a própria coordenação do retry.
  const commandsPerRetry = 3
  let executionCount = 0, reviewCount = 0, retryCount = 0
  for (const task of Object.values(tasks ?? {})) {
    const attempts = Array.isArray(task?.attempts) ? task.attempts : []
    executionCount += attempts.length
    retryCount += Math.max(0, attempts.length - 1)
    const reviewVerdicts = Array.isArray(task?.validations) ? task.validations.filter((item) => item?.by === 'review').length : 0
    reviewCount += Math.max(reviewVerdicts, attempts.filter((attempt) => attempt?.reviewStartedAt).length)
  }
  const commandCounts = { execution: executionCount, review: reviewCount, retry: retryCount }
  const commandTotal = executionCount + reviewCount + retryCount

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
    minutesPerCommand,
    commandCounts,
    commandTotal,
    manualCoordinationMs: commandTotal * minutesPerCommand * 60_000,
    retryScenarioMs: retryCount > 0 ? retryCount * commandsPerRetry * minutesPerCommand * 60_000 : null,
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

/** Renderiza a estimativa de coordenação manual (3 min fixos por comando), separada do ganho aferido. */
export function renderManualCoordination(gain, tr, fmtMs, esc) {
  const counts = gain.commandCounts ?? { execution: 0, review: 0, retry: 0 }
  const total = gain.commandTotal ?? 0
  const minutes = gain.minutesPerCommand ?? 3
  const mark = '\u0001'
  const headline = total > 0
    ? esc(tr(total === 1
      ? 'If you had to dispatch and re-dispatch every command by hand, you would spend about {0} just coordinating the agents ({1} min per command × 1 command).'
      : 'If you had to dispatch and re-dispatch every command by hand, you would spend about {0} just coordinating the agents ({1} min per command × {2} commands).',
      mark, minutes, total)).replace(mark, `<strong>${esc(fmtMs(gain.manualCoordinationMs))}</strong>`)
    : esc(tr('No execution, review or retry command recorded yet; there is nothing to estimate.'))
  const commands = (count) => count === 1 ? tr('1 command') : tr('{0} commands', count)
  const breakdown = total > 0 ? `<div class="manual-counts">${[
    ['execution', 'Execution command'], ['review', 'Review command'], ['retry', 'Retry coordination'],
  ].map(([kind, label]) => `<div><span>${esc(tr(label))}</span><b>${esc(commands(counts[kind] ?? 0))}</b><small>${esc(fmtMs((counts[kind] ?? 0) * minutes * 60_000))}</small></div>`).join('')}</div>` : ''
  const scenario = gain.retryScenarioMs == null ? ''
    : `<p class="gline manual-scenario">${esc(tr('Scenario only: if planning avoided all recorded retries, estimated manual coordination avoided would be {0}.', fmtMs(gain.retryScenarioMs)))} ${esc(tr('This is hypothetical and is excluded from measured savings.'))}</p>`
  return `<section class="gcard manual" id="manualPanel" aria-labelledby="manualTitle">
    <div class="gh"><b id="manualTitle">${esc(tr('Manual coordination estimate'))}</b><span class="gain-badge">${esc(tr('ESTIMATE · not a measurement'))}</span></div>
    <p class="manual-lead">${headline}</p>
    ${breakdown}
    ${scenario}
    <p class="gline gain-note">${esc(tr('Fixed assumption of {0} min per command. It is not added to the measured savings above.', minutes))}</p>
  </section>`
}
