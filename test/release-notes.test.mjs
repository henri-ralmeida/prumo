import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { releaseNotes } from '../lib/release-notes.mjs'

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

test('current release has concise English update highlights with descriptive subtitles', () => {
  const notes = releaseNotes(version)
  assert.deepEqual(notes.map(section => section.title), [
    'Fixed — Legacy run recovery',
    'Fixed — Windows state persistence',
    'Added — Executor alias and review guidance'
  ])
  assert.ok(notes.flatMap(section => section.items).includes('Preserve terminal contracts during sync-plan and retry'))
  assert.deepEqual(releaseNotes(version, 'pt-BR'), notes)
  assert.deepEqual(releaseNotes('0.0.0'), [])
})
