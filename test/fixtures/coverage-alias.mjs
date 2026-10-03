import { existsSync, readFileSync } from 'node:fs'
import module from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// A instalacao isolada conserva import.meta.url e seus arquivos de dados.
// Somente copias identicas dos fontes atuais compartilham seus contadores;
// versoes antigas ou adulteradas permanecem separadas.
if (process.env.NODE_V8_COVERAGE && process.env.PRUMO_TEST_COVERAGE_FLUSH === '1') {
  if (typeof module.registerHooks !== 'function') throw new Error('A coleta de cobertura exige Node 22.15 ou superior')
  const root = resolve(process.env.PRUMO_TEST_COVERAGE_SOURCE_ROOT ?? fileURLToPath(new URL('../..', import.meta.url)))
  module.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      if (result.format !== 'module' || !url.startsWith('file:')) return result
      const file = fileURLToPath(url).replaceAll('\\', '/')
      const relative = file.match(/\/(bin|lib|scripts|tools)\/(.+\.mjs)$/)?.slice(1).join('/')
      if (!relative) return result
      const original = join(root, relative)
      if (!existsSync(original)) return result
      const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
      if (readFileSync(original, 'utf8') !== source) return result
      // O V8 exige o mesmo comprimento para combinar o módulo original com suas cópias.
      // A anotação idêntica em ambos conserva os offsets e não muda import.meta.url.
      return { ...result, source: `${source}\n//# sourceURL=${pathToFileURL(original).href}\n` }
    },
  })
}
