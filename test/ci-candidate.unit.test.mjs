import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareCandidate } from '../.github/scripts/prepare-ci-candidate.mjs'
import { sharedCandidate } from '../.github/scripts/ci-candidate.mjs'
import { runCiPublished } from '../.github/scripts/run-ci-published.mjs'

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'prumo ci & candidato-')))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@example/prumo', version: '3.0.0' }))
  for (const directory of ['lib', 'scripts', 'test']) mkdirSync(join(root, directory))
  writeFileSync(join(root, 'lib/source.mjs'), 'export const preserved = true\n')
  const archive = join(root, '.test-output/ci-candidate/example-prumo-3.0.0.tgz')
  let packed = 0
  const manifest = prepareCandidate({ root, env: { GITHUB_SHA: 'revision', GITHUB_OUTPUT: join(root, 'outputs') },
    run(executable, args, options) {
      packed++
      assert.equal(options.cwd, root)
      assert.ok(args.includes('--ignore-scripts'))
      assert.equal(args.at(-1), '.test-output/ci-candidate')
      writeFileSync(archive, 'pacote imutável')
      return { status: 0, stdout: JSON.stringify([{ filename: 'example-prumo-3.0.0.tgz' }]) }
    } })
  return { root, archive, packed, manifest, env: { GITHUB_SHA: 'revision', PRUMO_CI_CANDIDATE_MANIFEST: '.test-output/ci-candidate/manifest.json', PRUMO_CI_CANDIDATE_SHA256: manifest.sha256 } }
}

test('um candidato verificado serve vários consumidores sem reempacotar ou apagar o arquivo', t => {
  const f = fixture(t)
  assert.equal(f.packed, 1)
  assert.equal(sharedCandidate(f.root, f.env), f.archive)
  assert.equal(sharedCandidate(f.root, f.env), f.archive)
  assert.match(readFileSync(join(f.root, 'outputs'), 'utf8'), new RegExp(`sha256=${f.manifest.sha256}`))
  assert.equal(sharedCandidate(f.root, {}), undefined)
  const calls = []
  assert.equal(runCiPublished({ root: f.root, env: f.env, run(executable, args) { calls.push(args); return { status: 7 } } }), 7)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('--reporter=json') && calls[0].includes('--reporter=json-summary'))
  assert.equal(calls[0].at(-1), 'test/upgrade-from-previous.test.mjs')
  assert.equal(readFileSync(f.archive, 'utf8'), 'pacote imutável')
})

test('digest, versão, revisão, nome ou manifesto inválidos recusam o candidato antes de executar testes', t => {
  const f = fixture(t), file = join(f.root, f.env.PRUMO_CI_CANDIDATE_MANIFEST)
  for (const change of [{ version: '2.0.0' }, { revision: 'obsolete' }, { archive: '../outside.tgz' }, { sha256: '0'.repeat(64) }]) {
    writeFileSync(file, JSON.stringify({ ...f.manifest, ...change }))
    assert.throws(() => runCiPublished({ root: f.root, env: f.env, run() { assert.fail('Candidato recusado não deve executar testes') } }))
  }
  writeFileSync(file, JSON.stringify(f.manifest))
  for (const env of [{}, { PRUMO_CI_CANDIDATE_MANIFEST: file }, { ...f.env, PRUMO_CI_CANDIDATE_SHA256: 'bad' }, { ...f.env, PRUMO_CI_CANDIDATE_MANIFEST: 'missing.json' }])
    assert.throws(() => runCiPublished({ root: f.root, env }))
  writeFileSync(f.archive, 'outro pacote')
  assert.throws(() => sharedCandidate(f.root, f.env), /digest/)
})

test('links no candidato são recusados na preparação e no consumo', t => {
  const f = fixture(t), other = join(f.root, 'other.tgz')
  writeFileSync(other, readFileSync(f.archive)); rmSync(f.archive)
  try { symlinkSync(other, f.archive) } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('A criação de link de arquivo exige privilégio neste Windows'); return }
    throw error
  }
  assert.throws(() => sharedCandidate(f.root, f.env), /arquivo regular/)
  assert.throws(() => prepareCandidate({ root: f.root, run() { assert.fail('Arquivo ligado não deve ser sobrescrito') } }), /arquivos regulares/)
})

test('falhas de empacotamento não publicam um candidato aprovado', t => {
  const f = fixture(t)
  for (const run of [() => ({ status: 1, stderr: 'recusado' }), () => ({ error: new Error('interrompido') }), () => ({ status: 0, stdout: '[{"filename":"../wrong.tgz"}]' })])
    assert.throws(() => prepareCandidate({ root: f.root, env: {}, run }))
})

test('diretório de saída ligado é recusado antes de criar arquivos no destino externo', t => {
  const f = fixture(t), outside = join(f.root, 'outside'), output = join(f.root, '.test-output')
  mkdirSync(outside)
  renameSync(output, join(f.root, 'saved-output'))
  symlinkSync(outside, output, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => prepareCandidate({ root: f.root, run() { assert.fail('Não deve empacotar através de um link') } }), /diretórios ligados/)
  assert.deepEqual(readdirSync(outside), [])
})

test('empacotamento real preserva caminhos com espaços e metacaracteres sem executar comandos extras', t => {
  const f = fixture(t)
  const env = { ...process.env, HOME: f.root, USERPROFILE: f.root, npm_config_cache: join(f.root, 'cache'), npm_config_userconfig: join(f.root, 'npmrc'), GITHUB_SHA: 'revision' }
  delete env.GITHUB_OUTPUT
  const manifest = prepareCandidate({ root: f.root, env })
  assert.equal(sharedCandidate(f.root, { ...env, PRUMO_CI_CANDIDATE_MANIFEST: f.env.PRUMO_CI_CANDIDATE_MANIFEST, PRUMO_CI_CANDIDATE_SHA256: manifest.sha256 }), f.archive)
})

test('os fluxos públicos recusam candidato adulterado antes de instalar ou consultar o registro', t => {
  const f = fixture(t)
  writeFileSync(f.archive, 'adulterado')
  const repo = fileURLToPath(new URL('..', import.meta.url))
  for (const script of ['scripts/package-smoke.mjs', 'scripts/published-update-smoke.mjs']) {
    // O pacote vigente é lido do checkout, para exercitar o mesmo vínculo utilizado pelo CI.
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    const currentArchive = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`
    const path = join(f.root, currentArchive)
    writeFileSync(path, 'adulterado')
    writeFileSync(join(f.root, 'current.json'), JSON.stringify({ ...f.manifest, version: pkg.version, archive: currentArchive }))
    const result = spawnSync(process.execPath, [join(repo, script)], { cwd: repo, env: { ...process.env, ...f.env, PRUMO_CI_CANDIDATE_MANIFEST: join(f.root, 'current.json') }, encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /digest/)
  }
})
