import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverageBatches } from '../../tools/run-coverage.mjs'
import { downloadPublishedFile } from '../../test/fixtures/published-download.mjs'

const platforms = ['ubuntu-latest', 'windows-latest', 'macos-latest']
const nodes = [22, 24]
const timings = JSON.parse(readFileSync(new URL('../ci-timings.json', import.meta.url), 'utf8'))

function balance(items, count, weight) {
  const groups = Array.from({ length: Math.min(items.length, count) }, () => ({ items: [], seconds: 0 }))
  for (const item of [...items].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, 'en'))) {
    const group = groups.reduce((best, next) => next.seconds < best.seconds ? next : best)
    group.items.push(item)
    group.seconds += weight(item)
  }
  return groups
}

function matrix(combinations, key, prefix) {
  const include = []
  for (let index = 0; index < Math.max(...combinations.map(item => item.groups.length)); index++)
    for (const { os, node, groups } of combinations) if (groups[index])
      include.push({ os, node, label: `${prefix}-${index + 1}-of-${groups.length}`, [key]: groups[index].items,
        estimatedSeconds: Math.ceil(groups[index].seconds) })
  return { include }
}

// O plano explícito mantém cada teste e versão uma vez por sistema e versão do Node.
export function planCi({ root, versions }) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('A raiz do projeto deve ser um caminho não vazio')
  const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  if (!Array.isArray(versions) || !versions.length || versions.some(version => typeof version !== 'string' || version !== version.trim() || !versionPattern.test(version)) || new Set(versions).size !== versions.length)
    throw new Error('As versões publicadas devem formar uma lista não vazia, válida e sem duplicações')

  // O orçamento amortiza a preparação; pesos medidos estimam duração sem limitar artefatos ou omitir casos novos.
  const inventory = coverageBatches(resolve(root), 1, false, 'regular').flatMap(batch => batch.files)
  const baseline = Object.values(timings.fileSeconds).reduce((sum, seconds) => sum + seconds, 0)
  const combinations = platforms.flatMap(os => nodes.map(node => ({ os, node, measured: timings.combinations[`${os}:${node}`] })))
  const groups = (items, weight, budget) => balance(items, Math.max(1, Math.min(42, Math.ceil(items.reduce((sum, item) => sum + weight(item), 0) / budget))), weight)
  const regular = combinations.map(({ os, node, measured }) => {
    const weight = file => (timings.fileSeconds[file] ?? 10) * measured.regularSeconds / baseline
    return { os, node, groups: groups(inventory, weight, timings.targetSeconds) }
  })
  const published = combinations.map(({ os, node, measured }) => {
    const workers = os === 'windows-latest' ? 1 : 2
    const weight = version => (measured.versionSeconds[version] ?? measured.publishedSeconds) / workers
    return { os, node, groups: groups(versions, weight, timings.targetSeconds) }
  })
  return { regular: matrix(regular, 'files', 'regular'), published: matrix(published, 'versions', 'published') }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata = JSON.parse((await downloadPublishedFile('https://registry.npmjs.org/@henri-ralmeida%2fprumo')).toString('utf8'))
  if (!metadata.versions || typeof metadata.versions !== 'object' || Array.isArray(metadata.versions))
    throw new Error('O catálogo npm não contém um objeto de versões publicadas')
  const root = process.cwd(), plan = planCi({ root, versions: Object.keys(metadata.versions) })
  mkdirSync(resolve(root, '.test-output'), { recursive: true })
  writeFileSync(resolve(root, '.test-output/ci-plan.json'), JSON.stringify(plan, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) for (const key of ['regular', 'published'])
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${JSON.stringify(plan[key])}\n`)
  console.log(`Plano de CI: ${plan.regular.include.length} grupos regulares e ${plan.published.include.length} grupos de versões publicadas.`)
}
