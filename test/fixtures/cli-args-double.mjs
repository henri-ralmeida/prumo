import module from 'node:module'

// Um parser atualizado parcialmente não pode encaminhar comando novo para instalação.
module.registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('/lib/cli-args.mjs')) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: 'export function assertCliOptions() {}\n//# sourceURL=prumo-test://cli-args-double\n' }
} })
