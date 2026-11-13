/** Lê a estimativa humana opcional de uma tarefa (minutos); qualquer outro formato é ignorado em silêncio. */
export function taskManualEstimateMinutes(task) {
  const value = task?.manualEstimate
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : null
}

/** Conta comandos registrados, preservando uma cobertura parcial para consultas antigas sem auditoria. */
export function commandMetricsForRun(tasks = {}, options = {}) {
  const byCommand = Object.create(null)
  const add = (name, count = 1) => { if (Number.isSafeInteger(count) && count > 0) byCommand[name] = (byCommand[name] ?? 0) + count }
  const ledger = options.commandMetrics
  const cutoff = Date.parse(ledger?.startedAt)
  const primary = {
    run_init: 'init', plan_sync: 'sync-plan', run_authorized: 'authorize',
    phase_discussion: 'begin-phase-discussion', phase_discussion_skipped: 'skip-phase-discussion', phase_discussed: 'finish-phase-discussion',
    phase_planning: 'plan-phase', phase_planning_skipped: 'skip-phase-planning', phase_planned: 'finish-phase-planning',
    task_discussion: 'begin-discussion', task_discussion_skipped: 'skip-discussion', task_discussed: 'finish-discussion',
    task_planning: 'plan-task', task_planning_skipped: 'skip-planning', task_planned: 'finish-planning',
    task_start: 'start', task_progress: 'progress', task_review: 'review', task_review_progress: 'review-progress',
    activity_start: 'activity-start', activity_stop: 'activity-stop',
    task_contract_refreshed: 'refresh-contract', task_validate: 'validate', task_done: 'done', task_fail: 'fail',
    task_retry: 'retry', task_block: 'block', task_block_updated: 'block', task_unblock: 'unblock', task_skip: 'skip', task_note: 'note',
    task_stages_skipped: 'skip-stages',
  }
  if (Array.isArray(options.events)) {
    for (const event of options.events) {
      if (event.type === 'task_done' && event.completionBy === 'user') continue
      const time = Date.parse(event.at ?? event.ts)
      if (Number.isFinite(cutoff) && (!Number.isFinite(time) || time >= cutoff)) continue
      if (Object.hasOwn(primary, event.type)) add(primary[event.type])
    }
  } else if (!ledger) {
    // Sem eventos, as tentativas fornecem somente uma contagem mínima dos disparos.
    for (const task of Object.values(tasks)) {
      const attempts = task?.attempts ?? []
      const executions = attempts.filter(attempt => attempt.kind !== 'review-only')
      add('start', executions.length > 0 ? 1 : 0)
      add('retry', Math.max(0, executions.length - 1))
      add('review', Math.max((task?.validations ?? []).filter(item => item.by === 'review').length, attempts.filter(item => item.reviewStartedAt).length))
      add('plan-task', (task?.planningAttempts ?? []).length)
      add('begin-discussion', (task?.discussionAttempts ?? []).length)
    }
    for (const phase of Object.values(options.phaseWorkflows ?? {})) {
      add('plan-phase', (phase.planningAttempts ?? []).length)
      add('begin-phase-discussion', (phase.discussionAttempts ?? []).length)
    }
  }
  for (const [name, count] of Object.entries(ledger?.byCommand ?? {})) {
    if (/^[a-z][a-z-]*$/.test(name)) add(name, count)
  }
  const counts = { execution: 0, review: 0, planning: 0, discussion: 0, retry: 0, technical: 0 }
  const categories = { start: 'execution', review: 'review', 'plan-task': 'planning', 'plan-phase': 'planning', 'begin-discussion': 'discussion', 'begin-phase-discussion': 'discussion', retry: 'retry' }
  for (const [name, count] of Object.entries(byCommand)) counts[Object.hasOwn(categories, name) ? categories[name] : 'technical'] += count
  return { byCommand, counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), complete: ledger?.complete === true }
}

