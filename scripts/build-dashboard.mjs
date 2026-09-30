import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createTranslator, messages } from './i18n.mjs'
import { taskManualEstimateMinutes, commandMetricsForRun, calculateGain, renderGainPanel, renderManualCoordination } from './dashboard-gains.mjs'
import { createPrumoOnboarding } from './onboarding.mjs'
import { createGuideDemoData } from './dashboard-guide-demo.mjs'

export function dashboardWithCatalog(html) {
  // O guia compartilha a identidade das entidades; alterar o SVG real atualiza a demonstracao.
  const roles = { orchNode: ['orchestrator', 'Coordinates the approved plan'], planNode: ['planner', 'Turns scope into tasks'], execNode: ['executor', 'Implements and records evidence'], revNode: ['reviewer', 'Verifies independently'] }
  const guideRoles = Object.entries(roles).map(([id, [role, description]]) => {
    const source = html.match(new RegExp('<div id="' + id + '" class="role"[\\s\\S]*?<i class="obar"></i></div>'))?.[0]
    if (!source) throw new Error(`Entidade do dashboard ausente: ${id}`)
    return source.replace(/^<div[^>]*>/, `<button type="button" class="role guide-role role-${role} live" data-guide-role="${role}" aria-pressed="false">`)
      .replace('</div>', '</button>').replace(/ id="[^"]*"/g, '')
      .replace(/<span class="os"[^>]*>[\s\S]*?<\/span><\/span>/, `<span class="os" data-i18n="${description}">${description}</span></span>`)
  }).join('')
  const block = '/*PRUMO_I18N_START*/\nconst PRUMO_MESSAGES = ' + JSON.stringify(messages) + '\n' + createTranslator.toString() + '\n/*PRUMO_I18N_END*/'
  const guide = '/*PRUMO_GUIDE_START*/\n' + createGuideDemoData.toString() + '\n' + createPrumoOnboarding.toString() + '\n/*PRUMO_GUIDE_END*/'
  if (!html.includes('/*PRUMO_I18N_START*/')) throw new Error('Dashboard translation marker missing')
  if (!html.includes('/*PRUMO_GAIN_HELPERS_START*/')) throw new Error('Dashboard gain-helper marker missing')
  if (!html.includes('/*PRUMO_GUIDE_START*/')) throw new Error('Dashboard onboarding marker missing')
  const helpers = '/*PRUMO_GAIN_HELPERS_START*/\n' +
    [taskManualEstimateMinutes, commandMetricsForRun, calculateGain, renderGainPanel, renderManualCoordination].map(fn => fn.toString()).join('\n\n') +
    '\n/*PRUMO_GAIN_HELPERS_END*/'
  return html
    .replace(/\/\*PRUMO_I18N_START\*\/[\s\S]*?\/\*PRUMO_I18N_END\*\//, () => block)
    .replace(/\/\*PRUMO_GAIN_HELPERS_START\*\/[\s\S]*?\/\*PRUMO_GAIN_HELPERS_END\*\//, () => helpers)
    .replace(/\/\*PRUMO_GUIDE_START\*\/[\s\S]*?\/\*PRUMO_GUIDE_END\*\//, () => guide)
    .replace(/(<section id="guideMockRoles"[^>]*>)[\s\S]*?<\/section>/, (_match, opening) => opening + guideRoles + '</section>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = new URL('./dashboard.html', import.meta.url)
  const before = readFileSync(file, 'utf8')
  const after = dashboardWithCatalog(before)
  if (process.argv.includes('--write')) writeFileSync(file, after)
  else if (before !== after) throw new Error('Run node scripts/build-dashboard.mjs --write after editing translations')
}
