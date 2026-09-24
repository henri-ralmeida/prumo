import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { messages, createTranslator } from '../scripts/i18n.mjs'
import { createPrumoOnboarding } from '../scripts/onboarding.mjs'

class FakeNode {
  constructor({ hidden = false, anchor, parent = null } = {}) {
    this.hidden = hidden
    this.dataset = anchor ? { prumoGuideAnchor: anchor } : {}
    this.attributes = new Map()
    this.listeners = new Map()
    this.classes = new Set()
    this.children = []
    this.textContent = ''
    this.parent = parent
    this.focusCount = 0
    this.disabled = false
    this.style = { setProperty(name, value) { this[name] = value } }
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classes.has(name) : Boolean(force)
        if (enabled) this.classes.add(name)
        else this.classes.delete(name)
        return enabled
      },
    }
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  async click() {
    await Promise.all((this.listeners.get('click') ?? []).map((listener) => listener({ target: this })))
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  focus() { this.focusCount += 1 }
  closest(selector) { return selector === '[hidden]' && this.parent?.hidden ? this.parent : null }
  contains(node) {
    for (let current = node; current; current = current.parent) {
      if (current === this) return true
    }
    return false
  }
  replaceChildren(...children) { this.children = children }
  querySelector(selector) { return selector === 'svg' ? { cloneNode: () => ({ copied: true }) } : null }
}

function createHarness({ lang = 'en', storage = new Map(), storageThrows = false, sidebarCollapsed = false,
  storageGetterThrows = false, hasRun = true, summary = () => null } = {}) {
  const elements = new Map()
  const sidePanel = new FakeNode({ hidden: sidebarCollapsed })
  const guide = new FakeNode({ hidden: true })
  const anchors = [
    new FakeNode({ anchor: 'board' }),
    new FakeNode({ anchor: 'filters' }),
    new FakeNode({ anchor: 'phases' }),
    new FakeNode({ anchor: 'tasks' }),
    new FakeNode({ anchor: 'role-orchestrator' }),
    new FakeNode({ anchor: 'role-planner' }),
    new FakeNode({ anchor: 'role-executor' }),
    new FakeNode({ anchor: 'role-reviewer' }),
    new FakeNode({ anchor: 'example-graph', parent: guide }),
    new FakeNode({ anchor: 'available', parent: sidePanel }),
    new FakeNode({ anchor: 'selected', parent: sidePanel, hidden: true }),
    new FakeNode({ anchor: 'results' }),
    new FakeNode({ anchor: 'legend', parent: sidePanel }),
  ]
  const byAnchor = (name) => anchors.find((node) => node.dataset.prumoGuideAnchor === name) ?? null
  const create = (selector, options) => {
    if (!elements.has(selector)) elements.set(selector, new FakeNode(options))
    return elements.get(selector)
  }
  const childIds = [
    '#guideTitle', '#guideDescription', '#guideCount', '#guideAnnouncement', '#guidePrevious', '#guideNext',
    '#guideSkip', '#guidePresentation', '#guideGainsLabel', '#guideGainsSummary', '#guideOpenLegend',
    '#guideGainPanel', '#guideCommandPanel', '#guideFlowPanel', '#guideRoleCard', '#guideRoleName', '#guideRoleIcon', '#guideExamplePanel',
  ]
  for (const id of childIds) create(id, {
    hidden: ['#guideGainPanel', '#guideCommandPanel', '#guideFlowPanel', '#guideRoleCard', '#guideOpenLegend', '#guideExamplePanel'].includes(id),
    parent: guide,
  })

  guide.querySelector = (selector) => elements.get(selector) ?? null
  const listeners = new Map()
  const document = {
    fullscreenElement: null,
    querySelectorAll: (selector) => selector === '[data-prumo-guide-anchor]' ? anchors : [],
    querySelector(selector) {
      if (selector === '#sidebar') return sidePanel
      if (selector === '#sidebarToggle') return sidebarToggle
      const anchor = selector.match(/^\[data-prumo-guide-anchor="([^"]+)"\]$/)?.[1]
      return anchor ? byAnchor(anchor) : null
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(listener)
    },
    dispatch(type, event) { for (const listener of listeners.get(type) ?? []) listener(event) },
    async exitFullscreen() { this.fullscreenElement = null; this.dispatch('fullscreenchange', {}) },
  }
  const sidebarToggle = new FakeNode()
  sidebarToggle.addEventListener('click', () => { sidePanel.hidden = !sidePanel.hidden })
  const localStorage = storageThrows ? {
    getItem() { throw new Error('Storage disabled') },
    setItem() { throw new Error('Storage disabled') },
  } : {
    getItem(key) { return storage.get(key) ?? null },
    setItem(key, value) { storage.set(key, value) },
  }
  const window = {}
  Object.defineProperty(window, 'localStorage', { get() {
    if (storageGetterThrows) throw new Error('Storage access denied')
    return localStorage
  } })
  const launcher = new FakeNode()
  const translate = createTranslator(messages, lang)
  const runStatus = { available: hasRun }
  const api = createPrumoOnboarding({ root: guide, launcher, document, window, translate,
    getCompletedRunSummary: summary, getRunAvailability: () => runStatus.available })
  guide.requestFullscreen = async () => { document.fullscreenElement = guide; document.dispatch('fullscreenchange', {}) }

  return { api, anchors, document, elements, guide, launcher, runStatus, sidePanel, sidebarToggle, storage, translate }
}

