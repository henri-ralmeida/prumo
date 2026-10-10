import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Script, runInNewContext } from 'node:vm'
import { messages, createTranslator, language, localizeDashboard, log, errorLog } from '../scripts/i18n.mjs'
import { regionalLanguage } from '../scripts/region.mjs'
import { dashboardWithCatalog } from '../scripts/build-dashboard.mjs'

test('tradução conserva valores não textuais e placeholders sem parâmetro', () => {
  const dictionary = { 'Command {0}: {1}': 'Comando {0}: {1}' }
  const pt = createTranslator(dictionary, 'pt-BR')
  const en = createTranslator(dictionary, 'en')
  const value = { state: 'done' }
  assert.equal(pt(value), value)
  assert.equal(pt(null), null)
  assert.equal(pt(3), 3)
  assert.equal(pt('Uncatalogued {0}', 'valor'), 'Uncatalogued valor')
  assert.equal(pt('Command {0}: {1}', 'verificar'), 'Comando verificar: {1}')
  assert.equal(en('Command {0}: {1}', 'verificar'), 'Command verificar: {1}')
})

test('idioma inválido encerra inicialização com erro explícito e sem saída traduzida', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/i18n.mjs', import.meta.url)), '--lang', 'fr'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Language must be en or pt-BR/)
})

test('logs preservam dados não textuais e encaminham falhas para o canal de erro', () => {
  const normal = [], errors = [], value = { state: 'done' }
  const originalLog = console.log, originalError = console.error
  try {
    console.log = (...args) => normal.push(args)
    console.error = (...args) => errors.push(args)
    log('mensagem externa', value, 3)
    errorLog('falha externa', value)
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  assert.deepEqual(normal, [['mensagem externa', value, 3]])
  assert.deepEqual(errors, [['falha externa', value]])
  assert.equal(normal[0][1], value)
  assert.equal(errors[0][1], value)
})

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
  assert.equal(pt('dsh'), 'dsh')
  assert.equal(pt('English'), 'English')
  assert.equal(pt('Miriam'), 'Miriam')
  assert.equal(pt('15m'), '15 min')
  assert.equal(pt('2h'), '2 h')
  assert.equal(pt('{0} requires a fresh answered contract confirmation; begin-discussion and ask the user before skipping discussion', 'T1'),
    'T1 exige uma nova confirmação respondida do contrato; execute begin-discussion e pergunte ao usuário antes de pular a discussão')
  // O modelo mais específico vence os genéricos, e um slot nunca absorve o prefixo "[prumo] ".
  assert.equal(pt('[prumo] WARNING: executor progress stayed at 2/3; the position is not proof of completed work'),
    '[prumo] AVISO: o progresso do executor permaneceu em 2/3; a posição não comprova trabalho concluído')
  assert.equal(pt('[prumo] A validation recorded by review: OK'), '[prumo] validação de A registrada por review: OK')
  assert.equal(pt('3 of 5'), '3 de 5')
  assert.equal(pt('[prumo] P1 discussing 2 task(s) (round A, nonce n1)'), '[prumo] P1 em discussão com 2 tarefa(s) (rodada A, nonce n1)')
  assert.equal(pt('[prumo] P1 planned atomically (2 task artifact(s))'), '[prumo] P1 planejada atomicamente (2 artefato(s) de tarefa)')
  assert.equal(pt('[prumo] P1 ready to plan (2 task(s))'), '[prumo] P1 pronta para planejar (2 tarefa(s))')
  assert.equal(pt('[prumo] T1 ready to plan (discussion A closed)'), '[prumo] T1 pronta para planejar (discussão A encerrada)')
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

test('favicon, dashboard e guia usam o mesmo prumo facetado com contraste adequado', () => {
  const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8')
  const encoded = html.match(/<link rel="icon" href="data:image\/svg\+xml,([^"]+)"/)[1]
  const favicon = decodeURIComponent(encoded)
  const marks = [...html.matchAll(/<svg class="prumo-logo"[^]*?<\/svg>/g)].map(match => match[0])
  assert.equal(marks.length, 2, 'dashboard e abertura do guia usam o mesmo símbolo')
  const geometry = svg => [...svg.matchAll(/<(?:circle|line|path)\b[^>]*\/>/g)].map(match => match[0])
  for (const mark of marks) {
    assert.deepEqual(geometry(mark), geometry(favicon))
    assert.match(mark, /viewBox="0 0 28 80"/)
    assert.match(mark, /aria-hidden="true"/)
    assert.doesNotMatch(mark, /<rect/, 'a interface mantém o fundo transparente')
  }
  assert.match(favicon, /<circle[^>]*fill="#f1ece3"/)
  assert.match(favicon, /<line[^>]*stroke="#f1ece3"/)
  assert.match(favicon, /<path[^>]*fill="#e8b04b"/)
  assert.match(favicon, /<path[^>]*fill="#edc174"/)
  assert.match(favicon, /viewBox="0 0 80 80"/)
  assert.match(favicon, /<rect[^>]*rx="12"[^>]*fill="#0e0d0b"/,
    'o fundo escuro mantém o fio claro visível em abas claras ou escuras')
  assert.doesNotMatch(favicon, /<image|<script|http[^"]*\.(?:png|jpg)/)
  assert.doesNotMatch(html, /M5 10h12l-1\.4 5L11 29 6\.4 15z/)
})
