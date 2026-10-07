import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidateVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version
const historicalTags = ['v1.0.0', 'v1.0.1']

function put(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}

function npmCommand(args, env, cwd, message) {
  const command = process.platform === 'win32'
    ? [env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]]
    : ['npm', args]
  const result = spawnSync(command[0], command[1], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${message}\n${result.stdout}${result.stderr}`)
  return result.stdout
}

function assertDistributedArchive(archive, label) {
  const result = spawnSync('tar', ['-tf', archive], { encoding: 'utf8', timeout: 60000, windowsHide: true })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const entries = result.stdout.split(/\r?\n/).filter(Boolean)
  assert.equal(entries.some(name => /(^|\/)test\//.test(name) || /\.test\.mjs$/.test(name) || /-smoke\.mjs$/.test(name)), false, label)
  assert.ok(entries.some(name => /(^|\/)bin\/prumo\.mjs$/.test(name)), label)
  assert.ok(entries.some(name => /(^|\/)lib\/install\.mjs$/.test(name)), label)
}

function command(file, args, env, cwd, message) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${message}\n${result.stdout}${result.stderr}`)
  return result.stdout
}

function packageRoot(prefix, name) {
  const modules = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib', ...(process.platform === 'win32' ? [] : ['node_modules']))
  return name.startsWith('@') ? join(modules, ...name.split('/')) : join(modules, name)
}

function packTag(tag, work, env) {
  const source = join(work, `source-${tag}`)
  const archiveSource = join(work, `source-${tag}.tar`)
  const output = join(work, `package-${tag}`)
  mkdirSync(source, { recursive: true })
  mkdirSync(output, { recursive: true })
  const archived = spawnSync('git', ['archive', '--format=tar', '-o', archiveSource, tag], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  })
  assert.ifError(archived.error)
  assert.equal(archived.status, 0, archived.stdout + archived.stderr)
  const extracted = spawnSync('tar', ['-xf', `source-${tag}.tar`, '-C', `source-${tag}`], {
    cwd: work,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  })
  assert.ifError(extracted.error)
  assert.equal(extracted.status, 0, extracted.stdout + extracted.stderr)
  npmCommand(['pack', '--ignore-scripts', '--pack-destination', output, '--loglevel=error'], env, source, `empacotamento de ${tag}`)
  const archives = readdirSync(output).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1, `o empacotamento de ${tag} deve produzir um único arquivo`)
  assertDistributedArchive(join(output, archives[0]), `o pacote ${tag} deve conter somente arquivos distribuídos`)
  return join(output, archives[0])
}

function fileSnapshot(root, names) {
  return Object.fromEntries(names.map(name => [name, readFileSync(join(root, name))]))
}

function assertSnapshot(root, snapshot) {
  for (const [name, bytes] of Object.entries(snapshot)) assert.deepEqual(readFileSync(join(root, name)), bytes, name)
}

function harnessRoot(home, harness) {
  return harness === 'codex' ? join(home, '.agents', 'skills') : join(home, `.${harness}`, 'skills')
}

