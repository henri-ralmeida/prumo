import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { updateRequest, npmLatestVersion, installationsCurrent, reconcileDashboardUpdate } from '../lib/update.mjs'

const request = () => ({ dryRun: true, cwd: resolve('.'), projects: [] })
const invalid = [null, '', false, 0, [], {}]
for (const field of ['dryRun', 'cwd', 'projects', 'updateCli', 'pendingUpdate', 'sourceVersion', 'globalVersion']) {
  for (const value of invalid.filter(value => !(
    ['dryRun', 'updateCli', 'pendingUpdate'].includes(field) && value === false ||
    field === 'projects' && Array.isArray(value) || field === 'globalVersion' && value === null
  ))) test(`update rejeita ${field}=${JSON.stringify(value)} antes de executar`, () => {
    assert.throws(() => updateRequest(JSON.stringify({ ...request(), [field]: value })), /Invalid Prumo update request/)
  })
}
for (const field of ['cwd', 'projects']) test(`update rejeita NUL em ${field} antes de atualizar a CLI`, () => {
  const path = resolve('projeto') + '\0oculto'
  assert.throws(() => updateRequest(JSON.stringify({ ...request(), [field]: field === 'cwd' ? path : [path] })), /Invalid Prumo update request/)
})
for (const field of ['sourceVersion', 'globalVersion']) for (const value of [['2.4.0'], [['2.4.0']]]) test(`update recusa versão array em ${field}: ${JSON.stringify(value)}`, () => {
  assert.throws(() => updateRequest(JSON.stringify({ ...request(), [field]: value })), /Invalid Prumo update request/)
})
test('npm normaliza lista plana de versões e rejeita versão selecionada como array aninhado', () => {
  const run = value => () => ({ status: 0, stdout: JSON.stringify(value) })
  assert.equal(npmLatestVersion({ run: run(['1.0', '2.4.0']) }), '2.4.0')
  for (const value of [[['2.4.0']], [['2.3.0'], ['2.4.0']]])
    assert.throws(() => npmLatestVersion({ run: run(value) }), /npm returned an invalid Prumo version/)
})
for (const value of [null, {}, [], [null], '', 'next', '1.2', '1.2.3-beta']) test(`registro npm inválido ${JSON.stringify(value)} não seleciona versão`, () => {
  assert.throws(() => npmLatestVersion({ run: () => ({ status: 0, stdout: JSON.stringify(value) }) }))
})
for (const result of [{ status: 1, stderr: 'Indisponível' }, { status: null, error: new Error('Interrompido') }]) {
  test(`falha do registro npm (${result.status}) interrompe atualização`, () => {
    assert.throws(() => npmLatestVersion({ run: () => result }), /Indisponível|Interrompido/)
  })
}
for (const marker of ['{', 'null', '{}', '{"version":"1.0.0"}']) test(`marcador ${marker} não prova instalação atual`, () => {
  assert.equal(installationsCurrent([{ roots: [resolve('isolado')] }], '2.0.0', {
    read: () => marker, filesCurrent: () => true,
  }), false)
})
test('versão igual com conteúdo divergente exige atualização', () => {
  assert.equal(installationsCurrent([{ roots: [resolve('isolado')] }], '2.0.0', {
    read: () => '{"version":"2.0.0"}', filesCurrent: () => false,
  }), false)
})
for (const disabled of [false, true]) for (const enabled of [false, true]) {
  for (const process of ['running', 'stopped']) for (const dryRun of [false, true]) {
    test(`dashboard respeita preferência: disabled=${disabled}, enabled=${enabled}, process=${process}, prévia=${dryRun}`, async () => {
      const before = { disabled, enabled, process }, calls = []
      const options = { home: resolve('isolado') }
      const result = await reconcileDashboardUpdate({ before, dryRun, dashboardOptions: options, lang: 'pt-BR' }, {
        status: () => { throw new Error('Estado já fornecido') },
        enable: async received => { calls.push(['enable', received]); return { ok: true } },
        restart: async received => { calls.push(['restart', received]); return { ok: true } },
      })
      const action = disabled ? 'disabled' : enabled ? 'restart' : process === 'running' ? 'enable' : 'none'
      assert.equal(result.action, action)
      assert.equal(result.ok, true)
      assert.deepEqual(calls, !dryRun && ['enable', 'restart'].includes(action) ? [[action, { ...options, lang: 'pt-BR' }]] : [])
      assert.deepEqual(options, { home: resolve('isolado') })
    })
  }
}
