import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { fixture, check } from './fixtures/approved-graph.mjs'
import { unresolvedValidationCommand } from '../scripts/validation.mjs'

const mismatch = /belong to different Git repositories/
const prose = /validation step (\d+) looks like inspection prose/g
const unresolved = /validation step (\d+) starts with "([^"]*)"/g

function secondRepository(f, name = 'other') {
  const directory = join(f.home, name)
  mkdirSync(directory)
  const git = (...args) => { const r = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stdout + r.stderr) }
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(directory, 'README.md'), 'outro repositorio\n'); git('add', '.'); git('commit', '-m', 'Base')
  return realpathSync.native(directory)
}

// Executa init e sync-plan sobre o mesmo plano para provar que os dois caminhos avisam igualmente.
function planOutputs(f) {
  const sync = f.ok('sync-plan', '--plan', f.source, '--dry-run')
  const init = f.ok('init', '--plan', f.source, '--cwd', f.project, '--force')
  return { sync, init }
}

for (const lang of ['en', 'pt-BR']) for (const touches of [false, true]) test(`init e sync-plan avisam validacao em outro repositorio Git sem project (${lang}, touches ${touches})`, t => {
  const f = fixture(t, { git: true, lang })
  const other = secondRepository(f)
  f.plan.tasks[0].validation = [{ ...check, cwd: other }]
  if (touches) Object.assign(f.plan.tasks[0], { writeScope: 'files', touches: ['README.md'] })
  f.writePlan()
  const expected = lang === 'en' ? mismatch : /repositórios Git diferentes/
  const { sync, init } = planOutputs(f)
  for (const output of [sync, init]) {
    assert.match(output, expected)
    assert.match(output, lang === 'en' ? /approve task\.project before execution/ : /aprove task\.project antes da execução/)
  }
  assert.equal(f.state().plan.name, 'Entrega verificavel')
})

test('aviso de projeto divergente nao recusa e some com project coerente, cwd no mesmo repositorio ou fora de Git', t => {
  const f = fixture(t, { git: true })
  const other = secondRepository(f)
  const outside = join(f.home, 'sem-git'); mkdirSync(outside)
  mkdirSync(join(f.project, 'pacote'))
  for (const [label, task] of [
    ['project coerente', { project: other, validation: [{ ...check, cwd: other }] }],
    ['cwd no mesmo repositorio', { validation: [{ ...check, cwd: join(f.project, 'pacote') }] }],
    ['cwd fora de Git', { validation: [{ ...check, cwd: outside }] }],
    ['sem cwd', { validation: [check] }],
  ]) {
    f.plan.tasks[0] = { ...f.plan.tasks[0], project: undefined, ...task }; f.writePlan()
    const { sync, init } = planOutputs(f)
    assert.doesNotMatch(sync, mismatch, label); assert.doesNotMatch(init, mismatch, label)
  }
  // O aviso e informativo: o mesmo plano divergente continua sendo aceito pelos dois comandos.
  f.plan.tasks[0] = { ...f.plan.tasks[0], project: undefined, validation: [{ ...check, cwd: other }] }; f.writePlan()
  const { sync, init } = planOutputs(f)
  assert.match(sync, mismatch); assert.match(init, mismatch)
})

