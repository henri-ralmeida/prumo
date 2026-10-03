import module from 'node:module'

// A prévia automática deve passar os ambientes detectados para a seleção sem escrever arquivos.
module.registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('/lib/prompt.mjs')) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: `export async function selectHarnesses(harnesses) { console.log('seleção solicitada: ' + harnesses.join(', ')); return harnesses; }\n//# sourceURL=prumo-test://prompt-double\n` }
} })
