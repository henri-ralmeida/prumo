import { setTimeout } from 'node:timers/promises'

// A verificação de versões publicadas tolera falhas temporárias de rede, sem ocultar pacotes ausentes ou inválidos.
export async function downloadPublishedFile(url, { fetchImpl = fetch, wait = setTimeout } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let status
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) })
      status = response.status
      if (status !== 200) throw new Error(`Download ${url}: HTTP ${status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      const transient = status === 429 || status >= 500 ||
        ['AbortError', 'TimeoutError'].includes(error.name) ||
        /^(UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)$/.test(error.cause?.code ?? error.code ?? '')
      if (!transient || attempt === 3) throw error
      await wait(attempt * 1000)
    }
  }
}
