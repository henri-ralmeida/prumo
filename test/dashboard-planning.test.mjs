import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { localizeDashboard } from '../scripts/i18n.mjs'

const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
const instant = (seconds) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString()
const task = (id, state = 'pending', fields = {}) => ({
  id, title: `Task ${id}`, phase: 'P1', state, deps: [], attempts: [], validations: [], notes: [], ...fields,
})
const plan = {
  planner: 'planner-1', startedAt: instant(0), completedAt: instant(20),
  research: [{ source: 'src/task.mjs', findings: 'Existing behavior verified' }],
  decisions: [{ question: 'Reuse existing function?', answer: 'Yes' }],
  steps: ['Update shared function', 'Run functional check'],
  verification: [{ criterion: 'Required behavior', check: 1 }], openQuestions: [],
}
const discovery = {
  recordedAt: instant(0), closure: 'No consequential gray area remains.',
  research: [{ source: 'src/task.mjs', findings: 'Current task context inspected' }],
  questions: [{ question: 'Keep current behavior?', answer: 'Yes', channel: 'chat-fallback', round: 1 }],
  coverage: { problem: 'Problem', affected: 'People', outcome: 'Outcome', currentBehavior: 'Current',
    desiredBehavior: 'Desired', rules: 'Rules', exceptions: 'Exceptions', scope: 'Scope', acceptance: 'Acceptance' },
  decisions: [{ question: 'Keep behavior?', answer: 'Yes' }], deferred: ['Future idea'],
  executionBoundary: { deferredToExecutor: ['T'], prematureTaskWork: [] },
}

function dashboard(lang = 'en', width = 1000, session = new Map(), navigation = { state: null, urls: [] }) {
  const nodes = new Map(), cards = [], paths = []
  const documentListeners = new Map(), windowListeners = new Map()
  let viewportWidth = width, viewportHeight = 700, animationFrame = null
  const element = (initialClasses = []) => {
    const classes = new Set(initialClasses)
    const attributes = new Map()
    const listeners = new Map()
    let markup = ''
    return {
      textContent: '', dataset: {}, style: { setProperty() {} },
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)) },
        remove(...names) { names.forEach((name) => classes.delete(name)) },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force)
          if (enabled) classes.add(name); else classes.delete(name)
          return enabled
        },
        contains(name) { return classes.has(name) },
      },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, [])
        listeners.get(type).push(listener)
      },
      dispatchEvent(type, event) {
        for (const listener of listeners.get(type) ?? []) listener(event)
      },
      setPointerCapture() {},
      setAttribute(name, value) { attributes.set(name, String(value)) },
      getAttribute(name) { return attributes.get(name) ?? null },
      offsetWidth: 280, offsetHeight: 300,
      getBoundingClientRect: () => ({ width: 1000, height: 700, left: 0, right: 1000, top: 0 }),
      get innerHTML() { return markup },
      set innerHTML(value) { markup = String(value) },
    }
  }
  const materialize = (markup, tag, target) => {
    target.length = 0
    const pattern = new RegExp(`<${tag}\\b([^>]*)>`, 'g')
    const sources = [...markup.matchAll(pattern)]
    const nodeCount = tag === 'div' ? sources.filter(([, source]) => /class="[^"]*\bnode\b/.test(source)).length : 0
    const cardSize = nodeCount <= 24 ? [212, 52] : nodeCount <= 100 ? [202, 48] : [194, 44]
    for (const [, source] of sources) {
      const attrs = Object.fromEntries([...source.matchAll(/([:\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))
      const initialClasses = (attrs.class ?? '').split(/\s+/).filter(Boolean)
      if (tag === 'div' && !initialClasses.includes('node')) continue
      const item = element(initialClasses)
      for (const [name, value] of Object.entries(attrs)) {
        item.setAttribute(name, value)
        if (name.startsWith('data-')) item.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
      }
      for (const declaration of (attrs.style ?? '').split(';')) {
        const [name, value] = declaration.split(':')
        if (name?.trim()) item.style[name.trim()] = value?.trim() ?? ''
      }
      if (tag === 'div') item.getBoundingClientRect = () => {
        const left = Number.parseFloat(item.style.left) || 0
        const top = Number.parseFloat(item.style.top) || 0
        const [width, height] = cardSize
        return { left, right: left + width, top, bottom: top + height, width, height }
      }
      target.push(item)
    }
  }
  const labels = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(([, key]) => {
    const node = element()
    node.dataset.i18n = key.replaceAll('&amp;', '&')
    return node
  })
  const querySelectorAll = (selector) => {
    if (selector === '[data-i18n]') return labels
    if (selector === '.node') return cards
    if (selector === '.node.lit, .node.lit-self') return cards.filter((node) => node.classList.contains('lit') || node.classList.contains('lit-self'))
    if (selector === '#edgePaths path') return paths
    if (selector === '#edgePaths path.lit') return paths.filter((path) => path.classList.contains('lit'))
    return []
  }
  const location = { search: '', origin: 'http://localhost', href: 'http://localhost/' }
  const context = createContext({
    document: {
      documentElement: element(),
      querySelector(selector) {
        const cardId = selector.match(/^\.node\[data-id="([^"]+)"\]$/)?.[1]
        if (cardId) return cards.find((node) => node.dataset.id === cardId) ?? null
        if (!nodes.has(selector)) {
          const node = element()
          if (selector === '#nodes' || selector === '#edgePaths') {
            const target = selector === '#nodes' ? cards : paths
            const tag = selector === '#nodes' ? 'div' : 'path'
            Object.defineProperty(node, 'innerHTML', {
              get() { return node._markup ?? '' },
              set(value) { node._markup = String(value); materialize(node._markup, tag, target) },
            })
          }
          if (selector === '#viewport') node.getBoundingClientRect = () =>
            ({ width: viewportWidth, height: viewportHeight, left: 0, right: viewportWidth, top: 0 })
          nodes.set(selector, node)
        }
        return nodes.get(selector)
      },
      querySelectorAll,
      addEventListener(name, listener) {
        if (!documentListeners.has(name)) documentListeners.set(name, [])
        documentListeners.get(name).push(listener)
      },
    },
    location,
    history: {
      get state() { return navigation.state },
      replaceState(state, _unused, url) {
        navigation.state = state
        if (url !== undefined) {
          location.href = String(url)
          location.search = new URL(location.href).search
          navigation.urls.push(location.href)
        }
      },
    },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: (key) => session.get(key) ?? null, setItem: (key, value) => session.set(key, value) },
    URL, URLSearchParams,
    innerWidth: width + 330, innerHeight: 800,
    performance: { now: () => 0 }, CSS: { escape: (text) => text },
    addEventListener(name, listener) {
      if (!windowListeners.has(name)) windowListeners.set(name, [])
      windowListeners.get(name).push(listener)
    },
    requestAnimationFrame(callback) { animationFrame = callback; return 1 },
    setTimeout() {}, clearTimeout() {},
    Date: class extends Date { static now() { return Date.parse(instant(100)) } },
  })
  // Run the shipped script, excluding its network polling boot; render/localize stay real.
  const script = localizeDashboard(html, lang).match(/<script>([\s\S]*?)<\/script>/)[1]
  runInContext(script.replace(/localize\(\)\s*tick\(\)\s*$/, ''), context)
  return {
    nodes, labels, cards, paths,
    run(code, values = {}) { Object.assign(context, values); return runInContext(code, context) },
    dispatchDocument(type, event, inline = () => {}) {
      inline()
      for (const listener of documentListeners.get(type) ?? []) listener(event)
    },
    dispatchElement(selector, type, event) { nodes.get(selector)?.dispatchEvent(type, event) },
    render(state, events = []) { this.run('STATE = input; render(STATE, inputEvents)', { input: state, inputEvents: events }) },
    flushFrame(nextWidth = viewportWidth) {
      viewportWidth = nextWidth
      const callback = animationFrame
      animationFrame = null
      callback?.()
    },
    resize(nextWidth, nextHeight = viewportHeight) {
      viewportWidth = nextWidth
      viewportHeight = nextHeight
      context.innerWidth = nextWidth + 330
      context.innerHeight = nextHeight + 100
      for (const listener of windowListeners.get('resize') ?? []) listener()
      const callback = animationFrame
      animationFrame = null
      callback?.()
    },
  }
}

function graphState(count, phaseCount = 4) {
  const phases = Array.from({ length: phaseCount }, (_, i) => ({ id: `P${i + 1}`, title: `Phase ${i + 1}` }))
  const tasks = Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const id = `T${String(i + 1).padStart(3, '0')}`
    return [id, task(id, i === 0 ? 'running' : 'pending', { phase: phases[i % phaseCount]?.id ?? 'P1' })]
  }))
  return { run: `fixture-${count}`, plan: { phases }, tasks,
    derived: Object.fromEntries(Object.keys(tasks).map((id) => [id, { effective: tasks[id].state, blockedBy: [] }])) }
}

test('waiting cards identify the blocking phase even without their own task dependencies', () => {
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    const state = graphState(1, 1)
    state.tasks.T001.state = 'pending'
    state.derived.T001 = { effective: 'waiting', blockedBy: [], planningBlockedBy: ['F2'] }
    ui.render(state)
    assert.match(ui.nodes.get('#nodes').innerHTML, /← F2/)
  }
})

test('dashboard marks declared manual inspection as pending and displays plan writes and required resources', () => {
  for (const [lang, pending, requires, writes] of [
    ['en', 'Manual inspection pending', 'Requires: manual-inspection', 'Writes'],
    ['pt-BR', 'Inspeção manual pendente', 'Requer: manual-inspection', 'Caminhos declarados para escrita'],
  ]) {
    const ui = dashboard(lang)
    const state = graphState(1, 1)
    const taskValue = state.tasks.T001
    taskValue.unavailable = ['manual-inspection']
    taskValue.taskPlan = { ...plan, writes: ['src/report.mjs'], verification: [
      { criterion: 'the report is checked', check: 1, requires: ['manual-inspection'] },
    ] }
    state.derived.T001.manualInspectionPending = true
    ui.render(state)
    assert.ok(ui.nodes.get('#nodes').innerHTML.includes(pending))
    ui.run("POP_MODE = 'detail'; fillPop('T001')")
    const detail = ui.nodes.get('#popBody').innerHTML
    assert.ok(detail.includes(pending))
    assert.ok(detail.includes(requires))
    assert.ok(detail.includes(writes))
    assert.ok(detail.includes('src/report.mjs'))
  }
})