const keyEvent = (key, target = new FakeNode()) => ({ key, target, prevented: false, preventDefault() { this.prevented = true } })

test('o guia tem seis passos, quatro papéis visuais, resultados de rejeição e demonstrações reais do dashboard', async () => {
  const ui = createHarness({ lang: 'pt-BR', sidebarCollapsed: true })
  assert.equal(ui.guide.hidden, false, 'a primeira visita abre o guia')
  assert.equal(ui.elements.get('#guideTitle').textContent, 'O que é o Prumo?')
  assert.equal(ui.elements.get('#guideCount').textContent, 'Passo 1 de 6')
  assert.equal(ui.elements.get('#guideNext').focusCount, 1, 'o foco inicial fica no botão Avançar')

  for (const [role, name, color] of [
    ['role-orchestrator', 'O orquestrador', 'var(--accent)'], ['role-planner', 'O planejador', 'var(--planning)'],
    ['role-executor', 'O executor', 'var(--running)'], ['role-reviewer', 'O revisor', 'var(--review)'],
  ]) {
    await ui.elements.get('#guideNext').click()
    assert.equal(ui.elements.get('#guideTitle').textContent, name)
    assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === role).classList.contains('prumo-guide-target'))
    assert.equal(ui.elements.get('#guideRoleCard').hidden, false)
    assert.equal(ui.elements.get('#guideRoleIcon').children[0].copied, true, 'o ícone vem do nó real do dashboard')
    assert.equal(ui.elements.get('#guideRoleCard').style['--guide-role'], color)
    assert.ok(ui.elements.get('#guideDescription').textContent.length > 0)
  }

  await ui.elements.get('#guideNext').click()
  assert.equal(ui.elements.get('#guideTitle').textContent, 'Da discussão à conclusão')
  assert.equal(ui.elements.get('#guideFlowPanel').hidden, false)
  await ui.elements.get('#guideNext').click()
  assert.equal(ui.elements.get('#guideCount').textContent, 'Passo 4 de 6 — demonstração 1 de 6')
  assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === 'filters').classList.contains('prumo-guide-target'))

  await ui.elements.get('#guideNext').click()
  assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === 'phases').classList.contains('prumo-guide-target'))
  assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === 'tasks').classList.contains('prumo-guide-target'))
  await ui.elements.get('#guideNext').click()
  assert.equal(ui.elements.get('#guideOpenLegend').hidden, false, 'o painel recolhido pode ser aberto no tour')
  const availableCount = ui.elements.get('#guideCount').textContent
  await ui.elements.get('#guideOpenLegend').click()
  assert.equal(ui.elements.get('#guideCount').textContent, availableCount, 'abrir o painel mantém a demonstração atual')
  assert.equal(ui.sidePanel.hidden, false)
  assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === 'available').classList.contains('prumo-guide-target'))
  await ui.elements.get('#guideNext').click()
  assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === 'available').classList.contains('prumo-guide-target'),
    'se o painel de tarefa selecionada estiver oculto, a demonstração aponta para a lista que vira esse painel')
  assert.match(ui.elements.get('#guideDescription').textContent, /Ao clicar/)
  await ui.elements.get('#guideNext').click()
  assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === 'results').classList.contains('prumo-guide-target'))
  await ui.elements.get('#guideNext').click()
  assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === 'legend').classList.contains('prumo-guide-target'))

  await ui.elements.get('#guideNext').click()
  assert.equal(ui.elements.get('#guideTitle').textContent, 'Veja o ganho medido')
  assert.match(ui.elements.get('#guideGainsLabel').textContent, /Exemplo ilustrativo/)
  assert.match(ui.elements.get('#guideGainsSummary').textContent, /75%/)
  await ui.elements.get('#guideNext').click()
  assert.equal(ui.elements.get('#guideCommandPanel').hidden, false)
  assert.equal(ui.elements.get('#guideTitle').textContent, 'Comece aqui')
  await ui.elements.get('#guideNext').click()
  assert.equal(ui.guide.hidden, true)
  assert.equal(ui.storage.get('prumoOnboardingDismissed'), 'true', 'concluir o guia grava a preferência')
})

