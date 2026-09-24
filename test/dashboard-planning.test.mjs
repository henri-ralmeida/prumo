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
      textContent: '', dataset: {}, open: false, hidden: false, style: { setProperty(name, value) { this[name] = value } },
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
    const cardSize = [Number.parseFloat(nodes.get('#canvas')?.style['--node-w']) || 200,
      Number.parseFloat(nodes.get('#canvas')?.style['--node-h']) || 64]
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
    assert.match(ui.nodes.get('#nodes').innerHTML, /title="[^"]*← F2/)
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
    assert.match(ui.nodes.get('#lanes').innerHTML, lang === 'en' ? /Active time not measured/ : /tempo ativo não aferido/)
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
  assert.match(html, /url\.searchParams\.set\('root', root\)/)
  assert.match(html, /url\.searchParams\.set\('run', run\)/)
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
    const cardDrivenWidth = Math.max(900, 80 + result.capacity * result.metrics.nodeW + (result.capacity - 1) * result.metrics.gapX)
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
  const tallUi = dashboard('en', 1440)
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
  assert.equal(wideView.width, Math.max(636, 80 + wideView.metrics.nodeW * cardCapacity + wideView.metrics.gapX * (cardCapacity - 1)))
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

test('Gravidade cards and agent panels show measured activity in the compact dashboard layout', () => {
  assert.match(html, /grid-template: 64px minmax\(0, 1fr\) 48px/)
  assert.match(html, /grid-template-columns: minmax\(0, 1fr\) 360px/)
  assert.match(html, /\.node \{[^}]*width: var\(--node-w, 200px\); height: var\(--node-h, 64px\)[^}]*padding: 9px 12px/)
  assert.match(html, /\.node \.id \{[^}]*font-size: 13px/)
  assert.match(html, /\.node \.tag \{[^}]*font-size: 10px/)
  assert.match(html, /\.node \.nt \{ font: 15px\/1\.2 var\(--font-display\)/)
  assert.doesNotMatch(html, /\.node \.sub\b/)
  assert.match(html, /<details class="run-menu" id="runMenu"/)
  assert.match(html, /<summary class="run-trigger"/)
  assert.doesNotMatch(html, /<select[^>]+id="runSelect"/)
  assert.match(html, /<details class="legend-box">/)
  assert.match(html, /#eventsBox \{ display: flex; flex: 1;/)
  assert.match(html, /#pop \{[^}]*width: 472px/)
  assert.match(html, /#pop \.pk \{[^}]*10px[^}]*var\(--font-mono\)/)
  assert.match(html, /#pop \.lead \{ font: 400 16px\/1\.45 var\(--font-display\)/)
  assert.match(html, /#pop \.detail-head \{ display: flex; align-items: baseline; flex-wrap: nowrap/)
  assert.match(html, /#pop\.expanded \.pk, #pop\.expanded dt \{[^}]*16px[^}]*var\(--font-display\)/)

  const tasks = {
    T0: task('T0', 'done', { attempts: [{ n: 1, agent: 'exec-a', startedAt: instant(1), endedAt: instant(5), result: 'passed', planDigest: 'a'.repeat(64) }],
      validations: [{ by: 'review', ok: true, at: instant(5), evidence: 'check passed' }] }),
    T1: task('T1', 'running', { deps: ['T0'], agent: 'exec-b', summary: 'Linha um\nLinha dois\nLinha três\nSUMMARY_SENTINEL',
      attempts: [
        { n: 1, agent: 'exec-b', startedAt: instant(50), endedAt: instant(60), result: 'failed', planDigest: 'a'.repeat(64) },
        { n: 2, agent: 'exec-b', startedAt: instant(90), planDigest: 'b'.repeat(64) },
      ],
      validations: [{ by: 'review', agent: 'review', ok: false, at: instant(60), summary: 'Precisa corrigir', evidence: 'prova insuficiente' }] }),
    T2: task('T2', 'failed', { deps: ['T1'], attempts: [
      { n: 1, agent: 'exec-c', startedAt: instant(70), endedAt: instant(80), result: 'failed', reason: 'tentativa inicial falhou' },
      { n: 2, agent: 'exec-c', startedAt: instant(82), endedAt: instant(90), result: 'failed', reason: 'timeout na segunda tentativa' },
    ] }),
  }
  const state = { run: 'run-a', createdAt: new Date(Date.UTC(2026, 0, 1) - 115 * 60 * 60 * 1000).toISOString(),
    plan: { description: 'Plano de atividade', phases: [], maxExecutors: 3, maxAttempts: 3 }, tasks,
    derived: { T0: { effective: 'done' }, T1: { effective: 'running' }, T2: { effective: 'failed' } } }
  const events = [
    { type: 'task_start', task: 'T0', attempt: 1, at: instant(1) },
    { type: 'task_progress', task: 'T0', attempt: 1, at: instant(5) },
    { type: 'task_start', task: 'T1', attempt: 1, at: instant(50) },
    { type: 'task_progress', task: 'T1', attempt: 1, at: instant(60) },
    { type: 'task_start', task: 'T2', attempt: 1, at: instant(70) },
    { type: 'task_progress', task: 'T2', attempt: 1, at: instant(80) },
    { type: 'task_start', task: 'T2', attempt: 2, at: instant(82) },
    { type: 'task_progress', task: 'T2', attempt: 2, at: instant(90) },
  ]
  const ui = dashboard('en', 1440)
  ui.render(state, events)
  ui.run("updateRunSelect({ currentRoot: 'workspace', current: 'run-a', runs: [{ root: 'workspace', run: 'run-a', plan: 'Plano de atividade' }, { root: 'workspace', run: 'run-b', plan: 'Outro plano' }] })")
  assert.equal(ui.nodes.get('#runName').textContent, 'run-a')
  assert.equal(ui.nodes.get('#runLabel').textContent, 'Plano de atividade')
  assert.match(ui.nodes.get('#runOptions').innerHTML, /aria-current="true"/)
  assert.match(ui.nodes.get('#runOptions').innerHTML, /Outro plano/)
  ui.run("updateRunSelect({ currentRoot: 'workspace', current: 'run-b', runs: [{ root: 'workspace', run: 'run-a', plan: 'Plano de atividade' }, { root: 'workspace', run: 'run-b', plan: 'Outro plano' }] })")
  assert.equal(ui.nodes.get('#runName').textContent, 'run-b')
  assert.match(ui.nodes.get('#runOptions').innerHTML, /data-run="workspace\/run-b" aria-current="true"/)
  assert.doesNotMatch(ui.nodes.get('#runOptions').innerHTML, /data-run="workspace\/run-a" aria-current="true"/)
  assert.match(ui.nodes.get('#orch').innerHTML, /Live[\s\S]*00:00:32/)
  assert.match(ui.nodes.get('#orch').innerHTML, /aria-label="Agent time: 00:00:32 · not measured"/)
  assert.equal(ui.nodes.get('#orch').classList.contains('live'), true, 'the current task state, not event age, controls the live pill')
  assert.match(ui.nodes.get('#doneCount').innerHTML, /32s[\s\S]*Active time not measured/)
  assert.doesNotMatch(ui.nodes.get('#orch').innerHTML + ui.nodes.get('#doneCount').innerHTML, /115:00:00|115h/)
  assert.match(ui.nodes.get('#nodes').innerHTML, /class="tr">running<\/span>/)
  assert.doesNotMatch(ui.nodes.get('#nodes').innerHTML, /class="sub"/)
  assert.match(ui.nodes.get('#parallel').innerHTML, /T1[\s\S]*executor[\s\S]*not measured[\s\S]*rbar/)
  assert.match(ui.nodes.get('#failures').innerHTML, /2 of 3/)
  assert.match(ui.nodes.get('#failures').innerHTML, /timeout na segunda tentativa/)

  ui.run("POP_MODE = 'lean'; fillPop('T1')")
  const lean = ui.nodes.get('#popBody').innerHTML
  for (const text of ['T1', '2 of 3', 'Linha um', 'Linha dois', 'Linha três', 'Depends on', 'T0', 'Unlocks', 'T2', 'changed from aaaa', 'Pin', 'Agent time', 'see detail'])
    assert.ok(lean.includes(text), text)
  assert.ok(lean.includes('SUMMARY_SENTINEL'), 'an explicit summary remains complete in the concise view')
  assert.doesNotMatch(lean, /115:00:00|115h/)
  assert.match(lean, /<button type="button" class="dep"/)

  ui.run("POP_MODE = 'detail'; fillPop('T1')")
  const detail = ui.nodes.get('#popBody').innerHTML
  for (const text of ['Attempts and verdicts', 'Rejected', '@exec-b', '@review', 'prova insuficiente', 'changed from aaaa', 'Esc closes'])
    assert.ok(detail.includes(text), text)
  ui.run("POP_MODE = 'lean'; fillPop('T0')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /Approved[\s\S]*in prumo/)
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
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-st="discussing"[^>]*[\s\S]*class="elapsed">não aferido</,'the card does not infer active time from an open discussion envelope')
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
    K: task('K', 'blocked', { blockReason: 'pick <the> API version', blockQuestion: 'Which API version should ship?',
      blockOptions: ['v1', 'v2'], blockHistory: [{ at: instant(10), reason: 'Needs a decision',
        question: 'Which API version should ship?', answer: 'v2' }] }),
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
    assert.match(list, lang === 'en' ? /Decision question: Which API version should ship\? · Options: v1 \/ v2/ :
      /Pergunta para decisão: Which API version should ship\? · Opções: v1 \/ v2/)
    ui.run("POP_MODE = 'lean'; fillPop('K')")
    const blockedPopover = ui.nodes.get('#popBody').innerHTML
    assert.equal((blockedPopover.match(/pick &lt;the&gt; API version/g) ?? []).length, 1, 'the blocked reason appears once in the lean popover')
    assert.match(list, /--role:var\(--running\)[\s\S]*\$ bun test auth[\s\S]*12 tests pass/)
    assert.match(list, /--role:var\(--planning\)/)
    assert.match(list, lang === 'en' ? /needs you/ : /precisa de você/)
    const resultTask = ui.run("RESULT_TASK_ID = 'K'; renderResultTaskDetail(STATE)")
    assert.match(resultTask, lang === 'en' ? /Decision question/ : /Pergunta para decisão/)
    assert.match(resultTask, /v1 \/ v2/)
    assert.match(resultTask, /v2/)
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

test('dashboard keeps a future open-question reference and its later decision visible', () => {
  const reference = 'T:plan:012345abcdef'
  for (const [lang, deadline, resolved] of [
    ['en', 'before task U', 'resolved by U'],
    ['pt-BR', 'antes da tarefa U', 'resolvida por U'],
  ]) {
    const ui = dashboard(lang)
    const state = { run: 'question-reference', plan: {}, tasks: {
      T: task('T', 'pending', { taskPlan: { ...plan, openQuestions: [{ question: 'Which protocol should U use?',
        blocking: false, decideBy: { beforeTask: 'U' }, questionRef: reference }] } }),
    }, questionResolutions: [{ questionRef: reference, byTask: 'U', answer: 'Use the existing client.' }],
      derived: { T: { effective: 'ready' } } }
    ui.render(state)
    ui.run("POP_MODE = 'detail'; fillPop('T')")
    const detail = ui.nodes.get('#popBody').innerHTML
    assert.ok(detail.includes(reference))
    assert.ok(detail.includes('Which protocol should U use?'))
    assert.ok(detail.includes(deadline))
    assert.ok(detail.includes(resolved))
    assert.ok(detail.includes('Use the existing client.'))
  }
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
  assert.match(lean, /class="lead">Task T/)
  assert.match(lean, /class="ptxt clamp">contrato antigo em prosa/)
  assert.equal((lean.match(/class="nosum"/g) ?? []).length, 1, 'a blank summary counts as absent')
})

test('detail preserves every recorded line in summaries, plans and validations while lean remains a preview', () => {
  const summary = 'Resumo 1\nResumo 2\nResumo 3\nResumo 4 <img src=x onerror="alert(1)">'
  const approach = 'Abordagem 1\nAbordagem 2\nAbordagem 3\nAbordagem 4'
  const research = 'Pesquisa 1\nPesquisa 2\nPesquisa 3\nPesquisa 4 <script>alert(1)</script>'
  const question = 'Pergunta 1\nPergunta 2\nPergunta 3\nPergunta 4'
  const answer = 'Decisão 1\nDecisão 2\nDecisão 3\nDecisão 4'
  const steps = 'Passo 1\nPasso 2\nPasso 3\nPasso 4'
  const criterion = 'Critério 1\nCritério 2\nCritério 3\nCritério 4'
  const check = 'Checagem 1\nChecagem 2\nChecagem 3\nChecagem 4'
  const rejectedSummary = 'Parecer reprovado 1\nParecer reprovado 2\nParecer reprovado 3\nParecer reprovado 4'
  const rejectedEvidence = 'Evidência reprovada 1\nEvidência reprovada 2\nEvidência reprovada 3\nEvidência reprovada 4'
  const approvedSummary = 'Parecer aprovado 1\nParecer aprovado 2\nParecer aprovado 3\nParecer aprovado 4'
  const approvedEvidence = 'Evidência aprovada 1\nEvidência aprovada 2\nEvidência aprovada 3\nEvidência aprovada 4'
  const extraEvidence = 'Validação extra 1\nValidação extra 2\nValidação extra 3\nValidação extra 4'
  const ui = dashboard('pt-BR')
  ui.render({ run: 'full-detail', plan: {}, tasks: { T: task('T', 'done', {
    summary,
    taskPlan: { ...plan, summary: approach,
      research: [{ source: 'arquivo atual', findings: research }],
      decisions: [{ question, answer }], steps: [steps],
      verification: [{ criterion, check }] },
    attempts: [{ n: 1, agent: 'executor-1', startedAt: instant(1), endedAt: instant(10) }],
    validations: [
      { attempt: 1, by: 'review', agent: 'revisor-1', ok: false, at: instant(2), summary: rejectedSummary, evidence: rejectedEvidence },
      { attempt: 1, by: 'review', agent: 'revisor-2', ok: true, at: instant(5), summary: approvedSummary, evidence: approvedEvidence },
      { attempt: 1, by: 'executor', agent: 'executor-1', ok: true, at: instant(8), evidence: extraEvidence },
    ],
  }) }, derived: { T: { effective: 'done' } } })

  ui.run("POP_MODE = 'lean'; fillPop('T')")
  const lean = ui.nodes.get('#popBody').innerHTML
  for (const line of ['Resumo 1', 'Resumo 2', 'Resumo 3', 'Resumo 4 &lt;img']) assert.ok(lean.includes(line), line)
  assert.doesNotMatch(lean, /Pesquisa 4|Evidência aprovada 4/)

  ui.run("POP_MODE = 'detail'; fillPop('T')")
  const detail = ui.nodes.get('#popBody').innerHTML
  for (const text of ['Resumo 4 &lt;img', 'Abordagem 4', 'Pesquisa 4 &lt;script&gt;', 'Pergunta 4', 'Decisão 4',
    'Passo 4', 'Critério 4', 'Checagem 4', 'Parecer reprovado 4', 'Evidência reprovada 4',
    'Parecer aprovado 4', 'Evidência aprovada 4', 'Validação extra 4']) assert.ok(detail.includes(text), text)
  assert.equal((detail.match(/class="vitem/g) ?? []).length, 3, 'every validation remains in the full list')
  assert.doesNotMatch(detail, /<img|onerror="|<script>/)

  const fallback = 'Título original 1\nTítulo original 2\nTítulo original 3\nTítulo original 4 <em>completo</em>'
  const fallbackUi = dashboard('pt-BR')
  fallbackUi.render({ run: 'fallback', plan: {}, tasks: { F: task('F', 'pending', { title: fallback, summary: '  ' }) }, derived: { F: { effective: 'ready' } } })
  fallbackUi.run("POP_MODE = 'lean'; fillPop('F')")
  const fallbackLean = fallbackUi.nodes.get('#popBody').innerHTML
  const fallbackPreview = fallbackLean.match(/<div class="lead">([\s\S]*?)<\/div>/)?.[1] ?? ''
  for (const line of ['Título original 1', 'Título original 2', 'Título original 3']) assert.ok(fallbackPreview.includes(line), line)
  assert.doesNotMatch(fallbackPreview, /Título original 4/)
  fallbackUi.run("POP_MODE = 'detail'; fillPop('F')")
  assert.ok(fallbackUi.nodes.get('#popBody').innerHTML.includes('Título original 4 &lt;em&gt;completo&lt;/em&gt;'))
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
test('task planning envelopes stay unmeasured and are subtracted from execution queue time', () => {
  const ui = dashboard()
  const completePlan = { ...plan, startedAt: instant(15), completedAt: instant(20) }
  const tasks = {
    D: task('D', 'done', { planningRequired: true, taskPlan: completePlan, planningHistory: [completePlan],
      planningAttempts: [
        { startedAt: instant(0), endedAt: instant(10), result: 'blocked' },
        { startedAt: instant(15), endedAt: instant(20), result: 'planned' },
      ], attempts: [{ startedAt: instant(30), reviewStartedAt: instant(50), endedAt: instant(60) }],
      validations: [{ by: 'review', attempt: 1, ok: true, at: instant(60) }] }),
    P: task('P', 'planning', { planningAttempts: [{ startedAt: instant(80) }] }),
    L: task('L', 'done', { attempts: [{ startedAt: instant(10), endedAt: instant(20) }] }),
  }
  const state = { run: 'metrics', createdAt: instant(0), plan: {}, tasks, derived: {} }
  const events = [
    { type: 'task_start', task: 'D', attempt: 1, at: instant(30) },
    { type: 'task_review', task: 'D', attempt: 1, at: instant(50) },
    { type: 'task_review_progress', task: 'D', attempt: 1, at: instant(60) },
    { type: 'task_validate', task: 'D', attempt: 1, by: 'review', at: instant(60) },
    { type: 'task_done', task: 'D', attempt: 1, at: instant(60) },
    { type: 'task_start', task: 'L', attempt: 1, at: instant(10) },
    { type: 'task_progress', task: 'L', attempt: 1, at: instant(20) },
    { type: 'task_done', task: 'L', attempt: 1, at: instant(20) },
  ]
  const result = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
  assert.equal(result.planningTotal, 0, 'task plan envelopes have no active planning telemetry')
  assert.equal(result.execTotal, 30000)
  assert.equal(result.reviewTotal, 10000)
  assert.equal(result.agentTotal, 40000)
  assert.equal(result.planningMeasured, false)
  assert.equal(result.per.find((t) => t.id === 'D').unmeasured, true)
  assert.equal(result.wall, 100000)
  assert.equal(result.anyLive, true)
  assert.equal(result.per.find((t) => t.id === 'D').queue, 10000)
  assert.equal(result.per.find((t) => t.id === 'P').queue, null)
  assert.equal(result.per.find((t) => t.id === 'L').queue, 10000)
  ui.run('FULL_EVENTS = inputEvents; renderResults(input)', { input: state, inputEvents: events })
  assert.match(ui.nodes.get('#results').innerHTML, /Planning share/)
  assert.match(ui.nodes.get('#results').innerHTML, /not measured/)
  assert.doesNotMatch(ui.nodes.get('#results').innerHTML, /<i class="gs"[^>]*background:var\(--planning\)/)
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
  const events = [{ type: 'task_start', task: 'A', attempt: 1, at: instant(30) },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(40) },
    { type: 'task_done', task: 'A', attempt: 1, at: instant(40) }]
  const result = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
  assert.equal(result.planningTotal, 0, 'phase envelopes without activity events are not active planning time')
  assert.equal(result.agentTotal, 10000)
  assert.equal(result.wall, 100000)
  assert.equal(result.anyLive, true, 'pending work keeps the run live even when no executor is active')
  assert.equal(JSON.stringify(result.phasePlanningByPhase), '[]')
  assert.equal(result.phasePlanning.find((attempt) => attempt.phase === 'F1').elapsed, 10000)
  assert.equal(result.phasePlanning.find((attempt) => attempt.phase === 'F2').elapsed, 20000)
  assert.equal(result.cpLen, 10000, 'unmeasured phase envelopes do not inflate the critical path')
  assert.equal(result.criticalPathMeasured, false, 'a path that omits unmeasured phase planning is not authoritative')
  ui.run('FULL_EVENTS = inputEvents; renderResults(input)', { input: state, inputEvents: events })
  const results = ui.nodes.get('#results').innerHTML
  assert.equal((results.match(/Active time not measured/g) ?? []).length, 5,
    'the phase label, tooltip and critical-path indicator identify unmeasured time without showing the envelope')
  assert.doesNotMatch(results, /open for|elapsed /)
})

test('the results time axis folds long gaps but keeps measured spans and boundaries exact', () => {
  const ui = dashboard()
  const values = JSON.parse(ui.run("(() => { const m = 60000; const axis = buildTimeAxis(0, 600*m, [[0, 5*m], [360*m, 365*m]], [[120*m, 240*m]]); const overlap = buildTimeAxis(0, 10*m, [[0, 6*m], [4*m, 10*m]]); const exact = buildTimeAxis(0, 30*m, [], []); const over = buildTimeAxis(0, 31*m, [], []); const zero = buildTimeAxis(7, 7, [[NaN, 20]], [[7, NaN]]); return JSON.stringify({ width: axis.width, activeFirst: axis.position(5*m) - axis.position(0), activeSecond: axis.position(365*m) - axis.position(360*m), idle: axis.breaks.map(gap => gap.duration), unmeasured: axis.unmeasured.map(gap => gap.duration), unmeasuredWidth: axis.position(240*m) - axis.position(120*m), overlapWidth: overlap.width, exactWidth: exact.width, exactBreaks: exact.breaks.length, overWidth: over.width, overBreaks: over.breaks.map(gap => gap.duration), zeroWidth: zero.width, zeroPosition: zero.position(7), zeroTime: zero.timeAt(1) }) })()"))
  assert.equal(values.width, 130 * 60000)
  assert.equal(values.activeFirst, 5 * 60000)
  assert.equal(values.activeSecond, 5 * 60000)
  assert.deepEqual(values.idle, [115, 120, 235].map(minutes => minutes * 60000))
  assert.deepEqual(values.unmeasured, [120 * 60000])
  assert.equal(values.unmeasuredWidth, 30 * 60000)
  assert.equal(values.overlapWidth, 10 * 60000, 'overlapping activity counts once and retains its true width')
  assert.equal(values.exactWidth, 30 * 60000, 'the exact threshold does not fold')
  assert.equal(values.exactBreaks, 0)
  assert.equal(values.overWidth, 30 * 60000, 'gaps above the threshold fold to 30 minutes')
  assert.deepEqual(values.overBreaks, [31 * 60000])
  assert.equal(values.zeroWidth, 1, 'an empty or invalid timeline stays finite')
  assert.equal(values.zeroPosition, 0)
  assert.equal(values.zeroTime, 7)
  assert.match(html, /\.grow \.gs[^}]*min-width: 5px/)
})

test('mobile header puts filters and counters behind a compact menu below 700px', () => {
  const small = dashboard('en', 330)
  assert.equal(small.nodes.get('#headerMenu').open, false)
  const wide = dashboard('en', 1440)
  assert.equal(wide.nodes.get('#headerMenu').open, true)
  small.resize(400)
  assert.equal(small.nodes.get('#headerMenu').open, true)
  small.resize(330)
  assert.equal(small.nodes.get('#headerMenu').open, false)
  const menuStart = html.indexOf('<details class="header-menu"')
  const menu = html.slice(menuStart, html.indexOf('</details>', menuStart) + 10)
  assert.ok(menu.includes('id="statusFilter"'))
  assert.ok(menu.includes('id="counts"'))
  assert.match(menu, /<div class="filter-menu" id="filterMenu">/)
  assert.doesNotMatch(menu, /<details[^>]+class="filter-menu"/)
  small.run('toggleFilterMenu()')
  assert.equal(small.nodes.get('#filterPanel').hidden, false)
  assert.equal(small.nodes.get('#filterToggle').getAttribute('aria-expanded'), 'true')
  small.run('setFilter("done")')
  assert.equal(small.nodes.get('#filterPanel').hidden, true)
  assert.equal(small.nodes.get('#filterToggle').getAttribute('aria-expanded'), 'false')
  assert.match(html, /@media \(max-width: 700px\)/)
})

test('115h23 phase envelope stays out of displayed time while measured work and critical path stay exact', () => {
  const elapsedSeconds = (115 * 60 + 23) * 60
  const phaseStart = instant(100 - elapsedSeconds)
  for (const open of [false, true]) {
    const ui = dashboard('pt-BR')
    const taskValue = task('A', 'done', {
      title: 'A tarefa tem um título muito comprido',
      label: 'Tarefa curta',
      phase: 'F0',
      attempts: [{ startedAt: instant(95), endedAt: instant(100) }],
    })
    const state = {
      run: 'phase-long',
      createdAt: phaseStart,
      plan: { phases: [{ id: 'F0', title: 'Título completo da fase F0 muito grande', label: 'Fase curta' }] },
      tasks: { A: taskValue },
      derived: { A: { effective: 'done', blockedBy: [] } },
      phaseWorkflows: { F0: {
        id: 'F0', state: open ? 'planning' : 'planned',
        planningAttempts: [{ startedAt: phaseStart, ...(open ? {} : { endedAt: instant(100) }) }],
      } },
    }
    const events = [
      { type: 'task_start', task: 'A', attempt: 1, at: instant(95) },
      { type: 'task_progress', task: 'A', attempt: 1, at: instant(100) },
      { type: 'task_done', task: 'A', attempt: 1, at: instant(100) },
    ]
    const result = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
    assert.equal(result.phasePlanning[0].elapsed, elapsedSeconds * 1000)
    assert.equal(result.phasePlanning[0].duration, 0)
    assert.equal(result.planningTotal, 0)
    assert.equal(result.agentTotal, 5000)
    assert.equal(result.activeElapsed, 5000)
    assert.equal(result.wall, elapsedSeconds * 1000)
    assert.equal(result.cpLen, 5000, 'the measured task alone remains available to internal calculations')
    assert.equal(result.criticalPathMeasured, false, 'unmeasured phase planning suppresses the displayed critical path')
    ui.render(state, events)
    const graph = ['#doneCount', '#lanes', '#nodes', '#parallel', '#orch', '#planSub']
      .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
    assert.match(graph, /5s/)
    assert.match(graph, /tempo ativo não aferido/)
    assert.doesNotMatch(graph, /115h|76h|192h|115:23|24h/)
    ui.run('FULL_EVENTS = inputEvents; renderResults(input)', { input: state, inputEvents: events })
    const results = ui.nodes.get('#results').innerHTML
    assert.equal((results.match(/tempo ativo não aferido/g) ?? []).length, 3,
      'phase label, tooltip and critical-path indicator state the measurement limit without elapsed hours')
    assert.ok(results.includes('F0 · Fase curta'))
    assert.ok(results.includes('F0 · Título completo da fase F0 muito grande'))
    assert.ok(results.includes('title="A tarefa tem um título muito comprido"'))
    assert.ok(results.includes('Tarefa curta'))
    assert.ok(results.includes('>5s</span>'))
    assert.doesNotMatch(results, /class="cp-tag"/)
    assert.match(results, /Caminho crítico[\s\S]*tempo ativo não aferido/)
    assert.doesNotMatch(results, /115h|76h|192h|115h23|aberta por|decorrido/)
  }
})

test('blocked execution keeps only its two measured slices across graph, results and popover', () => {
  const waitSeconds = 115 * 3600 + 23 * 60
  const startSeconds = 100 - waitSeconds - 10
  const events = [
    { type: 'task_start', task: 'A', attempt: 1, at: instant(startSeconds) },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(startSeconds + 5), current: 1, total: 2 },
    { type: 'task_block', task: 'A', attempt: 1, at: instant(startSeconds + 5) },
    { type: 'task_unblock', task: 'A', attempt: 1, at: instant(startSeconds + waitSeconds + 5), state: 'running' },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(100), current: 2, total: 2 },
  ]
  const value = task('A', 'running', { phase: 'F0', agent: 'executor-1', attempts: [{ n: 1, startedAt: instant(startSeconds) }] })
  const state = { run: 'blocked-gap', createdAt: instant(startSeconds), plan: { phases: [{ id: 'F0', title: 'Fase longa' }] },
    tasks: { A: value }, derived: { A: { effective: 'running', blockedBy: [] } } }
  const ui = dashboard('pt-BR')
  ui.render(state, events)

  const graph = ['#doneCount', '#lanes', '#nodes', '#parallel', '#orch', '#planSub']
    .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
  assert.match(graph, /10s/)
  assert.match(graph, /não aferido/)
  assert.doesNotMatch(graph, /115h|76h|192h|115:23|24h/)

  const metrics = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
  assert.equal(metrics.agentTotal, 10000)
  assert.equal(metrics.activeElapsed, 10000)
  assert.equal(metrics.cpLen, 10000)
  assert.deepEqual(JSON.parse(JSON.stringify(metrics.per[0].spans.map(([kind, from, to]) => [kind, Math.round((to - from) / 1000)]))), [['exec', 5], ['exec', 5]])

  ui.run('FULL_EVENTS = inputEvents; RESULTS_OPEN = true; renderResults(STATE)', { inputEvents: events })
  const results = ui.nodes.get('#results').innerHTML
  assert.match(results, /10s/)
  assert.match(results, /⋯ parado/)
  assert.doesNotMatch(results, /115h|76h|192h|115:23|24h|115 hours/)

  ui.run("POP = { id: 'A', pinned: true }; POP_MODE = 'lean'; fillPop('A')")
  const popover = ui.nodes.get('#popBody').innerHTML
  assert.match(popover, /10s/)
  assert.doesNotMatch(popover, /115h|76h|192h|115:23|24h/)
})

test('more than 120 events preserve long pauses and never display unmeasured envelope time', () => {
  const waitSeconds = 115 * 3600 + 23 * 60
  const startSeconds = 100 - waitSeconds - 10
  const events = [
    { type: 'task_start', task: 'A', attempt: 1, at: instant(startSeconds) },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(startSeconds + 5), current: 1, total: 2 },
    { type: 'task_block', task: 'A', attempt: 1, at: instant(startSeconds + 5) },
    ...Array.from({ length: 121 }, (_, index) => ({ type: 'task_note', task: 'OTHER', at: instant(90 + index / 100), text: `event-${index}` })),
    { type: 'task_unblock', task: 'A', attempt: 1, at: instant(startSeconds + waitSeconds + 5), state: 'running' },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(100), current: 2, total: 2 },
  ]
  const value = task('A', 'running', { agent: 'executor-1', attempts: [{ n: 1, startedAt: instant(startSeconds) }] })
  const state = { run: 'long-block', createdAt: instant(startSeconds), plan: {}, tasks: { A: value },
    derived: { A: { effective: 'running', blockedBy: [] } } }
  assert.ok(events.length > 120)
  const ui = dashboard('en')
  const truncated = events.slice(-120)
  const truncatedCalculation = ui.run('analyse(input, inputEvents, true)', { input: state, inputEvents: truncated })
  assert.equal(truncatedCalculation.agentTotal, 5000, 'a long gap without its opening pause marker remains unknown')

  ui.run('EVENTS_COMPLETE = false')
  ui.render(state, truncated)
  const visibleWhileIncomplete = ['#orch', '#doneCount', '#parallel', '#nodes', '#planSub']
    .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
  assert.match(visibleWhileIncomplete, /Live[\s\S]*not measured/)
  assert.match(ui.nodes.get('#orch').innerHTML, /aria-label="Agent time: not measured"/)
  assert.equal(ui.nodes.get('#orch').classList.contains('live'), true)
  assert.match(visibleWhileIncomplete, /not measured/)
  assert.doesNotMatch(visibleWhileIncomplete, /115h|115:23|415390s/)
  ui.run("POP = { id: 'A', pinned: true }; POP_MODE = 'lean'; fillPop('A')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /Agent time[\s\S]*· not measured/)
  ui.run('FULL_EVENTS = inputEvents; RESULTS_OPEN = true; renderResults(STATE)', { inputEvents: truncated })
  const incompleteResults = ui.nodes.get('#results').innerHTML
  assert.match(incompleteResults, /tempo ativo não aferido|Active time not measured/)
  assert.doesNotMatch(incompleteResults, /115h|115:23|415390s/)

  ui.run('EVENTS_COMPLETE = true; FULL_EVENTS = inputEvents; EVENTS = inputEvents; render(STATE, inputEvents); renderResults(STATE)',
    { input: state, inputEvents: events })
  const completeMetrics = ui.run('analyse(input, inputEvents, true)', { input: state, inputEvents: events })
  assert.equal(completeMetrics.agentTotal, 10000)
  assert.equal(completeMetrics.per[0].blocked, waitSeconds * 1000)
  assert.match(ui.nodes.get('#orch').innerHTML, /Live[\s\S]*00:00:10/)
  assert.match(ui.nodes.get('#orch').innerHTML, /aria-label="Agent time: 00:00:10 · not measured"/)
  const visibleWithCompleteHistory = ['#orch', '#doneCount', '#parallel', '#results', '#popBody']
    .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
  assert.doesNotMatch(visibleWithCompleteHistory, /115h|115:23|415390s/)
})

test('late event pages from a previous run cannot contaminate the newly selected run', async () => {
  const ui = dashboard()
  let resolvePage
  ui.run('fetch = inputFetch', { inputFetch: () => new Promise(resolve => { resolvePage = resolve }) })
  ui.run("TICK_GENERATION = 1; resetEventHistory('root/run-a')")
  const oldRun = ui.run("syncEventHistory(1, 'root/run-a')")
  ui.run("TICK_GENERATION = 2; resetEventHistory('root/run-b'); FULL_EVENTS = [{ id: 'new-run' }]; EVENTS = FULL_EVENTS; EVENT_OFFSET = 1; EVENT_HISTORY_REVISION = 'rev-b'; EVENTS_COMPLETE = true")
  const staleEntry = ui.run("syncEventHistory(1, 'root/run-a')")
  assert.equal(ui.run('EVENT_HISTORY_KEY'), 'root/run-b', 'an obsolete entry cannot reset the newly selected history')
  resolvePage({ ok: true, json: async () => ({ events: [{ id: 'old-run' }], next: 1, total: 1, complete: true, revision: 'rev-a' }) })
  await oldRun
  await staleEntry
  assert.equal(ui.run('EVENT_HISTORY_KEY'), 'root/run-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'new-run' }])
  assert.equal(ui.run('EVENT_HISTORY_REVISION'), 'rev-b')
  assert.equal(ui.run('EVENTS_COMPLETE'), true)
})

test('a late state response after selecting another run cannot replace its state or history', async () => {
  const ui = dashboard()
  const oldState = { run: 'run-a', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  const newState = { run: 'run-b', createdAt: instant(0), plan: { phases: [] },
    tasks: { B: task('B', 'done') }, derived: { B: { effective: 'done', blockedBy: [] } } }
  const runs = {
    a: { currentRoot: 'root-a', current: 'run-a', runs: [{ root: 'root-a', run: 'run-a', plan: '' }] },
    b: { currentRoot: 'root-b', current: 'run-b', runs: [{ root: 'root-b', run: 'run-b', plan: '' }] },
  }
  let activeRun = 'a', resolveOldState, announceOldState
  const oldStateStarted = new Promise(resolve => { announceOldState = resolve })
  const pendingOldState = new Promise(resolve => { resolveOldState = resolve })
  ui.run('fetch = inputFetch', { inputFetch: (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/runs') return Promise.resolve({ ok: true, json: async () => runs[activeRun] })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-a') {
      return Promise.resolve({ ok: true, json: () => { announceOldState(); return pendingOldState } })
    }
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => newState })
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => ({ events: [{ id: 'run-b-event' }], next: 1, total: 1, complete: true, revision: 'rev-b' }) })
    throw new Error(`Unexpected request: ${url}`)
  } })

  ui.run("SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; TICK_GENERATION = 1")
  const oldTick = ui.run('tick(1)')
  await oldStateStarted

  activeRun = 'b'
  ui.run("SELECTED_ROOT = 'root-b'; SELECTED_RUN = 'run-b'; TICK_GENERATION = 2; resetEventHistory()")
  await ui.run('tick(2)')
  assert.equal(ui.run('STATE.run'), 'run-b')
  assert.equal(ui.run('EVENT_HISTORY_KEY'), 'root-b\u0000run-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'run-b-event' }])
  assert.equal(ui.run('EVENTS_COMPLETE'), true)

  resolveOldState(oldState)
  await oldTick
  assert.equal(ui.run('STATE.run'), 'run-b', 'the stale state body cannot repaint run A over run B')
  assert.equal(ui.run('EVENT_HISTORY_KEY'), 'root-b\u0000run-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'run-b-event' }])
  assert.equal(ui.run('EVENT_HISTORY_REVISION'), 'rev-b')
  assert.equal(ui.run('EVENTS_COMPLETE'), true)
  assert.equal(ui.nodes.get('#runName').textContent, 'run-b')
})

test('a late runs catalog cannot move the header back to a previous run', async () => {
  const ui = dashboard()
  const oldState = { run: 'run-a', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  const newState = { run: 'run-b', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  const runs = {
    a: { currentRoot: 'root-a', current: 'run-a', runs: [{ root: 'root-a', run: 'run-a', plan: '' }] },
    b: { currentRoot: 'root-b', current: 'run-b', runs: [{ root: 'root-b', run: 'run-b', plan: '' }] },
  }
  let activeRun = 'a', resolveOldRuns, announceOldRuns
  const oldRunsStarted = new Promise(resolve => { announceOldRuns = resolve })
  const pendingOldRuns = new Promise(resolve => { resolveOldRuns = resolve })
  ui.run('fetch = inputFetch', { inputFetch: (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/runs' && activeRun === 'a')
      return Promise.resolve({ ok: true, json: () => { announceOldRuns(); return pendingOldRuns } })
    if (url.pathname === '/api/runs') return Promise.resolve({ ok: true, json: async () => runs.b })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-a')
      return Promise.resolve({ ok: true, json: async () => oldState })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => newState })
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => ({ events: [{ id: 'run-b-event' }], next: 1, total: 1, complete: true, revision: 'rev-b' }) })
    throw new Error(`Unexpected request: ${url}`)
  } })

  ui.run("SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; TICK_GENERATION = 1")
  const oldTick = ui.run('tick(1)')
  await oldRunsStarted
  activeRun = 'b'
  ui.run("SELECTED_ROOT = 'root-b'; SELECTED_RUN = 'run-b'; TICK_GENERATION = 2; resetEventHistory()")
  await ui.run('tick(2)')
  assert.equal(ui.nodes.get('#runName').textContent, 'run-b')

  resolveOldRuns(runs.a)
  await oldTick
  assert.equal(ui.nodes.get('#runName').textContent, 'run-b', 'the previous catalog cannot repaint the run selector')
  assert.equal(ui.run('STATE.run'), 'run-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'run-b-event' }])
  assert.equal(ui.run('EVENTS_COMPLETE'), true)
})

test('late result events from run A cannot replace results for run B', async () => {
  const ui = dashboard()
  const stateA = { run: 'run-a', createdAt: instant(0), plan: { phases: [] },
    tasks: { A: task('A', 'done') }, derived: { A: { effective: 'done' } } }
  const stateB = { run: 'run-b', createdAt: instant(0), plan: { phases: [] },
    tasks: { B: task('B', 'done') }, derived: { B: { effective: 'done' } } }
  let resolveEventsA, announceEventsA
  const eventsAStarted = new Promise(resolve => { announceEventsA = resolve })
  const pendingEventsA = new Promise(resolve => { resolveEventsA = resolve })
  let eventsBStarted
  const eventsBLoaded = new Promise(resolve => { eventsBStarted = resolve })
  ui.run('fetch = inputFetch', { inputFetch: (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-a')
      return Promise.resolve({ ok: true, json: () => { announceEventsA(); return pendingEventsA } })
    if (url.pathname === '/api/runs')
      return Promise.resolve({ ok: true, json: async () => ({ currentRoot: 'root-b', current: 'run-b', runs: [{ root: 'root-b', run: 'run-b', plan: '' }] }) })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => stateB })
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => {
        eventsBStarted()
        return { events: [{ id: 'run-b-event' }], next: 1, total: 1, complete: true, revision: 'rev-b' }
      } })
    throw new Error(`Unexpected request: ${url}`)
  } })
  ui.run("STATE = input; SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; CURRENT_ROOT = 'root-a'; CURRENT_RUN = 'run-a'; TICK_GENERATION = 1; STATE_RUN_KEY = 'root-a\\0run-a'; EVENT_HISTORY_KEY = STATE_RUN_KEY; EVENTS_COMPLETE = true; RESULTS_OPEN = true; renderResults(STATE)", { input: stateA })
  const oldResults = ui.run('loadResults()')
  await eventsAStarted

  ui.run("selectRun('root-b/run-b')")
  await eventsBLoaded
  for (let tries = 0; tries < 60 && ui.run("STATE?.run !== 'run-b' || !EVENTS_COMPLETE || !$('#results').innerHTML.includes('run-b')"); tries++)
    await Promise.resolve()
  assert.equal(ui.run('STATE.run'), 'run-b')
  assert.match(ui.nodes.get('#results').innerHTML, /results · run-b/)

  resolveEventsA({ events: [{ id: 'stale-run-a-event' }], next: 1, total: 1, complete: true, revision: 'rev-a' })
  await oldResults
  assert.match(ui.nodes.get('#results').innerHTML, /results · run-b/)
  assert.doesNotMatch(ui.nodes.get('#results').innerHTML, /results · run-a|stale-run-a-event/)
  assert.equal(ui.run('EVENT_HISTORY_KEY'), 'root-b\u0000run-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'run-b-event' }])
})

test('opening results while the selected run state is still loading never shows the previous run', async () => {
  const ui = dashboard()
  const stateA = { run: 'run-a', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  const stateB = { run: 'run-b', createdAt: instant(0), plan: { phases: [] },
    tasks: { B: task('B', 'done') }, derived: { B: { effective: 'done' } } }
  let resolveStateB, announceStateB
  const stateBStarted = new Promise(resolve => { announceStateB = resolve })
  const pendingStateB = new Promise(resolve => { resolveStateB = resolve })
  let eventsBRequests = 0
  ui.run('fetch = inputFetch', { inputFetch: (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/runs')
      return Promise.resolve({ ok: true, json: async () => ({ currentRoot: 'root-b', current: 'run-b', runs: [{ root: 'root-b', run: 'run-b', plan: '' }] }) })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: () => { announceStateB(); return pendingStateB } })
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-b') {
      eventsBRequests++
      return Promise.resolve({ ok: true, json: async () => ({ events: [{ id: 'run-b-event' }], next: 1, total: 1, complete: true, revision: 'rev-b' }) })
    }
    throw new Error(`Unexpected request: ${url}`)
  } })
  ui.run("STATE = input; SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; CURRENT_ROOT = 'root-a'; CURRENT_RUN = 'run-a'; TICK_GENERATION = 1; STATE_RUN_KEY = 'root-a\\0run-a'; EVENT_HISTORY_KEY = STATE_RUN_KEY; EVENTS_COMPLETE = true; renderResults(STATE)", { input: stateA })
  ui.run("selectRun('root-b/run-b')")
  await stateBStarted

  await ui.run('toggleResults()')
  assert.equal(ui.run('RESULTS_OPEN'), true)
  assert.equal(ui.nodes.get('#results').innerHTML, '')
  assert.equal(ui.nodes.get('#results').getAttribute('aria-busy'), 'true')
  assert.equal(eventsBRequests, 0, 'events are not fetched against the old state')

  resolveStateB(stateB)
  for (let tries = 0; tries < 60 && ui.run("STATE?.run !== 'run-b' || !EVENTS_COMPLETE || !$('#results').innerHTML.includes('run-b')"); tries++)
    await Promise.resolve()
  assert.equal(ui.run('STATE.run'), 'run-b')
  assert.match(ui.nodes.get('#results').innerHTML, /results · run-b/)
  assert.equal(ui.nodes.get('#results').getAttribute('aria-busy'), 'false')
})

test('closing results while event history is pending prevents a late repaint', async () => {
  const ui = dashboard()
  const state = { run: 'run-a', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  let resolvePage, announcePage
  const pageStarted = new Promise(resolve => { announcePage = resolve })
  const pendingPage = new Promise(resolve => { resolvePage = resolve })
  ui.run('fetch = inputFetch', { inputFetch: () => Promise.resolve({
    ok: true, json: () => { announcePage(); return pendingPage },
  }) })
  ui.run("STATE = input; TICK_GENERATION = 1; STATE_RUN_KEY = 'root-a\\0run-a'; EVENT_HISTORY_KEY = STATE_RUN_KEY; EVENTS_COMPLETE = true; RESULTS_OPEN = true; renderResults(STATE)", { input: state })
  const pendingResults = ui.run('loadResults()')
  await pageStarted
  await ui.run('toggleResults()')
  assert.equal(ui.run('RESULTS_OPEN'), false)
  ui.nodes.get('#results').innerHTML = 'closed-tab marker'
  resolvePage({ events: [{ id: 'late' }], next: 1, total: 1, complete: true, revision: 'rev-a' })
  await pendingResults
  assert.equal(ui.nodes.get('#results').innerHTML, 'closed-tab marker')
})

test('a changed event revision replaces the cached browser history from its first page', async () => {
  const ui = dashboard()
  const responses = [
    { events: [{ id: 'old-run' }], next: 1, total: 1, complete: true, revision: 'rev-a' },
    { events: [{ id: 'new-run-1' }], next: 1, total: 2, complete: false, reset: true, revision: 'rev-b' },
    { events: [{ id: 'new-run-2' }], next: 2, total: 2, complete: true, revision: 'rev-b' },
  ]
  ui.run('fetch = inputFetch', { inputFetch: async () => ({ ok: true, json: async () => responses.shift() }) })
  ui.run("TICK_GENERATION = 1; resetEventHistory('root/run-a')")
  assert.equal(await ui.run("syncEventHistory(1, 'root/run-a')"), true)
  assert.equal(ui.run('EVENT_HISTORY_REVISION'), 'rev-a')
  assert.equal(await ui.run("syncEventHistory(1, 'root/run-a')"), false, 'revision change restarts at the first page and waits for the next page')
  assert.equal(ui.run('EVENT_HISTORY_REVISION'), 'rev-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'new-run-1' }])
  assert.equal(await ui.run("syncEventHistory(1, 'root/run-a')"), true)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'new-run-1' }, { id: 'new-run-2' }])
})

test('115h task planning envelopes stay unmeasured and cannot inflate the critical path', () => {
  const waitSeconds = 115 * 3600 + 23 * 60
  const planStart = instant(100 - waitSeconds)
  const taskValue = task('P', 'done', {
    planningAttempts: [{ startedAt: planStart, endedAt: instant(95) }],
    attempts: [{ n: 1, startedAt: instant(95), endedAt: instant(100) }],
  })
  const state = { run: 'task-plan-envelope', createdAt: planStart, plan: {}, tasks: { P: taskValue },
    derived: { P: { effective: 'done' } } }
  const events = [
    { type: 'task_start', task: 'P', attempt: 1, at: instant(95) },
    { type: 'task_progress', task: 'P', attempt: 1, at: instant(100) },
    { type: 'task_done', task: 'P', attempt: 1, at: instant(100) },
  ]
  const ui = dashboard('pt-BR')
  const result = ui.run('analyse(input, inputEvents, true)', { input: state, inputEvents: events })
  assert.equal(result.planningTotal, 0)
  assert.equal(result.execTotal, 5000)
  assert.equal(result.agentTotal, 5000)
  assert.equal(result.planningMeasured, false)
  assert.equal(result.criticalPathMeasured, false)
  assert.equal(result.per[0].unmeasured, true)
  ui.render(state, events)
  const graph = ['#orch', '#doneCount', '#nodes', '#parallel'].map(selector => ui.nodes.get(selector).innerHTML).join('\n')
  assert.match(graph, /concluída[\s\S]*00:00:05/i)
  assert.match(graph, /tempo ativo não aferido/)
  assert.doesNotMatch(graph, /115h|115:23|415390s/)
  ui.run('FULL_EVENTS = inputEvents; renderResults(input)', { input: state, inputEvents: events })
  const results = ui.nodes.get('#results').innerHTML
  assert.match(results, /tempo ativo não aferido/)
  assert.doesNotMatch(results, /class="cp-tag"|115h|115:23|415390s/)
  ui.run("POP = { id: 'P', pinned: true }; POP_MODE = 'lean'; fillPop('P')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /Agent time[\s\S]*· 5s · não aferido/)
  assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, /115h|115:23|415390s/)
})

test('review time ends at the last validation receipt even when done arrives 115h later', () => {
  const waitSeconds = 115 * 3600 + 23 * 60
  const startSeconds = 100 - waitSeconds - 10
  const reviewAt = startSeconds + 5
  const receiptAt = startSeconds + 10
  const events = [
    { type: 'task_start', task: 'A', attempt: 1, at: instant(startSeconds) },
    { type: 'task_review', task: 'A', attempt: 1, at: instant(reviewAt) },
    { type: 'task_review_progress', task: 'A', attempt: 1, at: instant(receiptAt) },
    { type: 'task_validate', task: 'A', attempt: 1, by: 'review', ok: true, at: instant(receiptAt) },
    { type: 'task_done', task: 'A', attempt: 1, at: instant(100) },
  ]
  const value = task('A', 'done', { phase: 'F0', attempts: [{ n: 1, startedAt: instant(startSeconds), reviewStartedAt: instant(reviewAt), endedAt: instant(100) }],
    validations: [{ by: 'review', attempt: 1, ok: true, at: instant(receiptAt) }] })
  const state = { run: 'review-wait', createdAt: instant(startSeconds), plan: {}, tasks: { A: value }, derived: { A: { effective: 'done', blockedBy: [] } } }
  const ui = dashboard('pt-BR')
  const result = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
  assert.equal(result.execTotal, 5000)
  assert.equal(result.reviewTotal, 5000)
  assert.equal(result.agentTotal, 10000)
  assert.equal(result.activeElapsed, 10000)
  assert.equal(result.cpLen, 10000)
  assert.equal(result.criticalPathMeasured, false, 'the 115h tail after the last reviewer activity stays unknown')
  ui.render(state, events)
  ui.run('FULL_EVENTS = inputEvents; renderResults(STATE)', { inputEvents: events })
  const results = ui.nodes.get('#results').innerHTML
  assert.match(results, /10s/)
  assert.doesNotMatch(results, /115h|76h|192h|115:23|24h/)
})

test('large gaps between activity milestones are unknown and never counted as agent time', () => {
  const waitSeconds = 115 * 3600 + 23 * 60
  const startSeconds = 100 - waitSeconds - 10
  const endSeconds = 100
  const cases = [
    {
      name: 'late execution milestone',
      events: [
        { type: 'task_start', task: 'E', attempt: 1, at: instant(startSeconds) },
        { type: 'task_progress', task: 'E', attempt: 1, at: instant(startSeconds + waitSeconds + 5) },
        { type: 'task_done', task: 'E', attempt: 1, at: instant(endSeconds) },
      ],
      value: task('E', 'done', { attempts: [{ n: 1, startedAt: instant(startSeconds), endedAt: instant(endSeconds) }] }),
      expected: 0,
    },
    {
      name: 'late review start',
      events: [
        { type: 'task_start', task: 'E', attempt: 1, at: instant(startSeconds) },
        { type: 'task_review', task: 'E', attempt: 1, at: instant(startSeconds + waitSeconds + 5) },
        { type: 'task_review_progress', task: 'E', attempt: 1, at: instant(endSeconds - 1) },
        { type: 'task_validate', task: 'E', attempt: 1, by: 'review', at: instant(endSeconds) },
        { type: 'task_done', task: 'E', attempt: 1, at: instant(endSeconds) },
      ],
      value: task('E', 'done', { attempts: [{ n: 1, startedAt: instant(startSeconds), reviewStartedAt: instant(startSeconds + waitSeconds + 5), endedAt: instant(endSeconds) }],
        validations: [{ by: 'review', attempt: 1, ok: true, at: instant(endSeconds) }] }),
      expected: 4000,
    },
    {
      name: 'late review progress',
      events: [
        { type: 'task_start', task: 'E', attempt: 1, at: instant(startSeconds) },
        { type: 'task_review', task: 'E', attempt: 1, at: instant(startSeconds + 5) },
        { type: 'task_review_progress', task: 'E', attempt: 1, at: instant(startSeconds + waitSeconds + 5) },
        { type: 'task_validate', task: 'E', attempt: 1, by: 'review', at: instant(endSeconds) },
        { type: 'task_done', task: 'E', attempt: 1, at: instant(endSeconds) },
      ],
      value: task('E', 'done', { attempts: [{ n: 1, startedAt: instant(startSeconds), reviewStartedAt: instant(startSeconds + 5), endedAt: instant(endSeconds) }],
        validations: [{ by: 'review', attempt: 1, ok: true, at: instant(endSeconds) }] }),
      expected: 5000,
    },
    {
      name: 'late validation receipt without review progress',
      events: [
        { type: 'task_start', task: 'E', attempt: 1, at: instant(startSeconds) },
        { type: 'task_review', task: 'E', attempt: 1, at: instant(startSeconds + 5) },
        { type: 'task_validate', task: 'E', attempt: 1, by: 'review', at: instant(endSeconds) },
        { type: 'task_done', task: 'E', attempt: 1, at: instant(endSeconds) },
      ],
      value: task('E', 'done', { attempts: [{ n: 1, startedAt: instant(startSeconds), reviewStartedAt: instant(startSeconds + 5), endedAt: instant(endSeconds) }],
        validations: [{ by: 'review', attempt: 1, ok: true, at: instant(endSeconds) }] }),
      expected: 5000,
    },
  ]
  for (const item of cases) {
    const state = { run: item.name, createdAt: instant(startSeconds), plan: {}, tasks: { E: item.value }, derived: { E: { effective: 'done' } } }
    const ui = dashboard('pt-BR')
    const metrics = ui.run('analyse(input, inputEvents, true)', { input: state, inputEvents: item.events })
    assert.equal(metrics.agentTotal, item.expected, item.name)
    assert.equal(metrics.per[0].unmeasured, true, item.name)
    assert.equal(metrics.criticalPathMeasured, false, item.name)
    ui.render(state, item.events)
    ui.run('FULL_EVENTS = inputEvents; renderResults(STATE); POP = { id: "E", pinned: true }; POP_MODE = "detail"; fillPop("E")',
      { inputEvents: item.events })
    const visible = ['#orch', '#doneCount', '#parallel', '#nodes', '#results', '#popBody']
      .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
    assert.doesNotMatch(visible, /115h|115:23|415390s/, item.name)
    assert.match(ui.nodes.get('#popBody').innerHTML, /Agent time[\s\S]*não aferido/, item.name)
    if (item.expected === 0) assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, />0s</, item.name)
  }
})

