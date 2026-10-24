import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coverageBatches } from '../../tools/run-coverage.mjs'
import { downloadPublishedFile } from '../../test/fixtures/published-download.mjs'

const platforms = ['ubuntu-latest', 'windows-latest', 'macos-latest']
const nodes = [22, 24]

// O plano explícito mantém cada teste e versão uma vez por sistema e versão do Node.
export function planCi({ root, versions }) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('A raiz do projeto deve ser um caminho não vazio')
  const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  if (!Array.isArray(versions) || !versions.length || versions.some(version => typeof version !== 'string' || version !== version.trim() || !versionPattern.test(version)) || new Set(versions).size !== versions.length)
    throw new Error('As versões publicadas devem formar uma lista não vazia, válida e sem duplicações')

  // Conserva o balanceamento existente em quatro lotes e divide cada lote entre dois runners.
  const inventory = coverageBatches(resolve(root), 1, false, 'regular').flatMap(batch => batch.files)
  const originalCount = Math.min(4, inventory.length)
  const regularGroups = Array.from({ length: originalCount }, (_, index) =>
    coverageBatches(resolve(root), 1, false, 'regular', { index, count: originalCount }).flatMap(batch => batch.files))
    .flatMap(files => [files.filter((_, index) => index % 2 === 0), files.filter((_, index) => index % 2 === 1)])
  // Oito é uma meta de paralelismo, não um tamanho mínimo de projeto.
  const targetCount = Math.min(8, inventory.length)
  while (regularGroups.length > targetCount) regularGroups.splice(regularGroups.findIndex(group => group.length === 0), 1)
  // Um arquivo pesado pode ocupar sozinho um lote original; redistribuir evita um runner vazio.
  for (const group of regularGroups.filter(group => group.length === 0)) {
    const donor = regularGroups.reduce((largest, candidate) => candidate.length > largest.length ? candidate : largest)
    group.push(donor.pop())
  }

  // Windows executa versões sequencialmente; POSIX executa duas em paralelo.
  // Acima de 64 versões, o multiplicador cresce sem ultrapassar as 256 entradas do GitHub.
  const baseSize = os => os === 'windows-latest' ? 1 : 2
  let multiplier = 1
  while (platforms.reduce((total, os) => total + nodes.length * Math.ceil(versions.length / (baseSize(os) * multiplier)), 0) > 256) multiplier++
  const publishedGroups = new Map(platforms.map(os => {
    const groups = [], size = baseSize(os) * multiplier
    for (let index = 0; index < versions.length; index += size) groups.push(versions.slice(index, index + size))
    return [os, groups]
  }))
  const published = { include: [] }
  for (let index = 0; index < Math.max(...[...publishedGroups.values()].map(groups => groups.length)); index++) {
    for (const os of platforms) {
      const groups = publishedGroups.get(os)
      if (index < groups.length) for (const node of nodes)
        published.include.push({ os, node, label: `published-${index + 1}-of-${groups.length}`, versions: [...groups[index]] })
    }
  }
  const matrix = (groups, key, prefix) => ({ include: groups.flatMap((items, index) => platforms.flatMap(os =>
    nodes.map(node => ({ os, node, label: `${prefix}-${index + 1}-of-${groups.length}`, [key]: [...items] })))) })
  return { regular: matrix(regularGroups, 'files', 'regular'), published }
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
