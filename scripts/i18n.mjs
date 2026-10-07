import { readFileSync } from 'node:fs'
import { regionalLanguage } from './region.mjs'

export const messages = JSON.parse(readFileSync(new URL('./messages.json', import.meta.url), 'utf8'))

export function language(requested, env = process.env, detect = regionalLanguage) {
  if (requested !== undefined && !['en', 'pt-BR'].includes(requested)) throw new Error('Language must be en or pt-BR')
  let installed
  try { installed = JSON.parse(readFileSync(new URL('../.prumo-install.json', import.meta.url), 'utf8')).lang } catch { /* Código-fonte local ou idioma não configurado. */ }
  const detected = requested ?? env.PRUMO_LANG ?? installed ?? detect({ env })
  return /^pt(?:[-_]|$)/i.test(detected) ? 'pt-BR' : 'en'
}

export function localizeDashboard(html, lang) {
  return html.replace(/\/\*PRUMO_LANGUAGE\*\/"(?:en|pt-BR)"/, () => JSON.stringify(lang))
}

// Função pura: o mesmo tradutor é incorporado ao dashboard autossuficiente.
export function createTranslator(dictionary, lang) {
  const templates = Object.entries(dictionary).filter(([key]) => /\{\d+\}/.test(key)).map(([key, translated]) => {
    const slots = []
    const numericDuration = /^\{0\}[smh]$/.test(key)
    const pattern = key.split(/(\{\d+\})/).map(part => {
      if (/^\{\d+\}$/.test(part)) { slots.push(Number(part.slice(1, -1))); return numericDuration ? '(\\d+)' : '(.*?)' }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }).join('')
    return { pattern: new RegExp(`^${pattern}$`, 's'), slots, translated, literal: key.replace(/\{\d+\}/g, '').length }
  })
  // O modelo mais específico prevalece: uma chave genérica como "{0} of {1}" não pode absorver uma frase
  // com chave própria apenas por conter " of ". Ordenar pelo texto literal mantém a ordem do catálogo no desempate.
  templates.sort((a, b) => b.literal - a.literal)
  function translate(value, ...parameters) {
    if (typeof value !== 'string') return value
    const fill = (text, values) => text.replace(/\{(\d+)\}/g, (all, index) => values[index] === undefined ? all : String(values[index]))
    if (parameters.length) return fill(lang === 'pt-BR' ? dictionary[value] ?? value : value, parameters)
    if (lang !== 'pt-BR') return value
    if (Object.hasOwn(dictionary, value)) return dictionary[value]
    for (const { pattern, slots, translated } of templates) {
      const match = pattern.exec(value)
      // Um campo nunca absorve o prefixo "[prumo] " do log; o prefixo é removido abaixo e o restante é processado novamente.
      if (match && !match.slice(1).some(part => /^\s*\[prumo\] /.test(part))) return translated.replace(/\{(\d+)\}/g, (_, index) => match[slots.indexOf(Number(index)) + 1])
    }
    const prefix = /^(\s*\[prumo\] )(ERROR: )?([\s\S]*)$/.exec(value)
    if (prefix) return prefix[1] + (prefix[2] ? 'ERRO: ' : '') + translate(prefix[3])
    return value
  }
  return translate
}

const index = process.argv.indexOf('--lang')
let selected
try { selected = language(index >= 0 ? process.argv[index + 1] : undefined) }
catch (error) { console.error(error.message); process.exit(1) }
export const tr = createTranslator(messages, selected)
export const log = (...values) => console.log(...values.map(value => tr(value)))
export const errorLog = (...values) => console.error(...values.map(value => tr(value)))
