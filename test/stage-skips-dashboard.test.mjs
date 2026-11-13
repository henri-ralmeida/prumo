import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { disableDashboardBoot, extractDashboardScript, injectDashboardLanguage, runDashboardScript } from './fixtures/dashboard-vm.mjs'
import { calculateGain, commandMetricsForRun } from '../scripts/dashboard-gains.mjs'

function dashboard(lang) {
  const source = extractDashboardScript(readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8'))
  const nodes = new Map()
  const element = () => ({ innerHTML: '', textContent: '', dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
    querySelectorAll() { return [] }, querySelector() { return element() },
    getBoundingClientRect() { return { width: 1000, height: 700, left: 0, top: 0 } } })
  const sandbox = { document: { documentElement: element(), querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector)
  }, querySelectorAll() { return [] }, addEventListener() {} },
  location: { search: '', origin: 'http://localhost', href: 'http://localhost/' },
  history: { state: null, replaceState() {} }, localStorage: { getItem() { return null }, setItem() {} },
  sessionStorage: { getItem() { return null }, setItem() {} }, URL, URLSearchParams, innerWidth: 1330, innerHeight: 800,
  performance: { now() { return 0 } }, CSS: { escape: text => text }, addEventListener() {}, requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {} }
  sandbox.window = sandbox
  return { nodes, ui: runDashboardScript(disableDashboardBoot(injectDashboardLanguage(source, lang)), sandbox, { sourceScript: source }) }
}

for (const lang of ['en', 'pt-BR']) test(`card e detalhes distinguem decisão do usuário de validação e escapam o motivo em ${lang}`, () => {
  const { ui, nodes } = dashboard(lang)
  const choice = { decisionId: 'choice', stages: ['discussion', 'planning', 'execution', 'review'], reason: '<img src=x onerror=alert(1)>', at: '2026-01-01T00:00:00Z' }
  const task = { id: 'T1', title: 'Entrega aceita pelo usuário', state: 'done', phase: null, deps: [], tags: [], touches: [],
    attempts: [], validations: [], notes: [], stageSkips: [choice], completionDecision: { by: 'user', stages: choice.stages, reason: choice.reason } }
  const state = { run: 'choices', plan: { name: 'Escolhas', phases: [] }, tasks: { T1: task }, derived: { T1: { effective: 'done', currentStageSkips: [choice], blockedBy: [] } } }
  ui.run('STATE = input; render(STATE, []); fillPop("T1")', { input: state })
  assert.match(nodes.get('#nodes').innerHTML, lang === 'en' ? /DONE · USER CHOICE/ : /NO PRUMO · DECISÃO SUA/)
  const history = ui.run('stageSkipHistory(STATE.tasks.T1)')
  assert.match(history, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(history, /<img/)
  assert.match(history, lang === 'en' ? /do not prove implementation or validation/ : /não comprovam implementação nem validação/)
  assert.match(ui.run('eventSentence({type:"task_done",task:"T1",completionBy:"user"})'), lang === 'en' ? /User completed/ : /O usuário concluiu/)
  assert.match(ui.run('eventSentence({type:"task_stages_skipped",task:"T1",stages:["execution"]})'), lang === 'en' ? /User dispensed/ : /O usuário dispensou/)
  assert.equal(ui.run('stageSkipHistory({stageSkips: "invalid"})'), '')
  assert.equal(ui.run('stageSkipHistory({stageSkips: [null, {}]})'), '')
  task.state = 'reviewing'; task.completionDecision = undefined
  task.attempts = [{ n: 1, kind: 'review-only', agent: null, reviewer: 'reviewer', startedAt: '2026-01-01T00:00:00Z', reviewStartedAt: '2026-01-01T00:00:00Z' }]
  state.derived.T1.effective = 'reviewing'
  ui.run('STATE = input; fillPop("T1")', { input: state })
  assert.match([...nodes.values()].map(node => node.innerHTML).join(''), lang === 'en' ? /Review only/ : /somente revisão/)
  task.state = 'pending'; task.attempts = []
  state.derived.T1.effective = 'ready_for_review'; state.derived.T1.inputStatus = 'user_accepted_input'
  state.derived.T1.currentStageSkips = [{ ...choice, stages: ['execution'] }]
  ui.run('STATE = input; renderAvailable()', { input: state })
  assert.match(nodes.get('#available').innerHTML, lang === 'en' ? /execution dispensed/ : /execução dispensada/)
  assert.match(ui.run('phaseTaskLabel(STATE.tasks.T1)'), lang === 'en' ? /input accepted by user/ : /entrada aceita pelo usuário/)
  task.completionDecision = undefined; state.derived.T1.currentStageSkips = []
  ui.run('STATE = input', { input: state })
  assert.equal(ui.run('taskStageSkipSummary(STATE.tasks.T1)'), '')
})

test('dispensa não inventa despacho de execução nem estimativa de trabalho entregue', () => {
  const tasks = { T1: { state: 'done', manualEstimate: 60, attempts: [{ kind: 'review-only', reviewStartedAt: '2026-01-01' }], completionDecision: { by: 'user' } } }
  const commands = commandMetricsForRun(tasks)
  assert.equal(commands.byCommand.start, undefined)
  assert.equal(commands.byCommand.review, 1)
  const gain = calculateGain({ per: [] }, tasks, true)
  assert.equal(gain.countedTasks, 0)
  assert.equal(gain.humanEstimateMs, null)
  const events = [{ type: 'task_done', completionBy: 'user' }, { type: 'task_stages_skipped' }]
  assert.deepEqual({ ...commandMetricsForRun({}, { events }).byCommand }, { 'skip-stages': 1 })
})
