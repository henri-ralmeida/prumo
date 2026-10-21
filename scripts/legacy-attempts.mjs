const terminal = new Set(['done', 'skipped'])
const eventsByCollection = {
  tasks: { start: 'task_start', end: new Set(['task_done', 'task_fail', 'task_skip']) },
  phaseWorkflows: { start: 'phase_start', end: new Set(['phase_done', 'phase_fail', 'phase_skip']) },
}

function time(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
}

const attemptNumber = (attempt, index) => Number.isInteger(attempt.n) && attempt.n > 0 ? attempt.n : index + 1

// Só a evidência posterior ao início encerra o legado; o horário da migração não representa trabalho realizado.
export function terminalAttemptRepairs(state, events = []) {
  const repairs = [], unresolved = []
  for (const collection of ['tasks', 'phaseWorkflows']) {
    const types = eventsByCollection[collection]
    for (const [owner, value] of Object.entries(state[collection] ?? {})) {
      if (!terminal.has(value.state)) continue
      const attempts = value.attempts ?? []
      for (const [index, attempt] of attempts.entries()) {
        if (attempt.endedAt) continue
        const identity = { collection, owner, index, attempt: attemptNumber(attempt, index) }
        const started = time(attempt.startedAt)
        if (started === null) {
          unresolved.push({ ...identity, reason: 'missing-start' })
          continue
        }
        const candidates = []
        for (let next = index + 1; next < attempts.length; next += 1) {
          const at = time(attempts[next].startedAt)
          if (at !== null && at >= started) candidates.push({ at, endedAt: attempts[next].startedAt,
            source: { type: 'next-attempt', attempt: attemptNumber(attempts[next], next) } })
        }
        for (const [eventIndex, event] of events.entries()) {
          const id = collection === 'tasks' ? event.task : event.phase
          if (id !== owner) continue
          const at = time(event.at)
          if (at === null || at < started) continue
          const closing = types.end.has(event.type) && (event.attempt === undefined || event.attempt === identity.attempt)
          const superseding = event.type === types.start && Number.isInteger(event.attempt) && event.attempt > identity.attempt
          if (closing || superseding) candidates.push({ at, endedAt: event.at, source: { type: 'event', eventType: event.type, eventIndex } })
        }
        candidates.sort((left, right) => left.at - right.at)
        if (!candidates.length) unresolved.push({ ...identity, reason: 'missing-end-evidence' })
        else repairs.push({ ...identity, endedAt: candidates[0].endedAt, source: candidates[0].source })
      }
    }
  }
  return { repairs, unresolved }
}

// O fechamento preserva contratos e tentativas; a origem permite auditar o horário recuperado.
export function repairTerminalAttempts(state, events = []) {
  const result = terminalAttemptRepairs(state, events)
  for (const repair of result.repairs) {
    const attempt = state[repair.collection][repair.owner].attempts[repair.index]
    const context = { version: 1, resultAdded: !Object.hasOwn(attempt, 'result'), appliedEndedAt: repair.endedAt,
      ...(Object.hasOwn(attempt, 'endedAt') ? { endedAt: attempt.endedAt } : {}) }
    attempt.endedAt = repair.endedAt
    if (context.resultAdded) attempt.result = 'legacy-superseded'
    attempt.legacyClosure = { ...repair.source, context }
  }
  return result
}

// Reparar a medição histórica não muda o contexto que os planos dependentes já aceitaram.
export function attemptsForContext(attempts) {
  if (!Array.isArray(attempts)) return attempts
  return attempts.map(attempt => {
    const context = attempt.legacyClosure?.context
    if (context?.version !== 1) return attempt
    const original = { ...attempt }
    delete original.legacyClosure
    if (attempt.endedAt === context.appliedEndedAt) {
      if (Object.hasOwn(context, 'endedAt')) original.endedAt = context.endedAt
      else delete original.endedAt
    }
    if (context.resultAdded && attempt.result === 'legacy-superseded') delete original.result
    return original
  })
}