function commandFixture(t, lang = 'en', tasks) {
  const f = fixture(t, { git: true, lang, tasks })
  const stubs = mkdtempSync(join(tmpdir(), 'prumo-command-stubs-'))
  t.after(() => rmSync(stubs, { recursive: true, force: true }))
  const windows = process.platform === 'win32'
  for (const name of ['node', 'npm', 'ferramenta-local']) {
    const file = join(stubs, windows ? name + '.cmd' : name)
    writeFileSync(file, windows ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n'); chmodSync(file, 0o755)
  }
  mkdirSync(join(f.project, 'scripts')); mkdirSync(join(f.project, 'pasta com espaco'))
  writeFileSync(join(f.project, 'scripts', 'x.sh'), 'exit 0\n')
  writeFileSync(join(f.project, 'pasta com espaco', 'verificar.sh'), 'exit 0\n')
  // O PATH controlado garante que os executaveis usados existem e que os textos de prosa nunca existem.
  const env = { ...process.env, PRUMO_ROOT: f.root, PRUMO_HOME: f.home, PRUMO_LANG: lang }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.PATH = stubs + delimiter + (process.env.PATH ?? process.env.Path ?? '')
  const runIn = (cwd, ...args) => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '../scripts/engine.mjs'), ...args, '--run', 'audit'], { cwd, env, encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout
  }
  const run = (...args) => runIn(f.project, ...args)
  const warned = (output, pattern) => [...output.matchAll(pattern)].map(match => Number(match[1]))
  return { f, run, runIn, warned }
}

const proseTexts = ['Verificar se o arquivo existe', 'Validar que a API responde', 'Garantir que o relatorio abre', 'Confirm the endpoint answers',
  'Ensure tests pass', 'Conferir manualmente o layout']

