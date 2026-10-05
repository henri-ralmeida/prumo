import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { taskIdentifierProblem } from './task-identifiers.mjs'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), 'engine.mjs')
const check = { kind: 'functional', run: 'node -e "process.exit(0)"', expect: 'verified' }
const task = (id, deps = []) => ({ id, title: id, deps, validation: [check] })
const issue = (tasks, existingIds) => taskIdentifierProblem(tasks, existingIds)?.message ?? null

test('o plano inicial exige T1..Tn sem lacunas, sufixos, zeros ou variantes de caixa', () => {
  assert.equal(issue([task('T3'), task('T1'), task('T2')]), null)
  for (const ids of [['T1', 'T3'], ['T2'], ['T1', 'T1a'], ['T01'], ['t1'], ['T1', 'T1']])
    assert.ok(issue(ids.map(id => task(id))), ids.join(', '))
  assert.ok(issue([task('A1'), task('B2')]), 'novos planos não aceitam formatos genéricos')
})

test('IDs genéricos permanecem compatíveis somente em planos legados inteiramente genéricos', () => {
  assert.ok(issue([task('A1'), task('B2')]))
  assert.ok(issue([task('T1'), task('A1')]), 'plano inicial T não mistura identificador genérico')
  assert.ok(issue([task('A1'), task('T1')]), 'a ordem não altera a regra de mistura')
  assert.equal(issue([task('A1'), task('B2')], ['A1']), null, 'sync legado A/B continua válido')
  assert.ok(issue([task('T1'), task('A1')], ['T1']), 'sync de execução T não aceita novo A1')
})

test('ampliações seguem a..z, inclusive após sufixos persistidos', () => {
  assert.equal(issue([task('T1'), task('T1a', ['T1']), task('T1b', ['T1a'])], ['T1']), null)
  assert.equal(issue([task('T1'), task('T1a', ['T1']), task('T1b', ['T1a'])], ['T1', 'T1a']), null)
  assert.ok(issue([task('T1'), task('T1b', ['T1'])], ['T1']), 'não pode saltar a')
  assert.ok(issue([task('T1'), task('T1a', ['T1']), task('T1c', ['T1'])], ['T1', 'T1a']),
    'não pode saltar b após a persistido')
  const allSuffixes = Array.from({ length: 26 }, (_, i) => `T1${String.fromCharCode(97 + i)}`)
  assert.equal(issue([task('T1'), ...allSuffixes.map(id => task(id, ['T1']))],
    ['T1', ...allSuffixes.slice(0, -1)]), null, 'z encerra a sequência válida')
  assert.ok(issue([task('T1'), ...allSuffixes.map(id => task(id, ['T1'])), task('T1aa', ['T1'])],
    ['T1', ...allSuffixes]), 'não há sufixo após z')
})

test('ampliações exigem pai numérico persistido e vínculo de dependência', () => {
  assert.ok(issue([task('T1'), task('T2a', ['T1'])], ['T1']), 'T2 criado no mesmo sync não é pai persistido')
  assert.ok(issue([task('T1'), task('T1a')], ['T1']), 'filha solta é rejeitada')
  assert.equal(issue([task('T1'), task('T1a', ['A1']), task('A1', ['T1'])], ['T1', 'A1']), null)
  assert.ok(issue([task('T1'), task('T1A', ['T1'])], ['T1']), 'sufixo novo deve ser minúsculo')
  assert.ok(issue([task('T1'), task('T1a', ['T1']), task('T1A', ['T1'])], ['T1']),
    'variante de caixa não pode duplicar a filha')
})

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-task-ids-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const root = join(home, 'workspace')
  mkdirSync(root)
  const planPath = join(root, 'plan.json')
  const runDir = join(root, '.specs', 'graph', 'identifiers')
  const env = { ...process.env, PRUMO_HOME: home, PRUMO_ROOT: root, PRUMO_LANG: 'en' }
  return {
    planPath, runDir,
    write: (tasks, phases) => writeFileSync(planPath, JSON.stringify({ name: 'identifiers', tasks, ...(phases ? { phases } : {}) })),
    run: (...args) => {
      const result = spawnSync(process.execPath, [engine, ...args], {
        cwd: root, env, encoding: 'utf8', timeout: 20000,
      })
      if (result.error) throw result.error
      return result
    },
    state: () => readFileSync(join(runDir, 'state.json'), 'utf8'),
    events: () => readFileSync(join(runDir, 'events.ndjson'), 'utf8'),
  }
}