test('dashboard footer shows package version, origin, content ID and path, with an unavailable fallback', async () => {
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    const about = { version: '2.0.0', origin: 'global', contentId: 'a1b2c3d4e5f6', path: 'C:\\Prumo\\global\\package' }
    await ui.run('loadIdentity()', { fetch: async url => {
      assert.equal(url, '/api/about')
      return { ok: true, json: async () => about }
    } })
    const identity = ui.nodes.get('#identity')
    const expected = ui.run("tr('Prumo v{0} · {1} · content {2} · path {3}', '2.0.0', tr('global package'), 'a1b2c3d4e5f6', 'C:\\\\Prumo\\\\global\\\\package')")
    assert.equal(identity.textContent, expected)
    assert.equal(identity.getAttribute('title'), expected)
    assert.equal(identity.getAttribute('aria-label'), expected)

    const unavailable = dashboard(lang)
    await unavailable.run('loadIdentity()', { fetch: async () => { throw new Error('offline') } })
    assert.equal(unavailable.nodes.get('#identity').textContent, unavailable.run("tr('Package identity unavailable')"))
  }
})

test('dashboard renders separate planning queues, active planner hub and execution readiness in both languages', () => {
  const tasks = {
    P: task('P', 'pending', { planningRequired: true }),
    A: task('A', 'planning', { planner: 'planner-1', planningAttempts: [{ startedAt: instant(10), agent: 'planner-1' }] }),
    E: task('E', 'pending', { planningRequired: true, planner: 'planner-1', taskPlan: plan }),
    W: task('W', 'pending', { deps: ['R'] }),
    R: task('R', 'running', { agent: 'executor-1', attempts: [{ startedAt: instant(10) }] }),
    V: task('V', 'reviewing', { reviewer: 'reviewer-1', attempts: [{ startedAt: instant(10), reviewStartedAt: instant(30) }] }),
    D: task('D', 'done'), F: task('F', 'failed'), B: task('B', 'blocked'), S: task('S', 'skipped'),
  }
  const states = { P: 'ready_to_plan', A: 'planning', E: 'ready', W: 'waiting', R: 'running', V: 'reviewing', D: 'done', F: 'failed', B: 'blocked', S: 'skipped' }
  const state = { run: 'planning-test', plan: { phases: [{ id: 'P1', title: 'Phase 1' }] }, tasks,
    derived: Object.fromEntries(Object.entries(states).map(([id, effective]) => [id, { effective, blockedBy: tasks[id].deps }])) }
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    ui.render(state)
    const expected = lang === 'en' ? ['ready for planning', 'planning', 'ready for execution'] : ['pronto para planejamento', 'em planejamento', 'pronto para executar']
    for (const label of expected) {
      const legendLabel = label === 'planning' ? 'planning · planner' : label === 'em planejamento' ? 'planejamento · planejador' : label
      assert.ok(ui.labels.some((node) => node.textContent === legendLabel), `Legend: ${legendLabel}`)
      assert.ok(ui.nodes.get('#counts').innerHTML.includes(`${label} <b>1</b>`), `Counter: ${label}`)
    }
    for (const [id, status] of Object.entries(states)) {
      assert.match(ui.nodes.get('#nodes').innerHTML, new RegExp(`data-st="${status}"[^>]*data-id="${id}"`))
      ui.run('fillPop(id)', { id })
      assert.ok(ui.nodes.get('#popBody').innerHTML.includes(ui.run('statusLabel(status)', { status })))
    }
    const colors = ui.run("['ready_to_plan', 'planning', 'ready'].map(s => ST_COLOR[s])")
    assert.equal(new Set(colors).size, 3)
    const values = colors.map((cssVar) => html.match(new RegExp(`${cssVar.slice(4, -1)}: (#[a-f0-9]+)`))[1])
    assert.deepEqual([...values], ['#8a7bd6', '#b69cff', '#f5b58a'])
    assert.notEqual(ui.run('ST_COLOR.ready_for_discussion'), ui.run('ST_COLOR.discussing'), 'a queued discussion must not look like one in progress')
    assert.match(ui.nodes.get('#parallel').innerHTML, /class="plan"[^>]*openTask\('A'\)[\s\S]*@planner-1/)
    assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML, /openTask\('[PEWDFBS]'\)/)
    assert.match(ui.nodes.get('#planSub').textContent, /1: A/)
    assert.equal(ui.nodes.get('#planNode').classList.contains('live'), true)
    assert.doesNotMatch(ui.nodes.get('#edgePaths').innerHTML, /data-from="__/, 'roles light up in the hub; only dependencies draw lines')
    assert.equal(ui.nodes.get('#bar .seg-plan').style.width, `${100 / 9}%`)
    assert.equal(ui.nodes.get('#bar .seg-review').style.width, `${100 / 9}%`)
    assert.ok(Number.parseFloat(ui.nodes.get('#planNode').style.left) >= 0)
  }
})

test('dashboard observes phase discussion, phase planning and per-task input readiness in both languages', () => {
  const tasks = {
    A: task('A', 'pending', { phase: 'F1', deps: ['C'], planningRequired: true,
      taskPlan: { ...plan, phaseId: 'F1', unresolvedInputs: [{ task: 'C', phase: 'F2', requiredEvidence: 'validated output' }] } }),
    B: task('B', 'pending', { phase: 'F1', planningRequired: true, taskPlan: { ...plan, phaseId: 'F1', unresolvedInputs: [] } }),
    C: task('C', 'pending', { phase: 'F2', planningRequired: true }),
  }
  const state = { run: 'phase-observer', plan: { planningMode: 'phase', maxParallel: 4,
    phases: [{ id: 'F1', title: 'Consumers' }, { id: 'F2', title: 'Producer' }] }, tasks,
    phaseWorkflows: {
      F1: { id: 'F1', state: 'discussing', discussionAttempts: [{ targets: ['A', 'B'] }], planningAttempts: [] },
      F2: { id: 'F2', state: 'planning', discussionAttempts: [{ targets: ['C'] }], planningAttempts: [{ targets: ['C'] }] },
    },
    derived: {
      A: { effective: 'discussing', blockedBy: ['C'], planningStatus: 'phase_discussing', inputStatus: 'unresolved_later_phase_input' },
      B: { effective: 'discussing', blockedBy: [], planningStatus: 'phase_discussing' },
      C: { effective: 'planning', blockedBy: [], planningStatus: 'phase_planning' },
    } }
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang); ui.render(state)
    assert.match(ui.nodes.get('#orchSub').textContent, lang === 'en' ?
      /phase discussion F1: 2 tasks.*phase execution locked/ : /discussão da fase F1: 2 tarefas.*execução da fase bloqueada/)
    assert.match(ui.nodes.get('#planSub').textContent, lang === 'en' ? /phase planning F2: 1 tasks/ : /planejamento da fase F2: 1 tarefas/)
    assert.match(ui.nodes.get('#lanes').innerHTML, lang === 'en' ? /discussion · orchestrator/ : /discussão · orquestrador/)
    assert.match(ui.nodes.get('#lanes').innerHTML, lang === 'en' ? /planning · planner/ : /planejamento · planejador/)
    assert.match(ui.nodes.get('#lanes').innerHTML, /lane-state planning/)
    assert.match(ui.nodes.get('#nodes').innerHTML, lang === 'en' ? /unresolved later-phase input/ : /entrada de fase posterior não resolvida/)
    state.derived.A.inputStatus = 'unresolved_input'
    ui.render(state)
    assert.match(ui.nodes.get('#nodes').innerHTML, lang === 'en' ? /unresolved input/ : /entrada não resolvida/)
    state.derived.A.inputStatus = 'unresolved_later_phase_input'
    assert.match(ui.nodes.get('#nodes').innerHTML, /data-st="planning"[^>]*data-id="C"/)
    const planningLabel = lang === 'en' ? 'planning' : 'em planejamento'
    const plannerLabel = lang === 'en' ? 'planner' : 'planejador'
    assert.match(ui.nodes.get('#nodes').innerHTML, new RegExp(`aria-label="C: ${planningLabel}"`))
    assert.doesNotMatch(ui.nodes.get('#nodes').innerHTML, new RegExp(`aria-label="C: ${planningLabel} · ${plannerLabel}"`),
      'the phase owns the planner relationship; member cards expose only their active state')
    assert.match(ui.nodes.get('#nodes').innerHTML, /data-st="discussing"[^>]*data-id="A"/,
      'an open phase discussion owns the active visual state before execution readiness')
    assert.equal(ui.nodes.get('#orchNode').classList.contains('discussing'), true)
    assert.equal(ui.nodes.get('#planNode').classList.contains('live'), true)
    assert.doesNotMatch(ui.nodes.get('#edgePaths').innerHTML, /__phase-/,
      'the phase board carries its own state pill; no role line crosses the board')
  }
  assert.doesNotMatch(html, /fetch\([^)]*begin-phase|onclick="[^"]*phase-(?:discussion|planning)/,
    'phase workflow remains observer-only')
})

test('summary counts include discussion and legacy pending tasks', () => {
  const tasks = { A: task('A'), B: task('B', 'discussing'), C: task('C'), D: task('D', 'done') }
  const derived = Object.fromEntries(Object.entries({ A: 'ready_for_discussion', B: 'discussing', C: 'pending', D: 'done' })
    .map(([id, effective]) => [id, { effective, blockedBy: [] }]))
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    ui.render({ run: 'summary', plan: { phases: [] }, tasks, derived })
    const summary = ui.nodes.get('#counts').innerHTML
    assert.equal([...summary.matchAll(/<b>(\d+)<\/b>/g)].reduce((sum, match) => sum + Number(match[1]), 0), 4)
    for (const state of ['ready_for_discussion', 'discussing', 'pending']) {
      assert.ok(summary.includes(ui.run('statusLabel(value)', { value: state })))
    }
    assert.doesNotMatch(summary, /color:undefined/)
  }
})

