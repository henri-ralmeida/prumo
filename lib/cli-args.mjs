import { HARNESSES } from './install.mjs'

const harnessFlags = [...HARNESSES]
const allowed = {
  install: [...harnessFlags, 'all', 'lang', 'dry-run', 'project'],
  doctor: [...harnessFlags, 'lang', 'project', 'shell-filter-config', 'shell-block-evidence'],
  update: ['lang', 'dry-run', 'project'], _update: [],
  status: ['verify-install', 'project'], migrate: ['check', 'run'],
  dashboard: [], restore: [],
}

// Uma opção sem efeito pode ocultar uma gravação real, especialmente --dry-run.
// Rejeite-a antes de iniciar instalação, restauração ou serviços.
export function assertCliOptions(command, values) {
  if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown command: ${command}`)
  for (const flag of Object.keys(values)) {
    if (!allowed[command].includes(flag)) throw new Error(`${command} does not accept --${flag}`)
  }
}
