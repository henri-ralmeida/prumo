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
  storageGetterThrows = false, hasRun = true, summary = () => null, snapshot = () => null,
  fullscreen = 'available' } = {}) {
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
    '#guideSkip', '#guideGainsLabel', '#guideGainsSummary', '#guideOpenLegend',
    '#guideGainPanel', '#guideCommandPanel', '#guideFlowPanel', '#guideRoleCard', '#guideRoleName', '#guideRoleIcon', '#guideExamplePanel', '#guideVisual',
  ]
  for (const id of childIds) create(id, {
    hidden: ['#guideGainPanel', '#guideCommandPanel', '#guideFlowPanel', '#guideRoleCard', '#guideOpenLegend', '#guideExamplePanel', '#guideVisual'].includes(id),
    parent: guide,
  })

  guide.querySelector = (selector) => elements.get(selector) ?? null
  const listeners = new Map()
  const document = {
    fullscreenElement: null,
    fullscreenExitCount: 0,
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
    async exitFullscreen() { this.fullscreenExitCount += 1; this.fullscreenElement = null; this.dispatch('fullscreenchange', {}) },
  }
  guide.fullscreenRequestCount = 0
  if (fullscreen !== 'unsupported') guide.requestFullscreen = async () => {
    guide.fullscreenRequestCount += 1
    if (fullscreen === 'denied') throw new Error('Fullscreen unavailable')
    document.fullscreenElement = guide
    document.dispatch('fullscreenchange', {})
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
    getCompletedRunSummary: summary, getRunAvailability: () => runStatus.available, getRunSnapshot: snapshot })
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
    ['role-orchestrator', 'Orquestrador', 'var(--accent)'], ['role-planner', 'Planejador', 'var(--planning)'],
    ['role-executor', 'Executor', 'var(--running)'], ['role-reviewer', 'Revisor', 'var(--review)'],
  ]) {
    await ui.elements.get('#guideNext').click()
    assert.equal(ui.elements.get('#guideTitle').textContent, name)
    assert.equal(ui.elements.get('#guideRoleName').textContent, name, 'o título e o card usam o mesmo nome da entidade')
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
  assert.ok(ui.anchors.find((node) => node.dataset.prumoGuideAnchor === 'tasks').classList.contains('prumo-guide-target'),
    'se nenhum card estiver aberto, a demonstracao aponta para as tarefas que podem ser abertas')
  assert.match(ui.elements.get('#guideDescription').textContent, /Expanda o card/)
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

test('o guia mostra os contadores reais mesmo quando ficam fora do menu de filtros', async () => {
  const ui = createHarness({ lang: 'pt-BR', snapshot: () => ({ run: 'plano-real', tasks: 7, phases: 2, done: 5 }) })
  const originalQuery = ui.document.querySelector.bind(ui.document)
  ui.document.querySelector = selector => selector === '#counts' ? {
    cloneNode: () => ({ attributes: [], outerHTML: '<div class="counts">concluído <b>5</b> | em execução <b>2</b></div>' }),
  } : originalQuery(selector)
  const filters = (await walkVisuals(ui)).find(step => step.kind === 'filters')
  assert.ok(filters)
  assert.match(filters.html, /Da sua execução: plano-real/)
  assert.match(filters.html, /concluído <b>5<\/b> \| em execução <b>2<\/b>/)
  assert.doesNotMatch(filters.html, /gv-tag mock/)
})

test('o guia so usa o card aberto da execucao atual e descarta cards fechados ou de outro plano', async () => {
  for (const [hidden, run, expectedReal] of [[false, 'atual', true], [true, 'atual', false], [false, 'anterior', false]]) {
    const ui = createHarness({ lang: 'pt-BR', snapshot: () => ({ run: 'atual', tasks: 2, phases: 1, done: 0 }) })
    const originalQuery = ui.document.querySelector.bind(ui.document)
    const body = { textContent: 'Este e um resumo suficientemente longo de uma tarefa aberta no plano.',
      cloneNode: () => ({ attributes: [], outerHTML: '<div>CARD_REAL_DA_TAREFA</div>' }) }
    ui.document.querySelector = selector => selector === '#pop' ? { hidden, dataset: { run }, classList: { contains: () => true } }
      : selector === '#popBody' ? body : originalQuery(selector)
    const visual = (await walkVisuals(ui)).find(step => step.kind === 'selected')
    assert.equal(visual.html.includes('CARD_REAL_DA_TAREFA'), expectedReal, `${hidden} ${run}`)
    assert.equal(visual.html.includes('gv-tag real'), expectedReal)
  }
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
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1]
  assert.ok(style)
  assert.match(style, /#onboarding\.presenting \.guide-example \{ width: min\(1080px, 100%\)/,
    'o quadro de exemplo ocupa espaço suficiente em tela cheia desktop')
  const desktopPresentation = style.match(/#onboarding\.presenting \{([^}]+)\}/)?.[1]
  assert.match(desktopPresentation ?? '', /justify-content:\s*flex-start/,
    'a apresentação começa no topo para manter os títulos estáveis entre passos')
  assert.match(desktopPresentation ?? '', /overflow:\s*auto/,
    'o modo de apresentação pode rolar quando o conteúdo excede a altura disponível')
  assert.match(style, /\.guide-example-node > span \{[^}]*font: 600 14px\/1\.3 var\(--font-display\)/,
    'o nome das tarefas permanece legível no exemplo')
  assert.match(style, /\.guide-example-node small \{[^}]*font-size: 11px/,
    'papel ou estado não fica reduzido a microtexto')
  const mobileRuleStart = style.lastIndexOf('@media (max-width: 700px) {')
  assert.notEqual(mobileRuleStart, -1)
  const mobileStyles = style.slice(mobileRuleStart)
  const mobilePresentation = mobileStyles.match(/#onboarding\.presenting \{([^}]+)\}/)?.[1]
  assert.match(mobilePresentation ?? '', /height:\s*100dvh/)
  assert.match(mobilePresentation ?? '', /justify-content:\s*flex-start/,
    'em celular, conteúdo mais alto que a tela começa no topo e permanece acessível por rolagem')
  assert.match(mobileStyles, /\.guide-example-chain \{ grid-template-columns: minmax\(0, 1fr\)/,
    'em tela estreita cada dependência usa a largura inteira')
  assert.match(mobileStyles, /\.guide-example-arrow \{[^}]*transform: rotate\(90deg\)/,
    'as setas acompanham a leitura vertical no celular')
  assert.match(html, /Illustrative example — not current run data\./,
    'o mock deixa explícito que não é dado real da execução')
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

test('o guia inicia em apresentação, tolera armazenamento bloqueado, reabre e oferece setas e Esc', async () => {
  const ui = createHarness({ storageThrows: true })
  assert.equal(ui.guide.hidden, false, 'falha de leitura de storage não impede primeira visita')
  assert.equal(ui.guide.classList.contains('presenting'), true)
  assert.equal(ui.guide.fullscreenRequestCount, 1)
  assert.equal(ui.elements.has('#guidePresentation'), false, 'o guia não oferece alternância de modo')

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
  assert.equal(ui.guide.classList.contains('presenting'), false)
  assert.equal(ui.document.fullscreenElement, null)
  assert.equal(ui.document.fullscreenExitCount, 1)
  assert.equal(ui.launcher.focusCount, 1, 'fechar devolve o foco ao botão que reabre o guia')
  await ui.launcher.click()
  assert.equal(ui.guide.hidden, false)
  assert.equal(ui.guide.classList.contains('presenting'), true)
  assert.equal(ui.guide.fullscreenRequestCount, 2, 'cada abertura solicita tela cheia uma vez')
  assert.equal(ui.elements.get('#guideNext').focusCount, 2)

  const getterBlocked = createHarness({ storageGetterThrows: true })
  assert.equal(getterBlocked.guide.hidden, false, 'até o acesso à propriedade localStorage pode falhar sem bloquear o guia')
  const fullscreenDenied = createHarness({ fullscreen: 'denied' })
  assert.equal(fullscreenDenied.guide.classList.contains('presenting'), true, 'a apresentação na página funciona sem tela cheia')
  assert.equal(fullscreenDenied.guide.fullscreenRequestCount, 1)
  await fullscreenDenied.elements.get('#guideSkip').click()
  assert.equal(fullscreenDenied.guide.hidden, true)
  const fullscreenUnsupported = createHarness({ fullscreen: 'unsupported' })
  assert.equal(fullscreenUnsupported.guide.classList.contains('presenting'), true)
  await fullscreenUnsupported.elements.get('#guideSkip').click()
  assert.equal(fullscreenUnsupported.guide.hidden, true)
})

test('sair da tela cheia pelo navegador fecha o guia e devolve o foco', async () => {
  const ui = createHarness()
  assert.equal(ui.document.fullscreenElement, ui.guide)
  await ui.document.exitFullscreen()
  assert.equal(ui.guide.hidden, true)
  assert.equal(ui.guide.classList.contains('presenting'), false)
  assert.equal(ui.launcher.getAttribute('aria-expanded'), 'false')
  assert.equal(ui.launcher.focusCount, 1)
  assert.equal(ui.document.fullscreenExitCount, 1, 'o fechamento não repete a saída já feita pelo navegador')
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

async function walkVisuals(ui) {
  const seen = []
  for (let index = 0; index < 40; index += 1) {
    const visual = ui.elements.get('#guideVisual')
    seen.push({ title: ui.elements.get('#guideTitle').textContent, kind: visual.dataset.kind, hidden: visual.hidden,
      example: !ui.elements.get('#guideExamplePanel').hidden, html: String(visual.innerHTML ?? '') })
    if (/Finish guide|Concluir guia/.test(ui.elements.get('#guideNext').textContent) && seen.length > 1) break
    await ui.elements.get('#guideNext').click()
  }
  return seen
}

test('cada passo do guia tem visualização: mocks rotulados sem execução e números reais quando há execução', async () => {
  const empty = await walkVisuals(createHarness({ lang: 'pt-BR', hasRun: false }))
  for (const step of empty) {
    assert.ok(step.example || (!step.hidden && step.html.length > 0), `passo sem visualização: ${step.title}`)
    assert.doesNotMatch(step.html, /Da sua execução/, 'sem execução nada é apresentado como dado real')
    assert.doesNotMatch(step.html, /@|\d{3}\.\d{3}\.\d{3}/, 'nenhum dado pessoal nos exemplos')
  }
  const mocks = empty.filter((step) => /gv-tag mock/.test(step.html))
  assert.ok(mocks.length >= 4)
  for (const step of mocks) assert.match(step.html, /Exemplo ilustrativo — não são dados da execução atual\./)
  const flow = empty.find((step) => step.kind === 'flow')
  assert.ok(flow)
  for (const state of ['reprovada', 'bloqueada', 'no prumo']) assert.match(flow.html, new RegExp(state))
  assert.match(empty[0].html, /10 tarefas em 3 fases · 4 no prumo/)

  const figures = { oneAtATimeMs: 3_600_000, withPrumoMs: 900_000, oneAtATime: '1h00', withPrumo: '15m', savings: '45m', factor: '4×' }
  const live = await walkVisuals(createHarness({ lang: 'pt-BR', hasRun: true,
    snapshot: () => ({ run: 'demo-<run>', tasks: 12, phases: 3, done: 5 }),
    summary: () => ({ completed: true, measurementComplete: true, text: '45m poupados', figures }) }))
  assert.match(live[0].html, /Da sua execução: demo-&lt;run&gt;/, 'o nome da execução entra escapado')
  assert.match(live[0].html, /12 tarefas em 3 fases · 5 no prumo/)
  const gains = live.find((step) => step.kind === 'gains')
  assert.ok(gains)
  assert.match(gains.html, /Medido em uma execução concluída/)
  assert.match(gains.html, /<strong>1h00<\/strong>[\s\S]*<strong>15m<\/strong>[\s\S]*<strong>45m<\/strong>/)
  assert.match(gains.html, /class="par" style="width:25\.0%"/)
  const liveFlow = live.find((step) => step.kind === 'flow')
  assert.match(liveFlow.html, /gv-tag mock/, 'estados que a execução pode não ter continuam como exemplo rotulado')
})
