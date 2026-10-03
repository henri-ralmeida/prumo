import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

test('copia identica compartilha contadores sem mudar import.meta.url; copia adulterada fica separada', t => {
  const base = realpathSync(tmpdir()), home = mkdtempSync(join(base, 'prumo-coverage-alias-'))
  t.after(() => { assert.equal(dirname(home), base); rmSync(home, { recursive: true, force: true }) })
  const original = join(home, 'original'), copied = join(home, 'copied'), changed = join(home, 'changed')
  for (const root of [original, copied, changed]) mkdirSync(join(root, 'lib'), { recursive: true })
  const source = 'export function valor() { return import.meta.url }\n'
  writeFileSync(join(original, 'lib/sample.mjs'), source)
  writeFileSync(join(copied, 'lib/sample.mjs'), source)
  writeFileSync(join(changed, 'lib/sample.mjs'), source + '// alterado\n')
  const data = join(home, 'v8')
  const preload = new URL('./fixtures/coverage-alias.mjs', import.meta.url).href
  const program = `const o=await import(${JSON.stringify(pathToFileURL(join(original, 'lib/sample.mjs')).href)}); const a=await import(${JSON.stringify(pathToFileURL(join(copied, 'lib/sample.mjs')).href)}); const b=await import(${JSON.stringify(pathToFileURL(join(changed, 'lib/sample.mjs')).href)}); console.log(JSON.stringify([o.valor(),a.valor(),b.valor()]));`
  const result = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-e', program], {
    env: { ...process.env, NODE_V8_COVERAGE: data, PRUMO_TEST_COVERAGE_FLUSH: '1', PRUMO_TEST_COVERAGE_SOURCE_ROOT: original },
    encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [original, copied, changed].map(root => pathToFileURL(join(root, 'lib/sample.mjs')).href))
  const records = readdirSync(data).filter(name => name.endsWith('.json')).flatMap(name => JSON.parse(readFileSync(join(data, name), 'utf8')).result)
  const canonical = records.filter(record => record.url === pathToFileURL(join(original, 'lib/sample.mjs')).href)
  assert.ok(canonical.length >= 2, 'original e cópia precisam contribuir para a mesma fonte')
  assert.equal(new Set(canonical.map(record => record.functions[0].ranges[0].endOffset)).size, 1,
    'comprimentos distintos distorcem a consolidação de caminhos condicionais no V8')
  for (const record of canonical) assert.equal(record.functions.find(fn => fn.functionName === 'valor').ranges[0].count, 1)
  assert.ok(records.some(record => record.url === pathToFileURL(join(changed, 'lib/sample.mjs')).href))
  assert.equal(readFileSync(join(copied, 'lib/sample.mjs'), 'utf8'), source)
})
