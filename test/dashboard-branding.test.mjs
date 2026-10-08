import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

test('guia usa vetores oficiais completos sem depender de rede nem recolorir as marcas', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  const brands = [...html.matchAll(/<img class="guide-brand-logo" src="data:image\/svg\+xml;base64,([^"]+)" alt="([^"]+)" width="40" height="40" data-brand-source="([^"]+)" data-brand-sha256="([^"]+)">/g)]
  assert.deepEqual(brands.map(match => match[2]), ['Antigravity', 'OpenCode', 'Grok Build'])
  for (const [, encoded, , source, digest] of brands) {
    const asset = Buffer.from(encoded, 'base64')
    assert.equal(createHash('sha256').update(asset).digest('hex'), digest)
    assert.match(asset.toString(), /<svg\b/)
    assert.doesNotMatch(asset.toString(), /<script\b|\bonload=|\bonerror=/i)
    assert.match(source, /^https:\/\/(antigravity\.google|opencode\.ai|grok\.com)\//)
  }
  assert.doesNotMatch(html, /guide-harness-grid-new svg \{ color:/)
})