test('height-only resize keeps the untouched board at 100% anchored at the top', () => {
  const ui = dashboard('en', 1000)
  ui.render(graphState(48, 8))
  ui.resize(1000, 350)
  assert.equal(ui.run('VIEW.k'), 1)
  assert.equal(ui.run('VIEW.y'), 0)
})

test('dashboard keeps an unadopted legacy phase pending until explicit adoption', () => {
  const state = { run: 'legacy-phase', plan: { planningMode: 'phase', phases: [{ id: 'F1', title: 'Adopted' }, { id: 'F2', title: 'Legacy' }] },
    legacyPhaseAdoption: true,
    phaseWorkflows: {
      F1: { id: 'F1', state: 'planned', adoptedLegacy: true, discussionAttempts: [], planningAttempts: [] },
      F2: { id: 'F2', state: 'pending', discussionAttempts: [], planningAttempts: [] },
    },
    tasks: { B: task('B', 'pending', { phase: 'F2', planningRequired: true }) },
    derived: { B: { effective: 'pending', blockedBy: [], planningStatus: 'awaiting_phase_adoption' } } }
  for (const [lang, label] of [['en', 'awaiting phase adoption'], ['pt-BR', 'aguardando adoção da fase']]) {
    const ui = dashboard(lang)
    ui.render(state)
    const card = ui.cards.find(node => node.dataset.id === 'B')
    assert.equal(card.dataset.st, 'pending')
    assert.match(ui.nodes.get('#nodes').innerHTML, new RegExp(label))
    assert.doesNotMatch(ui.nodes.get('#nodes').innerHTML, /ready for discussion|pronto para discussão|ready for execution|pronto para executar/)
  }
})

test('status filters use effective state and always show only direct dependency context', () => {
  assert.ok(html.indexOf('.node.filtered-out') > html.indexOf('.node[data-st="skipped"]'),
    'filter opacity must override every task-state opacity')
  const tasks = {
    A: task('A', 'done'),
    B: task('B', 'pending', { deps: ['A'] }),
    C: task('C', 'pending', { deps: ['B'] }),
    D: task('D', 'pending', { deps: ['C'] }),
    P: task('P', 'pending', { planningRequired: true }),
    L: task('L', 'planning'), E: task('E'), R: task('R', 'reviewing'),
    K: task('K', 'blocked'), F: task('F', 'failed'), S: task('S', 'skipped'), U: task('U', 'future_state'),
  }
  const effective = { A: 'done', B: 'running', C: 'waiting', D: 'pending', P: 'ready_to_plan', L: 'planning',
    E: 'ready', R: 'reviewing', K: 'blocked', F: 'failed', S: 'skipped', U: 'future_state' }
  const state = { run: 'filters', plan: { phases: [{ id: 'P1', title: 'Phase 1' }] }, tasks,
    derived: Object.fromEntries(Object.entries(effective).map(([id, value]) => [id, { effective: value, blockedBy: tasks[id].deps }])) }
  const ui = dashboard()
  ui.render(state)
  const matches = (filter) => ui.run("JSON.stringify([...filterSets(STATE.tasks, inputFilter).matches].sort())", { inputFilter: filter })
  const allowed = (filter) => ui.run("JSON.stringify([...filterSets(STATE.tasks, inputFilter).allowed].sort())", { inputFilter: filter })
  const card = (id) => ui.cards.find((node) => node.dataset.id === id)
  const edge = (from, to) => ui.paths.find((path) => path.dataset.from === from && path.dataset.to === to)
  const hidden = (from, to) => !edge(from, to) || edge(from, to).classList.contains('filter-hidden')
  const expected = {
    done: ['A'], incomplete: ['B', 'C', 'D', 'E', 'F', 'K', 'L', 'P', 'R', 'U'], waiting: ['C'],
    ready_to_plan: ['P'], planning: ['L'], ready: ['E'], running: ['B'], reviewing: ['R'],
    blocked: ['K'], failed: ['F'], skipped: ['S'],
  }
  assert.equal(matches('all'), JSON.stringify(Object.keys(tasks).sort()))
  for (const [filter, ids] of Object.entries(expected)) assert.equal(matches(filter), JSON.stringify(ids), filter)
  assert.equal(allowed('all'), JSON.stringify(Object.keys(tasks).sort()), 'no filter adds no context')
  assert.equal(allowed('running'), JSON.stringify(['A', 'B']))
  assert.equal(ui.run("JSON.stringify([...filterSets(STATE.tasks, 'missing').matches])"), '[]')

  assert.equal(ui.cards.length, Object.keys(tasks).length)
  for (const endpoints of [['A', 'B'], ['B', 'C'], ['C', 'D']])
    assert.ok(edge(...endpoints), endpoints.join(' → '))
  const originalState = JSON.stringify(state)
  assert.equal(hidden('A', 'B'), true, 'the unfiltered graph keeps its prior dependency visibility')

  ui.run("setFilter('running')")
  assert.equal(card('B').classList.contains('filtered-out'), false)
  assert.equal(card('A').classList.contains('filtered-out'), false)
  assert.equal(card('A').classList.contains('dependency-context'), true)
  assert.equal(card('B').classList.contains('dependency-context'), false)
  assert.equal(card('C').classList.contains('filtered-out'), true)
  assert.equal(ui.nodes.get('#filterCount').textContent, 'filter results 1/12')
  assert.equal(hidden('A', 'B'), false)
  assert.equal(edge('A', 'B').classList.contains('context-edge'), true)
  assert.equal(hidden('B', 'C'), true)
  assert.equal(hidden('C', 'D'), true)

  ui.run("setFilter('incomplete')")
  assert.equal(card('B').classList.contains('filtered-out'), false)
  assert.equal(card('C').classList.contains('filtered-out'), false)
  assert.equal(hidden('B', 'C'), false, 'dependencies remain visible when both endpoints match the filter')
  assert.equal(edge('B', 'C').classList.contains('context-edge'), false)
  assert.equal(edge('A', 'B').classList.contains('context-edge'), true, 'direct dependencies outside the filter stay dimmed')

  ui.run("setFilter('running')")
  ui.run("openTask('B'); setFilter('reviewing')")
  assert.equal(ui.run('POP === null'), true)
  assert.equal(ui.nodes.get('#pop').classList.contains('open'), false)

  ui.run("setFilter('running')")
  assert.equal(card('D').classList.contains('filtered-out'), true)
  assert.equal(JSON.stringify(state), originalState, 'filtering must not rewrite any task or dependency')
  ui.run("FOCUS = 'B'; applyFocus()")
  assert.deepEqual(ui.cards.filter((node) => node.classList.contains('lit')).map((node) => node.dataset.id).sort(), ['A', 'B'])
  assert.equal(card('B').classList.contains('lit-self'), true)
  assert.equal(edge('A', 'B').classList.contains('lit'), true)
  assert.equal(edge('B', 'C').classList.contains('filter-hidden'), true)

  ui.run("setFilter('reviewing')")
  ui.run("openTask('R')")
  const completed = structuredClone(state)
  completed.tasks.R.status = 'done'
  completed.derived.R.effective = 'done'
  ui.render(completed)
  assert.equal(ui.run('POP'), null, 'live status changes close details when the card leaves the filter')
  assert.equal(card('R').classList.contains('filtered-out'), true)
})
test('filter controls expose every state and localize labels', () => {
  assert.doesNotMatch(html, /id="depsBtn"|toggleDependencies/)
  const options = [...html.matchAll(/<option value="([^"]+)"/g)].map(([, value]) => value)
  assert.deepEqual(options, ['all', 'done', 'incomplete', 'waiting', 'ready_for_discussion', 'discussing', 'ready_to_plan', 'planning', 'ready', 'running', 'reviewing', 'blocked', 'failed', 'skipped'])
  for (const [lang, labels] of [['en', ['all tasks', 'incomplete', 'ignored']], ['pt-BR', ['todas', 'incompletas', 'ignoradas']]]) {
    const ui = dashboard(lang)
    ui.render({ run: 'empty-filter', plan: { phases: [] }, tasks: {}, derived: {} })
    for (const label of labels) assert.ok(ui.labels.some((node) => node.textContent === label), `${lang}: ${label}`)
    assert.equal(ui.nodes.get('#filterCount').textContent, lang === 'en' ? 'filter results 0/0' : 'resultado do filtro 0/0')
  }
})

test('a run-only URL selects that run in the current root', () => {
  assert.match(html, /const selectedRoot = SELECTED_ROOT \?\? currentRoot/)
  assert.match(html, /selectedRoot && SELECTED_RUN[\s\S]*selectedRoot\}\/\$\{SELECTED_RUN/)
})