test('sync mantém derivadas na fase original e rejeita nova fase sem modificar estado ou eventos', t => {
  const f = fixture(t)
  const phases = [{ id: 'F1', title: 'Original' }]
  const original = [{ ...task('T1'), phase: 'F1' }]
  f.write(original, phases)
  const initialized = f.run('init', '--plan', f.planPath, '--run', 'identifiers')
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr)
  const rejectedPlans = [
    [...original, { ...task('T1a', ['T1']), summary: 'Complemento da tarefa original.', phase: 'F2' }],
    [{ ...original[0], phase: 'F2' }, { ...task('T1a', ['T1']), summary: 'Complemento da tarefa original.', phase: 'F2' }],
  ]
  for (const tasks of rejectedPlans) {
    const beforeState = f.state(), beforeEvents = f.events()
    f.write(tasks, [...phases, { id: 'F2', title: 'Fase criada para a derivada' }])
    const rejected = f.run('sync-plan', '--plan', f.planPath)
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stdout + rejected.stderr, /same phase.*T1.*F1/)
    assert.equal(f.state(), beforeState)
    assert.equal(f.events(), beforeEvents)
  }
  const child = { ...task('T1a', ['T1']), summary: 'Complemento da tarefa original.', phase: 'F1' }
  f.write([...original, child], phases)
  const accepted = f.run('sync-plan', '--plan', f.planPath)
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)
  assert.equal(JSON.parse(f.state()).tasks.T1a.phase, 'F1')
  const beforeState = f.state(), beforeEvents = f.events()
  f.write([...original, { ...child, phase: 'F2' }], [...phases, { id: 'F2', title: 'Outra' }])
  const moved = f.run('sync-plan', '--plan', f.planPath)
  assert.notEqual(moved.status, 0)
  assert.equal(f.state(), beforeState)
  assert.equal(f.events(), beforeEvents)
  const translated = f.run('sync-plan', '--plan', f.planPath, '--lang', 'pt-BR')
  assert.notEqual(translated.status, 0)
  assert.match(translated.stdout + translated.stderr, /mesma fase.*T1.*F1/)
  assert.equal(f.state(), beforeState)
  assert.equal(f.events(), beforeEvents)
})

test('init rejeita numeração inválida antes de criar estado e eventos', t => {
  const f = fixture(t)
  f.write([task('T1'), task('T3')])
  const rejected = f.run('init', '--plan', f.planPath, '--run', 'identifiers')
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stdout + rejected.stderr, /sequential|T2/)
  assert.equal(existsSync(join(f.runDir, 'state.json')), false)
  assert.equal(existsSync(join(f.runDir, 'events.ndjson')), false)
  f.write([task('T1'), task('T2', ['T1'])])
  const accepted = f.run('init', '--plan', f.planPath, '--run', 'identifiers')
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)
  assert.deepEqual(Object.keys(JSON.parse(f.state()).tasks), ['T1', 'T2'])
})

test('sync rejeita lacuna, base ausente e ciclo sem alterar estado ou eventos', t => {
  const f = fixture(t)
  const original = [task('T1'), task('T2', ['T1'])]
  f.write(original)
  const initialized = f.run('init', '--plan', f.planPath, '--run', 'identifiers')
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr)
  const beforeState = f.state()
  const beforeEvents = f.events()
  const rejectedPlans = [
    [...original, task('T3')],
    [...original, task('T3a', ['T2'])],
    [...original, task('T1b', ['T1'])],
    [task('T1', ['T1a']), task('T2', ['T1']), task('T1a', ['T1'])],
  ]
  for (const tasks of rejectedPlans) {
    f.write(tasks)
    const rejected = f.run('sync-plan', '--plan', f.planPath)
    assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr)
    assert.equal(f.state(), beforeState)
    assert.equal(f.events(), beforeEvents)
  }
})

test('sync acrescenta correção filha sem renumerar nem reescrever histórico concluído', t => {
  const f = fixture(t)
  const original = [task('T1'), task('T2', ['T1'])]
  f.write(original)
  const initialized = f.run('init', '--plan', f.planPath, '--run', 'identifiers')
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr)
  const skipped = f.run('skip', 'T1', '--reason', 'Contrato original concluído')
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr)
  const before = JSON.parse(f.state())
  const eventsBefore = f.events()
  f.write([...original, { ...task('T1a', ['T1']), summary: 'Corrigir a entrega original preservando seu histórico e sua dependência.' }])
  const synced = f.run('sync-plan', '--plan', f.planPath)
  assert.equal(synced.status, 0, synced.stdout + synced.stderr)
  const after = JSON.parse(f.state())
  assert.deepEqual(after.tasks.T1, before.tasks.T1)
  assert.deepEqual(Object.keys(after.tasks).sort(), ['T1', 'T1a', 'T2'])
  assert.deepEqual(after.tasks.T1a.deps, ['T1'])
  assert.ok(f.events().startsWith(eventsBefore))
  const last = JSON.parse(f.events().trim().split('\n').at(-1))
  assert.equal(last.type, 'plan_sync')
  assert.deepEqual(last.added, ['T1a'])
})

test('sync não aceita vínculo que desaparece ao preservar contrato concluído', t => {
  const f = fixture(t)
  f.write([task('T1')])
  const initialized = f.run('init', '--plan', f.planPath, '--run', 'identifiers')
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr)
  const skipped = f.run('skip', 'T1', '--reason', 'Contrato original concluído')
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr)
  const beforeState = f.state()
  const beforeEvents = f.events()
  f.write([task('T1', ['T1a']), task('T1a')])
  const rejected = f.run('sync-plan', '--plan', f.planPath)
  assert.notEqual(rejected.status, 0, 'a única dependência será descartada ao preservar T1')
  assert.equal(f.state(), beforeState)
  assert.equal(f.events(), beforeEvents)
})
