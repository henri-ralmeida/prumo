import { readFileSync } from 'node:fs'

const notes = JSON.parse(readFileSync(new URL('../scripts/release-notes.json', import.meta.url), 'utf8'))

export function releaseNotes(version) {
  return notes[version]?.en ?? []
}