/** Calcula o paralelismo aferido sem transformar a premissa manual em trabalho dos agentes. */
export function calculateGain(analysis, tasks = {}, eventsComplete = false, options = {}) {
  // Envelopes legados de planejamento não medem atividade; START/STOP explícitos entram nas quatro funções.
  const activeKinds = new Set(['exec', 'review', 'planning', 'discussion'])
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
  const sharedIntervals = (analysis?.sharedSpans ?? []).filter(([kind, from, to]) => activeKinds.has(kind) && Number.isFinite(from) && Number.isFinite(to) && to > from).map(([, from, to]) => [from, to])
  const oneAtATimeMs = taskIntervals.reduce((total, intervals) => total + mergeDuration(intervals), 0) + sharedIntervals.reduce((total, [from, to]) => total + to - from, 0)
  const withPrumoMs = mergeDuration([...taskIntervals.flat(), ...sharedIntervals])
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
  const countedEntries = Object.entries(tasks ?? {}).filter(([, task]) => task?.state !== 'skipped' && task?.completionDecision?.by !== 'user')
  const counted = countedEntries.map(([, task]) => task)
  const estimatedIds = new Set(countedEntries.filter(([, task]) => taskManualEstimateMinutes(task) != null).map(([id]) => id))
  const estimates = counted.map(taskManualEstimateMinutes).filter((minutes) => minutes != null)
  const humanEstimateMs = estimates.length ? estimates.reduce((total, minutes) => total + minutes, 0) * 60_000 : null
  // A comparação visual usa só o tempo aferido das MESMAS tarefas estimadas, e só quando todas foram aferidas.
  const sameTaskTimes = per.map((item, index) => [item?.id, mergeDuration(taskIntervals[index])])
    .filter(([id, ms]) => estimatedIds.has(id) && ms > 0)
  const humanComparedMs = measured && estimatedIds.size > 0 && sameTaskTimes.length === estimatedIds.size
    ? sameTaskTimes.reduce((total, [, ms]) => total + ms, 0) : null

  // A premissa manual considera somente disparos de planejamento, execução e revisão.
  // Nunca entra na economia aferida; é um cenário, não uma medição.
  const minutesPerCommand = 3
  const commands = commandMetricsForRun(tasks, options)
  const commandCounts = { planning: commands.counts.planning, execution: commands.counts.execution, review: commands.counts.review }
  const commandTotal = commandCounts.planning + commandCounts.execution + commandCounts.review
  const commandsByName = Object.fromEntries(Object.entries(commands.byCommand).filter(([name]) => ['plan-task', 'plan-phase', 'start', 'review'].includes(name)))

  return {
    oneAtATimeMs: measured ? oneAtATimeMs : null,
    withPrumoMs: measured ? withPrumoMs : null,
    savingsMs: measured ? Math.max(0, oneAtATimeMs - withPrumoMs) : null,
    factor: measured ? oneAtATimeMs / withPrumoMs : null,
    criticalPathMs,
    partial: Boolean(!historyComplete || analysis?.unmeasuredActivity || per.some((item) => item.unmeasured || (item.spans ?? []).some(([kind]) => kind === 'plan')) || analysis?.phasePlanning?.some(attempt => attempt.activityTiming !== 'explicit')),
    runActive: Boolean(analysis?.anyLive),
    historyComplete,
    humanEstimateMs,
    humanEstimateTasks: estimates.length,
    humanComparedMs,
    countedTasks: counted.length,
    minutesPerCommand,
    commandCounts,
    commandTotal,
    commandsByName,
    commandsComplete: historyComplete && commands.complete,
    combinedEstimateMs: measured ? Math.max(0, oneAtATimeMs - withPrumoMs) + commandTotal * minutesPerCommand * 60_000 : null,
    manualCoordinationMs: commandTotal * minutesPerCommand * 60_000,
  }
}

