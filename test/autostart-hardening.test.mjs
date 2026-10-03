import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { dashboardHealth, dashboardStatus, disableDashboard, enableDashboard, restartDashboard, runDashboardForeground, stopDashboardForUpdate } from '../lib/autostart.mjs'

function fixture(t, platform = 'win32') {
  const home = fs.mkdtempSync(join(tmpdir(), 'prumo-autostart-hardening-'))
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    assert.equal(dirname(home), tmpdir())
    fs.rmSync(home, { recursive: true, force: true })
  })
  const node = join(home, 'Node JS', 'node.exe'), script = join(home, 'Prumo', 'scripts/serve.mjs')
  fs.mkdirSync(join(home, '.local/share/prumo'), { recursive: true })
  fs.writeFileSync(join(home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism: platform === 'win32' ? 'windows-startup' : 'xdg', node, script }))
  let running = true
  const killed = []
  const command = `"${node}" "${script}" --global --port 4949`
  const options = { platform, home, node, script, contentId: 'fixture', version: '2.3.2', env: {},
    delay: async () => {}, readinessAttempts: 2, portAvailable: async () => true,
    kill: pid => { killed.push(pid); running = false },
    fetch: async url => {
      if (!running) throw new Error('stopped')
      return { ok: true, json: async () => String(url).endsWith('/api/about') ? { product: 'prumo' }
        : { product: 'prumo', mode: 'global', readOnly: true } }
    },
  }
  return { home, node, script, options, command, killed }
}

for (const scenario of ['wsh', 'powershell', 'malformed-wsh', 'missing-wsh']) {
  test(`encerramento confirma o comando real via ${scenario} sem confiar apenas no PID`, async t => {
    const f = fixture(t)
    const query = []
    t.mock.method(childProcess, 'execFileSync', (file, args) => {
      if (file === 'cscript.exe' || args.at(-1).includes('Win32_Process')) query.push(file)
      if (file === 'cscript.exe') {
        if (scenario === 'powershell') throw new Error('WSH indisponivel')
        if (scenario === 'malformed-wsh') return '{}'
        if (scenario === 'missing-wsh' && args.includes('pid')) return '[]'
        return JSON.stringify([{ pid: 555, executable: f.node, commandLine: f.command }])
      }
      assert.equal(file, 'powershell.exe')
      return args.at(-1).includes('ConvertTo-Json') ? JSON.stringify({ executable: f.node, commandLine: f.command }) : '555 999'
    })
    syncBuiltinESMExports()
    const stopped = await stopDashboardForUpdate(f.options)
    assert.deepEqual(stopped, { ok: true, stopped: true })
    assert.deepEqual(f.killed, [555])
    assert.ok(query.includes('cscript.exe'))
    assert.equal(query.includes('powershell.exe'), scenario !== 'wsh')
  })
}

test('consulta Windows prepara script ausente sem escrever fora do ambiente simulado', async t => {
  const f = fixture(t), writes = [], moves = []
  const read = fs.readFileSync, write = fs.writeFileSync, rename = fs.renameSync
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (String(path).endsWith('prumo-process-query-v1.js')) throw Object.assign(new Error('ausente'), { code: 'ENOENT' })
    return read(path, ...args)
  })
  t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    if (String(path).includes('prumo-process-query-v1.js.')) { writes.push([path, args[0]]); return }
    return write(path, ...args)
  })
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('prumo-process-query-v1.js')) { moves.push([from, to]); return }
    return rename(from, to)
  })
  t.mock.method(childProcess, 'execFileSync', () => JSON.stringify([{ pid: 555, executable: f.node, commandLine: f.command }]))
  syncBuiltinESMExports()
  assert.deepEqual(await stopDashboardForUpdate(f.options), { ok: true, stopped: true })
  assert.ok(writes.length > 0)
  assert.equal(moves.length, writes.length)
  assert.ok(writes.every(([, source]) => source.includes('Win32_Process')))
})

test('consulta Windows ignora processos sem linha de comando e encerra somente o dashboard comprovado', async t => {
  const f = fixture(t), inspected = []
  t.mock.method(childProcess, 'execFileSync', (file, args) => {
    assert.equal(file, 'cscript.exe')
    if (args.includes('name')) return JSON.stringify([
      { pid: 777, commandLine: null },
      { pid: 888 },
      { pid: 555, executable: f.node, commandLine: f.command },
    ])
    inspected.push(args.at(-1))
    return JSON.stringify([{ pid: 555, executable: f.node, commandLine: f.command }])
  })
  syncBuiltinESMExports()
  assert.deepEqual(await stopDashboardForUpdate(f.options), { ok: true, stopped: true })
  assert.deepEqual(f.killed, [555])
  assert.deepEqual(inspected, ['555'])
})

