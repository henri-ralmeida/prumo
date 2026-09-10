import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, runInNewContext } from 'node:vm'
import { messages, createTranslator, language, localizeDashboard } from '../scripts/i18n.mjs'
import { regionalLanguage } from '../scripts/region.mjs'
import { dashboardWithCatalog } from '../scripts/build-dashboard.mjs'

test('language selection and interpolation preserve data and placeholders', () => {
  assert.equal(language(undefined, { LANG: 'en_US.UTF-8' }, () => 'pt-BR'), 'pt-BR')
  assert.equal(language(undefined, { LANG: 'pt_BR.UTF-8' }, () => 'en'), 'en')
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

test('region detection is independent of display language and defaults to English on failure', () => {
  for (const [platform, output, expected] of [
    ['win32', '32', 'pt-BR'], ['win32', '244', 'en'],
    ['darwin', 'en_BR', 'pt-BR'], ['darwin', 'pt_US', 'en'], ['darwin', 'en_BR@calendar=gregorian', 'pt-BR'],
    ['linux', 'country_ab2="BR"\nlang_ab="en"', 'pt-BR'], ['linux', 'country_ab2="US"\nlang_ab="pt"', 'en'],
    ['linux', 'country_ab2=""', 'en'],
  ]) {
    const run = (command, args, options) => {
      assert.equal(options.windowsHide, true)
      assert.ok(options.timeout > 0)
      if (platform === 'win32') assert.ok(args.includes('(Get-WinHomeLocation).GeoId'))
      if (platform === 'darwin') assert.ok(args.includes('AppleLocale'))
      if (platform === 'linux') assert.ok(args.includes('LC_ADDRESS'))
      return output
    }
    assert.equal(regionalLanguage({ platform, env: { LANG: expected === 'en' ? 'pt_BR' : 'en_US' }, run }), expected)
  }
  assert.equal(regionalLanguage({ run: () => { throw new Error('Unavailable') } }), 'en')
})

test('dashboard embeds the current translator and remains valid JavaScript', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  assert.equal(dashboardWithCatalog(html), html)
  assert.doesNotMatch(html, /id="language"|prumoLanguage|navigator.language|function setLanguage/)
  for (const lang of ['en', 'pt-BR']) {
    const installed = localizeDashboard(html, lang)
    assert.doesNotMatch(installed, /\/\*PRUMO_LANGUAGE\*\//)
    const setup = installed.match(/const defaultLanguage = [\s\S]*?(?=function localize)/)[0]
    const context = { createTranslator, PRUMO_MESSAGES: messages, navigator: { language: lang === 'en' ? 'pt-BR' : 'en-US' }, localStorage: { getItem: () => lang === 'en' ? 'pt-BR' : 'en' } }
    assert.equal(runInNewContext(setup + '; UI_LANG', context), lang)
    assert.equal(localizeDashboard(installed, lang === 'en' ? 'pt-BR' : 'en'), installed, 'Running servers preserve the installed language')
  }
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new Script(script))
  assert.doesNotMatch(html, /Graph Engine/)
  assert.match(html, /\.par > span:not\(\.empty\)/, 'Empty state and nested labels must not receive task borders')
  assert.match(script, /if \(generation !== TICK_GENERATION\) return/, 'A superseded run response must not repaint the dashboard')
})