test('métricas reais só aparecem quando a execução e as medições estão completas', () => {
  let result = { completed: false, measurementComplete: true, text: '12 min poupados' }
  const ui = createHarness({ summary: () => result })
  for (let index = 0; index < 12; index += 1) ui.elements.get('#guideNext').click()
  ui.api.refreshGains()
  assert.match(ui.elements.get('#guideGainsLabel').textContent, /not a measurement/)
  assert.doesNotMatch(ui.elements.get('#guideGainsSummary').textContent, /12 min/)

  result = { completed: true, measurementComplete: false, text: '12 min poupados' }
  ui.api.refreshGains()
  assert.match(ui.elements.get('#guideGainsLabel').textContent, /not a measurement/)
  assert.doesNotMatch(ui.elements.get('#guideGainsSummary').textContent, /12 min/)

  result = { completed: true, measurementComplete: true, text: '<b>12 min poupados</b>' }
  ui.api.refreshGains()
  assert.equal(ui.elements.get('#guideGainsLabel').textContent, 'Measured from a completed run')
  assert.equal(ui.elements.get('#guideGainsSummary').textContent, '<b>12 min poupados</b>', 'o resumo entra como texto, sem interpretar HTML')
})

test('sem execução carregada, a demonstração mostra checkout-v2, T1–T10 e as dependências do design', async () => {
  const ui = createHarness({ lang: 'pt-BR', hasRun: false })
  for (let index = 0; index < 7; index += 1) await ui.elements.get('#guideNext').click()
  assert.equal(ui.elements.get('#guideTitle').textContent, 'Execução de exemplo: checkout-v2')
  assert.equal(ui.elements.get('#guideCount').textContent, 'Passo 4 de 6 — demonstração 2 de 6')
  assert.equal(ui.elements.get('#guideExamplePanel').hidden, false)
  assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === 'example-graph').classList.contains('prumo-guide-target'))
  assert.equal(ui.translate('Illustrative example — not current run data.'), 'Exemplo ilustrativo — não são dados da execução atual.')

  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  for (const task of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10']) assert.match(html, new RegExp(`<b>${task}</b>`))
  for (const [from, to] of [['T1', 'T4'], ['T4', 'T8'], ['T2', 'T5'], ['T5', 'T8'], ['T2', 'T6'], ['T6', 'T9'], ['T3', 'T7'], ['T7', 'T10']]) {
    const edge = new RegExp(`<b>${from}</b>[\\s\\S]*?<span class="guide-example-arrow"[^>]*>→<\\/span>[\\s\\S]*?<b>${to}</b>`)
    assert.match(html, edge)
  }
  assert.match(html, /data-i18n="blocked by T7"/)

  ui.runStatus.available = true
  ui.api.refreshRunAvailability()
  assert.equal(ui.elements.get('#guideExamplePanel').hidden, true)
  assert.equal(ui.elements.get('#guideTitle').textContent, 'Fases, tarefas e dependências')
  assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === 'phases').classList.contains('prumo-guide-target'))
})