test('switching runs clears the previous graph and exposes a loading state until the new run paints', () => {
  const ui = dashboard('pt-BR')
  const stateA = { run: 'run-a', createdAt: instant(0), plan: {}, tasks: { A: task('A', 'done') }, derived: { A: { effective: 'done' } } }
  const stateB = { run: 'run-b', createdAt: instant(0), plan: {}, tasks: { B: task('B', 'done') }, derived: { B: { effective: 'done' } } }
  ui.render(stateA)
  ui.run("SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; CURRENT_ROOT = 'root-a'; CURRENT_RUN = 'run-a'")
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-id="A"/)

  ui.run("selectRun('root-b/run-b')")
  assert.equal(ui.nodes.get('#nodes').innerHTML, '')
  assert.equal(ui.nodes.get('#lanes').innerHTML, '')
  assert.equal(ui.nodes.get('#runLoading').hidden, false)
  assert.equal(ui.nodes.get('#runLoadingStatus').hidden, false)
  assert.equal(ui.nodes.get('#main').inert, true)
  assert.equal(ui.nodes.get('#main').getAttribute('aria-busy'), 'true')
  assert.ok(html.indexOf('id="runLoadingStatus"') < html.indexOf('<main id="main">'), 'the live loading status remains outside the inert main')
  assert.equal(ui.nodes.get('#runName').textContent, 'run-b')
  assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML + ui.nodes.get('#events').innerHTML, /run-a|A/)

  ui.run('STATE = stateB; STATE_RUN_KEY = "root-b\\0run-b"; render(STATE, [])', { stateB })
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-id="B"/)
  assert.equal(ui.nodes.get('#runLoading').hidden, true)
  assert.equal(ui.nodes.get('#runLoadingStatus').hidden, true)
  assert.equal(ui.nodes.get('#main').inert, false)
  assert.equal(ui.nodes.get('#viewport').getAttribute('aria-busy'), 'false')
})

