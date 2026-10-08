import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { captureDelivery, checkDelivery, verifyNumericProvenance, assertEvidenceContract, safeEvidencePath } from '../scripts/delivery-evidence.mjs'
import { assertRolePreferences, recordDispatchMetadata, reportedUsageTotals, pauseRun, resumeRun, shellCommand, taskBrief, repeatedPlanQuestions, recordedPlanIdentity } from '../scripts/run-metadata.mjs'
import { recordedAgentTiming } from '../scripts/recorded-timing.mjs'
import { diagnoseShellFilter } from '../lib/shell-diagnostics.mjs'
import { parseEngineArgs } from '../scripts/engine-args.mjs'

const engine = fileURLToPath(new URL('../scripts/engine.mjs', import.meta.url))
const at = minute => new Date(Date.UTC(2026, 9, 7, 13, minute)).toISOString()
function fixture(t) {
  const home = fs.realpathSync(mkdtempSync(join(tmpdir(), 'prumo-evidence-'))), cwd = join(home, 'project'), root = join(home, 'store', 'workspace'), run = join(root, '.specs', 'graph', 'demo')
  mkdirSync(join(cwd, 'out'), { recursive: true }); mkdirSync(run, { recursive: true })
  assert.equal(spawnSync('git', ['init', cwd], { encoding: 'utf8' }).status, 0)
  const task = { id: 'T1', phase: null, title: 'Observable delivery', touches: ['out'], deps: [], state: 'pending', planningRequired: false, discussionRequired: false, discoveryRequired: false, validation: [{ kind: 'functional', run: 'node --version', expect: 'Node runs' }], attempts: [], validations: [], notes: [] }
  const state = { schemaVersion: 1, run: 'demo', createdAt: at(0), plan: { name: 'approved-delivery', planningMode: 'task', phases: [], maxAgents: 3, requireReview: true, cwd }, tasks: { T1: task } }
  const statePath = join(run, 'state.json')
  const save = () => writeFileSync(statePath, JSON.stringify(state))
  save(); writeFileSync(join(run, 'events.ndjson'), ''); writeFileSync(join(dirname(run), 'CURRENT'), 'demo')
  const write = (path, value) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)) }
  const cli = (args, expected = 0, env = {}) => {
    const result = spawnSync(process.execPath, [engine, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PRUMO_HOME: dirname(root), PRUMO_ROOT: root, PRUMO_LANG: 'en', PRUMO_RUN: 'demo', ...env }, timeout: 30000 })
    assert.ifError(result.error); assert.equal(result.status, expected, result.stdout + result.stderr)
    return expected === 0 ? result.stdout : result.stdout + result.stderr
  }
  const read = () => JSON.parse(readFileSync(statePath, 'utf8'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return { home, cwd, root, run, state, task, save, write, cli, read }
}

test('consultas e autorizacao durante uma pausa nao sugerem trabalho nem removem o motivo', t => {
  const f = fixture(t)
  f.cli(['pause-run', '--reason', 'Aguardar quota'])
  const status = f.cli(['status'])
  assert.match(status, /RUN PAUSED/)
  assert.match(status, /0 execution slot/)
  assert.doesNotMatch(status, /suggested action|→ start/)
  f.cli(['authorize', '--scope', 'run', '--confirmed-by-user'])
  assert.equal(f.read().runPause.reason, 'Aguardar quota')
  f.write('plan.json', { name: f.state.plan.name, planningMode: 'task', tasks: [{ ...f.task, summary: 'Descricao atualizada durante a pausa' }] })
  f.cli(['sync-plan', '--plan', join(f.cwd, 'plan.json')])
  assert.equal(f.read().tasks.T1.summary, 'Descricao atualizada durante a pausa')
  assert.ok(!f.read().runPause.endedAt)
  f.cli(['resume-run'])
  assert.doesNotMatch(f.cli(['status']), /RUN PAUSED/)
})

test('preferencias opcionais sobrevivem ao init por CURRENT e a sincronizacao sem revogar autorizacao', t => {
  const f = fixture(t)
  const preferences = { execution: { model: 'modelo-solicitado', effort: 'medium' } }
  f.write('plan.json', { name: 'Plano compativel', rolePreferences: preferences, tasks: [f.task] })
  f.cli(['init', '--plan', join(f.cwd, 'plan.json'), '--force'], 0, { PRUMO_RUN: undefined })
  assert.deepEqual(f.read().plan.rolePreferences, preferences)
  f.cli(['authorize', '--scope', 'run', '--confirmed-by-user'])
  const before = f.read().authorizations
  f.write('plan.json', { name: 'Plano compativel', tasks: [f.task] })
  f.cli(['sync-plan', '--plan', join(f.cwd, 'plan.json')])
  assert.deepEqual(f.read().plan.rolePreferences, preferences)
  assert.deepEqual(f.read().authorizations, before)
  f.write('plan.json', { name: 'Plano compativel', rolePreferences: { review: { model: 'outro-modelo' } }, tasks: [f.task] })
  f.cli(['sync-plan', '--plan', join(f.cwd, 'plan.json')])
  assert.deepEqual(f.read().plan.rolePreferences, { review: { model: 'outro-modelo' } })
  assert.deepEqual(f.read().authorizations, before)
})

test('contratos invalidos de modelo e evidencia sao recusados antes de criar um run', t => {
  const f = fixture(t)
  for (const [patch, expected] of [
    [{ rolePreferences: { execution: { model: 42 } } }, /Role preference/],
    [{ tasks: [{ ...f.task, textRules: { patterns: [''] } }] }, /task T1:/],
  ]) {
    f.write('invalid-plan.json', { name: 'Plano invalido', tasks: [f.task], ...patch })
    assert.match(f.cli(['init', '--plan', join(f.cwd, 'invalid-plan.json'), '--run', 'invalid'], 1), expected)
    assert.equal(fs.existsSync(join(f.root, '.specs', 'graph', 'invalid', 'state.json')), false)
  }
})

test('show-check explica indices invalidos e admite historico legado sem tentativas ou recibos', t => {
  const f = fixture(t)
  delete f.task.attempts
  delete f.task.validations
  f.save()
  const empty = JSON.parse(f.cli(['show-check', 'T1']))
  assert.equal(empty.latestAttempt, 0)
  assert.deepEqual(empty.attempts, [])
  assert.match(f.cli(['show-check', 'T1', '--check', 'zero'], 1), /positive integer; available: \[\]/)
  f.task.attempts = [{ startedAt: at(0) }]
  f.task.validations = [{ attempt: 1 }]
  f.save()
  const legacy = JSON.parse(f.cli(['show-check', 'T1']))
  assert.equal(legacy.latestAttempt, 1)
  assert.deepEqual(legacy.attempts[0].checks, [])
  assert.match(f.cli(['show-check', 'T1', '--attempt', '0'], 1), /positive integer; available:/)
})

test('custos de planejamento individual usam a rodada atual e nao inventam trabalhador de fase', t => {
  const f = fixture(t)
  f.task.planningAttempts = [{ n: 1, agent: 'planejador', startedAt: at(0), endedAt: at(1) }]
  f.state.phaseWorkflows = { F1: { state: 'pending' }, F2: { state: 'pending', planningAttempts: [] } }
  f.save()
  f.cli(['report-usage', 'T1', '--role', 'planning', '--receipt', 'plano-individual', '--tokens', '17'])
  assert.equal(f.read().tasks.T1.planningAttempts[0].usageReports[0].tokens, 17)
  assert.match(f.cli(['report-usage', 'T1', '--role', 'discussion', '--receipt', 'sem-discussao', '--tokens', '1'], 1), /No recorded attempt/)
  const unchanged = f.read()
  assert.match(f.cli(['report-usage', 'T1', '--role', 'planning', '--phase', 'F1', '--receipt', 'sem-worker', '--tokens', '1'], 1), /No recorded attempt/)
  assert.deepEqual(f.read(), unchanged)
})

test('inicio recusa leitura insegura e nao cria tentativa quando a captura da entrega falha', t => {
  const f = fixture(t)
  f.write('out/large.txt', 'x'.repeat(1024 * 1024 + 1))
  assert.match(f.cli(['start', 'T1', '--agent', 'autor'], 1), /reading limit/)
  assert.equal(f.read().tasks.T1.attempts.length, 0)
  assert.equal(f.read().tasks.T1.state, 'pending')
})

test('alteracao da entrega durante a validacao invalida o recibo em vez de aprovar dados antigos', t => {
  const f = fixture(t)
  f.task.validation = [{ kind: 'functional', run: `node -e "require('node:fs').writeFileSync('out/late.txt', 'resultado alterado')"`, expect: 'Gravacao autorizada concluida' }]
  f.save()
  f.cli(['start', 'T1', '--agent', 'autor'])
  f.cli(['review', 'T1', '--agent', 'revisor'])
  assert.match(f.cli(['validate', 'T1', '--ok', '--evidence', 'Conferencia independente', '--cwd', f.cwd], 1), /Delivery changed during validation/)
  assert.equal(f.read().tasks.T1.validations.at(-1).ok, false)
  assert.equal(f.read().tasks.T1.state, 'reviewing')
})

test('done e troca de revisor revalidam a entrega sem aceitar mudancas depois do recibo', t => {
  const f = fixture(t)
  f.cli(['start', 'T1', '--agent', 'autor'])
  f.write('out/result.txt', 'resultado valido')
  f.cli(['review', 'T1', '--agent', 'revisor'])
  f.cli(['validate', 'T1', '--ok', '--evidence', 'Verificacao independente', '--cwd', f.cwd])
  f.write('out/result.txt', 'resultado diferente')
  assert.match(f.cli(['done', 'T1'], 1), /Delivery changed after validation/)
  f.write('out/result.txt', 'T1 inserido no produto')
  assert.match(f.cli(['done', 'T1'], 1), /out\/result.txt:1/)
  f.cli(['block', 'T1', '--reason', 'Troca de sessao'])
  assert.match(f.cli(['unblock', 'T1', '--reviewer', 'novo-revisor'], 1), /out\/result.txt:1/)
  assert.equal(f.read().tasks.T1.state, 'blocked')
})

async function commandWaitingForLock(t, f, args, mutate, env = {}) {
  const lock = join(f.run, '.lock'), ready = join(f.home, 'waiting-for-lock')
  const preload = join(f.home, 'lock-wait.mjs')
  mkdirSync(lock)
  writeFileSync(preload, `import fs from 'node:fs'
import { resolve } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const original = fs.statSync
fs.statSync = function(path, ...args) {
  if (resolve(path) === ${JSON.stringify(lock)}) fs.writeFileSync(${JSON.stringify(ready)}, 'waiting')
  return original.call(this, path, ...args)
}
syncBuiltinESMExports()
`)
  const child = spawn(process.execPath, [engine, ...args], {
    cwd: f.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PRUMO_HOME: dirname(f.root), PRUMO_ROOT: f.root, PRUMO_LANG: 'en', PRUMO_RUN: 'demo', ...env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` },
  })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const deadline = Date.now() + 5000
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(fs.existsSync(ready), output)
  mutate()
  rmSync(lock, { recursive: true })
  return { code: await completed, output }
}

test('pausa concorrente impede validacao que aguardava o lock e preserva a tentativa', async t => {
  const f = fixture(t)
  f.cli(['start', 'T1', '--agent', 'autor'])
  f.cli(['review', 'T1', '--agent', 'revisor'])
  const before = f.read()
  const result = await commandWaitingForLock(t, f, ['validate', 'T1', '--ok', '--evidence', 'Conferencia independente', '--cwd', f.cwd], () => {
    const state = f.read()
    pauseRun(state, 'Quota indisponivel', undefined, new Date().toISOString())
    writeFileSync(join(f.run, 'state.json'), JSON.stringify(state))
  })
  assert.equal(result.code, 1)
  assert.match(result.output, /Run is paused/)
  assert.equal(f.read().tasks.T1.validations.length, before.tasks.T1.validations.length)
  f.cli(['resume-run'])
  assert.match(f.cli(['review-progress', 'T1', '--step', '0', '--agent', 'revisor'], 1), /positive integer/)
  f.cli(['validate', 'T1', '--ok', '--evidence', 'Conferencia apos retomada', '--cwd', f.cwd])
  assert.equal(f.read().tasks.T1.validations.at(-1).ok, true)
})

test('init recusa CURRENT removido durante espera sem sobrescrever a execucao existente', async t => {
  const f = fixture(t)
  const before = f.read()
  f.write('plan.json', { name: 'Outro plano', tasks: [f.task] })
  const result = await commandWaitingForLock(t, f, ['init', '--plan', join(f.cwd, 'plan.json'), '--force'], () => {
    rmSync(join(dirname(f.run), 'CURRENT'))
  }, { PRUMO_RUN: undefined })
  assert.equal(result.code, 1)
  assert.match(result.output, /invalid run name/)
  assert.deepEqual(f.read(), before)
})

test('retomada por alias preserva a identidade da tarefa no registro de modelo informado', t => {
  const f = fixture(t)
  f.state.taskIdAliases = { T9: 'T1', T1: 'T1' }
  f.save()
  f.cli(['start', 'T9', '--agent', 'autor'])
  f.cli(['review', 'T9', '--agent', 'revisor'])
  f.cli(['block', 'T9', '--reason', 'Troca de revisor'])
  f.cli(['unblock', 'T9', '--reviewer', 'novo-revisor', '--model', 'modelo-informado'])
  assert.equal(f.read().tasks.T1.reviewer, 'novo-revisor')
  assert.equal(f.read().tasks.T1.attempts.at(-1).modelDispatches.at(-1).reported.model, 'modelo-informado')
})
test('review refuses new case-insensitive identifiers, permits correction and preserves unrelated old lines', t => {
  const f = fixture(t)
  f.write('out/existing.txt', 'T1 already existed\nCommon executor role\n')
  f.cli(['start', 'T1', '--agent', 'author'])
  f.write('out/existing.txt', 'T1 already existed\nCommon executor role\nNew t1_reference\n')
  assert.match(f.cli(['review', 'T1', '--agent', 'fresh'], 1), /out\/existing.txt:3/)
  assert.equal(f.read().tasks.T1.state, 'running')
  f.write('out/existing.txt', 'T1 already existed\nCommon executor role\nNew business rule\n')
  f.write('out/t1_resumo.tsv', 'clean content')
  assert.match(f.cli(['review', 'T1', '--agent', 'fresh'], 1), /out\/t1_resumo.tsv:0/)
  rmSync(join(f.cwd, 'out/t1_resumo.tsv'))
  f.cli(['review', 'T1', '--agent', 'fresh'])
  f.cli(['validate', 'T1', '--ok', '--evidence', 'Independent Node execution', '--cwd', f.cwd])
  f.cli(['done', 'T1']); assert.equal(f.read().tasks.T1.state, 'done')
})
test('specific exceptions permit only the named path, line and identifier, with safe bounded reads', t => {
  const f = fixture(t), task = f.task
  f.write('out/existing.txt', 'historical t1')
  task.attempts.push({ deliveryBaseline: captureDelivery(task, f.cwd) })
  task.textRules = { patterns: ['INTERNAL-ROUND'], exceptions: [{ path: 'out/t1_resumo.tsv', line: 0, identifier: 'T1' }, { path: 'out/t1_resumo.tsv', line: 1, identifier: 'T1' }] }
  f.write('out/t1_resumo.tsv', 't1\nexecutor reviewer\n')
  assert.equal(checkDelivery(f.state, task, f.cwd).binaryPaths.length, 0)
  f.write('out/other.txt', 'INTERNAL-round')
  assert.throws(() => checkDelivery(f.state, task, f.cwd), /other.txt:1/)
  rmSync(join(f.cwd, 'out/other.txt'))
  f.write('out/image.bin', Buffer.from([0, 1, 2]))
  assert.deepEqual(checkDelivery(f.state, task, f.cwd).binaryPaths, ['out/image.bin'])
  f.write('out/large.txt', 'x'.repeat(1024 * 1024 + 1))
  assert.throws(() => checkDelivery(f.state, task, f.cwd), /reading limit/)
  rmSync(join(f.cwd, 'out/large.txt'))
  f.write('private.txt', 'secret')
  try { symlinkSync(join(f.cwd, 'private.txt'), join(f.cwd, 'out/link.txt')) } catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error; return }
  assert.throws(() => checkDelivery(f.state, task, f.cwd), /link refused/)
})
test('numeric summaries validate exact origins, calculations and outputs, rejecting stale evidence at done', t => {
  const f = fixture(t)
  f.task.numericProvenance = { manifest: 'out/provenance.json', sources: ['inputs.json'] }
  f.write('inputs.json', { rows: [2, 3], countable: ['a', 'b'], exact: 9, 'a/b': { '~': 7 } })
  f.write('out/summary.json', { total: 5, count: 2, exact: 9, escaped: 7 })
  const claims = [
    { source: 'inputs.json', pointer: '/rows', operation: 'sum', value: 5, result: { source: 'out/summary.json', pointer: '/total' } },
    { source: 'inputs.json', pointer: '/countable', operation: 'count', value: 2, result: { source: 'out/summary.json', pointer: '/count' } },
    { source: 'inputs.json', pointer: '/exact', operation: 'value', value: 9, result: { source: 'out/summary.json', pointer: '/exact' } },
    { source: 'inputs.json', pointer: '/a~1b/~0', operation: 'value', value: 7, result: { source: 'out/summary.json', pointer: '/escaped' } },
  ]
  f.write('out/provenance.json', { claims }); f.save()
  assert.equal(verifyNumericProvenance(f.task, f.cwd).claims, 4)
  assert.equal(JSON.parse(f.cli(['verify-provenance', 'T1'])).claims, 4)
  f.cli(['start', 'T1', '--agent', 'author']); f.cli(['review', 'T1', '--agent', 'fresh'])
  f.cli(['validate', 'T1', '--ok', '--evidence', 'Checked origins', '--cwd', f.cwd])
  f.write('inputs.json', { rows: [1, 4], countable: ['a', 'b'], exact: 9, 'a/b': { '~': 7 } })
  assert.match(f.cli(['done', 'T1'], 1), /Provenance changed/)
  const oldFingerprint = f.read().tasks.T1.validations.at(-1).numericProvenance.fingerprint
  f.cli(['validate', 'T1', '--ok', '--evidence', 'Rechecked changed sources', '--cwd', f.cwd])
  assert.notEqual(f.read().tasks.T1.validations.at(-1).numericProvenance.fingerprint, oldFingerprint)
  f.cli(['done', 'T1'])
  for (const patch of [{ pointer: '/missing' }, { source: '../secret' }, { operation: 'invent' }, { value: 6 }, { pointer: '/rows', operation: 'value' }, { result: { source: 'elsewhere', pointer: '' } }]) {
    f.write('out/provenance.json', { claims: [{ ...claims[0], ...patch }] })
    assert.throws(() => verifyNumericProvenance(f.task, f.cwd), /Provenance|provenance/)
  }
  for (const value of [{}, { claims: [] }, { claims: [null] }]) { f.write('out/provenance.json', value); assert.throws(() => verifyNumericProvenance(f.task, f.cwd)) }
  f.write('out/provenance.json', '{'); assert.throws(() => verifyNumericProvenance(f.task, f.cwd), /Invalid provenance JSON/)
  assert.equal(verifyNumericProvenance({}, f.cwd), null)
})
test('whole-run pause preserves attempts, phase workers, queues and external blockers; resume is explicit', t => {
  const f = fixture(t)
  f.cli(['start', 'T1', '--agent', 'author'])
  const state = f.read(); state.tasks.T2 = { ...f.task, id: 'T2', state: 'blocked', blockKind: 'external', blockReason: 'Waiting for approved input', stateBeforeBlock: 'pending' }
  state.phaseWorkflows = { F1: { state: 'planning', planningAttempts: [{ n: 1, startedAt: at(0), workers: { T3: { agent: 'planner', startedAt: at(0), activityIntervals: [{ role: 'planning', startedAt: at(0) }] } }, activeTargets: ['T3'], queuedTargets: ['T4'] }] } }
  writeFileSync(join(f.run, 'state.json'), JSON.stringify(state))
  f.cli(['pause-run', '--reason', 'Budget pause', '--until', '2099-01-01T00:00:00Z'])
  const paused = f.read()
  assert.equal(paused.tasks.T1.state, 'running'); assert.equal(paused.tasks.T1.attempts.length, 1)
  assert.equal(paused.tasks.T2.blockKind, 'external')
  assert.deepEqual(paused.phaseWorkflows.F1.planningAttempts[0].queuedTargets, ['T4'])
  assert.ok(paused.phaseWorkflows.F1.planningAttempts[0].workers.T3.activityIntervals[0].endedAt)
  assert.doesNotMatch(f.cli(['ready']), /suggested action|start T/)
  assert.match(f.cli(['review', 'T1', '--agent', 'fresh'], 1), /Run is paused/)
  f.cli(['pause-run', '--reason', 'Again'], 1)
  f.cli(['resume-run']); assert.ok(f.read().runPause.endedAt)
  f.cli(['resume-run'], 1)
  assert.equal(f.read().tasks.T1.attempts.length, 1)
})
test('model preferences apply to future dispatches only; usage receipts are idempotent and briefing survives handoff', t => {
  const f = fixture(t)
  f.cli(['set-role', '--role', 'execution', '--model', 'preferred', '--effort', 'high'])
  f.cli(['start', 'T1', '--agent', 'author', '--model', 'reported', '--effort', 'medium'])
  f.cli(['set-role', '--role', 'execution', '--model', 'next'])
  f.cli(['report-usage', 'T1', '--role', 'execution', '--receipt', 'execution-total', '--tokens', '100', '--tools', '3'])
  f.cli(['report-usage', 'T1', '--role', 'execution', '--receipt', 'execution-total', '--tokens', '100', '--tools', '3'])
  f.cli(['report-usage', 'T1', '--role', 'execution', '--receipt', 'execution-total', '--tokens', '101'], 1)
  f.cli(['review', 'T1', '--agent', 'review-old', '--model', 'review-report'])
  f.cli(['validate', 'T1', '--failed', '--evidence', 'The source value is missing'])
  f.cli(['block', 'T1', '--reason', 'Reviewer session ended'])
  f.cli(['unblock', 'T1', '--reviewer', 'review-new', '--model', 'replacement'])
  const state = f.read(), attempt = state.tasks.T1.attempts[0]
  assert.deepEqual(attempt.modelDispatches[0].requested, { model: 'preferred', effort: 'high' })
  assert.equal(attempt.modelDispatches[0].reported.model, 'reported')
  assert.equal(attempt.reviewHistory[0].reviewer, 'review-old')
  f.cli(['report-usage', 'T1', '--role', 'review', '--receipt', 'review-total', '--tokens', '50'])
  assert.equal(reportedUsageTotals(f.read()).run.tokens, 150)
  const brief = JSON.parse(f.cli(['brief', 'T1', '--role', 'reviewer']))
  assert.equal(brief.lastRejection.evidence, 'The source value is missing')
  assert.equal(brief.lastRejection.agent, 'review-old')
  assert.equal(brief.modelDispatches.at(-1).reported.model, 'replacement')
  assert.doesNotMatch(JSON.stringify(brief), /executor narrative|already green/)
  assert.match(f.cli(['status']), /not verified|not measured/)
})
test('run selector precedence and show-check never fall back to an earlier attempt', t => {
  const f = fixture(t)
  assert.match(f.cli(['status', '-r', 'demo'], 0, { PRUMO_RUN: '../bad' }), /run: demo/)
  f.cli(['status'], 1, { PRUMO_RUN: '../bad' })
  assert.match(f.cli(['status'], 0, { PRUMO_RUN: undefined }), /run: demo/)
  assert.throws(() => parseEngineArgs('status', ['-r', 'demo', '--run', 'other']), /Duplicate/)
  f.task.attempts = [{ n: 1 }, { n: 2 }]
  f.task.validations = [{ attempt: 1, checks: [{ stdout: 'full stdout', stderr: 'full stderr', run: 'original command', exitCode: 0 }] }]; f.save()
  const listing = JSON.parse(f.cli(['show-check', 'T1']))
  assert.equal(listing.latestAttempt, 2); assert.match(listing.attempts[0].checks[0].command, /--attempt.*1.*--check.*1/)
  assert.match(f.cli(['show-check', 'T1', '--check', '1'], 1), /attempt 2; available/)
  assert.match(f.cli(['show-check', 'T1', '--check', '1', '--attempt', '1']), /full stdout[^]*full stderr/)
  assert.match(f.cli(['show-check', 'T1', '--attempt', '9'], 1), /available: 1/)
  assert.equal(JSON.parse(f.cli(['show-check', 'T1', '--attempt', '1'])).attempts.length, 1)
  for (const selector of [['--check', '0'], ['--check', 'bad'], ['--attempt', '0'], ['--check', '1', '--attempt', 'bad']])
    assert.match(f.cli(['show-check', 'T1', ...selector], 1), /positive integer; available:.*original command/s)
  f.task.validations.push({ attempt: 1, ok: false, error: 'Interrupted before checks' }); f.save()
  assert.match(f.cli(['show-check', 'T1', '--check', '1', '--attempt', '1'], 1), /has no stored check/)
  assert.deepEqual(JSON.parse(f.cli(['show-check', 'T1'])).attempts[0].checks, [])
})
test('recorded role durations sum parallel workers once; live clock uses the union', () => {
  const state = { tasks: {}, phaseWorkflows: { F1: { state: 'planning', planningAttempts: [{ startedAt: at(0), workers: Object.fromEntries(['one', 'two', 'three'].map(agent => [agent, { agent, startedAt: at(0), activityTiming: 'explicit', activityIntervals: [] }])) }] } } }
  const timing = recordedAgentTiming(state, [], Date.parse(at(10)))
  assert.equal(timing.roles.planning.durationMs, 30 * 60000)
  assert.equal(timing.roles.planning.measuredMs, 0)
  assert.equal(timing.roles.planning.stageMs, 30 * 60000)
  assert.equal(timing.elapsedMs, 10 * 60000)
  assert.equal(Object.keys(timing.agents).length, 3)
  state.phaseWorkflows.F1.planningAttempts[0].endedAt = at(10)
  state.phaseWorkflows.F1.state = 'planned'
  assert.equal(recordedAgentTiming(state, [], Date.parse(at(20))).elapsedMs, 10 * 60000)
})
test('synthetic reported timestamps reproduce twenty minutes summed and twelve elapsed; empty intervals show honest durations', () => {
  const intervals = [
    ['2026-10-07T13:07:30.480Z', '2026-10-07T13:19:29.980Z'],
    ['2026-10-07T13:07:30.821Z', '2026-10-07T13:16:03.311Z'],
  ]
  const workers = Object.fromEntries(intervals.map(([startedAt, endedAt], index) => [`T${index + 1}`, { agent: `planner-${index}`, startedAt, endedAt, activityTiming: 'explicit', activityIntervals: [{ role: 'planning', startedAt, endedAt }] }]))
  const state = { tasks: {}, phaseWorkflows: { F1: { state: 'planned', planningAttempts: [{ startedAt: at(7), endedAt: at(20), workers }] } } }
  const actual = recordedAgentTiming(state)
  assert.equal(actual.roles.planning.measuredMs, 1231990)
  assert.equal(actual.elapsedMs, 719500)
  state.tasks = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`T${index + 1}`, { state: 'done', discussionAttempts: [{ agent: `discuss-${index}`, startedAt: at(0), endedAt: at(1), activityTiming: 'explicit', activityIntervals: [] }], attempts: [{ agent: `exec-${index}`, reviewer: `review-${index}`, startedAt: at(1), reviewStartedAt: at(3), endedAt: at(4), activityTiming: 'explicit', activityIntervals: [] }] }]))
  const historical = recordedAgentTiming(state)
  assert.equal(historical.roles.execution.durationMs, 16 * 60000)
  assert.equal(historical.roles.review.durationMs, 8 * 60000)
  assert.equal(historical.roles.discussion.durationMs, 8 * 60000)
  assert.equal(historical.roles.execution.measuredMs, 0)
})
test('timing handles pauses, open and resumed rounds, changed reviewers, partial history and missing timestamps', () => {
  const state = { runPauseHistory: [{ startedAt: at(3), endedAt: at(4) }], tasks: { T1: { state: 'reviewing', attempts: [{ agent: 'author', reviewer: 'new', startedAt: at(0), reviewStartedAt: at(7), reviewHistory: [{ reviewer: 'old', reviewStartedAt: at(5), reviewEndedAt: at(7), activityIntervals: [] }], activityIntervals: [] }] } }, phaseWorkflows: {} }
  const events = [{ type: 'task_block', task: 'T1', at: at(1) }, { type: 'task_block', task: 'T1', at: at(2) }, { type: 'task_unblock', task: 'T1', at: at(2) }]
  const timing = recordedAgentTiming(state, events, Date.parse(at(10)))
  assert.equal(timing.roles.execution.stageMs, 3 * 60000)
  assert.equal(timing.roles.review.stageMs, 5 * 60000)
  assert.equal(timing.elapsedMs, 8 * 60000)
  assert.equal(timing.agents.old.review.durationMs, 2 * 60000)
  assert.equal(timing.agents.new.review.durationMs, 3 * 60000)
  state.runPause = { startedAt: at(9), reason: 'Paused' }
  assert.equal(recordedAgentTiming(state, events, Date.parse(at(12))).roles.review.durationMs, 4 * 60000)
  assert.equal(recordedAgentTiming(state, events, Date.parse(at(12))).paused, true)
  assert.equal(recordedAgentTiming(state, events, Date.parse(at(12)), false).partial, true)
  state.tasks.T1.attempts[0].activityIntervals = [{ role: 'execution', agent: 'author', startedAt: at(0), endedAt: at(1) }, { role: 'review', agent: 'new', startedAt: at(8) }]
  state.tasks.T1.attempts[0].activityLegacy = true
  const explicit = recordedAgentTiming(state, events, Date.parse(at(12)))
  assert.equal(explicit.roles.execution.measuredMs, 60000)
  assert.equal(explicit.roles.review.measuredMs, 60000)
  state.tasks.T2 = { state: 'done', attempts: [{ startedAt: 'invalid', endedAt: 'invalid' }], planningAttempts: [{ agent: 'p', startedAt: at(0), endedAt: at(2) }], discussionAttempts: [{}] }
  assert.equal(recordedAgentTiming(state, events, Date.parse(at(12))).roles.planning.stageMs, 2 * 60000)
  assert.equal(recordedAgentTiming({}).elapsedMs, 0)
})
test('contracts reject unsafe patterns and paths while legacy optional fields remain absent', t => {
  const f = fixture(t)
  for (const path of ['', '../x', '/x', 'C:\\x', 'a\0b', 'a//b']) assert.throws(() => safeEvidencePath(path))
  assert.equal(safeEvidencePath('a\\b.json'), 'a/b.json')
  assert.equal(safeEvidencePath('a/./b.json'), 'a/b.json')
  for (const patch of [
    { deliveries: {} }, { deliveries: ['../x'] }, { deliveries: ['outside'] },
    { textRules: null }, { textRules: [] }, { textRules: { unknown: true } }, { textRules: { patterns: [''] } }, { textRules: { patterns: ['x'.repeat(129)] } }, { textRules: { patterns: ['a\nb'] } }, { textRules: { patterns: {} } },
    { textRules: { exceptions: {} } }, { textRules: { exceptions: [null] } }, { textRules: { exceptions: [{ path: 'outside', line: 1, identifier: 'T1' }] } },
    { numericProvenance: {} }, { numericProvenance: { manifest: 'outside', sources: ['source'] } },
  ]) assert.throws(() => assertEvidenceContract({ ...f.task, ...patch }))
  assertEvidenceContract({}); assertRolePreferences(undefined)
  for (const preference of [null, [], { executor: { model: 'x' } }, { review: {} }, { review: { model: '' } }, { review: { unknown: 'x' } }, { review: { model: 'x\ny' } }]) assert.throws(() => assertRolePreferences(preference))
  assertRolePreferences({ review: { model: 'named', effort: 'high' } })
  const empty = captureDelivery({}, f.cwd)
  assert.match(empty.limitation, /No approved/)
  assert.match(captureDelivery(f.task).limitation, /cwd unknown/)
  f.task.deliveries = ['out/report.txt']; assert.throws(() => captureDelivery(f.task), /recorded project/)
  delete f.task.deliveries
  f.write('out/report.txt', 't1')
  assert.match(checkDelivery(f.state, f.task, f.cwd).limitation, /Legacy/)
  f.task.deliveries = ['out/report.txt']; assert.throws(() => checkDelivery(f.state, f.task, f.cwd), /identifiers refused/)
})
test('pause validation, shell quoting and context defaults do not invent data', () => {
  const state = { tasks: { T1: { attempts: [{ agent: 'author', startedAt: at(0) }], discussionAttempts: [{ startedAt: at(0) }] } }, plan: {} }
  for (const [reason, until] of [['', undefined], ['pause', 'invalid'], ['pause', at(0)]]) assert.throws(() => pauseRun(state, reason, until, at(1)))
  pauseRun(state, 'pause', undefined, at(1)); resumeRun(state, at(2))
  assert.equal(state.runPauseHistory[0].endedAt, at(2))
  assert.equal(shellCommand(['node', "a'b", '$HOME'], false), "'node' 'a'\\''b' '$HOME'")
  assert.equal(shellCommand(['node', "a'b"], true), "& 'node' 'a''b'")
  assert.throws(() => taskBrief(state, {}, 'invalid', () => ''), /executor/)
  const brief = taskBrief(state, { id: 'T1', attempts: [], deps: ['missing'] }, 'executor', tokens => tokens.join(' '))
  assert.equal(brief.taskPlan, null); assert.equal(brief.lastRejection, null); assert.deepEqual(brief.dependencyDeliveries[0].deliveries, [])
  assert.deepEqual(recordDispatchMetadata(state, structuredClone(state)), [])
})
test('doctor uses accessible evidence and never assumes a lean-ctx block', t => {
  const f = fixture(t), config = join(f.home, 'config.json'), evidence = join(f.home, 'evidence.json')
  assert.match(diagnoseShellFilter(), /no shell filter detection claimed/)
  writeFileSync(config, JSON.stringify({ plugins: { 'lean-ctx': { allowedCommands: ['node --version'] } } }))
  assert.match(diagnoseShellFilter({ config }), /runtime block has not been established/)
  writeFileSync(evidence, JSON.stringify({ plugin: 'lean-ctx', decision: 'blocked', command: 'node scripts/engine.mjs ready' }))
  assert.match(diagnoseShellFilter({ evidence }), /adjust the allowed command list/)
  for (const value of [{ plugin: 'other' }, { plugin: 'lean-ctx', decision: 'allowed' }, { plugin: 'lean-ctx', decision: 'blocked', command: 'unrelated' }]) { writeFileSync(evidence, JSON.stringify(value)); assert.match(diagnoseShellFilter({ evidence }), /No accessible/) }
  writeFileSync(config, '{}'); assert.match(diagnoseShellFilter({ config }), /No accessible/)
  writeFileSync(config, 'x'.repeat(65537)); assert.throws(() => diagnoseShellFilter({ config }), /64 KiB/)
  writeFileSync(config, 'private-unparseable-value'); assert.throws(() => diagnoseShellFilter({ config }), error => /not valid JSON/.test(error.message) && !error.message.includes('private'))
  writeFileSync(config, 'null'); assert.match(diagnoseShellFilter({ config }), /No accessible/)
  for (const command of ['echo prumo', 'printf engine.mjs', '']) {
    writeFileSync(evidence, JSON.stringify({ plugin: 'lean-ctx', decision: 'blocked', command })); assert.match(diagnoseShellFilter({ evidence }), /No accessible/)
  }
  for (const command of ['prumo ready', "& 'node' 'scripts/engine.mjs' ready", 'npx prumo ready', 'bunx prumo ready']) {
    writeFileSync(evidence, JSON.stringify({ plugin: 'lean-ctx', decision: 'blocked', command })); assert.match(diagnoseShellFilter({ evidence }), /adjust the allowed/)
  }
  assert.throws(() => diagnoseShellFilter({ config: f.home }), /regular file|EISDIR|EPERM|EACCES/)
})
test('planning advisories compare literal answered questions without inventing semantic resolutions', () => {
  const task = { discovery: { questions: [{ question: ' Preserve   behavior? ', answer: 'Yes' }, { question: 'Pending?', answer: '' }, null] } }
  const plan = { decisions: [{ question: 'Include only non-blockers?', answer: 'Yes' }], openQuestions: [{ question: 'preserve behavior?' }, { question: 'Include only non-blockers?' }, { question: 'Pending?' }, { question: 'Different behavior?' }, null] }
  const phase = { decisions: [{ question: 'Which source?', answer: 'Approved report' }] }
  assert.deepEqual(repeatedPlanQuestions(task, plan, phase), [1, 2])
  assert.deepEqual(repeatedPlanQuestions({}, { openQuestions: [{ question: 'Which source?' }] }, phase), [1])
  assert.deepEqual(repeatedPlanQuestions({}, {}, undefined), [])
  assert.equal(plan.openQuestions.length, 5)
  assert.equal(plan.openQuestions[0].answer, undefined)
  assert.equal(recordedPlanIdentity({}), null)
  assert.deepEqual(recordedPlanIdentity({ taskPlan: {} }), { digest: null, sourcePath: null, plannerRound: null, sourceAttempt: null, embeddedInState: true })
  assert.deepEqual(recordedPlanIdentity({ taskPlan: { digest: 'recorded', sourcePath: 'recorded.json', phaseBinding: { plannerRound: 10 }, attempt: 2 } }), { digest: 'recorded', sourcePath: 'recorded.json', plannerRound: 10, sourceAttempt: 2, embeddedInState: true })
})
test('legacy inspection does not read unrelated evidence or reconstruct a missing start baseline', t => {
  const f = fixture(t)
  f.write('out/oversized.bin', Buffer.alloc(1024 * 1024 + 1))
  assert.equal(checkDelivery(f.state, f.task, '/missing/legacy/cwd').fingerprint, null)
  f.write('out/declared.txt', 'business output')
  f.task.deliveries = ['out/declared.txt']
  assert.match(checkDelivery(f.state, f.task, f.cwd).limitation, /Legacy/)
  assert.deepEqual(Object.keys(captureDelivery({ ...f.task, deliveries: ['out/deleted.txt'] }, f.cwd, false, true).files), [])
  assert.throws(() => captureDelivery({ touches: ['out'], numericProvenance: { manifest: 'out/declared.txt', sources: ['inputs.json'] } }), /recorded project cwd/)
})
test('non-Git projects inspect only approved files and enforce file/traversal/total-byte limits', t => {
  const f = fixture(t)
  rmSync(join(f.cwd, '.git'), { recursive: true, force: true })
  f.task.touches = ['out/', 'missing/']
  f.write('private.txt', 'T1 private context')
  f.write('out/report.txt', 'business result')
  const baseline = captureDelivery(f.task, f.cwd)
  assert.deepEqual(Object.keys(baseline.files), ['out/report.txt'])
  assert.equal(Object.hasOwn(baseline.files['out/report.txt'], 'lines'), false)
  f.task.attempts = [{ deliveryBaseline: baseline }]
  f.write('out/report.txt', 'T1 private-looking text')
  assert.throws(() => checkDelivery(f.state, f.task, f.cwd), /out\/report.txt:1/)
  f.write('out/report.txt', 'clean')
  f.task.touches = ['.']; assert.ok(Object.hasOwn(captureDelivery(f.task, f.cwd).files, 'private.txt'))
  f.task.touches = ['out']
  for (let index = 0; index < 257; index++) f.write(`out/file-${index}`, '')
  assert.throws(() => captureDelivery(f.task, f.cwd), /file count/)
  rmSync(join(f.cwd, 'out'), { recursive: true }); mkdirSync(join(f.cwd, 'out'))
  for (let index = 0; index < 4097; index++) mkdirSync(join(f.cwd, 'out', `directory-${index}`))
  assert.throws(() => captureDelivery(f.task, f.cwd), /traversal/)
  rmSync(join(f.cwd, 'out'), { recursive: true }); mkdirSync(join(f.cwd, 'out'))
  for (let index = 0; index < 9; index++) f.write(`out/megabyte-${index}`, 'x'.repeat(1024 * 1024))
  assert.throws(() => captureDelivery(f.task, f.cwd), /reading limit/)
  const original = fs.fstatSync
  try {
    fs.fstatSync = (...args) => { const stat = original(...args); stat.size = 0; return stat }; syncBuiltinESMExports()
    assert.throws(() => captureDelivery(f.task, f.cwd), /reading limit/)
  } finally { fs.fstatSync = original; syncBuiltinESMExports() }
})
test('file replacement, special entries, partial reads and growth cannot bypass safe evidence reads', t => {
  const f = fixture(t), original = { fstatSync: fs.fstatSync, realpathSync: fs.realpathSync, readSync: fs.readSync, lstatSync: fs.lstatSync }
  const restore = () => { Object.assign(fs, original); syncBuiltinESMExports() }
  t.after(restore)
  f.write('out/report.txt', 'T1 sensitive payload')
  f.task.deliveries = ['out/report.txt']
  const capture = () => captureDelivery(f.task, f.cwd, true, true)
  try {
    fs.fstatSync = (...args) => { const stat = original.fstatSync(...args); stat.ino++; return stat }; syncBuiltinESMExports()
    assert.throws(capture, /path changed/); restore()
    fs.fstatSync = (...args) => { const stat = original.fstatSync(...args); stat.dev++; return stat }; syncBuiltinESMExports()
    assert.throws(capture, /path changed/); restore()
    fs.realpathSync = path => path === join(f.cwd, 'out/report.txt') ? join(f.cwd, 'private.txt') : original.realpathSync(path); syncBuiltinESMExports()
    assert.throws(capture, /path changed/); restore()
    fs.fstatSync = (...args) => { const stat = original.fstatSync(...args); stat.isFile = () => false; return stat }; syncBuiltinESMExports()
    assert.throws(capture, /reading limit/); restore()
    fs.lstatSync = (path, ...args) => { const stat = original.lstatSync(path, ...args); if (path === join(f.cwd, 'out/report.txt')) stat.isFile = () => false; return stat }; syncBuiltinESMExports()
    assert.throws(capture, /not a regular file/); restore()
    fs.readSync = (fd, buffer, offset, length, position) => original.readSync(fd, buffer, offset, Math.min(length, 3), position); syncBuiltinESMExports()
    assert.equal(capture().files['out/report.txt'].lines[0], 'T1 sensitive payload'); restore()
    f.write('out/report.txt', 'x'.repeat(1024 * 1024 + 1))
    fs.fstatSync = (...args) => { const stat = original.fstatSync(...args); stat.size = 0; return stat }; syncBuiltinESMExports()
    assert.throws(capture, /reading limit/); restore()
    f.write('out/report.txt', Buffer.from([0xff, 0x54, 0x31]))
    assert.equal(capture().files['out/report.txt'].binary, true)
    rmSync(join(f.cwd, '.git'), { recursive: true })
    fs.lstatSync = (path, ...args) => { if (path === join(f.cwd, 'out')) throw Object.assign(new Error('Denied'), { code: 'EACCES' }); return original.lstatSync(path, ...args) }; syncBuiltinESMExports()
    assert.throws(() => captureDelivery(f.task, f.cwd), /Denied/)
  } finally { restore() }
})
test('exact large file identities reject replacements hidden by Number rounding', t => {
  const f = fixture(t), target = join(f.cwd, 'out/report.txt')
  f.write('out/report.txt', 'Approved product content'); f.task.deliveries = ['out/report.txt']
  const original = { lstatSync: fs.lstatSync, fstatSync: fs.fstatSync }
  const large = 2n ** 60n
  assert.equal(Number(large), Number(large + 1n), 'the regression must reproduce loss of precision')
  let openedInode = large, openedDevice = large
  try {
    fs.lstatSync = (path, options) => {
      const stat = original.lstatSync(path, options)
      if (path === target && options?.bigint) { stat.ino = large; stat.dev = large }
      return stat
    }
    fs.fstatSync = (fd, options) => {
      assert.equal(options?.bigint, true, 'file identity must use exact integers')
      const stat = original.fstatSync(fd, options); stat.ino = openedInode; stat.dev = openedDevice
      return stat
    }
    syncBuiltinESMExports()
    const capture = () => captureDelivery(f.task, f.cwd, true, true)
    assert.equal(capture().files['out/report.txt'].lines[0], 'Approved product content')
    openedInode = large + 1n; assert.throws(capture, /path changed/)
    openedInode = large; openedDevice = large + 1n; assert.throws(capture, /path changed/)
  } finally { Object.assign(fs, original); syncBuiltinESMExports() }
})
test('an open block freezes recorded stage duration at its real event without inventing a missing endpoint', () => {
  const state = { tasks: { T1: { state: 'blocked', stateBeforeBlock: 'running', attempts: [{ agent: 'author', startedAt: at(0) }] } } }
  const measured = recordedAgentTiming(state, [{ type: 'task_block', task: 'T1', at: at(4) }], Date.parse(at(10)))
  assert.equal(measured.roles.execution.stageMs, 4 * 60000)
  assert.equal(measured.elapsedMs, 4 * 60000)
  const unknown = recordedAgentTiming(state, [], Date.parse(at(10)), false)
  assert.equal(unknown.roles.execution.durationMs, 0)
  assert.equal(unknown.partial, true)
})
test('numeric checks refuse source mutation during validation even when the sum stays unchanged', t => {
  const f = fixture(t)
  f.task.numericProvenance = { manifest: 'out/provenance.json', sources: ['inputs.json'] }
  f.task.validation = [{ kind: 'functional', run: `node -e "const fs=require('fs'); if(!fs.existsSync('mutation-recorded')) {fs.writeFileSync('inputs.json',JSON.stringify({rows:[1,4]}));fs.writeFileSync('mutation-recorded','yes')}"`, expect: 'Source remains the inspected version' }]
  f.write('inputs.json', { rows: [2, 3] }); f.write('out/summary.json', { total: 5 })
  f.write('out/provenance.json', { claims: [{ source: 'inputs.json', pointer: '/rows', operation: 'sum', value: 5, result: { source: 'out/summary.json', pointer: '/total' } }] }); f.save()
  f.cli(['start', 'T1', '--agent', 'author']); f.cli(['review', 'T1', '--agent', 'reviewer'])
  assert.match(f.cli(['validate', 'T1', '--ok', '--cwd', f.cwd, '--evidence', 'Inspected originals'], 1), /sources changed during validation/)
  assert.equal(f.read().tasks.T1.validations.at(-1).ok, false)
  assert.equal(f.read().tasks.T1.attempts.length, 1)
  f.cli(['validate', 'T1', '--ok', '--cwd', f.cwd, '--evidence', 'Inspected corrected current sources']); f.cli(['done', 'T1'])
})
test('init uses the environment or short selector and retains safe CURRENT behavior', t => {
  const f = fixture(t), source = join(f.home, 'plan.json')
  writeFileSync(source, JSON.stringify({ name: 'new delivery', planningMode: 'task', tasks: [{ id: 'T1', title: 'Produce business output', touches: ['out'], validation: f.task.validation }] }))
  f.cli(['init', '--plan', source], 0, { PRUMO_RUN: 'selected' })
  assert.equal(JSON.parse(readFileSync(join(f.root, '.specs/graph/selected/state.json'))).run, 'selected')
  assert.equal(readFileSync(join(f.root, '.specs/graph/CURRENT'), 'utf8').trim(), 'selected')
  f.cli(['init', '-r', 'short', '--plan', source], 0, { PRUMO_RUN: '../unsafe' })
  f.cli(['init', '--plan', source], 1, { PRUMO_RUN: '../unsafe' })
  assert.match(f.cli(['status'], 0, { PRUMO_RUN: undefined }), /run: short/)
  assert.equal(f.read().tasks.T1.attempts.length, 0)
})
test('optional contract validation rejects malformed references without weakening historical contracts', t => {
  const f = fixture(t)
  for (const patch of [
    { textRules: { exceptions: Array.from({ length: 65 }, () => ({})) } },
    { textRules: { exceptions: [{ path: 'out/a', line: -1, identifier: 'T1' }] } },
    { textRules: { exceptions: [{ path: 'out/a', line: 1, identifier: '' }] } },
    { numericProvenance: { manifest: 'out/a', sources: [] } },
    { numericProvenance: { manifest: 'out/a', sources: ['../secret'] } },
  ]) assert.throws(() => assertEvidenceContract({ ...f.task, ...patch }))
  f.task.numericProvenance = { manifest: 'out/provenance.json', sources: ['input.json'] }
  f.write('input.json', { values: [1, '2'], number: 1, null: null })
  f.write('out/summary.json', 1)
  const claim = { source: 'input.json', pointer: '/number', operation: 'value', value: 1, result: { source: 'out/summary.json', pointer: '' } }
  f.write('out/provenance.json', { claims: [claim] }); assert.equal(verifyNumericProvenance(f.task, f.cwd).claims, 1)
  for (const patch of [{ pointer: 'number' }, { pointer: '/~2' }, { pointer: 1 }, { pointer: '/null/absent' }, { pointer: '/number/absent' }, { pointer: '/values', operation: 'sum' }, { pointer: '/number', operation: 'count' }]) {
    f.write('out/provenance.json', { claims: [{ ...claim, ...patch }] }); assert.throws(() => verifyNumericProvenance(f.task, f.cwd), /provenance|Provenance/)
  }
  f.write('input.json', '1e309'); f.write('out/provenance.json', { claims: [{ ...claim, pointer: '', value: 1 }] }); assert.throws(() => verifyNumericProvenance(f.task, f.cwd), /diverges/)
  f.write('out/provenance.json', { claims: Array(257).fill(claim) }); assert.throws(() => verifyNumericProvenance(f.task, f.cwd), /bounded claims/)
})
test('phase worker metadata and usage are attributed once, while past assignments keep their supplied values', () => {
  const prior = { plan: {}, tasks: { T1: { discussionAttempts: [{ agent: 'discussion-one', startedAt: at(0) }] } } }
  const state = structuredClone(prior)
  state.plan.rolePreferences = { planning: { effort: 'high' } }
  state.phaseWorkflows = { F1: { discussionAttempts: [{ n: 1, agent: 'phase-reader', startedAt: at(1) }], planningAttempts: [{ n: 1, agent: 'envelope', startedAt: at(2), workers: { T1: { agent: 'planner-one', startedAt: at(2), usageReports: [{ task: 'T1', role: 'planning', tokens: 10, tools: 1 }] }, T2: { startedAt: at(2), usageReports: [{ task: 'T2', role: 'planning' }] } } }] } }
  const records = recordDispatchMetadata(prior, state, { effort: 'medium' })
  assert.equal(records.length, 3)
  assert.deepEqual(records.find(record => record.agent === 'planner-one').requested, { effort: 'high' })
  assert.deepEqual(records.find(record => record.agent === 'planner-one').reported, { effort: 'medium' })
  assert.equal(records.find(record => record.agent === null).role, 'planning')
  assert.equal(state.tasks.T1.discussionAttempts[0].modelDispatches, undefined)
  assert.equal(reportedUsageTotals(state).run.receipts, 2)
  assert.equal(reportedUsageTotals(state).run.tokens, 10)
  const next = structuredClone(state); next.phaseWorkflows.F1.discussionAttempts[0].activityAgent = 'ignored-secondary';
  assert.deepEqual(recordDispatchMetadata(state, next), [])
  assert.equal(reportedUsageTotals({}).run.receipts, 0)
})
test('brief gives dependency deliveries and skip receipts without promoting pending validation to a verdict', () => {
  const state = { run: 'old', plan: {}, tasks: { D: { state: 'done', deliveries: ['out/source.json'], validations: [{ ok: true, agent: 'independent' }] }, S: { state: 'skipped', skipReason: 'Explicitly skipped' } } }
  const task = { id: 'T1', deps: ['D', 'S'], attempts: [{ n: 1, result: 'failed', reason: 'Original rejection', modelDispatches: [], scopeBaseline: { method: 'git', cwd: 'recorded', limitation: 'partial' } }], validations: [{ by: 'review', ok: false, token: 'pending-receipt', evidence: 'Validation has started' }], planningSkips: [{ reason: 'Approved' }], discussionSkips: [{ reason: 'Approved' }], discovery: { decisions: [] } }
  const brief = taskBrief(state, task, 'executor', tokens => tokens.join(' '))
  assert.equal(brief.lastRejection.reason, 'Original rejection')
  assert.equal(brief.dependencyDeliveries[0].terminalReceipt.agent, 'independent')
  assert.equal(brief.dependencyDeliveries[1].skipReason, 'Explicitly skipped')
  assert.equal(brief.scopeBaseline.method, 'git')
  task.validations[0].error = 'Executable check failed'
  assert.equal(taskBrief(state, task, 'reviewer', tokens => tokens.join(' ')).lastRejection.error, 'Executable check failed')
  pauseRun({ tasks: {} }, 'Pause', undefined, at(0))
  const resumed = { runPause: { startedAt: at(0) }, runPauseHistory: [{ startedAt: at(1) }] }; resumeRun(resumed, at(2)); assert.equal(resumed.runPauseHistory[0].endedAt, undefined)
})
test('resuming the same executor or reviewer records newly supplied dispatch preferences without rewriting stage history', t => {
  const f = fixture(t)
  f.cli(['start', 'T1', '--agent', 'author', '--model', 'first'])
  const startedAt = f.read().tasks.T1.attempts[0].startedAt
  f.cli(['block', 'T1', '--reason', 'Session restart'])
  f.cli(['set-role', '--role', 'execution', '--model', 'requested-next'])
  f.cli(['unblock', 'T1', '--model', 'second'])
  let attempt = f.read().tasks.T1.attempts[0]
  assert.equal(attempt.startedAt, startedAt); assert.equal(attempt.modelDispatches[0].reported.model, 'first')
  assert.equal(attempt.modelDispatches.at(-1).reported.model, 'second')
  assert.equal(attempt.modelDispatches.at(-1).requested.model, 'requested-next')
  f.cli(['review', 'T1', '--agent', 'reviewer', '--model', 'review-first'])
  const reviewStartedAt = f.read().tasks.T1.attempts[0].reviewStartedAt
  f.cli(['block', 'T1', '--reason', 'Review session restart']); f.cli(['unblock', 'T1', '--reviewer', 'reviewer', '--model', 'review-second'])
  attempt = f.read().tasks.T1.attempts[0]
  assert.equal(attempt.reviewStartedAt, reviewStartedAt)
  assert.equal(attempt.reviewHistory, undefined)
  assert.equal(attempt.modelDispatches.at(-1).reported.model, 'review-second')
  assert.equal(f.read().tasks.T1.attempts.length, 1)
})
test('phase usage selects the recorded worker, preserves old phases and refuses an ambiguous legacy choice', t => {
  const f = fixture(t)
  f.state.phaseWorkflows = { F1: { planningAttempts: [{ n: 1, workers: { T1: { agent: 'first', startedAt: at(0) } } }] }, F2: { planningAttempts: [{ n: 1, workers: { T1: { agent: 'second', startedAt: at(1) } } }] } }; f.save()
  const args = ['report-usage', 'T1', '--role', 'planning', '--attempt', '1', '--receipt', 'planning-report', '--tokens', '20']
  assert.match(f.cli(args, 1), /select --phase explicitly/)
  f.cli([...args, '--phase', 'F1']); f.cli([...args, '--phase', 'F1'])
  assert.equal(f.read().phaseWorkflows.F1.planningAttempts[0].workers.T1.usageReports.length, 1)
  assert.equal(f.read().phaseWorkflows.F2.planningAttempts[0].workers.T1.usageReports, undefined)
  const state = f.read(); state.tasks.T1.phase = 'F2'; writeFileSync(join(f.run, 'state.json'), JSON.stringify(state))
  f.cli(args); assert.equal(reportedUsageTotals(f.read()).run.tokens, 40)
  f.cli([...args, '--phase', 'missing'], 1)
})
test('brief retains recorded phase discussion and role preferences for the current task', () => {
  const state = { plan: { rolePreferences: { execution: { model: 'requested' } } }, phaseWorkflows: { F1: { discovery: { decisions: [{ question: 'Approved source?', answer: 'Recorded source' }] }, discussionSkips: [{ reason: 'Explicit' }], planningSkips: [], planningAttempts: [{ workers: { T1: { modelDispatches: [{ role: 'planning', reported: { model: 'planner-reported' } }] } } }] } }, tasks: { T1: { planningAttempts: [{ modelDispatches: [{ role: 'planning', reported: null }] }] }, D: { state: 'done' } } }
  const brief = taskBrief(state, { id: 'T1', phase: 'F1', deps: ['D'] }, 'executor', tokens => tokens.join(' '))
  assert.equal(brief.phaseContext.discovery.decisions[0].answer, 'Recorded source')
  assert.equal(brief.modelPreference.model, 'requested')
  assert.equal(brief.planningAndDiscussionDispatches.length, 2)
  assert.equal(brief.dependencyDeliveries[0].terminalReceipt, null)
  state.phaseWorkflows.F1 = {}
  assert.equal(taskBrief(state, { id: 'T1', phase: 'F1' }, 'reviewer', () => '').phaseContext.discovery, null)
})
test('agent and task names that resemble prototype properties remain isolated ledger entries', () => {
  const state = { tasks: Object.fromEntries([['__proto__', { state: 'done', attempts: [{ agent: '__proto__', startedAt: at(0), endedAt: at(3), usageReports: [{ task: '__proto__', tokens: 5, tools: 1 }] }] }], ['constructor', { state: 'done', attempts: [{ agent: 'constructor', startedAt: at(0), endedAt: at(2) }] }]]) }
  const timing = recordedAgentTiming(state, [{ task: '__proto__', type: 'task_block', at: at(1) }, { task: '__proto__', type: 'task_unblock', at: at(2) }])
  assert.equal(timing.agents.__proto__.execution.stageMs, 120000)
  assert.equal(timing.agents.constructor.execution.stageMs, 120000)
  assert.equal(timing.roles.execution.durationMs, 240000)
  assert.equal(reportedUsageTotals(state).tasks.__proto__.tokens, 5)
  assert.equal(Object.prototype.tokens, undefined)
  assert.equal(Object.prototype.execution, undefined)
})
test('declared ignored deliveries, phase identifiers and run names obey the same literal boundary and exception rules', t => {
  const f = fixture(t)
  f.state.plan.phases = [{ id: 'F6' }]
  f.write('.gitignore', 'out/ignored.txt\n')
  f.write('out/ignored.txt', 'original business text')
  f.task.deliveries = ['out/ignored.txt']
  f.task.attempts = [{ deliveryBaseline: captureDelivery(f.task, f.cwd) }]
  assert.ok(f.task.attempts[0].deliveryBaseline.files['out/ignored.txt'])
  for (const value of ['F6_summary', 'DEMO-result', 'APPROVED-DELIVERY_report']) {
    f.write('out/ignored.txt', value)
    assert.throws(() => checkDelivery(f.state, f.task, f.cwd), /out\/ignored.txt:1/)
  }
  f.write('out/ignored.txt', 'F60 and common reviewer executor words')
  assert.equal(checkDelivery(f.state, f.task, f.cwd).binaryPaths.length, 0)
  f.task.textRules = { exceptions: [{ path: 'out\\ignored.txt', line: 1, identifier: 'F6' }] }
  f.write('out/ignored.txt', 'f6_summary')
  assert.ok(checkDelivery(f.state, f.task, f.cwd).fingerprint)
  assertEvidenceContract({ textRules: {} })
  for (const patch of [{ deliveries: ['out/a'] }, { textRules: { exceptions: [{ path: 'out/a', line: 0, identifier: 'T1' }] } }, { numericProvenance: { manifest: 'out/a', sources: ['input'] } }]) assert.throws(() => assertEvidenceContract(patch), /approved touches/)
  assert.deepEqual(Object.keys(captureDelivery({ touches: ['out'] }, f.cwd, false, true).files), [])
  f.task.deliveries = undefined; f.task.textRules = undefined
  for (let index = 0; index < 257; index++) f.write(`out/file-${index}`, '')
  assert.throws(() => captureDelivery(f.task, f.cwd), /file count/)
})
test('historical review handoff retains measured intervals and missing interval arrays without multiplying work', () => {
  const make = intervals => ({ plan: {}, tasks: { T1: { state: 'reviewing', attempts: [{ agent: 'author', reviewer: 'first', startedAt: at(0), reviewStartedAt: at(2), ...(intervals === undefined ? {} : { activityIntervals: intervals }) }] } } })
  for (const intervals of [undefined, [{ role: 'execution', startedAt: at(0), endedAt: at(2) }, { role: 'review', startedAt: at(2), endedAt: at(3) }, { role: 'review', startedAt: at(4) }]]) {
    const prior = make(intervals), state = structuredClone(prior), attempt = state.tasks.T1.attempts[0]
    attempt.reviewer = 'second'; attempt.reviewStartedAt = at(5)
    recordDispatchMetadata(prior, state)
    assert.equal(attempt.reviewHistory.length, 1)
    assert.equal(attempt.reviewHistory[0].reviewEndedAt, at(5))
    assert.equal(attempt.activityIntervals.some(interval => interval.role === 'review'), false)
    const actual = recordedAgentTiming(state, [], Date.parse(at(7)))
    assert.equal(actual.roles.execution.durationMs, 120000)
    assert.equal(actual.roles.review.durationMs, intervals ? 240000 : 300000)
  }
})
test('partial stage history uses only real endpoints and counts phase workers rather than mirrored task rounds', () => {
  const state = { runPauseHistory: [{ startedAt: at(8) }], tasks: { T1: { phase: 'F1', state: 'planned', planningAttempts: [{ agent: 'coordinator-copy', startedAt: at(0), endedAt: at(2) }] }, T2: { phase: 'F1', state: 'pending', discussionAttempts: [{ activityAgent: 'discussion', startedAt: at(2), endedAt: at(3) }] }, T3: { phase: 'F1', state: 'done', planningAttempts: [{ activityIntervals: [{ role: 'planning', agent: 'partial-planner', startedAt: at(4), endedAt: at(5) }] }] }, T4: { state: 'done', attempts: [{ activityIntervals: [{ role: 'review', agent: 'reviewer', startedAt: at(6), endedAt: at(7) }] }] } }, phaseWorkflows: { F1: { state: 'planned', planningAttempts: [{ startedAt: at(0), endedAt: at(2), workers: { T1: { agent: 'worker', startedAt: at(0), endedAt: at(2) } } }], discussionAttempts: [{ agent: 'phase-discussion', startedAt: at(0), endedAt: at(1) }] } } }
  const timing = recordedAgentTiming(state, [], Date.parse(at(10)))
  assert.equal(timing.roles.planning.durationMs, 180000)
  assert.equal(timing.roles.planning.measuredMs, 60000)
  assert.equal(timing.agents['coordinator-copy'], undefined)
  assert.equal(timing.roles.discussion.stageMs, 120000)
  assert.equal(timing.roles.review.measuredMs, 60000)
  assert.equal(timing.partial, true)
  for (const status of ['discussing', 'planning', 'running', 'reviewing']) {
    const missing = recordedAgentTiming({ tasks: { T1: { state: status } } })
    assert.equal(missing.partial, true)
    assert.equal(missing.elapsedMs, 0)
  }
  const unfinished = recordedAgentTiming({ tasks: { T1: { state: 'done', attempts: [{ startedAt: at(0), activityIntervals: [{ role: 'execution', startedAt: at(0) }] }] } } }, [], Date.parse(at(10)))
  assert.equal(unfinished.roles.execution.durationMs, 0)
  assert.equal(unfinished.partial, true)
  const envelope = recordedAgentTiming({ phaseWorkflows: { old: { state: 'discussing', discussionAttempts: [{ startedAt: at(0) }] } } }, [], Date.parse(at(2)))
  assert.equal(envelope.roles.discussion.stageMs, 120000)
  assert.equal(envelope.roles.discussion.measuredMs, 0)
  const receipts = recordedAgentTiming({ tasks: { T1: { state: 'done', attempts: [{ n: 1, startedAt: at(0), reviewStartedAt: at(1) }], validations: [{ by: 'review', agent: 'recorded', attempt: 1, at: at(2) }] } } }, [], Date.parse(at(3)))
  assert.equal(receipts.roles.review.stageMs, 60000)
})
test('shell commands follow positive Windows shell evidence and quote supplied text literally', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'), saved = { MSYSTEM: process.env.MSYSTEM, SHELL: process.env.SHELL }
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    delete process.env.MSYSTEM; delete process.env.SHELL
    assert.equal(shellCommand(['node', "a'b"]), "& 'node' 'a''b'")
    process.env.MSYSTEM = 'MINGW64'; assert.equal(shellCommand(['node', "a'b"]), "'node' 'a'\\''b'")
    delete process.env.MSYSTEM; process.env.SHELL = '/bin/bash'
    assert.equal(shellCommand(['node', '$HOME']), "'node' '$HOME'")
  } finally {
    Object.defineProperty(process, 'platform', platform)
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})
test('invalid optional CLI metadata is rejected before recording costs, preferences or a new attempt', t => {
  const f = fixture(t)
  f.cli(['start', 'T1', '--agent', 'author'])
  const before = f.read().tasks.T1.attempts.length
  for (const args of [
    ['set-role', '--role', 'unknown', '--model', 'name'], ['set-role', '--role', 'execution'],
    ['report-usage', 'T1', '--role', 'unknown', '--receipt', 'id'],
    ['report-usage', 'T1', '--role', 'review', '--receipt', 'id', '--tokens', '1'],
    ['report-usage', 'T1', '--role', 'execution', '--receipt', 'id'],
    ['report-usage', 'T1', '--role', 'execution', '--receipt', 'id', '--tokens', '-1'],
    ['report-usage', 'T1', '--role', 'execution', '--receipt', 'id', '--tokens', '9007199254740992'],
    ['report-usage', 'T1', '--role', 'execution', '--receipt', 'id', '--tools', '1.5'],
    ['report-usage', 'T1', '--role', 'execution', '--receipt', 'x'.repeat(129), '--tokens', '1'],
    ['report-usage', 'T1', '--role', 'execution', '--receipt', 'id', '--attempt', '99', '--tokens', '1'],
    ['brief', 'T1', '--role', 'unknown'], ['pause-run', '--reason', 'Forecast', '--until', 'invalid'],
    ['verify-provenance', 'T1'],
    ['show-check', 'T1', '--check', '9'], ['show-check', 'T1', '--attempt', '9'],
  ]) f.cli(args, 1)
  assert.equal(f.read().tasks.T1.attempts.length, before)
  assert.equal(reportedUsageTotals(f.read()).run.receipts, 0)
  assert.equal(f.read().runPause, undefined)
})
test('changed existing filenames are attributable deliveries while unchanged unrelated files stay permitted', t => {
  const f = fixture(t)
  f.write('out/t1_historical.txt', 'original product content')
  f.task.attempts = [{ deliveryBaseline: captureDelivery(f.task, f.cwd) }]
  assert.ok(checkDelivery(f.state, f.task, f.cwd).fingerprint)
  f.write('out/t1_historical.txt', 'changed product content')
  assert.throws(() => checkDelivery(f.state, f.task, f.cwd), /out\/t1_historical.txt:0/)
  f.task.textRules = { exceptions: [{ path: 'out/./t1_historical.txt', line: 0, identifier: 'T1' }] }
  assert.ok(checkDelivery(f.state, f.task, f.cwd).fingerprint)
  f.write('out/t1_historical.txt', 'original product content')
  f.task.textRules = undefined; f.task.deliveries = ['out\\t1_historical.txt']
  assert.throws(() => checkDelivery(f.state, f.task, f.cwd), /out\/t1_historical.txt:0/)
  f.task.textRules = { exceptions: [{ path: 'out\\t1_historical.txt', line: 0, identifier: 'T1' }] }
  assert.ok(checkDelivery(f.state, f.task, f.cwd).fingerprint)
  assert.equal(Object.keys(captureDelivery(f.task, f.cwd).files).length, 1)
})
test('pausing closes only current role intervals and preserves partial historical endpoints and terminal records', () => {
  const historical = { state: 'done', stateRevision: 2, attempts: [{ agent: 'old', startedAt: at(0), endedAt: at(1), activityIntervals: [{ role: 'execution', startedAt: at(0) }] }] }
  const state = { tasks: { DONE: historical, ACTIVE: { state: 'reviewing', attempts: [{ agent: 'author', reviewer: 'reviewer', startedAt: at(0), reviewStartedAt: at(2), activityIntervals: [{ role: 'execution', startedAt: at(0), endedAt: at(2) }, { role: 'review', startedAt: at(2) }] }] }, UNKNOWN: { state: 'planning' }, CLOSED: { state: 'planning', planningAttempts: [{ startedAt: at(0), endedAt: at(1), activityIntervals: [{ role: 'planning', startedAt: at(0) }] }] } }, phaseWorkflows: { F1: { state: 'planning', planningAttempts: [{ startedAt: at(2), workers: { T1: { startedAt: at(2), activityIntervals: [{ role: 'planning', startedAt: at(2) }] }, T2: { startedAt: at(0), endedAt: at(1), activityIntervals: [{ role: 'planning', startedAt: at(0) }] } } }] } } }
  const before = structuredClone(historical)
  pauseRun(state, 'Pause current work', undefined, at(3))
  assert.deepEqual(historical, before)
  assert.equal(state.tasks.CLOSED.planningAttempts[0].activityIntervals[0].endedAt, undefined)
  assert.equal(state.tasks.ACTIVE.attempts[0].activityIntervals[1].endedAt, at(3))
  assert.equal(state.tasks.ACTIVE.stateRevision, 1)
  assert.equal(state.phaseWorkflows.F1.planningAttempts[0].workers.T1.activityIntervals[0].endedAt, at(3))
  assert.equal(state.phaseWorkflows.F1.planningAttempts[0].workers.T2.activityIntervals[0].endedAt, undefined)
})

test('declared deliveries inspect existing content while unrelated baseline files stay discounted', t => {
  const f = fixture(t)
  f.write('out/delivery.txt', 'historical T1')
  f.write('out/unrelated.txt', 'historical T1')
  f.task.attempts = [{ deliveryBaseline: captureDelivery(f.task, f.cwd) }]
  f.task.deliveries = ['out/delivery.txt']
  assert.throws(() => checkDelivery(f.state, f.task, f.cwd), /delivery.txt:1/)
  f.write('out/delivery.txt', 'Approved business outcome')
  assert.ok(checkDelivery(f.state, f.task, f.cwd).fingerprint)
})
test('legacy phase consumption uses its real recorded round and refuses aggregate overflow without saving', t => {
  const f = fixture(t)
  f.state.phaseWorkflows = { F1: { planningAttempts: [{ n: 1, agent: 'legacy-planner', targets: ['T1'], startedAt: at(0), endedAt: at(2) }] } }; f.save()
  const args = ['report-usage', 'T1', '--phase', 'F1', '--role', 'planning', '--attempt', '1']
  f.cli([...args, '--receipt', 'largest', '--tokens', String(Number.MAX_SAFE_INTEGER)])
  const saved = f.read(), round = saved.phaseWorkflows.F1.planningAttempts[0]
  assert.equal(round.workers, undefined); assert.equal(round.startedAt, at(0)); assert.equal(round.endedAt, at(2))
  assert.equal(saved.tasks.T1.planningAttempts?.length ?? 0, 0)
  assert.equal(reportedUsageTotals(saved).run.tokens, Number.MAX_SAFE_INTEGER)
  assert.match(f.cli([...args, '--receipt', 'overflow', '--tokens', '1'], 1), /safe integer limits/)
  assert.deepEqual(f.read(), saved)
})
test('resume restores stage duration after a pause-closed activity interval without inventing measured work', () => {
  const state = { tasks: { T1: { state: 'running', attempts: [{ agent: 'executor', startedAt: at(0), activityIntervals: [{ role: 'execution', agent: 'executor', startedAt: at(0), endedAt: at(2), closedBy: 'run-pause' }] }] } }, runPauseHistory: [{ startedAt: at(2), endedAt: at(4) }] }
  let timing = recordedAgentTiming(state, [], Date.parse(at(6)))
  assert.equal(timing.elapsedMs, 240000); assert.equal(timing.roles.execution.measuredMs, 120000); assert.equal(timing.roles.execution.stageMs, 120000)
  state.tasks.T1.attempts[0].activityIntervals.push({ role: 'execution', agent: 'executor', startedAt: at(5), endedAt: at(6) })
  timing = recordedAgentTiming(state, [], Date.parse(at(6)))
  assert.equal(timing.elapsedMs, 240000); assert.equal(timing.roles.execution.measuredMs, 180000); assert.equal(timing.roles.execution.stageMs, 60000)
  state.tasks.T1.attempts[0].activityIntervals[0].endedAt = at(1)
  assert.equal(recordedAgentTiming(state, [], Date.parse(at(6))).roles.execution.stageMs, 0)
  const partial = { tasks: { T1: { taskPlan: { planner: 'legacy', startedAt: at(0), completedAt: at(3) }, discovery: { recordedAt: at(0) } }, T2: { taskPlan: { phaseBinding: {}, startedAt: at(0), completedAt: at(3) } } } }
  timing = recordedAgentTiming(partial, [], Date.parse(at(6)))
  assert.equal(timing.roles.planning.stageMs, 180000); assert.equal(timing.roles.planning.measuredMs, 0); assert.equal(timing.roles.planning.partial, true); assert.equal(timing.roles.discussion.partial, true)
  assert.equal(partial.tasks.T1.planningAttempts, undefined)
})

test('partial historical artifacts avoid phase envelopes and review receipts preserve their actual attribution', () => {
  const state = { tasks: {
    T1: { phase: 'F1', taskPlan: { planner: 'wrong-envelope', startedAt: at(0), completedAt: at(5) } },
    T2: { state: 'planning' }, T3: { state: 'discussing', discovery: { recordedAt: at(0) }, discussionAttempts: [] },
    T4: { discovery: {}, discussionAttempts: [{ agent: 'discussion', startedAt: at(0), endedAt: at(1) }] },
    T5: { state: 'done', attempts: [{ agent: 'executor', startedAt: at(0), reviewStartedAt: at(1) }], validations: [{ by: 'review', attempt: 1, at: at(2) }] },
    T6: { state: 'done', attempts: [{ n: 1, agent: 'executor', reviewer: 'fresh', startedAt: at(0), reviewStartedAt: at(1) }], validations: [{ by: 'review', attempt: 1, agent: 'fresh', at: at(2) }, { by: 'review', attempt: 1, agent: 'other', at: at(5) }] },
  }, phaseWorkflows: { F1: { planningAttempts: [{ workers: { T1: { agent: 'worker', startedAt: at(2), endedAt: at(3) } } }] } } }
  const timing = recordedAgentTiming(state, [], Date.parse(at(6)))
  assert.equal(timing.roles.planning.durationMs, 60000)
  assert.equal(timing.agents['wrong-envelope'], undefined)
  assert.equal(timing.agents.fresh.review.durationMs, 60000)
  assert.equal(timing.roles.planning.partial, true); assert.equal(timing.roles.discussion.partial, true)
  const active = { tasks: { T1: { state: 'running', attempts: [{ startedAt: at(0) }] } } }
  pauseRun(active, 'Actual pause', undefined, at(1))
  assert.equal(active.tasks.T1.attempts[0].activityIntervals, undefined)
})
test('doctor bounds actual bytes even if a diagnostic file grows after stat and accepts partial reads', t => {
  const f = fixture(t), path = join(f.home, 'diagnostic.json'), originalStat = fs.fstatSync, originalRead = fs.readSync
  writeFileSync(path, JSON.stringify({ plugins: { 'lean-ctx': { allowedCommands: [] } } }))
  try {
    fs.readSync = (fd, buffer, offset, length, position) => originalRead(fd, buffer, offset, Math.min(length, 2), position)
    syncBuiltinESMExports()
    assert.match(diagnoseShellFilter({ config: path }), /Accessible/)
    writeFileSync(path, 'x'.repeat(65537))
    fs.fstatSync = fd => { const stat = originalStat(fd); return { ...stat, size: 0, isFile: () => true } }
    syncBuiltinESMExports()
    assert.throws(() => diagnoseShellFilter({ config: path }), /64 KiB/)
  } finally { fs.fstatSync = originalStat; fs.readSync = originalRead; syncBuiltinESMExports() }
  writeFileSync(path, JSON.stringify({ plugin: 'lean-ctx', decision: 'blocked', command: 'node' }))
  assert.match(diagnoseShellFilter({ evidence: path }), /No accessible/)
  f.task.deliveries = ['out/value.txt']; f.write('out/value.txt', 'Business text')
  assert.ok(checkDelivery({ tasks: f.state.tasks, plan: {} }, f.task, f.cwd).fingerprint)
})
