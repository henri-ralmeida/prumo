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

function harness({ saved = false, search = '', summary = () => null, launcherBottom = 48, callbacks = true, translate = true,
  cancelFrames = true, storageThrows = false, searchThrows = false, noLocation = false, rolesMissing = false, invitationMissing = false } = {}) {
  const elements = new Map()
  const el = id => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id) }
  const root = el('#onboarding'), launcher = el('#guideButton'), invite = el('#guideInvitation')
  launcher.getBoundingClientRect = () => ({ bottom: launcherBottom })
  invite.style = {}
  const demos = [], stops = []
  const roles = ['orchestrator','planner','executor','reviewer'].map(guideRole => new Node({guideRole}))
  const guideRoles = el('#guideMockRoles')
  guideRoles.querySelectorAll = rolesMissing ? () => null : () => roles
  root.querySelector = key => el(key)
  const storage = new Map(saved ? [['prumoOnboardingDismissed','true']] : [])
  const localStorage = {
    getItem: key => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
  }
  if (storageThrows) {
    localStorage.getItem = () => { throw new Error('storage indisponivel') }
    localStorage.setItem = () => { throw new Error('storage indisponivel') }
  }
  const document = { documentElement: { classList: new Node().classList }, fullscreenElement: null, listeners: new Map(),
    querySelector: key => invitationMissing && key === '#guideInvitation' ? null : el(key), addEventListener(type, fn) { this.listeners.set(type, fn) },
    exitFullscreen() { this.fullscreenElement = null; this.listeners.get('fullscreenchange')?.() } }
  root.requestFullscreen = () => { document.fullscreenElement = root; document.listeners.get('fullscreenchange')?.(); return Promise.resolve() }
  const frames = new Map()
  let frameId = 0
  const location = {}
  Object.defineProperty(location, 'search', { configurable: true, get: searchThrows ? () => { throw new Error('URL indisponivel') } : () => search })
  const window = { listeners: new Map(), addEventListener(type, listener) { this.listeners.set(type, listener) }, location: noLocation ? null : location, localStorage,
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id }, cancelAnimationFrame(id) { if (cancelFrames) frames.delete(id) } }
  const flushFrame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()) }
  root.hidden = true; invite.hidden = true
  const input = { root, launcher, document, window }
  if (translate) input.translate = (value,...args) => value.replace(/\{(\d+)\}/g, (_,index) => args[Number(index)] ?? '')
  if (callbacks) Object.assign(input, { showDemo: (mode,target) => demos.push({mode,target}), stopDemos: options => stops.push(options) })
  const api = createPrumoOnboarding(input)
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
  for(let i=0;i<5;i++) ui.el('#guideNext').click()
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

test('onboarding tolera dependencias opcionais ausentes e callbacks de demo obsoletos', () => {
  assert.equal(createPrumoOnboarding({ root: null, launcher: null, document: null }), null)

  const stale = harness({ cancelFrames: false, rolesMissing: true, invitationMissing: true, storageThrows: true, searchThrows: true, noLocation: true })
  stale.launcher.click()
  for (let step = 0; step < 5; step += 1) stale.el('#guideNext').click()
  stale.api.close()
  stale.flushFrame()
  stale.window.listeners.get('resize')?.()
  assert.equal(stale.demos.length, 0)

  const forcedError = harness({ searchThrows: true })
  assert.equal(forcedError.invite.hidden, false)

  const duplicate = harness()
  duplicate.launcher.click()
  for (let step = 0; step < 5; step += 1) duplicate.el('#guideNext').click()
  duplicate.flushFrame()
  duplicate.el('#guideNext').click()
  duplicate.el('#guidePrevious').click()
  duplicate.flushFrame()
  assert.deepEqual(duplicate.demos, [{ mode: 'board', target: 'board' }])

  const previous = harness()
  previous.launcher.click()
  previous.el('#guideNext').click()
  previous.el('#guidePrevious').click()
  assert.equal(previous.el('#guideStepTitle').textContent, 'Overview')
})

