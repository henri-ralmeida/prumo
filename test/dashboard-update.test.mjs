import test from 'node:test'
import assert from 'node:assert/strict'
import { dashboardUpdate } from '../scripts/dashboard-update.mjs'

test('aviso compara versões estáveis por número e não sugere downgrade', async () => {
  for (const [current, latest, available] of [
    ['2.4.7', '2.4.8', true], ['2.4.7', '2.5.0', true], ['2.4.7', '3.0.0', true],
    ['2.9.0', '2.10.0', true], ['2.4.7', '2.4.7', false], ['3.0.0', '2.9.9', false],
    ['2.5.0', '2.4.9', false], ['2.4.8', '2.4.7', false],
  ]) {
    const result = await dashboardUpdate(current, { fetch: async (url, options) => {
      assert.equal(url, 'https://registry.npmjs.org/@henri-ralmeida%2fprumo/latest')
      assert.equal(options.headers.accept, 'application/json')
      assert.ok(options.signal instanceof AbortSignal)
      return { ok: true, json: async () => ({ version: latest }) }
    } })
    assert.deepEqual(result, available ? { available, current, latest } : { available })
  }
})

test('rede indisponível e metadados inválidos não interrompem o dashboard', async () => {
  for (const version of [undefined, null, 247, {}, '', 'v2.4.8', '02.4.8', '2.4.8-beta.1', '999999999999999999999.0.0']) {
    let calls = 0
    assert.deepEqual(await dashboardUpdate(version, { fetch: async () => { calls++; throw new Error('consulta inesperada') } }), { available: false })
    assert.equal(calls, 0)
    assert.deepEqual(await dashboardUpdate('2.4.7', { fetch: async () => ({ ok: true, json: async () => ({ version }) }) }), { available: false })
  }
  for (const request of [
    async () => { throw new Error('offline') },
    async () => { throw new DOMException('timeout', 'TimeoutError') },
    async () => ({ ok: false, json: async () => { throw new Error('não deve ler erro HTTP') } }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('JSON inválido') } }),
    async () => ({ ok: true, json: async () => null }),
  ]) assert.deepEqual(await dashboardUpdate('2.4.7', { fetch: request }), { available: false })
})
