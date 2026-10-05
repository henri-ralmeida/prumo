export function rejectionCases() {
  const base = { state: 'reviewing', attempts: [{ n: 2, startedAt: '2026-01-01T09:00:00Z' }],
    validations: [{ by: 'review', attempt: 2, ok: false, token: 'verdict', error: null, at: '2026-01-01T09:10:00Z' }] }
  const change = fn => { const value = structuredClone(base); fn(value); return value }
  return [
    [base, true], [null, false], [{ state: 'reviewing' }, false],
    [change(t => { t.state = 'running' }), false],
    [change(t => { delete t.validations }), false],
    [change(t => { t.validations[0].ok = true }), false],
    [change(t => { delete t.validations[0].error }), false],
    [change(t => { delete t.validations[0].token; delete t.validations[0].error }), true],
    [change(t => { t.validations[0].attempt = 1 }), false],
    [change(t => { delete t.validations[0].attempt }), true],
    [change(t => { t.validations[0].by = 'executor' }), false],
    [change(t => { delete t.validations[0].at }), false],
    [change(t => { delete t.attempts[0].startedAt }), false],
    [change(t => { delete t.attempts[0].n; t.validations[0].attempt = 1 }), true],
    ...['review', 'execution'].flatMap(role => [undefined, '2026-01-01T09:12:00Z'].map(endedAt => [change(t => {
      t.attempts[0].activityIntervals = [{ role, startedAt: '2026-01-01T09:11:00Z', endedAt }]
    }), role !== 'review' || !!endedAt])),
    [change(t => { t.attempts[0].activityIntervals = [{ role: 'review', startedAt: '2026-01-01T09:09:00Z' }] }), true],
    [change(t => { t.attempts[0].activityIntervals = [{ role: 'review' }] }), true],
  ]
}

