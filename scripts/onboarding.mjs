export function createPrumoOnboarding({
  root,
  launcher,
  document,
  window,
  translate = (value) => value,
  getCompletedRunSummary = () => null,
  getRunAvailability = () => false,
  getRunSnapshot = () => null,
}) {
  if (!root || !launcher || !document) return null

  const title = root.querySelector('#guideTitle')
  const description = root.querySelector('#guideDescription')
  const count = root.querySelector('#guideCount')
  const announcement = root.querySelector('#guideAnnouncement')
  const previous = root.querySelector('#guidePrevious')
  const next = root.querySelector('#guideNext')
  const skip = root.querySelector('#guideSkip')
  const gainsLabel = root.querySelector('#guideGainsLabel')
  const gainsSummary = root.querySelector('#guideGainsSummary')
  const openLegend = root.querySelector('#guideOpenLegend')
  const flowPanel = root.querySelector('#guideFlowPanel')
  const roleCard = root.querySelector('#guideRoleCard')
  const roleName = root.querySelector('#guideRoleName')
  const roleIcon = root.querySelector('#guideRoleIcon')
  const examplePanel = root.querySelector('#guideExamplePanel')
  const visual = root.querySelector('#guideVisual')

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
      { title: 'Task card', description: 'Click a task to open its summary. Expand the card to read the full details.', anchors: ['selected'], fallbackAnchors: ['tasks'] },
      { title: 'Run results', description: 'Open Results to see the selected run\'s summary and measured data.', anchors: ['results'] },
      { title: 'Legend', description: 'The legend maps each task state to its color and explains dependency lines.', anchors: ['legend'], needsSidebar: true },
    ], exampleDemos: [
      { title: 'Filters and counts', description: 'Filter this dashboard by status and read how many tasks are in each state.', anchors: ['filters'] },
      { title: 'Example run: checkout-v2', description: 'This illustrative design example shows 10 tasks and their dependencies; it is not current run data.', anchors: ['example-graph'], exampleGraph: true },
      { title: 'Available tasks', description: 'During a run, this panel lists tasks that can start now, including tasks waiting on your decision.', anchors: ['available'], needsSidebar: true },
      { title: 'Task card', description: 'Click a task to open its summary. Expand the card to read the full details.', anchors: ['selected'], fallbackAnchors: ['tasks'] },
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
    if (visual && ['gains', 'results'].includes(visual.dataset?.kind)) visual.innerHTML = gainsMarkup()
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

  // Cada passo tem uma visualização: dados reais da execução selecionada quando existem,
  // e exemplo rotulado quando não existem ou para mostrar estados que a execução não tem.
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
  const text = (key, ...values) => escape(translate(key, ...values))

  function readSnapshot() {
    if (!runAvailable) return null
    try {
      const snapshot = getRunSnapshot()
      return snapshot && typeof snapshot.run === 'string' ? snapshot : null
    } catch { return null }
  }

  function readGainSummary() {
    try {
      const result = getCompletedRunSummary()
      return result?.completed === true && result?.measurementComplete === true && result.figures ? result : null
    } catch { return null }
  }

  /** Copia um elemento real do dashboard sem ids, eventos inline nem foco, para ilustrar o passo. */
  function copyOf(node, limit = 4000) {
    if (!node || typeof node.cloneNode !== 'function') return ''
    try {
      const copy = node.cloneNode(true)
      const all = [copy, ...(copy.querySelectorAll?.('*') ?? [])]
      for (const element of all) {
        for (const attribute of [...(element.attributes ?? [])]) {
          if (/^on/i.test(attribute.name) || ['id', 'tabindex', 'data-prumo-guide-anchor', 'aria-controls', 'aria-describedby', 'aria-labelledby'].includes(attribute.name))
            element.removeAttribute(attribute.name)
        }
        if (element.classList?.contains?.('node')) element.removeAttribute('style')
      }
      const markup = typeof copy.outerHTML === 'string' ? copy.outerHTML : ''
      return markup.length <= limit * 4 ? markup : ''
    } catch { return '' }
  }

  function realCards() {
    const cards = [...(document.querySelectorAll?.('#nodes .node') ?? [])]
    const seen = new Set(), picked = []
    for (const card of cards) {
      const state = card.dataset?.st
      if (!state || seen.has(state)) continue
      seen.add(state)
      picked.push(card)
      if (picked.length === 4) break
    }
    for (const card of cards) {
      if (picked.length >= 3) break
      if (!picked.includes(card)) picked.push(card)
    }
    return picked.map((card) => copyOf(card)).filter(Boolean)
  }

  const tag = (real, snapshot) => real
    ? `<span class="gv-tag real">${text('From your run: {0}', snapshot?.run ?? '')}</span>`
    : `<span class="gv-tag mock">${text('Illustrative example — not current run data.')}</span>`

  const mockCard = (id, name, state, caption) =>
    `<span class="guide-example-node ${state}"><b>${escape(id)}</b><span>${text(name)}</span><small>${text(caption)}</small></span>`

  function visualKind(step, content) {
    if (step.commands) return 'commands'
    if (step.gains) return 'gains'
    if (step.flow) return 'flow'
    if (content.role) return 'roles'
    if (content.exampleGraph) return ''
    const anchor = content.anchors?.[0]
    if (anchor) return anchor === 'board' ? 'phases' : anchor
    return stepIndex === 0 ? 'intro' : ''
  }

  function visualMarkup(kind, content) {
    const snapshot = readSnapshot()
    const live = (markup) => `<div class="gv-live" inert aria-hidden="true">${markup}</div>`
    if (kind === 'intro') {
      const scope = snapshot
        ? text('{0} tasks in {1} phases · {2} in prumo', snapshot.tasks, snapshot.phases, snapshot.done)
        : text('10 tasks in 3 phases · 4 in prumo')
      return tag(Boolean(snapshot), snapshot) + `<ol class="gv-steps">
        <li><span>${text('Approved plan')}</span><small>${text('you confirm the scope')}</small></li>
        <li><span>${text('Task graph')}</span><small>${scope}</small></li>
        <li><span>${text('Agents in parallel')}</span><small>${text('each task where its dependencies allow')}</small></li>
        <li><span>${text('Independent reviewer')}</span><small>${text('checks the evidence')}</small></li>
        <li class="prumo"><span>${text('in prumo')}</span><small>${text('only after approval')}</small></li></ol>`
    }
    if (kind === 'roles') {
      const roles = [['orchestrator', 'The orchestrator', 'Facilitates discussion, confirms scope with you and coordinates phases.', 'var(--accent)'],
        ['planner', 'The planner', 'Turns confirmed decisions into a plan before work starts.', 'var(--planning)'],
        ['executor', 'The executor', 'Works on authorized tasks and records evidence for review.', 'var(--running)'],
        ['reviewer', 'The reviewer', 'Independently checks evidence; approval puts the task in prumo.', 'var(--review)']]
      return `<div class="gv-roles">${roles.map(([role, name, line, colour]) => {
        const icon = document.querySelector?.(`[data-prumo-guide-anchor="role-${role}"]`)?.querySelector?.('svg')
        return `<div class="gv-role${content.role === role ? ' on' : ''}" style="--guide-role:${colour}"><span class="gv-role-icon" aria-hidden="true">${typeof icon?.outerHTML === 'string' ? icon.outerHTML : ''}</span><b>${text(name)}</b><small>${text(line)}</small></div>`
      }).join('')}</div>`
    }
    if (kind === 'flow') {
      const chain = [['Discussion', 'var(--discussion)'], ['Planning', 'var(--planning)'], ['Execution', 'var(--running)'], ['Review', 'var(--review)'], ['in prumo', 'var(--done)']]
      return `<ol class="gv-cycle">${chain.map(([name, colour]) => `<li style="--c:${colour}">${text(name)}</li>`).join('')}</ol>` +
        tag(false) + `<div class="gv-cards">
          ${mockCard('T7', 'gateway webhooks', 'failed', 'rejected: back to the executor with the review')}
          ${mockCard('T10', 'gradual rollout', 'blocked', 'blocked: waiting for your decision')}
          ${mockCard('T1', 'orders schema', 'done', 'in prumo: the reviewer approved it')}</div>`
    }
    if (kind === 'filters') {
      const counts = snapshot ? copyOf(document.querySelector?.('#counts')) : ''
      return counts ? tag(true, snapshot) + live(counts)
        : tag(false) + `<div class="gv-counts"><span>${text('running')} <b>2</b></span><span>${text('blocked')} <b>1</b></span><span>${text('in prumo')} <b>4</b></span><span>${text('waiting')} <b>3</b></span></div>`
    }
    if (kind === 'phases' || kind === 'tasks') {
      const cards = snapshot ? realCards() : []
      return cards.length ? tag(true, snapshot) + live(`<div class="gv-nodes">${cards.join('')}</div>`)
        : tag(false) + `<div class="gv-cards">${mockCard('T4', 'payment service', 'running', 'executor')}${mockCard('T5', 'event queue', 'reviewing', 'reviewer')}${mockCard('T8', 'end-to-end tests', 'next', 'Next up')}</div>`
    }
    if (kind === 'available') {
      const items = snapshot ? [...(document.querySelectorAll?.('#available .avail') ?? [])].slice(0, 3).map((item) => copyOf(item)).filter(Boolean) : []
      return items.length ? tag(true, snapshot) + live(`<div class="gv-avail">${items.join('')}</div>`)
        : tag(false) + `<div class="gv-cards">${mockCard('T8', 'end-to-end tests', 'next', 'Next up')}${mockCard('T10', 'gradual rollout', 'blocked', 'blocked: waiting for your decision')}</div>`
    }
    if (kind === 'selected') {
      const card = document.querySelector?.('#pop')
      const selectedBox = document.querySelector?.('#popBody')
      const currentCard = card && !card.hidden && card.classList?.contains('open') && card.dataset?.run === snapshot?.run
      const selected = snapshot && currentCard && String(selectedBox?.textContent ?? '').trim().length > 40 ? copyOf(selectedBox) : ''
      return selected ? tag(true, snapshot) + live(`<div class="gv-selected">${selected}</div>`)
        : tag(false) + `<div class="gv-cards">${mockCard('T7', 'gateway webhooks', 'failed', 'rejected: back to the executor with the review')}</div>
          <p class="gv-note">${text('The panel shows its summary, what it needs to pass, its dependencies and its attempts.')}</p>`
    }
    if (kind === 'results' || kind === 'gains') return gainsMarkup()
    if (kind === 'legend') {
      const legend = copyOf(document.querySelector?.('[data-prumo-guide-anchor="legend"] .legend'))
      return legend ? `<span class="gv-tag real">${text('The legend used on this dashboard')}</span>` + live(`<div class="gv-legend">${legend}</div>`)
        : tag(false) + `<div class="gv-cards">${mockCard('T4', 'payment service', 'running', 'executor')}${mockCard('T10', 'gradual rollout', 'blocked', 'blocked: waiting for your decision')}${mockCard('T1', 'orders schema', 'done', 'in prumo: the reviewer approved it')}</div>`
    }
    if (kind === 'commands') {
      return `<div class="gv-commands"><div><span>Claude Code · Kiro · DSH</span><code>/prumo</code></div><div><span>Codex</span><code>$prumo</code></div></div>`
    }
    return ''
  }

  function gainsMarkup() {
    const summary = readGainSummary()
    const figures = summary?.figures
    const real = Boolean(figures && figures.oneAtATimeMs > 0)
    const one = real ? figures.oneAtATimeMs : 120, prumo = real ? figures.withPrumoMs : 30
    const width = (value) => Math.max(1, Math.min(100, (100 * value) / Math.max(one, 1))).toFixed(1)
    const label = real ? `<span class="gv-tag real">${text('Measured from a completed run')}</span>` : tag(false)
    return label + `<div class="gv-gain">
      <div><span>${text('One agent at a time')}</span><strong>${escape(real ? figures.oneAtATime : '2h00')}</strong><i style="width:100%"></i></div>
      <div><span>${text('With Prumo')}</span><strong>${escape(real ? figures.withPrumo : '30m')}</strong><i class="par" style="width:${width(prumo)}%"></i></div>
      <div class="save"><span>${text('Measured savings')}</span><strong>${escape(real ? figures.savings : '1h30')}</strong><small>${escape(real ? figures.factor : '4×')}</small></div></div>`
  }

  function renderVisual(step, content) {
    if (!visual) return
    const kind = visualKind(step, content)
    let markup = ''
    try { markup = kind ? visualMarkup(kind, content) : '' } catch { markup = '' }
    visual.innerHTML = markup
    visual.hidden = !markup
    visual.dataset.kind = kind
    visual.classList?.toggle?.('gv-anchored', Boolean(content.anchors?.length || content.role))
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
    renderVisual(step, content)
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

  let fullscreenPending = false
  let fullscreenOwned = false

  function leaveFullscreen() {
    if (fullscreenOwned && document.fullscreenElement === root && document.exitFullscreen) {
      try { Promise.resolve(document.exitFullscreen()).catch(() => {}) } catch { /* O guia já pode estar fora da tela cheia. */ }
    }
    fullscreenOwned = false
  }

  function enterPresentation() {
    root.classList.add('presenting')
    if (!root.requestFullscreen || document.fullscreenElement) return
    fullscreenPending = true
    try {
      Promise.resolve(root.requestFullscreen()).then(() => {
        fullscreenPending = false
        if (document.fullscreenElement !== root) return
        fullscreenOwned = true
        if (root.hidden) leaveFullscreen()
      }, () => { fullscreenPending = false })
    } catch { fullscreenPending = false /* A apresentação na página independe da API de tela cheia. */ }
  }

  function open() {
    dismissed = false
    runAvailable = readRunAvailability()
    renderStep(0)
    root.hidden = false
    launcher.setAttribute('aria-expanded', 'true')
    next.focus?.()
    enterPresentation()
  }

  function close() {
    if (dismissed) return
    dismissed = true
    root.hidden = true
    root.classList.remove('presenting')
    clearHighlights()
    launcher.setAttribute('aria-expanded', 'false')
    rememberDismissal()
    leaveFullscreen()
    launcher.focus?.()
  }

  function refreshRunAvailability() {
    const available = readRunAvailability()
    if (available === runAvailable) return
    runAvailable = available
    // Os exemplos reais dependem da execução selecionada; o passo aberto troca de exemplo na hora.
    if (!root.hidden || stepIndex === 3) renderStep(stepIndex, demoIndex)
  }

  launcher.addEventListener('click', () => open())
  previous.addEventListener('click', previousStep)
  next.addEventListener('click', nextStep)
  skip.addEventListener('click', close)
  openLegend.addEventListener('click', () => {
    document.querySelector('#sidebarToggle')?.click()
    renderStep(stepIndex, demoIndex)
  })
  document.addEventListener('fullscreenchange', () => {
    if (fullscreenPending && document.fullscreenElement === root) {
      fullscreenOwned = true
      if (root.hidden) leaveFullscreen()
    } else if (fullscreenOwned && document.fullscreenElement !== root) {
      fullscreenOwned = false
      if (!root.hidden) close()
    }
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
    open()
  }

  return { open, close, refreshGains, refreshRunAvailability }
}
