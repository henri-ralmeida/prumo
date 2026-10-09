import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

test('guia preserva vetores oficiais completos sem depender de rede', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  const brands = [...html.matchAll(/<img class="guide-brand-logo" src="data:image\/svg\+xml;base64,([^"]+)" alt="([^"]+)" width="40" height="40" data-brand-source="([^"]+)" data-brand-sha256="([^"]+)">/g)]
  assert.deepEqual(brands.map(match => match[2]), ['Antigravity', 'OpenCode', 'Grok', 'Hermes Agent', 'OpenClaw'])
  assert.match(html, /<h3>Grok<\/h3>/)
  assert.doesNotMatch(html, /<h3>Grok Build<\/h3>/)
  for (const [, encoded, , source, digest] of brands) {
    const asset = Buffer.from(encoded, 'base64')
    assert.equal(createHash('sha256').update(asset).digest('hex'), digest)
    assert.match(asset.toString(), /<svg\b/)
    assert.doesNotMatch(asset.toString(), /<script\b|\bonload=|\bonerror=/i)
    assert.match(source, /^https:\/\/(antigravity\.google|opencode\.ai|grok\.com|raw\.githubusercontent\.com)\//)
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

test('guia distribui dez ambientes em cinco colunas e adapta telas estreitas', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  const panel = html.split('<section id="guideCommandPanel"')[1].split('</section>')[0]
  assert.equal((panel.match(/<article>/g) ?? []).length, 10)
  assert.equal((panel.match(/class="guide-harness-grid"/g) ?? []).length, 1)
  assert.match(html, /guide-harness-grid \{[^}]*repeat\(5,minmax\(0,1fr\)\)/)
  assert.match(html, /max-width:1100px[^}]*repeat\(3,minmax\(0,1fr\)\)/)
  assert.match(html, /max-width:440px[^}]*grid-template-columns: 1fr/)
  for (const title of ['Hermes Agent', 'OpenClaw']) assert.ok(panel.includes('<h3>' + title + '</h3>'))
  assert.ok(panel.includes('https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/'))
  assert.ok(panel.includes('https://docs.openclaw.ai/tools/skills'))
})

test('Hermes remove o fundo oficial escuro e conserva o desenho branco', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.ok(html.includes('.guide-brand-logo[alt="Hermes Agent"] { filter: url(#guide-brand-tint-hermes); }'))
  const encoded = html.match(/class="guide-brand-logo" src="data:image\/svg\+xml;base64,([^"]+)" alt="Hermes Agent"/)[1]
  const svg = Buffer.from(encoded, 'base64').toString()
  const background = svg.match(/<ns0:rect[^>]*fill="(#[0-9a-f]+)"/)[1]
  const filter = html.match(/<filter id="guide-brand-tint-hermes"[^]*?<\/filter>/)[0]
  const transfer = filter.match(/feFuncA type="linear" slope="([^"]+)" intercept="([^"]+)"/)
  const alpha = color => {
    const rgb = color.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
    const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
    return Math.max(0, Math.min(1, luminance * Number(transfer[1]) + Number(transfer[2])))
  }
  assert.equal(alpha(background), 0, 'o fundo oficial precisa ficar completamente transparente')
  assert.equal(alpha('#ffffff'), 1, 'o desenho branco precisa continuar visível')
  assert.ok(html.includes('[alt="Grok"] { filter: url(#guide-brand-tint-luminance); }'))
})
