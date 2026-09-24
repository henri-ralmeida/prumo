import assert from 'node:assert/strict'

export function assertReleaseContentVersion(version, baseline, manifest) {
  assert.ok(baseline && typeof baseline.version === 'string' && /^\d+\.\d+\.\d+$/.test(baseline.version), 'Release baseline must name a stable SemVer version')
  assert.ok(baseline.files && typeof baseline.files === 'object' && !Array.isArray(baseline.files), 'Release baseline must contain a file manifest')
  if (version !== baseline.version) return
  const expected = Object.fromEntries(Object.entries(baseline.files).sort(([a], [b]) => a.localeCompare(b)))
  const actual = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
      .filter(name => expected[name] !== actual[name])
      .sort()
    throw new Error(`Distributed package content changed without a version bump from ${baseline.version}: ${changed.join(', ')}`)
  }
}
