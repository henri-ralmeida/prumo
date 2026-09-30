export function createPrumoOnboarding({ root, launcher, document, window, translate = value => value,
  getCompletedRunSummary = () => null }) {
  if (!root || !launcher || !document) return null
  const find = id => root.querySelector(id)
  const title = find('#guideTitle'), description = find('#guideDescription')
  const count = find('#guideCount'), announcement = find('#guideAnnouncement')
  const previous = find('#guidePrevious'), next = find('#guideNext'), skip = find('#guideSkip')
  const invitation = document.querySelector('#guideInvitation')
  const invitationOpen = document.querySelector('#guideInvitationOpen')
  const invitationDismiss = document.querySelector('#guideInvitationDismiss')
  const graph = find('#guideExamplePanel'), filters = find('#guideMockFilters')
  const roles = find('#guideMockRoles')
  const shown = find('#guideMockShown'), total = find('#guideMockTotal')
  const detail = find('#guideMockDetail'), gain = find('#guideGainPanel')
  const detailExpand = find('#guideMockDetailExpand'), detailMore = find('#guideMockDetailMore')
  const gainLabel = find('#guideGainsLabel'), gainSummary = find('#guideGainsSummary')
  const command = find('#guideCommandPanel')
  const cards = [...(graph?.querySelectorAll('[data-guide-task]') ?? [])]
  const filterButtons = [...(filters?.querySelectorAll('[data-guide-filter]') ?? [])]
  const steps = [
    { title: 'What is Prumo?', description: 'Prumo turns an approved plan into a task graph, execution and independent review.', target: 'graph' },
    { title: 'People and roles', demos: [
      { title: 'The orchestrator', description: 'The Orchestrator discusses scope and coordinates the work.', target: 'orchestrator' },
      { title: 'The planner', description: 'The Planner records the approved plan as tasks.', target: 'planner' },
      { title: 'The executor', description: 'The Executor works on authorized tasks and records evidence.', target: 'executor' },
      { title: 'The reviewer', description: 'The Reviewer independently checks the result.', target: 'reviewer' },
    ] },
    { title: 'From discussion to done', description: 'After approval, work moves through planning, execution and review. A rejected task returns for correction; a blocked task awaits your decision.', target: 'blocked' },
    { title: 'Explore this dashboard', demos: [
      { title: 'Filters and counts', description: 'Choose a status to filter this example and see how many cards remain.', target: 'filters' },
      { title: 'Phases and tasks', description: 'Each lane groups tasks in one phase. The cards keep the same status colors and shapes as the dashboard.', target: 'graph' },
      { title: 'Task card', description: 'Select a card to read its summary and details. Select it again to close.', target: 'card' },
      { title: 'Run results', description: 'Results show the measured execution after work is complete.', target: 'gain' },
    ] },
    { title: 'See the measured gain', description: 'A real gain appears only when the run and its measurements are complete.', target: 'gain' },
    { title: 'Start here', description: 'First create and approve a plan in your coding environment’s planning mode. Then start Prumo to turn that approved plan into a task graph.', target: 'command' },
  ]
  let stepIndex = 0, demoIndex = 0, dismissed = true, selected = null, activeFilter = 'all'
  let fullscreenOwned = false, fullscreenPending = false
  const store = (value) => { try { window.localStorage.setItem('prumoOnboardingDismissed', value) } catch {} }
  const saved = () => { try { return window.localStorage.getItem('prumoOnboardingDismissed') === 'true' } catch { return false } }
  const forced = () => {
    try { return new URLSearchParams(window.location?.search ?? '').get('onboarding') === 'first-run' }
    catch { return false }
  }
  const demo = () => steps[stepIndex].demos?.[demoIndex] ?? steps[stepIndex]
  const mark = (node, on) => node?.classList?.toggle('prumo-guide-target', Boolean(on))
  const matches = (card, filter) => filter === 'all' || card.dataset.guideStatus === filter

  function updateFilter(filter) {
    activeFilter = filter
    let visible = 0
    for (const card of cards) {
      card.hidden = !matches(card, filter)
      if (!card.hidden) visible += 1
    }
    if (selected?.hidden) showDetail(null)
    if (shown) shown.textContent = String(visible)
    if (total) total.textContent = String(cards.length)
    for (const button of filterButtons) {
      const active = button.dataset.guideFilter === filter
      button.setAttribute('aria-pressed', String(active))
      const amount = cards.filter(card => matches(card, button.dataset.guideFilter)).length
      const number = button.querySelector('[data-guide-count]')
      if (number) number.textContent = String(amount)
    }
  }

  function showDetail(card) {
    selected = selected === card ? null : card
    for (const item of cards) item.setAttribute('aria-expanded', String(item === selected))
    if (!detail) return
    detail.hidden = !selected
    if (detailMore) detailMore.hidden = true
    detailExpand?.setAttribute('aria-expanded', 'false')
    if (detailExpand) detailExpand.textContent = translate('Expand details')
    if (!selected) return
    detail.dataset.st = selected.dataset.guideStatus
    const taskName = selected.querySelector('.nt')?.textContent ?? ''
    const id = selected.querySelector('.id')?.textContent ?? ''
    const state = selected.querySelector('.tr')?.textContent ?? ''
    detail.querySelector('[data-guide-detail-title]').textContent = `${id} — ${taskName}`
    detail.querySelector('[data-guide-detail-state]').textContent = state
    detail.querySelector('[data-guide-detail-summary]').textContent = translate(selected.dataset.guideSummary)
    detail.querySelector('[data-guide-detail-check]').textContent = translate(selected.dataset.guideCheck)
    detail.querySelector('[data-guide-detail-needs]').textContent = translate(selected.dataset.guideNeeds)
  }

  function refreshGains() {
    if (!gainLabel || !gainSummary) return
    let result
    try { result = getCompletedRunSummary() } catch {}
    if (result?.completed === true && result?.measurementComplete === true && typeof result.text === 'string' && result.text.trim()) {
      gainLabel.hidden = false
      gainLabel.textContent = translate('Measured from a completed run')
      gainSummary.textContent = result.text.trim().slice(0, 320)
    } else {
      gainLabel.hidden = true
      gainSummary.textContent = translate('Results for this practice board are not measured. Open a completed run to see its measured gain.')
    }
  }

  function render() {
    const content = demo(), demos = steps[stepIndex].demos
    title.textContent = translate(content.title)
    description.textContent = translate(content.description)
    count.textContent = demos
      ? translate('Step {0} of {1} — demo {2} of {3}', stepIndex + 1, steps.length, demoIndex + 1, demos.length)
      : translate('Step {0} of {1}', stepIndex + 1, steps.length)
    announcement.textContent = `${count.textContent}: ${title.textContent}. ${description.textContent}`
    previous.disabled = stepIndex === 0 && demoIndex === 0
    next.textContent = translate(stepIndex === steps.length - 1 ? 'Finish guide' : 'Next')
    for (const [target, node] of [['graph', graph], ['filters', filters], ['gain', gain], ['command', command]])
      mark(node, content.target === target)
    for (const role of roles?.querySelectorAll('[data-guide-role]') ?? []) mark(role, role.dataset.guideRole === content.target)
    for (const card of cards) mark(card, content.target === 'card' ||
      (content.target === 'executor' && card.dataset.guideStatus === 'running') ||
      (content.target === 'reviewer' && card.dataset.guideStatus === 'reviewing') ||
      card.dataset.guideStatus === content.target)
    gain.hidden = !['gain'].includes(content.target)
    command.hidden = content.target !== 'command'
    if (!gain.hidden) refreshGains()
  }

  function nextStep() {
    const demos = steps[stepIndex].demos
    if (demos && demoIndex < demos.length - 1) demoIndex += 1
    else if (stepIndex === steps.length - 1) return close()
    else { stepIndex += 1; demoIndex = 0 }
    render()
  }
  function previousStep() {
    if (demoIndex > 0) demoIndex -= 1
    else if (stepIndex > 0) { stepIndex -= 1; demoIndex = (steps[stepIndex].demos?.length ?? 1) - 1 }
    render()
  }
  function hideInvitation(remember = false) {
    if (invitation) invitation.hidden = true
    document.documentElement?.classList?.remove('guide-inviting')
    if (remember) store('true')
  }
  function invite() {
    if (!invitation) return
    invitation.hidden = false
    document.documentElement?.classList?.add('guide-inviting')
  }
  function leaveFullscreen() {
    if (fullscreenOwned && document.fullscreenElement === root && document.exitFullscreen) {
      try { Promise.resolve(document.exitFullscreen()).catch(() => {}) } catch {}
    }
    fullscreenOwned = false
  }
  function enterFullscreen() {
    if (!root.requestFullscreen || document.fullscreenElement) return
    fullscreenPending = true
    try {
      Promise.resolve(root.requestFullscreen()).then(() => {
        fullscreenPending = false
        if (document.fullscreenElement !== root) return
        fullscreenOwned = true
        if (root.hidden) leaveFullscreen()
      }, () => { fullscreenPending = false })
    } catch { fullscreenPending = false }
  }
  function open() {
    hideInvitation(true)
    dismissed = false
    stepIndex = 0; demoIndex = 0
    updateFilter('all'); showDetail(null); render()
    root.hidden = false
    root.classList.add('presenting')
    launcher.setAttribute('aria-expanded', 'true')
    next.focus?.()
    enterFullscreen()
  }
  function close() {
    if (dismissed) return
    dismissed = true
    root.hidden = true
    root.classList.remove('presenting')
    launcher.setAttribute('aria-expanded', 'false')
    store('true')
    leaveFullscreen()
    launcher.focus?.()
  }
  launcher.addEventListener('click', open)
  invitationOpen?.addEventListener('click', open)
  invitationDismiss?.addEventListener('click', () => { hideInvitation(true); launcher.focus?.() })
  previous.addEventListener('click', previousStep)
  next.addEventListener('click', nextStep)
  skip.addEventListener('click', close)
  for (const button of filterButtons) button.addEventListener('click', () => updateFilter(button.dataset.guideFilter))
  for (const card of cards) card.addEventListener('click', () => showDetail(card))
  find('#guideMockDetailClose')?.addEventListener('click', () => showDetail(null))
  detailExpand?.addEventListener('click', () => {
    detailMore.hidden = !detailMore.hidden
    detailExpand.setAttribute('aria-expanded', String(!detailMore.hidden))
    detailExpand.textContent = translate(detailMore.hidden ? 'Expand details' : 'Collapse details')
  })
  document.addEventListener('fullscreenchange', () => {
    if (fullscreenPending && document.fullscreenElement === root) fullscreenOwned = true
    else if (fullscreenOwned && document.fullscreenElement !== root) {
      fullscreenOwned = false
      if (!root.hidden) close()
    }
  })
  document.addEventListener('keydown', event => {
    if (root.hidden) return
    if (event.key === 'Escape') { event.preventDefault?.(); close(); return }
    if (event.target !== root && !root.contains?.(event.target)) return
    if (event.target?.isContentEditable || event.target?.closest?.('[contenteditable="true"]') ||
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target?.tagName)) return
    if (event.key === 'ArrowLeft') { event.preventDefault?.(); previousStep() }
    if (event.key === 'ArrowRight') { event.preventDefault?.(); nextStep() }
  })
  updateFilter('all')
  render()
  launcher.setAttribute('aria-expanded', 'false')
  if (forced() || !saved()) invite()
  return { open, close, refreshGains, refreshRunAvailability: () => {}, updateFilter }
}
