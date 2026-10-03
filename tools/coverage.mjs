import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import coverage from 'istanbul-lib-coverage'
import { prepareDashboardCoverageSource } from '../test/fixtures/dashboard-vm.mjs'

export function sourceManifest(root) {
  const sources = {}
  const visit = (directory, prefix) => {
    if (!existsSync(directory)) return
    if (lstatSync(directory).isSymbolicLink()) throw new Error(`Fonte ligado nao e aceito: ${prefix}`)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`Fonte ligado nao e aceito: ${relative}`)
      if (entry.isDirectory()) visit(join(directory, entry.name), relative)
      else if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') && !entry.name.endsWith('-smoke.mjs')) {
        sources[relative] = createHash('sha256').update(readFileSync(join(directory, entry.name), 'utf8').replaceAll('\r\n', '\n')).digest('hex')
      }
    }
  }
  for (const directory of ['bin', 'lib', 'scripts', 'tools']) visit(join(root, directory), directory)
  const htmlPath = join(root, 'scripts/dashboard.html')
  if (existsSync(htmlPath)) {
    if (lstatSync(htmlPath).isSymbolicLink()) throw new Error('Fonte ligado nao e aceito: scripts/dashboard.html')
    if ((readFileSync(htmlPath, 'utf8').match(/<script\b/gi) ?? []).length > 1)
      throw new Error('A cobertura deve medir todos os scripts do dashboard; múltiplos scripts exigem fontes separados')
    for (const relative of ['.test-output', '.test-output/coverage-sources', '.test-output/coverage-sources/dashboard-inline.mjs']) {
      if (lstatSync(join(root, relative), { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Fonte ligado nao e aceito: ${relative}`)
    }
    const { source } = prepareDashboardCoverageSource({ root, htmlPath })
    sources['.test-output/coverage-sources/dashboard-inline.mjs'] = createHash('sha256').update(source).digest('hex')
  }
  return sources
}

export function mergeReports(root, reports) {
  if (!reports.length) throw new Error('Nenhum relatorio de cobertura recebido')
  const expected = sourceManifest(root)
  if (!Object.keys(expected).length) throw new Error('Nenhum fonte elegivel encontrado')
  const merged = coverage.createCoverageMap({})
  for (const { manifest, data } of reports) {
    if (JSON.stringify(Object.entries(manifest).sort()) !== JSON.stringify(Object.entries(expected).sort()))
      throw new Error('Os relatorios nao correspondem aos fontes atuais')
    for (const [path, counters] of Object.entries(data)) {
      const normalized = path.replaceAll('\\', '/')
      const relative = Object.keys(expected).find(file => normalized === file || normalized.endsWith(`/${file}`))
      if (!relative) throw new Error(`Fonte fora do escopo elegivel: ${normalized}`)
      if (coverage.createFileCoverage(counters).toSummary().statements.total === 0)
        throw new Error(`Fonte sem instrucoes medidas: ${relative}`)
      merged.addFileCoverage({ ...counters, path: relative })
    }
  }
  const files = new Set(merged.files())
  for (const file of Object.keys(expected)) if (!files.has(file)) throw new Error(`Fonte sem medicao: ${file}`)
  const failures = []
  for (const file of merged.files()) {
    const summary = merged.fileCoverageFor(file).toSummary()
    for (const metric of ['lines', 'statements', 'functions', 'branches'])
      if (summary[metric].pct !== 100) failures.push(`${file}: ${metric} ${summary[metric].pct}%`)
  }
  return { data: merged.toJSON(), summary: merged.getCoverageSummary().toJSON(), failures }
}

export function readReports(input) {
  const reports = []
  const visit = directory => {
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Diretorio de cobertura ligado nao e aceito')
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Arquivo de cobertura ligado nao e aceito')
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name === 'coverage-final.json') reports.push({
        manifest: JSON.parse(readFileSync(join(directory, 'source-manifest.json'), 'utf8')),
        data: JSON.parse(readFileSync(path, 'utf8')),
      })
    }
  }
  visit(input)
  return reports
}

export function runCoverageCommand(action, input, root) {
  if (action === 'manifest') {
    const directory = join(root, '.test-output/coverage')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'source-manifest.json'), JSON.stringify(sourceManifest(root), null, 2) + '\n')
    return 0
  }
  if (action !== 'merge' || !input) throw new Error('Use coverage manifest ou coverage merge <diretorio>')
  const result = mergeReports(root, readReports(resolve(input)))
  const directory = join(root, '.test-output/coverage-merged')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'coverage-final.json'), JSON.stringify(result.data) + '\n')
  writeFileSync(join(directory, 'coverage-summary.json'), JSON.stringify(result.summary, null, 2) + '\n')
  for (const failure of result.failures) console.error(failure)
  console.log(JSON.stringify(result.summary))
  return result.failures.length ? 1 : 0
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  process.exitCode = runCoverageCommand(process.argv[2], process.argv[3], resolve(dirname(fileURLToPath(import.meta.url)), '..'))
