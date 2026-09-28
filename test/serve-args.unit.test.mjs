import test from 'node:test'
import assert from 'node:assert/strict'
import { parseServeArgs } from '../scripts/serve-args.mjs'

test('dashboard usa porta padrão e permite porta dinâmica para ambientes isolados', () => {
  assert.deepEqual(parseServeArgs([]), { port: 4949, run: null, syncPlan: false, global: false })
  assert.equal(parseServeArgs(['--port', '0']).port, 0)
  assert.equal(parseServeArgs(['--port', '65535']).port, 65535)
})
for (const port of ['', ' ', '-1', '65536', '1.5', 'Infinity', 'NaN', 'abc', '0x50', '1e3']) {
  test(`dashboard rejeita porta inválida ${JSON.stringify(port)} antes de abrir serviço`, () => {
    assert.throws(() => parseServeArgs(['--port', port]), /port/)
  })
}
for (const flag of ['port', 'run', 'lang']) {
  test(`dashboard exige valor de --${flag}`, () => assert.throws(() => parseServeArgs([`--${flag}`]), /requires a value/))
  test(`dashboard não consome outra opção como valor de --${flag}`, () => assert.throws(() => parseServeArgs([`--${flag}`, '--global']), /requires a value/))
  const value = flag === 'port' ? '4949' : flag === 'lang' ? 'en' : 'demo'
  test(`dashboard rejeita repetição de --${flag}`, () => assert.throws(() => parseServeArgs([`--${flag}`, value, `--${flag}`, value]), /Duplicate/))
}
for (const flag of ['global', 'sync-plan']) {
  test(`dashboard aceita --${flag}`, () => assert.equal(parseServeArgs([`--${flag}`])[flag === 'global' ? 'global' : 'syncPlan'], true))
  test(`dashboard rejeita repetição de --${flag}`, () => assert.throws(() => parseServeArgs([`--${flag}`, `--${flag}`]), /Duplicate/))
}
for (const run of ['../fora', '/absoluto', 'a/b', 'a\\b', '.oculto', '', ' ', 'a\0b']) {
  test(`dashboard rejeita execução insegura ${JSON.stringify(run)}`, () => assert.throws(() => parseServeArgs(['--run', run]), /run/))
}
for (const run of ['demo', 'A-1', 'a.b_c']) test(`dashboard preserva execução válida ${run}`, () => assert.equal(parseServeArgs(['--run', run]).run, run))
for (const lang of ['en', 'pt-BR']) test(`dashboard aceita idioma ${lang}`, () => assert.equal(parseServeArgs(['--lang', lang]).lang, lang))
for (const lang of ['', 'pt', 'invalid']) test(`dashboard rejeita idioma ${JSON.stringify(lang)}`, () => assert.throws(() => parseServeArgs(['--lang', lang]), /Language/))
for (const token of ['--dry-run', '--constructor', '--port=80', 'extra']) {
  test(`dashboard rejeita entrada sem efeito ${token}`, () => assert.throws(() => parseServeArgs([token]), /Unknown/))
}
test('dashboard global preserva a restrição de leitura sem sincronização', () => {
  assert.throws(() => parseServeArgs(['--global', '--sync-plan']), /read-only/)
})
