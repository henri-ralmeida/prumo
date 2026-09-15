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
}

function dashboard(lang = 'en', width = 1000, session = new Map(), navigation = { state: null, urls: [] }) {
  const nodes = new Map(), cards = [], paths = []
  const windowListeners = new Map()
  let viewportWidth = width, viewportHeight = 700, animationFrame = null
  const element = (initialClasses = []) => {
    const classes = new Set(initialClasses)
    const attributes = new Map()
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
      addEventListener() {},
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
      addEventListener() {},
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
    assert.deepEqual([...values], ['#3b82f6', '#f472b6', '#2dd4bf'])
    assert.match(ui.nodes.get('#parallel').innerHTML, /class="plan"[^>]*openTask\('A'\)[\s\S]*@planner-1/)
    assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML, /openTask\('[PEWDFBS]'\)/)
    assert.match(ui.nodes.get('#planSub').textContent, /1: A/)
    assert.match(ui.nodes.get('#edgePaths').innerHTML, /class="e-planning" data-from="__plan" data-to="A"/)
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
      A: { effective: 'waiting', blockedBy: ['C'], planningStatus: 'planned', inputStatus: 'unresolved_later_phase_input' },
      B: { effective: 'ready', blockedBy: [], planningStatus: 'planned' },
      C: { effective: 'ready_to_plan', blockedBy: [], planningStatus: 'phase_planning' },
    } }
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang); ui.render(state)
    assert.match(ui.nodes.get('#orchSub').textContent, lang === 'en' ? /phase discussion F1: 2 tasks/ : /discussão da fase F1: 2 tarefas/)
    assert.match(ui.nodes.get('#planSub').textContent, lang === 'en' ? /phase planning F2: 1 tasks/ : /planejamento da fase F2: 1 tarefas/)
    assert.match(ui.nodes.get('#lanes').innerHTML, lang === 'en' ? /discussion · orchestrator/ : /discussão · orquestrador/)
    assert.match(ui.nodes.get('#lanes').innerHTML, lang === 'en' ? /planning · planner/ : /planejamento · planejador/)
    assert.match(ui.nodes.get('#nodes').innerHTML, lang === 'en' ? /unresolved later-phase input/ : /entrada de fase posterior não resolvida/)
    assert.match(ui.nodes.get('#nodes').innerHTML, /data-st="waiting"[^>]*data-id="A"/, 'primary state remains DAG-driven')
    assert.match(ui.nodes.get('#edgePaths').innerHTML, /e-discussion[^>]*data-to="A"/)
    assert.match(ui.nodes.get('#edgePaths').innerHTML, /e-planning[^>]*data-to="C"/)
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

