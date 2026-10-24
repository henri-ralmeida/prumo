import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { archiveName, digest } from './ci-candidate.mjs'

export function prepareCandidate({ root = process.cwd(), env = process.env, run = spawnSync } = {}) {
  root = realpathSync(root)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const directory = join(root, '.test-output/ci-candidate')
  for (const path of [join(root, '.test-output'), directory]) {
    const entry = lstatSync(path, { throwIfNoEntry: false })
    if (entry && (!entry.isDirectory() || realpathSync(path) !== path)) throw new Error('A preparação do candidato não aceita diretórios ligados')
  }
  mkdirSync(directory, { recursive: true })
  if (realpathSync(directory) !== directory) throw new Error('A preparação do candidato não aceita diretórios ligados')
  for (const name of [archiveName(pkg), 'manifest.json']) {
    const entry = lstatSync(join(directory, name), { throwIfNoEntry: false })
    if (entry && !entry.isFile()) throw new Error('A preparação do candidato exige arquivos regulares sem links')
  }
  const command = process.platform === 'win32'
    ? [env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', 'pack']]
    : ['npm', ['pack']]
  const result = run(command[0], [...command[1], '--ignore-scripts', '--json', '--pack-destination', '.test-output/ci-candidate'],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Falha ao preparar o candidato: ${result.stdout ?? ''}${result.stderr ?? ''}`)
  const output = JSON.parse(result.stdout)
  // npm publicado pode identificar o único pacote por uma lista ou pelo nome; ambos precisam produzir o mesmo arquivo.
  const packed = Array.isArray(output) ? output : output && Object.keys(output).length === 1 ? [output[pkg.name]] : []
  if (packed.length !== 1 || packed[0]?.filename !== archiveName(pkg)) throw new Error('O empacotamento não produziu o candidato esperado')
  const manifest = { version: pkg.version, archive: archiveName(pkg), sha256: digest(join(directory, archiveName(pkg))), revision: env.GITHUB_SHA ?? null }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `sha256=${manifest.sha256}\n`)
  return manifest
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) prepareCandidate()
