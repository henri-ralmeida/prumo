const registry = 'https://registry.npmjs.org/@henri-ralmeida%2fprumo/latest'

function stableVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null
  const parts = value.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

// Consultar somente a versão estável publicada; falhas de rede não interrompem o plano.
export async function dashboardUpdate(current, { fetch: request = globalThis.fetch } = {}) {
  try {
    const installed = stableVersion(current)
    if (!installed) return { available: false }
    const response = await request(registry, { signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' } })
    if (!response.ok) return { available: false }
    const { version } = await response.json()
    const latest = stableVersion(version)
    if (!latest) return { available: false }
    for (let index = 0; index < 3; index++) {
      if (latest[index] !== installed[index]) return latest[index] > installed[index]
        ? { available: true, current, latest: version } : { available: false }
    }
    return { available: false }
  } catch {
    return { available: false }
  }
}