/** Renderiza o cartão de ganho com o tradutor, formatador e escapador de HTML do dashboard. */
export function renderGainPanel(gain, tr, fmtMs, esc, locale = 'en') {
  const shown = (value) => esc(value == null ? tr('Not measured') : fmtMs(value))
  const factor = gain.factor == null ? tr('Not measured') : `${gain.factor.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`
  const stateNote = !gain.historyComplete
    ? tr('Event history is incomplete; technical gain is not measured.')
    : gain.oneAtATimeMs == null
    ? tr('No recorded agent activity is available for a technical gain calculation.')
    : gain.partial
      ? tr('Only evidenced activity intervals are counted; unmeasured periods are omitted.')
      : tr('Only evidenced activity intervals are counted; waiting time is excluded.')
  const critical = gain.criticalPathMs == null ? ''
    : `<p class="gline gain-critical"><b>${esc(tr('Critical path'))}:</b> ${shown(gain.criticalPathMs)} · ${esc(tr('lower limit from measured dependent work'))}</p>`
  const ratio = (scale) => (value) => scale > 0 && value > 0 ? Math.min(100, (100 * value) / scale).toFixed(2) : '0'
  // A estimativa só ganha barra frente ao tempo aferido das mesmas tarefas; nunca na escala da execução inteira.
  const humanScale = ratio(Math.max(gain.humanEstimateMs ?? 0, gain.humanComparedMs ?? 0))
  const humanBars = gain.humanComparedMs == null ? '' : `<div class="gain-bars" aria-hidden="true">
      <div class="gbar"><span>${esc(tr('Human estimate'))}</span><span class="gbar-track"><i class="est" style="width:${humanScale(gain.humanEstimateMs)}%"></i></span></div>
      <div class="gbar"><span>${esc(tr('Agents on the same tasks'))}</span><span class="gbar-track"><i class="seq" style="width:${humanScale(gain.humanComparedMs)}%"></i></span></div></div>`
  const human = gain.humanEstimateMs == null ? ''
    : `<div class="gain-human" data-kind="estimate"><span class="gain-badge">${esc(tr('estimate · not measured'))}</span>
      <p><b>${esc(tr('Human estimate'))}: ${esc(fmtMs(gain.humanEstimateMs))}</b> ${esc(tr('Sum of the manual estimates recorded in the plan for {0} of {1} tasks. It is not a measurement.', gain.humanEstimateTasks, gain.countedTasks))}</p>${humanBars}</div>`
  // A base sem Prumo soma trabalho sequencial aferido e coordenação manual estimada.
  // O ganho estimado já inclui o aferido; a barra inferior decompõe a base sem duplicá-lo.
  const baselineMs = gain.oneAtATimeMs == null ? null : gain.oneAtATimeMs + (gain.manualCoordinationMs ?? 0)
  const pct = ratio(baselineMs ?? 0)
  const parallelPct = Number(pct(gain.withPrumoMs))
  const measuredPct = Number(pct(gain.savingsMs))
  const estimatedPct = Math.max(0, 100 - parallelPct - measuredPct).toFixed(2)
  const bars = gain.oneAtATimeMs == null || !(gain.oneAtATimeMs > 0) ? '' : `<div class="gain-bars" aria-hidden="true">
      <div class="gbar"><span>${esc(tr('Without Prumo'))}</span><span class="gbar-track"><i class="seq" style="width:100%"></i></span></div>
      <div class="gbar"><span class="gain-prumo">${esc(tr('With Prumo'))}</span><span class="gbar-track"><i class="par" style="width:${parallelPct.toFixed(2)}%"></i><i class="save" style="width:${measuredPct.toFixed(2)}%"></i><i class="est" style="width:${estimatedPct}%"></i></span></div>
    </div><div class="gain-legend">
      <span><i class="seq"></i>${esc(tr('Without Prumo'))}</span>
      <span class="gain-prumo"><i class="par"></i>${esc(tr('With Prumo'))}</span>
      <span><i class="save"></i>${esc(tr('Measured savings'))}</span>
      <span><i class="est"></i>${esc(tr('Estimated calculation based on manual coordination'))}</span>
    </div>`
  return `<section class="gcard gain" id="gainPanel" aria-labelledby="gainTitle">
    <div class="gh"><b id="gainTitle">${esc(tr('Parallel gain'))}</b></div>
    <div class="gain-grid">
      <div><span>${esc(tr('Without Prumo'))}</span><strong>${shown(baselineMs)}</strong><small>${esc(tr('measured sequential work plus estimated manual coordination'))}</small></div>
      <div><span>${esc(tr('Parallel factor'))}</span><strong>${esc(factor)}</strong><small>${esc(tr('measured activity only'))}</small></div>
      <div><span class="gain-prumo">${esc(tr('With Prumo'))}</span><strong>${shown(gain.withPrumoMs)}</strong><small>${esc(tr('union of recorded activity intervals; overlaps count once'))}</small></div>
      <div class="gain-save"><span>${esc(tr('Measured savings'))}</span><strong>${shown(gain.savingsMs)}</strong></div>
      <div class="gain-save gain-estimate"><span>${esc(tr('Estimated savings'))}</span><strong>${shown(gain.combinedEstimateMs)}</strong><small>${esc(tr('Estimated calculation based on manual coordination'))}</small></div>
    </div>
    ${bars}
    <p class="gline"><strong>${esc(tr('Fixed assumption of 3 minutes per command'))}</strong> · ${esc(fmtMs(gain.manualCoordinationMs ?? 0))} · ${esc(tr('{0} commands', gain.commandTotal ?? 0))}</p>
    ${critical}
    ${human}
    <p class="gline gain-note">${esc(stateNote)}</p>
  </section>`
}

