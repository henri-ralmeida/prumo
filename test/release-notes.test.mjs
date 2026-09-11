import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { releaseNotes } from '../lib/release-notes.mjs'

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

test('current release has concise localized update highlights', () => {
  const en = releaseNotes(version, 'en')
  const pt = releaseNotes(version, 'pt-BR')
  assert.deepEqual(en.map(section => section.title), ['Fixed', 'Added'])
  assert.deepEqual(pt.map(section => section.title), ['Corrigido', 'Adicionado'])
  assert.ok(en.flatMap(section => section.items).includes('Safe retry after approved contract changes'))
  assert.ok(pt.flatMap(section => section.items).includes('Retry seguro após alterações aprovadas de contrato'))
  assert.deepEqual(releaseNotes(version, 'unsupported'), en)
  assert.deepEqual(releaseNotes('0.0.0', 'en'), [])
})
