#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolve, join, dirname } from 'node:path'
import { planInstall, applyInstall, restoreInstall, installationStatus, discoverInstallations, detectHarnesses, reconcileDashboardInstall } from '../lib/install.mjs'
import { assertUpdateVersion, globalCliState, launchUpdate, reconcileDashboardUpdate, updateGlobalCli, updateRequest } from '../lib/update.mjs'
import { releaseHistory } from '../lib/release-notes.mjs'
import { dashboardNeedsRepair, dashboardStatus, disableDashboard, enableDashboard, runDashboardForeground } from '../lib/autostart.mjs'
import { selectHarnesses } from '../lib/prompt.mjs'
import { language, createTranslator, messages } from '../scripts/i18n.mjs'

let t = createTranslator(messages, language())
const print = (...parts) => console.log(...parts.map(part => t(part)))
const color = (code, value, stream = process.stdout) => stream.isTTY && !('NO_COLOR' in process.env) ? `\x1b[${code}m${value}\x1b[0m` : value

function progressUi(enabled, stream = process.stdout) {
  let active = false
  const clear = () => {
    if (!active) return
    if (typeof stream.clearLine === 'function' && typeof stream.cursorTo === 'function') {
      stream.clearLine(0)
      stream.cursorTo(0)
    } else stream.write('\r\x1b[2K')
    active = false
  }
  return {
    update(percent, label) {
      if (!enabled || !stream.isTTY) return
      clear()
      active = true
      const width = 24
      const filled = Math.round(width * percent / 100)
      stream.write(`${color('36', `[${'='.repeat(filled)}${'-'.repeat(width - filled)}]`, stream)} ${String(percent).padStart(3)}% ${label}`)
    },
    clear,
    success(message, version) {
      clear()
      stream.write(`${color('32', `✓ ${message}`, stream)}\nPrumo v${version}\n`)
    },
  }
}

function printReleaseNotes(fromVersions, version) {
  const releases = releaseHistory(fromVersions, version)
  for (const release of releases) {
    if (releases.length > 1) console.log(`Prumo v${release.version}`)
    for (const section of release.sections) {
      console.log(color('1;36', section.title))
      for (const item of section.items) console.log(`- ${item}`)
    }
  }
}