/** Renderiza a estimativa de coordenação manual (3 min fixos por comando), separada do ganho aferido. */
export function renderManualCoordination(gain, tr, fmtMs, esc) {
  const counts = gain.commandCounts ?? { planning: 0, execution: 0, review: 0 }
  const total = gain.commandTotal ?? 0
  const minutes = gain.minutesPerCommand ?? 3
  const mark = '\u0001'
  const headline = total > 0
    ? esc(tr(total === 1
      ? 'If you had to dispatch and re-dispatch every command by hand, you would spend about {0} just coordinating the agents ({1} min per command × 1 command).'
      : 'If you had to dispatch and re-dispatch every command by hand, you would spend about {0} just coordinating the agents ({1} min per command × {2} commands).',
      mark, minutes, total)).replace(mark, `<strong>${esc(fmtMs(gain.manualCoordinationMs))}</strong>`)
    : esc(tr('No command recorded yet; there is nothing to estimate.'))
  const commands = (count) => count === 1 ? tr('1 command') : tr('{0} commands', count)
  const breakdown = `<div class="manual-counts">${[
    ['planning', 'Planning command'], ['execution', 'Execution commands'], ['review', 'Review commands'],
  ].map(([kind, label]) => `<div><span>${esc(tr(label))}</span><b>${esc(commands(counts[kind] ?? 0))}</b><small>${esc(fmtMs((counts[kind] ?? 0) * minutes * 60_000))}</small></div>`).join('')}</div>`
  return `<section class="gcard manual" id="manualPanel" aria-labelledby="manualTitle">
    <div class="gh"><b id="manualTitle">${esc(tr('Manual coordination estimate'))}</b></div>
    <p class="manual-lead">${headline}</p>
    ${breakdown}
    <details class="manual-commands"><summary>${esc(tr('Commands included in the estimate'))}</summary><table><thead><tr><th>${esc(tr('Command'))}</th><th>${esc(tr('Count'))}</th><th>${esc(tr('Estimate'))}</th></tr></thead><tbody>${Object.entries(gain.commandsByName ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `<tr><td>${esc(name)}</td><td>${esc(count)}</td><td>${esc(fmtMs(count * minutes * 60_000))}</td></tr>`).join('')}</tbody></table></details>
    <p class="gline gain-note"><strong>${esc(tr('Fixed assumption of 3 minutes per command'))}</strong>. ${esc(tr('It is an estimate, separate from measured parallel savings.'))}</p>
    <p class="gline gain-note">${esc(tr('Only planning, execution and review dispatches count toward this estimate.'))}</p>
    ${gain.commandsComplete ? '' : `<p class="gline gain-note">${esc(tr('Partial dispatch history: unrecorded dispatches are excluded from the estimate.'))}</p>`}
  </section>`
}

