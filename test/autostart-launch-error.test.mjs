import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const autostartUrl = pathToFileURL(join(root, 'lib', 'autostart.mjs')).href
const dashboardScript = join(root, 'scripts', 'serve.mjs')

function launchInIsolatedProcess(t, action) {
  const home = mkdtempSync(join(tmpdir(), 'prumo-autostart-launch-error-'))
  const preferencePath = join(home, '.local', 'share', 'prumo', 'dashboard.json')
  if (action === 'restartDashboard') {
    mkdirSync(dirname(preferencePath), { recursive: true })
    writeFileSync(preferencePath, JSON.stringify({ enabled: true, mechanism: 'windows-startup' }))
  }

  t.after(() => {
    const tempRoot = resolve(tmpdir())
    const absoluteHome = resolve(home)
    const childPath = relative(tempRoot, absoluteHome)
    assert.ok(childPath && childPath !== '..' && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath),
      'o diretório isolado deve permanecer dentro da pasta temporária')
    rmSync(absoluteHome, { recursive: true, force: true })
  })

  const source = `
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ${action} } from ${JSON.stringify(autostartUrl)}

const home = ${JSON.stringify(home)}
const options = {
  platform: 'win32',
  home,
  node: join(home, 'missing-node.exe'),
  script: ${JSON.stringify(dashboardScript)},
  version: '2.3.2',
  contentId: 'probe',
  lang: 'en',
  env: {},
  readinessAttempts: 1,
  fetch: async () => { throw new Error('dashboard unavailable') },
  portAvailable: async () => true,
  exec: () => ({ status: 1, stdout: '' }),
  delay: async () => {},
}
const result = await ${action}(options)
const preference = JSON.parse(readFileSync(join(home, '.local', 'share', 'prumo', 'dashboard.json'), 'utf8'))
process.stdout.write(JSON.stringify({ result, preference }))
`

  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') },
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  })
}

function assertLaunchFailureIsReported(child) {
  const diagnostic = `${child.stdout ?? ''}\n${child.stderr ?? ''}`
  assert.equal(child.status, 0, `o processo chamador deve sobreviver ao erro de inicialização:\n${diagnostic}`)
  assert.doesNotMatch(child.stderr, /Unhandled 'error' event|Emitted 'error' event on ChildProcess/i)
  const output = JSON.parse(child.stdout)
  assert.equal(output.result.ok, false)
  assert.match(output.result.error, /Startup process failed:.*ENOENT/s)
  assert.equal(output.preference.enabled, true, 'a preferência de ativação deve permanecer salva após a falha')
  assert.equal(output.preference.mechanism, 'windows-startup')
}

test('enable informa falha ao iniciar o dashboard sem encerrar o comando e preserva a ativação', t => {
  assertLaunchFailureIsReported(launchInIsolatedProcess(t, 'enableDashboard'))
})

test('restart informa falha ao iniciar o dashboard sem encerrar o comando e preserva a ativação', t => {
  assertLaunchFailureIsReported(launchInIsolatedProcess(t, 'restartDashboard'))
})
