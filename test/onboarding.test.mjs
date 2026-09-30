import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGuideDemoFrameController, createPrumoOnboarding } from '../scripts/onboarding.mjs'
import { createGuideDemoData } from '../scripts/dashboard-guide-demo.mjs'

class Node {
  constructor(dataset = {}) {
    this.dataset = dataset; this.hidden = false; this.textContent = ''; this.listeners = new Map(); this.attributes = new Map(); this.classes = new Set(); this.children = new Map(); this.focusCount = 0
    this.classList = { add: key => this.classes.add(key), remove: key => this.classes.delete(key), contains: key => this.classes.has(key), toggle: (key, on) => on ? this.classes.add(key) : this.classes.delete(key) }
  }
  addEventListener(type, callback) { this.listeners.set(type, callback) }
  click() { this.listeners.get('click')?.() }
  setAttribute(key, value) { this.attributes.set(key, value) }
  getAttribute(key) { return this.attributes.get(key) }
  querySelector(key) { return this.children.get(key) ?? null }
  querySelectorAll() { return [] }
  focus() { this.focusCount++ }
  contains(node) { return node === this }
}

function harness({ saved = false, search = '', summary = () => null, launcherBottom = 48 } = {}) {
  const elements = new Map()
  const el = id => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id) }
  const root = el('#onboarding'), launcher = el('#guideButton'), invite = el('#guideInvitation')
  launcher.getBoundingClientRect = () => ({ bottom: launcherBottom })
  invite.style = {}
  const demos = [], stops = []
  const roles = ['orchestrator','planner','executor','reviewer'].map(guideRole => new Node({guideRole}))
  el('#guideMockRoles').querySelectorAll = () => roles
  root.querySelector = key => el(key)
  const storage = new Map(saved ? [['prumoOnboardingDismissed','true']] : [])
  const document = { documentElement: { classList: new Node().classList }, fullscreenElement: null, listeners: new Map(),
    querySelector: key => el(key), addEventListener(type, fn) { this.listeners.set(type, fn) },
    exitFullscreen() { this.fullscreenElement = null; this.listeners.get('fullscreenchange')?.() } }
  root.requestFullscreen = () => { document.fullscreenElement = root; document.listeners.get('fullscreenchange')?.(); return Promise.resolve() }
  const frames = new Map()
  let frameId = 0
  const window = { listeners: new Map(), addEventListener(type, listener) { this.listeners.set(type, listener) }, location: { search }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id }, cancelAnimationFrame(id) { frames.delete(id) } }
  const flushFrame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()) }
  root.hidden = true; invite.hidden = true
  const api = createPrumoOnboarding({ root, launcher, document, window, translate: (value,...args) => value.replace(/\{(\d+)\}/g, (_,index) => args[Number(index)] ?? ''), showDemo: (mode,target) => demos.push({mode,target}), stopDemos: options => stops.push(options) })
  return { api, el, root, launcher, invite, roles, demos, stops, storage, document, window, flushFrame }
}

test('primeira visita convida, clique abre em tela cheia e dispensa persiste sem abrir', async () => {
  const ui = harness()
  assert.equal(ui.root.hidden, true)
  assert.equal(ui.invite.hidden, false)
  assert.equal(ui.document.fullscreenElement, null)
  ui.el('#guideInvitationOpen').click()
  assert.equal(ui.root.hidden, false)
  assert.equal(ui.invite.hidden, true)
  assert.equal(ui.document.fullscreenElement, ui.root)
  assert.equal(ui.el('#guideNext').focusCount, 1)
  ui.el('#guideSkip').click()
  assert.equal(ui.root.hidden, true)
  assert.equal(ui.storage.get('prumoOnboardingDismissed'), 'true')
  const dismissed = harness({ saved: true })
  assert.equal(dismissed.invite.hidden, true)
  dismissed.launcher.click()
  assert.equal(dismissed.root.hidden, false)
  const skipped = harness()
  skipped.el('#guideInvitationDismiss').click()
  assert.equal(skipped.storage.get('prumoOnboardingDismissed'), 'true')
  assert.equal(skipped.root.hidden, true)
})

