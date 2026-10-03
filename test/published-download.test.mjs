import test from 'node:test'
import assert from 'node:assert/strict'
import { downloadPublishedFile } from './fixtures/published-download.mjs'

const response = (status = 200) => ({ status, arrayBuffer: async () => Buffer.from('pacote-publicado') })
const networkError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })

test('download recupera uma conexão temporariamente indisponível e conserva os bytes', async () => {
  let calls = 0
  const delays = []
  const bytes = await downloadPublishedFile('https://registry.npmjs.org/pacote.tgz', {
    fetchImpl: async (_url, options) => { assert.ok(options.signal); if (++calls === 1) throw networkError(); return response() },
    wait: async delay => { delays.push(delay) },
  })
  assert.equal(bytes.toString(), 'pacote-publicado')
  assert.equal(calls, 2)
  assert.deepEqual(delays, [1000])
})

test('download limita tentativas e mantém o erro de rede quando a conexão não se recupera', async () => {
  let calls = 0
  const error = networkError(), delays = []
  await assert.rejects(downloadPublishedFile('https://registry.npmjs.org/pacote.tgz', {
    fetchImpl: async () => { calls++; throw error }, wait: async delay => { delays.push(delay) },
  }), value => value === error)
  assert.equal(calls, 3)
  assert.deepEqual(delays, [1000, 2000])
})

test('download repete apenas respostas HTTP temporárias e não transforma arquivo ausente em sucesso', async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0
    await downloadPublishedFile('https://registry.npmjs.org/pacote.tgz', {
      fetchImpl: async () => response(++calls === 1 ? status : 200), wait: async () => {},
    })
    assert.equal(calls, 2)
  }
  let calls = 0
  await assert.rejects(downloadPublishedFile('https://registry.npmjs.org/pacote.tgz', {
    fetchImpl: async () => { calls++; return response(404) }, wait: async () => assert.fail('404 não deve ser repetido'),
  }), /HTTP 404/)
  assert.equal(calls, 1)
})

test('download repete falha de transporte durante o corpo, mas propaga erros de programação', async () => {
  let calls = 0
  await downloadPublishedFile('https://registry.npmjs.org/pacote.tgz', {
    fetchImpl: async () => ++calls === 1 ? { status: 200, arrayBuffer: async () => { throw networkError() } } : response(), wait: async () => {},
  })
  assert.equal(calls, 2)
  await assert.rejects(downloadPublishedFile('https://registry.npmjs.org/pacote.tgz', {
    fetchImpl: async () => { throw new TypeError('erro de programação') }, wait: async () => assert.fail('erro permanente não deve ser repetido'),
  }), /erro de programação/)
})
