import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

// O chamador mantém o bloqueio da execução. Nunca apague o destino para contornar um bloqueio.
export function writeAtomicState(file, contents, { validateJson = false } = {}) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' })
    if (validateJson) {
      const written = fs.readFileSync(temporary, 'utf8')
      JSON.parse(written)
      if (written !== contents) throw new Error('Temporary JSON differs from the intended content')
    }
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); return }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * 2 ** attempt)
      }
    }
  /* c8 ignore next -- O laço sempre retorna ou lança; esta passagem até catch não é executável. */
  } catch (error) {
    if (error?.code === 'ENOSPC') error.prumoAtomicFile = file
    throw error
  /* c8 ignore next -- O fim do catch é inalcançável após o relançamento; o finally continua testado. */
  } finally {
    // Preserve o erro original caso o Windows também bloqueie o arquivo temporário.
    try { fs.rmSync(temporary, { force: true }) } catch {}
  }
}
