import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { messages, createTranslator, language } from '../scripts/i18n.mjs'
import { dashboardWithCatalog } from '../scripts/build-dashboard.mjs'

test('language selection and interpolation preserve data and placeholders', () => {
  assert.equal(language(undefined, { LANG: 'pt_BR.UTF-8' }), 'pt-BR')
  assert.equal(language(undefined, { LANG: 'de_DE.UTF-8' }), 'en')
  assert.equal(language('en', { PRUMO_LANG: 'pt-BR' }), 'en')
  assert.throws(() => language('de'), /en or pt-BR/)
  const pt = createTranslator(messages, 'pt-BR')
  const en = createTranslator(messages, 'en')
  assert.equal(pt('Changes / {0}', 'C:/a $& <unchanged>'), 'Alterações / C:/a $& <unchanged>')
  assert.equal(en('Changes / {0}', 'x'), 'Changes / x')
  assert.equal(pt('[prumo] ERROR: unknown task "T1"'), '[prumo] ERRO: tarefa desconhecida "T1"')
  assert.equal(pt(JSON.stringify({ state: 'done', title: 'Review' })), '{"state":"done","title":"Review"}')
  for (const [key, value] of Object.entries(messages)) {
    const slots = text => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort()
    assert.deepEqual(slots(key), slots(value), key)
  }
})

test('dashboard embeds the current translator and remains valid JavaScript', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.equal(dashboardWithCatalog(html), html)
  assert.match(html, /id="language"/)
  assert.match(html, /prumoLanguage/)
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new Script(script))
  assert.doesNotMatch(html, /Graph Engine/)
})
