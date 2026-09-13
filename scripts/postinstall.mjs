import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isGlobalCli } from '../lib/update.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

export function runPostinstall({ root = packageRoot, env = process.env, execPath = process.execPath, run = spawnSync, global = isGlobalCli(root) } = {}) {
  if (!global) return 0
  const result = run(execPath, [resolve(root, 'bin', 'prumo.mjs'), 'install', '--all'], {
    env: { ...env, PRUMO_POSTINSTALL_LIFECYCLE: '1' }, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = runPostinstall()
