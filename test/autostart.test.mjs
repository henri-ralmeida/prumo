import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dashboardHealth, dashboardNeedsRepair, dashboardStatus, disableDashboard, enableDashboard, restartDashboard, runDashboardForeground } from '../lib/autostart.mjs'

function fixture(t, platform, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'prumo autostart-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const calls = []
  let task = false
  let running = false
  const node = join(home, 'Node JS', platform === 'win32' ? 'node.exe' : 'node')
  const script = join(home, 'Prumo Package', 'scripts', 'serve.mjs')
  const options = {
    platform, home, node, script, version: '1.3.0', env: {}, uid: () => 1234,
    fetch: async () => {
      if (!running) throw new Error('not running')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, version: '1.3.0' }) }
    },
    portAvailable: async () => true,
    listProcessIds: () => [],
    delay: async () => {},
    readinessAttempts: 3,
    exec(file, args) {
      calls.push([file, args])
      if (file === 'schtasks' && args[0] === '/Query') return { status: task ? 0 : 1, stdout: '' }
      if (file === 'schtasks' && args[0] === '/Create') task = true
      if (file === 'schtasks' && args[0] === '/Run') running = true
      if (file === 'schtasks' && args[0] === '/End') running = false
      if (file === 'schtasks' && args[0] === '/Delete') { task = false; running = false }
      if (file === 'launchctl' && args[0] === 'kickstart') running = true
      if (file === 'launchctl' && args[0] === 'bootout') running = false
      if (file === 'systemctl' && args[1] === 'show-environment') return { status: 0, stdout: '' }
      if (file === 'systemctl' && args.join(' ') === '--user enable --now prumo-dashboard.service') running = true
      if (file === 'systemctl' && args.join(' ') === '--user disable --now prumo-dashboard.service') running = false
      return { status: 0, stdout: '' }
    },
    ...extra,
  }
  return { home, node, script, calls, options }
}

const preference = home => JSON.parse(readFileSync(join(home, '.local', 'share', 'prumo', 'dashboard.json'), 'utf8'))

test('doctor policy distinguishes opt-out from missing, stopped and conflicting services', () => {
  assert.equal(dashboardNeedsRepair({ disabled: true, registered: false, process: 'stopped', conflict: false }), false)
  assert.equal(dashboardNeedsRepair({ disabled: false, registered: false, process: 'stopped', conflict: false }), true)
  assert.equal(dashboardNeedsRepair({ disabled: false, registered: true, process: 'stopped', conflict: false }), true)
  assert.equal(dashboardNeedsRepair({ disabled: false, registered: true, process: 'conflict', conflict: true }), true)
  assert.equal(dashboardNeedsRepair({ disabled: false, registered: true, process: 'running', conflict: false }), false)
})

test('Windows creates one ONLOGON task with absolute quoted paths and persists opt-out', async t => {
  const f = fixture(t, 'win32')
  const enabled = await enableDashboard(f.options)
  assert.equal(enabled.ok, true)
  const create = f.calls.find(([file, args]) => file === 'schtasks' && args[0] === '/Create')[1]
  assert.deepEqual(create.slice(0, 6), ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'Prumo Dashboard'])
  assert.match(create.at(-1), /^".*node\.exe" ".*serve\.mjs" "--global" "--port" "4949"$/)
  assert.ok(f.calls.some(([file, args]) => file === 'schtasks' && args[0] === '/Run'))
  assert.equal((await dashboardStatus(f.options)).registered, true)
  await enableDashboard(f.options)
  assert.equal(f.calls.filter(([file, args]) => file === 'schtasks' && args[0] === '/Create').length, 2, 'replace, never duplicate')
  const disabled = await disableDashboard(f.options)
  assert.equal(disabled.ok, true)
  assert.equal(disabled.registered, false)
  assert.equal(preference(f.home).enabled, false)
  await disableDashboard(f.options)
  assert.equal(preference(f.home).enabled, false)
})

