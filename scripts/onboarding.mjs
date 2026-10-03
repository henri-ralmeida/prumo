export function createGuideDemoFrameController(frames, onState = () => {}) {
  const cache = { board: false, results: false }
  let active = null, target = null, generation = 0
  function focus(mode) {
    const frame = frames[mode]
    if (active !== mode || !cache[mode]) return
    if (typeof frame.contentWindow?.prumoGuideDemo?.focus !== 'function') {
      cache[mode] = false
      onState(mode, 'error')
      return
    }
    try {
      frame.contentWindow.prumoGuideDemo.focus(target)
      onState(mode, 'ready')
    } catch {
      onState(mode, 'error')
    }
  }
  function show(mode, nextTarget) {
    if (!frames[mode]) return
    if (active && active !== mode) onState(active, 'idle')
    active = mode; target = nextTarget
    if (cache[mode]) return focus(mode)
    onState(mode, 'loading')
    const frame = frames[mode]
    if (frame.dataset.guideLoading === 'true') return
    const started = generation
    frame.dataset.guideLoading = 'true'
    frame.onload = () => {
      if (started !== generation) return
      delete frame.dataset.guideLoading
      cache[mode] = true
      if (active === mode) focus(mode)
      else onState(mode, 'idle')
    }
    frame.src = '?guide-demo=' + mode
  }
  function stop({ dispose = false } = {}) {
    if (active) onState(active, 'idle')
    active = null; target = null
    if (!dispose) return
    generation += 1
    for (const mode of ['board', 'results']) {
      const frame = frames[mode]
      frame.onload = null
      frame.removeAttribute('src')
      delete frame.dataset.guideLoading
      cache[mode] = false
      onState(mode, 'idle')
    }
  }
  return { show, stop }
}