test('open execution without progress telemetry stays unmeasured in every visible surface', () => {
  const elapsedSeconds = 115 * 3600 + 23 * 60
  const start = instant(100 - elapsedSeconds)
  const events = [{ type: 'task_start', task: 'A', attempt: 1, at: start }]
  const value = task('A', 'running', { attempts: [{ n: 1, startedAt: start }] })
  const state = { run: 'no-progress', createdAt: start, plan: {}, tasks: { A: value },
    derived: { A: { effective: 'running', blockedBy: [] } } }
  const ui = dashboard('pt-BR')
  ui.render(state, events)
  const metrics = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
  assert.equal(metrics.agentTotal, 0)
  assert.equal(metrics.activeElapsed, 0)
  assert.equal(metrics.cpLen, 0)
  assert.equal(metrics.per[0].unmeasured, true)
  const graph = ['#doneCount', '#lanes', '#nodes', '#parallel', '#orch']
    .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
  assert.match(graph, /não aferido/)
  assert.doesNotMatch(graph, /115h|76h|192h|115:23|24h/)
  ui.run('FULL_EVENTS = inputEvents; renderResults(STATE)', { inputEvents: events })
  assert.match(ui.nodes.get('#results').innerHTML, /tempo ativo não aferido/)
  assert.doesNotMatch(ui.nodes.get('#results').innerHTML, /115h|76h|192h|115:23|24h/)
  ui.run("POP = { id: 'A', pinned: true }; POP_MODE = 'lean'; fillPop('A')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /não aferido/)
  assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, /115h|76h|192h|115:23|24h/)
})

