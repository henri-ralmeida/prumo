import { phasePlanningContext, planningContext } from '../../scripts/validation.mjs'

// Planejamento aprovado antes da primeira execução; consultar não pode criar uma tentativa.
export function plannedManualInspectionState() {
  const base = { phase: 'F1', state: 'pending', deps: [], attempts: [], validations: [], notes: [],
    planningRequired: true, discussionRequired: false, discoveryRequired: false,
    validationMode: 'inspection', inspectionReason: 'Conferir o resultado com revisão independente', validation: 'Inspecionar o resultado' }
  const task = { ...base, id: 'T7a', title: 'Resultado planejado', deps: ['T7'], planningHistory: [{ planner: 'planejador' }] }
  const state = { schemaVersion: 1, run: 'inspection', plan: { name: 'Inspeção', description: 'Resultado aprovado', planningMode: 'phase',
    requireReview: true, phases: [{ id: 'F1', title: 'Resultado' }] },
    tasks: { T7: { ...base, id: 'T7', title: 'Dependência concluída', state: 'done' }, T7a: task },
    phaseWorkflows: { F1: { id: 'F1', discussionSkips: [{ decisionId: 'S1', confirmedByUser: true, digest: 'aprovado' }] } } }
  task.taskPlan = { research: [{ source: 'contrato', findings: 'Inspeção necessária' }], decisions: [],
    steps: ['Inspecionar o resultado'], verification: [{ criterion: 'Resultado corresponde ao contrato', check: 'inspection', requires: ['manual-inspection'] }],
    openQuestions: [], planner: 'planejador', completedAt: '2026-01-01T00:00:00Z', attempt: 1,
    phaseId: 'F1', phaseDecision: 'skipped', phaseBinding: { discussionRoundId: 'S1' }, phaseDecisionDigest: 'aprovado',
    scope: phasePlanningContext(state, task), context: planningContext(state, task, { attempt: 1 }) }
  return state
}