test('filters preserve the full graph and show matching task dependencies as context', () => {
  const ui = dashboard('pt-BR')
  const tasks = { A: task('A', 'pending', { phase: 'F0' }), B: task('B', 'pending', { phase: 'F1', deps: ['A'] }),
    C: task('C', 'pending', { phase: 'F7' }) }
  const state = { run: 'phase-filter', plan: { phases: Array.from({ length: 8 }, (_, i) => ({ id: `F${i}`, title: `Phase ${i}` })) }, tasks,
    derived: { A: { effective: 'ready_for_discussion' }, B: { effective: 'waiting', blockedBy: ['A'] }, C: { effective: 'ready_for_discussion' } } }
  ui.render(state)
  const fullHeight = ui.run('CANVAS_H')
  ui.run("setFilter('ready_for_discussion')")
  assert.deepEqual(ui.cards.map(card => card.dataset.id), ['A', 'B', 'C'])
  assert.equal(ui.cards.find(card => card.dataset.id === 'B').classList.contains('filtered-out'), true)
  assert.match(ui.nodes.get('#lanes').innerHTML, /F0/)
  assert.match(ui.nodes.get('#lanes').innerHTML, /F7/)
  assert.match(ui.nodes.get('#lanes').innerHTML, /F1|F6/)
  assert.equal(ui.run('CANVAS_H'), fullHeight)
  ui.run("setFilter('waiting')")
  assert.equal(ui.cards.find(card => card.dataset.id === 'B').classList.contains('filtered-out'), false)
  assert.equal(ui.cards.find(card => card.dataset.id === 'A').classList.contains('filtered-out'), false)
  assert.equal(ui.cards.find(card => card.dataset.id === 'A').classList.contains('dependency-context'), true)
  ui.run("setFilter('done')")
  assert.equal(ui.cards.length, 3)
  assert.equal(ui.cards.every(card => card.classList.contains('filtered-out')), true)
  assert.notEqual(ui.nodes.get('#lanes').innerHTML, '')
  ui.run("setFilter('all')")
  assert.deepEqual(ui.cards.map(card => card.dataset.id), ['A', 'B', 'C'])
  assert.equal(ui.cards.some(card => card.classList.contains('filtered-out')), false)
})

test('opening and closing the legend preserves fixed scale and manual pan', () => {
  for (const setup of ['', 'VIEW.x -= 40; VIEW.y -= 20; VIEW_MANUAL = true; applyView()']) {
    const ui = dashboard('en', 1000)
    ui.render(graphState(30))
    if (setup) ui.run(setup)
    const before = JSON.parse(ui.run('JSON.stringify({ view: VIEW, manual: VIEW_MANUAL })'))
    const assertView = () => {
      const after = JSON.parse(ui.run("JSON.stringify({ view: VIEW, manual: VIEW_MANUAL, width: CANVAS_W, height: CANVAS_H, vw: $('#viewport').getBoundingClientRect().width, vh: $('#viewport').getBoundingClientRect().height })"))
      assert.equal(after.view.k, 1)
      assert.equal(after.manual, before.manual)
      assert.ok(after.view.x >= Math.min(0, after.vw - after.width))
      assert.ok(after.view.x <= Math.max(0, (after.vw - after.width) / 2))
      assert.ok(after.view.y >= Math.min(0, after.vh - after.height))
      assert.ok(after.view.y <= 0)
    }
    ui.run('toggleSidebar()')
    ui.flushFrame(1330)
    assertView()
    ui.run('toggleSidebar()')
    ui.flushFrame(1000)
    assertView()
  }
})
test('responsive layout selects density and sizes phase lanes from their cards', () => {
  for (const [count, expected] of [[6, 'detailed'], [24, 'detailed'], [25, 'compact'], [48, 'compact'], [100, 'compact'], [101, 'dense'], [206, 'dense']]) {
    const ui = dashboard('en', 960)
    const state = graphState(count)
    const result = JSON.parse(ui.run("STATE = input; JSON.stringify(layout(STATE.tasks))", { input: state }))
    assert.equal(result.density, expected, `${count} tasks`)
    const cardDrivenWidth = Math.max(636, 80 + result.capacity * result.metrics.nodeW + (result.capacity - 1) * 16)
    assert.equal(result.w, cardDrivenWidth)
    for (const point of Object.values(result.pos)) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `${count}: finite coordinates`)
      assert.ok(point.x + result.metrics.nodeW <= result.w - 40, `${count}: bounded x`)
    }
    ui.render(state)
    assert.equal(ui.nodes.get('#canvas').dataset.density, expected)
  }

  const phasedUi = dashboard('en', 700)
  const phased = JSON.parse(phasedUi.run('STATE = input; JSON.stringify(layout(STATE.tasks))', { input: graphState(48, 4) }))
  assert.ok(new Set(Object.values(phased.pos).map(({ y }) => y)).size > 1, 'phase bands wrap vertically')

  const unphasedState = graphState(48, 1)
  unphasedState.plan.phases = []
  const unphasedUi = dashboard('en', 700)
  const unphased = JSON.parse(unphasedUi.run('STATE = input; JSON.stringify(layout(STATE.tasks))', { input: unphasedState }))
  assert.equal(unphased.lanes.length, 0, 'a plan without phases renders one unlabelled band')
  assert.equal(unphased.metrics.nodeW, phased.metrics.nodeW, 'the phase layout is the only layout')
  assert.ok(new Set(Object.values(unphased.pos).map(({ y }) => y)).size > 1, 'the single band wraps vertically')
  assert.doesNotMatch(html, /layoutBtn|toggleLayout|graphLayout/, 'no way to switch the graph layout')

  const tallState = graphState(28, 23)
  const tallTasks = Object.values(tallState.tasks)
  tallTasks.slice(0, 6).forEach(task => { task.phase = 'P1' })
  tallTasks.slice(6).forEach((task, index) => { task.phase = `P${index + 2}` })
  const tallUi = dashboard('en', 1000)
  const tallLayout = JSON.parse(tallUi.run("STATE = input; JSON.stringify(layout(STATE.tasks))", { input: tallState }))
  assert.equal(tallLayout.capacity, 6, 'many phases must not force a six-card phase into one column')
  assert.equal(new Set(tallTasks.slice(0, 6).map(task => tallLayout.pos[task.id].y)).size, 1)

  const state = graphState(206)
  const wide = dashboard('en', 1200)
  const narrow = dashboard('en', 700)
  const wideLayout = JSON.parse(wide.run("STATE = input; JSON.stringify(layout(STATE.tasks))", { input: state }))
  const narrowLayout = JSON.parse(narrow.run("STATE = input; JSON.stringify(layout(STATE.tasks))", { input: state }))
  assert.ok(wideLayout.capacity >= narrowLayout.capacity)
  assert.ok(wideLayout.w >= narrowLayout.w)
  assert.ok(narrowLayout.lanes.every((lane, i, lanes) => i === 0 || lanes[i - 1].y + lanes[i - 1].height < lane.y))
})

test('resize relayout preserves selected state and clamps manual pan at 100%', () => {
  const ui = dashboard('en', 1200)
  const state = graphState(48)
  ui.render(state)
  ui.run("setFilter('running'); openTask('T013'); FOCUS = 'T013'; SELECTED_RUN = 'fixture-48'; VIEW_MANUAL = true; Object.assign(VIEW, { x: 91, y: -37 })")
  assert.equal(ui.run('FILTER'), 'all', 'opening a filtered-out task reveals its card and popover anchor')
  const before = JSON.parse(ui.run("JSON.stringify({ filter: FILTER, pop: POP, focus: FOCUS, selected: SELECTED_RUN, fitted, manual: VIEW_MANUAL, view: VIEW, h: CANVAS_H, pos: LAST_POS })"))
  const beforeAnchor = JSON.parse(ui.run("JSON.stringify(document.querySelector('.node[data-id=\\\"T013\\\"]')?.getBoundingClientRect())"))
  ui.resize(700)
  const after = JSON.parse(ui.run("JSON.stringify({ filter: FILTER, pop: POP, focus: FOCUS, selected: SELECTED_RUN, fitted, manual: VIEW_MANUAL, view: VIEW, w: CANVAS_W, h: CANVAS_H, metrics: LAST_METRICS, pos: LAST_POS })"))
  assert.equal(after.filter, before.filter)
  assert.deepEqual(after.pop, before.pop)
  assert.equal(after.focus, before.focus)
  assert.equal(after.selected, before.selected)
  assert.equal(after.fitted, before.fitted)
  assert.equal(after.manual, true)
  assert.equal(after.view.k, 1)
  assert.notDeepEqual(after.view, before.view)
  const viewportW = ui.run("$('#viewport').getBoundingClientRect().width")
  const viewportH = ui.run("$('#viewport').getBoundingClientRect().height")
  assert.ok(after.view.x >= Math.min(0, viewportW - after.w))
  assert.ok(after.view.x <= Math.max(0, (viewportW - after.w) / 2))
  assert.ok(after.view.y >= Math.min(0, viewportH - after.h))
  assert.ok(after.view.y <= 0)
  assert.equal(after.metrics.nodeW * after.view.k, after.metrics.nodeW)
  const afterAnchor = JSON.parse(ui.run("JSON.stringify(document.querySelector('.node[data-id=\\\"T013\\\"]')?.getBoundingClientRect())"))
  const popPosition = JSON.parse(ui.run("JSON.stringify({ left: parseFloat($('#pop').style.left), top: parseFloat($('#pop').style.top) })"))
  assert.deepEqual(popPosition, { left: afterAnchor.right + 14, top: afterAnchor.top - 6 })
  assert.ok(beforeAnchor)
})
test('graph wheel and drag pan at fixed scale, honor bounds, and never zoom', () => {
  const ui = dashboard('en', 500)
  ui.render(graphState(48, 8))
  const bounds = JSON.parse(ui.run("JSON.stringify({ width: CANVAS_W, height: CANVAS_H, vw: $('#viewport').getBoundingClientRect().width, vh: $('#viewport').getBoundingClientRect().height })"))
  assert.ok(bounds.width > bounds.vw)
  assert.ok(bounds.height > bounds.vh)
  assert.equal(ui.run('VIEW.k'), 1)

  const wheel = (deltaX, deltaY, options = {}) => {
    const event = { deltaX, deltaY, shiftKey: false, ctrlKey: false, prevented: false,
      preventDefault() { this.prevented = true }, ...options }
    ui.dispatchElement('#viewport', 'wheel', event)
    return event
  }
  wheel(30, 40)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: -30, y: -40 })
  wheel(0, 12, { shiftKey: true })
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: -42, y: -40 },
    'Shift plus wheel moves the board horizontally')
  const pinch = wheel(0, 15, { ctrlKey: true })
  assert.equal(pinch.prevented, true, 'pinch wheel is prevented from zooming the page')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y, k: VIEW.k })')), { x: -42, y: -55, k: 1 })

  const key = (value) => ui.dispatchDocument('keydown', {
    key: value, target: { tagName: 'BODY' }, preventDefault() {},
  })
  const beforeKeys = ui.run('JSON.stringify(VIEW)')
  for (const value of ['+', '-', '0']) key(value)
  assert.equal(ui.run('JSON.stringify(VIEW)'), beforeKeys, 'legacy zoom keys do not move or scale the board')
  assert.doesNotMatch(html, /zoomAt|zoomLvl|VIEW\.k\s*=/)

  const minX = bounds.vw - bounds.width, minY = bounds.vh - bounds.height
  wheel(5000, 5000)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: minX, y: minY })
  wheel(-5000, -5000)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: 0, y: 0 })

  const drag = (toX, toY) => {
    ui.dispatchElement('#viewport', 'pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
    ui.dispatchElement('#viewport', 'pointermove', { clientX: toX, clientY: toY })
    ui.dispatchElement('#viewport', 'pointerup', {})
  }
  drag(-2000, -2000)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: minX, y: minY },
    'drag cannot pan beyond the far edges')
  drag(2000, 2000)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: 0, y: 0 },
    'drag cannot pan past the near edges')
})
test('phase boards expand for their cards and open with the complete graph visible', () => {
  const ui = dashboard('en', 1000)
  ui.render(graphState(48, 8))
  const initial = JSON.parse(ui.run('JSON.stringify({ view: VIEW, width: CANVAS_W, height: CANVAS_H, metrics: LAST_METRICS, pos: LAST_POS })'))
  assert.ok(initial.height > 644)
  assert.ok(initial.metrics.nodeW >= 120)
  assert.ok(initial.metrics.nodeW < 202)
  assert.equal(Math.max(...Object.values(initial.pos).map(point => point.x)) + initial.metrics.nodeW, initial.width - 40)
  assert.equal(initial.view.k, 1, 'the board always opens at 100%')
  assert.equal(initial.view.y, 0, '100% starts at the top when the board is taller than the viewport')
  assert.ok(initial.view.x >= 0, '100% never hides the hierarchy to the left of the viewport')
  assert.doesNotMatch(html, /zoomAt|id="zoomLvl"|id="fitBtn"|toggleFitView|fitView\(/)
  ui.run('VIEW.x -= 36; VIEW.y -= 20; VIEW_MANUAL = true; applyView()')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ k: VIEW.k, manual: VIEW_MANUAL })')), { k: 1, manual: true })
  ui.run('actualView()')
  const back = JSON.parse(ui.run('JSON.stringify({ view: VIEW, manual: VIEW_MANUAL })'))
  assert.equal(back.manual, false)
  assert.deepEqual(back.view, initial.view, 'resetting the graph returns to the opening fixed-scale view')

  const screenshotState = graphState(25, 6)
  const screenshotTasks = Object.values(screenshotState.tasks)
  let offset = 0
  for (const [phaseIndex, size] of [4, 3, 3, 11, 2, 2].entries()) {
    screenshotTasks.slice(offset, offset + size).forEach(task => { task.phase = `P${phaseIndex + 1}` })
    offset += size
  }
  const wide = dashboard('en', 1046)
  wide.render(screenshotState)
  const wideView = JSON.parse(wide.run("JSON.stringify({ view: VIEW, width: CANVAS_W, metrics: LAST_METRICS })"))
  const cardCapacity = wide.run("layout(STATE.tasks, 'phase').capacity")
  assert.equal(wideView.width, Math.max(636, 80 + wideView.metrics.nodeW * cardCapacity + 16 * (cardCapacity - 1)))
  assert.ok(wideView.metrics.nodeW * wideView.view.k >= 72, 'cards at 100% stay legible')
})

