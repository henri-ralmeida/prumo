import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

test('guia preserva vetores oficiais completos sem depender de rede', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  const brands = [...html.matchAll(/<img class="guide-brand-logo" src="data:image\/svg\+xml;base64,([^"]+)" alt="([^"]+)" width="40" height="40" data-brand-source="([^"]+)" data-brand-sha256="([^"]+)">/g)]
  assert.deepEqual(brands.map(match => match[2]), ['Antigravity', 'OpenCode', 'Grok'])
  assert.match(html, /<h3>Grok<\/h3>/)
  assert.doesNotMatch(html, /<h3>Grok Build<\/h3>/)
  for (const [, encoded, , source, digest] of brands) {
    const asset = Buffer.from(encoded, 'base64')
    assert.equal(createHash('sha256').update(asset).digest('hex'), digest)
    assert.match(asset.toString(), /<svg\b/)
    assert.doesNotMatch(asset.toString(), /<script\b|\bonload=|\bonerror=/i)
    assert.match(source, /^https:\/\/(antigravity\.google|opencode\.ai|grok\.com)\//)
  }
  assert.doesNotMatch(html, /guide-harness-grid-new svg \{ color:/)
})

test('logos ficam brancos e barras amarelas como os demais cards, sem o fundo escuro do Grok', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.match(html, /guide-brand-filters feFlood \{ flood-color: var\(--text\)/)
  assert.match(html, /\.guide-harness-grid article \{[^}]*border-top: 2px solid var\(--accent\)/)
  assert.doesNotMatch(html, /guide-harness-grid-new article \{ border-top-color:/)
  assert.match(html, /filter: url\(#guide-brand-tint\)/)
  assert.match(html, /\[alt="Grok"\] \{ filter: url\(#guide-brand-tint-luminance\)/)
  assert.match(html, /0\.2126 0\.7152 0\.0722 0 0" result="luminance"/)
  assert.match(html, /feFuncA type="linear" slope="1\.05" intercept="-0\.05"/)
  assert.match(html, /in2="SourceGraphic" operator="in"/)
  assert.match(html, /in2="silhouette" operator="in"/)
})

test('OpenCode preserva o cinza interno oficial e orienta a invocacao por versao', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.match(html, /guide-brand-logo\[alt="OpenCode"\] \{ filter: none; \}/)
  const encoded = html.match(/class="guide-brand-logo" src="data:image\/svg\+xml;base64,([^"]+)" alt="OpenCode"/)[1]
  assert.match(Buffer.from(encoded, 'base64').toString(), /fill='#4B4646'/)
  assert.match(html, /<code class="guide-invoke-options" data-i18n="\/prumo or @prumo">\/prumo or @prumo<\/code>/)
  assert.doesNotMatch(html, /<code>skill\(/)
  assert.match(html, /href="https:\/\/opencode.ai\/v2\/docs\/skills"/)
  assert.doesNotMatch(html, /Select the built-in Plan agent with Tab;/)
  const messages = JSON.parse(readFileSync(new URL('../scripts/messages.json', import.meta.url), 'utf8'))
  const key = 'Select Plan in the agent picker and approve the plan. In V2, mention @prumo; in V1, use /prumo. /models selects the model.'
  assert.match(messages[key], /Na V2, mencione @prumo; na V1, use \/prumo/)
  assert.equal(messages['/prumo or @prumo'], '/prumo ou @prumo')
  assert.match(html, /guide-invoke-options \{ white-space: nowrap;/)
  assert.match(html, /<h3>Deep Seek<\/h3>/)
  assert.doesNotMatch(html, /<h3>DSH<\/h3>|<code>Plan \/ \/plan<\/code>/)
  assert.match(html, /<h3>GitHub Copilot<\/h3><code>\/plan<\/code>/)
})