test('inspecao Linux usa argv do processo e preserva argumentos fora do contrato', async t => {
  const f = fixture(t, 'linux')
  const read = fs.readFileSync
  let extra = true
  t.mock.method(fs, 'readFileSync', (path, ...args) => String(path) === '/proc/555/cmdline'
    ? [f.node, f.script, '--global', '--port', '4949', ...(extra ? ['--sync-plan'] : [])].join('\0') + '\0'
    : read(path, ...args))
  syncBuiltinESMExports()
  f.options.fetch = async () => ({ ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, pid: 555 }) })
  const refused = await stopDashboardForUpdate(f.options)
  assert.equal(refused.ok, false)
  assert.deepEqual(f.killed, [])
  extra = false
  let running = true
  f.options.fetch = async () => {
    if (!running) throw new Error('stopped')
    return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, pid: 555 }) }
  }
  f.options.kill = pid => { f.killed.push(pid); running = false }
  assert.deepEqual(await stopDashboardForUpdate(f.options), { ok: true, stopped: true })
  assert.deepEqual(f.killed, [555])
})

for (const changed of ['executable', 'script', 'port', 'extra', 'truncated']) {
  test(`Windows preserva ocupante com ${changed} diferente mesmo quando afirma ser Prumo`, async t => {
    const f = fixture(t)
    const executable = changed === 'executable' ? join(f.home, 'other.exe') : f.node
    let command = f.command
    if (changed === 'script') command = command.replace(f.script, join(f.home, 'other.mjs'))
    if (changed === 'port') command = command.replace('4949', '9999')
    if (changed === 'extra') command += ' --sync-plan'
    if (changed === 'truncated') command += ' "'
    t.mock.method(childProcess, 'execFileSync', (file, args) => file === 'cscript.exe'
      ? JSON.stringify([{ pid: 555, executable, commandLine: command }])
      : args.at(-1).includes('ConvertTo-Json') ? JSON.stringify({ executable, commandLine: command }) : '555')
    syncBuiltinESMExports()
    assert.equal((await stopDashboardForUpdate(f.options)).ok, false)
    assert.deepEqual(f.killed, [])
  })
}

for (const scenario of ['registration', 'kill', 'still-running', 'launch']) {
  test(`reinício informa falha de ${scenario} e conserva preferência de ativação`, async t => {
    const f = fixture(t)
    f.options.readProcessCommand = () => [f.node, f.script, '--global', '--port', '4949']
    f.options.listProcessIds = () => [555]
    f.options.exec = () => ({ status: 0 })
    if (scenario === 'registration') {
      const blocked = join(f.home, 'blocked')
      fs.writeFileSync(blocked, 'preservar')
      f.options.env.APPDATA = blocked
    }
    if (scenario === 'kill') f.options.kill = () => { throw new Error('acesso negado') }
    if (scenario === 'still-running') f.options.kill = () => {}
    if (scenario === 'launch') f.options.spawn = () => { throw new Error('início negado') }
    const result = await restartDashboard(f.options)
    assert.equal(result.ok, false)
    assert.match(result.error, new RegExp(scenario === 'registration' ? 'registration failed' : scenario === 'kill'
      ? 'stop failed' : scenario === 'still-running' ? 'did not stop' : 'process failed'))
    const preference = JSON.parse(fs.readFileSync(join(f.home, '.local/share/prumo/dashboard.json'), 'utf8'))
    assert.equal(preference.enabled, true)
    assert.equal(preference.script, f.script)
  })
}

test('falha ao substituir registro do agendador mantém o processo e informa os dois problemas', async t => {
  const f = fixture(t)
  fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism: 'schtasks', node: f.node, script: f.script }))
  f.options.exec = (_file, args) => ({ status: args[0] === '/Query' || args[0] === '/End' ? 0 : 1, stderr: 'negado' })
  for (const operation of [enableDashboard, restartDashboard]) {
    const result = await operation(f.options)
    assert.equal(result.ok, false)
    assert.deepEqual(f.killed, [])
    assert.ok(result.error?.includes('Unable to replace') || result.error?.includes('did not stop'))
  }
})

