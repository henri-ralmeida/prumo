import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { releaseNotes } from '../lib/release-notes.mjs'

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

test('current release has concise English update highlights with descriptive subtitles', () => {
  const notes = releaseNotes(version)
  assert.deepEqual(notes.map(section => section.title), [
    'Fixed — Native discovery questions',
    'Added — Task progress visibility'
  ])
  assert.ok(notes.flatMap(section => section.items).includes('Select permitted question tools from the current harness session'))
  assert.ok(releaseNotes('1.2.0').flatMap(section => section.items).includes('A dedicated planner researches each new task before execution'))
  assert.ok(releaseNotes('1.1.2').flatMap(section => section.items).includes('Preserve terminal contracts during sync-plan and retry'))
  assert.deepEqual(releaseNotes(version, 'pt-BR'), notes)
  assert.deepEqual(releaseNotes('0.0.0'), [])
})