/** Renders the run-level security audit card; empty when the run has no audit block and tolerant of a partial view. */
export function renderSecurityAuditCards(view, tr, esc, locale) {
  // Tentativas e achados registrados tornam a auditoria visível sem estimar progresso de testes não relatados.
  const attempts = view?.attempts ?? []
  const findings = view?.findings ?? []
  const previous = view?.state === 'running' ? view.previousBlocking ?? [] : []
  const emptyStates = { enabled: 'Scheduled after delivery', 'awaiting-decision': 'Awaiting your decision', skipped: 'Audit skipped',
    running: 'The audit is running. Findings appear when the auditor submits its report.', done: 'No findings recorded.',
    blocked: 'Findings require a decision', 'pending-recheck': 'Awaiting re-audit' }
  const empty = emptyStates[view?.state] ?? (view && view.state !== 'optional' ? 'unknown' : 'No security audit has started. Ask the orchestrator to enable it after delivery.')
  if (!attempts.length && !findings.length && !previous.length) return `<p class="security-empty">${esc(tr(empty))}</p>`
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale) : tr('Not recorded')
  const states = { done: 'Audit completed', blocked: 'Findings require a decision', failed: 'Failed', cancelled: 'Cancelled by user' }
  const attemptCards = attempts.map((attempt, index) => {
    const running = view.state === 'running' && index === attempts.length - 1 && !attempt.endedAt
    const label = running ? 'Auditing locally' : states[attempt.result] ?? 'Unknown'
    return `<article class="security-card security-attempt${running ? ' is-running' : ''}" data-audit-attempt="${esc(attempt.n ?? index + 1)}">
      <div class="security-card-heading"><span>${esc(tr('Audit attempt {0}', attempt.n ?? index + 1))}</span><span class="security-state">${esc(tr(label))}</span></div>
      <h4>${esc(attempt.agent ?? tr('Not assigned'))}</h4>
      <dl><dt>${esc(tr('Environment'))}</dt><dd>${esc(attempt.environment ?? tr('Not recorded'))}</dd>
      <dt>${esc(tr('Started'))}</dt><dd>${esc(time(attempt.startedAt))}</dd>
      ${attempt.endedAt ? `<dt>${esc(tr('Finished'))}</dt><dd>${esc(time(attempt.endedAt))}</dd>` : ''}</dl>
    </article>`
  }).join('')
  const findingCard = (finding, revalidating) => {
    const severity = ['critical', 'high', 'medium', 'low', 'info'].includes(finding.severity) ? finding.severity : 'info'
    const kind = finding.resolution ?? finding.status
    const resolution = finding.accepted || kind === 'accepted' ? tr('Accepted') : revalidating ? tr('Being revalidated')
      : kind === 'fix-skipped' ? tr('Fix task {0} skipped', finding.fixTask) : finding.fixTask ? tr('Fix task {0}', finding.fixTask) : tr('Open')
    const details = [['Evidence', finding.evidence], ['Reproduction', finding.reproduction], ['Remediation', finding.remediation]]
      .filter(([, text]) => typeof text === 'string' && text.trim())
      .map(([label, text]) => `<dt>${esc(tr(label))}</dt><dd>${esc(text)}</dd>`).join('')
    const scores = [['CVSS-B', finding.cvss?.computedScore ?? finding.cvss?.score], ['CVSS-BE', finding.cvss?.environmental?.computedScore ?? finding.cvss?.environmental?.score]]
      .filter(([, value]) => typeof value === 'number').map(([label, value]) => `${label} ${value}`).join(' · ')
    return `<article class="security-card security-finding" data-audit-finding="${esc(finding.id)}">
      <div class="security-card-heading"><span>${esc(finding.id)}</span><span class="sev sev-${severity}">${esc(tr(severity))}</span></div>
      <h4>${esc(finding.title)}</h4><p class="security-resolution">${esc(resolution)}</p>
      <p class="security-finding-meta">${esc(finding.cwe ?? tr('Not recorded'))}${scores ? ` · ${esc(scores)}` : ''}${finding.severityFloor?.class ? ` · ${esc(tr('Floor: {0}', finding.severityFloor.class))}` : ''}${finding.taskRefs?.length ? ` · ${esc(finding.taskRefs.join(', '))}` : ''}</p>
      ${details ? `<details><summary>${esc(tr('Finding details'))}</summary><dl>${details}</dl></details>` : ''}
      ${finding.fixTask ? `<button type="button" class="lbtn task-ref" onclick="jumpTo(${esc(JSON.stringify(finding.fixTask))})">${esc(tr('Open fix task'))}</button>` : ''}
    </article>`
  }
  const findingCards = findings.map(finding => findingCard(finding, false)).join('') + previous.map(finding => findingCard(finding, true)).join('')
  return `<section class="security-card-section"><h3>${esc(tr('Audit attempts'))}</h3>${attempts.length ? `<div class="security-card-grid">${attemptCards}</div>` : `<p class="security-empty">${esc(tr('Not recorded'))}</p>`}</section>
    <section class="security-card-section"><h3>${esc(tr('Recorded findings'))}</h3>${findingCards ? `<div class="security-card-grid">${findingCards}</div>` : `<p class="security-empty">${esc(tr(view.state === 'running' ? empty : 'No findings recorded.'))}</p>`}</section>`
}