test('legend follows the workflow and event history names actions with their colored roles', () => {
  const legend = html.match(/<div class="legend">([\s\S]*?)<\/div>/)[1]
  const order = [...legend.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(order.slice(0, 11), ['waiting for dependencies', 'ready for discussion', 'discussion · orchestrator', 'ready for planning', 'planning · planner',
    'ready for execution', 'execution · executor', 'review · reviewer', '✓ = validated, awaiting done', 'done', 'failed'])
  assert.equal((legend.match(/class="role-dot"/g) ?? []).length, 4)
  assert.ok(order.includes('skipped'))
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    const taskValue = task('T4', 'reviewing', { validations: [
      { by: 'review', ok: false, evidence: 'The reviewer checked the current result.', summary: 'Reviewer found a missing acceptance condition.' },
      { by: 'review', ok: true, evidence: 'All required checks passed.' },
    ] })
    const events = [
      { type: 'task_start', task: 'T4', at: instant(1), current: 1, total: 4 },
      { type: 'task_progress', task: 'T4', at: instant(2), current: 2, total: 4 },
      { type: 'task_check', task: 'T4', at: instant(3), current: 1, total: 4, status: 'started', kind: 'functional', by: 'review' },
      { type: 'task_check', task: 'T4', at: instant(4), current: 2, total: 4, status: 'failed', kind: 'functional', by: 'review' },
      { type: 'task_review', task: 'T4', at: instant(5), reviewer: 'reviewer-1' },
      { type: 'task_validate', task: 'T4', at: instant(6), by: 'review', ok: false, evidence: 'The reviewer checked the current result.' },
      { type: 'task_validate', task: 'T4', at: instant(7), by: 'review', ok: true, evidence: 'All required checks passed.' },
      { type: 'phase_planning', phase: 'P2', at: instant(8), planner: 'planner-2' },
      { type: 'task_start', task: 'OLD', at: instant(0) },
    ]
    ui.render({ run: 'events', plan: {}, tasks: { T4: taskValue }, derived: { T4: { effective: 'ready' } } }, events)
    const title = ui.nodes.get('#parTitle').innerHTML
    for (const color of ['discussion', 'planning', 'running', 'review']) assert.ok(title.includes(`color:var(--${color})`))
    assert.equal((title.match(/<b>/g) ?? []).length, 4)
    assert.doesNotMatch(title, / · /)
    if (lang === 'pt-BR') assert.ok(ui.labels.some(node => node.textContent === 'discussão · orquestrador'))
    const log = ui.nodes.get('#events').innerHTML
    const visibleLog = log.replace(/<[^>]*>/g, '')
    assert.match(visibleLog, /T4 \[1\/4\]/)
    assert.match(visibleLog, /T4 \[2\/4\]/)
    assert.doesNotMatch(visibleLog, /OLD \[/)
    assert.ok(visibleLog.includes(lang === 'en' ? 'executor started task T4' : 'executor iniciou a tarefa T4'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'reviewer began the functional check for task T4' : 'revisor iniciou a verificação funcional da tarefa T4'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'orchestrator sent T4 to reviewer @reviewer-1' : 'orquestrador encaminhou T4 ao revisor @reviewer-1'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'reviewer approved T4' : 'revisor aprovou T4'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'reviewer rejected T4' : 'revisor reprovou T4'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'planner started planning for phase P2' : 'planejador iniciou o planejamento da fase P2'))
    assert.match(log, /class="ev-phase" style="color:var\(--planning\)">P2/)
    assert.match(log, /class="t-task_validate" data-ok="true"/)
    assert.match(log, /class="t-task_validate" data-ok="false"/)
    assert.doesNotMatch(visibleLog, /\b(?:phase|task)_[a-z_]+\b/)
  }
})

test('review rejection history prefers its validation summary and truncates evidence as fallback', () => {
  const evidence = 'A'.repeat(80) + 'UNTRUNCATED_SENTINEL'
  const repeatedEvidence = 'The same reviewer evidence was recorded twice.'
  const firstSummary = '1'.repeat(95)
  const secondSummary = '2'.repeat(95)
  const state = { run: 'rejection-history', plan: {}, tasks: {
    SUMMARY: task('SUMMARY', 'pending', { validations: [
      { by: 'review', ok: false, evidence: 'Raw evidence replaced by summary.', summary: 'Reviewer summary is shown first.' },
    ] }),
    FALLBACK: task('FALLBACK', 'pending', { validations: [
      { by: 'review', ok: false, evidence, summary: '' },
    ] }),
    REPEAT: task('REPEAT', 'pending', { validations: [
      { by: 'review', ok: false, evidence: repeatedEvidence, summary: firstSummary, at: instant(10) },
      { by: 'review', ok: false, evidence: repeatedEvidence, summary: secondSummary, at: instant(12) },
    ] }),
  }, derived: {
    SUMMARY: { effective: 'pending', blockedBy: [] },
    FALLBACK: { effective: 'pending', blockedBy: [] },
    REPEAT: { effective: 'pending', blockedBy: [] },
  } }
  const events = [
    { type: 'task_validate', task: 'SUMMARY', at: instant(1), by: 'review', ok: false, evidence: 'Raw evidence replaced by summary.' },
    { type: 'task_validate', task: 'FALLBACK', at: instant(2), by: 'review', ok: false, evidence },
    { type: 'task_validate', task: 'REPEAT', at: instant(11), by: 'review', ok: false, evidence: repeatedEvidence },
    { type: 'task_validate', task: 'REPEAT', at: instant(13), by: 'review', ok: false, evidence: repeatedEvidence },
  ]
  const ui = dashboard('en')
  ui.render(state, events)
  const log = ui.nodes.get('#events').innerHTML
  assert.ok(log.includes('Reviewer summary is shown first.'))
  assert.doesNotMatch(log, /Raw evidence replaced by summary\./)
  assert.ok(log.includes('A'.repeat(80)))
  assert.doesNotMatch(log, /UNTRUNCATED_SENTINEL/)
  const repeatLines = log.match(/<div class="ev">[\s\S]*?<\/div>/g).filter(line => line.includes('REPEAT'))
  assert.equal(repeatLines.length, 2)
  assert.ok(repeatLines[0].includes(secondSummary), 'the latest rejection keeps its full summary')
  assert.ok(repeatLines[1].includes(firstSummary), 'the earlier rejection keeps its own full summary')
})

test('visual polish keeps arrowless curves, full card labels and a controllable responsive sidebar', () => {
  assert.doesNotMatch(html, /marker-end|<marker/, 'dependency curves end on the card without arrowheads')
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\*, \*::before, \*::after[\s\S]*animation: none !important/)
  assert.match(html, /\.phase-task-state \{ display: inline;/)
  const sectionOrder = ['id="parTitle"', 'data-i18n="Selected task"', 'data-i18n="Failures &amp; retries"', 'data-i18n="Event log"', 'data-i18n="Legend"']
  assert.deepEqual(sectionOrder.map((part) => html.indexOf(part)), [...sectionOrder.map((part) => html.indexOf(part))].sort((a, b) => a - b))

  for (const [count, density] of [[6, 'detailed'], [48, 'compact'], [101, 'dense']]) {
    const ui = dashboard('pt-BR')
    const state = graphState(count)
    ui.render(state)
    assert.equal(ui.nodes.get('#canvas').dataset.density, density)
    assert.match(ui.nodes.get('#nodes').innerHTML, /em execução · executor/)
  }

  const state = graphState(6)
  const wide = dashboard('en', 1000)
  wide.render(state)
  assert.equal(wide.nodes.get('#sidebar').hidden, false)
  assert.equal(wide.nodes.get('#sidebarToggle').getAttribute('aria-expanded'), 'true')
  assert.equal(wide.nodes.get('#sidebarToggle').getAttribute('aria-label'), 'Collapse sidebar')

  const narrow = dashboard('pt-BR', 500)
  narrow.render(state)
  assert.equal(narrow.nodes.get('#sidebar').hidden, true)
  assert.equal(narrow.nodes.get('#sidebarToggle').getAttribute('aria-label'), 'Abrir lateral')
  narrow.run('toggleSidebar()')
  narrow.resize(400)
  assert.equal(narrow.nodes.get('#sidebar').hidden, false, 'manual choice survives resize')
  assert.equal(narrow.nodes.get('#sidebarToggle').getAttribute('aria-expanded'), 'true')
  narrow.run("openTask('T001')")
  assert.equal(narrow.nodes.get('#selectedTask').dataset.task, 'T001')
  assert.match(narrow.nodes.get('#selectedTask').innerHTML, /T001 · Task T001[\s\S]*em execução · executor/)

  const session = new Map()
  const firstLoad = dashboard('en', 500, session)
  firstLoad.render(state)
  firstLoad.run('toggleSidebar()')
  const openReload = dashboard('en', 500, session)
  openReload.render(state)
  assert.equal(openReload.nodes.get('#sidebar').hidden, false, 'manual open choice survives reload')
  openReload.run('toggleSidebar()')
  const collapsedReload = dashboard('en', 1000, session)
  collapsedReload.render(state)
  assert.equal(collapsedReload.nodes.get('#sidebar').hidden, true, 'manual collapsed choice survives reload')

  const unavailableStorage = { get() { throw new Error('blocked') }, set() { throw new Error('blocked') } }
  const navigation = { state: { existing: 'preserved' }, urls: [] }
  const fallback = dashboard('en', 500, unavailableStorage, navigation)
  fallback.render(state)
  assert.equal(fallback.nodes.get('#sidebar').hidden, true, 'responsive default survives unavailable storage')
  assert.doesNotThrow(() => fallback.run('toggleSidebar()'))
  assert.deepEqual(JSON.parse(JSON.stringify(navigation.state)), { existing: 'preserved', graphSidebarCollapsed: false })
  assert.deepEqual(navigation.urls, [], 'sidebar state does not alter the URL')
  const fallbackReload = dashboard('en', 500, unavailableStorage, navigation)
  fallbackReload.render(state)
  assert.equal(fallbackReload.nodes.get('#sidebar').hidden, false, 'manual open choice survives reload without storage')
  fallbackReload.run("selectRun('workspace/next')")
  assert.equal(navigation.state.graphSidebarCollapsed, false, 'run selection preserves the sidebar fallback')
  assert.deepEqual(new URL(navigation.urls.at(-1)).searchParams.get('root'), 'workspace')
  assert.equal(new URL(navigation.urls.at(-1)).searchParams.has('graphSidebarCollapsed'), false)
  fallbackReload.run('toggleSidebar()')
  const collapsedFallbackReload = dashboard('en', 1000, unavailableStorage, navigation)
  collapsedFallbackReload.render(state)
  assert.equal(collapsedFallbackReload.nodes.get('#sidebar').hidden, true, 'manual collapsed choice survives reload without storage')
  assert.equal(navigation.state.existing, 'preserved')

  const linked = dashboard('en')
  linked.render({ run: 'curves', plan: { phases: [{ id: 'P1', title: 'Phase 1' }] },
    tasks: { A: task('A', 'done'), B: task('B', 'running', { deps: ['A'], agent: 'executor-1', attempts: [{ startedAt: instant(10) }] }) },
    derived: { A: { effective: 'done', blockedBy: [] }, B: { effective: 'running', blockedBy: [] } } })
  assert.match(linked.nodes.get('#edgePaths').innerHTML, /<path class="e-hot"[^>]* d="M [^"]* C [^"]*"/)
})

test('discussion uses the orchestrator brass and lights the active orchestrator without motion when reduced', () => {
  assert.match(html, /--discussion:\s*#e8b04b/)
  assert.match(html, /\.node\[data-st="discussing"\][^{]*\{[^}]*--st:\s*var\(--discussion\)/)
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none !important/)
  const ui = dashboard('pt-BR')
  ui.render({ run: 'discussion', plan: { maxParallel: 4 }, tasks: { T1: task('T1', 'discussing') }, derived: { T1: { effective: 'discussing' } } })
  assert.equal(ui.nodes.get('#orchNode').classList.contains('discussing'), true)
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-st="discussing"[^>]*data-id="T1"/)
  assert.match(ui.nodes.get('#orchSub').textContent, /discutindo 1: T1/)
  ui.render({ run: 'discussion', plan: { maxParallel: 4 }, tasks: { T1: task('T1', 'discussing', { discussionAttempts: [{ startedAt: instant(28) }] }) }, derived: { T1: { effective: 'discussing' } } })
  assert.match(ui.nodes.get('#nodes').innerHTML, /orquestrador<\/span><span class="beat"><\/span><span class="elapsed">1:12</,'the card counts the open discussion round')
})

test('the dashboard ships its own licensed fonts and the page policy allows only inline data fonts', () => {
  for (const family of ['Bricolage Grotesque', 'JetBrains Mono'])
    assert.match(html, new RegExp(`@font-face \\{ font-family: "${family}"[^}]*src: url\\(data:font/woff2;base64,`))
  assert.match(html, /SIL Open Font License, Version 1\.1/)
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/, 'no font request leaves the machine')
  const serve = readFileSync(new URL('../scripts/serve.mjs', import.meta.url), 'utf8')
  assert.match(serve, /font-src data:;/)
})