test('Windows falls back to one hidden per-user Startup entry when task creation is unavailable', async t => {
  let running = false
  let nextPid = 4300
  let currentPid = null
  const spawned = []
  const killed = []
  const appData = join(tmpdir(), `Prumo Roaming ${process.pid}-${Date.now()}`)
  const f = fixture(t, 'win32', {
    env: { APPDATA: appData },
    exec(file, args) {
      f.calls.push([file, args])
      if (file === 'schtasks' && args[0] === '/Query') return { status: 1, stdout: '' }
      if (file === 'schtasks' && args[0] === '/Create') return { status: 5, stderr: 'localized denial' }
      return { status: 0, stdout: '' }
    },
    spawn(file, args, settings) {
      spawned.push([file, args, settings])
      running = true
      currentPid = ++nextPid
      return { pid: currentPid }
    },
    fetch: async () => {
      if (!running) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, version: '1.3.0' }) }
    },
    listProcessIds: () => currentPid ? [currentPid] : [],
    readProcessCommand: () => [f.node, f.script, '--global', '--port', '4949'],
    kill(pid) { killed.push(pid); running = false },
  })
  t.after(() => rmSync(appData, { recursive: true, force: true }))

  const enabled = await enableDashboard(f.options)
  const startup = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Prumo Dashboard.vbs')
  assert.equal(enabled.ok, true)
  assert.equal(enabled.mechanism, 'windows-startup')
  assert.equal(preference(f.home).mechanism, 'windows-startup')
  assert.equal(f.calls.filter(([file, args]) => file === 'schtasks' && args[0] === '/Create').length, 1)
  assert.deepEqual(spawned[0], [f.node, [f.script, '--global', '--port', '4949'], {
    cwd: join(f.home, '.local', 'share', 'prumo'), detached: true, stdio: 'ignore', windowsHide: true,
  }])
  assert.equal(existsSync(spawned[0][2].cwd), true)
  assert.match(readFileSync(startup, 'utf8'), /^CreateObject\("WScript\.Shell"\)\.Run """.*node\.exe"" "".*serve\.mjs"" ""--global"" ""--port"" ""4949""", 0, False\r?\n$/)

  assert.equal((await dashboardStatus(f.options)).registered, true)
  assert.equal((await enableDashboard(f.options)).ok, true)
  assert.equal(spawned.length, 1, 're-enable honors the persisted fallback and reuses its process')
  assert.equal(f.calls.filter(([file, args]) => file === 'schtasks' && args[0] === '/Create').length, 1)

  const restarted = await restartDashboard(f.options)
  assert.equal(restarted.ok, true)
  assert.equal(spawned.length, 2)
  assert.deepEqual(killed, [4301])

  const disabled = await disableDashboard(f.options)
  assert.equal(disabled.ok, true)
  assert.equal(disabled.registered, false)
  assert.deepEqual(killed, [4301, 4302])
  assert.equal(existsSync(startup), false)
  assert.equal(preference(f.home).enabled, false)
})

test('Windows Startup discovers a later login process and refuses similar foreign commands', async t => {
  let running = false
  let loginPid = 8800
  let exact = true
  const killed = []
  const appData = join(tmpdir(), `Prumo Login ${process.pid}-${Date.now()}`)
  const f = fixture(t, 'win32', {
    env: { APPDATA: appData },
    exec(file, args) {
      f.calls.push([file, args])
      return { status: file === 'schtasks' && args[0] === '/Create' ? 1 : 0, stdout: '' }
    },
    spawn: () => { running = true; return { pid: 7700 } },
    fetch: async () => {
      if (!running) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, version: '1.3.0' }) }
    },
    listProcessIds: () => [loginPid],
    readProcessCommand(pid) {
      if (pid === 7700) throw new Error('previous session ended')
      return exact
        ? { executable: f.node.toUpperCase(), commandLine: `"${f.node}" "${f.script}" "--global" "--port" "4949"` }
        : { executable: f.node, commandLine: `"${f.node}" "${f.script}" "--global" "--port" "4949" "--sync-plan"` }
    },
    kill(pid) { killed.push(pid); running = false },
  })
  t.after(() => rmSync(appData, { recursive: true, force: true }))

  await enableDashboard(f.options)
  running = true
  assert.equal((await enableDashboard(f.options)).ok, true)
  assert.equal(preference(f.home).pid, loginPid)
  exact = false
  const disabled = await disableDashboard(f.options)
  assert.equal(disabled.ok, false)
  assert.deepEqual(killed, [])
  assert.equal(disabled.registered, false, 'the managed entry is removed even when process ownership is not proven')
})