export function renderSecurityAuditPanel(view, tr, esc) {
  if (!view) return ''
  const states = { enabled: 'Pre-authorized', 'awaiting-decision': 'Awaiting decision', skipped: 'Audit skipped', running: 'Running', blocked: 'Blocked', 'pending-recheck': 'Pending re-check', done: 'Done' }
  const severities = ['critical', 'high', 'medium', 'low', 'info']
  const findings = view.findings ?? [], previous = view.state === 'running' ? view.previousBlocking ?? [] : []
  const chips = severities.map(severity => `<span class="sev sev-${severity}">${esc(tr(severity))} · ${esc(view.counts?.[severity] ?? 0)}</span>`).join('')
  const accepted = findings.filter(finding => finding.accepted).length
  const resolution = finding => {
    const kind = finding.resolution ?? finding.status
    return kind === 'fix-task' ? tr('Fix task {0}', finding.fixTask) : kind === 'fix-skipped' ? tr('Fix task {0} skipped', finding.fixTask) : kind === 'open' ? tr('Open') : finding.accepted || kind === 'accepted' ? tr('Accepted') : '-'
  }
  // The original CVSS score stays visible next to the final one (BE) and the class floor that lifted the severity, so the gate is explainable; every part is optional.
  const score = finding => {
    const cvss = finding.cvss, parts = []
    // The engine's calculated scores come first; reports recorded before the calculator only carry the auditor's score.
    const base = cvss?.computedScore ?? cvss?.score, environmental = cvss?.environmental?.computedScore ?? cvss?.environmental?.score
    if (typeof base === 'number') parts.push(`CVSS-B ${base}`)
    if (typeof environmental === 'number') parts.push(`CVSS-BE ${environmental}`)
    if (finding.severityFloor?.class) parts.push(tr('Floor: {0}', finding.severityFloor.class))
    return parts.length ? `<br><small class="cvss">${esc(parts.join(' · '))}</small>` : ''
  }
  const table = list => list.length ? `<table><thead><tr><th>${esc(tr('Finding'))}</th><th>${esc(tr('Severity'))}</th><th>${esc(tr('Title'))}</th><th>CWE</th><th>${esc(tr('Tasks'))}</th><th>${esc(tr('Risk'))}</th></tr></thead><tbody>${list.map(finding => `<tr><td>${esc(finding.id)}</td><td>${esc(tr(finding.severity))}${score(finding)}</td><td>${esc(finding.title)}</td><td>${esc(finding.cwe)}</td><td>${esc((finding.taskRefs ?? []).join(', '))}</td><td>${esc(resolution(finding))}</td></tr>`).join('')}</tbody></table>` : ''
  return `<section class="gcard security-audit" id="securityAuditPanel" aria-labelledby="securityAuditTitle">
    <div class="gh"><b id="securityAuditTitle">${esc(tr('Security audit'))}</b><span>${esc(tr(states[view.state] ?? view.state))}</span></div>
    <div class="sev-chips">${chips}</div>
    <p class="gline gain-note">${esc(tr('Attempts: {0}; blocking findings: {1}; accepted: {2}', (view.attempts ?? []).length, (view.blocking ?? []).length, accepted))}</p>
    ${previous.length ? `<p class="gline gain-note">${esc(tr('Findings from the previous audit being revalidated'))}</p>${table(previous)}` : ''}
    ${table(findings)}
  </section>`
}
