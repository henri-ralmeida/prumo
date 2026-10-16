import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { disableDashboardBoot, extractDashboardScript, injectDashboardLanguage, runDashboardScript } from './fixtures/dashboard-vm.mjs'

test('card com titulo curto conserva titulo completo escapado no tooltip', () => {
  const source = extractDashboardScript(readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8'))
  const nodes = new Map()
  const element = () => ({ innerHTML: '', textContent: '', dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
    querySelectorAll() { return [] }, querySelector() { return element() },
    getBoundingClientRect() { return { width: 1000, height: 700, left: 0, top: 0 } } })
  const sandbox = {
    document: { documentElement: element(), querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element())
      return nodes.get(selector)
    }, querySelectorAll() { return [] }, addEventListener() {} },
    location: { search: '', origin: 'http://localhost', href: 'http://localhost/' },
    history: { state: null, replaceState() {} },
    localStorage: { getItem() { return null }, setItem() {} },
    sessionStorage: { getItem() { return null }, setItem() {} },
    URL, URLSearchParams, innerWidth: 1330, innerHeight: 800,
    performance: { now() { return 0 } }, CSS: { escape: text => text },
    addEventListener() {}, requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {},
  }
  sandbox.window = sandbox
  const ui = runDashboardScript(disableDashboardBoot(injectDashboardLanguage(source, 'pt-BR')), sandbox, { sourceScript: source })
  const title = 'Sincronizar "cartao" <aprovado> & conta'
  const state = { run: 'cartoes', createdAt: '2026-01-01T00:00:00Z', plan: { name: 'Cartoes', phases: [] },
    tasks: { T1: { id: 'T1', title, label: 'Cartões', summary: 'Atualizar o status aprovado.', state: 'pending',
      deps: [], tags: [], touches: [], attempts: [], validations: [], notes: [] } },
    derived: { T1: { effective: 'ready', blockedBy: [] } } }
  ui.run('STATE = input; render(STATE, [])', { input: state })
  const markup = nodes.get('#nodes').innerHTML
  assert.match(markup, /<span class="nt">Cartões<\/span>/)
  const tooltip = markup.match(/<div class="node"[^>]* title="([^"]*)"/)
  assert.ok(tooltip, markup)
  assert.ok(tooltip[1].includes('Sincronizar &quot;cartao&quot; &lt;aprovado&gt; &amp; conta'), tooltip[1])
})