test('o guia tolera armazenamento bloqueado, reabre, fecha com Esc e oferece setas e apresentação', async () => {
  const ui = createHarness({ storageThrows: true })
  assert.equal(ui.guide.hidden, false, 'falha de leitura de storage não impede primeira visita')
  await ui.elements.get('#guidePresentation').click()
  assert.equal(ui.guide.classList.contains('presenting'), true)
  assert.equal(ui.elements.get('#guidePresentation').getAttribute('aria-pressed'), 'true')
  await ui.elements.get('#guidePresentation').click()
  assert.equal(ui.guide.classList.contains('presenting'), false)

  const outside = new FakeNode()
  outside.tagName = 'BUTTON'
  const externalRight = keyEvent('ArrowRight', outside)
  ui.document.dispatch('keydown', externalRight)
  assert.equal(externalRight.prevented, false, 'setas com foco fora do guia não navegam porque o guia é não modal')
  assert.equal(ui.elements.get('#guideTitle').textContent, 'What is Prumo?')

  const right = keyEvent('ArrowRight', ui.elements.get('#guideNext'))
  ui.document.dispatch('keydown', right)
  assert.equal(right.prevented, true)
  assert.equal(ui.elements.get('#guideTitle').textContent, 'The orchestrator')
  const input = new FakeNode({ parent: ui.guide })
  input.tagName = 'INPUT'
  const ignored = keyEvent('ArrowRight', input)
  ui.document.dispatch('keydown', ignored)
  assert.equal(ignored.prevented, false, 'setas dentro de campos continuam disponíveis ao campo')
  const externalLeft = keyEvent('ArrowLeft', outside)
  ui.document.dispatch('keydown', externalLeft)
  assert.equal(externalLeft.prevented, false, 'ArrowLeft com foco fora também fica disponível à página')
  assert.equal(ui.elements.get('#guideTitle').textContent, 'The orchestrator')
  const left = keyEvent('ArrowLeft', ui.elements.get('#guidePrevious'))
  ui.document.dispatch('keydown', left)
  assert.equal(ui.elements.get('#guideTitle').textContent, 'What is Prumo?')

  const escape = keyEvent('Escape')
  ui.document.dispatch('keydown', escape)
  assert.equal(ui.guide.hidden, true)
  assert.equal(ui.launcher.focusCount, 1, 'fechar devolve o foco ao botão que reabre o guia')
  await ui.launcher.click()
  assert.equal(ui.guide.hidden, false)
  assert.equal(ui.elements.get('#guideNext').focusCount, 2)

  const getterBlocked = createHarness({ storageGetterThrows: true })
  assert.equal(getterBlocked.guide.hidden, false, 'até o acesso à propriedade localStorage pode falhar sem bloquear o guia')
  const fullscreenDenied = createHarness()
  fullscreenDenied.guide.requestFullscreen = async () => { throw new Error('Fullscreen unavailable') }
  await fullscreenDenied.elements.get('#guidePresentation').click()
  assert.equal(fullscreenDenied.guide.classList.contains('presenting'), true, 'a apresentação na página funciona sem tela cheia')
})

test('uma preferência gravada deixa o dashboard sem painel automático e a marcação mantém o tour não modal', () => {
  const storage = new Map([['prumoOnboardingDismissed', 'true']])
  const ui = createHarness({ storage })
  assert.equal(ui.guide.hidden, true)
  assert.equal(ui.launcher.getAttribute('aria-expanded'), 'false', 'o guia recolhido informa seu estado acessível')
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.match(html, /role="region"[^>]*aria-live="polite"|role="region"[^>]*aria-keyshortcuts/)
  assert.doesNotMatch(html, /id="onboarding"[^>]*aria-modal=/)
  assert.match(html, /@media \(max-width: 700px\)[\s\S]*?\.prumo-guide \{[^}]*calc\(100vw - 20px\)/)
  assert.match(html, /data-prumo-guide-anchor="legend"/)
  assert.match(html, /<div id="viewport" data-prumo-guide-anchor="board">/)
  assert.match(html, /<div id="nodes" data-prumo-guide-anchor="tasks"><\/div>/)
  const loadingMarkup = html.match(/<div id="runLoading"[^>]*>/)?.[0] ?? ''
  assert.ok(loadingMarkup, 'o indicador de carregamento permanece presente no viewport')
  assert.doesNotMatch(loadingMarkup, /data-prumo-guide-anchor/, 'o overlay não recebe a âncora das tarefas')
  assert.match(html, /In Claude Code, Kiro or DSH, type \/prumo\. In Codex, type \$prumo\./)
})

