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

function dashboard(lang = 'en') {
  const nodes = new Map()
  const element = () => ({
    innerHTML: '', textContent: '', dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, setAttribute() {},
    getBoundingClientRect: () => ({ width: 1000, height: 700 }),
  })
  const labels = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(([, key]) => ({ ...element(), dataset: { i18n: key.replaceAll('&amp;', '&') } }))
  const context = createContext({
    document: {
      documentElement: element(),
      querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector) },
      querySelectorAll: (selector) => selector === '[data-i18n]' ? labels : [],
      addEventListener() {},
    },
    location: { search: '', origin: 'http://localhost', href: 'http://localhost/' },
    localStorage: { getItem: () => null }, URL, URLSearchParams,
    performance: { now: () => 0 }, CSS: { escape: (text) => text }, addEventListener() {},
    setTimeout() {}, clearTimeout() {},
    Date: class extends Date { static now() { return Date.parse(instant(100)) } },
  })
  // Run the shipped script, excluding its network polling boot; render/localize stay real.
  const script = localizeDashboard(html, lang).match(/<script>([\s\S]*?)<\/script>/)[1]
  runInContext(script.replace(/localize\(\)\s*tick\(\)\s*$/, ''), context)
  return {
    nodes, labels,
    run(code, values = {}) { Object.assign(context, values); return runInContext(code, context) },
    render(state, events = []) { this.run('STATE = input; render(STATE, inputEvents)', { input: state, inputEvents: events }) },
  }
}

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

test('legend follows the workflow and colored role counters and events show actual progress', () => {
  const legend = html.match(/<div class="legend">([\s\S]*?)<\/div>/)[1]
  const order = [...legend.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(order.slice(0, 9), ['waiting for dependencies', 'ready for planning', 'discussion · orchestrator', 'planning · planner',
    'ready for execution', 'execution · executor', 'review · reviewer', '✓ = validated, awaiting done', 'done'])
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
    for (const color of ['planning', 'running', 'review']) assert.ok(title.includes(`color:var(--${color})`))
    assert.equal((title.match(/<b>/g) ?? []).length, 3)
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
