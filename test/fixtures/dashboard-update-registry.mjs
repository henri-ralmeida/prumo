const original = globalThis.fetch
globalThis.fetch = async (url, options) => {
  if (url === 'https://registry.npmjs.org/@henri-ralmeida%2fprumo/latest') {
    if (process.env.PRUMO_TEST_UPDATE_RESULT === 'offline') throw new Error('npm indisponível no cenário isolado')
    return { ok: true, json: async () => ({ version: process.env.PRUMO_TEST_UPDATE_RESULT }) }
  }
  return original(url, options)
}
