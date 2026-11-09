import fs from 'node:fs'
import path from 'node:path'

const [reportId, filename] = process.argv.slice(2)
const source = path.join(process.env.DATA_DIR, `${reportId}.csv`)
const lines = fs.readFileSync(source, 'utf8').split(/\r?\n/).filter(Boolean)
const [header, ...rows] = lines
const out = [header.toUpperCase(), ...rows].join('\n') + '\n'
fs.writeFileSync(path.join(process.env.EXPORTS_DIR, path.basename(filename)), out)
console.log(rows.length)
