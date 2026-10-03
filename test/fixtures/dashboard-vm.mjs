import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, Script } from 'node:vm'

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const dashboardCoverageSourcePath = join(repo, '.test-output', 'coverage-sources', 'dashboard-inline.mjs')
const runnerSourcePath = fileURLToPath(new URL('./dashboard-vm.mjs', import.meta.url))
const languageSpan = '/*PRUMO_LANGUAGE*/"en"'

export function dashboardCoverageSourcePathForRoot(root = repo) {
  return join(resolve(root), '.test-output', 'coverage-sources', 'dashboard-inline.mjs')
}

function normalizeRealm(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) Object.setPrototypeOf(value, Array.prototype)
  } else if (Object.prototype.toString.call(value) === '[object Object]' && Object.getPrototypeOf(value) !== Object.prototype) {
    Object.setPrototypeOf(value, Object.prototype)
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.get || descriptor?.set) continue
    normalizeRealm(value[key], seen)
  }
  return value
}

/*
 * O Node não coleta cobertura de uma string executada sem filename. O fixture
 * executa a fonte inline canônica em um vm.Context isolado, com Script.filename
 * apontando para a cópia física que o c8 lê. Cada comando de teste usa um
 * segundo filename fora do include para não transformar o código do teste em
 * linhas do dashboard.
 */

/**
 * Prepara somente a fonte canônica para o c8; não compila nem executa JavaScript.
 * O preparador é exportado para o coletor escrever a fonte antes do manifesto.
 * O arquivo não contém invólucro nem sourceURL absoluto: seus bytes e quebras
 * de linha são os mesmos do script inline servido pelo dashboard.
 */
export function extractDashboardScript(html) {
  const match = String(html).replaceAll('\r\n', '\n').match(/<script>([\s\S]*?)<\/script>/)
  if (!match) throw new Error('Script inline do dashboard ausente no HTML canônico')
  return match[1]
}

export function prepareDashboardCoverageSource(sourceScript, { root = repo, htmlPath } = {}) {
  const input = sourceScript && typeof sourceScript === 'object'
    ? sourceScript
    : { sourceScript, htmlPath }
  const html = input.html ?? (input.htmlPath ? readFileSync(input.htmlPath, 'utf8') : null)
  const rawSource = input.sourceScript ?? (html != null ? extractDashboardScript(html) : null)
  if (rawSource == null) throw new Error('Fonte canônica do dashboard não informada')
  const source = String(rawSource).replaceAll('\r\n', '\n')
  const path = dashboardCoverageSourcePathForRoot(input.root ?? root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source, 'utf8')
  return { path, source }
}

/** Insere o idioma sem alterar o comprimento nem as linhas do script canônico. */
export function injectDashboardLanguage(sourceScript, lang) {
  const source = String(sourceScript)
  const localized = JSON.stringify(lang)
  const padding = languageSpan.length - localized.length
  if (padding < 4) throw new Error(`O idioma ${lang} não cabe no span canônico do dashboard`)
  const replacement = localized + `/*${' '.repeat(padding - 4)}*/`
  if (replacement.length !== languageSpan.length) throw new Error('A injeção de idioma alterou o comprimento do script do dashboard')
  const index = source.indexOf(languageSpan)
  if (index < 0) throw new Error('Span de idioma do dashboard ausente na fonte canônica')
  return source.slice(0, index) + replacement + source.slice(index + languageSpan.length)
}

/**
 * Mantém o boot no mesmo intervalo de bytes, mas em um ramo impossível.
 * O ramo falso é necessário para o V8 emitir uma faixa de cobertura zero;
 * somente preencher com espaços faria o c8 assumir que as linhas ausentes
 * foram cobertas pelo range superior do script.
 */
export function disableDashboardBoot(sourceScript) {
  const source = String(sourceScript)
  const marker = '\nconst GUIDE_FRAMES'
  const index = source.indexOf(marker)
  if (index < 0) throw new Error('Ponto de boot do dashboard ausente na fonte canônica')
  const sidebarMarker = '\napplySidebar()'
  const sidebarIndex = source.lastIndexOf(sidebarMarker, index)
  if (sidebarIndex < 0) throw new Error('Chamada de layout do dashboard ausente na fonte canônica')
  const open = 'if(false){'
  const sidebarStart = sidebarIndex + 1
  const replacedSidebar = open + ' '.repeat(sidebarMarker.length - 1 - open.length)
  const sourceWithGuard = source.slice(0, sidebarStart) + replacedSidebar + source.slice(sidebarStart + sidebarMarker.length - 1)
  const tail = sourceWithGuard.slice(index)
  const masked = [...tail].map(char => /[\r\n]/.test(char) ? char : ' ')
  const close = masked.findLastIndex(char => char !== '\r' && char !== '\n')
  masked[close] = '}'
  return sourceWithGuard.slice(0, index) + masked.join('')
}

export function runDashboardScript(script, sandbox, { sourceScript = script } = {}) {
  const canonical = String(sourceScript).replaceAll('\r\n', '\n')
  const execution = String(script).replaceAll('\r\n', '\n')
  if (execution.length !== canonical.length) throw new Error('A execução do dashboard não preservou o comprimento da fonte canônica')
  prepareDashboardCoverageSource(canonical)
  const context = createContext(sandbox)
  const renderOnly = !execution.includes('const GUIDE_FRAMES')
  new Script(execution, { filename: dashboardCoverageSourcePath }).runInContext(context)
  if (renderOnly) new Script('applySidebar()', { filename: runnerSourcePath }).runInContext(context)
  return {
    run(code, values = {}) {
      Object.assign(sandbox, values)
      const result = new Script(String(code), { filename: runnerSourcePath }).runInContext(context)
      for (const value of Object.values(values)) normalizeRealm(value)
      if (result && typeof result.then === 'function') return Promise.resolve(result).then(value => normalizeRealm(value))
      return normalizeRealm(result)
    },
  }
}