for (const lang of ['en', 'pt-BR']) test(`sync-plan e init avisam passos cuja primeira palavra nao e executavel e nao avisam comandos validos (${lang})`, t => {
  const { f, run, warned } = commandFixture(t, lang)
  const valid = ['node --test', 'npm test', './scripts/x.sh', 'echo ok', '"./pasta com espaco/verificar.sh"', 'ferramenta-local --versao']
  if (process.platform !== 'win32') valid.push('NODE_ENV=test FERRAMENTA="a b" node --test')
  f.plan.tasks[0].validation = [...proseTexts, ...valid].map(text => ({ ...check, run: text }))
  f.writePlan()
  const before = f.state(), events = f.events()
  const sync = run('sync-plan', '--plan', f.source, '--dry-run')
  assert.deepEqual(f.state(), before); assert.equal(f.events(), events)
  const init = run('init', '--plan', f.source, '--cwd', f.project, '--force')
  const expected = proseTexts.map((_, index) => index + 1)
  for (const output of [sync, init]) {
    // Nenhum desses textos casa o reconhecimento de prosa por verbo e artigo; todos falham na resolucao do comando.
    assert.deepEqual(warned(output, prose), [])
    assert.deepEqual(warned(output, lang === 'en' ? unresolved : /passo (\d+) da validação da tarefa \S+ começa com "/g), expected)
    assert.match(output, lang === 'en' ? /which is not an executable on PATH, a shell builtin or an existing path/ : /que não é um executável no PATH, um comando interno do shell nem um caminho existente/)
  }
})

test('o aviso de comando nao recusa nem altera contratos concluidos ou de inspecao', t => {
  const { f, run, warned } = commandFixture(t, 'en', [{ id: 'T1' }, { id: 'T2' }])
  f.ok('skip', 'T1', '--reason', 'Entrega dispensada pelo usuario')
  const original = f.state().tasks.T1
  f.plan.tasks[0].validation = [{ ...check, run: 'Confirm the endpoint answers' }]
  f.plan.tasks[1] = { ...f.plan.tasks[1], validationMode: 'inspection', inspectionReason: 'A entrega altera somente uma explicacao documental.', validation: 'Conferir manualmente o layout' }
  f.writePlan()
  const output = run('sync-plan', '--plan', f.source)
  assert.deepEqual(warned(output, unresolved), [])
  assert.deepEqual(f.state().tasks.T1, original)
})

test('a resolucao do comando respeita o cwd do passo e o shell de cada plataforma', t => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'prumo-command-unit-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const bin = join(directory, 'bin')
  mkdirSync(bin); mkdirSync(join(directory, 'pacote'))
  for (const name of ['ferramenta.CMD', 'sem-extensao', 'padrao.EXE']) writeFileSync(join(bin, name), '')
  writeFileSync(join(directory, 'pacote', 'run.sh'), '')
  const posix = { platform: 'linux', env: { PATH: bin + delimiter } }
  const windows = { platform: 'win32', env: { PATH: bin + delimiter, PATHEXT: '.EXE;.CMD' } }
  const unresolvedIn = (run, options, cwd = directory) => unresolvedValidationCommand(run, cwd, options)
  // PATH: nome exato no POSIX, extensoes de PATHEXT no cmd.exe e extensoes padrao quando PATHEXT nao existe.
  assert.equal(unresolvedIn('sem-extensao --x', posix), null)
  assert.equal(unresolvedIn('ferramenta --x', posix), 'ferramenta')
  assert.equal(unresolvedIn('ferramenta --x', windows), null)
  assert.equal(unresolvedIn('sem-extensao', windows), null)
  assert.equal(unresolvedIn('padrao', { platform: 'win32', env: { PATH: bin } }), null)
  assert.equal(unresolvedIn('padrao', { platform: 'win32', env: { PATH: bin, PATHEXT: '' } }), 'padrao')
  assert.equal(unresolvedIn('x', { platform: 'linux', env: {} }), 'x')
  // Builtins: o shell de cada plataforma, sem diferenciar maiusculas no cmd.exe e sem o arroba de eco.
  for (const run of ['echo ok', 'cd pacote', 'test -f x', '[ -f x ]', 'exit 0', 'if true; then :; fi', '! false', 'for x in a; do :; done']) assert.equal(unresolvedIn(run, posix), null, run)
  for (const run of ['ECHO ok', '@echo off', 'set A=1', 'call x.bat', 'if exist x echo y', 'for %i in (a) do echo %i', 'dir']) assert.equal(unresolvedIn(run, windows), null, run)
  for (const [run, word] of [['call x', 'call'], ['Echo ok', 'Echo'], ['FOR x', 'FOR']]) assert.equal(unresolvedIn(run, posix), word)
  // Caminhos: relativos ao cwd do passo, absolutos, ausentes e entre aspas.
  assert.equal(unresolvedIn('./run.sh', posix, join(directory, 'pacote')), null)
  assert.equal(unresolvedIn('./run.sh', posix), './run.sh')
  assert.equal(unresolvedIn('"' + join(directory, 'pacote', 'run.sh') + '" -x', posix), null)
  assert.equal(unresolvedIn("'./pacote/run.sh'", posix), null)
  assert.equal(unresolvedIn('pacote/ausente.sh', posix), 'pacote/ausente.sh')
  // Variaveis de ambiente prefixadas existem apenas no shell POSIX.
  assert.equal(unresolvedIn('A=1 B="x y" sem-extensao', posix), null)
  assert.equal(unresolvedIn('A=1 ausente', posix), 'ausente')
  assert.equal(unresolvedIn('A=1', posix), null)
  assert.equal(unresolvedIn('A=1 sem-extensao', windows), 'A=1')
  // Expansoes, subshells, operadores e comandos vazios nao sao analisados.
  for (const run of ['$HOME/bin/x', '%TOOL% --x', '(cd pacote && ausente)', '`x`', '', '   ', '"" x', '<entrada', 'ausente*']) assert.equal(unresolvedIn(run, posix), null, run)
  assert.equal(unresolvedIn('"sem extensao" x', posix), 'sem extensao')
})

test('sem projeto conhecido, o caminho relativo e o cwd do passo partem do diretorio do processo', t => {
  const { f, runIn, warned } = commandFixture(t)
  mkdirSync(join(f.home, 'pacote')); writeFileSync(join(f.home, 'pacote', 'run.sh'), 'exit 0\n')
  f.plan.tasks[0].validation = [{ ...check, run: './run.sh', cwd: 'pacote' }, { ...check, run: './ausente.sh' }]; f.writePlan()
  // Dentro do armazenamento central o projeto e desconhecido; so o caminho existente deixa de avisar.
  const output = runIn(f.home, 'init', '--plan', f.source, '--force')
  assert.deepEqual(warned(output, unresolved), [2])
})