test('controlador do guia trata frame ausente, carga repetida e falha de foco', () => {
  const makeFrame = () => ({ dataset: {}, src: '', onload: null,
    removeAttribute(name) { if (name === 'src') this.src = '' },
    contentWindow: { prumoGuideDemo: { calls: [], focus(target) { this.calls.push(target) } } } })
  const frames = { board: makeFrame(), results: makeFrame() }, states = []
  frames.board.contentWindow.prumoGuideDemo.focus = undefined
  const controller = createGuideDemoFrameController(frames, (mode, state) => states.push([mode, state]))
  controller.show('missing', 'none')
  controller.show('board', 'filters')
  controller.show('board', 'card')
  const boardLoad = frames.board.onload
  controller.show('results', 'gain')
  boardLoad()
  assert.deepEqual(states.at(-1), ['board', 'idle'])
  controller.show('board', 'card')
  frames.board.onload()
  assert.deepEqual(states.at(-1), ['board', 'error'])
  frames.board.contentWindow.prumoGuideDemo.focus = () => { throw new Error('frame indisponível') }
  controller.show('board', 'activity')
  frames.board.onload()
  assert.deepEqual(states.at(-1), ['board', 'error'])
  controller.stop()
  controller.stop({ dispose: true })
  assert.equal(frames.board.src, '')
  assert.equal(frames.results.src, '')

  const quietFrame = makeFrame()
  const quietController = createGuideDemoFrameController({ board: quietFrame })
  quietController.show('board', 'board')
  quietFrame.onload()
  quietController.stop()
})

test('controlador encerra foco quando um frame público reentra durante o carregamento', () => {
  const frame = { dataset: {}, src: '', onload: null,
    removeAttribute(name) { if (name === 'src') this.src = '' },
    contentWindow: { prumoGuideDemo: { focus() {} } } }
  let accesses = 0
  let controller
  const frames = { results: { dataset: {}, src: '', onload: null, removeAttribute() {} } }
  Object.defineProperty(frames, 'board', {
    enumerable: true,
    get() {
      accesses += 1
      // O frame é uma dependência pública; uma troca de tela pode fechá-lo
      // enquanto o callback de carga ainda está tentando focar o destino.
      if (accesses === 3) controller.stop()
      return frame
    },
  })
  const states = []
  controller = createGuideDemoFrameController(frames, (mode, state) => states.push([mode, state]))
  controller.show('board', 'filters')
  frame.onload()
  assert.equal(accesses, 3)
  assert.deepEqual(states, [['board', 'loading'], ['board', 'idle']])
})

test('foco em frame em cache é cancelado quando o guia fecha durante a leitura do frame', () => {
  const calls = []
  const frame = { dataset: {}, src: '', onload: null,
    removeAttribute(name) { if (name === 'src') this.src = '' },
    contentWindow: { prumoGuideDemo: { focus(target) { calls.push(target) } } } }
  let accesses = 0
  let controller
  const frames = { results: { dataset: {}, src: '', onload: null, removeAttribute() {} } }
  Object.defineProperty(frames, 'board', {
    enumerable: true,
    get() {
      accesses += 1
      if (accesses === 5) controller.stop()
      return frame
    },
  })
  const states = []
  controller = createGuideDemoFrameController(frames, (mode, state) => states.push([mode, state]))
  controller.show('board', 'filters')
  frame.onload()
  assert.deepEqual(calls, ['filters'])

  controller.show('board', 'card')

  assert.equal(accesses, 5)
  assert.deepEqual(calls, ['filters'])
  assert.deepEqual(states, [['board', 'loading'], ['board', 'ready'], ['board', 'idle']])
})