test('available tasks say who moves each one next and give way to the selected task', () => {
  const tasks = {
    K: task('K', 'blocked', { blockReason: 'pick <the> API version' }),
    E: task('E', 'pending', { validation: [{ run: 'bun test auth', expect: '12 tests pass' }] }),
    P: task('P', 'pending', { planningRequired: true }),
    D: task('D', 'done'),
  }
  const derived = { K: { effective: 'blocked' }, E: { effective: 'ready' }, P: { effective: 'ready_to_plan' }, D: { effective: 'done' } }
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    ui.render({ run: 'available', plan: { phases: [] }, tasks, derived })
    const list = ui.nodes.get('#available').innerHTML
    assert.equal(ui.nodes.get('#availableBox').hidden, false)
    assert.equal(ui.nodes.get('#selectedBox').hidden, true)
    assert.deepEqual([...list.matchAll(/openTask\('(\w+)'\)/g)].map(m => m[1]), ['K', 'E', 'P'], 'needs-you first, then the next role in the flow')
    assert.match(list, /--role:var\(--blocked\)[\s\S]*pick &lt;the&gt; API version/)
    assert.match(list, /--role:var\(--running\)[\s\S]*\$ bun test auth[\s\S]*12 tests pass/)
    assert.match(list, /--role:var\(--planning\)/)
    assert.match(list, lang === 'en' ? /needs you/ : /precisa de você/)
    const availableTarget = { closest(selector) { return selector === '.avail' ? this : null } }
    const emptyTarget = { closest() { return null } }
    ui.dispatchDocument('click', { target: availableTarget }, () => ui.run("openTask('E')"))
    assert.equal(ui.nodes.get('#availableBox').hidden, true)
    assert.equal(ui.nodes.get('#selectedBox').hidden, false)
    assert.match(ui.nodes.get('#selectedTask').innerHTML, /E · Task E/)
    assert.equal(ui.run('POP.id'), 'E', 'the card inline handler opens before the bubbling document handler')
    ui.dispatchDocument('click', { target: emptyTarget })
    assert.equal(ui.run('POP'), null, 'clicking empty space still closes the pinned task')
    assert.equal(ui.nodes.get('#availableBox').hidden, false)
  }
})