test('Windows Startup reports incomplete setup when its per-user registration cannot be written', async t => {
  const blocked = join(tmpdir(), `Prumo blocked APPDATA ${process.pid}-${Date.now()}`)
  writeFileSync(blocked, 'not a directory')
  t.after(() => rmSync(blocked, { force: true }))
  const f = fixture(t, 'win32', {
    env: { APPDATA: blocked },
    exec(file, args) {
      f.calls.push([file, args])
      return file === 'schtasks' && args[0] === '/Create'
        ? { status: 5, stdout: '', stderr: 'Access denied by policy' }
        : { status: 0, stdout: '' }
    },
  })

  const result = await enableDashboard(f.options)
  assert.equal(result.ok, false)
  assert.equal(result.mechanism, 'windows-startup')
  assert.equal(result.registered, false)
  assert.equal(result.process, 'stopped')
  assert.equal(preference(f.home).enabled, true)
  assert.match(result.error, /schtasks \/Create failed with status 5: Access denied by policy/)
  assert.match(result.error, /Startup registration failed:.*(?:directory|ENOTDIR)/i)
})

test('restart replaces an enabled registration without losing its preference', async t => {
  const f = fixture(t, 'win32')
  await enableDashboard(f.options)
  const restarted = await restartDashboard(f.options)
  assert.equal(restarted.ok, true)
  assert.equal(preference(f.home).enabled, true)
  assert.ok(f.calls.some(([file, args]) => file === 'schtasks' && args[0] === '/End'))
  assert.equal(f.calls.filter(([file, args]) => file === 'schtasks' && args[0] === '/Create').length, 2)
  await disableDashboard(f.options)
  const count = f.calls.length
  const skipped = await restartDashboard(f.options)
  assert.equal(skipped.skipped, true)
  assert.equal(f.calls.slice(count).some(([, args]) => ['/Create', '/Run'].includes(args[0])), false)
})

test('Windows restart switches to Startup when replacing its scheduler task becomes unavailable', async t => {
  let task = false
  let running = false
  let denyCreate = false
  const spawned = []
  const appData = join(tmpdir(), `Prumo Restart ${process.pid}-${Date.now()}`)
  const f = fixture(t, 'win32', {
    env: { APPDATA: appData },
    exec(file, args) {
      f.calls.push([file, args])
      if (file !== 'schtasks') return { status: 0, stdout: '' }
      if (args[0] === '/Query') return { status: task ? 0 : 1, stdout: '' }
      if (args[0] === '/Create') {
        if (denyCreate) return { status: 5, stderr: 'denied' }
        task = true
      }
      if (args[0] === '/Run') running = true
      if (args[0] === '/End') running = false
      if (args[0] === '/Delete') task = false
      return { status: 0, stdout: '' }
    },
    spawn(file, args) { spawned.push([file, args]); running = true; return { pid: 5500 } },
    fetch: async () => {
      if (!running) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, version: '1.3.0' }) }
    },
    readProcessCommand: () => [f.node, f.script, '--global', '--port', '4949'],
  })
  t.after(() => rmSync(appData, { recursive: true, force: true }))

  assert.equal((await enableDashboard(f.options)).mechanism, 'schtasks')
  denyCreate = true
  const restarted = await restartDashboard(f.options)
  assert.equal(restarted.ok, true)
  assert.equal(restarted.mechanism, 'windows-startup')
  assert.equal(preference(f.home).mechanism, 'windows-startup')
  assert.equal(task, false)
  assert.deepEqual(spawned, [[f.node, [f.script, '--global', '--port', '4949']]])
})

test('Windows restart reports scheduler denial plus unproven Startup ownership', async t => {
  let task = false
  let running = false
  let denyCreate = false
  const f = fixture(t, 'win32', {
    exec(file, args) {
      f.calls.push([file, args])
      if (file !== 'schtasks') return { status: 0, stdout: '' }
      if (args[0] === '/Query') return { status: task ? 0 : 1, stdout: '' }
      if (args[0] === '/Create') {
        if (denyCreate) return { status: 5, stderr: 'Access denied' }
        task = true
      }
      if (args[0] === '/Run') running = true
      return { status: 0, stdout: '' }
    },
    fetch: async () => {
      if (!running) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, version: '1.3.0' }) }
    },
    listProcessIds: () => [6400],
    readProcessCommand: () => [f.node, f.script, '--global', '--port', '4949', '--foreign'],
  })

  await enableDashboard(f.options)
  task = false
  denyCreate = true
  const result = await restartDashboard(f.options)
  assert.equal(result.ok, false)
  assert.match(result.error, /schtasks \/Create failed with status 5: Access denied/)
  assert.match(result.error, /Startup ownership verification failed: managed process not found/)
})