for (const scenario of ['unverified', 'kill-failed', 'still-running', 'end-failed', 'delete-failed']) {
  test(`reinício pelo agendador preserva processo quando ocorre ${scenario}`, async t => {
    const f = fixture(t)
    fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism: 'schtasks', node: f.node, script: f.script }))
    f.options.listProcessIds = () => []
    f.options.readProcessCommand = () => scenario === 'unverified' ? ['other'] : [f.node, f.script, '--global', '--port', '4949']
    f.options.fetch = async () => {
      if (scenario === 'delete-failed') throw new Error('parado')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, pid: 555 }) }
    }
    f.options.exec = (_file, args) => ({ status: args[0] === '/Query' ? ['end-failed', 'delete-failed'].includes(scenario) ? 0 : 1
      : args[0] === '/End' && scenario === 'end-failed' || ['/Create', '/Delete'].includes(args[0]) && scenario === 'delete-failed' ? 1 : 0 })
    if (scenario === 'kill-failed') f.options.kill = () => { throw new Error('negado') }
    if (scenario === 'still-running') f.options.kill = () => {}
    const result = await restartDashboard(f.options)
    assert.equal(result.ok, false)
    assert.equal(JSON.parse(fs.readFileSync(join(f.home, '.local/share/prumo/dashboard.json'), 'utf8')).enabled, true)
    if (scenario !== 'end-failed') assert.match(result.error, /ownership|stop failed|did not stop|Unable to replace/)
  })
}

test('falha no bootout macOS não é tratada como reinício bem-sucedido', async t => {
  const f = fixture(t, 'darwin')
  fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism: 'launchd', node: f.node, script: f.script }))
  f.options.exec = (_file, args) => ({ status: args[0] === 'bootout' ? 1 : 0 })
  assert.equal((await restartDashboard(f.options)).ok, false)
  assert.deepEqual(f.killed, [])
})

test('ativação comunica falha ao criar processo e mantém preferência para nova tentativa', async t => {
  const f = fixture(t)
  f.options.fetch = async () => { throw new Error('parado') }
  f.options.spawn = () => { throw new Error('início indisponível') }
  const result = await enableDashboard(f.options)
  assert.equal(result.ok, false)
  assert.match(result.error, /Startup process failed: início indisponível/)
  assert.equal(JSON.parse(fs.readFileSync(join(f.home, '.local/share/prumo/dashboard.json'), 'utf8')).enabled, true)
})

test('plataforma não suportada é recusada antes de registrar inicialização', async t => {
  const f = fixture(t, 'unsupported')
  await assert.rejects(enableDashboard(f.options), /Unsupported platform/)
  assert.deepEqual(f.killed, [])
})

test('consulta do registro propaga resultado nativo sem confundir falha com registro existente', async t => {
  const f = fixture(t)
  fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: false, mechanism: 'schtasks' }))
  f.options.fetch = async () => { throw new Error('parado') }
  f.options.engineHash = 'a'.repeat(64)
  let fail = 0
  t.mock.method(childProcess, 'execFileSync', () => {
    if (fail === 1) throw Object.assign(new Error('consulta negada'), { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('negado') })
    if (fail === 2) throw new Error('comando indisponível')
    return 'registro encontrado'
  })
  syncBuiltinESMExports()
  assert.equal((await dashboardStatus(f.options)).registered, true)
  fail = 1
  assert.equal((await dashboardStatus(f.options)).registered, false)
  fail = 2
  assert.equal((await dashboardStatus(f.options)).registered, false)
  assert.equal(JSON.parse(fs.readFileSync(join(f.home, '.local/share/prumo/dashboard.json'), 'utf8')).enabled, false)
})

test('PID persistido inválido não autoriza encerramento de processo', async t => {
  const f = fixture(t)
  fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism: 'windows-startup', pid: 'not-a-pid', node: f.node, script: f.script }))
  f.options.listProcessIds = () => []
  const result = await stopDashboardForUpdate(f.options)
  assert.equal(result.ok, false)
  assert.match(result.error, /ownership verification failed/)
  assert.deepEqual(f.killed, [])
})

test('autostart recusa caminhos relativos e comando sem executável comprovado', async t => {
  const f = fixture(t)
  await assert.rejects(dashboardStatus({ ...f.options, node: 'node' }), /absolute Node and package paths/)
  f.options.readProcessCommand = () => ({ commandLine: f.command })
  f.options.listProcessIds = () => [555]
  assert.equal((await stopDashboardForUpdate(f.options)).ok, false)
  assert.deepEqual(f.killed, [])
  delete f.options.readinessAttempts
  assert.equal((await dashboardStatus({ ...f.options, platform: 'linux' })).process, 'running')
})

test('registro indisponível preserva dashboard existente sem identidade persistida', async t => {
  const f = fixture(t, 'linux')
  fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism: 'xdg' }))
  const write = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    if (String(path).endsWith('prumo-dashboard.desktop')) throw new Error('registro negado')
    return write(path, ...args)
  })
  syncBuiltinESMExports()
  const result = await enableDashboard(f.options)
  assert.equal(result.ok, false)
  assert.match(result.error, /Startup registration failed: registro negado/)
  const saved = JSON.parse(fs.readFileSync(join(f.home, '.local/share/prumo/dashboard.json'), 'utf8'))
  assert.equal(saved.node, f.node)
  assert.equal(saved.script, f.script)
  assert.deepEqual(f.killed, [])
})