test('URL de primeira visita força apenas convite, sem remover preferência ou dados', () => {
  const ui = harness({ saved: true, search: '?onboarding=first-run' })
  ui.storage.set('prumoPlanData', 'preservado')
  assert.equal(ui.invite.hidden, false)
  assert.equal(ui.root.hidden, true)
  assert.equal(ui.storage.get('prumoOnboardingDismissed'), 'true')
  assert.equal(ui.storage.get('prumoPlanData'), 'preservado')
})

test('convite fica abaixo do botao Guia e acompanha a mudanca de largura', () => {
  const ui = harness({ launcherBottom: 142 })
  assert.equal(ui.invite.style.top, '154px')
  ui.launcher.getBoundingClientRect = () => ({ bottom: 212 })
  ui.window.listeners.get('resize')()
  assert.equal(ui.invite.style.top, '224px')
})

test('cinco frentes mostram apenas a superficie correspondente e controles minusculos', () => {
  const ui = harness()
  ui.launcher.click()
  assert.match(ui.el('#guideCount').textContent, /Step 1 of 5/)
  assert.equal(ui.el('#guideStepTitle').textContent, 'Overview')
  assert.equal(ui.el('#guideIntroPanel').hidden, false)
  assert.equal(ui.el('#guideExamplePanel').hidden, true)
  assert.equal(ui.el('#guideGainPanel').hidden, true)
  assert.equal(ui.el('#guidePrevious').textContent, 'back')
  assert.equal(ui.el('#guideNext').textContent, 'next')
  ui.el('#guideNext').click()
  assert.equal(ui.el('#guideStepTitle').textContent, 'Entities')
  assert.equal(ui.el('#guideMockRoles').hidden, false)
  assert.equal(ui.el('#guideExamplePanel').hidden, true)
  ui.roles[2].click()
  assert.equal(ui.el('#guideTitle').textContent, 'The executor')
  ui.el('#guideNext').click(); ui.el('#guideNext').click()
  ui.flushFrame()
  assert.match(ui.el('#guideCount').textContent, /Step 3 of 5/)
  assert.equal(ui.el('#guideStepTitle').textContent, 'Dashboard')
  assert.equal(ui.el('#guideMockRoles').hidden, true)
  assert.equal(ui.el('#guideExamplePanel').hidden, false)
  assert.deepEqual(ui.demos.at(-1), {mode:'board',target:'board'})
  for(let i=0;i<4;i++) ui.el('#guideNext').click()
  ui.flushFrame()
  assert.match(ui.el('#guideCount').textContent, /Step 4 of 5/)
  assert.equal(ui.el('#guideStepTitle').textContent, 'Results')
  assert.equal(ui.el('#guideExamplePanel').hidden, true)
  assert.equal(ui.el('#guideGainPanel').hidden, false)
  assert.deepEqual(ui.demos.at(-1), {mode:'results',target:'gain'})
  for(let i=0;i<3;i++) ui.el('#guideNext').click()
  assert.match(ui.el('#guideCount').textContent, /Step 5 of 5/)
  assert.equal(ui.el('#guideStepTitle').textContent, 'How to use')
  assert.equal(ui.el('#guideCommandPanel').hidden, false)
  assert.equal(ui.el('#guideGainPanel').hidden, true)
  assert.equal(ui.el('#guideNext').textContent, 'finish guide')
  ui.el('#guidePrevious').click()
  assert.equal(ui.el('#guideNext').textContent, 'next')
  ui.flushFrame()
  assert.deepEqual(ui.demos.at(-1), {mode:'results',target:'commands'})
  ui.el('#guideSkip').click()
  assert.equal(ui.root.hidden,true)
  assert.ok(ui.stops.length)
})

test('navegacao rapida aplica apenas o ultimo destino e cancela ao fechar', () => {
  const ui = harness()
  ui.launcher.click()
  for (let i = 0; i < 5; i++) ui.el('#guideNext').click()
  assert.equal(ui.demos.length, 0)
  ui.flushFrame()
  assert.deepEqual(ui.demos, [{ mode: 'board', target: 'board' }])
  ui.el('#guideNext').click()
  ui.el('#guideNext').click()
  ui.el('#guidePrevious').click()
  assert.equal(ui.el('#guideNext').textContent, 'next')
  ui.flushFrame()
  assert.deepEqual(ui.demos.at(-1), { mode: 'board', target: 'filters' })
  ui.el('#guideNext').click()
  ui.el('#guideSkip').click()
  ui.flushFrame()
  assert.equal(ui.demos.length, 2)
  assert.deepEqual(ui.stops.at(-1), { dispose: true })
})

