import { readFileSync } from 'node:fs'

const notes = JSON.parse(readFileSync(new URL('../scripts/release-notes.json', import.meta.url), 'utf8'))

export function releaseNotes(version) {
  return notes[version]?.en ?? []
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function releaseHistory(fromVersions, toVersion) {
  const valid = (fromVersions ?? []).filter(version => /^\d+\.\d+\.\d+$/.test(version))
  if (!valid.length) return [{ version: toVersion, sections: releaseNotes(toVersion) }]
  const fromVersion = valid.sort(compareVersions)[0]
  return Object.keys(notes)
    .filter(version => compareVersions(version, fromVersion) > 0 && compareVersions(version, toVersion) <= 0)
    .sort(compareVersions)
    .map(version => ({ version, sections: releaseNotes(version) }))
}