test('reinício macOS registra serviço parado antes de iniciar a candidata', async t => {
  const f = fixture(t, 'darwin'), commands = []
  fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism: 'launchd' }))
  let running = false
  f.options.fetch = async () => {
    if (!running) throw new Error('parado')
    return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, version: f.options.version, contentId: 'fixture' }) }
  }
  f.options.uid = () => 1234
  f.options.exec = (_file, args) => { commands.push(args); if (args[0] === 'kickstart') running = true; return { status: 0 } }
  assert.equal((await restartDashboard(f.options)).ok, true)
  assert.deepEqual(commands.filter(args => ['bootout', 'bootstrap', 'kickstart'].includes(args[0])).map(args => args[0]), ['bootout', 'bootstrap', 'kickstart'])
})

test('reinício denuncia processo criado que não oferece a identidade esperada', async t => {
  const f = fixture(t, 'linux')
  f.options.fetch = async () => { throw new Error('parado') }
  f.options.spawn = () => ({})
  const missingPid = await enableDashboard(f.options)
  assert.equal(missingPid.ok, false)
  assert.match(missingPid.error, /managed process not found/)
  assert.match((await restartDashboard(f.options)).error, /managed process not found/)
  f.options.spawn = () => ({ pid: 555 })
  f.options.listProcessIds = () => [555]
  f.options.readProcessCommand = () => [f.node, f.script, '--global', '--port', '4949']
  f.options.exec = () => ({ status: 1 })
  const result = await restartDashboard(f.options)
  assert.equal(result.ok, false)
  assert.match(result.error, /Startup readiness failed: stopped/)
  assert.equal(JSON.parse(fs.readFileSync(join(f.home, '.local/share/prumo/dashboard.json'), 'utf8')).enabled, true)
})

test('serviço indisponível informa falha antes de declarar ativação', async t => {
  const f = fixture(t, 'linux')
  fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism: 'systemd' }))
  f.options.fetch = async () => { throw new Error('parado') }
  f.options.exec = (_file, args) => ({ status: args.includes('enable') ? 1 : 0 })
  await assert.rejects(enableDashboard(f.options), /systemctl .* failed/)
  assert.deepEqual(f.killed, [])
})

for (const mechanism of ['launchd', 'schtasks']) test(`desativação ${mechanism} denuncia processo que o serviço não encerrou`, async t => {
  const f = fixture(t, mechanism === 'launchd' ? 'darwin' : 'win32')
  fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism }))
  f.options.exec = (_file, args) => ({ status: ['bootout', '/End'].includes(args[0]) ? 1 : 0 })
  f.options.uid = () => 1234
  assert.equal((await disableDashboard(f.options)).ok, false)
  assert.deepEqual(f.killed, [])
})

test('processo sem PID e dashboard com identidade antiga não são confirmados como atualizados', async t => {
  const f = fixture(t, 'linux')
  f.options.fetch = async () => { throw new Error('parado') }
  f.options.spawn = () => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  assert.equal((await enableDashboard(f.options)).ok, false)
  f.options.fetch = async url => ({ ok: true, json: async () => String(url).endsWith('/api/about')
    ? { product: 'prumo', version: '0.0.1', contentId: 'antiga' }
    : { product: 'prumo', mode: 'global', readOnly: true } })
  fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism: 'systemd' }))
  f.options.exec = () => ({ status: 0 })
  assert.equal((await restartDashboard(f.options)).ok, false)
  assert.equal(runDashboardForeground({ ...f.options, spawnSync: () => ({ status: null }) }), 1)
})

test('registro macOS consulta somente o domínio do usuário corrente', async t => {
  const f = fixture(t, 'darwin'), calls = []
  const original = Object.getOwnPropertyDescriptor(process, 'getuid')
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1234 })
  t.after(() => { if (original) Object.defineProperty(process, 'getuid', original); else delete process.getuid })
  fs.writeFileSync(join(f.home, '.local/share/prumo/dashboard.json'), JSON.stringify({ enabled: true, mechanism: 'launchd' }))
  f.options.exec = (_file, args) => { calls.push(args); return { status: 0 } }
  await disableDashboard(f.options)
  assert.ok(calls.some(args => args[0] === 'bootout' && args[1] === 'gui/1234'))
  assert.deepEqual(f.killed, [])
})

for (const about of ['missing', 'invalid']) {
  test(`dashboard antigo mantém saúde conhecida com identidade ${about}`, async t => {
    const f = fixture(t)
    f.options.fetch = async url => String(url).endsWith('/api/about')
      ? { ok: about !== 'missing', json: async () => { throw new Error('JSON inválido') } }
      : { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true }) }
    assert.deepEqual(await dashboardHealth(f.options), { state: 'running', health: { product: 'prumo', mode: 'global', readOnly: true }, about: null })
  })
}
