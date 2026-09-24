import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createTranslator, messages } from './i18n.mjs'
import { DEFAULT_GAIN_ASSUMPTIONS, gainAssumptionKey, calculateGain, renderGainPanel, renderGainEstimate } from './dashboard-gains.mjs'

export function dashboardWithCatalog(html) {
  const block = `/*PRUMO_I18N_START*/\nconst PRUMO_MESSAGES = ${JSON.stringify(messages)}\n${createTranslator.toString()}\n/*PRUMO_I18N_END*/`
  if (!html.includes('/*PRUMO_I18N_START*/')) throw new Error('Dashboard translation marker missing')
  if (!html.includes('/*PRUMO_GAIN_HELPERS_START*/')) throw new Error('Dashboard gain-helper marker missing')
  const helpers = `/*PRUMO_GAIN_HELPERS_START*/\nconst DEFAULT_GAIN_ASSUMPTIONS = Object.freeze(${JSON.stringify(DEFAULT_GAIN_ASSUMPTIONS)})\n${[gainAssumptionKey, calculateGain, renderGainPanel, renderGainEstimate].map(fn => fn.toString()).join('\n\n')}\n/*PRUMO_GAIN_HELPERS_END*/`
  return html
    .replace(/\/\*PRUMO_I18N_START\*\/[\s\S]*?\/\*PRUMO_I18N_END\*\//, () => block)
    .replace(/\/\*PRUMO_GAIN_HELPERS_START\*\/[\s\S]*?\/\*PRUMO_GAIN_HELPERS_END\*\//, () => helpers)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = new URL('./dashboard.html', import.meta.url)
  const before = readFileSync(file, 'utf8')
  const after = dashboardWithCatalog(before)
  if (process.argv.includes('--write')) writeFileSync(file, after)
  else if (before !== after) throw new Error('Run node scripts/build-dashboard.mjs --write after editing translations')
}
