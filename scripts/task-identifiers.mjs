const taskId = /^T(\d+)([a-z]?)$/i
const problem = (message, ...values) => ({ message, values })

// O plano inicial fixa os números; ampliações vinculadas preservam esses números e o histórico.
export function taskIdentifierProblem(tasks, existingIds) {
  const numbered = tasks.filter(task => /^t\d/i.test(task.id))
  if (existingIds === undefined) {
    if (numbered.length && numbered.length !== tasks.length)
      return problem('Initial task identifiers cannot mix T1, T2, ... with other identifier formats')
    for (const task of numbered)
      if (!/^T[1-9]\d*$/.test(task.id))
        return problem('Initial task {0} must use T1, T2, ... without suffixes or leading zeros', task.id)
    const numbers = numbered.map(task => Number(task.id.slice(1))).sort((a, b) => a - b)
    for (let i = 0; i < numbers.length; i++)
      if (numbers[i] !== i + 1)
        return problem('Initial task numbering must be sequential from T1; expected T{0}', i + 1)
    return null
  }

  const existing = new Set(existingIds)
  const roots = new Map(existingIds.filter(id => /^T\d+$/i.test(id)).map(id => [id.toUpperCase(), id]))
  const added = (roots.size ? tasks : numbered).filter(task => !existing.has(task.id))
  const groups = new Map()
  for (const task of added) {
    const match = taskId.exec(task.id)
    if (!match || !/^T\d+[a-z]$/.test(task.id))
      return problem('New task {0} must extend an existing task with a lowercase suffix, such as T9a; original task numbers are preserved', task.id)
    const base = 'T' + match[1]
    const parent = roots.get(base)
    if (!parent) return problem('New task {0} has no existing parent {1}', task.id, base)
    const group = groups.get(base) ?? { parent, tasks: [] }
    group.tasks.push(task)
    groups.set(base, group)
  }

  const byId = new Map(tasks.map(task => [task.id, task]))
  const reaches = (from, to, seen = new Set()) => {
    if (from === to) return true
    if (seen.has(from)) return false
    seen.add(from)
    return (byId.get(from)?.deps ?? []).some(dep => reaches(dep, to, seen))
  }
  for (const [base, group] of groups) {
    const used = existingIds.map(id => taskId.exec(id)).filter(match => match && 'T' + match[1] === base && match[2])
      .map(match => match[2].toLowerCase().charCodeAt(0) - 97)
    let next = used.length ? Math.max(...used) + 1 : 0
    for (const task of group.tasks.sort((a, b) => a.id.localeCompare(b.id))) {
      if (next >= 26) return problem('Task {0} already uses all extension suffixes from a to z', group.parent)
      const expected = base + String.fromCharCode(97 + next++)
      if (task.id !== expected) return problem('New task {0} must use the next extension identifier {1}', task.id, expected)
      if (!reaches(group.parent, task.id) && !reaches(task.id, group.parent))
        return problem('Extension {0} must be linked to its parent {1} through dependencies', task.id, group.parent)
    }
  }
  return null
}