test('replanning a paused attempt never counts its waiting or research as execution or review', () => {
  const ui = dashboard()
  for (const [state, replanEnd, resumed, reviewAt, expected] of [
    ['done', 60, true, null, { planning: 0, exec: 30, review: 0, blocked: 40 }],
    ['blocked', 60, false, null, { planning: 0, exec: 10, review: 0, blocked: 60 }],
    ['planning', null, false, null, { planning: 0, exec: 10, review: 0, blocked: 20 }],
    ['done', 60, true, 15, { planning: 0, exec: 5, review: 25, blocked: 40 }],
    ['blocked', 60, false, 15, { planning: 0, exec: 5, review: 5, blocked: 60 }],
    ['planning', null, false, 15, { planning: 0, exec: 5, review: 5, blocked: 20 }],
  ]) {
    const attempt = { startedAt: instant(10), ...(state === 'done' ? { endedAt: instant(100) } : {}),
      ...(reviewAt == null ? {} : { reviewStartedAt: instant(reviewAt) }) }
    const reviewReceipt = reviewAt == null ? [] : [{ by: 'review', attempt: 1, ok: true, at: instant(state === 'done' ? 100 : 20) }]
    const paused = task('T', state, { attempts: [attempt], validations: reviewReceipt,
      ...(state === 'blocked' ? { stateBeforeBlock: reviewAt == null ? 'running' : 'reviewing' } : {}),
      planningAttempts: [
        { startedAt: instant(0), endedAt: instant(10) },
        { startedAt: instant(40), ...(replanEnd == null ? {} : { endedAt: instant(replanEnd) }) },
      ], ...(state === 'planning' ? { planningReturn: { stateBeforeBlock: reviewAt == null ? 'running' : 'reviewing' } } : {}),
    })
    const events = [{ type: 'task_block', task: 'T', at: instant(20) }, { type: 'task_planning', task: 'T', at: instant(40) }]
    if (replanEnd != null) events.push({ type: 'task_planned', task: 'T', at: instant(replanEnd), state: 'blocked' })
    if (resumed) {
      events.push({ type: 'task_unblock', task: 'T', attempt: 1, at: instant(80), state: reviewAt == null ? 'running' : 'reviewing' })
      events.push({ type: reviewAt == null ? 'task_progress' : 'task_review_progress', task: 'T', attempt: 1, at: instant(100) })
    }
    if (reviewAt != null) events.push({ type: 'task_review_progress', task: 'T', attempt: 1, at: instant(20) })
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