test('Windows restart reports scheduler denial plus a failed managed Startup stop', async t => {
  let task = false
  let running = false
  let denyCreate = false
  const f = fixture(t, 'win32', {
    exec(file, args) {
      f.calls.push([file, args])
      if (file !== 'schtasks') return { status: 0, stdout: '' }
      if (args[0] === '/Query') return { status: task ? 0 : 1, stdout: '' }
      if (args[0] === '/Create') {
        if (denyCreate) return { status: 5, stderr: 'Access denied' }
        task = true
      }
      if (args[0] === '/Run') running = true
      return { status: 0, stdout: '' }
    },
    fetch: async () => {
      if (!running) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, version: '1.3.0' }) }
    },
    listProcessIds: () => [6500],
    readProcessCommand: () => [f.node, f.script, '--global', '--port', '4949'],
    kill: () => { throw new Error('operation refused') },
  })

  await enableDashboard(f.options)
  task = false
  denyCreate = true
  const result = await restartDashboard(f.options)
  assert.equal(result.ok, false)
  assert.match(result.error, /schtasks \/Create failed with status 5: Access denied/)
  assert.match(result.error, /Startup process stop failed: operation refused/)
})

test('macOS writes a per-user LaunchAgent and manages only its fixed label', async t => {
  const f = fixture(t, 'darwin')
  await enableDashboard(f.options)
  const plist = join(f.home, 'Library', 'LaunchAgents', 'dev.prumo.dashboard.plist')
  const content = readFileSync(plist, 'utf8')
  assert.match(content, /<key>RunAtLoad<\/key><true\/>/)
  assert.match(content, /<key>SuccessfulExit<\/key><false\/>/)
  assert.ok(content.includes(f.node) && content.includes(f.script))
  assert.ok(f.calls.some(([file, args]) => file === 'launchctl' && args[0] === 'bootstrap' && args[1] === 'gui/1234'))
  assert.ok(f.calls.some(([file, args]) => file === 'launchctl' && args[0] === 'kickstart'))
  await disableDashboard(f.options)
  assert.equal(existsSync(plist), false)
  assert.ok(f.calls.some(([file, args]) => file === 'launchctl' && args[0] === 'bootout'))
})

test('Linux uses a systemd user unit when the user manager is available', async t => {
  const f = fixture(t, 'linux')
  await enableDashboard(f.options)
  const unit = join(f.home, '.config', 'systemd', 'user', 'prumo-dashboard.service')
  const content = readFileSync(unit, 'utf8')
  assert.match(content, /Restart=on-failure/)
  assert.ok(content.includes(`"${f.node.replaceAll('\\', '\\\\')}" "${f.script.replaceAll('\\', '\\\\')}" "--global" "--port" "4949"`))
  assert.ok(f.calls.some(([file, args]) => file === 'systemctl' && args.join(' ') === '--user enable --now prumo-dashboard.service'))
  await disableDashboard(f.options)
  assert.equal(existsSync(unit), false)
  assert.ok(f.calls.some(([file, args]) => file === 'systemctl' && args.join(' ') === '--user disable --now prumo-dashboard.service'))
})

test('Linux falls back to XDG, starts detached, and only stops a proven PID', async t => {
  const spawned = []
  const killed = []
  let running = false
  let options
  const f = fixture(t, 'linux', {
    exec(file, args) { f.calls.push([file, args]); return { status: file === 'systemctl' ? 1 : 0, stdout: '' } },
    spawn(file, args, settings) { spawned.push([file, args, settings]); running = true; return { pid: 4321 } },
    fetch: async () => {
      if (!running) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, version: '1.3.0' }) }
    },
    readProcessCommand: () => [f?.node, f?.script, '--global', '--port', '4949'],
    kill(pid) { killed.push(pid); running = false },
  })
  options = f.options
  await enableDashboard(options)
  const desktop = join(f.home, '.config', 'autostart', 'prumo-dashboard.desktop')
  assert.ok(readFileSync(desktop, 'utf8').includes(`Exec="${f.node.replaceAll('\\', '\\\\')}" "${f.script.replaceAll('\\', '\\\\')}" "--global" "--port" "4949"`))
  assert.deepEqual(spawned, [[f.node, [f.script, '--global', '--port', '4949'], {
    cwd: join(f.home, '.local', 'share', 'prumo'), detached: true, stdio: 'ignore', windowsHide: true,
  }]])
  assert.equal(preference(f.home).pid, 4321)
  const reenabled = await enableDashboard(options)
  assert.equal(reenabled.ok, true)
  assert.equal(preference(f.home).pid, 4321)
  assert.equal(spawned.length, 1, 're-enable reuses the proven process')
  const disabled = await disableDashboard(options)
  assert.equal(disabled.ok, true)
  assert.deepEqual(killed, [4321])
  assert.equal(existsSync(desktop), false)
})