test('height-only resize keeps the entire board inside the viewport', () => {
  const ui = dashboard('en', 1000)
  ui.render(graphState(48, 8))
  ui.resize(1000, 350)
  assert.ok(ui.run('CANVAS_H * VIEW.k') <= 294)
  assert.ok(ui.run('VIEW.y') >= 0)
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

test('status filters use effective state and add only direct dependency context', () => {
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
  const ids = (filter, deps = false) => ui.run("JSON.stringify([...filterSets(STATE.tasks, inputFilter, inputDeps).allowed].sort())",
    { inputFilter: filter, inputDeps: deps })
  const card = (id) => ui.cards.find((node) => node.dataset.id === id)
  const edge = (from, to) => ui.paths.find((path) => path.dataset.from === from && path.dataset.to === to)
  const hidden = (from, to) => !edge(from, to) || edge(from, to).classList.contains('filter-hidden')
  const expected = {
    done: ['A'], incomplete: ['B', 'C', 'D', 'E', 'F', 'K', 'L', 'P', 'R', 'U'], waiting: ['C'],
    ready_to_plan: ['P'], planning: ['L'], ready: ['E'], running: ['B'], reviewing: ['R'],
    blocked: ['K'], failed: ['F'], skipped: ['S'],
  }
  assert.equal(ids('all'), JSON.stringify(Object.keys(tasks).sort()))
  for (const [filter, matches] of Object.entries(expected)) assert.equal(ids(filter), JSON.stringify(matches), filter)
  assert.equal(ids('running', true), JSON.stringify(['A', 'B', 'C']))
  assert.equal(ui.run("JSON.stringify([...filterSets(STATE.tasks, 'missing', false).matches])"), '[]')

  assert.equal(ui.cards.length, Object.keys(tasks).length)
  for (const endpoints of [['A', 'B'], ['B', 'C'], ['C', 'D'], ['__orch', 'B'], ['__plan', 'L'], ['R', '__rev']])
    assert.ok(edge(...endpoints), endpoints.join(' → '))
  const originalState = JSON.stringify(state)

  ui.run("setFilter('running')")
  assert.equal(card('B').classList.contains('filtered-out'), false)
  assert.equal(card('A'), undefined)
  assert.equal(ui.nodes.get('#depsBtn').textContent, 'dependencies off')
  assert.equal(ui.nodes.get('#depsBtn').getAttribute('aria-pressed'), 'false')
  assert.equal(ui.nodes.get('#filterCount').textContent, 'filter results 1/12')
  assert.equal(hidden('A', 'B'), true)
  assert.equal(hidden('__orch', 'B'), false)
  assert.equal(hidden('__plan', 'L'), true)
  assert.equal(hidden('R', '__rev'), true)

  ui.run("openTask('B'); setFilter('reviewing')")
  assert.equal(ui.run('POP === null'), true)
  assert.equal(ui.nodes.get('#pop').classList.contains('open'), false)

  ui.run("setFilter('running'); toggleDependencies()")
  assert.equal(ui.nodes.get('#depsBtn').textContent, 'dependencies on')
  assert.equal(ui.nodes.get('#depsBtn').getAttribute('aria-pressed'), 'true')
  for (const id of ['A', 'B', 'C']) assert.equal(card(id).classList.contains('filtered-out'), false, id)
  assert.equal(card('D'), undefined)
  assert.equal(hidden('A', 'B'), false)
  assert.equal(hidden('B', 'C'), false)
  assert.equal(hidden('C', 'D'), true)
  assert.equal(JSON.stringify(state), originalState, 'filtering must not rewrite any task or dependency')

  ui.run("FOCUS = 'B'; applyFocus()")
  assert.deepEqual(ui.cards.filter((node) => node.classList.contains('lit')).map((node) => node.dataset.id).sort(), ['A', 'B', 'C'])
  assert.equal(card('B').classList.contains('lit-self'), true)
  assert.equal(edge('A', 'B').classList.contains('lit'), true)
  assert.equal(edge('B', 'C').classList.contains('lit'), true)
  assert.equal(edge('C', 'D'), undefined)

  ui.run("setFilter('planning')")
  assert.equal(hidden('__plan', 'L'), false)
  assert.equal(hidden('__orch', 'B'), true)
  ui.run("setFilter('reviewing')")
  assert.equal(hidden('R', '__rev'), false)
  assert.equal(hidden('__plan', 'L'), true)
  ui.run("openTask('R')")
  const completed = structuredClone(state)
  completed.tasks.R.status = 'done'
  completed.derived.R.effective = 'done'
  ui.render(completed)
  assert.equal(ui.run('POP'), null, 'live status changes close details when the card leaves the filter')
  assert.equal(card('R'), undefined)
})

test('filter controls expose every state and localize labels and dependency toggle', () => {
  const options = [...html.matchAll(/<option value="([^"]+)"/g)].map(([, value]) => value)
  assert.deepEqual(options, ['all', 'done', 'incomplete', 'waiting', 'ready_for_discussion', 'discussing', 'ready_to_plan', 'planning', 'ready', 'running', 'reviewing', 'blocked', 'failed', 'skipped'])
  for (const [lang, labels] of [['en', ['all tasks', 'incomplete', 'ignored']], ['pt-BR', ['todas', 'incompletas', 'ignoradas']]]) {
    const ui = dashboard(lang)
    ui.render({ run: 'empty-filter', plan: { phases: [] }, tasks: {}, derived: {} })
    for (const label of labels) assert.ok(ui.labels.some((node) => node.textContent === label), `${lang}: ${label}`)
    assert.equal(ui.nodes.get('#depsBtn').textContent, lang === 'en' ? 'dependencies off' : 'dependências desligadas')
    assert.equal(ui.nodes.get('#filterCount').textContent, lang === 'en' ? 'filter results 0/0' : 'resultado do filtro 0/0')
  }
})

test('filters compact matching tasks from distant phases and restore the full graph', () => {
  const ui = dashboard('pt-BR')
  const tasks = { A: task('A', 'pending', { phase: 'F0' }), B: task('B', 'pending', { phase: 'F1', deps: ['A'] }),
    C: task('C', 'pending', { phase: 'F7' }) }
  const state = { run: 'phase-filter', plan: { phases: Array.from({ length: 8 }, (_, i) => ({ id: `F${i}`, title: `Phase ${i}` })) }, tasks,
    derived: { A: { effective: 'ready_for_discussion' }, B: { effective: 'waiting', blockedBy: ['A'] }, C: { effective: 'ready_for_discussion' } } }
  ui.render(state)
  const fullHeight = ui.run('CANVAS_H')
  ui.run("setFilter('ready_for_discussion')")
  assert.deepEqual(ui.cards.map(card => card.dataset.id), ['A', 'C'])
  assert.match(ui.nodes.get('#lanes').innerHTML, /F0/)
  assert.match(ui.nodes.get('#lanes').innerHTML, /F7/)
  assert.doesNotMatch(ui.nodes.get('#lanes').innerHTML, /F1|F6/)
  assert.ok(ui.run('CANVAS_H') < fullHeight)
  ui.run("setFilter('waiting')")
  assert.deepEqual(ui.cards.map(card => card.dataset.id), ['B'])
  ui.run("setFilter('done')")
  assert.equal(ui.cards.length, 0)
  assert.equal(ui.nodes.get('#lanes').innerHTML, '')
  ui.run("setFilter('all')")
  assert.deepEqual(ui.cards.map(card => card.dataset.id), ['A', 'B', 'C'])
})

test('opening and closing the legend preserves fit, actual and manual zoom', () => {
  for (const setup of ['', 'toggleFitView()', 'zoomAt(100, 100, 1.4)']) {
    const ui = dashboard('en', 1000)
    ui.render(graphState(30))
    if (setup) ui.run(setup)
    const before = ui.run('JSON.stringify({ view: VIEW, mode: VIEW_MODE })')
    ui.run('toggleSidebar()')
    ui.flushFrame(1330)
    assert.equal(ui.run('JSON.stringify({ view: VIEW, mode: VIEW_MODE })'), before)
    ui.run('toggleSidebar()')
    ui.flushFrame(1000)
    assert.equal(ui.run('JSON.stringify({ view: VIEW, mode: VIEW_MODE })'), before)
  }
})

test('responsive layout selects density and sizes phase lanes from their cards', () => {
  for (const [count, expected] of [[6, 'detailed'], [24, 'detailed'], [25, 'compact'], [48, 'compact'], [100, 'compact'], [101, 'dense'], [206, 'dense']]) {
    const ui = dashboard('en', 960)
    const state = graphState(count)
    const result = JSON.parse(ui.run("STATE = input; JSON.stringify(layout(STATE.tasks, 'phase'))", { input: state }))
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

  for (const mode of ['phase', 'depth']) {
    const ui = dashboard('en', 700)
    const state = graphState(48, mode === 'phase' ? 4 : 1)
    const result = JSON.parse(ui.run('STATE = input; JSON.stringify(layout(STATE.tasks, inputMode))', { input: state, inputMode: mode }))
    assert.ok(new Set(Object.values(result.pos).map(({ y }) => y)).size > 1, `${mode} wraps vertically`)
  }

  const tallState = graphState(28, 23)
  const tallTasks = Object.values(tallState.tasks)
  tallTasks.slice(0, 6).forEach(task => { task.phase = 'P1' })
  tallTasks.slice(6).forEach((task, index) => { task.phase = `P${index + 2}` })
  const tallUi = dashboard('en', 1000)
  const tallLayout = JSON.parse(tallUi.run("STATE = input; JSON.stringify(layout(STATE.tasks, 'phase'))", { input: tallState }))
  assert.equal(tallLayout.capacity, 6, 'many phases must not force a six-card phase into one column')
  assert.equal(new Set(tallTasks.slice(0, 6).map(task => tallLayout.pos[task.id].y)).size, 1)

  const state = graphState(206)
  const wide = dashboard('en', 1200)
  const narrow = dashboard('en', 700)
  const wideLayout = JSON.parse(wide.run("STATE = input; JSON.stringify(layout(STATE.tasks, 'phase'))", { input: state }))
  const narrowLayout = JSON.parse(narrow.run("STATE = input; JSON.stringify(layout(STATE.tasks, 'phase'))", { input: state }))
  assert.ok(wideLayout.capacity >= narrowLayout.capacity)
  assert.ok(wideLayout.w >= narrowLayout.w)
  assert.ok(narrowLayout.lanes.every((lane, i, lanes) => i === 0 || lanes[i - 1].y + lanes[i - 1].height < lane.y))
})

test('resize relayout preserves state and refits the board to the live viewport', () => {
  const ui = dashboard('en', 1200)
  const state = graphState(48)
  ui.render(state)
  ui.run("setFilter('running'); toggleDependencies(); openTask('T013'); FOCUS = 'T013'; SELECTED_RUN = 'fixture-48'; Object.assign(VIEW, { x: 91, y: -37, k: .8 })")
  assert.equal(ui.run('FILTER'), 'all', 'opening a filtered-out task reveals its card and popover anchor')
  const before = JSON.parse(ui.run("JSON.stringify({ filter: FILTER, deps: SHOW_DEPS, pop: POP, focus: FOCUS, selected: SELECTED_RUN, layout: LAYOUT, fitted, view: VIEW, h: CANVAS_H, pos: LAST_POS })"))
  const beforeAnchor = JSON.parse(ui.run("JSON.stringify(document.querySelector('.node[data-id=\\\"T013\\\"]')?.getBoundingClientRect())"))
  ui.resize(700)
  const after = JSON.parse(ui.run("JSON.stringify({ filter: FILTER, deps: SHOW_DEPS, pop: POP, focus: FOCUS, selected: SELECTED_RUN, layout: LAYOUT, fitted, view: VIEW, w: CANVAS_W, h: CANVAS_H, metrics: LAST_METRICS, pos: LAST_POS })"))
  assert.equal(after.filter, before.filter)
  assert.equal(after.deps, before.deps)
  assert.deepEqual(after.pop, before.pop)
  assert.equal(after.focus, before.focus)
  assert.equal(after.selected, before.selected)
  assert.equal(after.layout, before.layout)
  assert.equal(after.fitted, before.fitted)
  assert.notDeepEqual(after.view, before.view)
  assert.ok(after.w * after.view.k <= 644)
  assert.ok(after.h * after.view.k <= 644)
  assert.ok(after.metrics.nodeW * after.view.k >= 72)
  const afterAnchor = JSON.parse(ui.run("JSON.stringify(document.querySelector('.node[data-id=\\\"T013\\\"]')?.getBoundingClientRect())"))
  const popPosition = JSON.parse(ui.run("JSON.stringify({ left: parseFloat($('#pop').style.left), top: parseFloat($('#pop').style.top) })"))
  assert.deepEqual(popPosition, { left: afterAnchor.right + 14, top: afterAnchor.top - 6 })
  assert.ok(beforeAnchor)
})

test('phase boards expand for their cards and open with the complete graph visible', () => {
  const ui = dashboard('en', 1000)
  ui.render(graphState(48, 8))
  const initial = JSON.parse(ui.run('JSON.stringify({ view: VIEW, width: CANVAS_W, height: CANVAS_H, metrics: LAST_METRICS, pos: LAST_POS })'))
  assert.ok(initial.height > 644)
  assert.ok(initial.metrics.nodeW >= 120)
  assert.ok(initial.metrics.nodeW < 202)
  assert.equal(Math.max(...Object.values(initial.pos).map(point => point.x)) + initial.metrics.nodeW, initial.width - 40)
  assert.ok(initial.view.k < 0.944)
  assert.ok(initial.width * initial.view.k <= 944)
  assert.ok(initial.height * initial.view.k <= 644)
  assert.ok(initial.view.x >= 28)
  assert.ok(initial.view.y >= 28)
  assert.equal(ui.run("$('#fitBtn').textContent"), '100%')
  ui.run('toggleFitView()')
  const actual = JSON.parse(ui.run("JSON.stringify({ view: VIEW, mode: VIEW_MODE, label: $('#fitBtn').textContent })"))
  assert.equal(actual.view.k, 1)
  assert.equal(actual.mode, 'actual')
  assert.equal(actual.label, 'fit')
  ui.run('toggleFitView()')
  const refitted = JSON.parse(ui.run("JSON.stringify({ view: VIEW, mode: VIEW_MODE, label: $('#fitBtn').textContent })"))
  assert.equal(refitted.mode, 'fit')
  assert.equal(refitted.label, '100%')
  assert.deepEqual(refitted.view, initial.view)

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
  assert.ok(wideView.metrics.nodeW * wideView.view.k >= 72, 'fitted cards should stay legible')
})

test('legend follows the workflow and colored role counters and events show actual progress', () => {
  const legend = html.match(/<div class="legend">([\s\S]*?)<\/div>/)[1]
  const order = [...legend.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(order.slice(0, 11), ['waiting for dependencies', 'ready for discussion', 'discussion · orchestrator', 'ready for planning', 'planning · planner',
    'ready for execution', 'execution · executor', 'review · reviewer', '✓ = validated, awaiting done', 'done', 'failed'])
  assert.equal((legend.match(/class="role-dot"/g) ?? []).length, 4)
  assert.ok(order.includes('skipped'))
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    const events = [
      { type: 'task_start', task: 'T4', at: instant(1), current: 1, total: 4 },
      { type: 'task_progress', task: 'T4', at: instant(2), current: 2, total: 4 },
      { type: 'task_check', task: 'T4', at: instant(3), current: 1, total: 4, status: 'started', kind: 'functional', by: 'review' },
      { type: 'task_check', task: 'T4', at: instant(4), current: 2, total: 4, status: 'failed', kind: 'functional', by: 'review' },
      { type: 'task_start', task: 'OLD', at: instant(0) },
    ]
    ui.render({ run: 'events', plan: {}, tasks: { T4: task('T4') }, derived: { T4: { effective: 'ready' } } }, events)
    const title = ui.nodes.get('#parTitle').innerHTML
    for (const color of ['discussion', 'planning', 'running', 'review']) assert.ok(title.includes(`color:var(--${color})`))
    assert.equal((title.match(/<b>/g) ?? []).length, 4)
    assert.doesNotMatch(title, / · /)
    if (lang === 'pt-BR') assert.ok(ui.labels.some(node => node.textContent === 'discussão · orquestrador'))
    const log = ui.nodes.get('#events').innerHTML
    assert.match(log, /T4 \[1\/4\]/)
    assert.match(log, /T4 \[2\/4\]/)
    assert.doesNotMatch(log, /OLD \[/)
    assert.ok(log.includes(lang === 'en' ? 'Working' : 'Executando'))
    assert.ok(log.includes(lang === 'en' ? 'Review' : 'Revisão'))
  }
})

test('visual polish keeps fixed arrows, full card labels and a controllable responsive sidebar', () => {
  assert.match(html, /markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse"/)
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\*, \*::before, \*::after[\s\S]*animation: none !important/)
  assert.match(html, /\.phase-task-state \{ display: inline;/)
  const sectionOrder = ['data-i18n="Legend"', 'id="parTitle"', 'data-i18n="Selected task"', 'data-i18n="Failures &amp; retries"', 'data-i18n="Event log"']
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

test('discussion uses electric lavender and connects the active orchestrator without motion when reduced', () => {
  assert.match(html, /--discussion:\s*#c084fc/)
  assert.match(html, /path\.e-discussion[\s\S]*stroke:\s*var\(--discussion\)/)
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none !important/)
  const ui = dashboard('pt-BR')
  ui.render({ run: 'discussion', plan: { maxParallel: 4 }, tasks: { T1: task('T1', 'discussing') }, derived: { T1: { effective: 'discussing' } } })
  assert.equal(ui.nodes.get('#orchNode').classList.contains('discussing'), true)
  assert.ok(ui.paths.some(path => path.classList.contains('e-discussion') && path.dataset.to === 'T1'))
  assert.match(ui.nodes.get('#orchSub').textContent, /discutindo 1: T1/)
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
    decisions: [{ question: hostile, answer: hostile }], deferred: [hostile] }
  const ui = dashboard('pt-BR')
  ui.render({ run: 'safe-plan', plan: {}, tasks: { T: task('T', 'pending', { discovery: hostileDiscovery, planner: hostile, taskPlan: recorded }) }, derived: { T: { effective: 'ready' } } })
  ui.run("fillPop('T')")
  const body = ui.nodes.get('#popBody').innerHTML
  assert.doesNotMatch(body, /<img|onerror="/)
  assert.match(body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;&#39;text/)
  for (const text of ['Descoberta da tarefa', 'Pesquisa da descoberta', 'Discussão', 'Cobertura PO First', 'Decisões da descoberta', 'Ideias adiadas',
    'Planejador', 'Plano registrado da tarefa', 'Pesquisa', 'Decisões', 'Passos de execução', 'Verificação', 'Perguntas', 'verificação 1', 'não bloqueante']) assert.ok(body.includes(text), text)
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
