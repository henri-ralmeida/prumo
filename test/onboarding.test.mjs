import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPrumoOnboarding } from '../scripts/onboarding.mjs'

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
  const graph = el('#guideExamplePanel'), filters = el('#guideMockFilters')
  const statuses = ['done', 'done', 'done', 'done', 'running', 'running', 'reviewing', 'failed', 'waiting', 'blocked']
  const cards = statuses.map((status, index) => {
    const card = new Node({ guideStatus: status, guideSummary: 'Summary', guideCheck: 'Check', guideNeeds: 'Needs' })
    card.children.set('.id', Object.assign(new Node(), { textContent: `T${index + 1}` }))
    card.children.set('.nt', Object.assign(new Node(), { textContent: 'Task' }))
    card.children.set('.tr', Object.assign(new Node(), { textContent: status }))
    return card
  })
  const buttons = ['all','done','running','reviewing','blocked','failed','waiting'].map(filter => {
    const button = new Node({ guideFilter: filter }); button.children.set('[data-guide-count]', new Node()); return button
  })
  graph.querySelectorAll = selector => selector === '[data-guide-task]' ? cards : []
  filters.querySelectorAll = selector => selector === '[data-guide-filter]' ? buttons : []
  const detail = el('#guideMockDetail')
  for (const id of ['[data-guide-detail-title]','[data-guide-detail-state]','[data-guide-detail-summary]','[data-guide-detail-check]','[data-guide-detail-needs]']) detail.children.set(id, new Node())
  root.querySelector = key => el(key)
  const storage = new Map(saved ? [['prumoOnboardingDismissed','true']] : [])
  const document = { documentElement: { classList: new Node().classList }, fullscreenElement: null, listeners: new Map(),
    querySelector: key => el(key), addEventListener(type, fn) { this.listeners.set(type, fn) },
    exitFullscreen() { this.fullscreenElement = null; this.listeners.get('fullscreenchange')?.() } }
  root.requestFullscreen = () => { document.fullscreenElement = root; document.listeners.get('fullscreenchange')?.(); return Promise.resolve() }
  const window = { listeners: new Map(), addEventListener(type, listener) { this.listeners.set(type, listener) }, location: { search }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } }
  root.hidden = true; invite.hidden = true; detail.hidden = true; el('#guideMockDetailMore').hidden = true
  const api = createPrumoOnboarding({ root, launcher, document, window, getCompletedRunSummary: summary })
  return { api, el, root, launcher, invite, cards, buttons, storage, document, window }
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

test('o mesmo grafo permanece entre passos; filtro, contagem e detalhe usam só o exemplo', () => {
  const ui = harness()
  const graph = ui.el('#guideExamplePanel')
  for (let i = 0; i < 9; i++) ui.el('#guideNext').click()
  assert.equal(ui.el('#guideExamplePanel'), graph)
  const done = ui.buttons.find(button => button.dataset.guideFilter === 'done')
  done.click()
  assert.equal(ui.el('#guideMockShown').textContent, '4')
  assert.equal(ui.cards.filter(card => !card.hidden).length, 4)
  assert.equal(done.getAttribute('aria-pressed'), 'true')
  ui.cards[0].click()
  assert.equal(ui.el('#guideMockDetail').hidden, false)
  assert.equal(ui.el('#guideMockDetail').dataset.st, 'done')
  assert.equal(ui.el('#guideMockDetail').querySelector('[data-guide-detail-title]').textContent, 'T1 — Task')
  assert.equal(ui.el('#guideMockDetailMore').hidden, true)
  ui.el('#guideMockDetailExpand').click()
  assert.equal(ui.el('#guideMockDetailMore').hidden, false)
  assert.equal(ui.el('#guideMockDetailExpand').getAttribute('aria-expanded'), 'true')
  ui.cards[0].click()
  assert.equal(ui.el('#guideMockDetail').hidden, true)
  ui.buttons[0].click()
  assert.equal(ui.el('#guideMockShown').textContent, '10')
})

test('ganho real exige execução e medição completas; texto não é interpretado como HTML', () => {
  let result = { completed: false, measurementComplete: true, text: '12 min' }
  const ui = harness({ summary: () => result })
  ui.api.refreshGains()
  assert.equal(ui.el('#guideGainsLabel').hidden, true)
  assert.doesNotMatch(ui.el('#guideGainsSummary').textContent, /12 min/)
  result = { completed: true, measurementComplete: true, text: '<b>12 min</b>' }
  ui.api.refreshGains()
  assert.equal(ui.el('#guideGainsLabel').hidden, false)
  assert.equal(ui.el('#guideGainsSummary').textContent, '<b>12 min</b>')
})

test('marcação mantém dez cards do dashboard, sem setas ou legenda, e foco visível', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  const section = html.match(/<section id="onboarding"[\s\S]*?<\/section>\s*(?=<div id="results")/)?.[0]
  assert.ok(section)
  assert.equal((section.match(/data-guide-task="T\d+"/g) ?? []).length, 10)
  assert.doesNotMatch(section, /Legend|Legenda|guide-example-arrow|Exemplo ilustrativo|no prumo/)
  assert.match(section, /data-st="blocked"/)
  assert.match(section, /awaiting your decision/)
  assert.match(html, /guide-mock-card\.node \{ position: relative; width: min\(200px, 100%\); height: 64px/)
  assert.match(html, /\.guide-mock-card:focus-visible/)
  assert.match(html, /prefers-reduced-motion: reduce/)
})