test('discovery, planner identity and task plan render as escaped text, including answers and checks', () => {
  const hostile = '<img src=x onerror="alert(1)">&\'text'
  const recorded = { ...plan, planner: hostile,
    research: [{ source: hostile, findings: hostile }], decisions: [{ question: hostile, answer: hostile }],
    steps: [hostile], verification: [{ criterion: hostile, check: 1 }],
    openQuestions: [{ question: hostile, blocking: true, answer: hostile }, { question: 'Follow up', blocking: false }],
  }
  const hostileDiscovery = { ...discovery, closure: hostile,
    research: [{ source: hostile, findings: hostile }],
    questions: [{ question: hostile, answer: hostile, channel: 'chat-fallback', round: 1 }],
    coverage: Object.fromEntries(Object.keys(discovery.coverage).map(key => [key, hostile])),
    decisions: [{ question: hostile, answer: hostile }], deferred: [hostile],
    executionBoundary: { deferredToExecutor: ['T'], prematureTaskWork: [] } }
  const ui = dashboard('pt-BR')
  ui.render({ run: 'safe-plan', plan: {}, tasks: { T: task('T', 'pending', { discovery: hostileDiscovery, planner: hostile, taskPlan: recorded }) }, derived: { T: { effective: 'ready' } } })
  ui.run("POP_MODE = 'detail'; fillPop('T')")
  const body = ui.nodes.get('#popBody').innerHTML
  assert.doesNotMatch(body, /<img|onerror="/)
  assert.match(body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;&#39;text/)
  for (const text of ['Descoberta da tarefa', 'Pesquisa da descoberta', 'Discussão', 'Cobertura PO First', 'Decisões da descoberta', 'Ideias adiadas',
    'Planejador', 'Plano registrado da tarefa', 'Pesquisa', 'Decisões', 'Passos de execução', 'Verificação', 'Perguntas', 'verificação 1', 'não bloqueante']) assert.ok(body.includes(text), text)
})

test('lean popover shows role-written summaries, escaped, and never the full plan', () => {
  const hostile = '<img src=x onerror="alert(1)">'
  const ui = dashboard('pt-BR')
  ui.render({ run: 'lean', plan: {}, tasks: { T: task('T', 'done', {
    summary: `Checkout avisado ${hostile}`, validationSummary: 'O aviso chega com 200',
    validation: [{ run: 'bun test', expect: 'doze testes passam' }],
    taskPlan: { ...plan, summary: 'caminho do planejador', steps: ['passo secreto do plano'] },
    attempts: [{ n: 1, agent: 'exec-1', startedAt: instant(1), endedAt: instant(5), result: 'passed' }],
    validations: [{ ok: false, at: instant(3), evidence: 'evidencia longa', summary: 'reprovado: HTTP 500' }],
  }) }, derived: { T: { effective: 'done' } } })
  ui.run("POP_MODE = 'lean'; fillPop('T')")
  const lean = ui.nodes.get('#popBody').innerHTML
  assert.doesNotMatch(lean, /<img|onerror="/)
  assert.ok(lean.includes('Checkout avisado &lt;img'), 'task summary wins over the planner summary')
  assert.ok(lean.includes('O aviso chega com 200'))
  assert.ok(lean.includes('reprovado: HTTP 500'), 'the journey uses the verdict summary')
  assert.ok(!lean.includes('passo secreto do plano') && !lean.includes('doze testes passam'), 'lean hides the full text')
  assert.ok(!lean.includes('No summary recorded'))

  ui.run("POP_MODE = 'detail'; fillPop('T')")
  const detail = ui.nodes.get('#popBody').innerHTML
  for (const text of ['passo secreto do plano', 'doze testes passam', 'caminho do planejador', 'evidencia longa', 'reprovado: HTTP 500']) assert.ok(detail.includes(text), text)
})

test('lean popover falls back to clamped full text when no summary was recorded', () => {
  const ui = dashboard('pt-BR')
  ui.render({ run: 'old', plan: {}, tasks: { T: task('T', 'pending', { summary: '   ', validation: 'contrato antigo em prosa' }) }, derived: { T: { effective: 'ready' } } })
  ui.run("POP_MODE = 'lean'; fillPop('T')")
  const lean = ui.nodes.get('#popBody').innerHTML
  assert.match(lean, /class="lead clamp">Task T/)
  assert.match(lean, /class="ptxt clamp">contrato antigo em prosa/)
  assert.equal((lean.match(/class="nosum"/g) ?? []).length, 2, 'a blank summary counts as absent')
})

test('expanding the popover pins it, switches to detail and closing resets it', () => {
  const ui = dashboard('pt-BR')
  ui.render({ run: 'x', plan: {}, tasks: { T: task('T') }, derived: { T: { effective: 'ready' } } })
  ui.run("POP = { id: 'T', pinned: false }; POP_MODE = 'lean'; togglePopExpand(true)")
  assert.equal(ui.run('POP.pinned && POP_MODE === "detail" && POP_EXPANDED'), true)
  assert.equal(ui.nodes.get('#pop').classList.contains('expanded'), true)
  assert.equal(ui.nodes.get('#popScrim').classList.contains('on'), true)
  ui.run('closePop()')
  assert.equal(ui.run('POP_EXPANDED'), false)
  assert.equal(ui.nodes.get('#pop').classList.contains('expanded'), false)
  assert.equal(ui.nodes.get('#popScrim').classList.contains('on'), false)
})

test('results task rows select inline details, preserve them on refresh, and navigate with arrows', () => {
  const state = graphState(3, 3)
  state.tasks.T001.summary = 'A <summary>'
  state.tasks.T001.validationSummary = 'Proof A'
  state.tasks.T001.attempts = [{ n: 1, agent: 'exec-a', startedAt: instant(1), endedAt: instant(2), result: 'passed' }]
  state.tasks.T001.validations = [{ ok: true, at: instant(2), evidence: 'check A passed' }]
  const ui = dashboard()
  ui.render(state)
  ui.run("RESULTS_OPEN = true; $('#results').classList.add('open'); renderResults(STATE)")
  assert.match(ui.nodes.get('#results').innerHTML, /role="button"[^>]*onclick="selectResultTask\('T001'\)"/)
  const resultsTarget = { closest(selector) { return selector === '#results' ? this : null } }

  ui.dispatchDocument('click', { target: resultsTarget }, () => ui.run("selectResultTask('T001')"))
  assert.equal(ui.run('RESULTS_OPEN'), true, 'selecting a timeline row keeps the results tab open')
  assert.equal(ui.run('POP'), null, 'row selection renders inside the tab without a graph popover')
  assert.match(ui.nodes.get('#results').innerHTML, /T001 · Task T001/)
  assert.match(ui.nodes.get('#results').innerHTML, /A &lt;summary&gt;/)
  assert.match(ui.nodes.get('#results').innerHTML, /Proof A/)
  assert.match(ui.nodes.get('#results').innerHTML, /onclick="jumpTo\('T001'\)"/)

  ui.dispatchDocument('click', { target: resultsTarget }, () => ui.run("selectResultTask('T002')"))
  assert.equal(ui.run('RESULT_TASK_ID'), 'T002', 'a second row replaces the selected detail')
  assert.match(ui.nodes.get('#results').innerHTML, /T002 · Task T002/)
  assert.doesNotMatch(ui.nodes.get('#results').innerHTML, /A &lt;summary&gt;/)
  ui.run('renderResults(STATE)')
  assert.equal(ui.run('RESULT_TASK_ID'), 'T002', 'the selected detail survives a live results refresh')

  const key = (value) => ui.dispatchDocument('keydown', {
    key: value, target: { tagName: 'BODY' }, preventDefault() {},
  })
  key('ArrowUp')
  assert.equal(ui.run('RESULT_TASK_ID'), 'T001')
  key('ArrowDown')
  assert.equal(ui.run('RESULT_TASK_ID'), 'T002')
  ui.dispatchDocument('keydown', {
    key: 'ArrowUp', target: { tagName: 'SELECT', closest() { return this } }, preventDefault() {},
  })
  assert.equal(ui.run('RESULT_TASK_ID'), 'T002', 'arrows keep working in the run selector')

  const nextRun = graphState(1, 1)
  nextRun.run = 'next-run'
  ui.render(nextRun)
  ui.run('renderResults(STATE)')
  assert.equal(ui.run('RESULT_TASK_ID'), null, 'switching to a run without the task clears its detail')
  assert.doesNotMatch(ui.nodes.get('#results').innerHTML, /class="result-task"/)

  ui.run("selectResultTask('T001')")
  ui.dispatchDocument('click', { target: resultsTarget }, () => ui.run("jumpTo('T001')"))
  assert.equal(ui.run('RESULTS_OPEN'), false, 'the separate graph link closes the results tab')
  assert.equal(ui.run('POP.id'), 'T001', 'the separate graph link keeps jumpTo navigation working')
})

test('jumping from results pans a tall graph until the target task is visible', () => {
  const ui = dashboard('en', 500)
  ui.render(graphState(48, 8))
  const before = JSON.parse(ui.run("JSON.stringify({ y: VIEW.y, taskY: LAST_POS.T048.y, height: LAST_METRICS.nodeH, viewport: $('#viewport').getBoundingClientRect().height })"))
  assert.ok(before.taskY > before.viewport, 'fixture places T048 below the initial viewport')

  ui.run("RESULTS_OPEN = true; $('#results').classList.add('open'); jumpTo('T048')")
  assert.equal(ui.run('RESULTS_OPEN'), false, 'the graph link returns to the graph')
  assert.equal(ui.run('POP.id'), 'T048', 'the target task keeps its graph detail open')
  const after = JSON.parse(ui.run("JSON.stringify({ x: VIEW.x, y: VIEW.y, taskX: LAST_POS.T048.x, taskY: LAST_POS.T048.y, width: LAST_METRICS.nodeW, height: LAST_METRICS.nodeH, viewportWidth: $('#viewport').getBoundingClientRect().width, viewportHeight: $('#viewport').getBoundingClientRect().height })"))
  const left = after.taskX + after.x
  const top = after.taskY + after.y
  assert.ok(left >= 0 && left + after.width <= after.viewportWidth,
    `T048 should fit horizontally in the viewport: ${JSON.stringify({ left, ...after })}`)
  assert.ok(top >= 0 && top + after.height <= after.viewportHeight,
    `T048 should fit vertically in the viewport: ${JSON.stringify({ top, ...after })}`)
})

test('explicit results navigation survives the click suppression left by dragging the graph', () => {
  const ui = dashboard('en', 500)
  ui.render(graphState(48, 8))
  ui.run('VIEW.x = -20; VIEW.y = -20; VIEW_MANUAL = true; applyView()')
  ui.dispatchElement('#viewport', 'pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
  ui.dispatchElement('#viewport', 'pointermove', { clientX: 112, clientY: 112, pointerId: 1 })
  ui.dispatchElement('#viewport', 'pointerup', { pointerId: 1 })
  assert.equal(ui.run('suppressClick'), true, 'the completed drag suppresses its trailing graph click')

  ui.run('toggleResults(); renderResults(STATE)')
  assert.equal(ui.run('RESULTS_OPEN'), true)
  ui.run("selectResultTask('T048')")
  const resultsTarget = { closest(selector) { return selector === '#results' ? this : null } }
  ui.dispatchDocument('click', { target: resultsTarget }, () => ui.run("jumpTo('T048')"))

  assert.equal(ui.run('RESULTS_OPEN'), false, 'navigation returns to the graph')
  assert.equal(ui.run('suppressClick'), false, 'explicit navigation clears stale drag suppression')
  assert.equal(ui.run('POP.id'), 'T048', 'the task details open after the jump')
  const view = JSON.parse(ui.run("JSON.stringify({ x: VIEW.x, y: VIEW.y, taskX: LAST_POS.T048.x, taskY: LAST_POS.T048.y, width: LAST_METRICS.nodeW, height: LAST_METRICS.nodeH, viewportWidth: $('#viewport').getBoundingClientRect().width, viewportHeight: $('#viewport').getBoundingClientRect().height })"))
  assert.ok(view.taskX + view.x >= 0 && view.taskX + view.x + view.width <= view.viewportWidth)
  assert.ok(view.taskY + view.y >= 0 && view.taskY + view.y + view.height <= view.viewportHeight)
})
test('results count planning intervals and exclude human blocks and planning from execution queue time', () => {
  const ui = dashboard()
  const completePlan = { ...plan, startedAt: instant(15), completedAt: instant(20) }
  const tasks = {
    D: task('D', 'done', { planningRequired: true, taskPlan: completePlan, planningHistory: [completePlan],
      planningAttempts: [
        { startedAt: instant(0), endedAt: instant(10), result: 'blocked' },
        { startedAt: instant(15), endedAt: instant(20), result: 'planned' },
      ], attempts: [{ startedAt: instant(30), reviewStartedAt: instant(50), endedAt: instant(60) }] }),
    P: task('P', 'planning', { planningAttempts: [{ startedAt: instant(80) }] }),
    L: task('L', 'done', { attempts: [{ startedAt: instant(10), endedAt: instant(20) }] }),
  }
  const state = { run: 'metrics', createdAt: instant(0), plan: {}, tasks, derived: {} }
  const result = ui.run('analyse(input, [])', { input: state })
  assert.equal(result.planningTotal, 35000)
  assert.equal(result.execTotal, 30000)
  assert.equal(result.reviewTotal, 10000)
  assert.equal(result.agentTotal, 75000)
  assert.equal(result.wall, 100000)
  assert.equal(result.anyLive, true)
  assert.equal(result.per.find((t) => t.id === 'D').queue, 10000)
  assert.equal(result.per.find((t) => t.id === 'P').queue, null)
  assert.equal(result.per.find((t) => t.id === 'L').queue, 10000)
  ui.run('renderResults(input)', { input: state })
  assert.match(ui.nodes.get('#results').innerHTML, /Planning share/)
  assert.match(ui.nodes.get('#results').innerHTML, /background:var\(--planning\)/)
  assert.match(ui.nodes.get('#results').innerHTML, /Run still active/)
})

test('results count shared phase planning once and keep pending runs live', () => {
  const ui = dashboard()
  const tasks = {
    A: task('A', 'done', { phase: 'F1', attempts: [{ startedAt: instant(30), endedAt: instant(40) }] }),
    B: task('B', 'pending', { phase: 'F2' }),
  }
  const state = { run: 'phase-metrics', createdAt: instant(0), plan: {}, tasks, derived: {}, phaseWorkflows: {
    F1: { id: 'F1', state: 'planned', planningAttempts: [{ startedAt: instant(10), endedAt: instant(20) }] },
    F2: { id: 'F2', state: 'planning', planningAttempts: [{ startedAt: instant(80) }] },
  } }
  const result = ui.run('analyse(input, [])', { input: state })
  assert.equal(result.planningTotal, 30000, 'one planner interval per phase, never multiplied by member count')
  assert.equal(result.agentTotal, 40000)
  assert.equal(result.wall, 100000)
  assert.equal(result.anyLive, true, 'pending work keeps the run live even when no executor is active')
  assert.equal(JSON.stringify(result.phasePlanningByPhase), JSON.stringify([{ phase: 'F1', duration: 10000 }, { phase: 'F2', duration: 20000 }]))
  assert.equal(result.cpLen, 20000, 'the critical path includes one shared phase-planning interval on each independent branch')
  ui.run('renderResults(input)', { input: state })
  assert.match(ui.nodes.get('#results').innerHTML, /phase planning: F1 10s · F2 20s/)
})

test('replanning a paused attempt never counts its waiting or research as execution or review', () => {
  const ui = dashboard()
  for (const [state, replanEnd, resumed, reviewAt, expected] of [
    ['done', 60, true, null, { planning: 30, exec: 30, review: 0, blocked: 40 }],
    ['blocked', 60, false, null, { planning: 30, exec: 10, review: 0, blocked: 60 }],
    ['planning', null, false, null, { planning: 70, exec: 10, review: 0, blocked: 20 }],
    ['done', 60, true, 15, { planning: 30, exec: 5, review: 25, blocked: 40 }],
    ['blocked', 60, false, 15, { planning: 30, exec: 5, review: 5, blocked: 60 }],
    ['planning', null, false, 15, { planning: 70, exec: 5, review: 5, blocked: 20 }],
  ]) {
    const attempt = { startedAt: instant(10), ...(state === 'done' ? { endedAt: instant(100) } : {}),
      ...(reviewAt == null ? {} : { reviewStartedAt: instant(reviewAt) }) }
    const paused = task('T', state, { attempts: [attempt],
      planningAttempts: [
        { startedAt: instant(0), endedAt: instant(10) },
        { startedAt: instant(40), ...(replanEnd == null ? {} : { endedAt: instant(replanEnd) }) },
      ], ...(state === 'planning' ? { planningReturn: { stateBeforeBlock: reviewAt == null ? 'running' : 'reviewing' } } : {}),
    })
    const events = [{ type: 'task_block', task: 'T', at: instant(20) }, { type: 'task_planning', task: 'T', at: instant(40) }]
    if (replanEnd != null) events.push({ type: 'task_planned', task: 'T', at: instant(replanEnd), state: 'blocked' })
    if (resumed) events.push({ type: 'task_unblock', task: 'T', at: instant(80), state: reviewAt == null ? 'running' : 'reviewing' })
    const result = ui.run('analyse(input, inputEvents)', { input: { createdAt: instant(0), plan: {}, tasks: { T: paused } }, inputEvents: events })
    for (const [key, seconds] of Object.entries(expected)) assert.equal(result.per[0][key], seconds * 1000, `${state}, reviewAt=${reviewAt}: ${key}`)
    assert.equal(result.agentTotal, (expected.planning + expected.exec + expected.review) * 1000)
    assert.equal(result.wall, 100000)
  }
})
test('task labels, summaries and plan identities stay visible across concise and historical dashboard views', () => {
  const state = graphState(1, 1)
  state.createdAt = instant(0)
  const value = state.tasks.T001
  value.title = 'Synchronize the approved card status with the customer account'
  value.label = 'Cartões'
  value.summary = 'A conta recebe o status aprovado antes da próxima compra.'
  value.validationSummary = 'A conta mostra o status de cartão aprovado.'
  value.validation = [{ run: 'node check.cjs', expect: 'The approved status appears in the account.' }]
  value.taskPlan = { ...plan, summary: 'Reuse the existing account update path.', digest: 'b'.repeat(64) }
  value.state = 'failed'
  value.attempts = [
    { n: 1, agent: 'executor-1', startedAt: instant(1), reviewStartedAt: instant(2), endedAt: instant(3),
      result: 'failed', planDigest: 'a'.repeat(64) },
    { n: 2, agent: 'executor-2', startedAt: instant(4), reviewStartedAt: instant(5), endedAt: instant(6),
      result: 'failed', planDigest: 'b'.repeat(64) },
  ]
  value.validations = [
    { by: 'review', ok: false, at: instant(3), evidence: 'Complete observation one.', summary: 'O status não atualizou no primeiro cenário.' },
    { by: 'review', ok: false, at: instant(6), evidence: 'Complete observation two.', summary: 'A conta ainda mostra o status anterior.' },
  ]
  state.derived.T001 = { effective: 'ready', blockedBy: [] }

  const ui = dashboard('pt-BR')
  ui.render(state)
  const graph = ui.nodes.get('#nodes').innerHTML
  assert.match(graph, /<span class="nt">Cartões<\/span>/)
  assert.ok(graph.includes(value.title), 'the graph tooltip retains the complete task title')
  const available = ui.nodes.get('#available').innerHTML
  assert.ok(available.includes('Cartões'))
  assert.ok(available.includes(value.summary))
  assert.ok(available.includes(value.validationSummary))
  assert.ok(available.includes(value.title), 'the available task tooltip retains the complete task title')

  ui.run("POP = { id: 'T001', pinned: true }; POP_MODE = 'lean'; fillPop('T001')")
  const lean = ui.nodes.get('#popBody').innerHTML
  assert.ok(lean.includes(value.title), 'the popover keeps the full task title')
  assert.ok(lean.includes(value.summary))
  assert.ok(lean.includes(value.validationSummary))
  assert.ok(lean.includes('Plano bbbb'))
  assert.ok(lean.includes('mudou de aaaa'), 'the journey calls out a changed plan between attempts')

  ui.run("RESULTS_OPEN = true; $('#results').classList.add('open'); selectResultTask('T001')")
  const history = ui.nodes.get('#results').innerHTML
  assert.ok(history.includes('Cartões'), 'the timeline and rework history use the business label')
  assert.ok(history.includes(value.title), 'history retains the full title in its tooltip')
  assert.ok(history.includes('A conta ainda mostra o status anterior.'), 'the reviewer gate prefers its validation summary')
  assert.ok(history.includes('Complete observation two.'), 'selected history retains the full evidence')
  assert.ok(history.includes('mudou de aaaa'), 'selected history records the plan change')
})
