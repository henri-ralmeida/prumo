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
  assert.deepEqual(['ready_to_plan', 'planning', 'ready'].map(pt), ['pronto para planejamento', 'em planejamento', 'pronto para executar'])
  assert.deepEqual(['phase discussion', 'phase planning', 'awaiting phase plan', 'unresolved later-phase input', 'validated input', 'waived input'].map(pt),
    ['discussão da fase', 'planejamento da fase', 'aguardando plano da fase', 'entrada de fase posterior não resolvida', 'entrada validada', 'entrada dispensada'])
  assert.deepEqual(['Selected task', 'No task selected', 'Collapse sidebar', 'Open sidebar'].map(pt),
    ['Tarefa selecionada', 'Nenhuma tarefa selecionada', 'Recolher lateral', 'Abrir lateral'])
  assert.equal(pt('Choose exactly one of --claude, --kiro, --codex or --dsh'), 'Escolha exatamente um: --claude, --kiro, --codex ou --dsh')
  for (const [harness, label] of [['claude', 'Claude Code'], ['kiro', 'Kiro'], ['codex', 'Codex'], ['dsh', 'DeepSeek Harness']]) {
    const flag = `--${harness}`
    const key = '{0} is not installed or configured; install or configure it before running prumo install {1}'
    assert.equal(en(key, label, flag), `${label} is not installed or configured; install or configure it before running prumo install ${flag}`)
    assert.equal(pt(key, label, flag), `${label} não está instalado ou configurado; instale ou configure esse ambiente antes de executar prumo install ${flag}`)
  }
  assert.equal(pt('No supported environments detected; install or configure Claude Code, Kiro, Codex or DeepSeek Harness first'),
    'Nenhum ambiente compatível foi detectado; instale ou configure Claude Code, Kiro, Codex ou DeepSeek Harness primeiro')
  assert.equal(pt('contract drift: task T1 fields: title, validation'),
    'divergência de contrato: tarefa T1, campos: title, validation')
  assert.equal(pt('planning round {0} ({1}) {2} for {3}; artifacts {4}/{5}', 'F1', 1, pt('open'), '12s', 0, 2),
    'rodada de planejamento F1 (1) aberta há 12s; artefatos 0/2')
  assert.equal(pt('contract confirmation required for phase F1: A, B'),
    'a fase F1 exige confirmação do contrato: A, B')
  assert.equal(pt('contract confirmation required for task T1'), 'a tarefa T1 exige confirmação do contrato')
  assert.equal(pt('{0} requires a fresh answered contract confirmation; begin-discussion and ask the user before skipping discussion', 'T1'),
    'T1 exige uma nova confirmação respondida do contrato; execute begin-discussion e pergunte ao usuário antes de pular a discussão')
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
  const rebuilt = dashboardWithCatalog(html)
  assert.equal(rebuilt, html)
  const embeddedMessages = JSON.parse(rebuilt.match(/const PRUMO_MESSAGES = ([^\r\n]+)/)[1])
  for (const [lang, expected] of [['en', 'reviewer rejected T5'], ['pt-BR', 'revisor reprovou T5']]) {
    assert.equal(createTranslator(embeddedMessages, lang)('{0} rejected {1}', lang === 'en' ? 'reviewer' : 'revisor', 'T5'), expected)
  }
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

test('favicon uses the inline header mark path, weight and amber color', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  const encoded = html.match(/<link rel="icon" href="data:image\/svg\+xml,([^"]+)"/)[1]
  const favicon = decodeURIComponent(encoded)
  const header = html.match(/<h1>(<svg[\s\S]*?<\/svg>)/)[1]
  const attribute = (svg, name) => svg.match(new RegExp(name + "=['\\\"]([^'\\\"]+)['\\\"]"))?.[1]
  const path = (svg) => svg.match(/<path d=['\"]([^'\"]+)['\"]/)[1]
  const line = (svg) => svg.match(/<line\b[^>]*>/)[0]
  const mark = (svg) => svg.match(/<path\b[^>]*>/)[0]
  assert.equal(attribute(favicon, 'viewBox'), attribute(header, 'viewBox'))
  assert.equal(path(favicon), path(header))
  assert.equal(attribute(line(favicon), 'stroke-width'), attribute(line(header), 'stroke-width'))
  assert.deepEqual([attribute(line(favicon), 'stroke'), attribute(mark(favicon), 'fill')],
    [attribute(line(header), 'stroke'), attribute(mark(header), 'fill')])
  assert.equal(attribute(mark(favicon), 'fill'), '#e8b04b')
  assert.equal(attribute(line(favicon), 'stroke'), '#e8b04b')
  assert.match(favicon, /viewBox=['"]0 0 22 30['"]/)
})
