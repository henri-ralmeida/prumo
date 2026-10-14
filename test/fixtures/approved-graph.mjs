import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/engine.mjs')
export const check = { kind: 'functional', run: 'node check.cjs', expect: 'Comportamento aprovado preservado' }

export function fixture(t, { tasks = [{ id: 'T1' }], phase = false, git = false, lang = 'en' } = {}) {
  const prefix = join(resolve(tmpdir()), 'prumo-pending-audit-'), home = mkdtempSync(prefix)
  t.after(() => { assert.ok(resolve(home).startsWith(prefix)); rmSync(home, { recursive: true, force: true }) })
  const root = join(home, 'storage'), project = join(home, 'project'), plans = join(home, 'plans')
  for (const path of [root, project, plans]) mkdirSync(path)
  writeFileSync(join(project, 'check.cjs'), "require('node:assert/strict').equal(1, 1)\n")
  const source = join(home, 'plan.json')
  const plan = { name: 'Entrega verificavel', planningMode: phase ? 'phase' : 'task',
    ...(phase ? { phases: [{ id: 'F1', title: 'Preparacao' }, { id: 'F2', title: 'Entrega' }] } : {}),
    tasks: tasks.map(task => ({ title: 'Entrega aprovada', summary: 'Preservar o comportamento aprovado para o usuario.',
      validation: [check], ...(phase ? { phase: 'F1' } : {}), ...task })) }
  const writePlan = () => writeFileSync(source, JSON.stringify(plan))
  writePlan()
  const env = { ...process.env, PRUMO_ROOT: root, PRUMO_HOME: home, PRUMO_LANG: lang }
  const cli = (...args) => spawnSync(process.execPath, [engine, ...args, '--run', 'audit'],
    { cwd: project, env, encoding: 'utf8', windowsHide: true })
  const ok = (...args) => { const r = cli(...args); assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout }
  const rejects = (pattern, ...args) => { const r = cli(...args); assert.notEqual(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, pattern); return r.stdout + r.stderr }
  const gitCommand = (...args) => { const r = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout }
  if (git) {
    gitCommand('init'); gitCommand('config', 'user.name', 'Fixture'); gitCommand('config', 'user.email', 'fixture@example.invalid')
    gitCommand('add', '.'); gitCommand('commit', '-m', 'Base')
  }
  ok('init', '--plan', source, '--cwd', project)
  ok('authorize', '--scope', 'run', '--confirmed-by-user')
  const statePath = join(root, '.specs/graph/audit/state.json')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const events = () => readFileSync(join(root, '.specs/graph/audit/events.ndjson'), 'utf8')
  const discovery = (phaseId, decisions = []) => {
    const round = state().phaseWorkflows[phaseId].discussionAttempts.at(-1)
    const value = { roundId: round.roundId, nonce: round.nonce,
      research: [{ source: 'Contrato aprovado', findings: 'Comportamento atual conferido.' }],
      questions: [{ question: 'Preservar o escopo apresentado?', answer: 'Sim.', channel: 'chat-fallback', round: 1,
        roundId: round.roundId, ...(round.confirmsContract ? { confirmsContract: round.confirmsContract } : {}) }],
      coverage: Object.fromEntries(['problem', 'affected', 'outcome', 'currentBehavior', 'desiredBehavior', 'rules', 'exceptions', 'scope', 'acceptance']
        .map(key => [key, 'Preservar o comportamento aprovado e a revisao independente.'])),
      decisions, deferred: [], executionBoundary: { deferredToExecutor: round.activeTargets ?? round.targets, prematureTaskWork: [] },
      closure: 'Decisoes necessarias respondidas.' }
    const path = join(home, `discovery-${phaseId}.json`)
    writeFileSync(path, JSON.stringify(value)); return path
  }
  const artifacts = (phaseId, configure = () => {}) => {
    const current = state(), round = current.phaseWorkflows[phaseId].planningAttempts.at(-1)
    for (const id of round.activeTargets ?? round.targets) {
      const value = { research: [{ source: 'Contrato', findings: 'Implementacao e criterios conferidos.' }], decisions: [],
        steps: ['Entregar o comportamento e conferir os criterios aprovados.'],
        verification: [{ criterion: check.expect, check: 1 }], openQuestions: [],
        phaseBinding: { phaseId, discussionRoundId: round.discussionRoundId, plannerRound: round.n },
        unresolvedInputs: round.requiredInputs[id] }
      configure(value, id)
      writeFileSync(join(plans, `task-plan-${id}.json`), JSON.stringify(value))
    }
  }
  const planPhase = (phaseId = 'F1', configure) => {
    ok('begin-phase-discussion', phaseId)
    ok('finish-phase-discussion', phaseId, '--context', discovery(phaseId))
    ok('plan-phase', phaseId, '--agent', 'planner', '--plan-dir', plans)
    artifacts(phaseId, configure)
    ok('finish-phase-planning', phaseId, '--plan-dir', plans)
  }
  const skipTaskPlan = (id = 'T1') => {
    ok('skip-discussion', id, '--reason', 'Escopo aprovado', '--confirmed-by-user')
    ok('skip-planning', id, '--reason', 'Contrato suficiente', '--confirmed-by-user')
  }
  return { home, root, project, plans, source, plan, cli, ok, rejects, state, events, writePlan, gitCommand,
    discovery, artifacts, planPhase, skipTaskPlan,
    importState: value => writeFileSync(statePath, JSON.stringify(value)) }
}
