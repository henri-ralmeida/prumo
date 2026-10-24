import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import coverage from 'istanbul-lib-coverage'

// Usa os mesmos reporters fornecidos pelo c8; a consolidação mantém os gates antes de gerar a apresentação.
const require = createRequire(import.meta.url)
const c8Require = createRequire(require.resolve('c8/package.json'))
export function coverageHtml(root = process.cwd()) {
  const directory = join(root, '.test-output/coverage-merged')
  const data = JSON.parse(readFileSync(join(directory, 'coverage-final.json'), 'utf8'))
  const context = c8Require('istanbul-lib-report').createContext({ dir: directory, coverageMap: coverage.createCoverageMap(data) })
  c8Require('istanbul-reports').create('html').execute(context)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) coverageHtml()
