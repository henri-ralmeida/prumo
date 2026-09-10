#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { planInstall, applyInstall, restoreInstall, installationStatus, discoverInstallations, detectHarnesses } from '../lib/install.mjs'
import { launchUpdate, updateRequest } from '../lib/update.mjs'
import { selectHarnesses } from '../lib/prompt.mjs'
import { language, createTranslator, messages } from '../scripts/i18n.mjs'

let t = createTranslator(messages, language())
const print = (...parts) => console.log(...parts.map(part => t(part)))

function runInstall(options, { command = 'install', dryRun = false } = {}) {
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
    const result = applyInstall(plan, { dryRun })
    if (result.backup) print(t('Backup: {0}', result.backup))
    for (const group of result.groups) { print(`${group.name}: ${t(group.status)}`); for (const error of group.errors) print(t(error)) }
    if (result.groups.some(group => group.status === 'conflict')) process.exitCode = 2
    if (dryRun) print('Dry run: no files changed')
    else print('Open a new session to load Prumo and PO First')
  }
  const status = installationStatus(command === 'install' && !dryRun ? planInstall(options) : plan)
  print(`${t('installed')}: ${t(status.installed ? 'yes' : 'no')}; ${t('configured')}: ${t(status.configured ? 'yes' : 'no')}`)
  for (const warning of status.pendingActivation) if (command !== 'install' || !plan.warnings.includes(warning)) print(`${t('pending activation')}: ${t(warning)}`)
  if (status.pendingActivation.length || command === 'doctor' && !status.configured) process.exitCode = 2
}

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Prumo requires Node.js 22 or newer')
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    claude: { type: 'boolean' }, kiro: { type: 'boolean' }, codex: { type: 'boolean' }, all: { type: 'boolean' },
    lang: { type: 'string' }, 'dry-run': { type: 'boolean' }, project: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } })
  const lang = language(values.lang)
  t = createTranslator(messages, lang)
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  if (values.version) print(version)
  else if (values.help || positionals.length === 0) {
    print(`Prumo ${version} — graph-foreman + PO First\n\nprumo install [--all | --claude|--kiro|--codex] [--lang en|pt-BR] [--dry-run] [--project <path>]\nprumo update [--dry-run] [--lang en|pt-BR] [--project <path>]\nprumo doctor --claude|--kiro|--codex [--lang en|pt-BR] [--project <path>]\nprumo restore <backup>\n`)
    print('Install opens a selection of detected environments; --all selects all without prompting')
  } else if (['update', '_update'].includes(positionals[0])) {
    if (positionals.length !== 1 || ['claude', 'kiro', 'codex', 'all'].some(name => values[name])) throw new Error('Update automatically selects installed environments; do not select a harness')
    if (positionals[0] === 'update') {
      const request = { dryRun: values['dry-run'] ?? false, lang: values.lang, projects: (values.project ?? []).map(path => resolve(path)), cwd: process.cwd() }
      const code = await launchUpdate(request)
      if (code === null) print('No Prumo installations found; install an environment first')
      else process.exitCode = code
    } else {
      const request = updateRequest(process.env.PRUMO_UPDATE_REQUEST)
      const installed = discoverInstallations(request)
      if (!installed.length) print('No Prumo installations found; install an environment first')
      for (const entry of installed) {
        try {
          const variants = new Map()
          for (const root of entry.roots) {
            const saved = JSON.parse(readFileSync(join(root, 'prumo', '.prumo-install.json'), 'utf8')).lang
            const lang = request.lang ?? (['en', 'pt-BR'].includes(saved) ? saved : undefined)
            if (!variants.has(lang)) variants.set(lang, [])
            variants.get(lang).push(root)
          }
          for (const [lang, roots] of variants) {
            t = createTranslator(messages, language(lang))
            print(t('Updating {0} with Prumo {1}', entry.harness, version))
            runInstall({ harness: entry.harness, configRoot: entry.config, skillRoots: roots, onlyInstalled: true, cwd: request.cwd, projects: entry.projects, lang }, { dryRun: request.dryRun })
          }
        } catch (error) { console.error(`[prumo] ${t(error.message)}`); process.exitCode = 2 }
      }
    }
  } else if (positionals[0] === 'restore') {
    if (!positionals[1] || positionals.length !== 2) throw new Error('Restore needs a backup directory')
    print(t('Restored {0} files; run data was not changed', restoreInstall(positionals[1])))
  } else {
    const command = positionals[0]
    if (!['install', 'doctor'].includes(command) || positionals.length !== 1) throw new Error(t('Unknown command: {0}', positionals.join(' ')))
    const selected = ['claude', 'kiro', 'codex'].filter(name => values[name])
    if (selected.length > 1 || command === 'doctor' && selected.length !== 1) throw new Error('Choose exactly one of --claude, --kiro or --codex')
    if (values.all && (selected.length || command !== 'install')) throw new Error('Use --all only with install and without a harness flag')
    const options = { lang: values.lang, projects: values.project ?? [] }
    let harnesses = selected.length ? selected : detectHarnesses(options)
    if (!harnesses.length) throw new Error('No supported environments detected; choose --claude, --kiro or --codex explicitly')
    if (!selected.length) {
      print(t('Detected environments: {0}', harnesses.join(', ')))
      if (!values.all && (process.stdin.isTTY && process.stdout.isTTY || !values['dry-run'])) harnesses = await selectHarnesses(harnesses, { t })
    }
    for (const harness of harnesses) {
      try { runInstall({ ...options, harness }, { command, dryRun: values['dry-run'] }) }
      catch (error) {
        if (selected.length) throw error
        console.error(`[prumo] ${harness}: ${t(error.message)}`)
        process.exitCode = 2
      }
    }
  }
} catch (error) {
  console.error(`[prumo] ${t(error.message)}`)
  process.exitCode = 1
}