function runInstall(options, { command = 'install', dryRun = false, quiet = false, reported = new Set(), onProgress } = {}) {
  const plan = planInstall(options)
  t = createTranslator(messages, plan.lang)
  if (command === 'install' && !quiet) {
    for (const group of plan.groups) {
      print(t('Changes / {0}', group.name))
      for (const item of group.changes) print(`  ${t(item.after === null ? 'remove' : 'write')}: ${item.file}`)
      for (const error of group.conflicts) print(`  ${t('conflict')}: ${t(error)}`)
      if (!group.changes.length && !group.conflicts.length) print('  ' + t('unchanged'))
    }
    for (const data of plan.data) print(data.action === 'migrate' ? t('Migrate existing data: {0} -> {1}', data.source, data.root) : t('Existing data stays in place: {0}', data.root))
    for (const warning of plan.warnings) print(`${t('pending activation')}: ${t(warning)}`)
    const result = applyInstall(plan, { dryRun, onProgress })
    if (result.backup) print(t('Backup: {0}', result.backup))
    for (const group of result.groups) { print(`${group.name}: ${t(group.status)}`); for (const error of group.errors) print(t(error)) }
    if (result.groups.some(group => group.status === 'conflict')) process.exitCode = 2
    if (dryRun) print('Dry run: no files changed')
    else print('Open a new session to load Prumo and PO First')
  } else if (command === 'install') {
    const result = applyInstall(plan, { dryRun, onProgress })
    for (const group of result.groups.filter(group => group.status === 'conflict')) {
      for (const error of group.errors) if (!reported.has(error)) {
        console.error(`[prumo] ${group.name}: ${t(error)}`)
        reported.add(error)
      }
    }
    if (result.groups.some(group => group.status === 'conflict')) process.exitCode = 2
  }
  const status = installationStatus(command === 'install' && !dryRun ? planInstall(options) : plan)
  if (!quiet) print(`${t('installed')}: ${t(status.installed ? 'yes' : 'no')}; ${t('configured')}: ${t(status.configured ? 'yes' : 'no')}`)
  for (const warning of status.pendingActivation) if (!reported.has(warning) && (command !== 'install' || !plan.warnings.includes(warning))) {
    (quiet ? console.error : print)(`${t('pending activation')}: ${t(warning)}`)
    reported.add(warning)
  }
  if (status.pendingActivation.length || command === 'doctor' && !status.configured) process.exitCode = 2
  return { ...status, viable: plan.groups.every(group => group.conflicts.length === 0) }
}

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Prumo requires Node.js 22 or newer')
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    claude: { type: 'boolean' }, kiro: { type: 'boolean' }, codex: { type: 'boolean' }, all: { type: 'boolean' },
    lang: { type: 'string' }, 'dry-run': { type: 'boolean' }, project: { type: 'string', multiple: true },
    check: { type: 'boolean' }, run: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } })
  const lang = language(values.lang)
  t = createTranslator(messages, lang)
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  if (values.version) print(version)
  else if (values.help || positionals.length === 0) {
    print(`Prumo ${version} — graph-foreman + PO First\n\nprumo install [--all | --claude|--kiro|--codex] [--lang en|pt-BR] [--dry-run] [--project <path>]\nprumo update [--dry-run] [--lang en|pt-BR] [--project <path>]\nprumo migrate [--check] [--run <name>]\nprumo doctor --claude|--kiro|--codex [--lang en|pt-BR] [--project <path>]\nprumo dashboard [enable|disable|status]\nprumo restore <backup>\n`)
    print('Install opens a selection of detected environments; --all selects all without prompting')
  } else if (positionals[0] === 'dashboard') {
    if (positionals.length > 2 || ['claude', 'kiro', 'codex', 'all'].some(name => values[name]) || values.lang || values['dry-run'] || values.project?.length) throw new Error('Dashboard accepts only enable, disable or status')
    const action = positionals[1]
    if (!action) process.exitCode = runDashboardForeground()
    else {
      if (!['enable', 'disable', 'status'].includes(action)) throw new Error(`Unknown dashboard action: ${action}`)
      const result = action === 'enable' ? await enableDashboard() : action === 'disable' ? await disableDashboard() : await dashboardStatus()
      print(`dashboard: ${result.process}; ${result.registered ? 'registered' : 'not registered'}; ${result.enabled ? 'enabled' : result.disabled ? 'disabled' : 'not configured'}`)
      print(`version: ${result.version ?? version}; port: ${result.port}; URL: ${result.url}`)
      if (result.conflict) console.error(`[prumo] Port ${result.port} is used by another process`)
      if (result.conflict || 'ok' in result && !result.ok) process.exitCode = 2
    }
  } else if (['update', '_update'].includes(positionals[0])) {
    if (positionals.length !== 1 || ['claude', 'kiro', 'codex', 'all'].some(name => values[name])) throw new Error('Update automatically selects installed environments; do not select a harness')
    if (positionals[0] === 'update') {
      const request = { dryRun: values['dry-run'] ?? false, lang: values.lang, projects: (values.project ?? []).map(path => resolve(path)), cwd: process.cwd(), updateCli: true, sourceVersion: version, globalVersion: globalCliState(packageRoot).version }
      const code = await launchUpdate(request, { onCurrent: current => print(t('Prumo is already up to date'), `v${current}`) })
      if (code === null) print('No Prumo installations found; install an environment first')
      else process.exitCode = code
    } else {
      const request = updateRequest(process.env.PRUMO_UPDATE_REQUEST)
      assertUpdateVersion(request.sourceVersion, version)
      const quiet = !request.dryRun
      const progress = progressUi(quiet)
      const previousVersions = [globalCliState(packageRoot).version]
      const dashboardBefore = await dashboardStatus()
      const installed = discoverInstallations({ ...request, onError(error) {
        console.error(`[prumo] ${error.message}`)
        process.exitCode = 2
      } })
      const checkpoint = join(homedir(), '.local/share/prumo/update-pending.json')
      try { previousVersions.push(...JSON.parse(readFileSync(checkpoint, 'utf8')).fromVersions) } catch { /* no unfinished update */ }
      for (const entry of installed) for (const root of entry.roots) {
        previousVersions.push(JSON.parse(readFileSync(join(root, 'prumo/.prumo-install.json'), 'utf8').replace(/^\uFEFF/, '')).version)
      }
      if (!request.dryRun) {
        mkdirSync(dirname(checkpoint), { recursive: true })
        const temporary = `${checkpoint}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify({ fromVersions: [...new Set(previousVersions.filter(value => typeof value === 'string'))], toVersion: version }))
        renameSync(temporary, checkpoint)
      }
      const reported = new Set()
      progress.update(10, t('Preparing Prumo update'))
      if (request.updateCli) {
        if (request.dryRun) print(t('Would update global Prumo CLI to {0}', version))
        else {
          progress.update(30, t('Updating Prumo CLI'))
          if (await updateGlobalCli(version) !== 0) throw new Error('Global Prumo CLI update failed')
        }
      }
      if (!installed.length) print('No Prumo installations found; install an environment first')
      for (const [index, entry] of installed.entries()) {
        try {
          const variants = new Map()
          for (const root of entry.roots) {
            const marker = JSON.parse(readFileSync(join(root, 'prumo', '.prumo-install.json'), 'utf8').replace(/^\uFEFF/, ''))
            previousVersions.push(marker.version)
            const saved = marker.lang
            const lang = request.lang ?? (['en', 'pt-BR'].includes(saved) ? saved : undefined)
            if (!variants.has(lang)) variants.set(lang, [])
            variants.get(lang).push(root)
          }
          for (const [lang, roots] of variants) {
            t = createTranslator(messages, language(lang))
            if (!quiet) print(t('Updating {0} with Prumo {1}', entry.harness, version))
            else progress.update(45 + Math.round(45 * (index + 1) / Math.max(installed.length, 1)), t('Updating {0}', entry.harness))
            const percent = 45 + Math.round(45 * (index + 1) / Math.max(installed.length, 1))
            runInstall({ harness: entry.harness, configRoot: entry.config, skillRoots: roots, onlyInstalled: true, cwd: request.cwd, projects: entry.projects, lang }, { dryRun: request.dryRun, quiet, reported,
              onProgress: event => progress.update(percent, t('Migrating workspace {0}', event.name)) })
          }
        } catch (error) { console.error(`[prumo] ${t(error.message)}`); process.exitCode = 2 }
      }
      const globalPackage = globalCliState(packageRoot).packageRoot ?? packageRoot
      const dashboard = await reconcileDashboardUpdate({ dryRun: request.dryRun, before: dashboardBefore, dashboardOptions: { packageRoot: globalPackage } })
      if (dashboard.action === 'enable' && request.dryRun) print('Would enable and start the Prumo dashboard')
      if (dashboard.action === 'restart' && request.dryRun) print('Would restart the enabled Prumo dashboard')
      else if (dashboard.action === 'disabled' && request.dryRun) print('Dashboard remains disabled by user preference')
      if (!dashboard.ok) {
        console.error(`[prumo] Dashboard restart failed${dashboard.status.conflict ? `: port ${dashboard.status.port} is used by another process` : dashboard.status.error ? `: ${dashboard.status.error}` : ''}`)
        process.exitCode = 2
      }
      if (quiet && !process.exitCode) {
        t = createTranslator(messages, lang)
        progress.success(t('Prumo updated successfully'), version)
        printReleaseNotes(previousVersions, version)
        rmSync(checkpoint, { force: true })
      } else {
        progress.clear()
        if (quiet) {
          print('Update incomplete; resolve the reported issues and run prumo update again')
          print(`Prumo v${globalCliState(packageRoot).version ?? version}`)
          printReleaseNotes(previousVersions, version)
        }
      }
    }
  } else if (positionals[0] === 'migrate') {
    if (positionals.length !== 1 || ['claude', 'kiro', 'codex', 'all'].some(name => values[name]) || values.lang || values['dry-run'] || values.project?.length) throw new Error('Migrate accepts only --check and --run <name>')
    const engineArgs = [fileURLToPath(new URL('../scripts/engine.mjs', import.meta.url)), 'migrate']
    if (values.check) engineArgs.push('--check')
    if (values.run) engineArgs.push('--run', values.run)
    const result = spawnSync(process.execPath, engineArgs, { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
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
      const allCurrent = command === 'install' && harnesses.every(harness => {
        const status = installationStatus(planInstall({ ...options, harness }))
        return status.installed && status.configured
      })
      if (!allCurrent && !values.all && (process.stdin.isTTY && process.stdout.isTTY || !values['dry-run'])) harnesses = await selectHarnesses(harnesses, { t })
    }
    let successfulHarnesses = 0
    if (command === 'install') {
      const current = []
      const pending = []
      for (const harness of harnesses) {
        const status = installationStatus(planInstall({ ...options, harness }))
        ;(status.installed && status.configured ? current : pending).push(harness)
      }
      if (current.length) print(color('32', t('Prumo v{0} is already installed in {1}', version, current.join(', '))))
      successfulHarnesses = current.length
      harnesses = pending
    }
    const dryRun = values['dry-run'] ?? false
    const quiet = command === 'install' && !dryRun
    const lifecycleInstall = command === 'install' && values.all === true && !selected.length && !values.lang && !values['dry-run'] && !values.project?.length &&
      process.env.PRUMO_POSTINSTALL_LIFECYCLE === '1' && process.env.npm_lifecycle_event === 'postinstall' &&
      resolve(process.env.npm_package_json ?? '') === join(packageRoot, 'package.json')
    const progress = progressUi(quiet)
    if (quiet) progress.update(10, t('Preparing Prumo installation'))
    let global = command === 'install' ? lifecycleInstall ? { version, packageRoot } : globalCliState(packageRoot) : null
    if (command === 'install' && global.version !== version) {
      if (dryRun) print(t('Would install global Prumo CLI {0}', version))
      else {
        progress.update(30, t('Installing Prumo CLI'))
        if (await updateGlobalCli(version) !== 0) {
          progress.clear()
          throw new Error('Global Prumo CLI installation failed')
        }
        global = globalCliState(packageRoot)
      }
    }
    for (const [index, harness] of harnesses.entries()) {
      try {
        if (quiet) progress.update(40 + Math.round(50 * (index + 1) / Math.max(harnesses.length, 1)), t('Installing {0}', harness))
        const status = runInstall({ ...options, harness }, { command, dryRun, quiet })
        if (command === 'install' && (dryRun ? status.viable : status.installed && status.configured)) successfulHarnesses += 1
      } catch (error) {
        progress.clear()
        if (selected.length) throw error
        console.error(`[prumo] ${harness}: ${t(error.message)}`)
        process.exitCode = 2
      }
    }
    if (command === 'install') {
      const dashboard = await reconcileDashboardInstall(successfulHarnesses, { dryRun, dashboardOptions: { packageRoot: global?.packageRoot ?? packageRoot } })
      if (dashboard.action === 'enable') print(dryRun ? 'Would enable and start the Prumo dashboard' : `Dashboard enabled: ${dashboard.status.url}`)
      else if (dashboard.action === 'restart') print(dryRun ? 'Would restart the enabled Prumo dashboard' : `Dashboard restarted: ${dashboard.status.url}`)
      else if (dashboard.action === 'disabled') print('Dashboard remains disabled by user preference')
      if (!dashboard.ok) {
        console.error(`[prumo] Dashboard setup failed${dashboard.status?.error ? `: ${dashboard.status.error}` : dashboard.status?.conflict ? `: port ${dashboard.status.port} is used by another process` : ''}`)
        process.exitCode = 2
      }
    } else {
      const dashboard = await dashboardStatus()
      print(`dashboard: ${dashboard.process}; ${dashboard.registered ? 'registered' : 'not registered'}; ${dashboard.enabled ? 'enabled' : dashboard.disabled ? 'disabled' : 'not configured'}`)
      if (dashboardNeedsRepair(dashboard)) process.exitCode = 2
    }
    if (quiet && !process.exitCode) progress.success(t('Prumo installed successfully'), version)
    else progress.clear()
  }
} catch (error) {
  console.error(`[prumo] ${t(error.message)}`)
  process.exitCode = 1
}