test('foreign port ownership blocks enable without commands or process changes', async t => {
  const f = fixture(t, 'win32', { portAvailable: async () => false })
  const result = await enableDashboard(f.options)
  assert.equal(result.ok, false)
  assert.equal(result.conflict, true)
  assert.equal(f.calls.some(([, args]) => args[0] === '/Create'), false)
  assert.equal(existsSync(join(f.home, '.local', 'share', 'prumo', 'dashboard.json')), false)
})

test('health identity reuses Prumo, rejects another product, and foreground stays read-only', async t => {
  const managed = fixture(t, 'linux', {
    fetch: async () => ({ ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true, version: '1.3.0' }) }),
  })
  assert.equal((await dashboardHealth(managed.options)).state, 'running')
  const foreign = fixture(t, 'linux', {
    fetch: async () => ({ ok: true, json: async () => ({ product: 'other' }) }),
  })
  assert.equal((await dashboardHealth(foreign.options)).state, 'conflict')
  let invocation
  const code = runDashboardForeground({ ...managed.options, spawnSync(file, args, settings) { invocation = [file, args, settings]; return { status: 7 } } })
  assert.equal(code, 7)
  assert.deepEqual(invocation[1], [managed.script, '--global', '--port', '4949'])
  assert.equal(invocation[1].includes('--sync-plan'), false)
})

test('XDG disable refuses to signal an unverified process', async t => {
  let killed = false
  let running = false
  const f = fixture(t, 'linux', {
    exec: () => ({ status: 1, stdout: '' }),
    spawn: () => { running = true; return { pid: 9000 } },
    fetch: async () => {
      if (!running) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true }) }
    },
    readProcessCommand: () => ['/usr/bin/node', '/foreign/server.mjs'],
    kill: () => { killed = true },
  })
  await enableDashboard(f.options)
  const result = await disableDashboard(f.options)
  assert.equal(result.ok, false)
  assert.equal(killed, false)
  assert.equal(preference(f.home).enabled, false)
})

test('enable waits for bounded health readiness', async t => {
  let probes = 0
  let delays = 0
  const f = fixture(t, 'win32', {
    fetch: async () => {
      probes += 1
      if (probes < 3) throw new Error('starting')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true }) }
    },
    delay: async () => { delays += 1 },
  })
  const result = await enableDashboard(f.options)
  assert.equal(result.ok, true)
  assert.equal(delays, 1)
  assert.ok(probes >= 3)
})

test('enable reports stopped after bounded probes and preserves registration', async t => {
  let probes = 0
  const f = fixture(t, 'win32', {
    fetch: async () => { probes += 1; throw new Error('stopped') },
    readinessAttempts: 2,
  })
  const result = await enableDashboard(f.options)
  assert.equal(result.ok, false)
  assert.equal(result.process, 'stopped')
  assert.equal(result.registered, true)
  assert.equal(preference(f.home).enabled, true)
  assert.ok(probes >= 3)
})

test('stopped XDG startup keeps its spawned PID for a later ownership check', async t => {
  const f = fixture(t, 'linux', {
    exec: () => ({ status: 1, stdout: '' }),
    spawn: () => ({ pid: 2468 }),
    fetch: async () => { throw new Error('stopped') },
    readinessAttempts: 1,
  })
  const result = await enableDashboard(f.options)
  assert.equal(result.ok, false)
  assert.equal(result.process, 'stopped')
  assert.equal(result.registered, true)
  assert.equal(preference(f.home).pid, 2468)
})

