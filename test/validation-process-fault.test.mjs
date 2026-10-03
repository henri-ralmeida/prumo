import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// As falhas simuladas não podem encerrar processos reais nem permitir reutilizar uma revisão desconhecida.
for (const mode of ['no_pid', 'tree_failure', 'tree_error', 'posix_failure', 'posix_missing', 'untracked_hash_error']) {
  test(`validação preserva o erro e limita encerramento ao processo próprio: ${mode}`, {
    skip: (mode.startsWith('tree_') && process.platform !== 'win32') ||
      (mode.startsWith('posix_') && process.platform === 'win32'),
  }, t => {
    const root = mkdtempSync(join(tmpdir(), 'prumo-validation-fault-'))
    t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }) })
    const source = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { EventEmitter } from 'node:events';
      const mode = ${JSON.stringify(mode)}, calls = [];
      if (mode.startsWith('posix_')) process.kill = (pid, signal) => {
        calls.push(['process.kill', [pid, signal]]);
        throw Object.assign(new Error('group unavailable'), { code: mode === 'posix_missing' ? 'ESRCH' : 'EACCES' });
      };
      childProcess.spawnSync = (command, args) => {
        calls.push([command, args]);
        if (command === 'taskkill.exe') return { status: 1, stderr: 'termination refused',
          ...(mode === 'tree_error' ? { error: new Error('termination unavailable') } : {}) };
        if (command !== 'git') throw new Error('unexpected external command');
        if (args.includes('hash-object')) return { status: 1, error: new Error('hash unavailable') };
        return { status: 0, stdout: args.includes('ls-files') ? 'untracked.txt\\0' : 'revision' };
      };
      childProcess.spawn = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.pid = mode.startsWith('tree_') || mode.startsWith('posix_') ? 123456 : undefined;
        child.kill = signal => { calls.push(['child.kill', signal]); return true; };
        queueMicrotask(() => {
          if (mode !== 'untracked_hash_error') {
            child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
            child.stderr.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
          }
          child.emit('close', 0, null);
        });
        return child;
      };
      syncBuiltinESMExports();
      const { runValidation } = await import(${JSON.stringify(new URL('../scripts/validation.mjs', import.meta.url).href)});
      const cache = mode === 'untracked_hash_error';
      const task = { attempts: [{}], validations: [{ by: 'review', agent: 'reviewer' }],
        validation: [{ kind: cache ? 'static' : 'functional', run: 'isolated check', expect: 'approved behavior', timeoutMs: 0,
          ...(cache ? { cacheable: true } : {}) }],
        ...(cache ? { validationMode: 'inspection', inspectionReason: 'Verificar sem alterar arquivos.' } : {}) };
      const receipt = await runValidation(task, ${JSON.stringify(root)});
      console.log(JSON.stringify({ receipt, calls }));
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const { receipt, calls } = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
    const check = receipt.checks[0]
    if (mode === 'untracked_hash_error') {
      assert.equal(check.workspaceRevision, null)
      assert.equal(check.exitCode, 0)
      assert.equal(calls.filter(([command, args]) => command === 'git' && args.includes('hash-object')).length, 1)
    } else {
      assert.match(check.error, /ENOBUFS/)
      const kills = calls.filter(([command]) => command === 'taskkill.exe' || command === 'child.kill' || command === 'process.kill')
      if (mode === 'no_pid') assert.deepEqual(kills, [])
      else if (mode.startsWith('posix_')) {
        assert.deepEqual(kills, [['process.kill', [-123456, 'SIGKILL']]])
        if (mode === 'posix_failure') assert.match(check.error, /process-group termination failed: group unavailable/)
        else assert.equal(check.error, 'ENOBUFS: validation output exceeds 4 MiB')
      }
      else {
        assert.match(check.error, mode === 'tree_error' ? /process-tree termination failed: termination unavailable/ : /process-tree termination failed: termination refused/)
        assert.deepEqual(kills, [['taskkill.exe', ['/PID', '123456', '/T', '/F']], ['child.kill', 'SIGKILL']])
      }
    }
  })
}
