import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { removeLegacySmokeHome } from './fixtures/legacy-smoke-cleanup.mjs'

function home(t) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'prumo-legacy-smoke-')))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('limpeza remove o ambiente isolado e aceita uma segunda chamada', async t => {
  const path = home(t)
  writeFileSync(join(path, 'evidencia.txt'), 'dados do cenario')
  await removeLegacySmokeHome(path)
  assert.equal(existsSync(path), false)
  await removeLegacySmokeHome(path)
})

for (const persistent of [false, true]) test(persistent
  ? 'limpeza preserva uma falha de permissao e os arquivos nao removidos'
  : 'limpeza relista um arquivo criado depois da leitura do diretorio', t => {
  const path = home(t), directory = join(path, '.local', 'share', 'prumo')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'inicial.txt'), 'inicial')
  // Injete a corrida na chamada real ao sistema, apos a listagem e antes do rmdir.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const directory = ${JSON.stringify(directory)}, persistent = ${persistent};
    let injections = 0;
    const inject = path => {
      if (String(path) === directory && fs.existsSync(directory)
          && fs.readdirSync(directory).length === 0 && (persistent || injections === 0)) {
        fs.writeFileSync(directory + '/tardio.txt', 'escrita tardia'); injections++;
      }
    };
    const rmdir = fs.rmdir, rmdirSync = fs.rmdirSync;
    const denied = () => Object.assign(new Error('acesso recusado'), { code: 'EACCES' });
    fs.rmdir = function(path, ...args) {
      if (persistent && String(path) === directory) { injections++; return args.at(-1)(denied()) }
      inject(path); return rmdir.call(this, path, ...args);
    };
    fs.rmdirSync = function(path, ...args) {
      if (persistent && String(path) === directory) { injections++; throw denied() }
      inject(path); return rmdirSync.call(this, path, ...args);
    };
    const { removeLegacySmokeHome } = await import(${JSON.stringify(new URL('./fixtures/legacy-smoke-cleanup.mjs', import.meta.url).href)});
    let code = null;
    try { await removeLegacySmokeHome(${JSON.stringify(path)}) } catch (error) { code = error.code }
    console.log(JSON.stringify({ code, injections, remains: fs.existsSync(${JSON.stringify(path)}) }));
  `], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const observed = JSON.parse(result.stdout)
  assert.ok(observed.injections > 0, 'a corrida foi exercitada')
  assert.equal(observed.code, persistent ? 'EACCES' : null)
  assert.equal(observed.remains, persistent)
})

test('limpeza recusa nomes e locais fora do ambiente isolado', async t => {
  const path = home(t), nested = join(path, 'prumo-legacy-smoke-filho')
  mkdirSync(nested)
  await assert.rejects(removeLegacySmokeHome(nested), { code: 'ERR_ASSERTION' })
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'prumo-preservar-')))
  t.after(() => rmSync(other, { recursive: true, force: true }))
  await assert.rejects(removeLegacySmokeHome(other), { code: 'ERR_ASSERTION' })
  assert.ok(existsSync(nested) && existsSync(other))
})
