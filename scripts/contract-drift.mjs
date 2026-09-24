import { existsSync, readFileSync } from 'node:fs'
import { planTaskFromState } from './validation.mjs'

export const TASK_CONTRACT_FIELDS = ['phase', 'title', 'deps', 'validation', 'validationMode', 'inspectionReason', 'requireReview', 'maxAttempts', 'tags', 'touches', 'unavailable']
export const GLOBAL_PLAN_FIELDS = ['name', 'description', 'requireReview']

function globalPlanValues(plan = {}) {
  return {
    name: plan.name,
    description: plan.description ?? '',
    requireReview: plan.requireReview !== false,
  }
}

function sourceTask(task) {
  return {
    id: task.id,
    phase: task.phase ?? null,
    title: task.title,
    deps: task.deps ?? [],
    validation: task.validation ?? '',
    validationMode: task.validationMode,
    inspectionReason: task.inspectionReason,
    requireReview: task.requireReview,
    maxAttempts: task.maxAttempts,
    tags: task.tags ?? [],
    touches: task.touches ?? [],
    unavailable: task.unavailable,
  }
}

function sourcePlan(state, suppliedPlan) {
  if (suppliedPlan) return { plan: suppliedPlan }
  const path = state.plan?.source
  if (typeof path !== 'string' || !path) return { error: 'missing' }
  if (!existsSync(path)) return { error: 'missing' }
  try {
    const plan = JSON.parse(readFileSync(path, 'utf8'))
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tasks) ||
        plan.tasks.some(task => !task || typeof task !== 'object' || typeof task.id !== 'string'))
      return { error: 'unreadable' }
    return { plan }
  } catch {
    return { error: 'unreadable' }
  }
}

/** Compara o contrato persistido da execução com a fonte aprovada sem bloquear quem consulta. */
export function contractDrift(state, { plan: suppliedPlan } = {}) {
  const source = sourcePlan(state, suppliedPlan)
  if (!source.plan) return { available: false, reason: source.error, planFields: [], tasks: [] }

  const approved = source.plan
  const persistedGlobals = globalPlanValues(state.plan)
  const approvedGlobals = globalPlanValues(approved)
  const planFields = GLOBAL_PLAN_FIELDS.filter(field =>
    JSON.stringify(persistedGlobals[field]) !== JSON.stringify(approvedGlobals[field]))

  const persistedIds = new Set(Object.keys(state.tasks ?? {}))
  const approvedIds = new Set(approved.tasks.map(task => task.id))
  const tasks = []
  for (const task of approved.tasks) {
    const current = state.tasks?.[task.id]
    if (!current) {
      tasks.push({ task: task.id, fields: ['notSynchronized'] })
      continue
    }
    const persisted = planTaskFromState(current)
    const planned = sourceTask(task)
    const fields = TASK_CONTRACT_FIELDS.filter(field =>
      JSON.stringify(persisted[field]) !== JSON.stringify(planned[field]))
    if (fields.length) tasks.push({ task: task.id, fields })
  }
  for (const id of persistedIds) {
    if (!approvedIds.has(id)) tasks.push({ task: id, fields: ['missingFromApprovedPlan'] })
  }

  return { available: true, planFields, tasks }
}

/** A human-readable contract view that never includes executable validation commands. */
export function businessContract(plan, task) {
  const value = sourceTask(task)
  const validation = Array.isArray(value.validation)
    ? value.validation.map(step => ({
      ...(step?.kind === undefined ? {} : { kind: step.kind }),
      expect: step?.expect,
    }))
    : value.validation
  return {
    plan: globalPlanValues(plan),
    task: {
      ...value,
      validation,
    },
  }
}