test('teclado, fullscreen e encerramento percorrem as saídas do onboarding', async () => {
  const ui = harness()
  ui.launcher.click()
  const keydown = ui.document.listeners.get('keydown')
  const prevent = { prevented: false, preventDefault() { this.prevented = true } }
  keydown({ key: 'ArrowRight', target: {}, ...prevent })
  keydown({ key: 'ArrowLeft', target: ui.root, ...prevent })
  keydown({ key: 'ArrowRight', target: { isContentEditable: true }, ...prevent })
  ui.root.contains = () => true
  keydown({ key: 'ArrowRight', target: { closest: selector => selector === '[contenteditable="true"]' ? {} : null }, ...prevent })
  keydown({ key: 'ArrowRight', target: { tagName: 'INPUT', closest: () => null }, ...prevent })
  keydown({ key: 'ArrowRight', target: ui.root, ...prevent })
  keydown({ key: 'Escape', target: ui.root, ...prevent })
  assert.equal(ui.root.hidden, true)
  keydown({ key: 'Escape', target: ui.root, ...prevent })
  ui.api.refreshGains()
  ui.api.refreshRunAvailability()

  const minimal = harness({ callbacks: false })
  minimal.launcher.click()
  for (let step = 0; step < 6; step += 1) minimal.el('#guideNext').click()
  minimal.flushFrame()
  minimal.api.close()

  const defaults = harness({ callbacks: false, translate: false })
  defaults.launcher.click()

  const noFullscreen = harness()
  noFullscreen.root.requestFullscreen = null
  noFullscreen.launcher.click()
  assert.equal(noFullscreen.root.hidden, false)

  const rejectedFullscreen = harness()
  rejectedFullscreen.root.requestFullscreen = () => { throw new Error('sem gesto') }
  rejectedFullscreen.launcher.click()
  assert.equal(rejectedFullscreen.root.hidden, false)
  rejectedFullscreen.document.exitFullscreen = () => { throw new Error('já fechado') }
  rejectedFullscreen.api.close()

  const throwingExit = harness()
  throwingExit.launcher.click()
  await Promise.resolve()
  throwingExit.document.exitFullscreen = () => { throw new Error('saída bloqueada') }
  throwingExit.api.close()

  const externalExit = harness()
  externalExit.launcher.click()
  externalExit.document.fullscreenElement = null
  externalExit.document.listeners.get('fullscreenchange')()
  assert.equal(externalExit.root.hidden, false)
  externalExit.el('#guideSkip').click()
  assert.equal(externalExit.root.hidden, true)

  const finish = harness()
  finish.launcher.click()
  for (let step = 0; step < 14; step += 1) finish.el('#guideNext').click()
  assert.equal(finish.root.hidden, true)
  finish.api.close()
  await Promise.resolve()
  await Promise.resolve()

  const previousDemo = harness()
  previousDemo.launcher.click()
  for (let step = 0; step < 5; step += 1) previousDemo.el('#guideNext').click()
  previousDemo.el('#guidePrevious').click()

  const delayed = harness()
  let resolveFullscreen
  delayed.root.requestFullscreen = () => {
    delayed.document.fullscreenElement = delayed.root
    return new Promise(resolve => { resolveFullscreen = resolve })
  }
  delayed.launcher.click()
  delayed.api.close()
  resolveFullscreen()
  await Promise.resolve()
  await Promise.resolve()
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

test('guia reutiliza as interfaces reais, documenta os dez ambientes e oferece fontes oficiais', () => {
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
  assert.deepEqual([...section.matchAll(/<h3>([^<]+)<\/h3>/g)].map(match => match[1]),
    ['Claude Code','Codex','Kiro','Deep Seek','Antigravity','OpenCode','Grok','GitHub Copilot','Hermes Agent','OpenClaw'])
  for (const href of ['https://code.claude.com/docs/en/common-workflows',
    'https://developers.openai.com/codex/cli/slash-commands', 'https://kiro.dev/docs/specs/plan/',
    'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/plan/plan-mode/README.md',
    'https://antigravity.google/docs/skills/', 'https://opencode.ai/v2/docs/skills',
    'https://docs.x.ai/build/features/skills-plugins-marketplaces',
    'https://docs.github.com/en/copilot/concepts/agents/about-agent-skills']) {
    assert.ok(section.includes(`href="${href}"`), `fonte oficial ausente: ${href}`)
  }
  for (const fragment of ['agy --mode=plan', 'separate global skill roots', '/models', 'grok models', '.grok/skills']) assert.ok(section.includes(fragment), `orientação ausente: ${fragment}`)
  assert.match(section,/id="guideStepTitle"/)
  assert.ok(section.indexOf('id="guideStepTitle"') < section.indexOf('id="guideCount"'))
  assert.match(section,/id="guideSkip"[^>]*data-i18n="Exit guide"/)
  assert.match(section,/id="guidePrevious"[^>]*>back<\/button>/)
  assert.match(section,/id="guideNext"[^>]*>next<\/button>/)
  assert.doesNotMatch(section,/id="guide(?:Previous|Next)"[^>]*data-i18n=/)
  assert.match(html,/if \(GUIDE_DEMO\) \{[\s\S]*STATE = createGuideDemoData/)
  assert.match(html,/else \{\s*tick\(\)\s*loadIdentity\(\)/)
})

test('guia dimensiona conteúdo pela largura e altura sem fixar a escala nem cortar rolagem', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.match(html, /--guide-unit: clamp\(1px, min\(\.075vw, \.14vh\), 2px\)/)
  for (const selector of ['h2', '.guide-intro > strong', '.guide-entities .oh', '.guide-harness-grid h3']) {
    const rule = html.split('#onboarding.presenting ' + selector + ' {').at(-1).split('}')[0]
    assert.match(rule, /font-size: calc\(\d+ \* var\(--guide-unit\)\)/)
  }
  assert.match(html, /height: 100dvh; overflow-y: auto; overflow-x: hidden/)
  assert.match(html, /#onboarding.presenting \.guide-entities \{ grid-template-columns: minmax\(0, 260px\)/)
})

test('guia preserva saída amarela do orquestrador e ramificações nas cores dos três papéis', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  const connections = html.match(/<svg class="guide-role-connections"[\s\S]*?<\/svg>/)?.[0]
  assert.ok(connections)
  assert.match(connections, /aria-hidden="true"/)
  assert.match(connections, /data-role="orchestrator" style="stroke:var\(--accent\)" d="M366 0V19"/)
  for (const role of ['plan', 'exec', 'rev']) assert.ok(connections.includes('data-role="' + role + '"'))
  assert.match(html, /@media \(max-width: 700px\) \{ \.guide-role-connections \{ display: none;/)
})

test('abrir documentação mantém o guia na etapa atual após sair da tela cheia', async () => {
  const ui = harness()
  ui.launcher.click()
  await Promise.resolve()
  for (let step = 0; step < 13; step += 1) ui.el('#guideNext').click()
  assert.equal(ui.el('#guideCommandPanel').hidden, false)
  const title = ui.el('#guideTitle').textContent
  const count = ui.el('#guideCount').textContent
  const stops = ui.stops.length
  const focus = ui.launcher.focusCount
  ui.root.scrollTop = 420
  ui.document.fullscreenElement = null
  ui.document.listeners.get('fullscreenchange')()
  assert.equal(ui.root.hidden, false)
  assert.equal(ui.root.classList.contains('presenting'), true)
  assert.equal(ui.launcher.getAttribute('aria-expanded'), 'true')
  assert.equal(ui.el('#guideCommandPanel').hidden, false)
  assert.equal(ui.el('#guideTitle').textContent, title)
  assert.equal(ui.el('#guideCount').textContent, count)
  assert.equal(ui.root.scrollTop, 420)
  assert.equal(ui.stops.length, stops)
  assert.equal(ui.launcher.focusCount, focus)
  ui.document.listeners.get('fullscreenchange')()
  assert.equal(ui.root.hidden, false)
  ui.document.listeners.get('keydown')({ key: 'Escape', target: ui.root, preventDefault() {} })
  assert.equal(ui.root.hidden, true, 'a saída explícita pelo teclado continua fechando o guia')
})

 test('limite de agentes tem demonstracao propria na barra de controles', () => {
  const ui = harness()
  ui.launcher.click()
  ui.el('#guideNext').click()
  assert.doesNotMatch(ui.el('#guideDescription').textContent, /default is 3/)
  ui.roles[3].click()
  ui.el('#guideNext').click()
  ui.el('#guideNext').click()
  ui.flushFrame()
  assert.deepEqual(ui.demos.at(-1), { mode: 'board', target: 'filters' })
  ui.el('#guideNext').click()
  ui.flushFrame()
  assert.deepEqual(ui.demos.at(-1), { mode: 'board', target: 'agents' })
  assert.match(ui.el('#guideDescription').textContent, /default is 3 simultaneous agents/)
  assert.match(ui.el('#guideDescription').textContent, /future runs on this computer/)
  ui.el('#guideNext').click()
  assert.doesNotMatch(ui.el('#guideDescription').textContent, /default is 3/)
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.doesNotMatch(html.match(/<section id="guideMockRoles"[\s\S]*?<\/section>/)[0], /default is 3/)
})