test('quadros reutilizam a pagina carregada, focam o destino final e ignoram load apos fechar', () => {
  const makeFrame = () => ({ dataset: {}, src: '', onload: null, removed: 0,
    removeAttribute(name) { if (name === 'src') { this.src = ''; this.removed++ } },
    contentWindow: { prumoGuideDemo: { focus(target) { this.calls.push(target) }, calls: [] } } })
  const frames = { board: makeFrame(), results: makeFrame() }
  const states = []
  const controller = createGuideDemoFrameController(frames, (mode, state) => states.push([mode, state]))
  controller.show('board', 'board')
  controller.show('board', 'filters')
  assert.equal(frames.board.src, '?guide-demo=board')
  assert.deepEqual(states.at(-1), ['board', 'loading'])
  frames.board.onload()
  assert.deepEqual(frames.board.contentWindow.prumoGuideDemo.calls, ['filters'])
  controller.show('results', 'gain')
  controller.show('board', 'card')
  assert.deepEqual(frames.board.contentWindow.prumoGuideDemo.calls, ['filters', 'card'])
  assert.equal(frames.board.removed, 0)
  assert.equal(frames.results.src, '?guide-demo=results')
  const lateLoad = frames.results.onload
  controller.stop({ dispose: true })
  lateLoad()
  assert.equal(frames.results.contentWindow.prumoGuideDemo.calls.length, 0)
  assert.equal(frames.board.src, '')
  assert.equal(frames.results.src, '')
  assert.deepEqual(states.at(-1), ['results', 'idle'])
})

test('dados ficticios independem do plano real e nao compartilham estado entre aberturas', () => {
  const board = createGuideDemoData('board'), results = createGuideDemoData('results')
  assert.equal(Object.values(board.tasks).filter(t=>t.state==='skipped').length,1)
  assert.ok(Object.values(results.tasks).every(t=>t.state==='done'))
  assert.ok(Object.values(results.tasks).every(t=>t.attempts[0].activityIntervals.every(i=>i.startedAt && i.endedAt)))
  board.tasks.T1.state='failed'
  assert.equal(createGuideDemoData('board').tasks.T1.state,'done')
  assert.equal(results.tasks.T1.state,'done')
})

test('guia reutiliza as interfaces reais em vez de copias de cards e tem quatro ambientes', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url),'utf8')
  const section = html.match(/<section id="onboarding"[\s\S]*?<\/section>\s*(?=<div id="results")/)?.[0]
  assert.ok(section)
  assert.equal((section.match(/data-guide-role=/g)??[]).length,4)
  assert.equal((section.match(/class="ric"/g)??[]).length,4)
  for (const id of ['orchNode', 'planNode', 'execNode', 'revNode']) {
    const svg = html.match(new RegExp('<div id="' + id + '"[^>]*>(<svg[\\s\\S]*?</svg>)'))?.[1]
    assert.ok(svg && section.includes(svg), `o guia conserva o SVG real de ${id}`)
  }
  assert.match(section,/id="guideBoardFrame"/)
  assert.match(section,/id="guideResultsFrame"/)
  assert.doesNotMatch(section,/guide-mock-card|Exemplo ilustrativo|no prumo|Legend/)
  for(const name of ['Claude Code','Codex','Kiro','DSH']) assert.match(section,new RegExp('<h3>'+name+'</h3>'))
  assert.match(section,/id="guideStepTitle"/)
  assert.ok(section.indexOf('id="guideStepTitle"') < section.indexOf('id="guideCount"'))
  assert.match(section,/id="guideSkip"[^>]*data-i18n="Exit guide"/)
  assert.match(section,/id="guidePrevious"[^>]*>back<\/button>/)
  assert.match(section,/id="guideNext"[^>]*>next<\/button>/)
  assert.doesNotMatch(section,/id="guide(?:Previous|Next)"[^>]*data-i18n=/)
  assert.match(html,/if \(GUIDE_DEMO\) \{[\s\S]*STATE = createGuideDemoData/)
  assert.match(html,/else \{\s*tick\(\)\s*loadIdentity\(\)/)
})
