import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { releaseHistory, releaseNotes } from '../lib/release-notes.mjs'

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

test('atualização da 2.4.8 apresenta as funcionalidades da 2.5.0', () => {
  const history = releaseHistory(['2.4.8'], '2.5.0')
  assert.deepEqual(history.map(release => release.version), ['2.5.0'])
  assert.deepEqual(history[0].sections.map(section => section.title), [
    'Added — Explicit task scopes', 'Added — Readiness and shared resources',
    'Improved — Scope confirmations',
    'Added — Shared agent capacity', 'Fixed — External blocks and live clock',
    'Added — Dashboard changelog',
    'Improved — Dependencies and first-plan guidance',
  ])
})

test('atualização da 2.4.7 mostra somente as notas novas da 2.4.8', () => {
  const history = releaseHistory(['2.4.7'], '2.4.8')
  assert.deepEqual(history.map(release => release.version), ['2.4.8'])
  assert.deepEqual(history[0].sections.map(section => section.title), [
    'Added — Dashboard update notice', 'Fixed — Planning scope before execution',
  ])
})

test('histórico ignora versões de tipos inválidos sem modificar os registros recebidos', () => {
  const invalid = [null, 42, true, ['2.3.1'], { version: '2.3.1' }, 'invalid']
  const before = structuredClone(invalid)
  assert.deepEqual(releaseHistory(invalid, version), [{ version, sections: releaseNotes(version) }])
  assert.deepEqual(releaseHistory([...invalid, '2.3.0'], version), releaseHistory(['2.3.0'], version))
  assert.deepEqual(invalid, before)
})

test('current release has concise English update highlights with descriptive subtitles', () => {
  const notes = releaseNotes(version)
  assert.ok(notes.length > 0, 'a versão atual precisa ter notas de atualização')
  for (const section of notes) {
    assert.match(section.title, /^(Added|Changed|Fixed|Improved) — \S.+$/)
    assert.ok(Array.isArray(section.items) && section.items.length > 0)
    assert.ok(section.items.every(item => typeof item === 'string' && item.trim().length > 0))
  }
  assert.deepEqual(releaseNotes('2.4.4').map(section => section.title), [
    'Fixed — Dashboard activity clocks',
    'Improved — Dashboard details and sidebar',
  ])
  assert.deepEqual(releaseNotes('2.4.3').map(section => section.title), [
    'Improved — Dashboard sidebar',
    'Fixed — Published update verification',
  ])
  assert.deepEqual(releaseNotes('2.4.2').map(section => section.title), [
    'Improved — Dashboard navigation and presentation',
    'Fixed — Plan contracts and legacy compatibility',
    'Improved — Cross-platform verification',
  ])
  assert.deepEqual(releaseNotes('2.4.1').map(section => section.title), ['Improved — Update history and dashboard activity'])
  assert.deepEqual(releaseNotes('2.4.0').map(section => section.title), [
    'Fixed — Dashboard shutdown before update',
    'Fixed — Installation and task identity',
    'Improved — Behavioral verification',
    'Improved — Dashboard filters and guide',
  ])
  assert.deepEqual(releaseNotes('2.1.1').map(section => section.title), ['Fixed — Dashboard restart after update'])
  assert.deepEqual(releaseNotes('2.1.0').map(section => section.title), [
    'Changed — Results focused on the parallel gain',
    'Improved — Run selector progress',
    'Improved — Dashboard interactions',
    'Added — Engine identity and planning metadata',
    'Fixed — Shell-aware commands and translations',
    'Fixed — Updating 1.2.x runs',
    'Changed — Skill organized by step'
  ])
  assert.ok(releaseNotes('2.1.0').flatMap(section => section.items).includes('Let started 1.2 task-planned attempts continue review, validation and completion after the update'))
  assert.ok(releaseNotes('2.0.0').flatMap(section => section.items).includes('Count activity between nearby recorded milestones and mark longer gaps unmeasured'))
  assert.ok(releaseNotes('1.3.17').flatMap(section => section.items).includes('Show bounded field-level changes and exact dependency differences after sync-plan'))
  assert.ok(releaseNotes('1.3.11').flatMap(section => section.items).includes('Keep every task and phase visible while dimming cards outside the selected filter'))
  assert.ok(releaseNotes('1.3.2').flatMap(section => section.items).includes('Keep one discussion and one planner when the user names one task'))
  assert.ok(releaseNotes('1.3.1').flatMap(section => section.items).includes('Open phases in declared order after earlier work is terminal'))
  assert.ok(releaseNotes('1.3.0').flatMap(section => section.items).includes('Start the read-only dashboard after global npm installation'))
  assert.ok(releaseNotes('1.2.2').flatMap(section => section.items).includes('Select permitted question tools from the current harness session'))
  assert.ok(releaseNotes('1.2.0').flatMap(section => section.items).includes('A dedicated planner researches each new task before execution'))
  assert.ok(releaseNotes('1.1.2').flatMap(section => section.items).includes('Preserve terminal contracts during sync-plan and retry'))
  assert.deepEqual(releaseNotes(version, 'pt-BR'), notes)
  assert.deepEqual(releaseNotes('0.0.0'), [])
})

test('update history includes every missed release with the newest version first', () => {
  assert.deepEqual(releaseHistory(['1.0.2'], '1.0.9').map(release => release.version),
    ['1.0.9', '1.0.8', '1.0.7', '1.0.6', '1.0.5', '1.0.4', '1.0.3'])
  const history = releaseHistory(['1.2.2', '1.0.8'], version)
  assert.equal(history[0].version, version)
  assert.deepEqual(history.slice(-3).map(release => release.version), ['1.1.0', '1.0.10', '1.0.9'])
  assert.equal(history.at(-1).version, '1.0.9')
  assert.deepEqual(releaseHistory([version], version), [])
  assert.deepEqual(releaseHistory([], version), [{ version, sections: releaseNotes(version) }])
  assert.deepEqual(releaseHistory(null, version), releaseHistory([], version))
  assert.deepEqual(releaseHistory(undefined, version), releaseHistory([], version))
})
