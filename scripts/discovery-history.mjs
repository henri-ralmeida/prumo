import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeAtomicState } from './atomic-state.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const owners = state => [...Object.values(state.phaseWorkflows ?? {}), ...Object.values(state.tasks ?? {})]

// As referências são relativas à execução; conteúdo alterado ou ausente nunca valida planos históricos.
function readArchive(directory, reference) {
  if (!/^discoveries\/[a-f0-9]{64}\.json$/.test(reference)) throw new Error('Invalid discovery archive reference')
  const contents = readFileSync(join(directory, reference), 'utf8')
  if (digest(contents) !== reference.slice(12, -5)) throw new Error('Discovery archive digest mismatch')
  return JSON.parse(contents)
}

// A hidratação é somente em memória: leitores não migram nem reescrevem o estado.
export function hydrateDiscoveries(state, directory) {
  for (const owner of owners(state)) for (const round of owner.discussionAttempts ?? []) {
    if (!round.discoveryArtifact) continue
    try {
      const archived = readArchive(directory, round.discoveryArtifact)
      for (const key of ['discovery', 'discoveries']) if (archived[key])
        Object.defineProperty(round, key, { value: archived[key], writable: true, configurable: true })
    } catch { /* Referência indisponível mantém a validação histórica fechada. */ }
  }
  return state
}

// Grave o artefato antes da troca atômica do estado; uma falha mantém o estado anterior recuperável.
export function compactDiscoveries(state, directory) {
  for (const owner of owners(state)) for (const round of owner.discussionAttempts ?? []) {
    if (!round.endedAt || round === owner.discussionAttempts.at(-1)) continue
    if (round.discoveryArtifact) readArchive(directory, round.discoveryArtifact)
    const discovery = round.discovery ?? (owner.discovery?.roundId === round.roundId ? owner.discovery : undefined)
    const discoveries = round.discoveries
    if (!discovery && !discoveries) continue
    const contents = JSON.stringify({ ...(discovery ? { discovery } : {}), ...(discoveries ? { discoveries } : {}) }, null, 2)
    const reference = `discoveries/${digest(contents)}.json`
    mkdirSync(join(directory, 'discoveries'), { recursive: true })
    writeAtomicState(join(directory, reference), contents)
    round.discoveryArtifact = reference
    if (discovery?.digest) round.discoveryDigest = discovery.digest
    delete round.discovery
    delete round.discoveries
  }
  return state
}
