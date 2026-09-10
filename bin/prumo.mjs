#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { planInstall, applyInstall, restoreInstall, installationStatus } from '../lib/install.mjs'
import { language, createTranslator, messages } from '../scripts/i18n.mjs'

let t = createTranslator(messages, language())
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('PRUMO requires Node.js 22 or newer')
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    claude: { type: 'boolean' }, kiro: { type: 'boolean' }, codex: { type: 'boolean' },
    lang: { type: 'string' }, 'dry-run': { type: 'boolean' }, project: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } })
  const lang = language(values.lang)
  t = createTranslator(messages, lang)
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  const print = (...parts) => console.log(...parts.map(part => t(part)))
  if (values.version) print(version)
  else if (values.help || positionals.length === 0) {
    print(`PRUMO ${version} — graph-foreman + PO First\n\nprumo install --claude|--kiro|--codex [--lang en|pt-BR] [--dry-run] [--project <path>]\nprumo doctor --claude|--kiro|--codex [--lang en|pt-BR] [--project <path>]\nprumo restore <backup>\n`)
  } else if (positionals[0] === 'restore') {
    if (!positionals[1] || positionals.length !== 2) throw new Error('Restore needs a backup directory')
    print(t('Restored {0} files; run data was not changed', restoreInstall(positionals[1])))
  } else {
    const command = positionals[0]
    if (!['install', 'doctor'].includes(command) || positionals.length !== 1) throw new Error(t('Unknown command: {0}', positionals.join(' ')))
    const selected = ['claude', 'kiro', 'codex'].filter(name => values[name])
    if (selected.length !== 1) throw new Error('Choose exactly one of --claude, --kiro or --codex')
    const options = { harness: selected[0], lang: values.lang, projects: values.project ?? [] }
    const plan = planInstall(options)
    t = createTranslator(messages, plan.lang)
    if (command === 'install') {
      for (const group of plan.groups) {
        print(t('Changes / {0}', group.name))
        for (const item of group.changes) print(`  ${t(item.after === null ? 'remove' : 'write')}: ${item.file}`)
        for (const error of group.conflicts) print(`  ${t('conflict')}: ${t(error)}`)
        if (!group.changes.length && !group.conflicts.length) print('  ' + t('unchanged'))
      }
      for (const data of plan.data) print(t('Existing data stays in place: {0}', data.root))
      for (const warning of plan.warnings) print(`${t('pending activation')}: ${t(warning)}`)
      const result = applyInstall(plan, { dryRun: values['dry-run'] })
      if (result.backup) print(t('Backup: {0}', result.backup))
      for (const group of result.groups) { print(`${group.name}: ${t(group.status)}`); for (const error of group.errors) print(t(error)) }
      if (result.groups.some(group => group.status === 'conflict')) process.exitCode = 2
      if (values['dry-run']) print('Dry run: no files changed')
      else print('Open a new session to load PRUMO and PO First')
    }
    const status = installationStatus(command === 'install' && !values['dry-run'] ? planInstall(options) : plan)
    print(`${t('installed')}: ${t(status.installed ? 'yes' : 'no')}; ${t('configured')}: ${t(status.configured ? 'yes' : 'no')}`)
    for (const warning of status.pendingActivation) if (command !== 'install' || !plan.warnings.includes(warning)) print(`${t('pending activation')}: ${t(warning)}`)
    if (status.pendingActivation.length || command === 'doctor' && !status.configured) process.exitCode = 2
  }
} catch (error) {
  console.error(`[prumo] ${t(error.message)}`)
  process.exitCode = 1
}
