import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

// The caller holds the run lock. Never delete the destination to work around a lock.
export function writeAtomicState(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, contents)
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); return }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * 2 ** attempt)
      }
    }
  } finally {
    // Best effort: preserve the original error if Windows also locks the temporary file.
    try { fs.rmSync(temporary, { force: true }) } catch {}
  }
}
