import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const archiveName = pkg => `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`
export const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')

export function sharedCandidate(root, env = process.env) {
  const manifestPath = env.PRUMO_CI_CANDIDATE_MANIFEST, expected = env.PRUMO_CI_CANDIDATE_SHA256
  if (manifestPath === undefined && expected === undefined) return undefined
  if (!manifestPath || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('O candidato compartilhado exige manifesto e digest SHA256 esperado')
  const regular = path => {
    if (!lstatSync(path).isFile() || realpathSync(path) !== path) throw new Error('O candidato deve ser um arquivo regular sem links')
  }
  const manifestFile = resolve(realpathSync(root), manifestPath)
  regular(manifestFile)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (manifest.version !== pkg.version || manifest.archive !== archiveName(pkg) || basename(manifest.archive) !== manifest.archive)
    throw new Error('O candidato compartilhado não corresponde ao pacote vigente')
  if (env.GITHUB_SHA && manifest.revision !== env.GITHUB_SHA) throw new Error('O candidato compartilhado pertence a outra revisão')
  const archive = resolve(dirname(manifestFile), manifest.archive)
  regular(archive)
  if (manifest.sha256 !== expected || digest(archive) !== expected) throw new Error('O digest do candidato compartilhado diverge do aprovado na preparação')
  return archive
}