test('v1.0.0 e v1.0.1 chegam à candidata por reinstalação local e preservam seus dados', {
  timeout: 1800000,
  skip: process.env.PRUMO_TEST_GIT_RELEASES === '1' ? false
    : 'v1.0.0 e v1.0.1 são versões apenas do Git; o escopo padrão cobre publicações npm. Use PRUMO_TEST_GIT_RELEASES=1 para executar.',
}, t => {
  const base = realpathSync(tmpdir())
  const work = mkdtempSync(join(base, 'prumo-reinstall-historical-'))
  const candidateOutput = join(work, 'candidate')
  mkdirSync(candidateOutput, { recursive: true })
  const candidateEnv = { ...process.env, HOME: join(work, 'candidate-home'), USERPROFILE: join(work, 'candidate-home'),
    npm_config_cache: join(work, 'candidate-cache'), npm_config_userconfig: join(work, 'candidate-npmrc') }
  for (const key of Object.keys(candidateEnv)) if (/^npm_config_(registry|userconfig|prefix|cache)$/i.test(key) ||
    ['NPM_TOKEN', 'NODE_AUTH_TOKEN'].includes(key)) delete candidateEnv[key]
  candidateEnv.npm_config_cache = join(work, 'candidate-cache')
  candidateEnv.npm_config_userconfig = join(work, 'candidate-npmrc')
  npmCommand(['pack', '--ignore-scripts', '--pack-destination', candidateOutput, '--loglevel=error'], candidateEnv, repository, 'empacotamento da candidata atual')
  const candidateArchives = readdirSync(candidateOutput).filter(name => name.endsWith('.tgz'))
  assert.equal(candidateArchives.length, 1)
  assertDistributedArchive(join(candidateOutput, candidateArchives[0]), 'o pacote candidato deve conter somente arquivos distribuídos')
  const candidateArchive = join(candidateOutput, candidateArchives[0])

  t.after(() => {
    assert.ok(work.startsWith(join(base, 'prumo-reinstall-historical-')))
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  for (const tag of historicalTags) {
    const home = mkdtempSync(join(base, `prumo-reinstall-${tag.slice(1).replaceAll('.', '-')}-`))
    const project = join(home, 'project')
    const prefix = join(home, 'npm-prefix')
    const cache = join(home, 'npm-cache')
    const userConfig = join(home, 'npmrc')
    const legacyHome = join(home, '.local', 'share', 'graph-foreman')
    const legacyRoot = join(legacyHome, 'legacy')
    const pureRoot = join(project, 'pure-workspace')
    t.after(() => {
      assert.ok(home.startsWith(join(base, `prumo-reinstall-${tag.slice(1).replaceAll('.', '-')}-`)))
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    })
    mkdirSync(join(project, '.git'), { recursive: true })
    mkdirSync(legacyRoot, { recursive: true })
    mkdirSync(join(pureRoot, '.specs', 'graph', 'pure'), { recursive: true })
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      KIRO_HOME: join(home, '.kiro'),
      CODEX_HOME: join(home, '.codex'),
      DSH_HOME: join(home, '.dsh'),
      GROK_HOME: join(home, '.grok'),
      OPENCODE_CONFIG_DIR: join(home, '.opencode'),
      XDG_CONFIG_HOME: join(home, '.config'),
      PRUMO_LANG: 'en',
      npm_config_prefix: prefix,
      npm_config_cache: cache,
      npm_config_userconfig: userConfig,
    }
    for (const key of Object.keys(env)) {
      if (/^npm_config_(registry|userconfig|prefix|cache)$/i.test(key) || ['NPM_TOKEN', 'NODE_AUTH_TOKEN'].includes(key)) delete env[key]
    }
    env.npm_config_prefix = prefix
    env.npm_config_cache = cache
    env.npm_config_userconfig = userConfig
    for (const key of ['PRUMO_HOME', 'PRUMO_ROOT', 'GRAPH_ROOT', 'GRAPH_FOREMAN_HOME', 'NODE_OPTIONS']) delete env[key]
    // A coleta herda somente o preload aprovado, sem reintroduzir opções do ambiente do usuário.
    if (process.env.NODE_V8_COVERAGE && process.env.PRUMO_TEST_COVERAGE_FLUSH === '1')
      env.NODE_OPTIONS = `--import="${new URL('./fixtures/coverage-flush.mjs', import.meta.url).href}"`
    put(join(home, '.local', 'share', 'prumo', 'dashboard.json'), {
      enabled: false,
      mechanism: process.platform === 'win32' ? 'windows-startup' : process.platform === 'darwin' ? 'launchd' : 'xdg',
    })

    put(join(home, '.claude', 'settings.json'), { permissions: { deny: ['Read(secret)'] } })
    put(join(home, '.kiro', 'steering', 'user.md'), 'Instrução Kiro que pertence ao usuário.\n')
    put(join(home, '.codex', 'config.toml'), '# Configuração Codex que pertence ao usuário.\n')
    put(join(home, '.codex', 'AGENTS.override.md'), 'prefixo do usuário\n\n<!-- po-first:start -->\nbloco antigo\n<!-- po-first:end -->\nsufixo do usuário\n')

    const plan = join(project, 'legacy.plan.json')
    put(plan, { name: 'Dados históricos', tasks: [{ id: 'T1', title: 'Preservar histórico', validation: 'Inspecionar o histórico' }] })
    const oldArchive = packTag(tag, work, env)
    npmCommand(['install', '--global', '--force', '--ignore-scripts', '--no-audit', '--no-fund', oldArchive], env, project, `instalação histórica de ${tag}`)
    const oldPackage = JSON.parse(readFileSync(join(packageRoot(prefix, tag === 'v1.0.0' ? 'prumo' : '@henri-ralmeida/prumo'), 'package.json'), 'utf8'))
    assert.equal(oldPackage.version, tag.slice(1))
    const oldRoot = packageRoot(prefix, oldPackage.name)
    command(join(oldRoot, 'bin', 'prumo.mjs'), ['install', '--claude', '--lang', 'en'], env, project, `${tag} instala Claude`)
    command(join(oldRoot, 'bin', 'prumo.mjs'), ['install', '--kiro', '--lang', 'en'], env, project, `${tag} instala Kiro`)
    command(join(oldRoot, 'bin', 'prumo.mjs'), ['install', '--codex', '--lang', 'en'], env, project, `${tag} instala Codex`)

    const oldEngine = join(oldRoot, 'scripts', 'engine.mjs')
    const oldEngineEnv = { ...env, PRUMO_ROOT: legacyRoot }
    command(oldEngine, ['init', '--plan', plan, '--run', 'legacy'], oldEngineEnv, project, `${tag} cria o run histórico`)
    put(join(legacyRoot, 'approved.plan.json'), readFileSync(plan))
    put(join(legacyRoot, 'custom.txt'), 'Conteúdo criado pelo usuário na instalação histórica.\n')
    put(join(legacyRoot, 'backups', 'durable.txt'), 'Backup durável da instalação histórica.\n')
    put(join(pureRoot, '.specs', 'graph', 'pure', 'state.json'), '{"pureGraphForeman":true}\n')
    put(join(pureRoot, '.specs', 'graph', 'pure', 'events.ndjson'), '{"type":"pure_graph_foreman"}\n')
    put(join(pureRoot, 'pure.plan.json'), 'Plano graph-foreman sem marcador do Prumo.\n')
    assert.equal(existsSync(join(legacyRoot, '.specs', 'graph', 'legacy', 'state.json')), true)
    assert.equal(existsSync(join(home, '.local', 'share', 'prumo', 'legacy', '.specs', 'graph')), false)

    const preservedData = fileSnapshot(legacyRoot, [
      join('.specs', 'graph', 'legacy', 'state.json'),
      join('.specs', 'graph', 'legacy', 'events.ndjson'),
      'approved.plan.json',
      'custom.txt',
      join('backups', 'durable.txt'),
    ])
    const pureData = fileSnapshot(pureRoot, [
      join('.specs', 'graph', 'pure', 'state.json'),
      join('.specs', 'graph', 'pure', 'events.ndjson'),
      'pure.plan.json',
    ])
    const configBefore = {
      claude: readFileSync(join(home, '.claude', 'settings.json')),
      kiro: readFileSync(join(home, '.kiro', 'steering', 'user.md')),
      codex: readFileSync(join(home, '.codex', 'config.toml')),
    }
    for (const harness of ['claude', 'kiro', 'codex']) {
      const marker = JSON.parse(readFileSync(join(harnessRoot(home, harness), 'prumo', '.prumo-install.json'), 'utf8'))
      assert.equal(marker.product, 'prumo')
      assert.equal(marker.version, tag.slice(1))
    }

    npmCommand(['install', '--global', '--force', '--ignore-scripts', '--no-audit', '--no-fund', candidateArchive], env, project, `reinstalação da candidata sobre ${tag}`)
    const candidatePackage = packageRoot(prefix, '@henri-ralmeida/prumo')
    assert.equal(JSON.parse(readFileSync(join(candidatePackage, 'package.json'), 'utf8')).version, candidateVersion)
    for (const harness of ['claude', 'kiro', 'codex']) {
      command(join(candidatePackage, 'bin', 'prumo.mjs'), ['install', `--${harness}`, '--lang', 'en'], env, project, `candidata instala ${harness} sobre ${tag}`)
      const markerPath = join(harnessRoot(home, harness), 'prumo', '.prumo-install.json')
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      assert.equal(marker.product, 'prumo')
      assert.equal(marker.harness, harness)
      assert.equal(marker.version, candidateVersion)
      assert.deepEqual(readFileSync(join(harnessRoot(home, harness), 'prumo', 'scripts', 'engine.mjs')), readFileSync(join(repository, 'scripts', 'engine.mjs')))
    }

    const migratedRoot = join(home, '.local', 'share', 'prumo', 'legacy')
    assertSnapshot(migratedRoot, preservedData)
    assertSnapshot(legacyRoot, preservedData)
    assertSnapshot(pureRoot, pureData)
    assert.equal(existsSync(join(home, '.local', 'share', 'prumo', 'pure-workspace')), false)
    assert.deepEqual(readFileSync(join(home, '.claude', 'settings.json')), configBefore.claude)
    assert.deepEqual(readFileSync(join(home, '.kiro', 'steering', 'user.md')), configBefore.kiro)
    assert.deepEqual(readFileSync(join(home, '.codex', 'config.toml')), configBefore.codex)
    const override = readFileSync(join(home, '.codex', 'AGENTS.override.md'), 'utf8')
    assert.match(override, /^prefixo do usuário/)
    assert.match(override, /sufixo do usuário\n$/)
    assert.equal(existsSync(join(home, '.local', 'share', 'graph-foreman', 'pure-workspace')), false)
    assert.equal(existsSync(join(home, '.local', 'share', 'graph-foreman', 'legacy')), true)
  }
})
