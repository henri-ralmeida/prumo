export function createPrumoOnboarding({
  root,
  launcher,
  document,
  window,
  translate = (value) => value,
  getCompletedRunSummary = () => null,
  getRunAvailability = () => false,
}) {
  if (!root || !launcher || !document) return null

  const title = root.querySelector('#guideTitle')
  const description = root.querySelector('#guideDescription')
  const count = root.querySelector('#guideCount')
  const announcement = root.querySelector('#guideAnnouncement')
  const previous = root.querySelector('#guidePrevious')
  const next = root.querySelector('#guideNext')
  const skip = root.querySelector('#guideSkip')
  const presentation = root.querySelector('#guidePresentation')
  const gainsLabel = root.querySelector('#guideGainsLabel')
  const gainsSummary = root.querySelector('#guideGainsSummary')
  const openLegend = root.querySelector('#guideOpenLegend')
  const flowPanel = root.querySelector('#guideFlowPanel')
  const roleCard = root.querySelector('#guideRoleCard')
  const roleName = root.querySelector('#guideRoleName')
  const roleIcon = root.querySelector('#guideRoleIcon')
  const examplePanel = root.querySelector('#guideExamplePanel')

  const steps = [
    { title: 'What is Prumo?', description: 'Prumo organizes approved work into tasks with context, dependencies and evidence.' },
    { title: 'People and roles', demos: [
      { title: 'The orchestrator', description: 'Facilitates discussion, confirms scope with you and coordinates phases.', role: 'orchestrator', anchors: ['role-orchestrator'] },
      { title: 'The planner', description: 'Turns confirmed decisions into a plan before work starts.', role: 'planner', anchors: ['role-planner'] },
      { title: 'The executor', description: 'Works on authorized tasks and records evidence for review.', role: 'executor', anchors: ['role-executor'] },
      { title: 'The reviewer', description: 'Independently checks evidence; approval puts the task in prumo.', role: 'reviewer', anchors: ['role-reviewer'] },
    ] },
    { title: 'From discussion to done', description: 'The flow is discussion → planning → execution → review → in prumo.', flow: true },
    { title: 'Explore this dashboard', liveDemos: [
      { title: 'Filters and counts', description: 'Filter this run by status and read how many tasks are in each state.', anchors: ['filters'] },
      { title: 'Phases, tasks and dependencies', description: 'These lanes are phases, these cards are real tasks from the selected run, and the arrows show dependencies.', anchors: ['phases', 'tasks', 'board'] },
      { title: 'Available tasks', description: 'During a run, this panel lists tasks that can start now, including tasks waiting on your decision.', anchors: ['available'], needsSidebar: true },
      { title: 'Selected task', description: 'Clicking a task during a run shows its details in this same space.', anchors: ['selected'], fallbackAnchors: ['available'], needsSidebar: true },
      { title: 'Run results', description: 'Open Results to see the selected run\'s summary and measured data.', anchors: ['results'] },
      { title: 'Legend', description: 'The legend maps each task state to its color and explains dependency lines.', anchors: ['legend'], needsSidebar: true },
    ], exampleDemos: [
      { title: 'Filters and counts', description: 'Filter this dashboard by status and read how many tasks are in each state.', anchors: ['filters'] },
      { title: 'Example run: checkout-v2', description: 'This illustrative design example shows 10 tasks and their dependencies; it is not current run data.', anchors: ['example-graph'], exampleGraph: true },
      { title: 'Available tasks', description: 'During a run, this panel lists tasks that can start now, including tasks waiting on your decision.', anchors: ['available'], needsSidebar: true },
      { title: 'Selected task', description: 'Clicking a task during a run shows its details in this same space.', anchors: ['selected'], fallbackAnchors: ['available'], needsSidebar: true },
      { title: 'Run results', description: 'When a run is available, open Results to see its summary and measured data.', anchors: ['results'] },
      { title: 'Legend', description: 'The legend maps each task state to its color and explains dependency lines.', anchors: ['legend'], needsSidebar: true },
    ] },
    { title: 'See the measured gain', description: 'A real gain appears only after the run is complete and its measurements are complete. Until then, this is an illustrative example.', gains: true },
    { title: 'Start here', description: 'Use the command for the coding environment you are working in.', commands: true },
  ]

  const stepCount = steps.length
  let stepIndex = 0
  let demoIndex = 0
  let runAvailable = readRunAvailability()
  let dismissed = false
  let highlighted = []

  function storageWasDismissed() {
    try { return window.localStorage.getItem('prumoOnboardingDismissed') === 'true' }
    catch { return false }
  }

  function rememberDismissal() {
    try { window.localStorage.setItem('prumoOnboardingDismissed', 'true') }
    catch { /* O guia continua funcionando mesmo sem armazenamento local. */ }
  }

  function readRunAvailability() {
    try { return getRunAvailability() === true }
    catch { return false }
  }

  function clearHighlights() {
    for (const node of highlighted) node.classList.remove('prumo-guide-target')
    highlighted = []
  }

  function targetsFor(anchors) {
    if (!anchors?.length) return []
    const candidates = [...document.querySelectorAll('[data-prumo-guide-anchor]')]
    return anchors.flatMap((anchor) => candidates.filter((node) => node.dataset.prumoGuideAnchor === anchor))
  }

  function visible(node) {
    return Boolean(node && !node.hidden && !node.closest?.('[hidden]'))
  }

  function refreshGains() {
    if (!gainsSummary || !gainsLabel) return
    let result = null
    try { result = getCompletedRunSummary() }
    catch { /* Sem o adaptador de métricas, permanece o exemplo identificado. */ }

    if (result?.completed === true && result?.measurementComplete === true &&
        typeof result.text === 'string' && result.text.trim()) {
      gainsLabel.textContent = translate('Measured from a completed run')
      gainsSummary.textContent = result.text.trim().slice(0, 320)
    } else {
      gainsLabel.textContent = translate('Illustrative example only — not a measurement')
      gainsSummary.textContent = translate('Illustrative gain: 4 independent 30-minute tasks could take about 30 minutes in parallel instead of 2 hours in sequence — up to 1 hour 30 minutes saved (75%). Dependencies and review change the real result.')
    }
  }

  function currentContent() {
    const step = steps[stepIndex]
    return demosFor(step)?.[demoIndex] ?? step
  }

  function demosFor(step) {
    if (step.liveDemos) return runAvailable ? step.liveDemos : step.exampleDemos
    return step.demos
  }

  function setRoleCard(role) {
    roleCard.hidden = !role
    if (!role) return
    roleCard.dataset.role = role
    roleName.textContent = translate({
      orchestrator: 'The orchestrator', planner: 'The planner', executor: 'The executor', reviewer: 'The reviewer',
    }[role])
    const target = document.querySelector(`[data-prumo-guide-anchor="role-${role}"]`)
    const icon = target?.querySelector('svg')
    roleIcon.replaceChildren(...(icon ? [icon.cloneNode(true)] : []))
    roleCard.style.setProperty('--guide-role', ({
      orchestrator: 'var(--accent)', planner: 'var(--planning)', executor: 'var(--running)', reviewer: 'var(--review)',
    })[role])
  }

  function renderStep(nextIndex, nextDemo = 0) {
    stepIndex = Math.max(0, Math.min(stepCount - 1, nextIndex))
    const step = steps[stepIndex]
    const demos = demosFor(step)
    demoIndex = Math.max(0, Math.min((demos?.length ?? 1) - 1, nextDemo))
    const content = currentContent()
    title.textContent = translate(content.title)
    description.textContent = translate(content.description)
    const counter = content !== step
      ? translate('Step {0} of {1} — demo {2} of {3}', stepIndex + 1, stepCount, demoIndex + 1, demos.length)
      : translate('Step {0} of {1}', stepIndex + 1, stepCount)
    count.textContent = counter
    announcement.textContent = `${counter}: ${translate(content.title)}. ${translate(content.description)}`
    previous.disabled = stepIndex === 0 && demoIndex === 0
    next.textContent = translate(stepIndex === stepCount - 1 ? 'Finish guide' : 'Next')
    flowPanel.hidden = !step.flow
    setRoleCard(content.role)
    examplePanel.hidden = !content.exampleGraph
    root.querySelector('#guideGainPanel').hidden = !step.gains
    root.querySelector('#guideCommandPanel').hidden = !step.commands
    clearHighlights()
    highlighted = targetsFor(content.anchors).filter(visible)
    if (!highlighted.length) highlighted = targetsFor(content.fallbackAnchors).filter(visible)
    for (const node of highlighted) node.classList.add('prumo-guide-target')
    const sidePanel = document.querySelector('#sidebar')
    openLegend.hidden = !content.needsSidebar || visible(sidePanel)
    if (step.gains) refreshGains()
  }

  function nextStep() {
    const step = steps[stepIndex]
    const demos = demosFor(step)
    if (demos && demoIndex < demos.length - 1) return renderStep(stepIndex, demoIndex + 1)
    if (stepIndex === stepCount - 1) return close()
    renderStep(stepIndex + 1)
  }

  function previousStep() {
    if (demoIndex > 0) return renderStep(stepIndex, demoIndex - 1)
    if (stepIndex === 0) return
    const targetIndex = stepIndex - 1
    const targetStep = steps[targetIndex]
    renderStep(targetIndex, (demosFor(targetStep)?.length ?? 1) - 1)
  }

  function setPresentation(active) {
    root.classList.toggle('presenting', active)
    presentation.setAttribute('aria-pressed', String(active))
    presentation.textContent = translate(active ? 'Exit presentation' : 'Presentation / fullscreen')
  }

  async function togglePresentation() {
    const entering = !root.classList.contains('presenting')
    setPresentation(entering)
    try {
      if (entering && root.requestFullscreen) await root.requestFullscreen()
      else if (!entering && document.fullscreenElement === root && document.exitFullscreen) await document.exitFullscreen()
    } catch { /* O modo de apresentação continua disponível sem tela cheia do navegador. */ }
  }

  function open() {
    dismissed = false
    runAvailable = readRunAvailability()
    renderStep(0)
    root.hidden = false
    launcher.setAttribute('aria-expanded', 'true')
    next.focus?.()
  }

  function close() {
    if (dismissed) return
    dismissed = true
    root.hidden = true
    setPresentation(false)
    clearHighlights()
    launcher.setAttribute('aria-expanded', 'false')
    rememberDismissal()
    try {
      if (document.fullscreenElement === root && document.exitFullscreen) document.exitFullscreen()
    } catch { /* Fechar o guia não depende do suporte à tela cheia. */ }
    launcher.focus?.()
  }

  function refreshRunAvailability() {
    const available = readRunAvailability()
    if (available === runAvailable) return
    runAvailable = available
    if (stepIndex === 3) renderStep(stepIndex, demoIndex)
  }

  launcher.addEventListener('click', () => open())
  previous.addEventListener('click', previousStep)
  next.addEventListener('click', nextStep)
  skip.addEventListener('click', close)
  presentation.addEventListener('click', togglePresentation)
  openLegend.addEventListener('click', () => {
    document.querySelector('#sidebarToggle')?.click()
    renderStep(stepIndex, demoIndex)
  })
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && root.classList.contains('presenting')) setPresentation(false)
  })
  document.addEventListener('keydown', (event) => {
    if (root.hidden) return
    if (event.key === 'Escape') {
      event.preventDefault?.()
      close()
      return
    }
    if (event.target !== root && !root.contains?.(event.target)) return
    if (event.target?.isContentEditable || event.target?.closest?.('[contenteditable="true"]') ||
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target?.tagName)) return
    if (event.key === 'ArrowLeft' && stepIndex > 0) {
      event.preventDefault?.()
      previousStep()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault?.()
      nextStep()
    }
  })

  renderStep(0)
  if (storageWasDismissed()) {
    dismissed = true
    root.hidden = true
    launcher.setAttribute('aria-expanded', 'false')
  } else {
    root.hidden = false
    launcher.setAttribute('aria-expanded', 'true')
    next.focus?.()
  }

  return { open, close, refreshGains, refreshRunAvailability }
}
