import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { releaseHistory, releaseNotes } from '../lib/release-notes.mjs'

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

test('current release has concise English update highlights with descriptive subtitles', () => {
  const notes = releaseNotes(version)
  assert.deepEqual(notes.map(section => section.title), [
    'Fixed — Filtered graph context',
    'Fixed — Safe candidate updates',
    'Fixed — macOS path aliases'
  ])
  assert.ok(notes.flatMap(section => section.items).includes('Keep every task and phase visible while dimming cards outside the selected filter'))
  assert.ok(releaseNotes('1.3.2').flatMap(section => section.items).includes('Keep one discussion and one planner when the user names one task'))
  assert.ok(releaseNotes('1.3.1').flatMap(section => section.items).includes('Open phases in declared order after earlier work is terminal'))
  assert.ok(releaseNotes('1.3.0').flatMap(section => section.items).includes('Start the read-only dashboard after global npm installation'))
  assert.ok(releaseNotes('1.2.2').flatMap(section => section.items).includes('Select permitted question tools from the current harness session'))
  assert.ok(releaseNotes('1.2.0').flatMap(section => section.items).includes('A dedicated planner researches each new task before execution'))
  assert.ok(releaseNotes('1.1.2').flatMap(section => section.items).includes('Preserve terminal contracts during sync-plan and retry'))
  assert.deepEqual(releaseNotes(version, 'pt-BR'), notes)
  assert.deepEqual(releaseNotes('0.0.0'), [])
})

test('update history includes every missed release from the oldest installation', () => {
  assert.deepEqual(releaseHistory(['1.0.2'], '1.0.9').map(release => release.version),
    ['1.0.3', '1.0.4', '1.0.5', '1.0.6', '1.0.7', '1.0.8', '1.0.9'])
  const history = releaseHistory(['1.2.2', '1.0.8'], version)
  assert.equal(history[0].version, '1.0.9')
  assert.deepEqual(history.slice(0, 3).map(release => release.version), ['1.0.9', '1.0.10', '1.1.0'])
  assert.equal(history.at(-1).version, version)
  assert.deepEqual(releaseHistory([version], version), [])
  assert.deepEqual(releaseHistory([], version), [{ version, sections: releaseNotes(version) }])
})