export function createPrumoOnboarding({ root, launcher, document, window, translate = value => value,
  showDemo = () => {}, stopDemos = () => {}, syncMotion = () => {} }) {
  if (!root || !launcher || !document) return null
  const find = id => root.querySelector(id)
  const title = find('#guideTitle'), description = find('#guideDescription')
  const count = find('#guideCount'), stepTitle = find('#guideStepTitle'), announcement = find('#guideAnnouncement')
  const previous = find('#guidePrevious'), next = find('#guideNext'), skip = find('#guideSkip')
  const invitation = document.querySelector('#guideInvitation')
  const invitationOpen = document.querySelector('#guideInvitationOpen')
  const invitationDismiss = document.querySelector('#guideInvitationDismiss')
  const intro = find('#guideIntroPanel'), roles = find('#guideMockRoles')
  const graph = find('#guideExamplePanel'), gain = find('#guideGainPanel'), command = find('#guideCommandPanel')
  const steps = [
    { title: 'Why use Prumo?', heading: 'Overview', description: 'An approved plan becomes visible work: clear dependencies, coordinated agents and independent review before completion.', target: 'intro' },
    { title: 'People and roles', heading: 'Entities', demos: [
      { title: 'The orchestrator', description: 'The Orchestrator discusses scope and coordinates the work.', target: 'orchestrator' },
      { title: 'The planner', description: 'The Planner records the approved plan as tasks.', target: 'planner' },
      { title: 'The executor', description: 'The Executor works on authorized tasks and records evidence.', target: 'executor' },
      { title: 'The reviewer', description: 'The Reviewer independently checks the result.', target: 'reviewer' },
    ] },
    { title: 'Explore this dashboard', heading: 'Dashboard', demos: [
      { title: 'Phases and tasks', description: 'Phases organize the plan. Task IDs identify the work; their colors show the current state. Click a phase or a task.', target: 'board' },
      { title: 'Filters and counts', description: 'Try the filters. They change the visible cards; completed totals exclude skipped tasks and preserve the full plan.', target: 'filters' },
      { title: 'Task card', description: 'Click a task to read its summary, validation and dependencies. The expansion arrow opens the full details.', target: 'card' },
      { title: 'Progress and activity', description: 'Green counts completed tasks. The other colored segments show discussion, planning, execution and review in progress, without increasing completion.', target: 'activity' },
    ] },
    { title: 'Run results', heading: 'Results', demos: [
      { title: 'Gain with Prumo', description: 'Compare the full baseline with measured parallel activity and the separate manual coordination estimate.', target: 'gain' },
      { title: 'Recorded agent activity', description: 'Discussion, Planning, Execution and Review count only evidenced activity. Waiting time is excluded.', target: 'times' },
      { title: 'Manual coordination estimate', description: 'Planning, execution and review dispatches use a fixed assumption of 3 minutes per command. Expand the list to inspect the count.', target: 'commands' },
    ] },
    { title: 'Start here', heading: 'How to use', description: 'First create and approve a plan in your coding environment’s planning mode. Then start Prumo to turn that approved plan into a task graph.', target: 'command' },
  ]
  let stepIndex = 0, demoIndex = 0, dismissed = true
  let fullscreenOwned = false, fullscreenPending = false
  let pendingDemo = null, pendingFrame = null, demoGeneration = 0
  let shownMode = null, shownTarget = null
  function cancelPendingDemo() {
    demoGeneration += 1
    if (pendingFrame !== null) window.cancelAnimationFrame?.(pendingFrame)
    pendingFrame = null
    pendingDemo = null
  }
  function scheduleDemo(mode, target) {
    pendingDemo = { mode, target }
    if (pendingFrame !== null) return
    const generation = ++demoGeneration
    pendingFrame = window.requestAnimationFrame(() => {
      pendingFrame = null
      const latest = pendingDemo
      pendingDemo = null
      if (generation !== demoGeneration || dismissed || !latest) return
      if (shownMode === latest.mode && shownTarget === latest.target) return
      shownMode = latest.mode; shownTarget = latest.target
      showDemo(latest.mode, latest.target)
    })
  }
  function stopDemo(dispose = false) {
    const active = shownMode !== null || pendingDemo !== null
    cancelPendingDemo()
    shownMode = shownTarget = null
    if (active || dispose) stopDemos({ dispose })
  }
  const store = (value) => { try { window.localStorage.setItem('prumoOnboardingDismissed', value) } catch {} }
  const saved = () => { try { return window.localStorage.getItem('prumoOnboardingDismissed') === 'true' } catch { return false } }
  const forced = () => {
    try { return new URLSearchParams(window.location?.search ?? '').get('onboarding') === 'first-run' }
    catch { return false }
  }
  const demo = () => steps[stepIndex].demos?.[demoIndex] ?? steps[stepIndex]
  const mark = (node, on) => node?.classList?.toggle('prumo-guide-target', Boolean(on))
  function render() {
    const content = demo(), demos = steps[stepIndex].demos
    title.textContent = translate(content.title)
    description.textContent = translate(content.description)
    stepTitle.textContent = translate(steps[stepIndex].heading)
    count.textContent = demos
      ? translate('Step {0} of {1} — demo {2} of {3}', stepIndex + 1, steps.length, demoIndex + 1, demos.length)
      : translate('Step {0} of {1}', stepIndex + 1, steps.length)
    announcement.textContent = `${count.textContent}: ${title.textContent}. ${description.textContent}`
    previous.disabled = stepIndex === 0 && demoIndex === 0
    previous.textContent = translate('back')
    next.textContent = translate(stepIndex === steps.length - 1 ? 'finish guide' : 'next')
    const roleStep = stepIndex === 1, boardStep = stepIndex === 2, resultsStep = stepIndex === 3
    intro.hidden = stepIndex !== 0
    roles.hidden = !roleStep
    graph.hidden = !boardStep
    gain.hidden = !resultsStep
    command.hidden = stepIndex !== 4
    for (const role of roles?.querySelectorAll('[data-guide-role]') ?? []) {
      mark(role, roleStep && role.dataset.guideRole === content.target)
      role.setAttribute('aria-pressed', String(roleStep && role.dataset.guideRole === content.target))
    }
    if (boardStep || resultsStep) scheduleDemo(boardStep ? 'board' : 'results', content.target)
    else stopDemo()
    root.scrollTop = 0
    syncMotion()

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
    positionInvitation()
  }
  function positionInvitation() {
    if (!invitation || invitation.hidden) return
    const bottom = launcher.getBoundingClientRect?.().bottom
    if (Number.isFinite(bottom) && invitation.style) invitation.style.top = `${bottom + 12}px`
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
    render()
    root.hidden = false
    root.classList.add('presenting')
    syncMotion()
    launcher.setAttribute('aria-expanded', 'true')
    next.focus?.()
    enterFullscreen()
  }
  function close() {
    if (dismissed) return
    dismissed = true
    root.hidden = true
    stopDemo(true)
    root.classList.remove('presenting')
    launcher.setAttribute('aria-expanded', 'false')
    store('true')
    leaveFullscreen()
    launcher.focus?.()
  }
  launcher.addEventListener('click', open)
  window.addEventListener?.('resize', positionInvitation)
  invitationOpen?.addEventListener('click', open)
  invitationDismiss?.addEventListener('click', () => { hideInvitation(true); launcher.focus?.() })
  previous.addEventListener('click', previousStep)
  next.addEventListener('click', nextStep)
  skip.addEventListener('click', close)
  for (const role of roles?.querySelectorAll('[data-guide-role]') ?? []) role.addEventListener('click', () => {
    stepIndex = 1
    demoIndex = steps[1].demos.findIndex(item => item.target === role.dataset.guideRole)
    render()
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
  render()
  launcher.setAttribute('aria-expanded', 'false')
  if (forced() || !saved()) invite()
  return { open, close, refreshGains: () => {}, refreshRunAvailability: () => {} }
}