test('hidden vence display flex/grid dos painéis do onboarding e acompanha os passos', async () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1]
  assert.ok(style)
  assert.match(style, /\.guide-role-card\s*\{[^}]*display:\s*flex/)
  assert.match(style, /\.guide-flow\s*\{[^}]*display:\s*grid/)
  const hiddenRule = style.match(/#onboarding\s+\[hidden\]\s*\{([^}]+)\}/)
  assert.ok(hiddenRule, 'o painel recebe um override de display para descendentes hidden')
  assert.match(hiddenRule[1], /display:\s*none\s*!important/)
  assert.ok(style.indexOf('#onboarding [hidden]') > style.indexOf('.guide-role-card {'))
  assert.ok(style.indexOf('#onboarding [hidden]') > style.indexOf('.guide-flow {'))

  const ui = createHarness()
  assert.equal(ui.elements.get('#guideRoleCard').hidden, true)
  assert.equal(ui.elements.get('#guideFlowPanel').hidden, true)
  assert.equal(ui.elements.get('#guideGainPanel').hidden, true)
  assert.equal(ui.elements.get('#guideCommandPanel').hidden, true)
  assert.equal(ui.elements.get('#guideExamplePanel').hidden, true)
  await ui.elements.get('#guideNext').click()
  assert.equal(ui.elements.get('#guideRoleCard').hidden, false)
  assert.equal(ui.elements.get('#guideFlowPanel').hidden, true)
  for (let index = 0; index < 4; index += 1) await ui.elements.get('#guideNext').click()
  assert.equal(ui.elements.get('#guideRoleCard').hidden, true)
  assert.equal(ui.elements.get('#guideFlowPanel').hidden, false)
})

test('títulos e descrições de todas as demonstrações têm pt-BR nos modos com e sem execução', async () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../scripts/onboarding.mjs', import.meta.url), 'utf8')
  const stepKeys = [...source.matchAll(/(?:title|description): '((?:\\.|[^'\\])*)'/g)]
    .map(([, key]) => key.replace(/\\'/g, "'"))
  const translatedKeys = [...source.matchAll(/translate\(\s*'((?:\\.|[^'\\])*)'/g)]
    .map(([, key]) => key.replace(/\\'/g, "'"))
  const guideStart = html.indexOf('<section id="onboarding"')
  const guideEnd = html.indexOf('<div id="results"', guideStart)
  const guideMarkup = html.slice(guideStart, guideEnd)
  const staticKeys = [...guideMarkup.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)].map(([, key]) => key)
  const allKeys = new Set([...stepKeys, ...translatedKeys, ...staticKeys])
  const pt = createTranslator(messages, 'pt-BR')
  for (const key of allKeys) {
    assert.ok(Object.hasOwn(messages, key), `chave de tradução ausente: ${key}`)
    assert.ok(typeof pt(key) === 'string')
  }

  const expectedTexts = new Set([...allKeys].map(pt))
  for (const hasRun of [true, false]) {
    const ui = createHarness({ lang: 'pt-BR', hasRun })
    const screens = []
    while (!ui.guide.hidden && screens.length < 20) {
      screens.push([ui.elements.get('#guideTitle').textContent, ui.elements.get('#guideDescription').textContent])
      await ui.elements.get('#guideNext').click()
    }
    assert.equal(screens.length, 14, hasRun ? 'walkthrough da execução real' : 'walkthrough do exemplo checkout-v2')
    for (const [title, description] of screens) {
      assert.ok(expectedTexts.has(title), `título sem pt-BR: ${title}`)
      assert.ok(expectedTexts.has(description), `descrição sem pt-BR: ${description}`)
    }
  }
})