test('enable reports a post-start port conflict and preserves registration', async t => {
  let probes = 0
  const f = fixture(t, 'win32', {
    fetch: async () => {
      probes += 1
      if (probes === 1) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'another-product' }) }
    },
  })
  const result = await enableDashboard(f.options)
  assert.equal(result.ok, false)
  assert.equal(result.conflict, true)
  assert.equal(result.registered, true)
  assert.equal(preference(f.home).enabled, true)
})

test('XDG recovers and persists a login-started process with the exact command', async t => {
  const f = fixture(t, 'linux', {
    exec: () => ({ status: 1, stdout: '' }),
    fetch: async () => ({ ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true }) }),
    listProcessIds: () => [111, 7654],
    readProcessCommand(pid) {
      return pid === 7654 ? [f.node, f.script, '--global', '--port', '4949'] : ['/usr/bin/node', '/tmp/other.mjs']
    },
  })
  const result = await enableDashboard(f.options)
  assert.equal(result.ok, true)
  assert.equal(preference(f.home).pid, 7654)
})

test('XDG refuses a PID whose command has the managed argv plus extra arguments', async t => {
  let exact = true
  let running = false
  const killed = []
  const f = fixture(t, 'linux', {
    exec: () => ({ status: 1, stdout: '' }),
    spawn: () => { running = true; return { pid: 9876 } },
    fetch: async () => {
      if (!running) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true }) }
    },
    readProcessCommand: () => [
      f.node, f.script, '--global', '--port', '4949',
      ...(exact ? [] : ['--sync-plan']),
    ],
    kill(pid) { killed.push(pid); running = false },
  })

  assert.equal((await enableDashboard(f.options)).ok, true)
  exact = false
  const result = await disableDashboard(f.options)
  assert.equal(result.ok, false)
  assert.deepEqual(killed, [])
})

test('Linux keeps the persisted systemd or XDG mechanism when detection changes', async t => {
  let systemdAvailable = true
  let systemdRunning = false
  const systemd = fixture(t, 'linux', {
    exec(file, args) {
      systemd.calls.push([file, args])
      if (file === 'systemctl' && args[1] === 'show-environment') return { status: systemdAvailable ? 0 : 1, stdout: '' }
      if (file === 'systemctl' && args.join(' ') === '--user enable --now prumo-dashboard.service') systemdRunning = true
      if (file === 'systemctl' && args.join(' ') === '--user disable --now prumo-dashboard.service') systemdRunning = false
      return { status: 0, stdout: '' }
    },
    fetch: async () => {
      if (!systemdRunning) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true }) }
    },
  })

  await enableDashboard(systemd.options)
  systemdAvailable = false
  assert.equal((await dashboardStatus(systemd.options)).mechanism, 'systemd')
  await disableDashboard(systemd.options)
  assert.equal(systemd.calls.filter(([file, args]) => file === 'systemctl' && args[1] === 'show-environment').length, 1)
  assert.equal(existsSync(join(systemd.home, '.config', 'autostart', 'prumo-dashboard.desktop')), false)

  let xdgSystemdAvailable = false
  let xdgRunning = false
  const killed = []
  const xdg = fixture(t, 'linux', {
    exec(file, args) {
      xdg.calls.push([file, args])
      if (file === 'systemctl' && args[1] === 'show-environment') return { status: xdgSystemdAvailable ? 0 : 1, stdout: '' }
      return { status: 0, stdout: '' }
    },
    spawn: () => { xdgRunning = true; return { pid: 6789 } },
    fetch: async () => {
      if (!xdgRunning) throw new Error('stopped')
      return { ok: true, json: async () => ({ product: 'prumo', mode: 'global', readOnly: true }) }
    },
    readProcessCommand: () => [xdg.node, xdg.script, '--global', '--port', '4949'],
    kill(pid) { killed.push(pid); xdgRunning = false },
  })

  await enableDashboard(xdg.options)
  xdgSystemdAvailable = true
  assert.equal((await dashboardStatus(xdg.options)).mechanism, 'xdg')
  await disableDashboard(xdg.options)
  assert.deepEqual(killed, [6789])
  assert.equal(xdg.calls.filter(([file, args]) => file === 'systemctl' && args[1] === 'show-environment').length, 1)
  assert.equal(existsSync(join(xdg.home, '.config', 'systemd', 'user', 'prumo-dashboard.service')), false)
})
