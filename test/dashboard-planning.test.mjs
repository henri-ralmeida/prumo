import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGuideDemoData } from '../scripts/dashboard-guide-demo.mjs'
import { rejectionCases } from './fixtures/review-rejection.mjs'
import { messages } from '../scripts/i18n.mjs'
import { plannedManualInspectionState } from './fixtures/planned-manual-inspection.mjs'
import { disableDashboardBoot, extractDashboardScript, injectDashboardLanguage, runDashboardScript } from './fixtures/dashboard-vm.mjs'

const html = readFileSync(new URL('../scripts/dashboard.html', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const canonicalScript = extractDashboardScript(html)
const releaseCatalog = JSON.parse(readFileSync(new URL('../scripts/release-notes.json', import.meta.url), 'utf8'))

test('agrupamentos do board distinguem pré-requisitos pendentes das tarefas que eles liberam', () => {
  const ui = dashboard('pt-BR')
  const state = graphState(6, 1)
  for (const [id, value, deps] of [['T001', 'planning', []], ['T002', 'waiting', ['T001', 'T005']],
    ['T003', 'blocked', ['T002']], ['T004', 'done', ['T002']], ['T005', 'done', []], ['T006', 'skipped', ['T002']]]) {
    state.tasks[id].state = value; state.tasks[id].deps = deps; state.derived[id].effective = value
  }
  ui.render(state)
  assert.deepEqual([...ui.run("filterSets(STATE.tasks, 'dependencies').matches")], ['T001', 'T002'])
  assert.deepEqual([...ui.run("filterSets(STATE.tasks, 'unlocks').matches")], ['T002', 'T003'])
  ui.run("setFilter('dependencies')")
  assert.equal(ui.filterOptions.find(option => option.dataset.filterValue === 'dependencies').getAttribute('aria-pressed'), 'true')
  const before = structuredClone(state)
  ui.run("POP = {id:'T002', pinned:true}; fillPop('T002')")
  let body = ui.nodes.get('#popBody').innerHTML
  assert.match(body, /Pendências · 1/)
  assert.match(body, /Liberações · 1/)
  assert.match(body, /data-st="planning"/)
  assert.match(body, /data-st="blocked"/)
  ui.nodes.get('#popBody').scrollTop = 100
  ui.run("setRelationFilter('dependencies')")
  assert.equal(ui.nodes.get('#popBody').scrollTop, 100)
  body = ui.nodes.get('#popBody').innerHTML
  assert.match(body, /class="relation-group dependencies"/)
  assert.doesNotMatch(body, /class="relation-group unlocks"/)
  ui.run("setRelationFilter('unlocks')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /class="relation-group unlocks"/)
  ui.run("setRelationFilter('invalid'); POP = null; setRelationFilter('all')")
  assert.deepEqual(state, before, 'os agrupamentos alteram apenas a visualização')
})

test('grupos vazios e referências ausentes permanecem legíveis nos dois idiomas', () => {
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang), state = graphState(1, 1)
    state.tasks.T001.deps = ['T-ausente']
    ui.render(state)
    ui.run("POP = {id:'T001', pinned:true}; fillPop('T001')")
    assert.match(ui.nodes.get('#popBody').innerHTML, /T-ausente/)
    assert.ok(ui.nodes.get('#popBody').innerHTML.includes(lang === 'en' ? 'No pending tasks in this group' : 'Nenhuma tarefa pendente neste grupo'))
    assert.equal(ui.run("filterSets(STATE.tasks, 'dependencies').matches.size"), 0)
    ui.run("POP_EXPANDED = true; setRelationFilter('all')")
    assert.match(ui.nodes.get('#popBody').innerHTML, /relation-group/)
  }
})

test('seletor sem planos abre apenas o guia e remove o exemplo ao aparecer o primeiro plano real', () => {
  let opens = 0
  const navigation = {state:null, urls:[]}
  const ui = dashboard('pt-BR', 1000, new Map(), navigation, {full:true})
  ui.run('ONBOARDING.open = openGuide', {openGuide(){opens++}})
  ui.run('updateRunSelect({runs:[]})')
  assert.equal(ui.nodes.get('#runName').textContent, 'sem-plano-verificar-guia-01')
  assert.match(ui.nodes.get('#runOptions').innerHTML, /__guide__/)
  ui.render({empty:true, plan:{name:'', phases:[]}, tasks:{}, derived:{}})
  assert.equal(ui.nodes.get('#runLabel').textContent, 'Exemplo do guia — nenhum plano real')
  assert.equal(ui.run('document.title'), 'sem-plano-verificar-guia-01 - prumo')
  ui.run("selectRun('__guide__')")
  assert.equal(opens, 1)
  assert.equal(navigation.urls.length, 0)
  const catalog = {currentRoot:'r1', current:'real-01', runs:[{root:'r1', run:'real-01', plan:'Plano real', taskCount:1}]}
  ui.run('updateRunSelect(catalog)', {catalog})
  assert.equal(ui.nodes.get('#runName').textContent, 'real-01')
  assert.doesNotMatch(ui.nodes.get('#runOptions').innerHTML, /sem-plano-verificar-guia-01|__guide__/)
  assert.deepEqual(catalog.runs.map(entry=>entry.run), ['real-01'])
  const realState = graphState(1, 1)
  realState.run = 'real-01'; realState.plan.name = 'Plano real'
  ui.render(realState)
  assert.equal(ui.nodes.get('#runLabel').dataset.i18nTitle, 'Plano real')
})

test('resposta obsoleta não substitui o plano recém-chegado ao seletor', async () => {
  const ui = dashboard('pt-BR')
  const catalog = {currentRoot:'r', current:'real', runs:[{root:'r', run:'real'}]}
  const stale = {run:'outro', plan:{phases:[]}, tasks:{}, derived:{}}
  ui.run('STATE = null')
  await ui.run('tick()', {fetch: async url => {
    const name = typeof url === 'string' ? url : url.pathname
    assert.ok(['/api/runs','/api/state'].includes(name), 'uma resposta obsoleta não carrega histórico de outro plano')
    return {ok:true, json:async()=>name === '/api/runs' ? catalog : stale}
  }})
  assert.equal(ui.run('STATE'), null)
  assert.equal(ui.nodes.get('#runName').textContent, 'real')
})

test('catálogo parcial ou aba vazia com planos reais não insere um exemplo artificial', () => {
  const ui = dashboard('en')
  ui.run("STATE = null; setFilter('dependencies')")
  const catalog = {runs:[{root:'r', run:'real'}]}
  ui.run('updateRunSelect(catalog)', {catalog})
  assert.match(ui.nodes.get('#runOptions').innerHTML, /r\/real/)
  assert.doesNotMatch(ui.nodes.get('#runOptions').innerHTML, /__guide__/)
  ui.run("STATE = {}; STATE_RUN_KEY = '\\0'; updateRunSelect(catalog)", {catalog})
  const completed = {currentRoot:'r', current:'real', runs:[{root:'r', run:'real', complete:true}]}
  ui.run("updateRunSelect(completed); toggleRunFilter('progress')", {completed})
  assert.match(ui.nodes.get('#runOptions').innerHTML, /No plans in progress/)
  assert.doesNotMatch(ui.nodes.get('#runOptions').innerHTML, /__guide__/)
})

test('versão abre todo o changelog no idioma selecionado e evita abrir duas janelas', async () => {
  const history = Object.entries(releaseCatalog).map(([version, notes]) => ({ version, sections: notes.en }))
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    ui.run("$('#changelogDialog'); $('#changelogContent')")
    const dialog = ui.nodes.get('#changelogDialog')
    let opens = 0, calls = 0
    dialog.showModal = () => { opens++; dialog.open = true }
    const fetch = async url => { calls++; assert.equal(url, '/api/changelog'); return { ok: true, json: async () => history } }
    await ui.run('openChangelog()', { fetch })
    await ui.run('openChangelog()', { fetch })
    assert.equal(opens, 1)
    assert.equal(calls, 1)
    const body = ui.nodes.get('#changelogContent').innerHTML
    assert.equal((body.match(/<article>/g) ?? []).length, history.length)
    for (const release of history) {
      assert.ok(body.includes(`v${release.version}`))
      for (const section of release.sections) {
        if (lang === 'pt-BR') {
          assert.ok(Object.hasOwn(messages, section.title), `Tradução do título: ${section.title}`)
          for (const item of section.items) assert.ok(Object.hasOwn(messages, item), `Tradução da alteração: ${item}`)
        }
        assert.ok(body.includes(ui.run(`esc(tr(${JSON.stringify(section.title)}))`)))
        for (const item of section.items) assert.ok(body.includes(ui.run(`esc(tr(${JSON.stringify(item)}))`)))
      }
    }
    assert.equal(ui.run("tr('Changelog')"), lang === 'en' ? 'Changelog' : 'Histórico de alterações')
  }
  assert.match(html, /<button[^>]*id="identity"[^>]*onclick="openChangelog\(\)"/)
  assert.match(html, /<dialog id="changelogDialog" aria-labelledby="changelogTitle">/)
})

test('changelog informa falha, permite tentar novamente e escapa o texto das notas', async () => {
  const ui = dashboard('pt-BR')
  ui.run("$('#changelogDialog'); $('#changelogContent')")
  const dialog = ui.nodes.get('#changelogDialog'), content = ui.nodes.get('#changelogContent')
  dialog.showModal = () => { dialog.open = true }
  for (const fetch of [async () => { throw new Error('offline') }, async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new Error('JSON inválido') } })]) {
    dialog.open = false
    await ui.run('openChangelog()', { fetch })
    assert.equal(content.textContent, 'Não foi possível carregar o histórico. Feche e tente novamente.')
  }
  dialog.open = false
  await ui.run('openChangelog()', { fetch: async () => ({ ok: true, json: async () => [] }) })
  assert.equal(content.textContent, 'Nenhum histórico de alterações disponível')
  dialog.open = false
  await ui.run('openChangelog()', { fetch: async () => ({ ok: true, json: async () => [{
    version: '<img>', sections: [{ title: '<script>', items: ['<img src=x onerror=alert(1)>'] }],
  }] }) })
  assert.doesNotMatch(content.innerHTML, /<img|<script/)
  assert.match(content.innerHTML, /&lt;img/)
})
const instant = (seconds) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString()
const task = (id, state = 'pending', fields = {}) => ({
  id, title: `Task ${id}`, phase: 'P1', state, deps: [], attempts: [], validations: [], notes: [], ...fields,
})

test('resumo aplica o limite compartilhado a todos os papéis e acompanha a alteração do board', () => {
  const ui = dashboard('pt-BR')
  const roles = ['discussing', 'planning', 'running', 'reviewing']
  const state = { run: 'limite-compartilhado', plan: { maxAgents: 6 }, agentUsage: { used: 4, maxAgents: 6 },
    tasks: Object.fromEntries(roles.map((role, i) => ['T' + (i + 1), task('T' + (i + 1), role)])),
    derived: Object.fromEntries(roles.map((effective, i) => ['T' + (i + 1), { effective }])) }
  const labels = ['Discutindo', 'Planejando', 'Executando', 'Revisando']
  ui.render(state)
  assert.equal(ui.nodes.get('#agentUsageLabel').textContent, 'Agentes: 4 de 6 em uso')
  for (const label of labels) assert.ok(ui.nodes.get('#counts').innerHTML.includes(label + '</span> <b>1/6</b>'))
  state.agentUsage.maxAgents = 2
  ui.render(state)
  assert.equal(ui.nodes.get('#agentUsageLabel').textContent, 'Agentes: 4 de 2 em uso', 'reduzir o limite preserva os agentes atuais')
  for (const label of labels) assert.ok(ui.nodes.get('#counts').innerHTML.includes(label + '</span> <b>1/2</b>'))
  for (const entry of Object.values(state.derived)) entry.effective = 'waiting'
  state.agentUsage.used = 0
  ui.render(state)
  for (const label of labels) assert.ok(ui.nodes.get('#counts').innerHTML.includes(label + '</span> <b>0/2</b>'))
})

test('controle de agentes mostra a ocupação do motor e mantém o valor digitado enquanto está aberto', () => {
  const ui = dashboard('pt-BR')
  const state = { run: 'limite', plan: { maxAgents: 3 }, agentControlToken: 'token', agentUsage: { used: 2, maxAgents: 3 }, tasks: {
    T1: task('T1'), T2: task('T2'), T3: task('T3'),
  }, phaseWorkflows: { P1: { state: 'planning', planningAttempts: [{ activityTiming: 'explicit', workers: {
    T1: { agent: 'planejador-a', role: 'planning', startedAt: instant(90), activityTiming: 'explicit', activityIntervals: [] },
    T2: { agent: 'planejador-b', role: 'planning', startedAt: instant(90), activityTiming: 'explicit', activityIntervals: [] },
  }, activeTargets: ['T1', 'T2'], queuedTargets: ['T3'], targets: ['T1', 'T2', 'T3'] }] } }, derived: {
    T1: { effective: 'planning', activeAgent: 'planejador-a' }, T2: { effective: 'planning', activeAgent: 'planejador-b' },
    T3: { effective: 'waiting', agentQueued: true },
  } }
  ui.render(state)
  assert.equal(ui.nodes.get('#agentLimitMenu').hidden, false)
  assert.equal(ui.nodes.get('#agentUsageLabel').textContent, 'Agentes: 2 de 3 em uso')
  assert.equal(ui.nodes.get('#agentLimitValue').value, '3')
  assert.match(ui.nodes.get('#parallel').innerHTML, /@planejador-a[\s\S]*@planejador-b/)
  assert.match(ui.nodes.get('#planSub').textContent, /2 tarefas/)
  assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML, /T3/)
  assert.match(ui.nodes.get('#nodes').innerHTML, /Aguardando uma vaga de agente/)
  assert.equal(ui.run('analyse(STATE).stageElapsed'), 20000)
  assert.equal(ui.run('taskClock(STATE.tasks.T1, "planning")'), 10000)
  ui.nodes.get('#agentLimitMenu').open = true
  ui.nodes.get('#agentLimitValue').value = '5'
  ui.render(state)
  assert.equal(ui.nodes.get('#agentLimitValue').value, '5')
  state.derived.T1 = { effective: 'waiting', phaseBatchPending: true }
  state.phaseWorkflows.P1.planningAttempts[0].workers.T1.endedAt = instant(100)
  state.phaseWorkflows.P1.planningAttempts[0].activeTargets = ['T2']
  state.agentUsage.used = 1
  ui.render(state)
  assert.match(ui.nodes.get('#nodes').innerHTML, /Aguardando os demais alvos da fase/)
  assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML, /@planejador-a/)
  assert.equal(ui.nodes.get('#agentUsageLabel').textContent, 'Agentes: 1 de 3 em uso')
  assert.match(ui.nodes.get('#planSub').textContent, /1 tarefas/)
  state.tasks.T1 = task('T1', 'planning', { individualPlanning: true, planner: 'planejador-individual', planningAttempts: [{
    startedAt: instant(95), activityTiming: 'explicit', activityIntervals: [{ role: 'planning', startedAt: instant(95) }],
  }] })
  state.derived.T1 = { effective: 'planning' }
  state.agentUsage.used = 2
  ui.render(state)
  assert.equal(ui.run('taskClock(STATE.tasks.T1, "planning")'), 5000)
  assert.match(ui.nodes.get('#parallel').innerHTML, /@planejador-individual/)
  assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML, /@planejador-a/)
  // Fases históricas sem rodada de planejamento continuam renderizáveis.
  state.phaseWorkflows.P1.planningAttempts = []
  state.phaseWorkflows.P1.discussionAttempts = [{ targets: ['T2'] }]
  ui.render(state)
  assert.match(ui.nodes.get('#nodes').innerHTML, /T2/)
  delete state.agentControlToken
  ui.render(state)
  assert.equal(ui.nodes.get('#agentLimitMenu').hidden, true)
})

test('controle de agentes envia somente o limite escolhido e informa sucesso ou falha sem trocar de execução', async () => {
  const ui = dashboard('pt-BR'), requests = []
  ui.render({ run: 'limite', plan: {}, tasks: {}, agentControlToken: 'token' })
  ui.run('STATE_RUN_KEY = "run-a"; tick = async () => {}')
  for (const value of ['', '0', '-1', '1.5', 'invalid']) {
    ui.nodes.get('#agentLimitValue').value = value
    await ui.run('changeAgentLimit({preventDefault(){}})')
    assert.equal(ui.nodes.get('#agentLimitFeedback').textContent, 'Informe um número inteiro maior que zero')
  }
  ui.nodes.get('#agentLimitValue').value = '5'
  ui.run('fetch = handler', { handler: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ maxAgents: 5 }) } } })
  await ui.run('changeAgentLimit({preventDefault(){}})')
  assert.equal(requests.length, 1)
  assert.match(String(requests[0].url), /\/api\/agent-limit/)
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.headers['X-Prumo-Control'], 'token')
  assert.deepEqual(JSON.parse(requests[0].options.body), { maxAgents: 5 })
  assert.equal(ui.nodes.get('#agentLimitFeedback').textContent, 'Limite de agentes salvo')
  for (const result of [{ ok: false, error: 'Capacidade indisponível' }, { ok: false }, { throws: true }]) {
    ui.run('fetch = handler', { handler: async () => {
      if (result.throws) throw new Error('Conexão interrompida')
      return { ok: result.ok, json: async () => result }
    } })
    await ui.run('changeAgentLimit({preventDefault(){}})')
    assert.equal(ui.nodes.get('#agentLimitApply').disabled, false)
    assert.equal(ui.nodes.get('#agentLimitFeedback').textContent, result.error || (result.throws ? 'Conexão interrompida' : 'Não foi possível alterar o limite de agentes'))
  }
  ui.run('fetch = async () => {STATE_RUN_KEY = "run-b"; return {ok:true,json:async()=>({})}}')
  await ui.run('changeAgentLimit({preventDefault(){}})')
  assert.notEqual(ui.nodes.get('#agentLimitFeedback').textContent, 'Limite de agentes salvo')
  ui.run('STATE_RUN_KEY = "run-a"; fetch = async () => {STATE_RUN_KEY = "run-b"; throw Error("old run error")}')
  await ui.run('changeAgentLimit({preventDefault(){}})')
  assert.notEqual(ui.nodes.get('#agentLimitFeedback').textContent, 'old run error')
})

test('condições de execução explicam liberação e espera sem substituir resumo, contrato ou estado', () => {
  const ui = dashboard('en')
  const value = task('T1', 'ready', { summary: 'Preserve summary', validation: 'echo contract',
    writeScope: 'files', touches: ['src/orders.mjs'], sharedResources: [{ id: 'orders-db', access: 'write' }],
    executionReadiness: { ready: true, reasons: [] } })
  const state = { run: 'escopo', plan: {}, tasks: { T1: value } }
  ui.render(state)
  assert.match(ui.nodes.get('#available').innerHTML, /Execution can start/)
  for (const expanded of [false, true]) {
    ui.run("POP_EXPANDED = expanded; fillPop('T1')", { expanded })
    const body = ui.nodes.get('#popBody').innerHTML
    assert.match(body, /role="group" aria-label="Execution conditions"/)
    for (const text of ['Preserve summary', 'echo contract', 'src/orders.mjs', 'orders-db (write access)', 'Execution can start']) assert.ok(body.includes(text), text)
  }
  value.executionReadiness = { ready: false, reasons: [
    { code: 'dependency', message: 'Dependencies are not complete', taskIds: ['T2'] },
    { code: 'files', message: 'Files overlap', paths: ['src/orders.mjs'] },
    { code: 'resources', message: 'Resources overlap', resources: ['orders-db'] },
    ...['Unknown scope', 'No capacity', 'Discussion required', 'Planning required', 'Authorization required'].map(message => ({ code: message, message })),
  ] }
  ui.render(state)
  ui.run("fillPop('T1')")
  const body = ui.nodes.get('#popBody').innerHTML
  assert.match(body, /Execution must wait/)
  assert.doesNotMatch(body, /Execution can start/)
  for (const reason of value.executionReadiness.reasons) assert.ok(body.includes(reason.message), reason.message)
  for (const detail of ['(T2)', '(src/orders.mjs)', '(orders-db)']) assert.ok(body.includes(detail), detail)
  assert.equal(ui.run("eff('T1')"), 'ready')
  assert.match(ui.nodes.get('#available').innerHTML, /Execution must wait/)
  assert.doesNotMatch(ui.nodes.get('#available').innerHTML, /the executor takes it next/)
})

test('estado servido usa condições derivadas e prioriza o cálculo vigente sobre campos antigos', () => {
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    const value = task('T1', 'pending', { writeScope: 'files', touches: ['src/orders.mjs'], summary: 'Resumo preservado', validation: 'echo contract' })
    const readiness = { ready: false, reasons: [{ code: 'path_conflict', message: 'An active task owns overlapping paths', taskIds: ['T2'], paths: ['src/orders.mjs'] }] }
    const state = { run: 'servido', plan: {}, tasks: { T1: value }, derived: { T1: { effective: 'ready', executionReadiness: readiness } } }
    const waiting = lang === 'en' ? 'Execution must wait' : 'Execução deve aguardar'
    const ready = lang === 'en' ? 'Execution can start' : 'Execução pode começar'
    ui.render(state)
    for (const expanded of [false, true]) {
      ui.run("POP_EXPANDED = expanded; fillPop('T1')", { expanded })
      const body = ui.nodes.get('#popBody').innerHTML
      for (const text of [waiting, 'T2', 'src/orders.mjs', 'Resumo preservado', 'echo contract']) assert.ok(body.includes(text), text)
      assert.ok(!body.includes(ready))
    }
    assert.ok(ui.nodes.get('#available').innerHTML.includes(waiting))
    assert.doesNotMatch(ui.nodes.get('#available').innerHTML, /the executor takes it next|o executor assume a seguir/)
    assert.equal(value.executionReadiness, undefined)
    value.executionReadiness = { ready: true, reasons: [] }
    ui.render(state)
    ui.run("fillPop('T1')")
    assert.ok(ui.nodes.get('#popBody').innerHTML.includes(waiting))
    readiness.ready = true
    readiness.reasons = []
    value.executionReadiness = { ready: false, reasons: [] }
    ui.render(state)
    ui.run("fillPop('T1')")
    assert.ok(ui.nodes.get('#popBody').innerHTML.includes(ready))
    assert.ok(ui.nodes.get('#available').innerHTML.includes(ready))
    assert.ok(!ui.nodes.get('#popBody').innerHTML.includes(waiting))
  }
})

test('escopo desconhecido e somente leitura ficam visíveis; legado não ganha promessa de liberação', () => {
  const ui = dashboard('en')
  for (const [scope, expected] of [['unknown', 'Write scope is unknown'], ['read-only', 'No file writes']]) {
    const value = task('T1', 'waiting', { writeScope: scope, sharedResources: [{ id: 'catalog', access: 'read' }],
      executionReadiness: { ready: false } })
    ui.render({ run: 'escopo', plan: {}, tasks: { T1: value } })
    ui.run("fillPop('T1')")
    assert.ok(ui.nodes.get('#popBody').innerHTML.includes(expected))
    assert.match(ui.nodes.get('#popBody').innerHTML, /catalog \(read access\)/)
  }
  for (const executionReadiness of [undefined, {}, { ready: 'yes' }]) {
    const value = task('T1', 'ready', { executionReadiness })
    ui.render({ run: 'legado', plan: {}, tasks: { T1: value } })
    ui.run("fillPop('T1')")
    assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, /Execution conditions|Execution can start|Execution must wait/)
    assert.doesNotMatch(ui.nodes.get('#available').innerHTML, /Execution can start|Execution must wait/)
  }
  assert.equal(ui.run('taskExecutionDetails(input)', { input: { writeScope: 'files' } }), '')
})

test('condições de execução e limites de escrita são traduzidos para pt-BR', () => {
  const ui = dashboard('pt-BR')
  const value = task('T1', 'pending', { writeScope: 'read-only',
    sharedResources: [{ id: 'database:catalog', access: 'read' }],
    executionReadiness: { ready: false, reasons: [
      { code: 'discussion', message: 'Current discussion is required before execution' },
      { code: 'capacity', message: 'Execution capacity is occupied' },
    ] } })
  ui.render({ run: 'escopo', plan: {}, tasks: { T1: value } })
  ui.run("fillPop('T1')")
  const body = ui.nodes.get('#popBody').innerHTML
  for (const text of ['Condições de execução', 'Execução deve aguardar', 'Sem escrita em arquivos',
    'É necessária uma discussão vigente antes da execução', 'As vagas de execução estão ocupadas',
    'database:catalog (acesso de leitura)']) assert.ok(body.includes(text), text)
})

test('tarefas ativas e encerradas preservam escopo sem anunciar espera por início', () => {
  const ui = dashboard('pt-BR')
  for (const taskState of ['running', 'reviewing', 'done', 'skipped']) {
    const value = task('T1', taskState, { writeScope: 'files', touches: ['src/orders.mjs'],
      sharedResources: [{ id: 'orders-db', access: 'write' }] })
    ui.render({ run: 'estado', plan: {}, tasks: { T1: value }, derived: { T1: {
      effective: taskState, executionReadiness: { ready: false, reasons: [{ code: 'state', message: 'Task is not pending execution' }] },
    } } })
    for (const expanded of [false, true]) {
      ui.run("POP_EXPANDED = expanded; fillPop('T1')", { expanded })
      const body = ui.nodes.get('#popBody').innerHTML
      assert.doesNotMatch(body, /Execução deve aguardar|Execução pode começar/)
      assert.match(body, /src\/orders.mjs/)
      assert.match(body, /orders-db \(acesso de escrita\)/)
    }
    assert.equal(value.state, taskState)
  }
  for (const taskState of ['blocked', 'failed']) {
    const value = task('T1', taskState, { executionReadiness: { ready: false, reasons: [] } })
    ui.render({ run: 'retomada', plan: {}, tasks: { T1: value } })
    ui.run("fillPop('T1')")
    assert.match(ui.nodes.get('#popBody').innerHTML, /Execução deve aguardar/)
  }
})

test('detalhes de execução escapam dados externos em mensagens, escopo e recursos', () => {
  const ui = dashboard('en')
  const unsafe = '<img src=x onerror=alert(1)>'
  const value = task('T1', 'ready', { writeScope: 'files', touches: [unsafe],
    sharedResources: [{ id: unsafe, access: 'write' }],
    executionReadiness: { ready: false, reasons: [{ code: 'files', message: unsafe, taskIds: [unsafe], paths: [unsafe], resources: [unsafe] }] } })
  ui.render({ run: 'escopo', plan: {}, tasks: { T1: value } })
  ui.run("fillPop('T1')")
  for (const body of [ui.nodes.get('#popBody').innerHTML, ui.nodes.get('#available').innerHTML]) {
    assert.doesNotMatch(body, /<img/)
    assert.match(body, /&lt;img/)
  }
})

test('aviso de atualização é traduzido, abre instruções manuais e não executa comandos', async () => {
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    let calls = 0
    await ui.run('checkDashboardUpdate()', { fetch: async (url, options) => {
      calls++
      assert.equal(url, '/api/update')
      assert.equal(options.cache, 'no-store')
      return { ok: true, json: async () => ({ available: true, current: '2.4.7', latest: '2.4.8' }) }
    } })
    assert.equal(calls, 1)
    assert.equal(ui.nodes.get('#updateNotice').hidden, false)
    assert.equal(ui.nodes.get('#updateVersions').textContent, lang === 'en'
      ? 'Installed: 2.4.7 · Available: 2.4.8' : 'Instalada: 2.4.7 · Disponível: 2.4.8')
    assert.equal(ui.run("tr('New update')"), lang === 'en' ? 'New update' : 'Nova atualização')
    assert.equal(ui.run('tr("Run \'prumo update\' in your terminal to install the latest version.")'), lang === 'en'
      ? "Run 'prumo update' in your terminal to install the latest version." : "Execute 'prumo update' no terminal para instalar a versão mais recente.")
    const dialog = ui.nodes.get('#updateDialog') ?? (ui.run("$('#updateDialog')"), ui.nodes.get('#updateDialog'))
    let opens = 0
    dialog.showModal = () => { opens++; dialog.open = true }
    ui.run('openUpdateDialog(); openUpdateDialog()')
    assert.equal(opens, 1)
    assert.equal(calls, 1, 'abrir as instruções não inicia uma instalação')
    for (const fetch of [
      async () => { throw new Error('offline') },
      async () => ({ ok: false }),
      async () => ({ ok: true, json: async () => { throw new Error('JSON inválido') } }),
      ...[{ available: false }, { available: true }, { available: true, current: '2.4.7' },
        { available: true, current: 247, latest: '2.4.8' }].map(data => async () => ({ ok: true, json: async () => data })),
    ]) {
      await ui.run('checkDashboardUpdate()', { fetch })
      assert.equal(ui.nodes.get('#updateNotice').hidden, true)
    }
  }
  assert.match(html, /<dialog id="updateDialog" aria-labelledby="updateTitle">/)
  assert.match(html, /#updateTitle, #updateInstruction \{ text-transform: none; \}/)
  assert.match(html, /<code>prumo update<\/code>/)
  assert.match(html, /<form method="dialog">/)
  assert.match(html, /prefers-reduced-motion: reduce\) \{ #updateNotice \{ animation: none;/)
})

test('copiar atualização copia somente o comando, anuncia sucesso e permite tentar novamente após falha', async () => {
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    ui.run("$('#updateCopy'); $('#updateCopyStatus')")
    const button = ui.nodes.get('#updateCopy'), status = ui.nodes.get('#updateCopyStatus')
    let copied
    await ui.run('copyUpdateCommand()', { navigator: { clipboard: { writeText: async text => {
      assert.equal(button.disabled, true)
      copied = text
    } } } })
    assert.equal(copied, 'prumo update')
    assert.equal(button.disabled, false)
    assert.equal(status.textContent, lang === 'en' ? 'Command copied' : 'Comando copiado')
    assert.equal(ui.run("tr('Copy command')"), lang === 'en' ? 'Copy command' : 'Copiar comando')
    for (const navigator of [{}, { clipboard: { writeText: async () => { throw new Error('permissão negada') } } }]) {
      await ui.run('copyUpdateCommand()', { navigator })
      assert.equal(button.disabled, false)
      assert.equal(status.textContent, lang === 'en' ? 'Unable to copy. Select the command and copy it manually.'
        : 'Não foi possível copiar. Selecione o comando e copie manualmente.')
    }
    const dialog = ui.run("$('#updateDialog')")
    dialog.showModal = () => { dialog.open = true }
    ui.run('openUpdateDialog()')
    assert.equal(status.textContent, '')
  }
})

test('dashboard exibe tarefa planejada ainda sem tentativa e mantém a inspeção no contrato', () => {
  const ui = dashboard('pt-BR'), state = plannedManualInspectionState()
  const before = structuredClone(state)
  ui.render(state)
  assert.match(ui.nodes.get('#nodes').innerHTML, /T7a/)
  ui.run("POP_EXPANDED = true; fillPop('T7a')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /manual-inspection/)
  assert.deepEqual(state, before)
})

test('vinculos usam o estado da tarefa referenciada sem simbolos e preservam a navegacao', () => {
  const ui = dashboard('pt-BR')
  const states = ['done', 'blocked', 'planning', 'running', 'reviewing', 'discussing', 'waiting', 'pending', 'ready', 'ready_to_plan', 'ready_for_discussion', 'ready_for_review', 'failed', 'skipped']
  const tasks = Object.fromEntries(states.map((state, i) => [`T${i + 2}`, task(`T${i + 2}`, state)]))
  tasks.T1 = task('T1', 'blocked', { deps: [...Object.keys(tasks), 'missing'] })
  tasks.T20 = task('T20', 'done', { deps: ['T1'] })
  tasks.T21 = { ...rejectionCases()[0][0], id: 'T21', title: 'Revisao', phase: 'P1', deps: [] }
  tasks.T1.deps.push('T21')
  ui.render({ run: 'vinculos', plan: {}, tasks })
  for (const expanded of [false, true]) {
    ui.run("POP_EXPANDED = expanded; fillPop('T1')", { expanded })
    const body = ui.nodes.get('#popBody').innerHTML
    for (const [i, state] of states.entries())
      assert.match(body, new RegExp(`class="dep" data-st="${state}"[^>]*onclick="jumpTo\\('T${i + 2}'\\)"[^>]*><span>[^<]+</span><b>T${i + 2}</b>`))
    assert.match(body, /class="dep" data-st=""[^>]*><span>[^<]+<\/span><b>missing<\/b>/)
    assert.match(body, /class="dep" data-st="failed"[^>]*aria-label="[^"]*Reprovado"[^>]*><span>[^<]+<\/span><b>T21<\/b>/)
    assert.match(body, /class="dep" data-st="done"[^>]*><span>Libera<\/span><b>T20<\/b>/)
    assert.doesNotMatch(body, /<b>T\d+(?: ✓| ·| ⛔)/)
  }
  tasks.T3.state = 'done'
  ui.run("fillPop('T1')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /data-st="done"[^>]*onclick="jumpTo\('T3'\)"/)
  ui.run("jumpTo('T3')")
  assert.equal(ui.run('POP.id'), 'T3')
  for (const [state, color] of [['done', '#323c21'], ['blocked', '#472a36'], ['planning', '#302e4d'], ['running', '#4a2b1f'], ['reviewing', '#183b4a'], ['failed', '#4b242b']])
    assert.match(html, new RegExp(`#pop \\.dep[^\\n{]*\\[data-st="${state}"\\][^\\n{]*\\{ --ticket-bg: ${color}; \\}`))
})

test('identificadores completos têm prioridade sobre o espaço do status do card', () => {
  assert.match(html, /\.node \.id \{ flex: 0 0 auto;[^}]*white-space: nowrap;/)
  assert.doesNotMatch(html, /\.node \.id \{[^}]*(?:text-overflow: ellipsis|overflow: hidden)/)
  assert.doesNotMatch(html, /\.node \.tag\.(?:live|queued) \{[^}]*24px/)
  const ui = dashboard('pt-BR')
  for (const status of ['ready_for_discussion', 'ready_to_plan', 'planning', 'running', 'reviewing']) {
    const tasks = Object.fromEntries(['T7a', 'T13a', 'T123a'].map(id => [id, task(id, status)]))
    ui.render({ run: 'identificadores', plan: {}, tasks })
    for (const id of Object.keys(tasks)) assert.ok(ui.nodes.get('#nodes').innerHTML.includes(`<span class="id">${id}`), id)
  }
})

test('reprovação concluída sai da revisão ativa e entra no resumo vermelho sem mudar o estado persistido', () => {
  const ui = dashboard('pt-BR')
  for (const [input, expected] of rejectionCases()) {
    assert.equal(ui.run('isReviewRejected(input)', { input }), expected)
  }
  const rejected = { ...rejectionCases()[0][0], id: 'T1', deps: [], title: 'Revisão', phase: 'F1' }
  const state = { run: 'reprovado', plan: {}, tasks: { T1: rejected, T2: task('T2', 'failed') } }
  ui.render(state)
  assert.equal(ui.run("eff('T1')"), 'failed')
  assert.equal(rejected.state, 'reviewing')
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-st="failed"[^]*aria-label="T1: Reprovado/)
  ui.run("POP = { id: 'T1', pinned: false }; fillPop('T1')")
  assert.equal(ui.nodes.get('#popStatus').textContent, 'Reprovado')
  assert.match(ui.nodes.get('#counts').innerHTML, /data-state="failed"[^]*Falhou \/ Reprovado[^]*<b>2<\/b>/)
  assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML, /onclick="openTask\('T1'\)/)
  delete rejected.validations[0].error
  ui.render(state)
  assert.equal(ui.run("eff('T1')"), 'reviewing', 'um resultado provisório não é uma reprovação concluída')
  assert.match(ui.nodes.get('#parallel').innerHTML, /onclick="openTask\('T1'\)/)
})

test('status do plano acompanha a cor da etapa e atualiza mesmo sem mudar contagens', () => {
  const ui = dashboard('pt-BR')
  const entry = { root: 'root', run: 'example', complete: false, taskCount: 2, doneCount: 0, activity: 'working' }
  const paint = fields => {
    ui.run(`updateRunSelect(${JSON.stringify({ currentRoot: 'root', current: 'example', runs: [{ ...entry, ...fields }] })})`)
    return ui.nodes.get('#runOptions').innerHTML
  }
  for (const activityState of ['ready_for_discussion', 'discussing', 'ready_to_plan', 'planning', 'ready', 'running', 'ready_for_review', 'reviewing']) {
    const options = paint({ activityState })
    assert.ok(options.includes(`class="run-state working" style="color:${ui.run(`ST_COLOR.${activityState}`)}"`), activityState)
    assert.match(options, />em andamento<i aria-hidden="true"/)
    assert.doesNotMatch(options, />parado<i/)
  }
  assert.match(paint({ activity: 'blocked', activityState: 'blocked' }), /class="run-state blocked">bloqueado<i/)
  assert.match(paint({ activity: 'failed', activityState: 'failed' }), /class="run-state failed">falhou<i/)
  assert.match(paint({ activity: 'idle', activityState: null }), /class="run-state idle">parado<i/)
  assert.doesNotMatch(paint({ activity: null, activityState: null }), /class="run-state/)
  assert.doesNotMatch(paint({ activityState: '__proto__' }), /style="color:/)
  assert.match(paint({ complete: true, doneCount: 2, activityState: 'blocked' }), /class="run-state complete">no prumo<i/)
})
test('resumo recolhido preserva contagens e recebe atualizações', () => {
  assert.match(html, /id="summaryToggle"[^>]*aria-expanded="true"[^>]*aria-controls="summaryContent"/)
  const ui = dashboard('pt-BR')
  const state = { run: 'resumo', plan: { phases: [] }, tasks: { T1: task('T1', 'running') } }
  ui.render(state)
  ui.run('toggleSummary()')
  const content = ui.nodes.get('#summaryContent')
  ui.run("setFilter('done')")
  state.tasks.T1.state = 'done'
  ui.render(state)
  assert.equal(ui.nodes.get('#summaryToggle').getAttribute('aria-expanded'), 'false')
  assert.equal(content.classList.contains('collapsed'), true)
  assert.equal(content.getAttribute('aria-hidden'), 'true')
  assert.equal(content.getAttribute('inert'), '')
  assert.match(ui.nodes.get('#counts').innerHTML, /No Prumo/)
  assert.match(ui.nodes.get('#counts').innerHTML, /1\/1/)
  ui.run('toggleSummary()')
  ui.render(state)
  assert.equal(ui.nodes.get('#summaryToggle').getAttribute('aria-expanded'), 'true')
  assert.equal(content.classList.contains('collapsed'), false)
  assert.equal(content.getAttribute('inert'), null)
  assert.match(ui.nodes.get('#counts').innerHTML, /1\/1/)
})

test('seções da lateral recolhem independentemente e preservam conteúdo atualizado', () => {
  const ui = dashboard('pt-BR')
  const state = { run: 'lateral', plan: { phases: [] }, tasks: { T1: task('T1', 'ready') } }
  ui.render(state)
  for (const section of ['summary', 'agents', 'available', 'events']) {
    assert.match(html, new RegExp(`id="${section}Toggle"[^>]*aria-controls="${section}Content"`))
    ui.run(`toggleSection('${section}')`)
    assert.equal(ui.nodes.get(`#${section}Toggle`).getAttribute('aria-expanded'), 'false')
    assert.equal(ui.nodes.get(`#${section}Content`).getAttribute('inert'), '')
  }
  state.tasks.T1.state = 'running'
  ui.render(state, [{ type: 'task_note', task: 'T1', at: instant(20), text: 'Atualização durante recolhimento' }])
  assert.match(ui.nodes.get('#events').innerHTML, /Atualização durante recolhimento/)
  for (const section of ['summary', 'agents', 'available', 'events']) {
    ui.run(`toggleSection('${section}', true)`)
    assert.equal(ui.nodes.get(`#${section}Toggle`).getAttribute('aria-expanded'), 'true')
    assert.equal(ui.nodes.get(`#${section}Content`).classList.contains('collapsed'), false)
    assert.equal(ui.nodes.get(`#${section}Content`).getAttribute('aria-hidden'), 'false')
    assert.equal(ui.nodes.get(`#${section}Content`).getAttribute('inert'), null)
    for (const other of ['summary', 'agents', 'available', 'events'].filter((value) => value !== section)) {
      assert.equal(ui.nodes.get(`#${other}Toggle`).getAttribute('aria-expanded'), 'false')
    }
    ui.run(`toggleSection('${section}', false)`)
  }
})

test('atividade explícita mantém relógios individuais e soma paralelismo no ao vivo', () => {
  const ui = dashboard('pt-BR')
  const measured = role => ({ n: 1, startedAt: instant(90), activityTiming: 'explicit',
    activityIntervals: [{ role, startedAt: instant(90) }] })
  const state = { run: 'paralelo', createdAt: instant(0), plan: { phases: [] }, tasks: {
    T1: task('T1', 'running', { attempts: [measured('execution')] }),
    T2: task('T2', 'reviewing', { attempts: [{ ...measured('review'), reviewStartedAt: instant(90) }] }),
    T3: task('T3', 'planning', { planningAttempts: [measured('planning')] }),
  } }
  ui.render(state)
  for (const item of Object.values(state.tasks)) {
    assert.equal(ui.run('taskClock(item, item.state)', { item }), 10000)
  }
  assert.match(ui.nodes.get('#orch').innerHTML, />00:00:30<\/time>/)
  assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML, /não aferido/)
  assert.equal(ui.run('analyse(STATE, [], true).agentTotal'), 30000)
  for (const item of Object.values(state.tasks)) {
    const round = item.planningAttempts?.[0] ?? item.attempts[0]
    round.activityIntervals[0].endedAt = instant(95)
  }
  ui.render(state)
  for (const item of Object.values(state.tasks)) assert.equal(ui.run('taskClock(item, item.state)', { item }), 5000)
  assert.match(ui.nodes.get('#orch').innerHTML, />00:00:15<\/time>/)
})

test('três planejadores de trinta minutos somam uma hora e meia e avançam sem checkpoints', () => {
  for (const language of ['en', 'pt-BR']) {
    const ui = dashboard(language)
    ui.run('Date.now = () => current', { current: Date.parse(instant(1800)) })
    const state = { run: 'planejamento', createdAt: instant(0), plan: {}, tasks: Object.fromEntries(
      ['T1', 'T2', 'T3'].map(id => [id, task(id, 'planning', { planningAttempts: [
        { startedAt: instant(0), activityTiming: 'explicit', activityIntervals: [] },
      ] })])) }
    ui.render(state)
    assert.match(ui.nodes.get('#orch').innerHTML, />01:30:00<\/time>/)
    assert.equal(ui.run('analyse(STATE).stageElapsed'), 5400000)
    ui.run('Date.now = () => current', { current: Date.parse(instant(1801)) })
    ui.render(state)
    assert.match(ui.nodes.get('#orch').innerHTML, />01:30:03<\/time>/)
    for (const item of Object.values(state.tasks)) {
      item.state = 'pending'
      item.planningAttempts[0].endedAt = instant(1800)
    }
    ui.render(state)
    assert.match(ui.nodes.get('#orch').innerHTML, />01:30:00<\/time>/)
  }
})

test('ao vivo soma discussão, planejamento, execução e revisão sem duplicar rodadas de fase', () => {
  const ui = dashboard()
  const state = { run: 'etapas', plan: {}, tasks: {
    T1: task('T1', 'discussing', { discussionAttempts: [{ activityTiming: 'explicit', startedAt: instant(90) }] }),
    T2: task('T2', 'planning', { planningAttempts: [{ activityTiming: 'explicit', startedAt: instant(90) }] }),
    T3: task('T3', 'running', { attempts: [{ activityTiming: 'explicit', startedAt: instant(90) }] }),
    T4: task('T4', 'reviewing', { attempts: [{ activityTiming: 'explicit', startedAt: instant(80), reviewStartedAt: instant(90) }] }),
  } }
  ui.render(state)
  assert.equal(ui.run('analyse(STATE).stageElapsed'), 50000)
  assert.match(ui.nodes.get('#orch').innerHTML, />00:00:50<\/time>/)
  state.tasks = Object.fromEntries(['T1', 'T2', 'T3'].map(id => [id, task(id, 'pending', { phase: 'F1' })]))
  state.phaseWorkflows = { F1: { state: 'planning', planningAttempts: [{ activityTiming: 'explicit', startedAt: instant(90), targets: ['T1', 'T2', 'T3'] }] } }
  ui.render(state)
  assert.equal(ui.run('analyse(STATE).stageElapsed'), 10000, 'uma rodada de um planejador é contada uma vez')
})

test('relógio das etapas exclui pausas, espera, horários inválidos e registros incompletos', () => {
  const ui = dashboard()
  const round = { startedAt: instant(0), activityTiming: 'explicit', activityIntervals: [
    { role: 'execution', startedAt: instant(0), endedAt: instant(10) },
    { role: 'execution', startedAt: instant(90) },
  ] }
  assert.equal(ui.run('stageTime(round, "execution", true, Date.now())', { round }), 20000)
  assert.equal(ui.run('stageTime(round, "execution", false, Date.now())', { round }), 10000)
  for (const startedAt of [undefined, 'invalid', instant(110)])
    assert.equal(ui.run('stageTime(round, "planning", true, Date.now())', { round: { activityTiming: 'explicit', startedAt } }), 0)
  assert.equal(ui.run('stageTime(round, "planning", false, Date.now())', { round: { startedAt: instant(0) } }), 0)
  const state = { run: 'pausas', createdAt: instant(0), plan: {}, tasks: {
    T1: task('T1', 'running', { attempts: [{ activityTiming: 'explicit', startedAt: instant(0) }] }),
    T2: task('T2', 'pending'),
  } }
  const events = [
    { type: 'task_block', task: 'T1', at: instant(10) },
    { type: 'task_unblock', task: 'T1', at: instant(90) },
  ]
  ui.render(state, events)
  assert.equal(ui.run('analyse(STATE, EVENTS).stageElapsed'), 20000)
  assert.equal(ui.run('analyse(STATE, EVENTS, false).stageElapsed'), 0)
})

test('relógio de planejamento acompanha a fase e não inventa tempo sem registro', () => {
  const ui = dashboard()
  const item = task('T1', 'planning', { phase: 'F1' })
  const round = { startedAt: instant(90), activityTiming: 'explicit',
    activityIntervals: [{ role: 'planning', startedAt: instant(90) }] }
  ui.render({ run: 'fase', plan: { phases: [{ id: 'F1', title: 'Fase' }] },
    phaseWorkflows: { F1: { state: 'planning', planningAttempts: [round] } }, tasks: { T1: item } })
  assert.equal(ui.run('taskClock(item, "planning")', { item }), 10000)
  round.endedAt = instant(95)
  ui.render({ run: 'fase', plan: { phases: [] }, tasks: { T1: { ...item, planningAttempts: [round] } } })
  assert.equal(ui.run('taskClock(item, "planning")', { item: { ...item, planningAttempts: [round] } }), 5000)
  for (const intervals of [undefined, [], [{ role: 'execution', startedAt: instant(90) }]]) {
    assert.equal(ui.run('taskClock(item, "planning")', { item: { ...item, planningAttempts: [{ ...round, activityIntervals: intervals }] } }), null)
  }
  for (const interval of [{ role: 'planning' }, { role: 'planning', startedAt: 'invalid' },
    { role: 'planning', startedAt: instant(110), endedAt: instant(100) }]) {
    assert.equal(ui.run('taskClock(item, "planning")', { item: { ...item, planningAttempts: [{ ...round, activityIntervals: [interval] }] } }), 0)
  }
})

test('último evento usa o mesmo tempo ao vivo sem crescer durante espera', () => {
  const ui = dashboard()
  const work = task('T1', 'running', { attempts: [{ n: 1, startedAt: instant(0), activityTiming: 'explicit',
    activityIntervals: [{ role: 'execution', startedAt: instant(0), endedAt: instant(10) }] }] })
  const state = { run: 'tempo', createdAt: instant(0), plan: { phases: [] }, tasks: { T1: work } }
  ui.render(state, [{ type: 'task_note', task: 'T1', at: instant(20), text: 'Pausa' }])
  assert.match(ui.nodes.get('#orch').innerHTML, />00:00:10<\/time>/)
  assert.match(ui.nodes.get('#events').innerHTML, />00:00:10<\/time>/)
  ui.render(state, [{ type: 'task_note', task: 'T1', at: instant(90), text: 'Ainda aguardando' }])
  assert.match(ui.nodes.get('#events').innerHTML, />00:00:10<\/time>/)
  assert.equal(ui.run('eventActivityClock(analyse(STATE, EVENTS, false))(at)', { at: instant(20) }), 'not measured')
})

const plan = {
  planner: 'planner-1', startedAt: instant(0), completedAt: instant(20),
  research: [{ source: 'src/task.mjs', findings: 'Existing behavior verified' }],
  decisions: [{ question: 'Reuse existing function?', answer: 'Yes' }],
  steps: ['Update shared function', 'Run functional check'],
  verification: [{ criterion: 'Required behavior', check: 1 }], openQuestions: [],
}
const discovery = {
  recordedAt: instant(0), closure: 'No consequential gray area remains.',
  research: [{ source: 'src/task.mjs', findings: 'Current task context inspected' }],
  questions: [{ question: 'Keep current behavior?', answer: 'Yes', channel: 'chat-fallback', round: 1 }],
  coverage: { problem: 'Problem', affected: 'People', outcome: 'Outcome', currentBehavior: 'Current',
    desiredBehavior: 'Desired', rules: 'Rules', exceptions: 'Exceptions', scope: 'Scope', acceptance: 'Acceptance' },
  decisions: [{ question: 'Keep behavior?', answer: 'Yes' }], deferred: ['Future idea'],
  executionBoundary: { deferredToExecutor: ['T'], prematureTaskWork: [] },
}

test('barra distingue conclusão e atividade sem contar tarefas puladas ou alterar a porcentagem ao filtrar', () => {
  const ui = dashboard('pt-BR')
  const states = ['done', 'discussing', 'planning', 'running', 'reviewing', 'waiting', 'blocked', 'failed', 'ready', 'skipped']
  const tasks = Object.fromEntries(states.map((state, index) => [`T${index}`, task(`T${index}`, state)]))
  const state = { run: 'atividade', plan: {}, tasks, derived: {} }
  ui.render(state)
  for (const status of ['done', 'discussing', 'planning', 'running', 'reviewing']) {
    assert.equal(ui.nodes.get(`#bar .seg-${status}`).style.width, `${100 / 9}%`)
    assert.match(ui.nodes.get(`#bar .seg-${status}`).title, /1\/9$/)
  }
  assert.equal(ui.nodes.get('#bar').getAttribute('aria-valuenow'), '11')
  assert.match(ui.nodes.get('#bar').getAttribute('aria-valuetext'), /executando: 1\/9/)
  ui.run("FILTER = 'waiting'")
  ui.render(state)
  assert.equal(ui.nodes.get('#bar .seg-done').style.width, `${100 / 9}%`)
  assert.equal(ui.nodes.get('#bar .seg-running').style.width, `${100 / 9}%`)
  for (const current of Object.values(tasks)) current.state = 'done'
  ui.render(state)
  assert.equal(ui.nodes.get('#bar .seg-done').style.width, '100%')
  for (const status of ['discussing', 'planning', 'running', 'reviewing']) assert.equal(ui.nodes.get(`#bar .seg-${status}`).style.width, '0%')
  ui.render({ run: 'vazio', plan: {}, tasks: {}, derived: {} })
  assert.equal(ui.nodes.get('#bar .seg-done').style.width, '0%')
  assert.equal(ui.nodes.get('#bar').getAttribute('aria-valuenow'), '0')
})

test('horário dos eventos acompanha atividade medida e preserva a data completa', () => {
  for (const language of ['en', 'pt-BR']) {
    const ui = dashboard(language)
    const createdAt = '2026-10-01T23:59:00Z'
    const timing = { per: [{ spans: [['exec', Date.parse(createdAt), Date.parse('2026-10-02T00:00:00Z')],
      ['review', Date.parse('2026-10-02T00:10:00Z'), Date.parse('2026-10-02T00:11:00Z')]] }],
      sharedSpans: [['planning', Date.parse(createdAt), Date.parse('2026-10-02T00:00:00Z')]], unmeasuredActivity: false }
    for (const [at, expected] of [
      [createdAt, '00:00:00'], ['2026-10-01T23:59:30Z', '00:01:00'],
      ['2026-10-02T00:00:00Z', '00:02:00'], ['2026-10-02T00:09:00Z', '00:02:00'],
      ['2026-10-02T00:10:30Z', '00:02:30'], ['2026-10-03T03:59:10Z', '00:03:00'],
      ['2026-10-01T20:59:00-03:00', '00:00:00'], ['2026-10-01T23:58:00Z', '00:00:00'],
      ['invalid', '—'], [undefined, '—'],
    ]) assert.equal(ui.run('eventActivityClock(timing)(at)', { timing, at }), expected)
    for (const measured of [false, true]) {
      const empty = { per: [], sharedSpans: [], unmeasuredActivity: measured }
      assert.equal(ui.run('eventActivityClock(timing)(at)', { timing: empty, at: createdAt }), measured ? ui.run("tr('not measured')") : '00:00:00')
    }
    assert.equal(ui.run('eventActivityClock(timing)(at)', { timing: { per: [], sharedSpans: [['exec', 0, 28 * 3600000]], unmeasuredActivity: false }, at: new Date(28 * 3600000).toISOString() }), '28:00:00')
    assert.equal(ui.run('fmtEventDate(at)', { at: 'invalid' }), '—')
    const at = '2026-10-02T00:14:32Z'
    const fullDate = ui.run('fmtEventDate(at)', { at })
    assert.match(fullDate, /2026/)
    ui.render({ run: 'tempo', createdAt, plan: {}, tasks: { T1: task('T1', 'waiting') }, derived: {} }, [{ type: 'task_note', task: 'T1', at, text: 'Registro' }])
    assert.ok(ui.nodes.get('#events').innerHTML.includes(`datetime="${at}" title="${fullDate}"`))
    assert.match(ui.nodes.get('#events').innerHTML, />00:00:00<\/time>/)
  }
})

test('guia usa os mesmos segmentos e mantém atividade fora do percentual concluído', () => {
  const ui = dashboard('pt-BR')
  ui.render(createGuideDemoData('board'))
  assert.equal(ui.nodes.get('#bar .seg-done').style.width, `${200 / 13}%`)
  for (const status of ['discussing', 'planning', 'running', 'reviewing']) assert.equal(ui.nodes.get(`#bar .seg-${status}`).style.width, `${100 / 13}%`)
  ui.render(createGuideDemoData('results'))
  assert.equal(ui.nodes.get('#bar .seg-done').style.width, '100%')
  for (const status of ['discussing', 'planning', 'running', 'reviewing']) assert.equal(ui.nodes.get(`#bar .seg-${status}`).style.width, '0%')
})

test('contagem dos filtros permanece visível nos controles e distingue resultados do contexto', () => {
  for (const width of [330, 1400]) {
    const ui = dashboard('pt-BR', width)
    const tasks = Object.fromEntries(Array.from({ length: 29 }, (_, index) => {
      const id = `T${index + 1}`
      return [id, task(id, index < 4 ? 'pending' : 'done')]
    }))
    const state = { run: 'filtros', plan: {}, tasks,
      derived: Object.fromEntries(Object.keys(tasks).map((id, index) => [id, { effective: index < 4 ? 'waiting' : 'done' }])) }
    const before = JSON.stringify(state)
    ui.render(state)
    for (const selector of ['#filterCount', '#compactFilterCount']) assert.equal(ui.nodes.get(selector).textContent, '29/29')
    ui.run("setFilter('waiting')")
    for (const selector of ['#filterCount', '#compactFilterCount']) assert.equal(ui.nodes.get(selector).textContent, '04/29')
    ui.run("setFilter('reviewing')")
    assert.equal(ui.nodes.get('#filterCount').textContent, '00/29')
    ui.run("setFilter('all')")
    assert.equal(ui.nodes.get('#compactFilterCount').textContent, '29/29')
    assert.equal(JSON.stringify(state), before)
  }
  const ui = dashboard()
  ui.run('updateFilterCount(4, 129)')
  assert.equal(ui.nodes.get('#filterCount').textContent, '004/129')
  assert.match(html, /id="filterToggle"[^>]*>[\s\S]*?id="filterCount"[\s\S]*?class="filter-eye"/)
  assert.match(html, /<summary><span data-i18n="Filters">[\s\S]*?id="compactFilterCount"/)
  assert.doesNotMatch(html, /tr\('filter results \{0\}\/\{1\}'/)
})

test('abrir planos e filtros alternadamente mantém apenas um dropdown aberto', () => {
  for (const width of [330, 1400]) {
    const ui = dashboard('pt-BR', width)
    ui.render({ run: 'filtros', plan: {}, tasks: { T1: task('T1', 'done') }, derived: {} })
    const runMenu = ui.nodes.get('#runMenu')
    const header = ui.nodes.get('#headerMenu')
    const openFilters = () => {
      if (width <= 1100) { header.open = true; ui.dispatchElement('#headerMenu', 'toggle') }
      else ui.run('toggleFilterMenu(true)')
    }
    for (let index = 0; index < 2; index++) {
      openFilters()
      assert.equal(runMenu.open, false)
      assert.equal(ui.nodes.get('#filterPanel').hidden, false)
      runMenu.open = true
      ui.dispatchElement('#runMenu', 'toggle')
      assert.equal(ui.nodes.get('#filterPanel').hidden, true)
      assert.equal(ui.nodes.get('#filterToggle').getAttribute('aria-expanded'), 'false')
      if (width <= 1100) { assert.equal(header.open, false); ui.dispatchElement('#headerMenu', 'toggle') }
      openFilters()
      assert.equal(runMenu.open, false)
      ui.dispatchElement('#runMenu', 'toggle')
      assert.equal(ui.nodes.get('#filterPanel').hidden, false, 'o toggle atrasado do menu fechado não fecha o filtro recém-aberto')
    }
    ui.run("setFilter('done')")
    assert.equal(ui.run('FILTER'), 'done')
    assert.equal(ui.nodes.get('#filterPanel').hidden, true)
  }
})

test('indicadores dos planos mostram texto antes da bolinha e usam o relógio compartilhado', () => {
  const ui = dashboard('pt-BR')
  const existing = { animationName: 'activity-spin', startTime: 70 }
  const inserted = { animationName: 'activity-spin', startTime: 300 }
  ui.run('document.getAnimations = () => animations; syncActivitySpinners()', { animations: [existing] })
  existing.startTime = 40
  const catalog = { currentRoot: 'root', current: 'ativo', runs: [
    { root: 'root', run: 'ativo', plan: 'Plano ativo', complete: false, activity: 'working', taskCount: 2, doneCount: 1 },
    { root: 'root', run: 'feito', plan: 'Plano entregue', complete: true, taskCount: 2, doneCount: 2 },
  ] }
  const before = JSON.stringify(catalog)
  ui.run('document.getAnimations = () => animations; updateRunSelect(input)', { animations: [existing, inserted], input: catalog })
  assert.equal(existing.startTime, 40, 'o menu não reinicia o spinner já sincronizado')
  assert.equal(inserted.startTime, 0)
  assert.match(ui.nodes.get('#runOptions').innerHTML, /class="run-state working">em andamento<i aria-hidden="true"><\/i>/)
  ui.run("toggleRunFilter('complete')")
  assert.match(ui.nodes.get('#runOptions').innerHTML, /class="run-state complete">no prumo<i aria-hidden="true"><\/i>/)
  assert.doesNotMatch(ui.nodes.get('#runOptions').innerHTML, /✓/)
  assert.equal(JSON.stringify(catalog), before)
})

test('API legada sem deps mantém card e dados acessíveis sem aceitar tipo inválido', async () => {
  const ui = dashboard()
  const state = JSON.parse(JSON.stringify({run:'legado',plan:{},tasks:{T1:task('T1','done',{phase:''})},derived:{}}))
  delete state.tasks.T1.deps
  const original = JSON.stringify(state)
  await ui.run('fetch = async url => String(url).includes("/api/runs") ? {ok:false} : String(url).includes("/api/events") ? {ok:true,json:async()=>({events:[],complete:true,total:0})} : {ok:true,json:async()=>input}; tick()', {input:state})
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-id="T1"/)
  assert.doesNotThrow(() => ui.run('openTask("T1"); togglePopExpand(true)'))
  assert.equal(ui.run('POP.id'), 'T1')
  assert.match(ui.nodes.get('#popBody').innerHTML, /Task T1/)
  assert.equal(Object.hasOwn(state.tasks.T1, 'deps'), false)
  assert.equal(JSON.stringify(state), original)
  const invalid = JSON.parse(original)
  invalid.tasks.T1.deps = 'T2'
  assert.throws(() => ui.run('analyse(input, [], true)', {input:invalid}), /map/)
  assert.equal(invalid.tasks.T1.deps, 'T2')
})

test('card ignora dependência ausente no foco sem modificar referência registrada', () => {
  const ui = dashboard()
  const state = graphState(2, 1)
  state.tasks.T002.deps = ['T001', 'ausente']
  ui.render(state)
  assert.doesNotThrow(() => ui.run('openTask("T002")'))
  assert.equal(ui.run('POP.id'), 'T002')
  assert.deepEqual(ui.run('Array.from(lineage("T002").up)'), ['T001'])
  assert.deepEqual(state.tasks.T002.deps, ['T001', 'ausente'])
  assert.match(ui.nodes.get('#popBody').innerHTML, /ausente/)
})

test('armazenamento privado mantém filtros e barra lateral operáveis sem persistência', () => {
  const ui = dashboard('pt-BR', 1000, new Map(), { state: 'legado', urls: [] })
  ui.render(graphState(1,1))
  ui.run('localStorage.setItem = () => {throw new Error("privado")}; sessionStorage.setItem = () => {throw new Error("privado")}; setFilter("done"); toggleSidebar()')
  assert.equal(ui.run('FILTER'), 'done')
  assert.equal(typeof ui.run('history.state.graphSidebarCollapsed'), 'boolean')
  assert.equal(ui.run('tr("[prumo] idle")'), '[prumo] inativo')
  assert.equal(ui.run('tr("{0} não catalogado", 2)'), '2 não catalogado')
  ui.run('STATE.tasks.T001.deps = undefined')
  assert.equal(ui.run('filterSets(STATE.tasks, "running").matches.size'), 1)
})

test('estado legado com chave diferente do ID conserva dados e mantém análise e card acessíveis', () => {
  const ui = dashboard()
  const state = JSON.parse(JSON.stringify({ run: 'legado', plan: {}, tasks: {
    chaveLegada: task('T1', 'pending', { title: 'Título legado preservado', phase: '' }),
  }, derived: {} }))
  const original = JSON.stringify(state)
  const result = ui.run('analyse(input, [], true)', { input: state })
  assert.equal(result.per[0].id, 'T1')
  assert.equal(result.cpLen, 0)
  ui.run('STATE = input; EVENTS_COMPLETE = true; fillPop("chaveLegada")', { input: state })
  assert.equal(ui.nodes.get('#popTitle').textContent, 'T1')
  assert.match(ui.nodes.get('#popBody').innerHTML, /Título legado preservado/)
  assert.equal(JSON.stringify(state), original)
})

test('card conserva dispensa de fase e relógio encerrado sem marcar atividade parcial', () => {
  const ui = dashboard()
  const state = graphState(1,1)
  state.tasks.T001.attempts = [{ startedAt: instant(0), endedAt: instant(2) }]
  state.tasks.T001.deps = ['T002']
  state.tasks.T002 = task('T002', 'pending', { phase: 'P1' })
  state.derived.T002 = { effective: 'unknown' }
  state.phaseWorkflows = { P1: { id: 'P1', state: 'discussing', discussionAttempts: [], planningAttempts: [], discussionSkips: [{ reason: 'fora do alvo' }, { targets: ['T001'], reason: 'dispensa aprovada' }] } }
  const events = [{ task: 'T001', type: 'task_start', at: instant(0) }, { task: 'T001', type: 'task_progress', at: instant(2) }]
  ui.run('EVENTS_COMPLETE = true')
  ui.render(state, events)
  assert.match(ui.nodes.get('#parallel').innerHTML, /2s/)
  assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML, /not measured/)
  ui.run('openTask("T001"); togglePopExpand(true)')
  assert.match(ui.nodes.get('#popBody').innerHTML, /dispensa aprovada/)
  ui.dispatchElement('#viewport', 'pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
  ui.run('openTask("T001")')
  assert.equal(ui.run('POP'), null)
  ui.dispatchElement('#viewport', 'pointerup', {})
})

test('histórico resolve papel do recibo e conserva identidade do plano e bloqueio sem resposta', () => {
  const ui = dashboard('pt-BR')
  assert.equal(ui.run('tr("[prumo] ERROR: idle")'), '[prumo] ERRO: inativo')
  ui.run('STATE = null; selectHistoryEvent("orphan", "T1", "F1")')
  assert.equal(ui.run('SELECTED_EVENT'), 'orphan')
  assert.equal(ui.run('phaseColour("F1")'), 'var(--waiting)')
  ui.run('STATE = {tasks:{T1:input}}', { input: task('T1', 'pending', { validations: [{ token: 'receipt', by: 'review' }] }) })
  assert.equal(ui.run('eventColour({type:"task_validation_started",task:"T1",token:"receipt"})'), 'var(--review)')
  assert.match(ui.run('eventSentence({type:"task_validation_started",task:"T1",token:"receipt"})'), /Revisor/)
  assert.match(ui.run('eventSentence({type:"task_check",task:"T1",kind:"manual",status:"started"})'), /Executor/)
  assert.match(ui.run('eventSentence({type:"task_start",task:"T1",planDigest:"abcd"})'), /abcd/)
  assert.match(ui.run('fmtTaskPlan({openQuestions:[{question:"decidir?",blocking:true}]})'), /bloqueante/)
  ui.run('updateRunDescription({run:"A",plan:{description:" Descrição "}})')
  assert.equal(ui.nodes.get('#runLabel').textContent, 'Descrição')
  const state = graphState(1,1)
  ui.render(state, [{ type: 'task_start', task: 'T001', at: instant(1) }])
  ui.render(state, [{ type: 'task_note', task: 'T001', at: instant(2), text: 'nota sem transição' }])
  assert.equal(ui.cards[0].classList.contains('flash-bad'), false)
  assert.equal(ui.cards[0].classList.contains('flash-start'), false)
})

test('atividade explícita aberta mede apenas o papel ativo e histórico legado de planejamento fica não aferido', () => {
  const ui = dashboard()
  const state = { run: 'active', plan: {}, tasks: {
    T1: task('T1', 'running', { attempts: [{ activityTiming: 'explicit', activityIntervals: [{ role: 'execution', startedAt: instant(90) }] }] }),
    T2: task('T2', 'pending', { planningHistory: [{}] }),
  } }
  const result = ui.run('analyse(input, [], true)', { input: state })
  assert.equal(result.execTotal, 10000)
  assert.equal(result.planningMeasured, false)
  assert.equal(result.per.find(item => item.id === 'T1').unmeasured, true)
})

test('polling cancela catálogo e histórico obsoletos e atualiza card aberto somente no plano atual', async () => {
  const ui = dashboard()
  const state = graphState(1,1)
  state.run = 'atual'
  ui.render(state)
  await ui.run('fetch = async url => String(url).includes("/api/runs") ? {ok:true,json:async()=>{TICK_GENERATION++;return {}}} : {ok:true,json:async()=>({run:"obsoleto"})}; tick()')
  assert.equal(ui.run('STATE.run'), 'atual')
  await ui.run('SELECTED_ROOT = "root"; SELECTED_RUN = null; CURRENT_ROOT = CURRENT_RUN = null; fetch = async url => String(url).includes("/api/runs") ? {ok:false} : String(url).includes("/api/events") ? {ok:true,json:async()=>({events:[],complete:true,total:0})} : {ok:true,json:async()=>input}; tick()', { input: state })
  assert.equal(ui.run('STATE_RUN_KEY'), 'root\0atual')
  await ui.run('fetch = async () => {TICK_GENERATION++;return {ok:false}}; tick()')
  assert.equal(ui.run('STATE.run'), 'atual')
  await ui.run('SELECTED_ROOT = "root"; SELECTED_RUN = "atual"; fetch = async url => String(url).includes("/api/runs") ? {ok:false} : String(url).includes("/api/events") ? {ok:true,json:async()=>{TICK_GENERATION++;return {events:[],complete:true,total:0}}} : {ok:true,json:async()=>input}; tick()', { input: state })
  assert.equal(ui.run('STATE.run'), 'atual')
  ui.run('SELECTED_ROOT = SELECTED_RUN = CURRENT_ROOT = CURRENT_RUN = null; closePop(); openTask("T001")')
  await ui.run('fetch = async url => String(url).includes("/api/runs") ? {ok:false} : String(url).includes("/api/events") ? {ok:true,json:async()=>({events:[],complete:true,total:0})} : {ok:true,json:async()=>input}; tick()', { input: { ...state, tasks: { T001: { ...state.tasks.T001, title: 'Título atualizado' } } } })
  assert.match(ui.nodes.get('#popBody').innerHTML, /Título atualizado/)
})

test('acesso negado ao armazenamento inicia sem filtro e mantém guia e atalhos utilizáveis', () => {
  const ui = dashboard('pt-BR', 1000, new Map(), { state: null, urls: [] }, {
    localStorage: { getItem() { throw new Error('acesso negado') }, setItem() { throw new Error('acesso negado') } },
  })
  assert.equal(ui.run('FILTER'), 'all')
  ui.render(graphState(1,1))
  assert.equal(ui.cards[0].classList.contains('filtered-out'), false)
  ui.run('toggleFilterMenu(true)')
  assert.equal(ui.nodes.get('#filterPanel').hidden, false)
  ui.dispatchDocument('keydown', { key: 'R' })
  assert.equal(ui.run('RESULTS_OPEN'), true)
  ui.dispatchDocument('keydown', { key: 'Escape' })
  assert.equal(ui.run('RESULTS_OPEN'), false)
  ui.run('requestAnimationFrame = () => 1')
  ui.resize(900)
  ui.resize(800)
  assert.equal(ui.run('viewportWidth'), 800)
  ui.resize(800)
  assert.equal(ui.run('viewportWidth'), 800)
})

test('renderização diferencia falha, múltiplos executores, fase por alias e histórico selecionado', () => {
  const ui = dashboard()
  const state = graphState(4, 1)
  state.tasks.T001.state = 'failed'; state.derived.T001.effective = 'failed'
  state.tasks.T002.deps = ['T001', 'ausente']
  state.tasks.T002.state = state.tasks.T003.state = 'running'
  state.derived.T002.effective = state.derived.T003.effective = 'running'
  state.tasks.T004.state = 'planning'; state.derived.T004.effective = 'planning'
  state.phaseWorkflows = { P1: { id: 'P1', state: 'discussing', discussionAttempts: [{}], planningAttempts: [{ targets: ['alias', 'ausente'] }] } }
  state.taskIdAliases = { alias: 'T004' }
  ui.run('matchMedia = () => ({matches:true}); SELECTED_EVENT = "selected"')
  ui.render(state, [{ id: 'selected', at: instant(1), type: 'task_note', task: 'T002', text: 'nota' }])
  assert.equal(ui.nodes.get('#execCount').textContent, '×2')
  assert.match(ui.nodes.get('#edgePaths').innerHTML, /e-failed/)
  assert.match(ui.nodes.get('#orchSub').textContent, /phase discussion P1: 1 tasks/)
  assert.match(ui.nodes.get('#events').innerHTML, /class="ev selected"/)
  ui.render(state, [{ id: 'failed', at: instant(2), type: 'task_fail', task: 'T001' }])
  assert.ok(ui.cards.find(card => card.dataset.id === 'T001').classList.contains('flash-bad'))
  state.tasks.T002.deps = ['T001']
  ui.run('selectHistoryEvent("selected", "T002", "")')
  assert.equal(ui.run('POP.id'), 'T002')
  const focused = ui.paths.find(path => path.dataset.from === 'T001' && path.dataset.to === 'T002')
  focused.classList.remove('filter-hidden')
  delete focused.dataset.members
  ui.run('applyFocus()')
  assert.equal(focused.classList.contains('lit'), true)
  state.derived.T004.inputStatus = 'validated_input'
  focused.dataset.members = 'T001,T002'
  ui.run('applyFocus()')
  assert.equal(focused.classList.contains('lit'), true)
  ui.run('POP = {id:"T004"}; fillPop("T004"); togglePopExpand(true)')
  assert.match(ui.nodes.get('#popBody').innerHTML, /Phase plan/)
})

test('seleção de resultados exige identidade consistente e ganho completo usa coordenação opcional zero', async () => {
  const ui = dashboard()
  await ui.run('loadResults()')
  const state = { run: 'A' }
  ui.run('SELECTED_ROOT = "root"; SELECTED_RUN = null; CURRENT_ROOT = null; CURRENT_RUN = null')
  assert.equal(ui.run('resultsStateMatchesSelection(input, "root\\0A", "root\\0A")', { input: state }), true)
  ui.run('SELECTED_ROOT = null; CURRENT_RUN = "A"')
  assert.equal(ui.run('resultsStateMatchesSelection(input, null, null)', { input: state }), false)
  assert.equal(ui.run('resultsStateMatchesSelection(input, "\\0B", "\\0B")', { input: state }), false)
  ui.run('CURRENT_ROOT = "root"')
  assert.equal(ui.run('resultsStateMatchesSelection(input, "other\\0A", "other\\0A")', { input: state }), false)
  const gain = { oneAtATimeMs: 2000, withPrumoMs: 1000, savingsMs: 1000, factor: 2, criticalPathMs: 1000, historyComplete: true, partial: false }
  const summary = ui.run('completedRunGainSummary({anyLive:false,criticalPathMeasured:true}, input, {T1:{state:"done"}}, true, true)', { input: gain })
  assert.equal(summary.measurementComplete, true)
  assert.equal(summary.figures.withoutPrumo, '2s')
  assert.equal(ui.run('completedRunGainSummary(null, null, null, false, false).completed'), false)
})

test('relógio descarta marcos sem timestamp, fora do intervalo e atividade totalmente pausada', () => {
  const ui = dashboard()
  const events = [{ type: 'task_progress', task: 'T1' }, { type: 'task_progress', task: 'T1', at: instant(-1) }, { type: 'task_progress', task: 'T1', at: instant(3) }]
  assert.deepEqual(ui.run('activityTimes("T1", 1, input, ["task_progress"], Date.parse(inputStart), Date.parse(inputEnd))', { input: events, inputStart: instant(0), inputEnd: instant(2) }), [])
  assert.equal(ui.run('latestReviewReceipt(input, 1, Date.parse(inputStart), Date.parse(inputEnd))', { input: { validations: [{ by: 'review' }, { by: 'review', at: instant(-1) }, { by: 'review', at: instant(3) }] }, inputStart: instant(0), inputEnd: instant(2) }), null)
  assert.equal(ui.run('latestReviewActivity({id:"T1"}, 1, Date.parse(inputStart), Date.parse(inputEnd), input)', { input: events.map(e => ({ ...e, type: 'task_review_progress' })), inputStart: instant(0), inputEnd: instant(2) }), null)
  const item = task('T1', 'running', { attempts: [{ startedAt: instant(0) }] })
  const paused = [{ type: 'task_block', task: 'T1', at: instant(0) }, { type: 'task_progress', task: 'T1', at: instant(1) }]
  assert.equal(ui.run('EVENTS_COMPLETE = true; taskClock(input, "running", inputEvents)', { input: item, inputEvents: paused }), null)
  assert.equal(ui.run('jsq(null)'), '')
  assert.equal(ui.run('taskText(null)'), '')
  assert.match(ui.run('taskText("F1a")'), /F1a/)
  assert.match(ui.run('taskReference("T1")'), /T1/)
})

test('layout tolera referência ausente e ciclo sem esconder tarefas e usa largura mínima quando necessário', () => {
  const ui = dashboard('en', 0)
  const state = graphState(2, 1)
  state.tasks.T001.deps = ['T002', 'ausente']
  state.tasks.T002.deps = ['T001']
  ui.run('STATE = input; innerWidth = 0', { input: state })
  const arranged = ui.run('layout(STATE.tasks)')
  assert.equal(Object.keys(arranged.pos).length, 2)
  assert.ok(arranged.w > 0)
  assert.ok(Object.values(arranged.pos).every(p => Number.isFinite(p.x) && Number.isFinite(p.y)))
})

test('catálogo vazio e entradas sem progresso conservam identidade e não fabricam descrição', () => {
  const ui = dashboard()
  ui.run('updateRunDescription(null); selectRun("sem-raiz"); selectRun("/sem-raiz")')
  ui.run('SELECTED_ROOT = "root"; SELECTED_RUN = "run"; selectRun("root/run"); SELECTED_ROOT = SELECTED_RUN = null')
  ui.run('CURRENT_ROOT = "root"; CURRENT_RUN = "run"; updateRunSelect(input)', { input: { currentRoot: 'root', current: 'run', runs: [{ root: 'root', run: 'run', plan: 'run', taskCount: 1 }] } })
  assert.equal(ui.nodes.get('#runLabel').textContent, '')
  assert.match(ui.nodes.get('#runOptions').innerHTML, /0 of 1 tasks/)
  ui.run('STATE = {run:"run", plan:{name:"run"}}; updateRunDescription()')
  assert.equal(ui.nodes.get('#runLabel').textContent, '')
  assert.equal(ui.run('phaseTaskLabel(input)', { input: { id: 'T1', state: 'pending' } }), '')
  ui.run('STATE.derived = {T1:{inputStatus:"future_status"}}')
  assert.equal(ui.run('phaseTaskLabel(input)', { input: { id: 'T1', state: 'pending' } }), 'future_status')
})

test('atividade explícita inválida ou incompleta nunca vira tempo aferido', () => {
  const ui = dashboard()
  const variants = [undefined, [], [{ role: 'execution', startedAt: instant(1), endedAt: instant(0) }],
    [{ role: 'execution', startedAt: 'inválido', endedAt: instant(3) }],
    [{ role: 'execution', startedAt: instant(1) }]]
  for (const intervals of variants) {
    const state = { run: 'sem-medida', createdAt: instant(0), plan: {}, derived: {}, tasks: {
      T1: task('T1', 'done', { phase: '', attempts: [{ activityTiming: 'explicit', activityIntervals: intervals, endedAt: instant(4) }] }),
    }, phaseWorkflows: { F1: { id: 'F1', state: 'pending', planningAttempts: [{ startedAt: instant(1) }] } } }
    const result = ui.run('analyse(input, [], true)', { input: state })
    assert.equal(result.agentTotal, 0)
    assert.equal(result.activeElapsed, 0)
    assert.equal(result.phasePlanning.length, 0)
  }
  const state = { run: 'discussão', plan: {}, derived: {}, tasks: {
    T1: task('T1', 'pending', { discussionAttempts: [{ activityTiming: 'explicit' }] }),
    T2: task('T2', 'pending', { planningAttempts: [{ activityTiming: 'explicit', startedAt: instant(0) }] }),
    T3: task('T3', 'pending', { attempts: [{ startedAt: instant(0), reviewStartedAt: instant(10) }] }),
  }, phaseWorkflows: { F1: { id: 'F1', state: 'pending' } } }
  const result = ui.run('analyse(input, [], false)', { input: state })
  assert.ok(result.per.every(item => item.agentTime === 0 && item.unmeasured))
})

test('navegação ignora gestos incompletos e alvos ausentes e mantém o card dentro da tela', () => {
  const ui = dashboard()
  ui.run('togglePopExpand(); renderAvailable(); focusTask("ausente"); jumpTo("ausente"); openPop("ausente", false); backToGraph()')
  assert.equal(ui.run('POP'), null)
  ui.dispatchElement('#viewport', 'pointermove', { clientX: 1, clientY: 1 })
  ui.dispatchElement('#viewport', 'pointerdown', { button: 2 })
  assert.equal(ui.run('drag'), null)
  ui.dispatchElement('#viewport', 'pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
  ui.dispatchElement('#viewport', 'pointermove', { clientX: 1, clientY: 1 })
  assert.equal(ui.run('drag.moved'), false)
  ui.dispatchElement('#viewport', 'pointermove', { clientX: 20, clientY: 20 })
  ui.run('openPop("ausente", true)')
  assert.equal(ui.run('POP'), null)
  ui.dispatchElement('#viewport', 'pointerup', {})
  ui.render(graphState(2, 1))
  ui.run('suppressClick = false; openPop("T001", false); openPop("T001", false)')
  assert.equal(Boolean(ui.run('POP.pinned')), false)
  ui.run('POP.pinned = true; openPop("T001", false)')
  assert.equal(ui.run('POP.pinned'), true)
  ui.run('innerWidth = 300; positionPop()')
  assert.equal(ui.nodes.get('#pop').style.left, '12px')
  ui.run('POP = {id:"ausente"}; positionPop(); FILTER = "done"; POP = {id:"T001"}; applyFocus()')
  assert.equal(ui.nodes.get('#canvas').classList.contains('focus'), false)
  ui.run('closePop()')
  ui.dispatchDocument('keydown', { key: 'r', target: { tagName: 'INPUT' } })
  ui.dispatchDocument('keydown', { key: 'r', target: { closest: () => ({}) } })
  ui.dispatchDocument('keydown', { key: 'x' })
  assert.equal(ui.run('RESULTS_OPEN'), false)
})

test('polling mantém a última pintura quando catálogo, estado ou histórico estão indisponíveis', async () => {
  const ui = dashboard()
  const state = graphState(1, 1)
  ui.render(state)
  await ui.run('fetch = async () => ({ok:false}); tick()')
  assert.equal(ui.run('STATE.run'), state.run)
  await ui.run('fetch = async () => {throw new Error("offline")}; syncEventHistory(TICK_GENERATION, "offline")')
  assert.equal(ui.run('EVENTS_COMPLETE'), false)
  assert.equal(ui.run('EVENT_SYNCING'), null)
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  ui.run('fetch = () => input', { input: pending })
  const a = ui.run('syncEventHistory(TICK_GENERATION, "same")')
  const b = ui.run('syncEventHistory(TICK_GENERATION, "same")')
  finish({ ok: true, json: async () => ({ events: [], complete: true, total: 0 }) })
  assert.deepEqual(await Promise.all([a,b]), [true,true])
  await ui.run('fetch = async () => ({ok:false}); loadIdentity()')
  assert.match(ui.nodes.get('#identity').textContent, /Package identity unavailable/)
})

test('formatadores preservam contratos estruturados, decisões de fase e recibos sem metadados', () => {
  const ui = dashboard()
  assert.equal(ui.run('contractText(null)'), '')
  assert.equal(ui.run('contractText(input)', { input: { run: 'verificar' } }), 'verificar')
  assert.equal(ui.run('contractText(input)', { input: [{ run: 'verificar', expect: 'ok' }, { kind: 'manual' }] }), 'verificar → ok\n{"kind":"manual"}')
  assert.equal(ui.run('fmtContract(input)', { input: { kind: '<manual>' } }), '{&quot;kind&quot;:&quot;&lt;manual&gt;&quot;}')
  assert.equal(ui.run('fmtContract(input)', { input: { run: 'verificar' } }), '<code>verificar</code>')
  assert.equal(ui.run('firstLines(null)'), '')
  assert.equal(ui.run('validationHistory()'), '<span class="empty">—</span>')
  assert.match(ui.run('validationHistory(input)', { input: [{ ok: true }, { ok: false, agent: '<revisor>' }] }), /Approved.*Rejected.*@&lt;revisor&gt;/s)
  assert.equal(ui.run('attemptReview(input, attempt)', { input: {}, attempt: { startedAt: instant(0) } }), undefined)
  assert.match(ui.run('fmtDiscovery(input)', { input: {} }), /Task discovery/)
  ui.run('STATE = {questionResolutions: input}', { input: [{ questionRef: 'Q', answer: 'preservar', byPhase: 'F2' }] })
  const questions = [
    { questionRef: 'Q', question: 'fase?', decideBy: { beforePhase: 'F3' } },
    { question: 'sem responsável?', decideBy: {} },
    { question: 'pendente?', blocking: false },
  ]
  const markup = ui.run('fmtTaskPlan(input, resources)', { input: { openQuestions: questions }, resources: ['arquivo externo'] })
  assert.match(markup, /before phase F3.*resolved by F2/s)
  assert.match(markup, /sem responsável\? \(non-blocking · due executor\)/)
  assert.match(markup, /arquivo externo/)
})

test('histórico usa executor quando recibo ou papel estão ausentes e conserva atualizações desconhecidas', () => {
  const ui = dashboard()
  ui.run('STATE = input', { input: { tasks: {} } })
  assert.match(ui.run('eventSentence(input)', { input: { type: 'task_start', task: 'T1' } }), /started task/)
  assert.match(ui.run('eventSentence(input)', { input: { type: 'task_check', task: 'T1', by: 'review', kind: 'manual', status: 'future' } }), /Reviewer.*updated the manual check/s)
  assert.match(ui.run('eventSentence(input)', { input: { type: 'task_validation_started', task: 'T1', token: 'missing' } }), /Executor.*began validation/s)
  assert.match(ui.run('eventSentence(input)', { input: { type: 'slot_freed', next: 'T1' } }), /freed an execution slot; next authorized:/)
  assert.equal(ui.run('validationForEvent(input)', { input: { type: 'task_validate', task: 'T1', by: 'review', ok: true } }), undefined)
  assert.equal(ui.run('eventDetail(input)', { input: { type: 'task_validate', ok: false, summary: { toJSON() {} } } }), '')
  assert.match(ui.run('tr(input, 2)', { input: '{0} tasks' }), /2 tasks/)
})

test('card expandido conserva decisões, dispensas, bloqueios e dependências ausentes sem inventar dados', () => {
  const ui = dashboard()
  const state = graphState(2, 1)
  state.tasks.T001 = task('T001', 'skipped', {
    phase: '', deps: ['inexistente', 'T002'], skipReason: '<dispensa>', blockQuestion: 'Qual opção?',
    discussionSkips: [{ reason: 'discussão dispensada' }], planningSkips: [{ reason: 'plano dispensado' }],
    planningAttempts: [{ n: 1, startedAt: instant(0), agent: 'planejador' }, { n: 2, startedAt: instant(5), endedAt: instant(8), result: 'planned' }],
    blockHistory: [{ at: instant(0) }, { at: instant(2), reason: 'aguardar', question: 'prosseguir?', answer: 'sim' }],
  })
  state.derived.T001.effective = 'skipped'
  ui.run('STATE = input; fillPop("ausente"); fillPop("T001")', { input: state })
  assert.match(ui.nodes.get('#popBody').innerHTML, /Qual opção\?.*&lt;dispensa&gt;/s)
  ui.run('POP = {id:"T001"}; togglePopExpand(true)')
  const markup = ui.nodes.get('#popBody').innerHTML
  assert.match(markup, /discussão dispensada.*plano dispensado/s)
  assert.match(markup, /Planning attempts.*#1.*planning.*#2/s)
  assert.match(markup, /Block history.*prosseguir\?.*Answer: sim/s)
  assert.match(markup, /inexistente/)
  state.tasks.T001.blockOptions = ['sim', 'não']
  ui.run('fillPop("T001")')
  assert.match(ui.nodes.get('#popBody').innerHTML, /Options: sim \/ não/)
})

function dashboard(lang = 'en', width = 1000, session = new Map(), navigation = { state: null, urls: [] }, options = {}) {
  const nodes = new Map(), cards = [], paths = []
  const documentListeners = new Map(), windowListeners = new Map()
  let viewportWidth = width, viewportHeight = 700, animationFrame = null
  const element = (initialClasses = []) => {
    const classes = new Set(initialClasses)
    const attributes = new Map()
    const listeners = new Map()
    let markup = ''
    return {
      textContent: '', dataset: {}, open: false, hidden: false, style: { setProperty(name, value) { this[name] = value } },
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)) },
        remove(...names) { names.forEach((name) => classes.delete(name)) },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force)
          if (enabled) classes.add(name); else classes.delete(name)
          return enabled
        },
        contains(name) { return classes.has(name) },
      },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, [])
        listeners.get(type).push(listener)
      },
      dispatchEvent(type, event) {
        for (const listener of listeners.get(type) ?? []) listener(event)
      },
      setPointerCapture() {},
      scrollIntoView() {},
      querySelector() { return element() },
      querySelectorAll() { return [] },
      setAttribute(name, value) { attributes.set(name, String(value)) },
      removeAttribute(name) { attributes.delete(name) },
      getAttribute(name) { return attributes.get(name) ?? null },
      offsetWidth: 280, offsetHeight: 300,
      getBoundingClientRect: () => ({ width: 1000, height: 700, left: 0, right: 1000, top: 0 }),
      get innerHTML() { return markup },
      set innerHTML(value) { markup = String(value) },
    }
  }
  const materialize = (markup, tag, target) => {
    target.length = 0
    const pattern = new RegExp(`<${tag}\\b([^>]*)>`, 'g')
    const sources = [...markup.matchAll(pattern)]
    const cardSize = [Number.parseFloat(nodes.get('#canvas')?.style['--node-w']) || 200,
      Number.parseFloat(nodes.get('#canvas')?.style['--node-h']) || 64]
    for (const [, source] of sources) {
      const attrs = Object.fromEntries([...source.matchAll(/([:\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))
      const initialClasses = (attrs.class ?? '').split(/\s+/).filter(Boolean)
      if (tag === 'div' && !initialClasses.includes('node')) continue
      const item = element(initialClasses)
      for (const [name, value] of Object.entries(attrs)) {
        item.setAttribute(name, value)
        if (name.startsWith('data-')) item.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
      }
      for (const declaration of (attrs.style ?? '').split(';')) {
        const [name, value] = declaration.split(':')
        if (name?.trim()) item.style[name.trim()] = value?.trim() ?? ''
      }
      if (tag === 'div') item.getBoundingClientRect = () => {
        const left = Number.parseFloat(item.style.left) || 0
        const top = Number.parseFloat(item.style.top) || 0
        const [width, height] = cardSize
        return { left, right: left + width, top, bottom: top + height, width, height }
      }
      target.push(item)
    }
  }
  const labels = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(([, key]) => {
    const node = element()
    node.dataset.i18n = key.replaceAll('&amp;', '&')
    return node
  })
  const filterMarkup = html.match(/<div[^>]+id="statusFilter"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ''
  const filterOptions = [...filterMarkup.matchAll(/<button\b([^>]*data-filter-value="([^"]+)"[^>]*)>/g)].map(([, source, filterValue]) => {
    const option = element()
    option.dataset.filterValue = filterValue
    option.setAttribute('aria-pressed', source.match(/aria-pressed="([^"]+)"/)?.[1] ?? 'false')
    return option
  })
  const querySelectorAll = (selector) => {
    if (selector === '[data-i18n]') return labels
    if (selector === '#statusFilter [data-filter-value]') return filterOptions
    if (selector === '.node' || selector === '#nodes .node') return cards
    if (selector === '.node.lit, .node.lit-self' || selector === '#nodes .node.lit, #nodes .node.lit-self') return cards.filter((node) => node.classList.contains('lit') || node.classList.contains('lit-self'))
    if (selector === '#edgePaths path') return paths
    if (selector === '#edgePaths path.lit') return paths.filter((path) => path.classList.contains('lit'))
    return []
  }
  const guideDemo = options.guideDemo ? `?guide-demo=${options.guideDemo}` : ''
  const location = { search: guideDemo, origin: 'http://localhost', href: `http://localhost/${guideDemo}` }
  const context = {
    document: {
      documentElement: element(),
      querySelector(selector) {
        const cardId = selector.match(/^\.node\[data-id="([^"]+)"\]$/)?.[1]
        if (cardId) return cards.find((node) => node.dataset.id === cardId) ?? null
        if (!nodes.has(selector)) {
          const node = element()
          if (selector === '#filterPanel') node.hidden = true
          if (selector === '#filterToggle') node.setAttribute('aria-expanded', 'false')
          if (['#summaryToggle', '#agentsToggle', '#availableToggle', '#eventsToggle'].includes(selector)) node.setAttribute('aria-expanded', 'true')
          if (selector === '#nodes' || selector === '#edgePaths') {
            const target = selector === '#nodes' ? cards : paths
            const tag = selector === '#nodes' ? 'div' : 'path'
            Object.defineProperty(node, 'innerHTML', {
              get() { return node._markup ?? '' },
              set(value) { node._markup = String(value); materialize(node._markup, tag, target) },
            })
          }
          if (selector === '#viewport') node.getBoundingClientRect = () =>
            ({ width: viewportWidth, height: viewportHeight, left: 0, right: viewportWidth, top: 0 })
          nodes.set(selector, node)
        }
        return nodes.get(selector)
      },
      querySelectorAll,
      addEventListener(name, listener) {
        if (!documentListeners.has(name)) documentListeners.set(name, [])
        documentListeners.get(name).push(listener)
      },
    },
    location,
    history: {
      get state() { return navigation.state },
      replaceState(state, _unused, url) {
        navigation.state = state
        if (url !== undefined) {
          location.href = String(url)
          location.search = new URL(location.href).search
          navigation.urls.push(location.href)
        }
      },
    },
    localStorage: options.localStorage ?? { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: (key) => session.get(key) ?? null, setItem: (key, value) => session.set(key, value) },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    URL, URLSearchParams,
    innerWidth: width + 330, innerHeight: 800,
    performance: { now: () => 0 }, CSS: { escape: (text) => text },
    matchMedia: undefined,
    addEventListener(name, listener) {
      if (!windowListeners.has(name)) windowListeners.set(name, [])
      windowListeners.get(name).push(listener)
    },
    requestAnimationFrame(callback) { animationFrame = callback; return 1 },
    setTimeout() {}, clearTimeout() {},
    Date: class extends Date { static now() { return Date.parse(instant(100)) } },
  }
  context.globalThis = context
  context.window = context
  // Executa a fonte canônica com o idioma injetado sem alterar offsets; no modo
  // renderOnly o boot fica em ramo impossível e continua descoberto até o
  // cenário fullboot exercitar esse caminho real.
  const script = injectDashboardLanguage(canonicalScript, lang)
  const runtimeScript = options.full ? script : disableDashboardBoot(script)
  const runtime = runDashboardScript(runtimeScript, context, { sourceScript: canonicalScript })
  return {
    nodes, labels, cards, paths, filterOptions,
    run(code, values = {}) { return runtime.run(code, values) },
    dispatchDocument(type, event, inline = () => {}) {
      inline()
      for (const listener of documentListeners.get(type) ?? []) listener(event)
    },
    dispatchElement(selector, type, event) { nodes.get(selector)?.dispatchEvent(type, event) },
    render(state, events = []) { this.run('STATE = input; render(STATE, inputEvents)', { input: state, inputEvents: events }) },
    flushFrame(nextWidth = viewportWidth) {
      viewportWidth = nextWidth
      const callback = animationFrame
      animationFrame = null
      callback?.()
    },
    resize(nextWidth, nextHeight = viewportHeight) {
      viewportWidth = nextWidth
      viewportHeight = nextHeight
      context.innerWidth = nextWidth + 330
      context.innerHeight = nextHeight + 100
      for (const listener of windowListeners.get('resize') ?? []) listener()
      const callback = animationFrame
      animationFrame = null
      callback?.()
    },
  }
}

function graphState(count, phaseCount = 4) {
  const phases = Array.from({ length: phaseCount }, (_, i) => ({ id: `P${i + 1}`, title: `Phase ${i + 1}` }))
  const tasks = Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const id = `T${String(i + 1).padStart(3, '0')}`
    return [id, task(id, i === 0 ? 'running' : 'pending', { phase: phases[i % phaseCount]?.id ?? 'P1' })]
  }))
  return { run: `fixture-${count}`, plan: { phases }, tasks,
    derived: Object.fromEntries(Object.keys(tasks).map((id) => [id, { effective: tasks[id].state, blockedBy: [] }])) }
}

test('waiting cards identify the blocking phase even without their own task dependencies', () => {
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    const state = graphState(1, 1)
    state.tasks.T001.state = 'pending'
    state.derived.T001 = { effective: 'waiting', blockedBy: [], planningBlockedBy: ['F2'] }
    ui.render(state)
    assert.match(ui.nodes.get('#nodes').innerHTML, /title="[^"]*← F2/)
  }
})

test('dashboard marks declared manual inspection as pending and displays plan writes and required resources', () => {
  for (const [lang, pending, requires, writes] of [
    ['en', 'Manual inspection pending', 'Requires: manual-inspection', 'Writes'],
    ['pt-BR', 'Inspeção manual pendente', 'Requer: manual-inspection', 'Caminhos declarados para escrita'],
  ]) {
    const ui = dashboard(lang)
    const state = graphState(1, 1)
    const taskValue = state.tasks.T001
    taskValue.unavailable = ['manual-inspection']
    taskValue.taskPlan = { ...plan, writes: ['src/report.mjs'], verification: [
      { criterion: 'the report is checked', check: 1, requires: ['manual-inspection'] },
    ] }
    state.derived.T001.manualInspectionPending = true
    ui.render(state)
    assert.ok(ui.nodes.get('#nodes').innerHTML.includes(pending))
    ui.run("POP_EXPANDED = true; fillPop('T001')")
    const detail = ui.nodes.get('#popBody').innerHTML
    assert.ok(detail.includes(pending))
    assert.ok(detail.includes(requires))
    assert.ok(detail.includes(writes))
    assert.ok(detail.includes('src/report.mjs'))
  }
})

test('dashboard footer shows only the package version, with an unavailable fallback', async () => {
  assert.match(html, /<footer>[\s\S]*<div id="bar"[^>]*><div class="seg-done"><\/div><div class="seg-discussing">/)
  assert.match(html, /footer \.n \{[^}]*font-size: 11\.5px/)
  assert.match(html, /footer #identity \{[^}]*font-size: 11\.5px[^}]*border-left: 1px solid var\(--line\)/)
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    const about = { version: '2.0.0', origin: 'global', contentId: 'a1b2c3d4e5f6', path: 'C:\\Prumo\\global\\package' }
    await ui.run('loadIdentity()', { fetch: async url => {
      assert.equal(url, '/api/about')
      return { ok: true, json: async () => about }
    } })
    const identity = ui.nodes.get('#identity')
    const expected = 'prumo v2.0.0'
    assert.equal(identity.textContent, expected)
    assert.equal(identity.getAttribute('title'), expected)
    assert.equal(identity.getAttribute('aria-label'), expected)

    const unavailable = dashboard(lang)
    await unavailable.run('loadIdentity()', { fetch: async () => { throw new Error('offline') } })
    assert.equal(unavailable.nodes.get('#identity').textContent, unavailable.run("tr('Package identity unavailable')"))
  }
})

test('dashboard footer uses an unknown version when the package version is missing or invalid', async () => {
  for (const version of [undefined, '', 2.1, {}]) {
    const ui = dashboard('en')
    await ui.run('loadIdentity()', { fetch: async () => ({
      ok: true,
      json: async () => ({ version, origin: 'global', contentId: 'a1b2c3d4e5f6', path: 'C:\\Prumo\\global\\package' }),
    }) })
    const identity = ui.nodes.get('#identity')
    assert.equal(identity.textContent, 'prumo vunknown')
    assert.equal(identity.getAttribute('title'), 'prumo vunknown')
    assert.equal(identity.getAttribute('aria-label'), 'prumo vunknown')
  }
})

test('dashboard footer shows only the version for a source checkout', async () => {
  for (const lang of ['en', 'pt-BR']) {
    for (const about of [
      { version: '2.0.0', origin: 'repository', commit: '641017a', contentId: 'a1b2c3d4e5f6', path: 'C:\\src\\prumo' },
      { version: '2.0.0', origin: 'repository', contentId: 'a1b2c3d4e5f6', path: 'C:\\src\\prumo' },
      { version: '2.0.0', origin: 'repository', commit: '<b>x</b>', contentId: 'a1b2c3d4e5f6', path: 'C:\\src\\prumo' },
    ]) {
      const ui = dashboard(lang)
      await ui.run('loadIdentity()', { fetch: async () => ({ ok: true, json: async () => about }) })
      const text = ui.nodes.get('#identity').textContent
      assert.equal(text, 'prumo v2.0.0')
    }
  }
})

test('dashboard renders separate planning queues, active planner hub and execution readiness in both languages', () => {
  assert.match(html, /\.node \.tag\.queued \.tr \{[^}]*white-space: normal; overflow: visible; text-overflow: clip; text-transform: none/)
  assert.doesNotMatch(html, /\.node \.id[^}]*text-transform: lowercase/)
  const tasks = {
    P: task('P', 'pending', { planningRequired: true }),
    A: task('A', 'planning', { planner: 'planner-1', planningAttempts: [{ startedAt: instant(10), agent: 'planner-1' }] }),
    E: task('E', 'pending', { planningRequired: true, planner: 'planner-1', taskPlan: plan }),
    W: task('W', 'pending', { deps: ['R'] }),
    R: task('R', 'running', { agent: 'executor-1', attempts: [{ startedAt: instant(10) }] }),
    V: task('V', 'reviewing', { reviewer: 'reviewer-1', attempts: [{ startedAt: instant(10), reviewStartedAt: instant(30) }] }),
    D: task('D', 'done'), F: task('F', 'failed'), B: task('B', 'blocked'), S: task('S', 'skipped'),
  }
  const states = { P: 'ready_to_plan', A: 'planning', E: 'ready', W: 'waiting', R: 'running', V: 'reviewing', D: 'done', F: 'failed', B: 'blocked', S: 'skipped' }
  const state = { run: 'planning-test', plan: { phases: [{ id: 'P1', title: 'Phase 1' }] }, tasks,
    derived: Object.fromEntries(Object.entries(states).map(([id, effective]) => [id, { effective, blockedBy: tasks[id].deps }])) }
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    ui.render(state)
    const expected = lang === 'en' ? ['ready for planning', 'planning', 'ready for execution'] : ['pronto para planejar', 'em planejamento', 'pronto para executar']
    for (const label of expected) {
      assert.ok(ui.nodes.get('#counts').innerHTML.includes(`${label === 'planning' ? 'Actively planning' : label === 'em planejamento' ? 'Planejando' : label.charAt(0).toLocaleUpperCase(lang) + label.slice(1)}</span> <b>${['planning', 'em planejamento'].includes(label) ? '1/3' : '1'}</b>`), `Counter: ${label}`)
    }
    for (const [id, status] of Object.entries(states)) {
      assert.match(ui.nodes.get('#nodes').innerHTML, new RegExp(`data-st="${status}"[^>]*data-id="${id}"`))
      ui.run('fillPop(id)', { id })
      assert.equal(ui.nodes.get('#popStatus').textContent, ui.run('cardStateLabel(status)', { status }))
    }
    const colors = ui.run("['ready_to_plan', 'planning', 'ready'].map(s => ST_COLOR[s])")
    assert.equal(new Set(colors).size, 3)
    const values = colors.map((cssVar) => html.match(new RegExp(`${cssVar.slice(4, -1)}: (#[a-f0-9]+)`))[1])
    assert.deepEqual([...values], ['#8a7bd6', '#b69cff', '#f5b58a'])
    assert.notEqual(ui.run('ST_COLOR.ready_for_discussion'), ui.run('ST_COLOR.discussing'), 'a queued discussion must not look like one in progress')
    assert.match(ui.nodes.get('#parallel').innerHTML, /class="plan"[^>]*openTask\('A'\)[\s\S]*@planner-1/)
    assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML, /openTask\('[PEWDFBS]'\)/)
    assert.match(ui.nodes.get('#planSub').textContent, /1: A/)
    assert.equal(ui.nodes.get('#planNode').classList.contains('live'), true)
    assert.doesNotMatch(ui.nodes.get('#edgePaths').innerHTML, /data-from="__/, 'roles light up in the hub; only dependencies draw lines')
    assert.equal(ui.nodes.get('#bar .seg-done').style.width, `${100 / 9}%`)
    for (const status of ['planning', 'running', 'reviewing']) assert.equal(ui.nodes.get(`#bar .seg-${status}`).style.width, `${100 / 9}%`)
    assert.ok(Number.parseFloat(ui.nodes.get('#planNode').style.left) >= 0)
  }
})

test('dashboard observes phase discussion, phase planning and per-task input readiness in both languages', () => {
  const tasks = {
    A: task('A', 'pending', { phase: 'F1', deps: ['C'], planningRequired: true,
      taskPlan: { ...plan, phaseId: 'F1', unresolvedInputs: [{ task: 'C', phase: 'F2', requiredEvidence: 'validated output' }] } }),
    B: task('B', 'pending', { phase: 'F1', planningRequired: true, taskPlan: { ...plan, phaseId: 'F1', unresolvedInputs: [] } }),
    C: task('C', 'pending', { phase: 'F2', planningRequired: true }),
  }
  const state = { run: 'phase-observer', plan: { planningMode: 'phase', maxParallel: 4,
    phases: [{ id: 'F1', title: 'Consumers' }, { id: 'F2', title: 'Producer' }] }, tasks,
    phaseWorkflows: {
      F1: { id: 'F1', state: 'discussing', discussionAttempts: [{ targets: ['A', 'B'] }], planningAttempts: [] },
      F2: { id: 'F2', state: 'planning', discussionAttempts: [{ targets: ['C'] }], planningAttempts: [{ targets: ['C'] }] },
    },
    derived: {
      A: { effective: 'discussing', blockedBy: ['C'], planningStatus: 'phase_discussing', inputStatus: 'unresolved_later_phase_input' },
      B: { effective: 'discussing', blockedBy: [], planningStatus: 'phase_discussing' },
      C: { effective: 'planning', blockedBy: [], planningStatus: 'phase_planning' },
    } }
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang); ui.render(state)
    assert.match(ui.nodes.get('#orchSub').textContent, lang === 'en' ?
      /phase discussion F1: 2 tasks.*phase execution locked/ : /discussão da fase F1: 2 tarefas.*execução da fase bloqueada/)
    assert.match(ui.nodes.get('#planSub').textContent, lang === 'en' ? /phase planning F2: 1 tasks/ : /planejamento da fase F2: 1 tarefas/)
    assert.match(ui.nodes.get('#lanes').innerHTML, lang === 'en' ? /discussion · orchestrator/ : /discussão · orquestrador/)
    assert.match(ui.nodes.get('#lanes').innerHTML, lang === 'en' ? /Active time not measured/ : /tempo ativo não aferido/)
    assert.match(ui.nodes.get('#lanes').innerHTML, /lane-state planning/)
    assert.match(ui.nodes.get('#nodes').innerHTML, lang === 'en' ? /unresolved later-phase input/ : /entrada de fase posterior não resolvida/)
    state.derived.A.inputStatus = 'unresolved_input'
    ui.render(state)
    assert.match(ui.nodes.get('#nodes').innerHTML, lang === 'en' ? /unresolved input/ : /entrada não resolvida/)
    state.derived.A.inputStatus = 'unresolved_later_phase_input'
    assert.match(ui.nodes.get('#nodes').innerHTML, /data-st="planning"[^>]*data-id="C"/)
    const planningLabel = lang === 'en' ? 'planning' : 'em planejamento'
    const plannerLabel = lang === 'en' ? 'planner' : 'planejador'
    assert.match(ui.nodes.get('#nodes').innerHTML, new RegExp(`aria-label="C: ${planningLabel}"`))
    assert.doesNotMatch(ui.nodes.get('#nodes').innerHTML, new RegExp(`aria-label="C: ${planningLabel} · ${plannerLabel}"`),
      'the phase owns the planner relationship; member cards expose only their active state')
    assert.match(ui.nodes.get('#nodes').innerHTML, /data-st="discussing"[^>]*data-id="A"/,
      'an open phase discussion owns the active visual state before execution readiness')
    assert.equal(ui.nodes.get('#orchNode').classList.contains('discussing'), true)
    assert.equal(ui.nodes.get('#planNode').classList.contains('live'), true)
    assert.doesNotMatch(ui.nodes.get('#edgePaths').innerHTML, /__phase-/,
      'the phase board carries its own state pill; no role line crosses the board')
  }
  assert.doesNotMatch(html, /fetch\([^)]*begin-phase|onclick="[^"]*phase-(?:discussion|planning)/,
    'phase workflow remains observer-only')
})

test('summary counts include discussion and legacy pending tasks', () => {
  const tasks = { A: task('A'), B: task('B', 'discussing'), C: task('C'), D: task('D', 'done') }
  const derived = Object.fromEntries(Object.entries({ A: 'ready_for_discussion', B: 'discussing', C: 'pending', D: 'done' })
    .map(([id, effective]) => [id, { effective, blockedBy: [] }]))
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    ui.render({ run: 'summary', plan: { phases: [] }, tasks, derived })
    const summary = ui.nodes.get('#counts').innerHTML
    assert.equal([...summary.matchAll(/<b>(\d+)(?:\/\d+)?<\/b>/g)].reduce((sum, match) => sum + Number(match[1]), 0), 4)
    for (const state of ['ready_for_discussion', 'discussing', 'waiting']) {
      assert.ok(summary.includes(state === 'discussing' ? (lang === 'en' ? 'Actively discussing' : 'Discutindo') : ui.run('statusLabel(value)', { value: state }).replace(/^./, char => char.toLocaleUpperCase(lang))), state)
    }
    assert.doesNotMatch(summary, /color:undefined/)
  }
})

test('concluidas excluem puladas do total de tarefas validas', () => {
  const ui = dashboard('pt-BR')
  const tasks = Object.fromEntries(Array.from({ length: 29 }, (_, index) => {
    const id = `T${index + 1}`
    return [id, task(id, index < 23 ? 'done' : index === 28 ? 'skipped' : 'pending')]
  }))
  const state = { run: 'concluidas-total', plan: { phases: [] }, tasks,
    derived: Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, { effective: task.state }])) }
  ui.render(state)
  assert.match(ui.nodes.get('#counts').innerHTML, /No Prumo<\/span> <b>23\/28<\/b>/)
  ui.run("setFilter('done')")
  assert.match(ui.nodes.get('#counts').innerHTML, /No Prumo<\/span> <b>23\/28<\/b>/, 'o filtro não reduz o total do plano')
  ui.render({ run: 'vazio', plan: { phases: [] }, tasks: {}, derived: {} })
  assert.match(ui.nodes.get('#counts').innerHTML, /No Prumo<\/span> <b>0\/0<\/b>/)
})

test('13 concluidas e uma pulada mostram 13 de 13 e o resumo existe em planos grandes', () => {
  for (const size of [14, 30, 110]) {
    const ui = dashboard('pt-BR')
    const tasks = Object.fromEntries(Array.from({ length: size }, (_, index) => [`T${index + 1}`, task(`T${index + 1}`, index < 13 ? 'done' : 'skipped')]))
    const state = { run: 'totais-validos', plan: { phases: [] }, tasks, derived: {} }
    ui.render(state)
    assert.match(ui.nodes.get('#counts').innerHTML, /No Prumo<\/span> <b>13\/13<\/b>/)
    assert.match(ui.nodes.get('#lanes').innerHTML, /class="run-sum" style="top:\d+px"/)
    assert.match(ui.nodes.get('#lanes').innerHTML, /13 de 13 no prumo/)
    const boardLayout = ui.run('layout(STATE.tasks)')
    const lastCardBottom = Math.max(...Object.values(boardLayout.pos).map(position => position.y)) + boardLayout.metrics.nodeH
    assert.ok(boardLayout.sumY > lastCardBottom)
    assert.ok(boardLayout.h > boardLayout.sumY + 60)
    ui.run("setFilter('skipped')")
    assert.match(ui.nodes.get('#counts').innerHTML, /<b>13\/13<\/b>/)
    const last = Object.values(state.tasks).at(-1)
    last.state = 'pending'
    ui.render(state)
    assert.match(ui.nodes.get('#counts').innerHTML, /<b>13\/14<\/b>/)
    assert.match(ui.nodes.get('#lanes').innerHTML, /13 de 14 no prumo/)
  }
})

test('comandos registrados permanecem abertos no tick e resetam ao trocar de plano', () => {
  const ui = dashboard('pt-BR')
  const state = { run: 'aberto', plan: {}, tasks: {}, derived: {} }
  ui.run('STATE = input; EVENTS_COMPLETE = true; renderResults(input)', { input: state })
  ui.run("$('#results .manual-commands').open = true; $('#results').scrollTop = 180; renderResults(STATE)")
  assert.equal(ui.run("$('#results .manual-commands').open"), true)
  assert.equal(ui.run("$('#results').scrollTop"), 180)
  ui.run('renderResults(input)', { input: { ...state, run: 'outro' } })
  assert.equal(ui.run("$('#results').scrollTop"), 0)
})

test('papeis ativos sem intervalos registrados mostram nao aferido em vez de zero', () => {
  const ui = dashboard('pt-BR')
  const state = { run: 'sem-registros', plan: {}, tasks: { A: task('A', 'running'), B: task('B', 'reviewing'), C: task('C', 'planning'), D: task('D', 'discussing') }, derived: {} }
  ui.run('STATE = input; EVENTS_COMPLETE = true; renderResults(input)', { input: state })
  const activity = ui.nodes.get('#results').innerHTML.split('class="gcard agent-activity"')[1].split('</section>')[0]
  assert.equal((activity.match(/<strong>Não aferido<\/strong>/g) ?? []).length, 4)
  assert.doesNotMatch(activity, /<strong>0s<\/strong>/)
})

test('height-only resize keeps the untouched board at 100% anchored at the top', () => {
  const ui = dashboard('en', 1000)
  ui.render(graphState(48, 8))
  ui.resize(1000, 350)
  assert.equal(ui.run('VIEW.k'), 1)
  assert.equal(ui.run('VIEW.y'), 0)
})

test('dashboard keeps an unadopted legacy phase pending until explicit adoption', () => {
  const state = { run: 'legacy-phase', plan: { planningMode: 'phase', phases: [{ id: 'F1', title: 'Adopted' }, { id: 'F2', title: 'Legacy' }] },
    legacyPhaseAdoption: true,
    phaseWorkflows: {
      F1: { id: 'F1', state: 'planned', adoptedLegacy: true, discussionAttempts: [], planningAttempts: [] },
      F2: { id: 'F2', state: 'pending', discussionAttempts: [], planningAttempts: [] },
    },
    tasks: { B: task('B', 'pending', { phase: 'F2', planningRequired: true }) },
    derived: { B: { effective: 'pending', blockedBy: [], planningStatus: 'awaiting_phase_adoption' } } }
  for (const [lang, label] of [['en', 'awaiting phase adoption'], ['pt-BR', 'aguardando adoção da fase']]) {
    const ui = dashboard(lang)
    ui.render(state)
    const card = ui.cards.find(node => node.dataset.id === 'B')
    assert.equal(card.dataset.st, 'pending')
    assert.match(ui.nodes.get('#nodes').innerHTML, new RegExp(label))
    assert.doesNotMatch(ui.nodes.get('#nodes').innerHTML, /ready for discussion|pronto para discussão|ready for execution|pronto para executar/)
  }
})

test('status filters use effective state and always show only direct dependency context', () => {
  assert.ok(html.indexOf('.node.filtered-out') > html.indexOf('.node[data-st="skipped"]'),
    'filter opacity must override every task-state opacity')
  const tasks = {
    A: task('A', 'done'),
    B: task('B', 'pending', { deps: ['A'] }),
    C: task('C', 'pending', { deps: ['B'] }),
    D: task('D', 'pending', { deps: ['C'] }),
    P: task('P', 'pending', { planningRequired: true }),
    L: task('L', 'planning'), E: task('E'), R: task('R', 'reviewing'),
    K: task('K', 'blocked'), F: task('F', 'failed'), S: task('S', 'skipped'), U: task('U', 'future_state'),
  }
  const effective = { A: 'done', B: 'running', C: 'waiting', D: 'pending', P: 'ready_to_plan', L: 'planning',
    E: 'ready', R: 'reviewing', K: 'blocked', F: 'failed', S: 'skipped', U: 'future_state' }
  const state = { run: 'filters', plan: { phases: [{ id: 'P1', title: 'Phase 1' }] }, tasks,
    derived: Object.fromEntries(Object.entries(effective).map(([id, value]) => [id, { effective: value, blockedBy: tasks[id].deps }])) }
  const ui = dashboard()
  ui.render(state)
  const matches = (filter) => ui.run("JSON.stringify([...filterSets(STATE.tasks, inputFilter).matches].sort())", { inputFilter: filter })
  const allowed = (filter) => ui.run("JSON.stringify([...filterSets(STATE.tasks, inputFilter).allowed].sort())", { inputFilter: filter })
  const card = (id) => ui.cards.find((node) => node.dataset.id === id)
  const edge = (from, to) => ui.paths.find((path) => path.dataset.from === from && path.dataset.to === to)
  const hidden = (from, to) => !edge(from, to) || edge(from, to).classList.contains('filter-hidden')
  const expected = {
    done: ['A'], incomplete: ['B', 'C', 'D', 'E', 'F', 'K', 'L', 'P', 'R', 'U'], waiting: ['C', 'D'],
    ready_to_plan: ['P'], planning: ['L'], ready: ['E'], running: ['B'], reviewing: ['R'],
    blocked: ['K'], failed: ['F'], skipped: ['S'],
  }
  assert.equal(matches('all'), JSON.stringify(Object.keys(tasks).sort()))
  for (const [filter, ids] of Object.entries(expected)) assert.equal(matches(filter), JSON.stringify(ids), filter)
  assert.equal(allowed('all'), JSON.stringify(Object.keys(tasks).sort()), 'no filter adds no context')
  assert.equal(allowed('running'), JSON.stringify(['A', 'B']))
  assert.equal(ui.run("JSON.stringify([...filterSets(STATE.tasks, 'missing').matches])"), '[]')

  assert.equal(ui.cards.length, Object.keys(tasks).length)
  for (const endpoints of [['A', 'B'], ['B', 'C'], ['C', 'D']])
    assert.ok(edge(...endpoints), endpoints.join(' → '))
  const originalState = JSON.stringify(state)
  assert.equal(hidden('A', 'B'), true, 'the unfiltered graph keeps its prior dependency visibility')

  ui.run("setFilter('running')")
  assert.equal(card('B').classList.contains('filtered-out'), false)
  assert.equal(card('A').classList.contains('filtered-out'), false)
  assert.equal(card('A').classList.contains('dependency-context'), true)
  assert.equal(card('B').classList.contains('dependency-context'), false)
  assert.equal(card('C').classList.contains('filtered-out'), true)
  assert.equal(ui.nodes.get('#filterCount').textContent, '01/12')
  assert.equal(hidden('A', 'B'), false)
  assert.equal(edge('A', 'B').classList.contains('context-edge'), true)
  assert.equal(hidden('B', 'C'), true)
  assert.equal(hidden('C', 'D'), true)

  ui.run("setFilter('incomplete')")
  assert.equal(card('B').classList.contains('filtered-out'), false)
  assert.equal(card('C').classList.contains('filtered-out'), false)
  assert.equal(hidden('B', 'C'), false, 'dependencies remain visible when both endpoints match the filter')
  assert.equal(edge('B', 'C').classList.contains('context-edge'), false)
  assert.equal(edge('A', 'B').classList.contains('context-edge'), true, 'direct dependencies outside the filter stay dimmed')

  ui.run("setFilter('running')")
  ui.run("openTask('B'); setFilter('reviewing')")
  assert.equal(ui.run('POP === null'), true)
  assert.equal(ui.nodes.get('#pop').classList.contains('open'), false)

  ui.run("setFilter('running')")
  assert.equal(card('D').classList.contains('filtered-out'), true)
  assert.equal(JSON.stringify(state), originalState, 'filtering must not rewrite any task or dependency')
  ui.run("openTask('B')")
  assert.deepEqual(ui.cards.filter((node) => node.classList.contains('lit')).map((node) => node.dataset.id).sort(), ['A', 'B'])
  assert.equal(card('B').classList.contains('lit-self'), true)
  assert.equal(edge('A', 'B').classList.contains('lit'), true)
  assert.equal(edge('B', 'C').classList.contains('filter-hidden'), true)

  ui.run("setFilter('reviewing')")
  ui.run("openTask('R')")
  const completed = structuredClone(state)
  completed.tasks.R.status = 'done'
  completed.derived.R.effective = 'done'
  ui.render(completed)
  assert.equal(ui.run('POP'), null, 'live status changes close details when the card leaves the filter')
  assert.equal(card('R').classList.contains('filtered-out'), true)
})
test('filter controls expose every state and localize labels', () => {
  assert.doesNotMatch(html, /id="depsBtn"|toggleDependencies/)
  const panel = html.match(/<div[^>]+id="statusFilter"[^>]*>([\s\S]*?)<\/div>/)[1]
  const options = [...panel.matchAll(/<button\b[^>]*data-filter-value="([^"]+)"/g)].map(([, value]) => value)
  assert.deepEqual(options, ['all', 'done', 'incomplete', 'dependencies', 'unlocks', 'waiting', 'ready_for_discussion', 'discussing', 'ready_to_plan', 'planning', 'ready', 'running', 'ready_for_review', 'reviewing', 'blocked', 'failed', 'skipped'])
  for (const [lang, labels] of [['en', ['all tasks', 'incomplete', 'ignored']], ['pt-BR', ['todas', 'incompletas', 'ignoradas']]]) {
    const ui = dashboard(lang)
    ui.render({ run: 'empty-filter', plan: { phases: [] }, tasks: {}, derived: {} })
    for (const label of labels) assert.ok(ui.labels.some((node) => node.textContent === label), `${lang}: ${label}`)
    assert.equal(ui.nodes.get('#filterCount').textContent, '00/00')
  }
})

test('filtros de estado usam os mesmos fundos dos cards e a seleção continua distinguível', () => {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
  for (const state of ['done', 'waiting', 'ready_for_discussion', 'discussing', 'ready_to_plan', 'planning', 'ready', 'running', 'ready_for_review', 'reviewing', 'blocked', 'failed', 'skipped']) {
    const card = rules.find(([, selector, body]) => selector.includes('.node') && selector.includes(`[data-st="${state}"]`) && /--ticket-bg:\s*#/.test(body))
    const filter = rules.find(([, selector]) => selector.trim() === `.filter-option[data-filter-value="${state}"]`)
    assert.ok(card && filter, `estado sem paleta: ${state}`)
    assert.equal(filter[2].match(/--filter-bg:\s*(#[a-f\d]+)/i)[1], card[2].match(/--ticket-bg:\s*(#[a-f\d]+)/i)[1], `filtro e card de ${state} preservam a mesma cor`)
  }
  const selected = rules.find(([, selector]) => selector.trim() === '.filter-option[aria-pressed="true"]')[2]
  assert.match(selected, /box-shadow:/, 'a seleção tem contorno adicional e não depende só da cor')
  assert.match(selected, /font-weight:\s*600/, 'o filtro ativo também tem peso de texto diferente')
})

test('entidades ativas abrem a primeira tarefa atual, inclusive oculta pelo filtro', () => {
  const ui = dashboard('pt-BR')
  const state = { run: 'entidades', plan: { phases: [] }, tasks: {
    T1: task('T1', 'planning'), T2: task('T2', 'running'),
    T3: task('T3', 'running'), T4: task('T4', 'reviewing'),
  } }
  ui.render(state)
  for (const [selector, id] of [['#planNode', 'T1'], ['#execNode', 'T2'], ['#revNode', 'T4']]) {
    const node = ui.nodes.get(selector)
    assert.equal(node.getAttribute('role'), 'button')
    assert.equal(node.getAttribute('tabindex'), '0')
    ui.run("setFilter('done')")
    node.onclick()
    assert.equal(ui.run('POP.id'), id)
    assert.equal(ui.run('FILTER'), 'all')
    node.onclick()
    assert.equal(ui.run('POP.id'), id, 'clicar novamente mantém a tarefa aberta')
    ui.render(state)
    node.onclick()
    assert.equal(ui.run('POP.id'), id, 'renderizações não acumulam ações')
  }
  assert.equal(ui.nodes.get('#orchNode').getAttribute('role'), null)
  assert.equal(ui.nodes.get('#orchNode').onclick, undefined)
  let prevented = 0
  ui.nodes.get('#execNode').onkeydown({ key: ' ', preventDefault() { prevented++ } })
  assert.equal(ui.run('POP.id'), 'T2')
  ui.nodes.get('#revNode').onkeydown({ key: 'Enter', preventDefault() { prevented++ } })
  assert.equal(ui.run('POP.id'), 'T4')
  ui.nodes.get('#planNode').onkeydown({ key: 'Escape', preventDefault() { prevented++ } })
  assert.equal(ui.run('POP.id'), 'T4')
  assert.equal(prevented, 2)
  for (const task of Object.values(state.tasks)) task.state = 'done'
  ui.render(state)
  for (const selector of ['#planNode', '#execNode', '#revNode']) {
    const node = ui.nodes.get(selector)
    assert.equal(node.onclick, null)
    assert.equal(node.onkeydown, null)
    assert.equal(node.getAttribute('tabindex'), null)
    assert.equal(node.getAttribute('role'), null)
  }
})

test('planejador segue o primeiro alvo válido da fase e resolve identificadores antigos', () => {
  const ui = dashboard()
  ui.render({ run: 'fase', plan: { phases: [] }, tasks: {
    T1: task('T1'), T2: task('T2'),
  }, derived: { T1: { effective: 'planning' }, T2: { effective: 'planning' } },
  taskIdAliases: { antigo: 'T2' }, phaseWorkflows: { F1: {
    id: 'F1', state: 'planning', planningAttempts: [{ targets: ['ausente', 'antigo', 'T1'] }],
  } } })
  ui.nodes.get('#planNode').onclick()
  assert.equal(ui.run('POP.id'), 'T2')
  ui.run("showRunLoading('outro')")
  assert.equal(ui.nodes.get('#planNode').onclick, null, 'trocar de plano limpa o alvo anterior')
})

test('somente clique seleciona cards; hover e arraste não mudam a seleção', () => {
  const ui = dashboard('pt-BR')
  ui.render({ run: 'cliques', plan: { phases: [] }, tasks: {
    A: task('A', 'pending'), B: task('B', 'pending', { deps: ['A'] }),
  }, derived: { A: { effective: 'ready' }, B: { effective: 'waiting', blockedBy: ['A'] } } })
  assert.equal(ui.run('typeof FOCUS'), 'undefined')
  assert.equal(ui.run('typeof dwellTimer'), 'undefined')
  assert.equal(ui.run('typeof closeTimer'), 'undefined')
  ui.dispatchElement('#nodes', 'mouseover', { target: { closest: () => ui.cards[0] } })
  ui.dispatchElement('#nodes', 'mouseout', { target: { closest: () => ui.cards[0] } })
  assert.equal(ui.run('POP'), null)
  assert.equal(ui.nodes.get('#canvas').classList.contains('focus'), false)

  ui.run("openTask('A')")
  assert.equal(ui.run('POP.id'), 'A')
  assert.equal(ui.cards.find(node => node.dataset.id === 'A').classList.contains('lit-self'), true)
  ui.dispatchElement('#nodes', 'mouseover', { target: { closest: () => ui.cards[1] } })
  ui.dispatchElement('#pop', 'mouseleave', {})
  assert.equal(ui.run('POP.id'), 'A', 'hover em outro card não altera a seleção')
  assert.equal(ui.cards.find(node => node.dataset.id === 'A').classList.contains('lit-self'), true)
  ui.run("openTask('A')")
  assert.equal(ui.run('POP'), null, 'segundo clique no mesmo card fecha o resumo')
  assert.equal(ui.nodes.get('#canvas').classList.contains('focus'), false)

  ui.run("openTask('A'); openTask('B')")
  assert.equal(ui.run('POP.id'), 'B', 'clique em outro card troca a seleção')
  ui.dispatchElement('#viewport', 'pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
  ui.dispatchElement('#viewport', 'pointermove', { clientX: 112, clientY: 112, pointerId: 1 })
  ui.dispatchElement('#viewport', 'pointerup', { pointerId: 1 })
  assert.equal(ui.run('suppressClick'), true)
  ui.run("openTask('A')")
  assert.equal(ui.run('POP.id'), 'B', 'o clique residual do arraste não seleciona outro card')
})

test('a run-only URL selects that run in the current root', () => {
  assert.match(html, /const selectedRoot = SELECTED_ROOT \?\? currentRoot/)
  assert.match(html, /url\.searchParams\.set\('root', root\)/)
  assert.match(html, /url\.searchParams\.set\('run', run\)/)
})

test('filters preserve the full graph and show matching task dependencies as context', () => {
  const ui = dashboard('pt-BR')
  const tasks = { A: task('A', 'pending', { phase: 'F0' }), B: task('B', 'pending', { phase: 'F1', deps: ['A'] }),
    C: task('C', 'pending', { phase: 'F7' }) }
  const state = { run: 'phase-filter', plan: { phases: Array.from({ length: 8 }, (_, i) => ({ id: `F${i}`, title: `Phase ${i}` })) }, tasks,
    derived: { A: { effective: 'ready_for_discussion' }, B: { effective: 'waiting', blockedBy: ['A'] }, C: { effective: 'ready_for_discussion' } } }
  ui.render(state)
  const fullHeight = ui.run('CANVAS_H')
  ui.run("setFilter('ready_for_discussion')")
  assert.deepEqual(ui.cards.map(card => card.dataset.id), ['A', 'B', 'C'])
  assert.equal(ui.cards.find(card => card.dataset.id === 'B').classList.contains('filtered-out'), true)
  assert.match(ui.nodes.get('#lanes').innerHTML, /F0/)
  assert.match(ui.nodes.get('#lanes').innerHTML, /F7/)
  assert.match(ui.nodes.get('#lanes').innerHTML, /F1|F6/)
  assert.equal(ui.run('CANVAS_H'), fullHeight)
  ui.run("setFilter('waiting')")
  assert.equal(ui.cards.find(card => card.dataset.id === 'B').classList.contains('filtered-out'), false)
  assert.equal(ui.cards.find(card => card.dataset.id === 'A').classList.contains('filtered-out'), false)
  assert.equal(ui.cards.find(card => card.dataset.id === 'A').classList.contains('dependency-context'), true)
  ui.run("setFilter('done')")
  assert.equal(ui.cards.length, 3)
  assert.equal(ui.cards.every(card => card.classList.contains('filtered-out')), true)
  assert.notEqual(ui.nodes.get('#lanes').innerHTML, '')
  ui.run("setFilter('all')")
  assert.deepEqual(ui.cards.map(card => card.dataset.id), ['A', 'B', 'C'])
  assert.equal(ui.cards.some(card => card.classList.contains('filtered-out')), false)
})

test('opening and closing the legend preserves fixed scale and manual pan', () => {
  for (const setup of ['', 'VIEW.x -= 40; VIEW.y -= 20; VIEW_MANUAL = true; applyView()']) {
    const ui = dashboard('en', 1000)
    ui.render(graphState(30))
    if (setup) ui.run(setup)
    const before = JSON.parse(ui.run('JSON.stringify({ view: VIEW, manual: VIEW_MANUAL })'))
    const assertView = () => {
      const after = JSON.parse(ui.run("JSON.stringify({ view: VIEW, manual: VIEW_MANUAL, width: CANVAS_W, height: CANVAS_H, vw: $('#viewport').getBoundingClientRect().width, vh: $('#viewport').getBoundingClientRect().height })"))
      assert.equal(after.view.k, 1)
      assert.equal(after.manual, before.manual)
      assert.ok(after.view.x >= Math.min(0, after.vw - after.width))
      assert.ok(after.view.x <= Math.max(0, (after.vw - after.width) / 2))
      assert.ok(after.view.y >= Math.min(0, after.vh - after.height))
      assert.ok(after.view.y <= 0)
    }
    ui.run('toggleSidebar()')
    ui.flushFrame(1330)
    assertView()
    ui.run('toggleSidebar()')
    ui.flushFrame(1000)
    assertView()
  }
})
test('cards follow numeric and suffix order within their phases regardless of dependencies or insertion order', () => {
  for (const width of [360, 1200]) {
    const ui = dashboard('pt-BR', width)
    const tasks = Object.fromEntries(['T12e', 'T11h', 'T2', 'T12a', 'T12', 'T11', 'T11b', 'T11a', 'T10'].map(id =>
      [id, task(id, 'pending', { phase: 'P1', deps: id === 'T11' ? ['T11h'] : [] })]))
    tasks.T1 = task('T1', 'pending', { phase: 'P2', deps: ['T12'] })
    const state = { plan: { phases: [{id:'P1'}, {id:'P2'}] }, tasks }
    const before = JSON.stringify(state)
    const result = JSON.parse(ui.run('STATE = input; JSON.stringify(layout(STATE.tasks))', { input: state }))
    const ordered = Object.entries(result.pos).sort((a,b) => a[1].y-b[1].y || a[1].x-b[1].x).map(([id])=>id)
    assert.deepEqual(ordered, ['T2', 'T10', 'T11', 'T11a', 'T11b', 'T11h', 'T12', 'T12a', 'T12e', 'T1'])
    assert.equal(JSON.stringify(state), before, 'layout preserves phases and dependency contracts')
  }
})

test('responsive layout selects density and sizes phase lanes from their cards', () => {
  for (const [count, expected] of [[6, 'detailed'], [24, 'detailed'], [25, 'compact'], [48, 'compact'], [100, 'compact'], [101, 'dense'], [206, 'dense']]) {
    const ui = dashboard('en', 960)
    const state = graphState(count)
    const result = JSON.parse(ui.run("STATE = input; JSON.stringify(layout(STATE.tasks))", { input: state }))
    assert.equal(result.density, expected, `${count} tasks`)
    const cardDrivenWidth = Math.max(900, 80 + result.capacity * result.metrics.nodeW + (result.capacity - 1) * result.metrics.gapX)
    assert.equal(result.w, cardDrivenWidth)
    for (const point of Object.values(result.pos)) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `${count}: finite coordinates`)
      assert.ok(point.x + result.metrics.nodeW <= result.w - 40, `${count}: bounded x`)
    }
    ui.render(state)
    assert.equal(ui.nodes.get('#canvas').dataset.density, expected)
  }

  const phasedUi = dashboard('en', 700)
  const phased = JSON.parse(phasedUi.run('STATE = input; JSON.stringify(layout(STATE.tasks))', { input: graphState(48, 4) }))
  assert.ok(new Set(Object.values(phased.pos).map(({ y }) => y)).size > 1, 'phase bands wrap vertically')

  const unphasedState = graphState(48, 1)
  unphasedState.plan.phases = []
  const unphasedUi = dashboard('en', 700)
  const unphased = JSON.parse(unphasedUi.run('STATE = input; JSON.stringify(layout(STATE.tasks))', { input: unphasedState }))
  assert.equal(unphased.lanes.length, 0, 'a plan without phases renders one unlabelled band')
  assert.equal(unphased.metrics.nodeW, phased.metrics.nodeW, 'the phase layout is the only layout')
  assert.ok(new Set(Object.values(unphased.pos).map(({ y }) => y)).size > 1, 'the single band wraps vertically')
  assert.doesNotMatch(html, /layoutBtn|toggleLayout|graphLayout/, 'no way to switch the graph layout')

  const tallState = graphState(28, 23)
  const tallTasks = Object.values(tallState.tasks)
  tallTasks.slice(0, 6).forEach(task => { task.phase = 'P1' })
  tallTasks.slice(6).forEach((task, index) => { task.phase = `P${index + 2}` })
  const tallUi = dashboard('en', 1440)
  const tallLayout = JSON.parse(tallUi.run("STATE = input; JSON.stringify(layout(STATE.tasks))", { input: tallState }))
  assert.equal(tallLayout.capacity, 6, 'many phases must not force a six-card phase into one column')
  assert.equal(new Set(tallTasks.slice(0, 6).map(task => tallLayout.pos[task.id].y)).size, 1)

  const state = graphState(206)
  const wide = dashboard('en', 1200)
  const narrow = dashboard('en', 700)
  const wideLayout = JSON.parse(wide.run("STATE = input; JSON.stringify(layout(STATE.tasks))", { input: state }))
  const narrowLayout = JSON.parse(narrow.run("STATE = input; JSON.stringify(layout(STATE.tasks))", { input: state }))
  assert.ok(wideLayout.capacity >= narrowLayout.capacity)
  assert.ok(wideLayout.w >= narrowLayout.w)
  assert.ok(narrowLayout.lanes.every((lane, i, lanes) => i === 0 || lanes[i - 1].y + lanes[i - 1].height < lane.y))
})

test('resize relayout preserves selected state and clamps manual pan at 100%', () => {
  const ui = dashboard('en', 1200)
  const state = graphState(48)
  ui.render(state)
  ui.run("setFilter('running'); openTask('T013'); SELECTED_RUN = 'fixture-48'; VIEW_MANUAL = true; Object.assign(VIEW, { x: 91, y: -37 })")
  assert.equal(ui.run('FILTER'), 'all', 'opening a filtered-out task reveals its card and popover anchor')
  const before = JSON.parse(ui.run("JSON.stringify({ filter: FILTER, pop: POP, selected: SELECTED_RUN, fitted, manual: VIEW_MANUAL, view: VIEW, h: CANVAS_H, pos: LAST_POS })"))
  const beforeAnchor = JSON.parse(ui.run("JSON.stringify(document.querySelector('.node[data-id=\\\"T013\\\"]')?.getBoundingClientRect())"))
  ui.resize(700)
  const after = JSON.parse(ui.run("JSON.stringify({ filter: FILTER, pop: POP, selected: SELECTED_RUN, fitted, manual: VIEW_MANUAL, view: VIEW, w: CANVAS_W, h: CANVAS_H, metrics: LAST_METRICS, pos: LAST_POS })"))
  assert.equal(after.filter, before.filter)
  assert.deepEqual(after.pop, before.pop)
  assert.equal(after.selected, before.selected)
  assert.equal(after.fitted, before.fitted)
  assert.equal(after.manual, true)
  assert.equal(after.view.k, 1)
  assert.notDeepEqual(after.view, before.view)
  const viewportW = ui.run("$('#viewport').getBoundingClientRect().width")
  const viewportH = ui.run("$('#viewport').getBoundingClientRect().height")
  assert.ok(after.view.x >= Math.min(0, viewportW - after.w))
  assert.ok(after.view.x <= Math.max(0, (viewportW - after.w) / 2))
  assert.ok(after.view.y >= Math.min(0, viewportH - after.h))
  assert.ok(after.view.y <= 0)
  assert.equal(after.metrics.nodeW * after.view.k, after.metrics.nodeW)
  const afterAnchor = JSON.parse(ui.run("JSON.stringify(document.querySelector('.node[data-id=\\\"T013\\\"]')?.getBoundingClientRect())"))
  const popPosition = JSON.parse(ui.run("JSON.stringify({ left: parseFloat($('#pop').style.left), top: parseFloat($('#pop').style.top) })"))
  assert.deepEqual(popPosition, { left: afterAnchor.right + 14, top: afterAnchor.top - 6 })
  assert.ok(beforeAnchor)
})
test('gestos da pipeline rolam apenas na vertical, respeitam limites e não aplicam zoom', () => {
  const ui = dashboard('en', 500)
  ui.render(graphState(48, 8))
  const bounds = JSON.parse(ui.run("JSON.stringify({ width: CANVAS_W, height: CANVAS_H, vw: $('#viewport').getBoundingClientRect().width, vh: $('#viewport').getBoundingClientRect().height })"))
  assert.ok(bounds.width > bounds.vw)
  assert.ok(bounds.height > bounds.vh)
  assert.equal(ui.run('VIEW.k'), 1)

  const wheel = (deltaX, deltaY, options = {}) => {
    const event = { deltaX, deltaY, shiftKey: false, ctrlKey: false, prevented: false,
      preventDefault() { this.prevented = true }, ...options }
    ui.dispatchElement('#viewport', 'wheel', event)
    return event
  }
  wheel(30, 40)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: 0, y: -40 })
  wheel(0, 12, { shiftKey: true })
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: 0, y: -52 },
    'Shift não transforma a rolagem em deslocamento lateral')
  const pinch = wheel(0, 15, { ctrlKey: true })
  assert.equal(pinch.prevented, true, 'pinch wheel is prevented from zooming the page')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y, k: VIEW.k })')), { x: 0, y: -67, k: 1 })

  const key = (value) => ui.dispatchDocument('keydown', {
    key: value, target: { tagName: 'BODY' }, preventDefault() {},
  })
  const beforeKeys = ui.run('JSON.stringify(VIEW)')
  for (const value of ['+', '-', '0']) key(value)
  assert.equal(ui.run('JSON.stringify(VIEW)'), beforeKeys, 'legacy zoom keys do not move or scale the board')
  assert.doesNotMatch(html, /zoomAt|zoomLvl|VIEW\.k\s*=/)

  const minY = bounds.vh - bounds.height
  wheel(5000, 5000)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: 0, y: minY })
  wheel(-5000, -5000)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: 0, y: 0 })

  const drag = (toX, toY) => {
    ui.dispatchElement('#viewport', 'pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
    ui.dispatchElement('#viewport', 'pointermove', { clientX: toX, clientY: toY })
    ui.dispatchElement('#viewport', 'pointerup', {})
  }
  drag(-2000, -2000)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: 0, y: minY },
    'drag cannot pan beyond the far edges')
  drag(2000, 2000)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y })')), { x: 0, y: 0 },
    'drag cannot pan past the near edges')
})
test('gestos exclusivamente laterais não movem o quadro e não abrem um card por engano', () => {
  const ui = dashboard('pt-BR', 500)
  ui.render(graphState(48, 8))
  const before = ui.run('JSON.stringify(VIEW)')
  ui.dispatchElement('#viewport', 'wheel', { deltaX: 300, deltaY: 0, preventDefault() {} })
  assert.equal(ui.run('JSON.stringify(VIEW)'), before)
  ui.dispatchElement('#viewport', 'pointerdown', { button: 0, clientX: 300, clientY: 100, pointerId: 1 })
  ui.dispatchElement('#viewport', 'pointermove', { clientX: 50, clientY: 100 })
  ui.dispatchElement('#viewport', 'pointerup', {})
  assert.equal(ui.run('JSON.stringify(VIEW)'), before)
  assert.equal(ui.run('suppressClick'), true)
  const wide = dashboard('pt-BR', 1600)
  wide.render(graphState(1, 1))
  const centered = wide.run('VIEW.x')
  wide.run('VIEW.x = 0; applyView()')
  assert.equal(wide.run('VIEW.x'), centered, 'um quadro que cabe na tela mantém o alinhamento central')
})

test('phase boards expand for their cards and open with the complete graph visible', () => {
  const ui = dashboard('en', 1000)
  ui.render(graphState(48, 8))
  const initial = JSON.parse(ui.run('JSON.stringify({ view: VIEW, width: CANVAS_W, height: CANVAS_H, metrics: LAST_METRICS, pos: LAST_POS })'))
  assert.ok(initial.height > 644)
  assert.ok(initial.metrics.nodeW >= 120)
  assert.ok(initial.metrics.nodeW < 202)
  assert.equal(Math.max(...Object.values(initial.pos).map(point => point.x)) + initial.metrics.nodeW, initial.width - 40)
  assert.equal(initial.view.k, 1, 'the board always opens at 100%')
  assert.equal(initial.view.y, 0, '100% starts at the top when the board is taller than the viewport')
  assert.ok(initial.view.x >= 0, '100% never hides the hierarchy to the left of the viewport')
  assert.doesNotMatch(html, /zoomAt|id="zoomLvl"|id="fitBtn"|toggleFitView|fitView\(/)
  ui.run('VIEW.x -= 36; VIEW.y -= 20; VIEW_MANUAL = true; applyView()')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify({ k: VIEW.k, manual: VIEW_MANUAL })')), { k: 1, manual: true })
  ui.run('actualView()')
  const back = JSON.parse(ui.run('JSON.stringify({ view: VIEW, manual: VIEW_MANUAL })'))
  assert.equal(back.manual, false)
  assert.deepEqual(back.view, initial.view, 'resetting the graph returns to the opening fixed-scale view')

  const screenshotState = graphState(25, 6)
  const screenshotTasks = Object.values(screenshotState.tasks)
  let offset = 0
  for (const [phaseIndex, size] of [4, 3, 3, 11, 2, 2].entries()) {
    screenshotTasks.slice(offset, offset + size).forEach(task => { task.phase = `P${phaseIndex + 1}` })
    offset += size
  }
  const wide = dashboard('en', 1046)
  wide.render(screenshotState)
  const wideView = JSON.parse(wide.run("JSON.stringify({ view: VIEW, width: CANVAS_W, metrics: LAST_METRICS })"))
  const cardCapacity = wide.run("layout(STATE.tasks, 'phase').capacity")
  assert.equal(wideView.width, Math.max(636, 80 + wideView.metrics.nodeW * cardCapacity + wideView.metrics.gapX * (cardCapacity - 1)))
  assert.ok(wideView.metrics.nodeW * wideView.view.k >= 72, 'cards at 100% stay legible')
})

test('historico continua mostrando acoes com suas cores sem legenda separada', () => {
  assert.doesNotMatch(html, /<div class="legend">/)
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    const taskValue = task('T4', 'reviewing', { validations: [
      { by: 'review', ok: false, evidence: 'The reviewer checked the current result.', summary: 'Reviewer found a missing acceptance condition.' },
      { by: 'review', ok: true, evidence: 'All required checks passed.' },
    ] })
    const events = [
      { type: 'task_start', task: 'T4', at: instant(1), current: 1, total: 4 },
      { type: 'task_progress', task: 'T4', at: instant(2), current: 2, total: 4 },
      { type: 'task_check', task: 'T4', at: instant(3), current: 1, total: 4, status: 'started', kind: 'functional', by: 'review' },
      { type: 'task_check', task: 'T4', at: instant(4), current: 2, total: 4, status: 'failed', kind: 'functional', by: 'review' },
      { type: 'task_review', task: 'T4', at: instant(5), reviewer: 'reviewer-1' },
      { type: 'task_validate', task: 'T4', at: instant(6), by: 'review', ok: false, evidence: 'The reviewer checked the current result.' },
      { type: 'task_validate', task: 'T4', at: instant(7), by: 'review', ok: true, evidence: 'All required checks passed.' },
      { type: 'phase_planning', phase: 'P2', at: instant(8), planner: 'planner-2' },
      { type: 'slot_freed', at: instant(9), freedBy: 'T4', cause: 'review', slots: 1, next: ['T5'] },
      { type: 'task_start', task: 'OLD', at: instant(0) },
    ]
    ui.render({ run: 'events', plan: {}, tasks: { T4: taskValue }, derived: { T4: { effective: 'ready' } } }, events)
    const title = ui.nodes.get('#counts').innerHTML
    for (const color of ['discussion', 'planning', 'running', 'review']) assert.ok(title.includes(`color:var(--${color})`))
    assert.ok((title.match(/<b>/g) ?? []).length >= 7)
    assert.doesNotMatch(title, / · /)
    const log = ui.nodes.get('#events').innerHTML
    const visibleLog = log.replace(/<[^>]*>/g, '')
    assert.match(visibleLog, /T4 \[1\/4\]/)
    assert.match(visibleLog, /T4 \[2\/4\]/)
    assert.doesNotMatch(visibleLog, /OLD \[/)
    assert.ok(visibleLog.includes(lang === 'en' ? 'Executor started task T4' : 'Executor iniciou a tarefa T4'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'Reviewer began the functional check for task T4' : 'Revisor iniciou a verificação funcional da tarefa T4'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'Orchestrator sent T4 to Reviewer @reviewer-1' : 'Orquestrador encaminhou T4 ao Revisor @reviewer-1'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'Reviewer approved T4' : 'Revisor aprovou T4'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'Reviewer rejected T4' : 'Revisor reprovou T4'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'Planner started planning for phase P2' : 'Planejador iniciou o planejamento da fase P2'))
    assert.ok(visibleLog.includes(lang === 'en' ? 'Orchestrator freed an execution slot when task T4 went to review; next authorized: T5'
      : 'Orquestrador liberou uma vaga de execução quando a tarefa T4 foi para revisão; próxima autorizada: T5'), visibleLog)
    assert.match(log, /class="task-ref ev-phase" style="color:var\(--accent\)">P2/)
    assert.match(log, /class="t-task_validate" data-ok="true"/)
    assert.match(log, /class="t-task_validate" data-ok="false"/)
    assert.doesNotMatch(visibleLog, /\b(?:phase|task)_[a-z_]+\b/)
  }
})

test('novos eventos destacam o card correto sem destacar eventos sem tarefa', () => {
  const ui = dashboard()
  const state = graphState(1, 1)
  ui.render(state, [{ type: 'task_note', task: 'T001', at: instant(1), note: 'primeiro evento' }])
  ui.render(state, [
    { type: 'task_done', task: 'T001', at: instant(2) },
    { type: 'task_validate', task: 'T001', ok: true, at: instant(3) },
    { type: 'task_validate', task: 'T001', ok: false, at: instant(4) },
    { type: 'task_start', task: 'T001', at: instant(5) },
    { type: 'task_fail', task: 'T001', at: instant(6) },
    { type: 'task_note', at: instant(7), note: 'sem alvo' },
  ])
  const card = ui.cards.find(item => item.dataset.id === 'T001')
  assert.equal(card.classList.contains('flash-done'), true)
  assert.equal(card.classList.contains('flash-val'), true)
  assert.equal(card.classList.contains('flash-bad'), true)
  assert.equal(card.classList.contains('flash-start'), true)
})

test('review rejection history prefers its validation summary and truncates evidence as fallback', () => {
  const evidence = 'A'.repeat(80) + 'UNTRUNCATED_SENTINEL'
  const repeatedEvidence = 'The same reviewer evidence was recorded twice.'
  const firstSummary = '1'.repeat(95)
  const secondSummary = '2'.repeat(95)
  const state = { run: 'rejection-history', plan: {}, tasks: {
    SUMMARY: task('SUMMARY', 'pending', { validations: [
      { by: 'review', ok: false, evidence: 'Raw evidence replaced by summary.', summary: 'Reviewer summary is shown first.' },
    ] }),
    FALLBACK: task('FALLBACK', 'pending', { validations: [
      { by: 'review', ok: false, evidence, summary: '' },
    ] }),
    REPEAT: task('REPEAT', 'pending', { validations: [
      { by: 'review', ok: false, evidence: repeatedEvidence, summary: firstSummary, at: instant(10) },
      { by: 'review', ok: false, evidence: repeatedEvidence, summary: secondSummary, at: instant(12) },
    ] }),
  }, derived: {
    SUMMARY: { effective: 'pending', blockedBy: [] },
    FALLBACK: { effective: 'pending', blockedBy: [] },
    REPEAT: { effective: 'pending', blockedBy: [] },
  } }
  const events = [
    { type: 'task_validate', task: 'SUMMARY', at: instant(1), by: 'review', ok: false, evidence: 'Raw evidence replaced by summary.' },
    { type: 'task_validate', task: 'FALLBACK', at: instant(2), by: 'review', ok: false, evidence },
    { type: 'task_validate', task: 'REPEAT', at: instant(11), by: 'review', ok: false, evidence: repeatedEvidence },
    { type: 'task_validate', task: 'REPEAT', at: instant(13), by: 'review', ok: false, evidence: repeatedEvidence },
  ]
  const ui = dashboard('en')
  ui.render(state, events)
  const log = ui.nodes.get('#events').innerHTML
  assert.ok(log.includes('Reviewer summary is shown first.'))
  assert.doesNotMatch(log, /Raw evidence replaced by summary\./)
  assert.ok(log.includes('A'.repeat(80)))
  assert.doesNotMatch(log, /UNTRUNCATED_SENTINEL/)
  const repeatLines = log.match(/<div class="ev"[^>]*>[\s\S]*?<\/div>/g).filter(line => line.includes('REPEAT'))
  assert.equal(repeatLines.length, 2)
  assert.ok(repeatLines[0].includes(secondSummary), 'the latest rejection keeps its full summary')
  assert.ok(repeatLines[1].includes(firstSummary), 'the earlier rejection keeps its own full summary')
})

test('visual polish keeps arrowless curves, full card labels and a controllable responsive sidebar', () => {
  assert.doesNotMatch(html, /marker-end|<marker/, 'dependency curves end on the card without arrowheads')
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\*, \*::before, \*::after[\s\S]*animation: none !important/)
  assert.match(html, /\.phase-task-state \{ display: inline;/)
  const sectionOrder = ['id="counts"', 'data-i18n="Event log"']
  assert.deepEqual(sectionOrder.map((part) => html.indexOf(part)), [...sectionOrder.map((part) => html.indexOf(part))].sort((a, b) => a - b))

  for (const [count, density] of [[6, 'detailed'], [48, 'compact'], [101, 'dense']]) {
    const ui = dashboard('pt-BR')
    const state = graphState(count)
    ui.render(state)
    assert.equal(ui.nodes.get('#canvas').dataset.density, density)
    assert.match(ui.nodes.get('#nodes').innerHTML, /em execução · executor/)
  }

  const state = graphState(6)
  const wide = dashboard('en', 1000)
  wide.render(state)
  assert.equal(wide.nodes.get('#sidebar').hidden, false)
  assert.equal(wide.nodes.get('#sidebarToggle').getAttribute('aria-expanded'), 'true')
  assert.equal(wide.nodes.get('#sidebarToggle').getAttribute('aria-label'), 'Collapse sidebar')

  const narrow = dashboard('pt-BR', 500)
  narrow.render(state)
  assert.equal(narrow.nodes.get('#sidebar').hidden, true)
  assert.equal(narrow.nodes.get('#sidebarToggle').getAttribute('aria-label'), 'Abrir lateral')
  narrow.run('toggleSidebar()')
  narrow.resize(400)
  assert.equal(narrow.nodes.get('#sidebar').hidden, false, 'manual choice survives resize')
  assert.equal(narrow.nodes.get('#sidebarToggle').getAttribute('aria-expanded'), 'true')
  narrow.run("openTask('T001')")
  assert.equal(narrow.run('POP.id'), 'T001')
  assert.match(narrow.nodes.get('#popBody').innerHTML, /T001/)

  const session = new Map()
  const firstLoad = dashboard('en', 500, session)
  firstLoad.render(state)
  firstLoad.run('toggleSidebar()')
  const openReload = dashboard('en', 500, session)
  openReload.render(state)
  assert.equal(openReload.nodes.get('#sidebar').hidden, false, 'manual open choice survives reload')
  openReload.run('toggleSidebar()')
  const collapsedReload = dashboard('en', 1000, session)
  collapsedReload.render(state)
  assert.equal(collapsedReload.nodes.get('#sidebar').hidden, true, 'manual collapsed choice survives reload')

  const unavailableStorage = { get() { throw new Error('blocked') }, set() { throw new Error('blocked') } }
  const navigation = { state: { existing: 'preserved' }, urls: [] }
  const fallback = dashboard('en', 500, unavailableStorage, navigation)
  fallback.render(state)
  assert.equal(fallback.nodes.get('#sidebar').hidden, true, 'responsive default survives unavailable storage')
  assert.doesNotThrow(() => fallback.run('toggleSidebar()'))
  assert.deepEqual(JSON.parse(JSON.stringify(navigation.state)), { existing: 'preserved', graphSidebarCollapsed: false })
  assert.deepEqual(navigation.urls, [], 'sidebar state does not alter the URL')
  const fallbackReload = dashboard('en', 500, unavailableStorage, navigation)
  fallbackReload.render(state)
  assert.equal(fallbackReload.nodes.get('#sidebar').hidden, false, 'manual open choice survives reload without storage')
  fallbackReload.run("selectRun('workspace/next')")
  assert.equal(navigation.state.graphSidebarCollapsed, false, 'run selection preserves the sidebar fallback')
  assert.deepEqual(new URL(navigation.urls.at(-1)).searchParams.get('root'), 'workspace')
  assert.equal(new URL(navigation.urls.at(-1)).searchParams.has('graphSidebarCollapsed'), false)
  fallbackReload.run('toggleSidebar()')
  const collapsedFallbackReload = dashboard('en', 1000, unavailableStorage, navigation)
  collapsedFallbackReload.render(state)
  assert.equal(collapsedFallbackReload.nodes.get('#sidebar').hidden, true, 'manual collapsed choice survives reload without storage')
  assert.equal(navigation.state.existing, 'preserved')

  const linked = dashboard('en')
  linked.render({ run: 'curves', plan: { phases: [{ id: 'P1', title: 'Phase 1' }] },
    tasks: { A: task('A', 'done'), B: task('B', 'running', { deps: ['A'], agent: 'executor-1', attempts: [{ startedAt: instant(10) }] }) },
    derived: { A: { effective: 'done', blockedBy: [] }, B: { effective: 'running', blockedBy: [] } } })
  assert.match(linked.nodes.get('#edgePaths').innerHTML, /<path class="e-hot"[^>]* d="M [^"]* C [^"]*"/)
})

test('O grupo in progress mostra apenas execuções não concluídas ao trocar a execução selecionada', () => {
  const ui = dashboard('en')
  const runs = [
    { root: 'workspace', run: 'completed', plan: 'completed-plan', complete: true, doneCount: 4, taskCount: 4 },
    { root: 'workspace', run: 'running', plan: 'running-plan', complete: false, activity: 'working', doneCount: 2, taskCount: 5 },
    { root: 'workspace', run: 'paused', plan: 'paused-plan', complete: false, activity: 'idle', doneCount: 1, taskCount: 3 },
  ]
  ui.run('updateRunSelect(input)', { input: { currentRoot: 'workspace', current: 'completed', runs } })
  ui.run('updateRunSelect(input)', { input: { currentRoot: 'workspace', current: 'running', runs } })

  const progress = ui.nodes.get('#runOptions').innerHTML
  assert.match(progress, /workspace\/running/)
  assert.match(progress, /workspace\/paused/)
  assert.doesNotMatch(progress, /workspace\/completed/)

  ui.run("toggleRunFilter('complete')")
  const completed = ui.nodes.get('#runOptions').innerHTML
  assert.match(completed, /workspace\/completed/)
  assert.doesNotMatch(completed, /workspace\/running/)
})

test('Gravidade cards and agent panels show measured activity in the compact dashboard layout', () => {
  assert.match(html, /grid-template: 64px minmax\(0, 1fr\) 48px/)
  assert.match(html, /grid-template-columns: minmax\(0, 1fr\) 360px/)
  assert.match(html, /\.node \{[^}]*width: var\(--node-w, 200px\); height: var\(--node-h, 64px\)[^}]*padding: 9px 12px/)
  assert.match(html, /\.node \.id \{[^}]*font-size: 13px/)
  assert.match(html, /\.node \.tag \{[^}]*font-size: 10px/)
  assert.match(html, /\.node \.nt \{ font: 15px\/1\.2 var\(--font-display\)/)
  assert.doesNotMatch(html, /\.node \.sub\b/)
  assert.match(html, /<details class="run-menu" id="runMenu"/)
  assert.match(html, /<summary class="run-trigger"/)
  assert.doesNotMatch(html, /<select[^>]+id="runSelect"/)
  assert.doesNotMatch(html, /<details class="legend-box" data-prumo-guide-anchor="legend">/)
  assert.match(html, /aside > section \{[^}]*flex: 1 0 0;[^}]*min-height: 180px;/, 'open sections grow while retaining enough height to read their content')
  assert.match(html, /aside > section:has\(> \.section-content\.collapsed\)[^}]*flex: 0 0 auto;/, 'collapsed sections release their space')
  assert.match(html, /#events, #available \{[^}]*min-height: 0; overflow-y: auto;/, 'as listas extensas mantêm rolagem no espaço disponível')
  assert.match(html, /#agentsBox \{ flex: 0 0 auto; min-height: 0;/, 'agentes ocupam apenas a altura do conteúdo')
  assert.match(html, /#parallel \{ flex: 0 0 auto; min-height: 0; overflow-y: visible;/, 'agentes não ficam presos em uma área de altura mínima')
  assert.match(html, /#parallel:has\(\.empty\), #available:has\(\.empty\), #events:has\(\.empty\) \{ flex: 0 0 auto;/, 'the empty agent message retains its natural height')
  assert.match(html, /#sidebar \{ scrollbar-width: auto; scrollbar-color: var\(--dim\) var\(--panel\);/, 'the outer sidebar scrollbar remains legible')
  assert.doesNotMatch(html, /#(?:available|parallel) \{[^}]*max-height:/, 'lists do not retain a fixed height cap')
  assert.match(html, /#pop \{[^}]*width: min\(472px, calc\(100vw - 24px\)\)/, '472px as designed, never wider than a phone')
  assert.match(html, /#pop \.pk \{[^}]*10px[^}]*var\(--font-mono\)/)
  assert.match(html, /#pop \.lead \{ font: 400 16px\/1\.45 var\(--font-display\)/)
  assert.match(html, /#pop \.detail-head \{ display: flex; align-items: baseline; flex-wrap: nowrap/)
  // detail design: main-column sections are Bricolage 16 titles; the side column and the Summary
  // box keep the mono 10px label; plan labels are mono grey; attempt dots are 13px; the pill is mono
  assert.match(html, /#pop\.expanded \.pmain > dt \{[^}]*font: 600 16px\/1\.25 var\(--font-display\)/)
  assert.match(html, /#pop\.expanded \.pside > dt \{[^}]*font: 500 10px\/1\.4 var\(--font-mono\)[^}]*text-transform: uppercase/)
  assert.match(html, /#pop \.summary-block \.pk \{[^}]*font: 500 10px\/1\.4 var\(--font-mono\)[^}]*text-transform: uppercase/)
  assert.match(html, /#pop \.plan-label \{ color: var\(--dim\); font: 400 12px\/1\.5 var\(--font-mono\)/)
  assert.match(html, /#pop \.jstep::before, #pop \.attempt-row::before \{[^}]*width: 13px; height: 13px/)
  assert.match(html, /#pop \.st \{[^}]*font: 400 11px\/1\.3 var\(--font-mono\)/)
  assert.match(html, /#pop \.chip, #pop \.dep \{[^}]*height: 26px[^}]*margin: 0[^}]*font: 400 11px\/1 var\(--font-mono\)/,
    'the phase chip and the dependency buttons share one box and one type')

  const tasks = {
    T0: task('T0', 'done', { attempts: [{ n: 1, agent: 'exec-a', startedAt: instant(1), endedAt: instant(5), result: 'passed', planDigest: 'a'.repeat(64) }],
      validations: [{ by: 'review', ok: true, at: instant(5), evidence: 'check passed' }] }),
    T1: task('T1', 'running', { deps: ['T0'], agent: 'exec-b', summary: 'Linha um\nLinha dois\nLinha três\nSUMMARY_SENTINEL',
      attempts: [
        { n: 1, agent: 'exec-b', startedAt: instant(50), endedAt: instant(60), result: 'failed', planDigest: 'a'.repeat(64) },
        { n: 2, agent: 'exec-b', startedAt: instant(90), planDigest: 'b'.repeat(64) },
      ],
      validations: [{ by: 'review', agent: 'review', ok: false, at: instant(60), summary: 'Precisa corrigir', evidence: 'prova insuficiente' }] }),
    T2: task('T2', 'failed', { deps: ['T1'], attempts: [
      { n: 1, agent: 'exec-c', startedAt: instant(70), endedAt: instant(80), result: 'failed', reason: 'tentativa inicial falhou' },
      { n: 2, agent: 'exec-c', startedAt: instant(82), endedAt: instant(90), result: 'failed', reason: 'timeout na segunda tentativa' },
    ] }),
  }
  const state = { run: 'run-a', createdAt: new Date(Date.UTC(2026, 0, 1) - 115 * 60 * 60 * 1000).toISOString(),
    plan: { description: 'Plano de atividade', phases: [], maxExecutors: 3, maxAttempts: 3 }, tasks,
    derived: { T0: { effective: 'done' }, T1: { effective: 'running' }, T2: { effective: 'failed' } } }
  const events = [
    { type: 'task_start', task: 'T0', attempt: 1, at: instant(1) },
    { type: 'task_progress', task: 'T0', attempt: 1, at: instant(5) },
    { type: 'task_start', task: 'T1', attempt: 1, at: instant(50) },
    { type: 'task_progress', task: 'T1', attempt: 1, at: instant(60) },
    { type: 'task_start', task: 'T2', attempt: 1, at: instant(70) },
    { type: 'task_progress', task: 'T2', attempt: 1, at: instant(80) },
    { type: 'task_start', task: 'T2', attempt: 2, at: instant(82) },
    { type: 'task_progress', task: 'T2', attempt: 2, at: instant(90) },
  ]
  const ui = dashboard('en', 1440)
  ui.render(state, events)
  ui.run("updateRunSelect({ currentRoot: 'workspace', current: 'run-a', runs: [{ root: 'workspace', run: 'run-a', plan: 'Plano de atividade' }, { root: 'workspace', run: 'run-b', plan: 'Outro plano' }] })")
  assert.equal(ui.nodes.get('#runName').textContent, 'run-a')
  assert.equal(ui.nodes.get('#runLabel').textContent, 'Plano de atividade')
  assert.match(ui.nodes.get('#runOptions').innerHTML, /aria-current="true"/)
  assert.match(ui.nodes.get('#runOptions').innerHTML, /Outro plano/)
  ui.run("updateRunSelect({ currentRoot: 'workspace', current: 'run-b', runs: [{ root: 'workspace', run: 'run-a', plan: 'Plano de atividade' }, { root: 'workspace', run: 'run-b', plan: 'Outro plano' }] })")
  assert.equal(ui.nodes.get('#runName').textContent, 'run-b')
  assert.match(ui.nodes.get('#runOptions').innerHTML, /data-run="workspace\/run-b" aria-current="true"/)
  assert.doesNotMatch(ui.nodes.get('#runOptions').innerHTML, /data-run="workspace\/run-a" aria-current="true"/)
  assert.match(ui.nodes.get('#orch').innerHTML, /Live[\s\S]*00:00:32/)
  assert.match(ui.nodes.get('#orch').innerHTML, /aria-label="Agent time: 00:00:32 · not measured"/)
  assert.equal(ui.nodes.get('#orch').classList.contains('live'), true, 'the current task state, not event age, controls the live pill')
  assert.equal(ui.nodes.get('#doneCount').innerHTML, '<b>33%</b> complete')
  assert.doesNotMatch(ui.nodes.get('#orch').innerHTML + ui.nodes.get('#doneCount').innerHTML, /115:00:00|115h/)
  assert.match(ui.nodes.get('#nodes').innerHTML, /class="tr">WORKING<\/span>/)
  assert.doesNotMatch(ui.nodes.get('#nodes').innerHTML, /class="sub"/)
  assert.match(ui.nodes.get('#parallel').innerHTML, /T1[\s\S]*executor[\s\S]*not measured[\s\S]*rbar/)

  ui.run("POP_EXPANDED = false; fillPop('T1')")
  const lean = ui.nodes.get('#popBody').innerHTML
  for (const text of ['T1', 'Linha um', 'Linha dois', 'Linha três', 'Depends on', 'T0', 'Unlocks', 'T2', 'changed from aaaa', 'Agent time'])
    assert.ok(lean.includes(text), text)
  assert.equal(ui.nodes.get('#popTitle').textContent, 'T1')
  assert.equal(ui.nodes.get('#popStatus').textContent, 'working')
  assert.doesNotMatch(ui.nodes.get('#popStatus').textContent, /of 3/)
  assert.ok(lean.includes('SUMMARY_SENTINEL'), 'an explicit summary remains complete in the concise view')
  assert.doesNotMatch(lean, /115:00:00|115h/)
  assert.match(lean, /<button type="button" class="dep"/)

  ui.run("POP_EXPANDED = true; fillPop('T1')")
  const detail = ui.nodes.get('#popBody').innerHTML
  for (const text of ['Attempts and verdicts', 'Rejected', '@exec-b', '@review', 'prova insuficiente', 'changed from aaaa', 'Esc closes'])
    assert.ok(detail.includes(text), text)
  ui.run("POP_EXPANDED = false; fillPop('T0')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /Approved[\s\S]*in prumo/)
})

test('discussion uses the orchestrator brass and lights the active orchestrator without motion when reduced', () => {
  assert.match(html, /--discussion:\s*#e8b04b/)
  assert.match(html, /\.node\[data-st="discussing"\][^{]*\{[^}]*--st:\s*var\(--discussion\)/)
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none !important/)
  const ui = dashboard('pt-BR')
  ui.render({ run: 'discussion', plan: { maxParallel: 4 }, tasks: { T1: task('T1', 'discussing') }, derived: { T1: { effective: 'discussing' } } })
  assert.equal(ui.nodes.get('#orchNode').classList.contains('discussing'), true)
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-st="discussing"[^>]*data-id="T1"/)
  assert.match(ui.nodes.get('#orchSub').textContent, /discutindo 1: T1/)
  ui.render({ run: 'discussion', plan: { maxParallel: 4 }, tasks: { T1: task('T1', 'discussing', { discussionAttempts: [{ startedAt: instant(28) }] }) }, derived: { T1: { effective: 'discussing' } } })
  assert.doesNotMatch(ui.nodes.get('#nodes').innerHTML, /class="elapsed"/,'the card does not infer active time from an open discussion envelope')
})

test('the dashboard ships its own licensed fonts and the page policy allows only inline data fonts', () => {
  for (const family of ['Bricolage Grotesque', 'JetBrains Mono'])
    assert.match(html, new RegExp(`@font-face \\{ font-family: "${family}"[^}]*src: url\\(data:font/woff2;base64,`))
  assert.match(html, /SIL Open Font License, Version 1\.1/)
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/, 'no font request leaves the machine')
  const serve = readFileSync(new URL('../scripts/serve.mjs', import.meta.url), 'utf8')
  assert.match(serve, /font-src data:;/)
})

test('planos em andamento precedem os parados sem alterar o catalogo nem a selecao', () => {
  const ui = dashboard('pt-BR')
  const catalog = { currentRoot: 'root', current: 'parado-a', runs: [
    { root: 'root', run: 'parado-a', complete: false, activity: 'idle' },
    { root: 'root', run: 'executando', complete: false, activity: 'working', activityState: 'running' },
    { root: 'root', run: 'bloqueado', complete: false, activity: 'blocked' },
    { root: 'root', run: 'planejando', complete: false, activity: 'working', activityState: 'planning' },
    { root: 'root', run: 'desconhecido', complete: false },
    { root: 'root', run: 'parado-b', complete: false, activity: 'idle' },
    { root: 'root', run: 'falhou', complete: false, activity: 'failed' },
    { root: 'root', run: 'discutindo', complete: false, activity: 'working', activityState: 'discussing' },
    { root: 'root', run: 'revisando', complete: false, activity: 'working', activityState: 'reviewing' },
    { root: 'root', run: 'feito-b', complete: true },
    { root: 'root', run: 'feito-a', complete: true },
  ] }
  const order = () => [...ui.nodes.get('#runOptions').innerHTML.matchAll(/data-run="root\/([^"]+)"/g)].map(match => match[1])
  const before = JSON.stringify(catalog)
  ui.run('updateRunSelect(catalog)', { catalog })
  assert.deepEqual(order(), ['executando', 'planejando', 'discutindo', 'revisando', 'bloqueado', 'desconhecido', 'falhou', 'parado-a', 'parado-b'])
  assert.match(ui.nodes.get('#runOptions').innerHTML, /data-run="root\/parado-a" aria-current="true"/)
  assert.equal(JSON.stringify(catalog), before)
  catalog.runs[0].activity = 'working'
  catalog.runs[1].activity = 'idle'
  ui.run('updateRunSelect(catalog)', { catalog })
  assert.deepEqual(order(), ['parado-a', 'planejando', 'discutindo', 'revisando', 'bloqueado', 'desconhecido', 'falhou', 'executando', 'parado-b'])
  ui.run("toggleRunFilter('complete')")
  assert.deepEqual(order(), ['feito-b', 'feito-a'])
  catalog.runs = []
  ui.run('updateRunSelect(catalog)', { catalog })
  assert.deepEqual(order(), [])
})

test('o seletor separa planos em andamento dos concluidos', () => {
  const ui = dashboard('pt-BR')
  const catalog = { currentRoot: 'root', current: 'active', runs: [
    { root: 'root', run: 'active', plan: 'Plano atual', taskCount: 3, doneCount: 1, complete: false, activity: 'working' },
    { root: 'root', run: 'paused', plan: 'Aguardando decisao', taskCount: 2, doneCount: 0, complete: false, activity: 'idle' },
    { root: 'root', run: 'finished', plan: 'Plano entregue', taskCount: 2, doneCount: 2, complete: true, activity: 'idle' },
  ] }
  ui.run(`updateRunSelect(${JSON.stringify(catalog)})`)
  let options = ui.nodes.get('#runOptions').innerHTML
  assert.match(options, /em andamento/)
  assert.match(options, /data-run="root\/active" aria-current="true"/)
  assert.match(options, /class="run-state working">em andamento<i/)
  assert.match(options, /parado/)
  assert.doesNotMatch(options, /data-run="root\/finished"/)

  const pressed = (markup, group) => markup.match(new RegExp(`data-run-filter="${group}" aria-pressed="(true|false)"`))?.[1]
  assert.equal(pressed(options, 'progress'), 'true')
  assert.equal(pressed(options, 'complete'), 'false')
  assert.match(options, /aria-label="em andamento: 2"[^>]*>em andamento<small>2<\/small>/, 'each group shows its count')
  assert.match(options, /aria-label="no prumo: 1"[^>]*>no prumo<small>1<\/small>/)

  // selecting a group replaces the prior filter so completed plans stay out of "in progress"
  ui.run("toggleRunFilter('complete')")
  options = ui.nodes.get('#runOptions').innerHTML
  assert.equal(pressed(options, 'progress'), 'false')
  assert.equal(pressed(options, 'complete'), 'true')
  assert.ok(options.includes('data-run="root/finished"'))
  assert.equal(options.includes('data-run="root/active"'), false)
  assert.equal(options.includes('data-run="root/paused"'), false)
  assert.match(options, /no prumo<i aria-hidden="true"/)

  ui.run("toggleRunFilter('progress')")
  options = ui.nodes.get('#runOptions').innerHTML
  assert.equal(pressed(options, 'progress'), 'true')
  assert.equal(pressed(options, 'complete'), 'false')
  assert.ok(options.includes('data-run="root/active"'))
  assert.ok(options.includes('data-run="root/paused"'))
  assert.equal(options.includes('data-run="root/finished"'), false)

  // selecting the active group again leaves it selected
  ui.run("toggleRunFilter('progress')")
  options = ui.nodes.get('#runOptions').innerHTML
  assert.equal(pressed(options, 'progress'), 'true')
  assert.equal(pressed(options, 'complete'), 'false')

  // clicking a group tab reaches the same exclusive selection
  ui.dispatchElement('#runOptions', 'click', { target: { closest: selector => selector === '[data-run-filter]' ? { dataset: { runFilter: 'complete' } } : null } })
  options = ui.nodes.get('#runOptions').innerHTML
  assert.equal(pressed(options, 'progress'), 'false')
  assert.equal(pressed(options, 'complete'), 'true')

  ui.dispatchElement('#runOptions', 'click', { target: { closest: selector => selector === '.run-option'
    ? { dataset: { run: 'root/finished' } } : null } })

  ui.run("updateRunSelect({ currentRoot: null, current: null, runs: [] })")
  assert.doesNotMatch(ui.nodes.get('#runOptions').innerHTML, /placeholder-01|data-run-demo/)
})

test('um plano com todas as tarefas concluidas conta como no prumo mesmo sem os campos complete e activity', () => {
  // Um servidor mais antigo lista as execuções sem complete/activity; o painel novo não pode chamá-las de "parado".
  const ui = dashboard('pt-BR')
  const catalog = { currentRoot: 'root', current: 'finished', runs: [
    { root: 'root', run: 'finished', plan: 'Plano entregue', taskCount: 6, doneCount: 6 },
    { root: 'root', run: 'halfway', plan: 'Plano pela metade', taskCount: 4, doneCount: 2 },
    { root: 'root', run: 'legacy', plan: 'Sem contagens' },
  ] }
  ui.run(`updateRunSelect(${JSON.stringify(catalog)})`)
  let options = ui.nodes.get('#runOptions').innerHTML
  assert.match(options, /aria-label="no prumo: 1"[^>]*>no prumo<small>1<\/small>/)
  assert.match(options, /aria-label="em andamento: 2"/)
  assert.match(options, /data-run="root\/finished" aria-current="true" aria-label="finished · Plano entregue · no prumo · 6 de 6 tarefas no prumo"/)
  assert.match(options, /<span class="run-state complete">no prumo<i aria-hidden="true"><\/i><\/span>/)
  assert.doesNotMatch(options, /parado|data-run="root\/halfway"/, 'the selected completed run opens its own group, without a paused badge')

  ui.run("toggleRunFilter('progress')")
  options = ui.nodes.get('#runOptions').innerHTML
  const option = (run) => options.slice(options.indexOf(`data-run="root/${run}"`), options.indexOf('</button>', options.indexOf(`data-run="root/${run}"`)))
  assert.doesNotMatch(option('halfway'), /run-state|parado/, 'unknown activity earns no paused badge')
  assert.match(option('halfway'), /2 de 4 tarefas no prumo/)
  assert.doesNotMatch(option('legacy'), /run-state|parado/)

  // quando o servidor informa, o campo explícito prevalece; parado só com trabalho pendente e sem atividade
  ui.run(`updateRunSelect(${JSON.stringify({ ...catalog, runs: [
    { root: 'root', run: 'finished', taskCount: 6, doneCount: 6, complete: true, activity: 'idle' },
    { root: 'root', run: 'halfway', taskCount: 4, doneCount: 2, complete: false, activity: 'idle' },
  ] })})`)
  ui.run("toggleRunFilter('complete')")
  options = ui.nodes.get('#runOptions').innerHTML
  assert.match(option('finished'), /no prumo<i aria-hidden="true"/)
  assert.doesNotMatch(option('finished'), /parado/)
  ui.run("toggleRunFilter('progress')")
  options = ui.nodes.get('#runOptions').innerHTML
  assert.match(option('halfway'), /<span class="run-state idle">parado<i aria-hidden="true"><\/i><\/span>/)
})

test('um plano com tarefas puladas e as demais concluidas fica em no prumo e nomeia as puladas', () => {
  const ui = dashboard('pt-BR')
  const runs = [
    { root: 'root', run: 'sonar', plan: 'Saneamento', taskCount: 14, doneCount: 13, skippedCount: 1, complete: true, activity: 'idle' },
    // servidor antigo: sem complete; as contagens decidem, com ou sem skippedCount
    { root: 'root', run: 'legacy-skip', taskCount: 3, doneCount: 2, skippedCount: 1 },
    { root: 'root', run: 'legacy-open', taskCount: 3, doneCount: 2 },
    { root: 'root', run: 'only-skipped', taskCount: 2, doneCount: 0, skippedCount: 2 },
  ]
  ui.run(`updateRunSelect(${JSON.stringify({ currentRoot: 'root', current: 'sonar', runs })})`)
  let options = ui.nodes.get('#runOptions').innerHTML
  const option = (run) => options.slice(options.indexOf(`data-run="root/${run}"`), options.indexOf('</button>', options.indexOf(`data-run="root/${run}"`)))
  assert.match(options, /aria-label="no prumo: 2"/)
  assert.match(options, /aria-label="em andamento: 2"/)
  assert.match(option('sonar'), /no prumo<i aria-hidden="true"/)
  assert.match(option('sonar'), /13 de 14 tarefas no prumo · 1 pulada/)
  assert.doesNotMatch(option('sonar'), /parado/)
  assert.match(option('legacy-skip'), /no prumo[\s\S]*2 de 3 tarefas no prumo · 1 pulada/)
  assert.doesNotMatch(option('legacy-open'), /run-state complete/,'without skippedCount an old server needs every task done')
  assert.doesNotMatch(option('only-skipped'), /no prumo<i aria-hidden="true"/, 'nothing done means nothing delivered')

  ui.run("toggleRunFilter('progress')")
  options = ui.nodes.get('#runOptions').innerHTML
  assert.ok(options.includes('data-run="root/legacy-open"'))
  assert.ok(options.includes('data-run="root/only-skipped"'))
  assert.equal(options.includes('data-run="root/sonar"'), false)
  assert.equal(options.includes('data-run="root/legacy-skip"'), false)

  assert.equal(ui.run(`completedRunGainSummary({ anyLive: false }, {}, { A: { state: 'skipped' } }, true, true).completed`), false)
  assert.equal(ui.run(`completedRunGainSummary({ anyLive: false }, {}, { A: { state: 'done' }, B: { state: 'skipped' } }, true, true).completed`), true)
})

test('available tasks say who moves each one next and give way to the selected task', () => {
  const tasks = {
    K: task('K', 'blocked', { blockReason: 'pick <the> API version', blockQuestion: 'Which API version should ship?',
      blockOptions: ['v1', 'v2'], blockHistory: [{ at: instant(10), reason: 'Needs a decision',
        question: 'Which API version should ship?', answer: 'v2' }] }),
    E: task('E', 'pending', { validation: [{ run: 'bun test auth', expect: '12 tests pass' }] }),
    E2: task('E2', 'pending'),
    E3: task('E3', 'pending'),
    R: task('R', 'pending'),
    Q: task('Q', 'pending'),
    W: task('W', 'pending'),
    P: task('P', 'pending', { planningRequired: true }),
    D: task('D', 'done'),
  }
  const derived = { K: { effective: 'blocked' }, E: { effective: 'ready' }, P: { effective: 'ready_to_plan' }, D: { effective: 'done' } }
  Object.assign(derived, { E2: { effective: 'ready' }, E3: { effective: 'ready' }, R: { effective: 'ready_for_review' },
    Q: { effective: 'ready_for_discussion' }, W: { effective: 'waiting' } })
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    ui.render({ run: 'available', plan: { phases: [] }, tasks, derived })
    const list = ui.nodes.get('#available').innerHTML
    assert.equal(ui.nodes.get('#availableBox').hidden, false)
    assert.deepEqual([...list.matchAll(/jumpTo\('(\w+)'\)/g)].map(m => m[1]), ['K', 'R', 'E', 'E2', 'E3', 'P', 'Q'], 'todas as disponíveis aparecem, com decisões primeiro e a ordem dos próximos papéis preservada')
    assert.doesNotMatch(list, /avail-more/)
    assert.match(list, /--role:var\(--blocked\)[\s\S]*pick &lt;the&gt; API version/)
    assert.match(list, lang === 'en' ? /Decision question: Which API version should ship\? · Options: v1 \/ v2/ :
      /Pergunta para decisão: Which API version should ship\? · Opções: v1 \/ v2/)
    ui.run("POP_EXPANDED = false; fillPop('K')")
    const blockedPopover = ui.nodes.get('#popBody').innerHTML
    assert.equal((blockedPopover.match(/pick &lt;the&gt; API version/g) ?? []).length, 1, 'the blocked reason appears once in the lean popover')
    assert.match(list, /--role:var\(--running\)[\s\S]*\$ bun test auth[\s\S]*12 tests pass/)
    assert.match(list, /--role:var\(--planning\)/)
    assert.match(list, lang === 'en' ? /needs you/ : /precisa de você/)
    ui.run("POP_EXPANDED = true; fillPop('K')")
    const blockedDetail = ui.nodes.get('#popBody').innerHTML
    assert.match(blockedDetail, lang === 'en' ? /Decision question/ : /Pergunta para decisão/)
    assert.match(blockedDetail, /v1 \/ v2/)
    ui.run('closePop()')
    const availableTarget = { closest(selector) { return selector === '.avail' ? this : null } }
    const emptyTarget = { closest() { return null } }
    ui.run('SIDEBAR_COLLAPSED = true; applySidebar()')
    ui.dispatchDocument('click', { target: availableTarget }, () => ui.run("jumpTo('E')"))
    assert.equal(ui.nodes.get('#sidebar').hidden, true, 'abrir uma tarefa respeita a escolha de recolher a lateral')
    assert.equal(ui.nodes.get('#availableBox').hidden, false)
    assert.match(ui.nodes.get('#popBody').innerHTML, /Task E/)
    assert.equal(ui.run('POP.id'), 'E', 'the card inline handler opens before the bubbling document handler')
    ui.dispatchDocument('click', { target: emptyTarget })
    assert.equal(ui.run('POP'), null, 'clicking empty space still closes the pinned task')
    assert.equal(ui.nodes.get('#availableBox').hidden, false)
  }
})

test('discovery, planner identity and task plan render as escaped text, including answers and checks', () => {
  const hostile = '<img src=x onerror="alert(1)">&\'text'
  const recorded = { ...plan, planner: hostile,
    research: [{ source: hostile, findings: hostile }], decisions: [{ question: hostile, answer: hostile }],
    steps: [hostile], verification: [{ criterion: hostile, check: 1 }],
    openQuestions: [{ question: hostile, blocking: true, answer: hostile }, { question: 'Follow up', blocking: false }],
  }
  const hostileDiscovery = { ...discovery, closure: hostile,
    research: [{ source: hostile, findings: hostile }],
    questions: [{ question: hostile, answer: hostile, channel: 'chat-fallback', round: 1 }],
    coverage: Object.fromEntries(Object.keys(discovery.coverage).map(key => [key, hostile])),
    decisions: [{ question: hostile, answer: hostile }], deferred: [hostile],
    executionBoundary: { deferredToExecutor: ['T'], prematureTaskWork: [] } }
  const ui = dashboard('pt-BR')
  ui.render({ run: 'safe-plan', plan: {}, tasks: { T: task('T', 'pending', { discovery: hostileDiscovery, planner: hostile, taskPlan: recorded }) }, derived: { T: { effective: 'ready' } } })
  ui.run("POP_EXPANDED = true; fillPop('T')")
  const body = ui.nodes.get('#popBody').innerHTML
  assert.doesNotMatch(body, /<img|onerror="/)
  assert.match(body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;&#39;text/)
  for (const text of ['Descoberta da tarefa', 'Pesquisa da descoberta', 'Discussão', 'Cobertura PO First', 'Decisões da descoberta', 'Ideias adiadas',
    'Planejador', 'Plano registrado da tarefa', 'Pesquisa', 'Decisões', 'Passos de execução', 'Verificação', 'Perguntas', 'verificação 1', 'não bloqueante']) assert.ok(body.includes(text), text)
})

test('dashboard keeps a future open-question reference and its later decision visible', () => {
  const reference = 'T:plan:012345abcdef'
  for (const [lang, deadline, resolved] of [
    ['en', 'before task U', 'resolved by U'],
    ['pt-BR', 'antes da tarefa U', 'resolvida por U'],
  ]) {
    const ui = dashboard(lang)
    const state = { run: 'question-reference', plan: {}, tasks: {
      T: task('T', 'pending', { taskPlan: { ...plan, openQuestions: [{ question: 'Which protocol should U use?',
        blocking: false, decideBy: { beforeTask: 'U' }, questionRef: reference }] } }),
    }, questionResolutions: [{ questionRef: reference, byTask: 'U', answer: 'Use the existing client.' }],
      derived: { T: { effective: 'ready' } } }
    ui.render(state)
    ui.run("POP_EXPANDED = true; fillPop('T')")
    const detail = ui.nodes.get('#popBody').innerHTML
    assert.ok(detail.includes(reference))
    assert.ok(detail.includes('Which protocol should U use?'))
    assert.ok(detail.includes(deadline))
    assert.ok(detail.includes(resolved))
    assert.ok(detail.includes('Use the existing client.'))
  }
})

test('lean popover shows role-written summaries, escaped, and never the full plan', () => {
  const hostile = '<img src=x onerror="alert(1)">'
  const ui = dashboard('pt-BR')
  ui.render({ run: 'lean', plan: {}, tasks: { T: task('T', 'done', {
    summary: `Checkout avisado ${hostile}`, validationSummary: 'O aviso chega com 200',
    validation: [{ run: 'bun test', expect: 'doze testes passam' }],
    taskPlan: { ...plan, summary: 'caminho do planejador', steps: ['passo secreto do plano'] },
    attempts: [{ n: 1, agent: 'exec-1', startedAt: instant(1), endedAt: instant(5), result: 'passed' }],
    validations: [{ ok: false, at: instant(3), evidence: 'evidencia longa', summary: 'reprovado: HTTP 500' }],
  }) }, derived: { T: { effective: 'done' } } })
  ui.run("POP_EXPANDED = false; fillPop('T')")
  const lean = ui.nodes.get('#popBody').innerHTML
  assert.doesNotMatch(lean, /<img|onerror="/)
  assert.ok(lean.includes('Checkout avisado &lt;img'), 'task summary wins over the planner summary')
  assert.ok(lean.includes('O aviso chega com 200'))
  assert.ok(lean.includes('reprovado: HTTP 500'), 'the journey uses the verdict summary')
  assert.ok(!lean.includes('passo secreto do plano') && !lean.includes('doze testes passam'), 'lean hides the full text')
  assert.ok(!lean.includes('No summary recorded'))

  ui.run("POP_EXPANDED = true; fillPop('T')")
  const detail = ui.nodes.get('#popBody').innerHTML
  for (const text of ['passo secreto do plano', 'doze testes passam', 'caminho do planejador', 'evidencia longa', 'reprovado: HTTP 500']) assert.ok(detail.includes(text), text)
})

test('lean popover without a summary shows the notice once and never repeats the title', () => {
  const ui = dashboard('pt-BR')
  ui.render({ run: 'old', plan: {}, tasks: {
    T: task('T', 'pending', { summary: '   ', validation: 'contrato antigo em prosa' }),
    L: task('L', 'pending', { label: 'Webhooks do gateway', title: 'Linha original 1\nLinha original 2\nLinha original 3\nLinha original 4' }),
  }, derived: { T: { effective: 'ready' }, L: { effective: 'ready' } } })
  ui.run("POP_EXPANDED = false; fillPop('T')")
  let lean = ui.nodes.get('#popBody').innerHTML
  assert.equal((lean.match(/Task T/g) ?? []).length, 2, 'the title appears only in the header (text and tooltip)')
  assert.doesNotMatch(lean, /class="lead"/, 'no summary body repeats the header title')
  assert.match(lean, /class="ptxt clamp">contrato antigo em prosa/)
  assert.equal((lean.match(/class="nosum"/g) ?? []).length, 1, 'a blank summary counts as absent and the notice appears once')
  assert.equal((lean.match(/No summary recorded/g) ?? []).length, 2, 'one notice: its i18n key and its text')

  // with a short label in the header, the original text is new information: first 3 lines only
  ui.run("fillPop('L')")
  lean = ui.nodes.get('#popBody').innerHTML
  const preview = lean.match(/class="psec nosum-box">[\s\S]*?<div class="lead">([\s\S]*?)<\/div>/)?.[1] ?? ''
  assert.equal(preview, 'Linha original 1\nLinha original 2\nLinha original 3')
  assert.equal((lean.match(/class="nosum"/g) ?? []).length, 1)

  // expanded/detail follows the same rule, but keeps every line
  ui.run("POP_EXPANDED = true; fillPop('T')")
  let detail = ui.nodes.get('#popBody').innerHTML
  assert.equal((detail.match(/Task T/g) ?? []).length, 2, 'the detail header alone carries the title (text and tooltip)')
  assert.doesNotMatch(detail, /class="psec summary-block"/)
  assert.match(detail, /class="psec nosum-box">[\s\S]*data-i18n="No summary recorded">No summary recorded</)
  assert.match(detail, /class="detail-title full"/, 'without a label the header title wraps instead of being cut')
  ui.run("fillPop('L')")
  detail = ui.nodes.get('#popBody').innerHTML
  assert.match(detail, /class="psec summary-block">[\s\S]*<div class="lead">Linha original 1\nLinha original 2\nLinha original 3\nLinha original 4<\/div>/)
  assert.match(detail, /class="detail-title"/)
  assert.match(html, /#pop \.detail-title\.full \{[^}]*white-space: pre-wrap/)
})

test('the hub (orchestrator and roles) stays inside the viewport while the board scrolls down', () => {
  for (const width of [1110, 30]) { // 1440 and 360 wide windows (the harness adds 330px of sidebar)
    const ui = dashboard('en', width)
    ui.render(graphState(120, 6))
    const hubTop = ui.run('HUB_TOP')
    ui.run('VIEW.y = 0; applyView()')
    assert.equal(ui.nodes.get('#hub').style.transform, '', 'at the top the hub sits in its natural place')
    assert.equal(ui.nodes.get('#hub').classList.contains('stuck'), false)
    ui.run(`VIEW.y = -${hubTop + 12}; applyView()`)
    assert.equal(ui.nodes.get('#hub').style.transform, 'translateY(12px)', 'no jump: the hub moves by the distance past its padding')
    for (const scrolled of [-600, -1500, -100000]) {
      ui.run(`VIEW.y = ${scrolled}; applyView()`)
      const y = ui.run('VIEW.y')
      assert.ok(y < -hubTop, `the fixture scrolls (VIEW.y = ${y})`)
      const offset = Number(ui.nodes.get('#hub').style.transform.match(/translateY\((\d+(?:\.\d+)?)px\)/)?.[1])
      const shadeTopOnScreen = y + offset + hubTop
      assert.equal(shadeTopOnScreen, 0, 'the pinned shade starts at the top edge of the graph area')
      const orchTopOnScreen = y + offset + ui.run('PAD')
      assert.ok(orchTopOnScreen > 0 && orchTopOnScreen + ui.run('ORCH_H') < 700, 'the orchestrator card is fully in the viewport')
      assert.equal(ui.nodes.get('#hub').classList.contains('stuck'), true)
    }
    ui.run('VIEW.y = 0; applyView()')
    assert.equal(ui.nodes.get('#hub').style.transform, '', 'scrolling back returns it to its place')
  }
  // the frame lines move with the hub; the base line and plumb stay with the phases
  const ui = dashboard('en', 1110)
  ui.render(graphState(3, 1))
  assert.match(ui.nodes.get('#hubPaths').innerHTML, /class="s-frame"/)
  assert.doesNotMatch(ui.nodes.get('#structPaths').innerHTML, /class="s-frame"/)
  assert.match(ui.nodes.get('#structPaths').innerHTML, /class="s-base"/)
  const struct = ui.nodes.get('#structPaths').innerHTML
  const rail = struct.match(/<line class="s-rail (?:done|live|next)" x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/)
  assert.ok(rail, 'the phase guide is a dashed vertical rail')
  assert.equal(rail[1], rail[3], 'the guide does not swing sideways')
  assert.notEqual(rail[2], rail[4], 'the guide extends vertically through the phases')
  assert.match(struct, /<circle class="s-end-dot live"/)
  assert.doesNotMatch(struct, /s-sway|s-bob/)
  assert.match(html, /svg#edges \.s-rail \{ stroke-linecap: round; \}/)
  assert.match(html, /svg#edges \.s-rail\.live \{ stroke-dasharray: 3 6; \}/)
  assert.match(html, /svg#edges \.s-spinner \{[^}]*animation: activity-spin/)
  assert.doesNotMatch(html, /@keyframes sway/)
  assert.match(html, /#hub \{ position: absolute; top: 0; left: 0; z-index: 4;/)
  assert.match(html, /#hub\.stuck \.hub-shade \{ display: block; background: var\(--bg\); border-bottom: 1px solid var\(--line\);/,
    'pinned: opaque ground and a hairline, no new colours')
  assert.match(html, /<div id="hub">[\s\S]*id="orchNode"[\s\S]*id="planNode"[\s\S]*id="execNode"[\s\S]*id="revNode"[\s\S]*<\/div>\n    <svg id="edges">/)
})

test('on a phone the pinned hub folds into a compact strip fixed to the visible area', () => {
  const ui = dashboard('en', 30)
  ui.run("matchMedia = (query) => ({ matches: query === '(max-width: 700px)' })")
  ui.render(graphState(120, 6))
  const hub = ui.nodes.get('#hub')
  ui.run('VIEW.y = 0; VIEW.x = -140; applyView()')
  assert.equal(hub.classList.contains('compact'), false, 'at the top the hub keeps its full layout')
  ui.run('VIEW.y = -900; VIEW.x = -140; applyView()')
  const x = ui.run('VIEW.x'), y = ui.run('VIEW.y'), hubTop = ui.run('HUB_TOP')
  assert.equal(hub.classList.contains('compact'), true)
  assert.equal(hub.classList.contains('stuck'), true)
  const [, dx, dy] = hub.style.transform.match(/translate\((-?\d+(?:\.\d+)?)px, (\d+(?:\.\d+)?)px\)/) ?? []
  assert.equal(x + Number(dx), 0, 'the horizontal pan is cancelled: the strip starts at the left edge of the graph area')
  assert.equal(y + Number(dy) + hubTop, 0, 'and at its top edge')
  ui.run('VIEW.y = 0; applyView()')
  assert.equal(hub.classList.contains('compact'), false)
  assert.equal(hub.style.transform, '')
  assert.match(html, /#hub\.compact svg#hubPaths \{ display: none; \}/)
  assert.match(html, /#hub\.compact \{ --hub-col: calc\(\(100vw - 48px\) \/ 2\); \}/, 'two columns, 32px left for the sidebar toggle')
})

test('the hub stays hidden until the layout has placed its roles', () => {
  const ui = dashboard('en', 1110)
  const hub = ui.run("$('#hub')")
  assert.equal(hub.classList.contains('placed'), false, 'before the first paint the cards are not shown at 0,0')
  ui.render(graphState(3, 1))
  assert.equal(hub.classList.contains('placed'), true)
  ui.run("selectRun('root-b/run-b')")
  assert.equal(hub.classList.contains('placed'), false, 'a run switch hides it again until the new layout')
  assert.match(html, /#hub:not\(\.placed\) \{ visibility: hidden; \}/)
})

test('page never scrolls sideways: hidden sidebar leaves the layout, main rows are pinned, long tokens wrap', () => {
  assert.match(html, /main > aside\[hidden\] \{ display: none; \}/, 'aside display:flex must not beat [hidden]')
  assert.match(html, /main \{ grid-area: 2 \/ 1; display: grid; grid-template-columns: minmax\(0, 1fr\) 360px; grid-template-rows: minmax\(0, 1fr\);\s*min-height: 0; overflow: hidden;/,
    'the sidebar scrolls inside its row instead of growing past the viewport')
  assert.match(html, /#pop \.ptxt \{[^}]*overflow-wrap: anywhere; \}/)
})

test('an open sidebar on a phone overlays the graph instead of widening the page', () => {
  const phone = html.slice(html.indexOf('main.sidebar-collapsed #sidebarToggle { right: 0; }'))
  const block = phone.slice(phone.indexOf('@media (max-width: 700px) {'), phone.indexOf('\n  }', phone.indexOf('@media (max-width: 700px) {')))
  assert.match(block, /main, main\.sidebar-collapsed \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  assert.match(block, /main > aside \{ position: absolute;[^}]*width: min\(360px, calc\(100vw - 32px\)\)/)
  assert.match(block, /#sidebarToggle \{ right: min\(360px, calc\(100vw - 32px\)\); \}/)
})

test('detail preserves every recorded line in summaries, plans and validations while lean remains a preview', () => {
  const summary = 'Resumo 1\nResumo 2\nResumo 3\nResumo 4 <img src=x onerror="alert(1)">'
  const approach = 'Abordagem 1\nAbordagem 2\nAbordagem 3\nAbordagem 4'
  const research = 'Pesquisa 1\nPesquisa 2\nPesquisa 3\nPesquisa 4 <script>alert(1)</script>'
  const question = 'Pergunta 1\nPergunta 2\nPergunta 3\nPergunta 4'
  const answer = 'Decisão 1\nDecisão 2\nDecisão 3\nDecisão 4'
  const steps = 'Passo 1\nPasso 2\nPasso 3\nPasso 4'
  const criterion = 'Critério 1\nCritério 2\nCritério 3\nCritério 4'
  const check = 'Checagem 1\nChecagem 2\nChecagem 3\nChecagem 4'
  const rejectedSummary = 'Parecer reprovado 1\nParecer reprovado 2\nParecer reprovado 3\nParecer reprovado 4'
  const rejectedEvidence = 'Evidência reprovada 1\nEvidência reprovada 2\nEvidência reprovada 3\nEvidência reprovada 4'
  const approvedSummary = 'Parecer aprovado 1\nParecer aprovado 2\nParecer aprovado 3\nParecer aprovado 4'
  const approvedEvidence = 'Evidência aprovada 1\nEvidência aprovada 2\nEvidência aprovada 3\nEvidência aprovada 4'
  const extraEvidence = 'Validação extra 1\nValidação extra 2\nValidação extra 3\nValidação extra 4'
  const ui = dashboard('pt-BR')
  ui.render({ run: 'full-detail', plan: {}, tasks: { T: task('T', 'done', {
    summary,
    taskPlan: { ...plan, summary: approach,
      research: [{ source: 'arquivo atual', findings: research }],
      decisions: [{ question, answer }], steps: [steps],
      verification: [{ criterion, check }] },
    attempts: [{ n: 1, agent: 'executor-1', startedAt: instant(1), endedAt: instant(10) }],
    validations: [
      { attempt: 1, by: 'review', agent: 'revisor-1', ok: false, at: instant(2), summary: rejectedSummary, evidence: rejectedEvidence },
      { attempt: 1, by: 'review', agent: 'revisor-2', ok: true, at: instant(5), summary: approvedSummary, evidence: approvedEvidence },
      { attempt: 1, by: 'executor', agent: 'executor-1', ok: true, at: instant(8), evidence: extraEvidence },
    ],
  }) }, derived: { T: { effective: 'done' } } })

  ui.run("POP_EXPANDED = false; fillPop('T')")
  const lean = ui.nodes.get('#popBody').innerHTML
  for (const line of ['Resumo 1', 'Resumo 2', 'Resumo 3', 'Resumo 4 &lt;img']) assert.ok(lean.includes(line), line)
  assert.doesNotMatch(lean, /Pesquisa 4|Evidência aprovada 4/)

  ui.run("POP_EXPANDED = true; fillPop('T')")
  const detail = ui.nodes.get('#popBody').innerHTML
  for (const text of ['Resumo 4 &lt;img', 'Abordagem 4', 'Pesquisa 4 &lt;script&gt;', 'Pergunta 4', 'Decisão 4',
    'Passo 4', 'Critério 4', 'Checagem 4', 'Parecer reprovado 4', 'Evidência reprovada 4',
    'Parecer aprovado 4', 'Evidência aprovada 4', 'Validação extra 4']) assert.ok(detail.includes(text), text)
  assert.equal((detail.match(/class="vitem/g) ?? []).length, 3, 'every validation remains in the full list')
  assert.doesNotMatch(detail, /<img|onerror="|<script>/)

  const fallback = 'Título original 1\nTítulo original 2\nTítulo original 3\nTítulo original 4 <em>completo</em>'
  const fallbackUi = dashboard('pt-BR')
  fallbackUi.render({ run: 'fallback', plan: {}, tasks: { F: task('F', 'pending', { label: 'Título curto', title: fallback, summary: '  ' }) }, derived: { F: { effective: 'ready' } } })
  fallbackUi.run("POP_EXPANDED = false; fillPop('F')")
  const fallbackLean = fallbackUi.nodes.get('#popBody').innerHTML
  const fallbackPreview = fallbackLean.match(/<div class="lead">([\s\S]*?)<\/div>/)?.[1] ?? ''
  for (const line of ['Título original 1', 'Título original 2', 'Título original 3']) assert.ok(fallbackPreview.includes(line), line)
  assert.doesNotMatch(fallbackPreview, /Título original 4/)
  fallbackUi.run("POP_EXPANDED = true; fillPop('F')")
  assert.ok(fallbackUi.nodes.get('#popBody').innerHTML.includes('Título original 4 &lt;em&gt;completo&lt;/em&gt;'))
})

test('clicar no motivo da jornada revela o parecer e a evidência completos com texto seguro', () => {
  const ui = dashboard('pt-BR')
  const summary = 'Motivo resumido\nSegunda linha\nTerceira linha\nQuarta linha completa <script>'
  const evidence = 'Evidência completa\nÚltima linha <img onerror="alert(1)">'
  ui.render({ run: 'parecer', plan: {}, tasks: { T1: task('T1', 'failed', {
    attempts: [{ n: 1, startedAt: instant(1), reviewStartedAt: instant(2), endedAt: instant(3) }],
    validations: [{ attempt: 1, by: 'review', ok: false, at: instant(3), summary, evidence }],
  }) } })
  ui.run("POP = { id: 'T1', pinned: false }; fillPop('T1')")
  const lean = ui.nodes.get('#popBody').innerHTML
  const button = lean.match(/<button type="button" class="jstep bad" onclick="([^"]+)"[^>]*>/)
  assert.ok(button, 'o item inteiro oferece um controle acionável por mouse e teclado')
  assert.doesNotMatch(lean, /Quarta linha completa/)
  ui.run(button[1])
  assert.equal(ui.run('POP_EXPANDED && POP.pinned'), true)
  const full = ui.nodes.get('#popBody').innerHTML
  assert.match(full, /Quarta linha completa &lt;script&gt;/)
  assert.match(full, /Última linha &lt;img onerror=&quot;alert\(1\)&quot;&gt;/)
  assert.doesNotMatch(full, /<script>|<img onerror=/)
  ui.run("fillPop('T1')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /Quarta linha completa/)
})

test('todos os itens da jornada abrem os detalhes, inclusive sem parecer ou motivo', () => {
  for (const result of ['cancelled', 'done', 'running', 'approved', 'rejected']) {
    for (const reason of ['', 'Linha inicial\nLinha dois\nLinha três\nMotivo completo <script>']) {
      const ui = dashboard('pt-BR')
      const attempt = { n: 1, agent: 'executor', startedAt: instant(1), result, reason,
        ...(result === 'running' ? {} : { endedAt: instant(3) }) }
      const validations = ['approved', 'rejected'].includes(result)
        ? [{ attempt: 1, by: 'review', ok: result === 'approved', at: instant(3), evidence: reason }] : []
      ui.render({ run: 'jornada', plan: {}, tasks: { T1: task('T1', 'running', { attempts: [attempt], validations }) } })
      ui.run("POP = { id: 'T1', pinned: false }; fillPop('T1')")
      const lean = ui.nodes.get('#popBody').innerHTML
      const button = lean.match(/<button type="button" class="jstep [^"]*" onclick="([^"]+)"[^>]*>([\s\S]*?)<\/button>/)
      assert.ok(button, result)
      assert.doesNotMatch(button[2], /<button/, 'o item não contém controles aninhados')
      assert.doesNotMatch(lean, /Motivo completo/)
      ui.run(button[1])
      assert.equal(ui.run('POP_EXPANDED && POP.pinned'), true, result)
      assert.match(ui.nodes.get('#popBody').innerHTML, /class="attempt-row/)
      if (reason) assert.match(ui.nodes.get('#popBody').innerHTML, /Motivo completo &lt;script&gt;/)
      assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, /<script>/)
    }
  }
})

test('expanding the popover pins it, switches to detail and closing resets it', () => {
  const ui = dashboard('pt-BR')
  ui.render({ run: 'x', plan: {}, tasks: { T: task('T') }, derived: { T: { effective: 'ready' } } })
  ui.run("POP = { id: 'T', pinned: false }; POP_EXPANDED = false; togglePopExpand(true)")
  assert.equal(ui.run('POP.pinned && POP_EXPANDED'), true)
  assert.equal(ui.nodes.get('#pop').classList.contains('expanded'), true)
  assert.equal(ui.nodes.get('#popScrim').classList.contains('on'), true)
  ui.run('closePop()')
  assert.equal(ui.run('POP_EXPANDED'), false)
  assert.equal(ui.nodes.get('#pop').classList.contains('expanded'), false)
  assert.equal(ui.nodes.get('#popScrim').classList.contains('on'), false)
})

test('resultados separam ganho, atividade por papel e estimativa dos tres papeis', () => {
  const state = graphState(3, 3)
  state.tasks.T001.summary = 'A <summary>'
  state.tasks.T001.attempts = [{ n: 1, agent: 'exec-a', startedAt: instant(1), reviewStartedAt: instant(2), endedAt: instant(3), result: 'passed' },
    { n: 2, agent: 'exec-a', startedAt: instant(4), endedAt: instant(5), result: 'passed' }]
  state.tasks.T001.validations = [{ by: 'review', ok: false, at: instant(3), evidence: 'check A failed' }]
  for (const lang of ['en', 'pt-BR']) {
    const ui = dashboard(lang)
    ui.render(state, [{ type: 'task_start', at: instant(1), task: 'T001' }, { type: 'task_review', at: instant(2), task: 'T001' }, { type: 'task_retry', at: instant(4), task: 'T001' }])
    ui.run("FULL_EVENTS = EVENTS; RESULTS_OPEN = true; $('#results').classList.add('open'); renderResults(STATE)")
    const results = ui.nodes.get('#results').innerHTML
    assert.match(results, /^<div class="rstack" data-results-run="fixture-3">\s*<section class="gcard gain" id="gainPanel"[\s\S]*<\/section>\s*<section class="gcard agent-activity"[\s\S]*<\/section>\s*<section class="gcard manual" id="manualPanel"[\s\S]*<\/section><\/div>$/)
    assert.equal((results.match(/<section /g) ?? []).length, 3, 'o painel mostra ganho, atividade por papel e estimativa manual')
    assert.doesNotMatch(results, /gantt|class="grow|result-task|gcard gate|gcard atime|class="rhead|class="insights|A &lt;summary&gt;/)
    assert.doesNotMatch(results, lang === 'en' ? /Reviewer gate|Timeline|Agent time|Task detail/ : /Portão do revisor|Linha do tempo|Tempo dos agentes|Detalhe da tarefa/)
    // Apenas start e review entram na premissa; a coordenação de retry fica fora.
    assert.match(results, lang === 'en'
      ? /you would spend about <strong>6m00<\/strong> just coordinating the agents \(3 min per command × 2 commands\)/
      : /gastaria cerca de <strong>6m00<\/strong> só coordenando os agentes \(3 min por comando × 2 comandos\)/)
    assert.doesNotMatch(results, /gain-status|gain-badge/)
    assert.doesNotMatch(results, /<input|<button|data-gain-minutes/, 'the 3-minute assumption is fixed, with no editable fields')

    const key = (value) => ui.dispatchDocument('keydown', { key: value, target: { tagName: 'BODY' }, preventDefault() {} })
    key('ArrowDown')
    assert.equal(ui.run('RESULTS_OPEN'), true, 'arrows no longer walk timeline rows')
    const resultsTarget = { closest(selector) { return selector === '#results' ? this : null } }
    ui.dispatchDocument('click', { target: resultsTarget }, () => ui.run("jumpTo('T001')"))
    assert.equal(ui.run('RESULTS_OPEN'), false, 'task navigation still closes the results tab')
    assert.equal(ui.run('POP.id'), 'T001')
  }
})

test('discussão sem registros de progresso não transforma o tempo decorrido em horas de agente', () => {
  const ui = dashboard('pt-BR')
  const state = { run: 'discussion-time', createdAt: instant(0), plan: { phases: [] },
    tasks: { A: task('A', 'done', { discussionAttempts: [{ startedAt: instant(-115 * 3600), endedAt: instant(0) }], attempts: [] }) }, derived: {} }
  ui.run('EVENTS_COMPLETE = true; STATE = input; FULL_EVENTS = []; renderResults(input)', { input: state })
  const analysis = ui.run('analyse(input, [], true)', { input: state })
  assert.equal(analysis.discussionMeasured, false)
  assert.equal(analysis.unmeasuredActivity, true)
  assert.equal(analysis.agentTotal, 0)
  assert.match(ui.nodes.get('#results').innerHTML, /Discussão<\/span><strong>Não aferido/)
  assert.doesNotMatch(ui.nodes.get('#results').innerHTML, /115h/)
})

test('START e STOP medem os quatro papeis sem contar espera e fases compartilhadas duas vezes', () => {
  const interval = (role, start, end) => ({ role, startedAt: instant(start), endedAt: instant(end), agent: role })
  const round = (role, start, end) => ({ activityTiming: 'explicit', startedAt: instant(-1000), endedAt: instant(90), activityIntervals: [interval(role, start, end)] })
  const state = { run: 'explicit-time', createdAt: instant(-1000), plan: { phases: [] }, derived: {},
    tasks: { A: task('A', 'done', {
      discussionAttempts: [round('discussion', 0, 10)], planningAttempts: [round('planning', 10, 20)],
      attempts: [{ ...round('execution', 20, 30), n: 1, activityIntervals: [interval('execution', 20, 30), interval('execution', 50, 60), interval('review', 60, 70)] }],
    }), B: task('B', 'done') },
    phaseWorkflows: { F1: { id: 'F1', state: 'planned', planningAttempts: [round('planning', 0, 10)] } } }
  const ui = dashboard('pt-BR')
  const a = ui.run('analyse(input, [], true)', { input: state })
  assert.equal(a.discussionTotal, 10000)
  assert.equal(a.planningTotal, 20000)
  assert.equal(a.execTotal, 20000)
  assert.equal(a.reviewTotal, 10000)
  assert.equal(a.agentTotal, 60000)
  assert.equal(a.activeElapsed, 50000, 'o intervalo de espera entre 30 e 50 fica fora; a fase conta uma vez')
  assert.equal(a.criticalPathMeasured, false, 'o caminho por tarefa não pode omitir o trabalho compartilhado e se apresentar como aferido')
  ui.run('EVENTS_COMPLETE = true; STATE = input; FULL_EVENTS = []; renderResults(input)', { input: state })
  const result = ui.nodes.get('#results').innerHTML
  assert.match(result, /Economia estimada<\/span><strong>/)
  assert.match(result, /Cálculo estimado baseado na coordenação manual/)
  assert.doesNotMatch(result, /Ganho combinado estimado/)
  const activity = result.split('class="gcard agent-activity"')[1].split('</section>')[0]
  assert.match(activity, /--discussion[^]*Discussão<\/span><strong>10s[^]*--planning[^]*Planejamento<\/span><strong>20s[^]*--running[^]*Execução<\/span><strong>20s[^]*--review[^]*Revisão<\/span><strong>10s/)
})

test('jumping from results pans a tall graph until the target task is visible', () => {
  const ui = dashboard('en', 500)
  ui.render(graphState(48, 8))
  const before = JSON.parse(ui.run("JSON.stringify({ y: VIEW.y, taskY: LAST_POS.T048.y, height: LAST_METRICS.nodeH, viewport: $('#viewport').getBoundingClientRect().height })"))
  assert.ok(before.taskY > before.viewport, 'fixture places T048 below the initial viewport')

  ui.run("RESULTS_OPEN = true; $('#results').classList.add('open'); jumpTo('T048')")
  assert.equal(ui.run('RESULTS_OPEN'), false, 'the graph link returns to the graph')
  assert.equal(ui.run('POP.id'), 'T048', 'the target task keeps its graph detail open')
  const after = JSON.parse(ui.run("JSON.stringify({ x: VIEW.x, y: VIEW.y, taskX: LAST_POS.T048.x, taskY: LAST_POS.T048.y, width: LAST_METRICS.nodeW, height: LAST_METRICS.nodeH, viewportWidth: $('#viewport').getBoundingClientRect().width, viewportHeight: $('#viewport').getBoundingClientRect().height })"))
  const left = after.taskX + after.x
  const top = after.taskY + after.y
  assert.ok(left >= 0 && left + after.width <= after.viewportWidth,
    `T048 should fit horizontally in the viewport: ${JSON.stringify({ left, ...after })}`)
  assert.ok(top >= 0 && top + after.height <= after.viewportHeight,
    `T048 should fit vertically in the viewport: ${JSON.stringify({ top, ...after })}`)
})

test('explicit results navigation survives the click suppression left by dragging the graph', () => {
  const ui = dashboard('en', 500)
  ui.render(graphState(48, 8))
  ui.run('VIEW.x = -20; VIEW.y = -20; VIEW_MANUAL = true; applyView()')
  ui.dispatchElement('#viewport', 'pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
  ui.dispatchElement('#viewport', 'pointermove', { clientX: 112, clientY: 112, pointerId: 1 })
  ui.dispatchElement('#viewport', 'pointerup', { pointerId: 1 })
  assert.equal(ui.run('suppressClick'), true, 'the completed drag suppresses its trailing graph click')

  ui.run('toggleResults(); renderResults(STATE)')
  assert.equal(ui.run('RESULTS_OPEN'), true)
  const resultsTarget = { closest(selector) { return selector === '#results' ? this : null } }
  ui.dispatchDocument('click', { target: resultsTarget }, () => ui.run("jumpTo('T048')"))

  assert.equal(ui.run('RESULTS_OPEN'), false, 'navigation returns to the graph')
  assert.equal(ui.run('suppressClick'), false, 'explicit navigation clears stale drag suppression')
  assert.equal(ui.run('POP.id'), 'T048', 'the task details open after the jump')
  const view = JSON.parse(ui.run("JSON.stringify({ x: VIEW.x, y: VIEW.y, taskX: LAST_POS.T048.x, taskY: LAST_POS.T048.y, width: LAST_METRICS.nodeW, height: LAST_METRICS.nodeH, viewportWidth: $('#viewport').getBoundingClientRect().width, viewportHeight: $('#viewport').getBoundingClientRect().height })"))
  assert.ok(view.taskX + view.x >= 0 && view.taskX + view.x + view.width <= view.viewportWidth)
  assert.ok(view.taskY + view.y >= 0 && view.taskY + view.y + view.height <= view.viewportHeight)
})

test('navegacao anima o ultimo destino e respeita arraste e movimento reduzido', () => {
  assert.doesNotMatch(html, /navigation-reveal|body:has\(#viewport\.navigating\) #pop/,
    'o fim do deslocamento nao reinicia a animacao de abertura do card')
  const ui = dashboard('pt-BR', 500)
  ui.render(graphState(48, 8))
  ui.run("jumpTo('T048'); jumpTo('T001')")
  assert.equal(ui.run('POP.id'), 'T001')
  assert.equal(ui.nodes.get('#viewport').classList.contains('navigating'), true)
  ui.dispatchElement('#viewport', 'wheel', { preventDefault() {}, deltaX: 0, deltaY: 20 })
  assert.equal(ui.nodes.get('#viewport').classList.contains('navigating'), false)
  ui.run("matchMedia = () => ({matches:true}); jumpTo('T048')")
  assert.equal(ui.run('POP.id'), 'T048')
  assert.equal(ui.nodes.get('#viewport').classList.contains('navigating'), false)
})

test('localizar uma tarefa distante mantém o filtro e a centraliza a partir do card expandido', () => {
  const ui = dashboard('pt-BR', 500)
  ui.render(graphState(48, 8))
  assert.match(html, /id="popLocate"[^>]*onclick="locateSelectedTask\(\)"/)
  ui.run("setFilter('incomplete'); openTask('T048'); togglePopExpand(true)")
  assert.equal(ui.run('POP_EXPANDED'), true)
  assert.equal(ui.run('FILTER'), 'incomplete')
  ui.run('locateSelectedTask()')
  assert.equal(ui.run('FILTER'), 'incomplete', 'o filtro compatível permanece ativo')
  assert.equal(ui.run('POP.id'), 'T048')
  assert.equal(ui.run('POP.pinned'), true)
  assert.equal(ui.run('POP_EXPANDED'), false, 'o card volta ao resumo junto da tarefa')
  assert.equal(ui.nodes.get('#popScrim').classList.contains('on'), false)
  assert.equal(ui.run('VIEW_MANUAL'), true)
  const view = JSON.parse(ui.run("JSON.stringify({ x: VIEW.x, y: VIEW.y, taskX: LAST_POS.T048.x, taskY: LAST_POS.T048.y, width: LAST_METRICS.nodeW, height: LAST_METRICS.nodeH, viewportWidth: $('#viewport').getBoundingClientRect().width, viewportHeight: $('#viewport').getBoundingClientRect().height })"))
  assert.ok(view.taskX + view.x >= 0 && view.taskX + view.x + view.width <= view.viewportWidth)
  assert.ok(view.taskY + view.y >= 0 && view.taskY + view.y + view.height <= view.viewportHeight)
  ui.render(graphState(48, 8))
  assert.equal(ui.run('VIEW_MANUAL'), true, 'a atualização não desfaz a navegação manual')
})

test('IDs F dos cabeçalhos e cards levam à fase real sem perder o alvo', () => {
  const ui = dashboard('pt-BR', 500)
  const state = graphState(48, 8)
  state.plan.phases[7].id = 'f8B'
  for (const value of Object.values(state.tasks)) if (value.phase === 'P8') value.phase = 'f8B'
  ui.render(state)
  const laneMarkup = ui.nodes.get('#lanes').innerHTML
  assert.match(laneMarkup, /<button type="button" class="ln"[^>]*onclick="jumpToPhase\('f8B'\)" aria-label="[^"]*: F8b">F8b<\/button>/)
  assert.match(html, /\.lane-h \.ln:focus-visible, #pop \.phase-link:focus-visible \{ outline: 2px solid var\(--accent\)/)
  ui.run("setFilter('done'); jumpToPhase('f8B')")
  assert.equal(ui.run('FILTER'), 'all')
  assert.equal(ui.run('VIEW_MANUAL'), true)
  const horizontal = JSON.parse(ui.run("JSON.stringify({ x: VIEW.x, canvas: CANVAS_W, viewport: $('#viewport').getBoundingClientRect().width })"))
  assert.ok(horizontal.canvas > horizontal.viewport, 'a contraprova usa um quadro mais largo que a janela')
  assert.ok(40 + horizontal.x >= 0 && 40 + horizontal.x < horizontal.viewport,
    'o ID F, posicionado à esquerda do quadro, continua visível após navegar')
  const lane = ui.run("LAST_LANES.find(phase => phase.id === 'f8B')")
  const viewY = ui.run('VIEW.y')
  assert.ok(lane.y + viewY >= ui.run('BASE_Y') && lane.y + viewY < 700,
    'a fase fica visível abaixo do cabeçalho fixo, respeitando o limite do quadro')
  ui.run("openTask('T048')")
  const lean = ui.nodes.get('#popBody').innerHTML
  assert.match(lean, /class="chip phase-link"[^>]*onclick="jumpToPhase\('f8B'\)"[^>]*>F8b<\/button>/)
  ui.run('togglePopExpand(true)')
  assert.match(ui.nodes.get('#popBody').innerHTML, /class="chip phase-link"[^>]*onclick="jumpToPhase\('f8B'\)"[^>]*>F8b<\/button>/)
  ui.run("jumpToPhase('f8B')")
  assert.equal(ui.run('POP'), null, 'o card expandido fecha para mostrar o quadro')
  assert.equal(ui.nodes.get('#popScrim').classList.contains('on'), false)
  const before = ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y, filter: FILTER, open: RESULTS_OPEN })')
  ui.run("jumpToPhase('fase-inexistente')")
  assert.equal(ui.run('JSON.stringify({ x: VIEW.x, y: VIEW.y, filter: FILTER, open: RESULTS_OPEN })'), before)
})

test('task planning envelopes stay unmeasured and are subtracted from execution queue time', () => {
  const ui = dashboard()
  const completePlan = { ...plan, startedAt: instant(15), completedAt: instant(20) }
  const tasks = {
    D: task('D', 'done', { planningRequired: true, taskPlan: completePlan, planningHistory: [completePlan],
      planningAttempts: [
        { startedAt: instant(0), endedAt: instant(10), result: 'blocked' },
        { startedAt: instant(15), endedAt: instant(20), result: 'planned' },
      ], attempts: [{ startedAt: instant(30), reviewStartedAt: instant(50), endedAt: instant(60) }],
      validations: [{ by: 'review', attempt: 1, ok: true, at: instant(60) }] }),
    P: task('P', 'planning', { planningAttempts: [{ startedAt: instant(80) }] }),
    L: task('L', 'done', { attempts: [{ startedAt: instant(10), endedAt: instant(20) }] }),
  }
  const state = { run: 'metrics', createdAt: instant(0), plan: {}, tasks, derived: {} }
  const events = [
    { type: 'task_start', task: 'D', attempt: 1, at: instant(30) },
    { type: 'task_review', task: 'D', attempt: 1, at: instant(50) },
    { type: 'task_review_progress', task: 'D', attempt: 1, at: instant(60) },
    { type: 'task_validate', task: 'D', attempt: 1, by: 'review', at: instant(60) },
    { type: 'task_done', task: 'D', attempt: 1, at: instant(60) },
    { type: 'task_start', task: 'L', attempt: 1, at: instant(10) },
    { type: 'task_progress', task: 'L', attempt: 1, at: instant(20) },
    { type: 'task_done', task: 'L', attempt: 1, at: instant(20) },
  ]
  const result = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
  assert.equal(result.planningTotal, 0, 'task plan envelopes have no active planning telemetry')
  assert.equal(result.execTotal, 30000)
  assert.equal(result.reviewTotal, 10000)
  assert.equal(result.agentTotal, 40000)
  assert.equal(result.planningMeasured, false)
  assert.equal(result.per.find((t) => t.id === 'D').unmeasured, true)
  assert.equal(result.wall, 100000)
  assert.equal(result.anyLive, true)
  assert.equal(result.per.find((t) => t.id === 'D').queue, 10000)
  assert.equal(result.per.find((t) => t.id === 'P').queue, null)
  assert.equal(result.per.find((t) => t.id === 'L').queue, 10000)
  ui.run('FULL_EVENTS = inputEvents; renderResults(input)', { input: state, inputEvents: events })
  assert.doesNotMatch(ui.nodes.get('#results').innerHTML, /gain-status|so far/)
})

test('results count shared phase planning once and keep pending runs live', () => {
  const ui = dashboard()
  const tasks = {
    A: task('A', 'done', { phase: 'F1', attempts: [{ startedAt: instant(30), endedAt: instant(40) }] }),
    B: task('B', 'pending', { phase: 'F2' }),
  }
  const state = { run: 'phase-metrics', createdAt: instant(0), plan: {}, tasks, derived: {}, phaseWorkflows: {
    F1: { id: 'F1', state: 'planned', planningAttempts: [{ startedAt: instant(10), endedAt: instant(20) }] },
    F2: { id: 'F2', state: 'planning', planningAttempts: [{ startedAt: instant(80) }] },
  } }
  const events = [{ type: 'task_start', task: 'A', attempt: 1, at: instant(30) },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(40) },
    { type: 'task_done', task: 'A', attempt: 1, at: instant(40) }]
  const result = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
  assert.equal(result.planningTotal, 0, 'phase envelopes without activity events are not active planning time')
  assert.equal(result.agentTotal, 10000)
  assert.equal(result.wall, 100000)
  assert.equal(result.anyLive, true, 'pending work keeps the run live even when no executor is active')
  assert.equal(JSON.stringify(result.phasePlanningByPhase), '[]')
  assert.equal(result.phasePlanning.find((attempt) => attempt.phase === 'F1').elapsed, 10000)
  assert.equal(result.phasePlanning.find((attempt) => attempt.phase === 'F2').elapsed, 20000)
  assert.equal(result.cpLen, 10000, 'unmeasured phase envelopes do not inflate the critical path')
  assert.equal(result.criticalPathMeasured, false, 'a path that omits unmeasured phase planning is not authoritative')
  ui.run('FULL_EVENTS = inputEvents; renderResults(input)', { input: state, inputEvents: events })
  const results = ui.nodes.get('#results').innerHTML
  assert.doesNotMatch(results, /open for|elapsed |1m40/, 'the unmeasured phase envelope never shows as time')
})

test('gain card omits a long phase-planning envelope without active telemetry', () => {
  const elapsedSeconds = 115 * 3600 + 23 * 60
  const start = instant(100 - elapsedSeconds)
  const state = {
    run: 'long-plan', createdAt: start,
    plan: { planningMode: 'phase', phases: [{ id: 'F1', title: 'Phase 1' }] },
    tasks: { A: task('A', 'pending', { phase: 'F1' }) }, derived: {},
    phaseWorkflows: { F1: { id: 'F1', state: 'planning', planningAttempts: [{ startedAt: start, targets: ['A'] }] } },
  }
  const ui = dashboard('pt-BR')
  ui.run('STATE = input; FULL_EVENTS = []; renderResults(input)', { input: state })
  const results = ui.nodes.get('#results').innerHTML
  const cardStart = results.indexOf('<section class="gcard gain"')
  const cardEnd = results.indexOf('</section>', cardStart)
  const measured = results.slice(cardStart, cardEnd)
  assert.ok(cardStart >= 0)
  assert.doesNotMatch(measured, /gain-status|até agora/)
  assert.match(measured, /Não aferido/)
  assert.doesNotMatch(measured, /115h/)
  assert.doesNotMatch(results, /115h|115:23/)
})

test('o tour só resume o ganho real do #39 com run concluída e medição íntegra', () => {
  const ui = dashboard('pt-BR')
  const runState = {
    run: 'finished', createdAt: instant(0), plan: { phases: [] },
    tasks: { A: task('A', 'done', { attempts: [{ n: 1, startedAt: instant(0), endedAt: instant(20) }] }) },
    derived: { A: { effective: 'done' } },
  }
  const events = [
    { type: 'task_start', task: 'A', attempt: 1, at: instant(0) },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(20), current: 1, total: 1 },
    { type: 'task_done', task: 'A', attempt: 1, at: instant(20) },
  ]
  const load = (run, state, history, complete) => ui.run(
    "SELECTED_ROOT = inputRoot; SELECTED_RUN = inputRun; CURRENT_ROOT = inputRoot; CURRENT_RUN = inputRun; STATE = inputState; FULL_EVENTS = inputEvents; EVENTS = inputEvents; EVENTS_COMPLETE = inputComplete; STATE_RUN_KEY = inputRoot + '\\0' + inputRun; EVENT_HISTORY_KEY = STATE_RUN_KEY",
    { inputRoot: 'root-a', inputRun: run, inputState: state, inputEvents: history, inputComplete: complete },
  )
  load('finished', runState, events, true)
  assert.equal(ui.run('selectedRunStateAvailable()'), true)
  const measured = JSON.parse(ui.run('JSON.stringify(getCompletedRunSummary())'))
  assert.equal(measured.completed, true)
  assert.equal(measured.measurementComplete, true)
  assert.equal(measured.text, 'Sem prumo: 3m20 · Fator de paralelismo: 1,00× · No prumo: 20s · Economia aferida: 0s · Economia estimada: 3m00')

  ui.run("SELECTED_ROOT = 'root-b'; SELECTED_RUN = 'loading'; CURRENT_ROOT = 'root-b'; CURRENT_RUN = 'loading'")
  assert.equal(ui.run('selectedRunStateAvailable()'), false, 'A não fica disponível enquanto a seleção aponta para B')
  assert.equal(ui.run('getCompletedRunSummary()'), null, 'o guia não reutiliza o resumo de A durante o carregamento de B')

  load('finished', runState, events, false)
  const incompleteHistory = JSON.parse(ui.run('JSON.stringify(getCompletedRunSummary())'))
  assert.equal(incompleteHistory.completed, true)
  assert.equal(incompleteHistory.measurementComplete, false)
  assert.equal(incompleteHistory.text, undefined)

  const pauseSeconds = 115 * 3600 + 23 * 60
  const gapState = {
    ...runState,
    tasks: { A: task('A', 'done', { attempts: [{ n: 1, startedAt: instant(0), endedAt: instant(pauseSeconds + 20) }] }) },
  }
  const sparseEvents = [
    { type: 'task_start', task: 'A', attempt: 1, at: instant(0) },
    { type: 'task_done', task: 'A', attempt: 1, at: instant(pauseSeconds + 20) },
  ]
  load('finished', gapState, sparseEvents, true)
  const unmeasuredGap = JSON.parse(ui.run('JSON.stringify(getCompletedRunSummary())'))
  assert.equal(unmeasuredGap.completed, true)
  assert.equal(unmeasuredGap.measurementComplete, false)
  assert.equal(unmeasuredGap.text, undefined)
  assert.doesNotMatch(JSON.stringify(unmeasuredGap), /115h|115:23/)

  const planningState = {
    ...runState,
    phaseWorkflows: { P1: { id: 'P1', state: 'done', planningAttempts: [{ startedAt: instant(0), endedAt: instant(pauseSeconds) }] } },
  }
  load('finished', planningState, events, true)
  const unmeasuredPlanning = JSON.parse(ui.run('JSON.stringify(getCompletedRunSummary())'))
  assert.equal(unmeasuredPlanning.completed, true)
  assert.equal(unmeasuredPlanning.measurementComplete, false)
  assert.equal(unmeasuredPlanning.text, undefined)
})
test('gain waits for complete events when an old block falls outside the last 120 events', () => {
  const ui = dashboard('pt-BR')
  const pauseSeconds = 115 * 3600 + 23 * 60
  const doneSeconds = pauseSeconds + 20
  const input = { run: 'old-block', createdAt: instant(0), plan: {}, derived: {}, tasks: {
    A: task('A', 'done', { attempts: [{ n: 1, startedAt: instant(0), endedAt: instant(doneSeconds), result: 'done' }] }),
  } }
  const fullEvents = [
    { type: 'task_start', task: 'A', attempt: 1, at: instant(0) },
    { type: 'task_block', task: 'A', attempt: 1, at: instant(10) },
    { type: 'task_unblock', task: 'A', attempt: 1, state: 'running', at: instant(pauseSeconds + 10) },
    ...Array.from({ length: 117 }, (_, index) => ({ type: 'task_note', task: 'NOISE', at: instant(pauseSeconds + 11 + index) })),
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(doneSeconds), current: 1, total: 1 },
    { type: 'task_done', task: 'A', attempt: 1, at: instant(doneSeconds) },
  ]
  const recentEvents = fullEvents.slice(-120)
  assert.equal(recentEvents.length, 120)
  assert.ok(recentEvents.some((event) => event.type === 'task_unblock'))
  assert.ok(!recentEvents.some((event) => event.type === 'task_block'))

  ui.run('EVENTS_COMPLETE = true; STATE = input; FULL_EVENTS = full; renderResults(input)', { input, full: fullEvents })
  const completeResult = ui.run('analyse(input, full)', { input, full: fullEvents })
  assert.equal(completeResult.per[0].agentTime, 20_000)
  assert.deepEqual(JSON.parse(JSON.stringify(completeResult.per[0].spans)), [
    ['exec', Date.parse(instant(0)), Date.parse(instant(10))],
    ['exec', Date.parse(instant(pauseSeconds + 10)), Date.parse(instant(doneSeconds))],
  ], 'somente os intervalos comprovados por marcos de início, bloqueio, retomada e progresso entram na medição')
  const gainCardOf = (html) => html.slice(html.indexOf('<section class="gcard gain"'), html.indexOf('</section>', html.indexOf('<section class="gcard gain"')))
  const completeHtml = ui.nodes.get('#results').innerHTML
  const completeCard = gainCardOf(completeHtml)
  assert.match(completeCard, /20s/)
  assert.doesNotMatch(completeCard, /115h|115:23/)
  assert.doesNotMatch(completeHtml, /115h|115:23/, 'the pause length never appears on the results tab')

  ui.run('EVENTS_COMPLETE = false; FULL_EVENTS = recent; renderResults(input)', { input, recent: recentEvents })
  const truncatedResult = ui.run('analyse(input, recent)', { input, recent: recentEvents })
  assert.equal(truncatedResult.per[0].agentTime, 0, 'history marked incomplete suppresses all measured activity')
  assert.equal(truncatedResult.per[0].unmeasured, true)
  assert.deepEqual(JSON.parse(JSON.stringify(truncatedResult.per[0].spans)), [])
  assert.equal(truncatedResult.criticalPathMeasured, false)
  const incompleteHtml = ui.nodes.get('#results').innerHTML
  const incompleteCard = gainCardOf(incompleteHtml)
  assert.match(incompleteCard, /não foi aferido/)
  assert.match(incompleteCard, /Não aferido/)
  assert.doesNotMatch(incompleteCard, /115h|115:23/)

  ui.run('EVENTS_COMPLETE = true; FULL_EVENTS = full; renderResults(input)', { input, full: fullEvents })
  const restoredCard = gainCardOf(ui.nodes.get('#results').innerHTML)
  assert.match(restoredCard, /20s/)
  assert.doesNotMatch(restoredCard, /115h|115:23/)
})

test('the gain card opens the results tab and shows a human estimate only from manualEstimate', async () => {
  const ui = dashboard('en')
  const first = { run: 'first', createdAt: instant(0), plan: {}, tasks: { A: task('A') }, derived: {} }
  const next = { ...first, tasks: { A: task('A', 'done', { attempts: [{ n: 1 }] }) }, derived: { A: { effective: 'done' } } }
  ui.run("STATE = input; SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'first'; CURRENT_ROOT = 'root-a'; CURRENT_RUN = 'first'; STATE_RUN_KEY = 'root-a\\0first'; EVENT_HISTORY_KEY = STATE_RUN_KEY; EVENTS_COMPLETE = true; RESULTS_OPEN = true; renderResults(input)", { input: first })
  const original = ui.nodes.get('#results').innerHTML
  assert.match(original, /^<div class="rstack" data-results-run="first">\s*<section class="gcard gain"/, 'the gain card is the first thing in the tab')
  assert.ok(original.indexOf('id="gainPanel"') < original.indexOf('id="manualPanel"'), 'the estimate sits below the gain card')
  assert.doesNotMatch(original, /<input|data-gain-minutes|Human estimate/,
    'without manualEstimate there is no human estimate and no editable per-event minutes')
  assert.match(original, /No command recorded yet/)

  ui.run('STATE = input; FULL_EVENTS = history', { input: next, history: [{ type: 'task_start', task: 'A', at: instant(0) }] })
  const fetch = async () => ({ json: async () => ({ events: [{ type: 'task_start', task: 'A', at: instant(0) }] }) })
  await ui.run('loadResults()', { fetch })
  assert.notEqual(ui.nodes.get('#results').innerHTML, original)
  assert.match(ui.nodes.get('#results').innerHTML, /about <strong>3m00<\/strong>[^<]*\(3 min per command × 1 command\)/)

  const estimated = { ...next, tasks: {
    A: task('A', 'done', { manualEstimate: 90 }), B: task('B', 'done', { manualEstimate: 'not a number' }), C: task('C', 'done'),
  }, derived: {} }
  ui.run('STATE = input; renderResults(input)', { input: estimated })
  const card = ui.nodes.get('#results').innerHTML.split('</section>')[0]
  assert.match(card, /Human estimate: 1h30/)
  assert.match(card, /estimate · not measured/)
  assert.match(card, /for 1 of 3 tasks/, 'invalid or missing estimates are ignored silently and the coverage is stated')

  const measuredBars = ui.run('renderGainPanel(input, tr, fmtMs, esc)', {
    input: { factor: 2, historyComplete: true, oneAtATimeMs: 5000, partial: false,
      criticalPathMs: 4000, humanEstimateMs: 90000, humanComparedMs: 60000,
      humanEstimateTasks: 2, countedTasks: 3, withPrumoMs: 3000, savingsMs: 2000 },
    tr: value => value, fmtMs: value => String(value), esc: value => String(value),
  })
  assert.match(measuredBars, /class="gain-bars"/)
  assert.match(measuredBars, /class="gbar-track"/)
})

test('a matriz de vinte cenarios de ganho executa os helpers reais no VM do dashboard', () => {
  const ui = dashboard('pt-BR')
  const call = (code, values = {}) => ui.run(code, values)
  const metrics = (tasks = {}, options = {}) => call('commandMetricsForRun(inputTasks, inputOptions)', {
    inputTasks: tasks, inputOptions: options,
  })
  const gain = (analysis, tasks = {}, complete = false, options = {}) => call(
    'calculateGain(inputAnalysis, inputTasks, inputComplete, inputOptions)',
    { inputAnalysis: analysis, inputTasks: tasks, inputComplete: complete, inputOptions: options },
  )
  const tr = (key, ...values) => String(key).replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? ''))
  const fmt = (value) => value == null ? '—' : `${value}ms`
  const escValue = (value) => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const panel = (value, locale = 'pt-BR') => call(
    'renderGainPanel(inputGain, inputTr, inputFmt, inputEsc, inputLocale)',
    { inputGain: value, inputTr: tr, inputFmt: fmt, inputEsc: escValue, inputLocale: locale },
  )
  const manual = (value) => call(
    'renderManualCoordination(inputGain, inputTr, inputFmt, inputEsc)',
    { inputGain: value, inputTr: tr, inputFmt: fmt, inputEsc: escValue },
  )
  const span = (kind, from, to) => [kind, from, to]

  // 1. Valores válidos, inválidos e ausentes seguem a mesma regra de estimativa manual.
  assert.equal(call('taskManualEstimateMinutes(input)', { input: { manualEstimate: 45 } }), 45)
  assert.equal(call('taskManualEstimateMinutes(input)', { input: { manualEstimate: '30' } }), 30)
  for (const value of [undefined, null, -5, 'PT4H', '4h', NaN, Infinity, {}, []]) {
    assert.equal(call('taskManualEstimateMinutes(input)', { input: { manualEstimate: value } }), null)
  }
  assert.equal(call('taskManualEstimateMinutes(input)', { input: null }), null)

  // 2. Um ledger completo preserva só disparos elegíveis para a estimativa.
  const ledger = metrics({}, { commandMetrics: {
    complete: true,
    byCommand: { start: 33, review: 27, 'plan-task': 4, 'plan-phase': 3, retry: 8, status: 162, 'begin-discussion': 8, bad_name: 99, Bad: 99, note: 0 },
  } })
  assert.equal(ledger.total, 245)
  assert.deepEqual(JSON.parse(JSON.stringify(ledger.counts)), { execution: 33, review: 27, planning: 7, discussion: 8, retry: 8, technical: 162 })
  const ledgerGain = gain({ per: [{ spans: [span('exec', 0, 60_000)] }, { spans: [span('review', 0, 60_000)] }] }, {}, true, {
    commandMetrics: ledger.complete ? { complete: true, byCommand: ledger.byCommand } : {},
  })
  assert.deepEqual(JSON.parse(JSON.stringify(ledgerGain.commandCounts)), { planning: 7, execution: 33, review: 27 })
  assert.equal(ledgerGain.manualCoordinationMs, 201 * 60_000)

  // 3. Eventos anteriores ao cutoff contam; eventos posteriores, inválidos e desconhecidos não contam.
  const before = '2026-01-01T00:00:00Z'
  const eventTypes = [
    'run_init', 'plan_sync', 'run_authorized', 'phase_discussion', 'phase_discussion_skipped', 'phase_discussed',
    'phase_planning', 'phase_planning_skipped', 'phase_planned', 'task_discussion', 'task_discussion_skipped',
    'task_discussed', 'task_planning', 'task_planning_skipped', 'task_planned', 'task_start', 'task_progress',
    'task_review', 'task_review_progress', 'activity_start', 'activity_stop', 'task_contract_refreshed', 'task_validate',
    'task_done', 'task_fail', 'task_retry', 'task_block', 'task_block_updated', 'task_unblock', 'task_skip', 'task_note',
  ]
  const events = eventTypes.map((type, index) => ({ type, at: `2025-12-31T23:${String(index).padStart(2, '0')}:00Z` }))
  events.push({ type: 'task_start', at: before }, { type: 'task_start', at: 'not-a-date' }, { type: 'unknown', at: '2025-12-31T23:59:00Z' })
  const eventMetrics = metrics({}, { commandMetrics: { startedAt: before }, events })
  assert.equal(eventMetrics.byCommand.start, 1)
  assert.equal(eventMetrics.byCommand.note, 1)
  assert.equal(eventMetrics.byCommand['sync-plan'], 1)
  assert.equal(eventMetrics.byCommand.fail, 1)
  assert.equal(eventMetrics.byCommand['skip-phase-discussion'], 1)
  assert.equal(eventMetrics.byCommand['skip-discussion'], 1)
  assert.equal(eventMetrics.byCommand['skip-planning'], 1)

  // 4. Sem eventos e sem ledger, a compatibilidade usa tentativas mínimas; com eventos vazios, não usa fallback.
  const legacyTasks = {
    A: { attempts: [{}, { reviewStartedAt: 'legacy' }], validations: [{ by: 'review' }, { by: 'executor' }], planningAttempts: [{}], discussionAttempts: [{}, {}] },
    B: { attempts: [], validations: [], planningAttempts: [], discussionAttempts: [] },
  }
  const legacy = metrics(legacyTasks, { phaseWorkflows: { P1: { planningAttempts: [{}], discussionAttempts: [{}, {}] }, P2: {} } })
  assert.equal(legacy.byCommand.start, 1)
  assert.equal(legacy.byCommand.retry, 1)
  assert.equal(legacy.byCommand.review, 1, 'validações e reviewStartedAt usam a maior contagem, sem duplicar disparos')
  assert.equal(legacy.byCommand['plan-phase'], 1)
  assert.equal(legacy.byCommand['begin-phase-discussion'], 2)
  assert.equal(metrics(legacyTasks, { events: [] }).total, 0)

  // O contrato público de prontidão rejeita estados incompletos e aceita apenas
  // um intervalo de execução explícito, encerrado e cronologicamente válido.
  assert.equal(call('isReadyForReview(input, inputPlan)', { input: null, inputPlan: {} }), false)
  assert.equal(call('isReadyForReview(input, inputPlan)', { input: { state: 'pending' }, inputPlan: {} }), false)
  assert.equal(call('isReadyForReview(input, inputPlan)', { input: { state: 'running', requireReview: false }, inputPlan: {} }), false)
  assert.equal(call('isReadyForReview(input, inputPlan)', { input: { state: 'running', attempts: [{}] }, inputPlan: {} }), false)
  assert.equal(call('isReadyForReview(input, inputPlan)', { input: { state: 'running', attempts: [{ activityTiming: 'explicit', reviewStartedAt: 'done' }] }, inputPlan: {} }), false)
  assert.equal(call('isReadyForReview(input, inputPlan)', { input: { state: 'running', attempts: [{ activityTiming: 'explicit' }] }, inputPlan: {} }), false)
  assert.equal(call('isReadyForReview(input, inputPlan)', { input: { state: 'running', attempts: [{ activityTiming: 'explicit', activityIntervals: [{ role: 'execution', startedAt: '2026-01-01T00:00:00Z' }] }] }, inputPlan: {} }), false)
  assert.equal(call('isReadyForReview(input, inputPlan)', { input: { state: 'running', attempts: [{ activityTiming: 'explicit', activityIntervals: [{ role: 'execution', startedAt: 'bad', endedAt: 'bad' }] }] }, inputPlan: {} }), false)
  assert.equal(call('isReadyForReview(input, inputPlan)', { input: { state: 'running', attempts: [{ activityTiming: 'explicit', activityIntervals: [{ role: 'execution', startedAt: '2026-01-01T00:01:00Z', endedAt: '2026-01-01T00:00:00Z' }] }] }, inputPlan: {} }), false)
  assert.equal(call('isReadyForReview(input, inputPlan)', { input: { state: 'running', attempts: [{ activityTiming: 'explicit', activityIntervals: [{ role: 'execution', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z' }] }] }, inputPlan: {} }), true)

  // 5. Intervalos ativos filtram dados inválidos, somam cada tarefa e unem sobreposições.
  const intervalGain = gain({
    per: [
      { id: 'A', spans: [span('exec', 0, 10_000), span('exec', 5_000, 20_000), span('review', 20_000, 30_000), span('noise', 0, 99_000), span('exec', 40_000, 40_000), span('exec', NaN, 50_000)] },
      { id: 'B', spans: [span('plan', 0, 100_000), span('discussion', 0, 5_000)] },
    ],
    sharedSpans: [span('planning', 20_000, 40_000), span('exec', 30_000, 50_000), span('noise', 0, 100_000)],
    cpLen: 90_000, criticalPathMeasured: true,
  }, {}, true)
  assert.equal(intervalGain.oneAtATimeMs, 75_000)
  assert.equal(intervalGain.withPrumoMs, 50_000)
  assert.equal(intervalGain.savingsMs, 25_000)
  assert.equal(intervalGain.criticalPathMs, null, 'planejamento sem telemetria não contamina o caminho crítico')
  assert.equal(intervalGain.partial, true)
  const sparseGain = gain(null, null, true, { commandMetrics: {} })
  assert.equal(sparseGain.oneAtATimeMs, null)
  assert.equal(sparseGain.countedTasks, 0)
  const missingSpanGain = gain({ per: [{ id: 'A' }, { id: 'B', spans: [] }] }, null, true, { commandMetrics: {} })
  assert.equal(missingSpanGain.oneAtATimeMs, null)
  assert.equal(missingSpanGain.partial, false)

  // 6. A união pode ser medida sem economia quando as tarefas são sequenciais.
  const sequential = gain({
    per: [{ id: 'A', spans: [span('discussion', 0, 10_000), span('exec', 20_000, 30_000)] }, { id: 'B', spans: [span('review', 30_000, 40_000)] }],
    sharedSpans: [span('planning', 10_000, 20_000)], cpLen: 40_000, criticalPathMeasured: true,
  }, {}, true, { commandMetrics: { complete: true, byCommand: { start: 1 } } })
  assert.equal(sequential.oneAtATimeMs, 40_000)
  assert.equal(sequential.withPrumoMs, 40_000)
  assert.equal(sequential.savingsMs, 0)
  assert.equal(sequential.factor, 1)
  assert.equal(sequential.criticalPathMs, 40_000)

  // 7. Um histórico incompleto nunca apresenta ganho aferido, mesmo com intervalos.
  const incomplete = gain({ per: [{ id: 'T', spans: [span('exec', 1_000, 691_000)] }], cpLen: 690_000 }, { T: { attempts: [{}] } })
  assert.equal(incomplete.historyComplete, false)
  assert.equal(incomplete.oneAtATimeMs, null)
  assert.equal(incomplete.withPrumoMs, null)
  assert.equal(incomplete.savingsMs, null)
  assert.equal(incomplete.criticalPathMs, null)

  // 8. Envelopes de planejamento e caminho crítico contaminado permanecem não aferidos.
  const unmeasured = gain({
    per: [{ id: 'A', spans: [span('exec', 1_000, 21_000), span('plan', 0, 115 * 60 * 60_000)] }],
    phasePlanning: [{ duration: 115 * 60 * 60_000 }], cpLen: 115 * 60 * 60_000, criticalPathMeasured: true, unmeasuredActivity: true,
  }, { A: { planningAttempts: [{ startedAt: 1_000, endedAt: 115 * 60 * 60_000 }] } }, true)
  assert.equal(unmeasured.oneAtATimeMs, 20_000)
  assert.equal(unmeasured.withPrumoMs, 20_000)
  assert.equal(unmeasured.criticalPathMs, null)
  assert.equal(unmeasured.partial, true)

  // 9. Sem atividade suficiente não se fabrica uma economia ou um fator.
  const emptyGain = gain({ per: [{ id: 'T', spans: [], unmeasured: true }], anyLive: true }, { T: { attempts: [{}] } }, true)
  assert.equal(emptyGain.oneAtATimeMs, null)
  assert.equal(emptyGain.withPrumoMs, null)
  assert.equal(emptyGain.factor, null)
  assert.equal(emptyGain.runActive, true)

  // 10. Estimativas aceitam número/string válidos, ignoram inválidos e excluem tarefas skipped.
  const estimated = gain({ per: [{ id: 'A', spans: [span('exec', 0, 60_000)] }, { id: 'B', spans: [span('exec', 0, 60_000)] }] }, {
    A: { state: 'done', manualEstimate: 120 }, B: { state: 'done', manualEstimate: '30' }, C: { state: 'done', manualEstimate: 'oops' }, S: { state: 'skipped', manualEstimate: 999 },
  }, true)
  assert.equal(estimated.humanEstimateMs, 150 * 60_000)
  assert.equal(estimated.humanEstimateTasks, 2)
  assert.equal(estimated.countedTasks, 3)
  assert.equal(estimated.humanComparedMs, 120_000)

  // 11. A comparação humana exige tempo aferido de todas as tarefas estimadas.
  const partialEstimated = gain({ per: [{ id: 'A', spans: [span('exec', 0, 600_000)] }, { id: 'B', spans: [] }] }, {
    A: { state: 'done', manualEstimate: 30 }, B: { state: 'done', manualEstimate: 30 },
  }, true)
  assert.equal(partialEstimated.humanEstimateMs, 3_600_000)
  assert.equal(partialEstimated.humanComparedMs, null)

  // 12. Planejamento, execução e revisão são a única base da coordenação manual.
  const commandGain = gain({ per: [{ spans: [span('exec', 0, 60_000)] }] }, {}, true, {
    events: [
      { type: 'task_start', at: '2026-01-01T00:00:00Z' }, { type: 'task_validation_started', at: '2026-01-01T00:01:00Z' },
      { type: 'task_validate', at: '2026-01-01T00:01:01Z' }, { type: 'phase_eligible', at: '2026-01-01T00:01:02Z' },
      { type: 'task_retry', at: '2026-01-01T00:02:00Z' }, { type: 'task_note', at: '2026-01-01T00:03:01Z' },
    ],
    commandMetrics: { startedAt: '2026-01-01T00:03:00Z', complete: false, byCommand: { note: 1, status: 2, 'plan-phase': 1, 'begin-discussion': 1, validate: 1 } },
  })
  assert.equal(commandGain.commandTotal, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(commandGain.commandCounts)), { planning: 1, execution: 1, review: 0 })
  assert.equal(commandGain.manualCoordinationMs, 6 * 60_000)
  assert.equal(commandGain.commandsComplete, false)

  // 13. Tentativas, validações e campos de retry formam a contagem legada mínima.
  const retryGain = gain({ per: [{ spans: [span('exec', 0, 60_000)] }, { spans: [span('exec', 0, 60_000)] }] }, {
    A: { attempts: [{ reviewStartedAt: 'x' }, { reviewStartedAt: 'y' }, {}], validations: [{ by: 'review' }] },
    B: { attempts: [{}], validations: [{ by: 'review' }, { by: 'executor' }] },
  }, true)
  assert.deepEqual(JSON.parse(JSON.stringify(retryGain.commandCounts)), { planning: 0, execution: 2, review: 3 })
  assert.equal(retryGain.commandTotal, 5)
  assert.equal(retryGain.savingsMs, 60_000)

  // 14. A estimativa combinada inclui a coordenação, sem alterar a economia medida.
  const phaseCommandGain = gain({ per: [{ spans: [span('exec', 0, 60_000)] }, { spans: [span('exec', 0, 60_000)] }] }, {}, true, {
    events: [{ type: 'phase_planning', at: '2026-01-01T00:00:00Z' }, { type: 'task_note', at: '2026-01-01T00:01:00Z' }],
  })
  assert.equal(phaseCommandGain.commandTotal, 1)
  assert.equal(phaseCommandGain.savingsMs, 60_000)
  assert.equal(phaseCommandGain.combinedEstimateMs, 240_000)

  // 15. Renderização distingue histórico incompleto, ausência de atividade, parcial e medida completa.
  assert.match(panel(incomplete), /Event history is incomplete/)
  assert.match(panel(emptyGain), /No recorded agent activity/)
  assert.match(panel(unmeasured), /unmeasured periods are omitted/)
  assert.match(panel(sequential), /waiting time is excluded/)

  // 16. Barras e caminho crítico aparecem somente quando a escala e o dado existem.
  assert.match(panel(sequential), /gain-bars/)
  assert.match(panel({ ...sequential, oneAtATimeMs: null, withPrumoMs: null, savingsMs: null, combinedEstimateMs: null,
    factor: null, criticalPathMs: null, humanComparedMs: null, humanEstimateMs: null }), /Not measured/)
  const humanPanel = panel({ ...estimated, criticalPathMs: 120_000 })
  assert.match(humanPanel, /gain-human/)
  assert.match(humanPanel, /Agents on the same tasks/)
  assert.match(humanPanel, /gain-critical/)

  // 17. O painel humano usa os mesmos dados e escapa textos fornecidos pelo catálogo.
  const hostile = { ...estimated, commandsByName: { '<bad>': 1 }, commandTotal: 1, manualCoordinationMs: 180_000 }
  const hostileMarkup = manual(hostile)
  assert.match(hostileMarkup, /&lt;bad&gt;/)
  assert.doesNotMatch(hostileMarkup, /<bad>/)

  // 18. A coordenação manual cobre total zero, singular, plural, defaults e histórico parcial.
  assert.match(manual({}), /No command recorded yet/)
  assert.match(manual({ commandCounts: { planning: 1, execution: 0, review: 0 }, commandTotal: 1, manualCoordinationMs: 180_000 }), /1 command/)
  assert.match(manual({ commandCounts: { planning: 1, execution: 1, review: 1 }, commandTotal: 3, manualCoordinationMs: 540_000, minutesPerCommand: 3, commandsComplete: false }), /3 commands/)
  assert.match(manual({ commandCounts: { planning: 0, execution: 0, review: 0 }, commandTotal: 0, commandsByName: {}, commandsComplete: true }), /Fixed assumption/)
  const missingCountsMarkup = manual({ commandCounts: {}, commandTotal: 0, commandsByName: {}, commandsComplete: true })
  assert.equal((missingCountsMarkup.match(/0 commands/g) ?? []).length, 3)

  // 19. O detalhamento ordena comandos e preserva apenas os nomes elegíveis.
  const detailMarkup = manual({ commandCounts: { planning: 2, execution: 1, review: 1 }, commandTotal: 4, manualCoordinationMs: 720_000, minutesPerCommand: 3, commandsByName: { review: 1, start: 1, 'plan-task': 1, 'plan-phase': 1 }, commandsComplete: true })
  assert.ok(detailMarkup.indexOf('<td>plan-phase</td>') < detailMarkup.indexOf('<td>review</td>'))
  assert.match(detailMarkup, /Only planning, execution and review dispatches count/)
  assert.doesNotMatch(detailMarkup, /Partial dispatch history/)

  // 20. Fator e escalas mantêm limite de 100% e suportam os dois idiomas do produto.
  const bounded = { ...sequential, factor: 4 / 3, oneAtATimeMs: 40_000, withPrumoMs: 80_000, savingsMs: 0, manualCoordinationMs: 0, humanEstimateMs: 120_000, humanComparedMs: 0, humanEstimateTasks: 1, countedTasks: 1 }
  assert.match(panel(bounded, 'pt-BR'), /1,33×/)
  const english = call('renderGainPanel(inputGain, inputTr, inputFmt, inputEsc, "en")', { inputGain: bounded, inputTr: tr, inputFmt: fmt, inputEsc: escValue })
  assert.match(english, /1\.33×/)
})

test('agentes ativos acompanham somente as tarefas em atividade ao atualizar o painel', () => {
  const ui = dashboard('pt-BR')
  const tasks = { T1: task('T1', 'running'), T2: task('T2', 'ready'), T3: task('T3', 'waiting') }
  const state = { run: 'agentes', plan: { phases: [] }, tasks }
  ui.render(state)
  const rows = () => ui.nodes.get('#parallel').innerHTML.match(/onclick="openTask\('/g)?.length ?? 0
  assert.equal(rows(), 1)
  tasks.T2.state = 'planning'
  tasks.T3.state = 'reviewing'
  ui.render(state)
  assert.equal(rows(), 3)
  tasks.T1.state = 'done'
  tasks.T2.state = 'ready'
  tasks.T3.state = 'waiting'
  ui.render(state)
  assert.equal(rows(), 0)
  assert.match(ui.nodes.get('#parallel').innerHTML, /class="empty"[^]*data-i18n="Nothing running"/)
})

test('o trilho alcança o fim da última fase mesmo com várias linhas de cards', () => {
  const ui = dashboard('pt-BR')
  for (const count of [0, 1, 12]) {
    for (const status of ['waiting', 'running', 'done']) {
      const state = { run: 'fim-trilho', plan: { phases: [{ id: 'F1', title: 'Primeira' }, { id: 'F2', title: 'Última' }] },
        tasks: Object.fromEntries(Array.from({ length: count }, (_, index) => {
          const id = `T${index + 1}`
          return [id, task(id, status, { phase: 'F2' })]
        })) }
      ui.render(state)
      const rails = [...ui.nodes.get('#structPaths').innerHTML.matchAll(/<line class="s-rail [^"]+" x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)]
      const last = rails.at(-1)
      const lane = ui.run('LAST_LANES.at(-1)')
      assert.equal(Number(last[2]), lane.y + 12)
      assert.equal(Number(last[4]), lane.y + lane.height + 8)
      assert.equal(rails[0][4], last[2], 'os segmentos não deixam uma lacuna entre fases')
      assert.ok(Number(last[4]) > Number(last[2]), 'a última aresta não pode ter comprimento zero')
      const bottom = ui.run('Math.max(0, ...Object.values(LAST_POS).map(p => p.y + LAST_METRICS.nodeH))')
      assert.ok(Number(last[4]) >= bottom, 'o trilho acompanha toda a altura dos cards')
    }
  }
})

test('o trilho diferencia fases concluidas, ativas e aguardando', () => {
  const ui = dashboard('pt-BR')
  const state = { run: 'fases', plan: { phases: [
    { id: 'P1', title: 'Primeira' }, { id: 'P2', title: 'Segunda' }, { id: 'P3', title: 'Terceira' },
  ] }, tasks: {
    A: task('A', 'done', { phase: 'P1' }), B: task('B', 'running', { phase: 'P2' }), C: task('C', 'pending', { phase: 'P3' }),
  }, derived: {} }
  const rails = () => [...ui.nodes.get('#structPaths').innerHTML.matchAll(/<line class="s-rail (\w+)"[^>]*stroke="([^"]+)"/g)].map(match => [match[1], match[2]])
  ui.render(state)
  assert.deepEqual(rails(), [['done', 'var(--done)'], ['live', 'var(--accent)'], ['next', '#3a362f']])
  const struct = ui.nodes.get('#structPaths').innerHTML
  const marker = /<circle class="s-end-dot live" cx="([\d.]+)" cy="([\d.]+)"/.exec(struct)
  const rail = /<line class="s-rail live" x1="([\d.]+)"[^>]*x2="([\d.]+)"/.exec(struct)
  const lanes = ui.run('layout(STATE.tasks).lanes')
  assert.ok(marker && rail)
  assert.equal(Number(marker[1]), Number(rail[1]), 'o marcador fica no eixo do trilho')
  assert.equal(Number(marker[2]), lanes[1].y + 12, 'o marcador aponta a fase atual')
  assert.notEqual(Number(marker[2]), lanes[2].y + 12, 'não avança para a fase futura')
  state.tasks.B.state = 'done'
  state.tasks.C.state = 'skipped'
  ui.render(state)
  assert.deepEqual(rails(), Array.from({ length: 3 }, () => ['done', 'var(--done)']))
  assert.match(ui.nodes.get('#structPaths').innerHTML, /class="s-end-dot done"/)
  assert.doesNotMatch(ui.nodes.get('#structPaths').innerHTML, /s-rail live|s-end-dot live|s-ring/)
  state.tasks.C.state = 'pending'
  ui.render(state)
  assert.deepEqual(rails(), [['done', 'var(--done)'], ['done', 'var(--done)'], ['next', '#3a362f']])
  assert.match(ui.nodes.get('#structPaths').innerHTML, /class="s-end-dot next"/)
})

test('o ponto final considera todas as tarefas mesmo sem fases ou com tarefas fora delas', () => {
  const ui = dashboard('pt-BR')
  const state = { run: 'sem-fases', plan: { phases: [] }, tasks: { A: task('A', 'done'), B: task('B', 'skipped') }, derived: {} }
  ui.render(state)
  assert.match(ui.nodes.get('#structPaths').innerHTML, /class="s-rail done"/)
  assert.match(ui.nodes.get('#structPaths').innerHTML, /class="s-end-dot done"/)
  state.tasks.B.state = 'pending'
  ui.render(state)
  assert.match(ui.nodes.get('#structPaths').innerHTML, /class="s-rail live"/)
  assert.match(ui.nodes.get('#structPaths').innerHTML, /class="s-end-dot next"/)
  state.plan.phases = [{ id: 'P1', title: 'Primeira' }]
  state.tasks.B.phase = 'fora-do-catalogo'
  ui.render(state)
  assert.match(ui.nodes.get('#structPaths').innerHTML, /class="s-rail done"/)
  assert.match(ui.nodes.get('#structPaths').innerHTML, /class="s-end-dot next"/, 'uma tarefa pendente fora da fase ainda impede a conclusao do plano')
  const markerY = Number(/class="s-end-dot next"[^>]*cy="([\d.]+)"/.exec(ui.nodes.get('#structPaths').innerHTML)?.[1])
  assert.equal(markerY, ui.run('LAST_POS.B.y + LAST_METRICS.nodeH / 2'), 'o marcador permanece junto da tarefa pendente real')
})

test('resultados do guia usam o calculo real com dados ficticios e os tres tipos de comando', () => {
  const ui = dashboard('pt-BR')
  ui.render(createGuideDemoData('results'))
  ui.run('FULL_EVENTS = []; EVENTS_COMPLETE = true; renderResults(STATE)')
  const markup = ui.nodes.get('#results').innerHTML
  assert.match(markup, /6h22/)
  assert.match(markup, /1h45/)
  assert.match(markup, /2h40/)
  assert.match(markup, /4h37/)
  assert.match(markup, /39 comandos/)
  assert.doesNotMatch(markup, /Histórico parcial de disparos|Não aferido/)
  assert.equal(ui.run('STATE.run'), 'checkout')
})

test('resumo sempre exibe a ordem completa mesmo sem tarefas', () => {
  const ui=dashboard('pt-BR')
  ui.render({run:'vazio',plan:{phases:[]},tasks:{},derived:{}})
  const counts=ui.nodes.get('#counts').innerHTML
  assert.deepEqual([...counts.matchAll(/data-state="([^"]+)"/g)].map(match=>match[1]), ['skipped','waiting','ready_for_discussion','discussing','ready_to_plan','planning','ready','running','ready_for_review','reviewing','blocked','failed','done'])
  assert.match(counts,/Pronto para planejar/)
  assert.match(counts,/Pronto para revisar/)
  assert.equal((counts.match(/<b>0<\/b>/g)??[]).length,8)
  assert.equal((counts.match(/<b>0\/3<\/b>/g)??[]).length,4)
  assert.match(counts,/<b>0\/0<\/b>/)
})

test('espera por revisao nao aparece como trabalho de executor ou revisor', () => {
  const ui=dashboard('pt-BR')
  const work=task('T1','running',{attempts:[{n:1,activityTiming:'explicit',activityIntervals:[{role:'execution',startedAt:instant(0),endedAt:instant(10)}],startedAt:instant(0)}]})
  const state={run:'revisao',plan:{phases:[]},tasks:{T1:work},derived:{}}
  ui.render(state)
  assert.equal(ui.run('eff("T1")'),'ready_for_review')
  assert.match(ui.nodes.get('#counts').innerHTML,/Pronto para revisar<\/span> <b>1<\/b>/)
  assert.match(ui.nodes.get('#counts').innerHTML,/Executando<\/span> <b>0\/3<\/b>/)
  assert.equal(ui.nodes.get('#execNode').classList.contains('live'),false)
  assert.equal(ui.nodes.get('#revNode').classList.contains('live'),false)
  assert.equal(ui.run('analyse(STATE).execTotal'),10000)
  assert.equal(ui.run('analyse(STATE).reviewTotal'),0)
  work.state='reviewing';work.attempts[0].reviewStartedAt=instant(30)
  ui.render(state)
  assert.equal(ui.run('eff("T1")'),'reviewing')
  assert.match(ui.nodes.get('#counts').innerHTML,/Pronto para revisar<\/span> <b>0<\/b>/)
  assert.equal(ui.nodes.get('#revNode').classList.contains('live'),true)
})

test('fases paralelas mostram seus proprios papeis e cores sem reduzir a primeira fase', () => {
  const ui=dashboard('pt-BR')
  ui.render({run:'paralelo',plan:{phases:[{id:'F1',title:'Primeira'},{id:'F2',title:'Segunda'}]},tasks:{T1:task('T1','discussing',{phase:'F1'}),T2:task('T2','running',{phase:'F1'}),T3:task('T3','planning',{phase:'F2'}),T4:task('T4','reviewing',{phase:'F2'})},derived:{}})
  const structure=ui.nodes.get('#structPaths').innerHTML
  assert.equal((structure.match(/class="s-end-dot live"/g)??[]).length,2)
  assert.match(structure,/values="#e8b04b;#f28c52;#e8b04b"/)
  assert.match(structure,/values="#b69cff;#4fc3f7;#b69cff"/)
  assert.match(structure,/class="s-spinner"[^>]*r="6.375"/)
  assert.match(structure,/class="s-end-dot live"[^>]*r="4"/)
})

test('spinners novos compartilham o relogio sem reiniciar os existentes', () => {
  const ui = dashboard('pt-BR')
  const first = { animationName: 'activity-spin', startTime: 75 }
  const other = { animationName: 'glow', startTime: 100 }
  const animations = [first, other]
  ui.run('document.getAnimations = () => inputAnimations; syncActivitySpinners()', { inputAnimations: animations })
  assert.equal(first.startTime, 0)
  assert.equal(other.startTime, 100)
  first.startTime = 20
  const added = { animationName: 'activity-spin', startTime: 500 }
  animations.push(added)
  ui.run('syncActivitySpinners()')
  assert.equal(first.startTime, 20, 'o indicador existente nao e reiniciado')
  assert.equal(added.startTime, 0, 'o novo indicador usa a mesma origem temporal')
})

test('barras ativas compartilham ciclo e origem mesmo quando um agente aparece depois', () => {
  const ui = dashboard('pt-BR')
  assert.match(html, /:is\(\.role\.live \.obar, \.node \.nbar, \.par \.rbar\)::after \{[^}]*animation: slide 1\.8s ease-in-out infinite;/)
  assert.doesNotMatch(html, /animation-duration: 2\.6s/)
  const bars = Array.from({ length: 4 }, (_, i) => ({ animationName: 'slide', startTime: i * 300 }))
  ui.run('performance.timeOrigin = 5300; document.getAnimations = () => bars; syncActivitySpinners()', { bars })
  assert.deepEqual(bars.map(bar => bar.startTime), [-1700, -1700, -1700, -1700])
  bars[0].startTime = -1690
  const added = { animationName: 'slide', startTime: 9000 }
  bars.push(added)
  ui.run('syncActivitySpinners()')
  assert.equal(added.startTime, -1700)
  assert.equal(bars[0].startTime, -1690, 'uma atualizacao nao reinicia a animacao ja sincronizada')
})

test('o spinner ativo cobre os trilhos, com e sem fases', () => {
  assert.match(html, /svg#edges \.s-end-mask \{ fill: var\(--bg\); stroke: none; \}/)
  assert.match(html, /@keyframes activity-spin \{ to \{ transform: rotate\(360deg\); \} \}/)
  assert.doesNotMatch(html, /svg#edges \.s-end-dot\.live \{[^}]*(?:animation: beat|transform:|scale\()/)
  for (const phases of [[], [{ id: 'P1', title: 'Primeira' }, { id: 'P2', title: 'Segunda' }]]) {
    const ui = dashboard('pt-BR')
    ui.render({ run: 'pulso', plan: { phases }, tasks: {
      A: task('A', 'done', { phase: 'P1' }), B: task('B', 'running', { phase: 'P2' }),
    }, derived: {} })
    const struct = ui.nodes.get('#structPaths').innerHTML
    const maskAndDot = /<circle class="s-end-mask" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"\/><circle class="s-end-dot live" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"[^>]*>/.exec(struct)
    assert.ok(maskAndDot, 'a mascara opaca fica imediatamente atras da bolinha ativa')
    assert.equal(maskAndDot[1], maskAndDot[4], 'a mascara compartilha o eixo da bolinha')
    assert.equal(maskAndDot[2], maskAndDot[5], 'a mascara compartilha o centro da bolinha')
    assert.ok(Number(maskAndDot[3]) > Number(maskAndDot[6]), 'a mascara cobre ate a borda suavizada da bolinha')
    assert.match(struct, /class="s-rail live"/, 'o trilho ativo continua presente')
  }
})

test('o seletor de planos fecha ao clicar fora e preserva cliques dentro dos dois grupos', () => {
  const ui = dashboard('pt-BR')
  ui.run("$('#runMenu')")
  const menu = ui.nodes.get('#runMenu')
  for (const group of ['progress', 'complete']) {
    ui.run('RUN_FILTER = group', { group })
    menu.open = true
    const detached = { target: { closest: () => null }, composedPath: () => [menu] }
    ui.dispatchDocument('click', detached, () => ui.run('toggleRunFilter(group)', { group: group === 'progress' ? 'complete' : 'progress' }))
    assert.equal(menu.open, true, 'trocar o grupo dentro do seletor mantem a lista aberta')
    ui.dispatchDocument('click', { target: { closest: () => menu } })
    assert.equal(menu.open, true)
    ui.dispatchDocument('click', { target: { closest: () => null }, composedPath: () => [] })
    assert.equal(menu.open, false, 'clicar fora fecha qualquer grupo selecionado')
  }
})

test('o cabecalho compacto preserva ao vivo e abre todos os filtros sem os contadores', () => {
  const small = dashboard('en', 330)
  assert.equal(small.nodes.get('#headerMenu').open, false)
  small.run("$('#filterPanel')")
  assert.equal(small.nodes.get('#filterPanel').hidden, true)
  const wide = dashboard('en', 1440)
  assert.equal(wide.nodes.get('#headerMenu').open, true)
  small.resize(400)
  assert.equal(small.nodes.get('#headerMenu').open, false)
  small.resize(800)
  assert.equal(small.nodes.get('#headerMenu').open, true)
  small.resize(330)
  assert.equal(small.nodes.get('#headerMenu').open, false)
  small.resize(400)
  assert.equal(small.nodes.get('#headerMenu').open, false, 'the filter menu is still compact above 700px')
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'))
  const menuStart = html.indexOf('<details class="header-menu"')
  const menu = html.slice(menuStart, html.indexOf('</details>', menuStart) + 10)
  assert.ok(header.indexOf('id="orch"') > header.indexOf('<details class="header-menu"'), 'o status fica depois dos filtros, fora do menu')
  assert.doesNotMatch(menu, /id="orch"/)
  assert.ok(menu.includes('id="statusFilter"'))
  assert.equal(small.filterOptions.length, 17)
  assert.doesNotMatch(menu, /<select/)
  assert.match(html, /\.filter-toggle \{ display: none; \}/)
  assert.doesNotMatch(header, /id="counts"/)
  assert.match(html, /<section id="statusBox">\s*<button id="summaryToggle"[\s\S]*?<div class="counts" id="counts"><\/div>/)
  assert.match(menu, /<div class="filter-menu" id="filterMenu">/)
  assert.doesNotMatch(menu, /<details[^>]+class="filter-menu"/)
  small.nodes.get('#headerMenu').open = true
  small.nodes.get('#headerMenu').dispatchEvent('toggle')
  assert.equal(small.nodes.get('#filterPanel').hidden, false)
  assert.equal(small.nodes.get('#filterToggle').getAttribute('aria-expanded'), 'true')
  small.run('setFilter("done")')
  assert.equal(small.nodes.get('#filterPanel').hidden, true)
  assert.equal(small.nodes.get('#filterToggle').getAttribute('aria-expanded'), 'false')
  assert.equal(small.nodes.get('#headerMenu').open, false, 'selecting a filter closes the whole compact menu')
  assert.equal(small.filterOptions.filter(option => option.getAttribute('aria-pressed') === 'true').length, 1)
  assert.equal(small.filterOptions.find(option => option.dataset.filterValue === 'done').getAttribute('aria-pressed'), 'true')
  assert.match(html, /@media \(max-width: 1100px\)/)
})

test('o cabecalho ordena plano e filtros antes do status e separa resultados do guia', () => {
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'))
  const guide = header.indexOf('id="guideButton"'), menu = header.indexOf('<details class="header-menu"')
  const slot = header.indexOf('<div class="header-guide">')
  const results = header.indexOf('id="resBtn"'), status = header.indexOf('id="orch"')
  assert.ok(header.indexOf('<h1>') < header.indexOf('id="runMenu"') && header.indexOf('id="runMenu"') < menu &&
    menu < status && status < slot && slot < results && results < guide,
    'logo, plano, filtros, status e acoes agrupadas na ordem de leitura')
  const separator = header.indexOf('<div class="guide-slot">')
  assert.ok(results < separator && separator < guide, 'o separador fica entre resultados e guia')
  assert.match(html, /\.guide-slot \{[^}]*padding-left: 12px;[^}]*border-left: 1px solid var\(--line\);/)
  assert.match(html, /header \.run-menu \{ grid-column: 2; grid-row: 1;/)
  assert.match(html, /header \.header-guide \{ grid-column: 3; grid-row: 2;/)
  assert.match(html, /header \.header-guide \{ grid-column: 1 \/ 3; grid-row: 3;/)
  assert.match(html, /header \.orch \{ grid-column: 2; grid-row: 2;/)
  assert.match(html, /header \.header-menu \{ grid-column: 1; grid-row: 2;/)
  assert.match(html, /\.header-menu-content \{[^}]*left: 0;[^}]*width: min\(calc\(100vw - 24px\), 280px\)/)
})

test('a conclusao fica verde e sem pulso, e nao permanece ao mudar para um plano ativo', () => {
  const ui = dashboard('pt-BR')
  const state = { run:'header-status', plan:{ phases:[] }, tasks:{ T1:task('T1','done'), T2:task('T2','skipped') } }
  ui.render(state)
  const status = ui.nodes.get('#orch')
  assert.equal(status.classList.contains('complete'), true)
  assert.equal(status.classList.contains('live'), false)
  assert.match(status.innerHTML, /concluída/)
  assert.match(status.innerHTML, /<time id="agentClock"/)
  ui.run("showRunLoading('active')")
  assert.equal(status.classList.contains('complete'), false)
  ui.render({ ...state, tasks:{T1:task('T1','running')} })
  assert.equal(status.classList.contains('complete'), false)
  assert.equal(status.classList.contains('live'), true)
  ui.render({ ...state, tasks:{T1:task('T1','skipped')} })
  assert.equal(status.classList.contains('complete'), false, 'um plano totalmente pulado nao e concluido')
  assert.match(html, /\.orch\.complete \.hb \{[^}]*background: var\(--done\);[^}]*animation: none;/)
})

test('guide button is labeled with one word in English and Brazilian Portuguese', () => {
  for (const [lang, label] of [['en', 'Open guide'], ['pt-BR', 'Guia']]) {
    assert.match(html, /id="guideButton"[^>]*data-i18n="Open guide">Open guide<\/button>/)
    assert.equal(dashboard(lang).run("tr('Open guide')"), label)
  }
})

test('boot do guia inline usa o dashboard real e seus alvos de filtro e card', () => {
  const ui = dashboard('en', 1000, new Map(), { state: null, urls: [] }, { full: true, guideDemo: 'board' })
  assert.equal(ui.run('GUIDE_DEMO'), 'board')
  assert.equal(ui.run('STATE.run'), 'checkout')
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-id="T8"/)
  assert.equal(ui.run('typeof window.prumoGuideDemo.focus'), 'function')
  ui.run("window.prumoGuideDemo.focus('filters')")
  assert.equal(ui.nodes.get('#filterPanel').hidden, false)
  ui.run("window.prumoGuideDemo.focus('card')")
  assert.equal(ui.run('POP.id'), 'T8')
  ui.run('window.prumoGuideDemo.pause(true); window.prumoGuideDemo.pause(false); showGuideDemo("board", "filters"); stopGuideDemos({ dispose: true })')
  ui.run('RESULTS_OPEN = true; window.prumoGuideDemo.focus("board")')
  assert.equal(ui.run('RESULTS_OPEN'), false)
  ui.dispatchDocument('visibilitychange', {})
  assert.equal(ui.run('TICK_GENERATION'), 0)
  ui.run('loadResults()')
  ui.run('RESULTS_OPEN = true; jumpToPhase("F1")')
  assert.equal(ui.run('RESULTS_OPEN'), false)
  ui.run('openTask("T8"); openTask("T8")')
  assert.equal(ui.run('POP'), null)
  ui.run('STATE.tasks.T8.attempts = [{startedAt:"2026-01-01T00:00:00Z",endedAt:"2026-01-01T00:00:10Z"}]; STATE.tasks.T8.validations = [{by:"review",ok:true,at:"2026-01-01T00:00:10Z"}]; fillPop("T8")')
  assert.match(ui.nodes.get('#popBody').innerHTML, /✓ Prumo/)
  const calls = []
  const child = { contentWindow: { prumoGuideDemo: { pause(value) { calls.push(value) } } } }
  const panel = ui.nodes.get('#guideExamplePanel')
  const loading = { hidden: true, textContent: '' }
  panel.querySelector = selector => selector === 'iframe' ? child : loading
  ui.run('showGuideDemo("board", "filters"); $("#guideBoardFrame").onload()')
  assert.equal(panel.dataset.guideState, 'error')
  assert.match(loading.textContent, /Unable to show this step/)
  assert.ok(calls.includes(true))
})

test('boot completo do guia de resultados usa a aba real e o foco de atividade', () => {
  const ui = dashboard('pt-BR', 1000, new Map(), { state: null, urls: [] }, { full: true, guideDemo: 'results' })
  assert.equal(ui.run('GUIDE_DEMO'), 'results')
  assert.equal(ui.run('RESULTS_OPEN'), true)
  assert.match(ui.nodes.get('#results').innerHTML, /id="gainPanel"/)
  ui.run('matchMedia = () => ({ matches: false })')
  ui.run('window.prumoGuideDemo.focus("gain"); matchMedia = () => ({matches:true}); window.prumoGuideDemo.focus("times")')
  assert.equal(ui.nodes.get('#results .agent-activity').classList.contains('prumo-guide-target'), true)
  ui.run("window.prumoGuideDemo.focus('times')")
  assert.ok(ui.nodes.get('#results').innerHTML.includes('agent-activity'))
  assert.ok(ui.nodes.get('#results').classList.contains('open'))
})

test('boot completo normal inicializa onboarding, polling e identidade sem rede real', async () => {
  const ui = dashboard('en', 1000, new Map(), { state: null, urls: [] }, { full: true })
  assert.equal(ui.run('typeof ONBOARDING'), 'object')
  ui.run('refreshOnboarding()')
  await Promise.resolve()
  await Promise.resolve()
})

test('metricas inline sem eventos derivam disparos das tentativas e dos fluxos de fase', () => {
  const ui = dashboard()
  const input = {
    A: { attempts: [{ reviewStartedAt: instant(4) }, {}], validations: [{ by: 'review' }], planningAttempts: [{}], discussionAttempts: [{}] },
    B: { attempts: [], validations: [], planningAttempts: [{}, {}], discussionAttempts: [] },
  }
  const options = { phaseWorkflows: { F1: { planningAttempts: [{}], discussionAttempts: [{}] } } }
  const result = ui.run('commandMetricsForRun(input, options)', { input, options })
  assert.deepEqual(result.counts, { execution: 1, review: 1, planning: 4, discussion: 2, retry: 1, technical: 0 })
  assert.equal(result.byCommand.start, 1)
  assert.equal(result.byCommand.retry, 1)
  assert.equal(result.byCommand['plan-task'], 3)
  assert.equal(result.byCommand['begin-phase-discussion'], 1)
})

test('historico inline escolhe o recibo de revisao mais recente dentro do intervalo', () => {
  const ui = dashboard()
  const input = { validations: [
    { by: 'review', attempt: 1, at: instant(10) },
    { by: 'review', attempt: 2, at: instant(20) },
    { by: 'review', at: instant(30) },
    { by: 'review', attempt: 2, at: 'data inválida' },
  ] }
  const receipt = ui.run('latestReviewReceipt(input, 2, Date.parse(start), Date.parse(end))', {
    input, start: instant(15), end: instant(25),
  })
  assert.equal(receipt, Date.parse(instant(20)))
})

test('historico inline cobre validacao iniciada, recibo sem ocorrencia e plano antes da fase', () => {
  const ui = dashboard()
  const state = { tasks: { T1: task('T1', 'pending', { validations: [
    { by: 'review', ok: false, token: 'v1', at: instant(1) },
  ] }) } }
  ui.run('STATE = input', { input: state })
  const sentence = ui.run('eventSentence(input)', { input: {
    type: 'task_validation_started', task: 'T1', token: 'v1', by: 'review', at: instant(2),
  } })
  assert.match(sentence, /began validation for task[\s\S]*T1/)

  const nearest = ui.run('validationForEvent(input, [])', { input: {
    type: 'task_validate', task: 'T1', by: 'review', ok: false, at: instant(2),
  } })
  assert.equal(nearest.at, instant(1))
  const fallback = ui.run('eventDetail(input, [])', { input: {
    type: 'task_validate', task: 'T1', by: 'review', ok: false, summary: '   ', evidence: 'evidence fallback', at: instant(2),
  } })
  assert.equal(fallback, 'evidence fallback')

  const planMarkup = ui.run('fmtTaskPlan(input)', { input: {
    verification: [{ criterion: 'plain check', check: 1 }],
    openQuestions: [
      { question: 'Now?', blocking: false, decideBy: 'user-now' },
      { question: 'Executor?', blocking: false, decideBy: 'executor' },
      { question: 'Default?', blocking: false },
      { question: 'Task?', blocking: false, decideBy: { beforeTask: 'T2' } },
      { question: 'Which phase?', blocking: false, decideBy: { beforePhase: 'F2' } },
    ],
  } })
  assert.match(planMarkup, /before phase F2/)
  const contractMarkup = ui.run('fmtContract(input)', { input: [{ run: 'bun test', expect: 'all pass' }, { run: 'bun lint' }] })
  assert.match(contractMarkup, /<code>bun test<\/code> → all pass/)

  const objectSummary = ui.run('eventDetail(input, [])', { input: {
    type: 'task_validate', task: 'T1', by: 'review', ok: false, summary: { reason: 'missing evidence' }, at: instant(2),
  } })
  assert.match(objectSummary, /missing evidence/)
})

test('historico inline traduz as transicoes de plano, fase e tarefa', () => {
  const ui = dashboard()
  ui.run("STATE = { tasks: { T1: { validations: [] } }, phaseWorkflows: {} }")
  const events = [
    { type: 'schema_migrate' },
    { type: 'plan_sync_audit' },
    { type: 'plan_sync' },
    { type: 'phase_discussion', phase: 'F1' },
    { type: 'phase_discussion_skipped', phase: 'F1' },
    { type: 'phase_discussed', phase: 'F1' },
    { type: 'phase_planning_skipped', phase: 'F1' },
    { type: 'phase_planned', phase: 'F1' },
    { type: 'task_discussion', task: 'T1' },
    { type: 'task_discussion_skipped', task: 'T1' },
    { type: 'task_discussed', task: 'T1' },
    { type: 'task_planning', task: 'T1' },
    { type: 'task_planning_skipped', task: 'T1' },
    { type: 'task_planned', task: 'T1' },
    { type: 'task_contract_refreshed', task: 'T1' },
    { type: 'task_block_updated', task: 'T1' },
    { type: 'task_skip', task: 'T1' },
  ]
  for (const input of events) assert.ok(ui.run('eventSentence(input)', { input }))
  ui.render({ run: 'transitions', plan: { phases: [{ id: 'F1', title: 'Phase 1' }] },
    tasks: { T1: task('T1', 'pending') }, derived: { T1: { effective: 'pending' } } },
  events.map((event, index) => ({ ...event, at: instant(index + 1) })))
  assert.ok(ui.nodes.get('#events').innerHTML.includes('schema_migrate'))
  assert.match(ui.run("eventRole('unknown')"), /var\(--accent\)/)
  ui.run("STATE = { plan: { phases: [{ id: 'F1' }] }, tasks: { T1: input }, derived: { T1: { effective: 'done' } } }", { input: task('T1', 'done', { phase: 'F1' }) })
  assert.equal(ui.run("phaseColour('F1')"), 'var(--done)')
  assert.equal(ui.run("eventColour({ type: 'task_validation_started', task: 'T1', by: 'executor' })"), 'var(--running)')
  assert.equal(ui.run("eventColour({ type: 'task_review_progress' })"), 'var(--review)')
  assert.equal(ui.run("eventColour({ type: 'task_start' })"), 'var(--running)')
  assert.equal(ui.run("eventColour({ type: 'phase_planning' })"), 'var(--planning)')
  assert.equal(ui.run("eventColour({ type: 'phase_discussion' })"), 'var(--discussion)')
  assert.equal(ui.run("eventColour({ type: 'legacy', state: 'waiting' })"), 'var(--waiting)')
  assert.match(ui.run("taskReference('T1', true)"), /href="#task-T1"/)
  assert.match(ui.run("taskReference('T99', false)"), /<b class="task-ref/)
  assert.match(ui.run("taskText('T1 depends on F1')"), /task-ref[\s\S]*F1/)
})

test('navegacao inline conclui a chegada e limpa resultados pendentes', () => {
  const ui = dashboard()
  ui.run(`setTimeout = (callback) => { callback(); return 1 }; clearTimeout = () => {}; matchMedia = () => ({ matches: false }); animateNavigation($('#viewport')); backToGraph(); clearResultsForPendingRun()`)
  assert.equal(ui.nodes.get('#viewport').classList.contains('navigating'), false)
  assert.equal(ui.nodes.get('#results').getAttribute('aria-busy'), 'true')
})

test('controlador inline de quadros carrega, foca, invalida e descarta demos', () => {
  const ui = dashboard()
  const frame = () => ({
    dataset: {}, src: '', onload: null,
    removeAttribute(name) { if (name === 'src') this.src = '' },
    contentWindow: { prumoGuideDemo: { calls: [], focus(target) { this.calls.push(target) } } },
  })
  const frames = { board: frame(), results: frame() }, states = []
  const output = (mode, state) => states.push([mode, state])
  const controller = ui.run('createGuideDemoFrameController(input, output)', { input: frames, output })
  controller.show('ausente', 'board')
  assert.deepEqual(states, [])
  controller.show('board', 'filters')
  assert.deepEqual(states.at(-1), ['board', 'loading'])
  frames.board.onload()
  assert.deepEqual(frames.board.contentWindow.prumoGuideDemo.calls, ['filters'])
  controller.show('board', 'card')
  assert.deepEqual(frames.board.contentWindow.prumoGuideDemo.calls, ['filters', 'card'])
  controller.show('results', 'gain')
  const staleResultsLoad = frames.results.onload
  controller.show('board', 'stale-results')
  staleResultsLoad()
  assert.deepEqual(states.at(-1), ['results', 'idle'])
  frames.board.contentWindow.prumoGuideDemo.focus = undefined
  controller.show('board', 'missing-focus')
  assert.deepEqual(states.at(-1), ['board', 'error'])
  frames.board.contentWindow.prumoGuideDemo.focus = () => { throw new Error('frame indisponivel') }
  controller.show('board', 'throwing-focus')
  controller.show('board', 'duplicate-load')
  frames.board.onload()
  assert.deepEqual(states.at(-1), ['board', 'error'])
  controller.show('results', 'gain')
  const lateLoad = frames.results.onload
  controller.stop()
  controller.stop({ dispose: true })
  lateLoad()
  assert.equal(frames.results.src, '')
  assert.equal(frames.board.src, '')
  assert.deepEqual(states.at(-1), ['results', 'idle'])

  const quietFrame = frame()
  const quietController = ui.run('createGuideDemoFrameController(input)', { input: { board: quietFrame } })
  quietController.show('board', 'board')
  quietFrame.onload()
})

test('controlador inline cancela o foco em cache se o guia fechar durante a leitura do frame', () => {
  const ui = dashboard()
  const calls = []
  const frame = {
    dataset: {}, src: '', onload: null,
    removeAttribute(name) { if (name === 'src') this.src = '' },
    contentWindow: { prumoGuideDemo: { focus(target) { calls.push(target) } } },
  }
  let accesses = 0
  let controller
  const frames = { results: { dataset: {}, src: '', onload: null, removeAttribute() {} } }
  Object.defineProperty(frames, 'board', {
    enumerable: true,
    get() {
      accesses += 1
      if (accesses === 5) controller.stop()
      return frame
    },
  })
  const states = []
  const output = (mode, state) => states.push([mode, state])
  controller = ui.run('createGuideDemoFrameController(input, output)', { input: frames, output })
  controller.show('board', 'filters')
  frame.onload()
  assert.deepEqual(calls, ['filters'])

  controller.show('board', 'card')

  assert.equal(accesses, 5)
  assert.deepEqual(calls, ['filters'])
  assert.deepEqual(states, [['board', 'loading'], ['board', 'ready'], ['board', 'idle']])
})

test('onboarding inline abre, percorre um papel e fecha o guia', async () => {
  const makeNode = () => {
    const listeners = new Map(), classes = new Set()
    return {
      hidden: true, disabled: false, textContent: '', dataset: {}, style: {}, scrollTop: 0,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
      addEventListener(type, callback) { listeners.set(type, callback) },
      emit(type, event = {}) { listeners.get(type)?.(event) },
      setAttribute() {}, focus() {}, getBoundingClientRect: () => ({ bottom: 10 }),
      contains: () => false, querySelector: () => null, querySelectorAll: () => [],
    }
  }
  const ids = ['#guideTitle', '#guideDescription', '#guideCount', '#guideStepTitle', '#guideAnnouncement', '#guidePrevious', '#guideNext', '#guideSkip', '#guideIntroPanel', '#guideMockRoles', '#guideExamplePanel', '#guideGainPanel', '#guideCommandPanel']
  const children = new Map(ids.map(id => [id, makeNode()])), roles = ['orchestrator', 'planner', 'executor', 'reviewer'].map(role => {
    const node = makeNode(); node.dataset.guideRole = role; return node
  })
  children.get('#guideMockRoles').querySelectorAll = () => roles
  const root = makeNode(); root.hidden = true; root.querySelector = id => children.get(id) ?? null
  const launcher = makeNode(); launcher.hidden = false
  const invitation = makeNode(), invitationOpen = makeNode(), invitationDismiss = makeNode()
  const document = { fullscreenElement: null, documentElement: makeNode(), listeners: new Map(), querySelector: id => ({ '#guideInvitation': invitation, '#guideInvitationOpen': invitationOpen, '#guideInvitationDismiss': invitationDismiss }[id] ?? null), addEventListener(type, callback) { this.listeners.set(type, callback) }, exitFullscreen() { this.fullscreenElement = null } }
  const storage = new Map(), window = { location: { search: '' }, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, listeners: new Map(), addEventListener(type, callback) { this.listeners.set(type, callback) }, requestAnimationFrame: callback => (callback(), 1), cancelAnimationFrame() {} }
  root.requestFullscreen = () => { document.fullscreenElement = root; document.listeners.get('fullscreenchange')?.(); return Promise.resolve() }
  const input = { root, launcher, document, window, translate: (value, ...args) => value.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)] ?? '') }
  const ui = dashboard()
  const onboarding = ui.run('createPrumoOnboarding(input)', { input })
  launcher.emit('click')
  await Promise.resolve()
  assert.equal(document.fullscreenElement, root)
  assert.equal(root.hidden, false)
  assert.equal(children.get('#guideStepTitle').textContent, 'Overview')
  children.get('#guideNext').emit('click')
  roles[2].emit('click')
  assert.equal(children.get('#guideTitle').textContent, 'The executor')
  children.get('#guideNext').emit('click')
  children.get('#guideNext').emit('click')
  const keydown = document.listeners.get('keydown')
  keydown({ key: 'ArrowLeft', target: root, preventDefault() {} })
  keydown({ key: 'ArrowRight', target: root, preventDefault() {} })
  keydown({ key: 'Escape', target: root, preventDefault() {} })
  assert.equal(root.hidden, true)
  assert.equal(storage.get('prumoOnboardingDismissed'), 'true')
  keydown({ key: 'ArrowRight', target: root, preventDefault() {} })
  onboarding.open()
  await Promise.resolve()
  document.fullscreenElement = root
  document.listeners.get('fullscreenchange')?.()
  document.fullscreenElement = null
  document.listeners.get('fullscreenchange')?.()
  assert.equal(root.hidden, true)

  const defaultRoot = makeNode(), defaultLauncher = makeNode()
  defaultRoot.hidden = true
  defaultRoot.querySelector = id => children.get(id) ?? null
  const defaultTranslateInput = { ...input, root: defaultRoot, launcher: defaultLauncher }
  delete defaultTranslateInput.translate
  const defaultTranslate = ui.run('createPrumoOnboarding(input)', { input: defaultTranslateInput })
  defaultTranslate.open()
  assert.equal(typeof defaultTranslate.open, 'function')

  const delayedRoot = makeNode(), delayedLauncher = makeNode()
  delayedRoot.hidden = true
  delayedRoot.querySelector = id => children.get(id) ?? null
  let resolveFullscreen
  delayedRoot.requestFullscreen = () => {
    document.fullscreenElement = delayedRoot
    return new Promise(resolve => { resolveFullscreen = resolve })
  }
  const delayedApi = ui.run('createPrumoOnboarding(input)', {
    input: { ...input, root: delayedRoot, launcher: delayedLauncher },
  })
  delayedLauncher.emit('click')
  delayedApi.close()
  resolveFullscreen()
  await Promise.resolve()
  assert.equal(delayedRoot.hidden, true)

  for (let step = 0; step < 13; step += 1) children.get('#guideNext').emit('click')
  assert.equal(root.hidden, true)
  assert.equal(typeof onboarding.open, 'function')
  await Promise.resolve()

  assert.equal(ui.run('createPrumoOnboarding({ root: null, launcher: null, document: null })'), null)
  window.localStorage.getItem = () => { throw new Error('storage indisponivel') }
  window.localStorage.setItem = () => { throw new Error('storage indisponivel') }
  window.location = { get search() { throw new Error('URL indisponivel') } }
  document.querySelector = () => null
  children.get('#guideMockRoles').querySelectorAll = () => null
  const edgeOnboarding = ui.run('createPrumoOnboarding(input)', { input })
  edgeOnboarding.open()
  edgeOnboarding.close()

  document.querySelector = id => ({ '#guideInvitation': invitation, '#guideInvitationOpen': invitationOpen, '#guideInvitationDismiss': invitationDismiss }[id] ?? null)
  children.get('#guideMockRoles').querySelectorAll = () => roles
  window.listeners.get('resize')?.()
  root.requestFullscreen = () => { document.fullscreenElement = root; document.listeners.get('fullscreenchange')?.(); return Promise.resolve() }
  const pendingFrames = []
  window.requestAnimationFrame = callback => { pendingFrames.push(callback); return pendingFrames.length }
  window.cancelAnimationFrame = () => {}
  const queuedOnboarding = ui.run('createPrumoOnboarding(input)', { input })
  queuedOnboarding.open()
  for (let step = 0; step < 5; step += 1) children.get('#guideNext').emit('click')
  pendingFrames.shift()?.()
  children.get('#guideNext').emit('click')
  children.get('#guidePrevious').emit('click')
  pendingFrames.shift()?.()
  children.get('#guidePrevious').emit('click')
  for (let step = 0; step < 4; step += 1) children.get('#guidePrevious').emit('click')
  root.contains = () => true
  const queuedKeydown = document.listeners.get('keydown')
  queuedKeydown({ key: 'ArrowRight', target: { closest: () => null, tagName: 'DIV' }, preventDefault() {} })
  queuedKeydown({ key: 'ArrowRight', target: { closest: () => null, tagName: 'INPUT' }, preventDefault() {} })
  const contains = root.contains
  root.contains = undefined
  queuedKeydown({ key: 'ArrowRight', target: {}, preventDefault() {} })
  root.contains = contains
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
  document.exitFullscreen = () => { throw new Error('saída bloqueada') }
  queuedOnboarding.close()
  document.fullscreenElement = null
  let resolveDelayedFullscreen
  root.requestFullscreen = () => {
    document.fullscreenElement = root
    return new Promise(resolve => { resolveDelayedFullscreen = resolve })
  }
  const delayedOnboarding = ui.run('createPrumoOnboarding(input)', { input })
  delayedOnboarding.open()
  delayedOnboarding.close()
  resolveDelayedFullscreen()
  await new Promise(resolve => setImmediate(resolve))
  window.location = null
  ui.run('createPrumoOnboarding(input)', { input })
  root.requestFullscreen = () => { throw new Error('sem gesto') }
  document.fullscreenElement = null
  ui.run('createPrumoOnboarding(input).open()', { input })
  assert.equal(root.hidden, false)
})

test('results and back-to-graph are one CTA whose label alternates', async () => {
  const ui = dashboard('pt-BR')
  ui.run('loadResults = async () => {}')
  assert.match(html, /#resBtn \{[^}]*min-width: 112px;[^}]*background: var\(--accent\)/)
  assert.doesNotMatch(html, /class="rback"/, 'no second, differently styled back button')
  await ui.run('toggleResults()')
  assert.equal(ui.nodes.get('#resBtn').textContent, 'grafo')
  assert.equal(ui.nodes.get('#resBtn').getAttribute('aria-pressed'), 'true')
  await ui.run('toggleResults()')
  assert.equal(ui.nodes.get('#resBtn').textContent, 'resultados')
  assert.equal(ui.nodes.get('#resBtn').getAttribute('aria-pressed'), 'false')
})

test('historico clicavel oferece foco visivel para navegacao por teclado', () => {
  assert.match(html, /\.ev-open:focus-visible, \.task-ref:focus-visible \{ outline: 1px solid var\(--accent\)/)
})

test('lateral preserva o historico sem a secao de falhas e retentativas', () => {
  assert.doesNotMatch(html, /id="failures(?:Box)?"/)
  assert.match(html, /id="eventsBox"/)
  assert.match(html, /#statusBox \.count-label \{[^}]*color: inherit/)
})

test('historico abre a tarefa atual por alias e nao oferece acao para tarefa inexistente', () => {
  const ui = dashboard('pt-BR')
  ui.render({run:'historico',plan:{},taskIdAliases:{T17:'T11a'},tasks:{T11a:task('T11a','done')},derived:{}}, [
    {type:'task_validate',task:'T17',ok:false,by:'review',at:instant(1)},
    {type:'task_note',task:'T99',text:'Nota antiga',at:instant(2)},
  ])
  const log = ui.nodes.get('#events').innerHTML
  assert.match(log, /onclick="selectHistoryEvent\('[^']*','T11a',''\)"><button class="ev-open" type="button">/)
  assert.doesNotMatch(log, /onclick="jumpTo\('T99'\)"/)
  assert.match(log, /data-ok="false"/)
  const eventTarget = { closest(selector) { return selector === '.ev' ? this : null } }
  ui.dispatchDocument('click', {target:eventTarget}, () => ui.run('jumpTo("T11a")'))
  assert.equal(ui.run('POP.id'), 'T11a', 'o clique propagado nao fecha o card que acabou de abrir')
  assert.equal(ui.run('POP_EXPANDED'), false)
})

test('referencias usam o estado atual e localizam tarefas concluidas ocultas pelo filtro', () => {
  const ui = dashboard('pt-BR')
  ui.render({run:'referencias',plan:{},tasks:{T1:task('T1','done'),T2:task('T2','blocked',{blockReason:'Aguardar T1 e T99 <img src=x onerror=alert(1)>'})},derived:{}},[
    {type:'task_review',task:'T1',at:instant(1)},
    {type:'task_note',task:'T2',at:instant(2),text:'Conferir T1 e T99 <img src=x onerror=alert(1)>'},
  ])
  const log = ui.nodes.get('#events').innerHTML, available = ui.nodes.get('#available').innerHTML
  for (const content of [log,available]) {
    assert.match(content, /class="task-ref ev-task" style="color:var\(--done\)"/)
    assert.match(content, /jumpTo\('T1'\)/)
    assert.doesNotMatch(content, /jumpTo\('T99'\)|<img/)
    assert.match(content, /&lt;img/)
  }
  ui.run('setFilter("running")')
  assert.equal(ui.cards.find(card=>card.dataset.id==='T1').classList.contains('filtered-out'), true)
  ui.run('jumpTo("T1")')
  assert.equal(ui.run('FILTER'), 'all')
  assert.equal(ui.run('POP.id'), 'T1')
  assert.equal(ui.nodes.get('#pop').dataset.st, 'done')
  assert.equal(ui.cards.find(card=>card.dataset.id==='T1').classList.contains('filtered-out'), false)
})

test('contador do historico fica vermelho em reprovação mesmo com a tarefa concluida', () => {
  const ui = dashboard('pt-BR')
  ui.render({run:'contadores',plan:{},tasks:{T1:task('T1','done'),T2:task('T2','blocked')},derived:{}},[
    {type:'task_done',task:'T1',at:instant(1),current:4,total:6},
    {type:'task_validate',task:'T1',at:instant(2),ok:false,current:4,total:6},
    {type:'task_block',task:'T2',at:instant(3),current:2,total:6},
  ])
  const log = ui.nodes.get('#events').innerHTML
  assert.match(log, /class="ev-count" style="color:var\(--done\)"> \[4\/6\]/)
  assert.match(log, /class="ev-count" style="color:var\(--failed\)"> \[4\/6\]/)
  assert.match(log, /class="ev-count" style="color:var\(--failed\)"> \[2\/6\]/)
  assert.match(html, /\.ev:has\(\.ev-open\) \{[^}]*cursor: pointer; user-select: none/)
})

test('o momento do evento preserva revisao azul e aprovacao verde na tarefa hoje concluida', () => {
  const ui=dashboard('pt-BR')
  ui.render({run:'cores',plan:{phases:[{id:'F1'}]},tasks:{T1:task('T1','done',{phase:'F1'})},derived:{}},[
    {id:'inicio',type:'task_check',task:'T1',by:'review',status:'started',at:instant(1),current:5,total:6},
    {id:'aprovado',type:'task_check',task:'T1',by:'review',status:'passed',at:instant(2),current:5,total:6},
    {id:'executor',type:'task_start',task:'T1',at:instant(0)},
    {id:'fase',type:'phase_planning',phase:'F1',at:instant(3)},
    {id:'global',type:'run_init',at:instant(4)},
  ])
  const log=ui.nodes.get('#events').innerHTML
  assert.match(log,/data-event-key="inicio"[\s\S]*?ev-task" style="color:var\(--review\)"[\s\S]*?ev-count" style="color:var\(--review\)"> \[5\/6\]/)
  assert.match(log,/data-event-key="aprovado"[\s\S]*?ev-task" style="color:var\(--done\)"[\s\S]*?ev-count" style="color:var\(--done\)"> \[5\/6\]/)
  assert.match(log,/data-event-key="executor"[\s\S]*?ev-task" style="color:var\(--running\)"/)
  assert.equal((log.match(/class="ev-open"/g)??[]).length,5)
  ui.run('selectHistoryEvent("global","","")')
  assert.equal(ui.run('SELECTED_EVENT'),'global')
  ui.run('selectHistoryEvent("fase","","F1")')
  assert.equal(ui.run('VIEW_MANUAL'),true)
  ui.run('selectHistoryEvent("inicio","T1","")')
  assert.equal(ui.nodes.get('#pop').dataset.st,'done')
})

test('fases ficam verdes so depois de todas as tarefas validas e usam a paleta aprovada', () => {
  const ui=dashboard('pt-BR')
  ui.render({run:'fases',plan:{phases:['F1','F2','F3','F4'].map(id=>({id}))},tasks:{T1:task('T1','waiting',{phase:'F1'}),T2:task('T2','discussing',{phase:'F2'}),T3:task('T3','running',{phase:'F3'}),T4:task('T4','done',{phase:'F4'}),T5:task('T5','skipped',{phase:'F4'})},derived:{}})
  assert.equal(ui.run('phaseColour("F1")'),'var(--waiting)')
  assert.equal(ui.run('phaseColour("F2")'),'var(--planning)')
  assert.equal(ui.run('phaseColour("F3")'),'var(--accent)')
  assert.equal(ui.run('phaseColour("F4")'),'var(--done)')
  assert.match(ui.run('taskText("T1 e F3")'),/href="#phase-F3"[^>]*jumpToPhase\('F3'\)/)
})

test('reprovacao historica permanece vermelha mesmo depois da conclusao aprovada', () => {
  const ui = dashboard('pt-BR')
  ui.render({run:'revisao',plan:{},tasks:{T1:task('T1','done',{validations:[
    {ok:false,by:'review',at:instant(1),evidence:'Correção necessária'},
    {ok:true,by:'review',at:instant(2),evidence:'Correção conferida'},
  ]})},derived:{}})
  ui.run('POP_EXPANDED = true; fillPop("T1")')
  assert.equal(ui.nodes.get('#pop').dataset.st, 'done')
  assert.match(ui.nodes.get('#popBody').innerHTML, /class="vitem bad"[\s\S]*Reprovado[\s\S]*Correção necessária/)
  assert.match(ui.nodes.get('#popBody').innerHTML, /Aprovado[\s\S]*Correção conferida/)
  assert.match(html, /\.vitem\.bad \{[^}]*background: #472329/)
  assert.equal(ui.run('statusLabel("ready_for_discussion")'), 'pronto para discutir')
})

test('todos os selos usam os nomes do resumo em minusculas e sem metadados', () => {
  const ui=dashboard('pt-BR')
  const labels={skipped:'pulado',waiting:'aguardando',ready_for_discussion:'pronto para discutir',discussing:'discutindo',ready_to_plan:'pronto para planejar',planning:'planejando',ready:'pronto para executar',running:'executando',ready_for_review:'pronto para revisar',reviewing:'revisando',blocked:'bloqueado',failed:'falhou',done:'no prumo'}
  for(const [state,label] of Object.entries(labels)) {
    ui.render({run:'estados',plan:{},tasks:{T1:task('T1',state)},derived:{T1:{effective:state}}})
    ui.run('fillPop("T1")')
    assert.equal(ui.nodes.get('#popStatus').textContent,label,state)
    const boardLabel=({ready_for_discussion:'DISCUTIR',ready_to_plan:'PLANEJAR',ready:'EXECUTAR',ready_for_review:'REVISAR'})[state]??label.toLocaleUpperCase('pt-BR')
    assert.match(ui.nodes.get('#nodes').innerHTML,new RegExp('class="tr">'+boardLabel+'<\\/span>'))
    assert.doesNotMatch(ui.nodes.get('#nodes').innerHTML,/class="elapsed"/)
    if(['discussing','planning','running','reviewing'].includes(state)) assert.match(ui.nodes.get('#nodes').innerHTML,/class="tr">[^<]+<\/span><span class="status-separator"[^>]*>·<\/span><span class="beat"/)
  }
})

test('historico destaca nomes e referencias sem alterar os dados nem executar notas', () => {
  const ui = dashboard('pt-BR')
  const events = [
    { type: 'task_note', task: 't14', at: instant(1), text: 'conferir t12, f3 e T25 <img src=x onerror=alert(1)>' },
    { type: 'phase_planning', phase: 'f3', at: instant(2) },
    { type: 'task_start', task: 't12', at: instant(3) },
    { type: 'task_validate', task: 't12', at: instant(4), by: 'review', ok: true },
  ]
  ui.render({ run: 'historico', plan: {}, tasks: {}, derived: {} }, events)
  const log = ui.nodes.get('#events').innerHTML
  for (const value of ['T14', 'T12', 'F3', 'T25', 'Orquestrador', 'Planejador', 'Executor', 'Revisor']) assert.ok(log.includes(value), value)
  assert.doesNotMatch(log, /\bt14\b|\bt12\b|\bf3\b|<img/)
  assert.ok(log.includes('&lt;img'))
  assert.match(log, /aria-hidden="true">\|<\/span>/)
  assert.equal(events[0].task, 't14')
  assert.match(events[0].text, /t12, f3/)
})

test('atualizacao identica preserva os cards e mudancas reais repintam o plano', () => {
  const ui = dashboard('pt-BR')
  const state = { run: 'plano', plan: {}, tasks: { T1: task('T1') }, derived: { T1: { effective: 'ready' } } }
  ui.render(state)
  const first = ui.cards[0]
  ui.render(state)
  assert.equal(ui.cards[0], first)
  state.tasks.T1.title = 'Titulo atualizado'
  ui.render(state)
  assert.notEqual(ui.cards[0], first)
  assert.match(ui.nodes.get('#nodes').innerHTML, /Titulo atualizado/)
  ui.run("showRunLoading('plano')")
  ui.render(state)
  assert.equal(ui.cards.length, 1)
})

test('o catalogo preserva a descricao carregada sem aproveitar outro diretorio', () => {
  const ui = dashboard('pt-BR')
  ui.run("SELECTED_ROOT = 'raiz'; SELECTED_RUN = 'plano'; STATE_RUN_KEY = 'raiz\\0plano'; STATE = { run: 'plano', plan: { name: 'Nome curto', description: 'Descricao completa' } }")
  const catalog = { currentRoot: 'raiz', current: 'plano', runs: [{ root: 'raiz', run: 'plano', plan: 'Nome curto' }] }
  ui.run('updateRunSelect(input)', { input: catalog })
  assert.equal(ui.nodes.get('#runLabel').textContent, 'Descricao completa')
  ui.run("SELECTED_ROOT = 'outra'; updateRunSelect(input)", { input: { ...catalog, runs: [{ root: 'outra', run: 'plano', plan: 'Outro nome' }] } })
  assert.equal(ui.nodes.get('#runLabel').textContent, 'Outro nome')
})

test('indicadores ficam juntos acima dos agentes, capitalizados e nas cores dos estados', () => {
  const ui = dashboard('pt-BR')
  const states = { T1: 'running', T2: 'discussing', T3: 'planning', T4: 'reviewing', T5: 'skipped', T6: 'waiting', T7: 'done' }
  const state = { run: 'indicadores', plan: { maxExecutors: 3 }, tasks: Object.fromEntries(Object.entries(states).map(([id, value]) => [id, task(id, value)])),
    derived: Object.fromEntries(Object.entries(states).map(([id, effective]) => [id, { effective }])) }
  ui.render(state)
  const counts = ui.nodes.get('#counts').innerHTML
  for (const [key, label, color] of [['discussing', 'Discutindo', 'discussion'], ['planning', 'Planejando', 'planning'], ['running', 'Executando', 'running'],
    ['reviewing', 'Revisando', 'review'], ['skipped', 'Pulado', 'skipped'], ['waiting', 'Aguardando', 'waiting'], ['done', 'No Prumo', 'done']]) {
    const row = counts.match(new RegExp('<span data-state="' + key + '"[\\s\\S]*?</b></span>'))?.[0]
    assert.ok(row?.includes(label), label)
    assert.ok(row.includes('var(--' + color + ')'), label)
  }
  assert.match(counts, /Executando<\/span> <b>1\/3<\/b>/)
  for (const label of ['Discutindo', 'Planejando', 'Revisando']) {
    assert.match(counts, new RegExp(label + '<\\/span> <b>1\\/3<\\/b>'), 'todos os papéis exibem o mesmo teto compartilhado')
  }
  assert.ok(html.indexOf('id="counts"') < html.indexOf('id="agentsBox"'))
  assert.doesNotMatch(html, /id="parTitle"/)
  assert.doesNotMatch(counts, /em execução|aguardando|concluído|pulado/)
  assert.equal((counts.match(/data-state="running"/g) ?? []).length, 1)
  ui.run("setFilter('done')")
  assert.equal(ui.nodes.get('#counts').innerHTML, counts, 'filtrar nao muda os totais do plano')
  state.tasks.T8 = task('T8')
  state.derived.T8 = { effective: 'ready_to_plan' }
  ui.render(state)
  assert.match(ui.nodes.get('#counts').innerHTML, /Pronto para planejar<\/span> <b>1<\/b>/)
  const expandedCounts = ui.nodes.get('#counts').innerHTML
  assert.ok(expandedCounts.indexOf('data-state="done"') > expandedCounts.indexOf('data-state="ready_to_plan"'), 'Concluido encerra o resumo sem deslocar os separadores das outras linhas')
  assert.match(html, /#statusBox \.count-label \{[^}]*min-width: 0;[^}]*white-space: normal;/)
  assert.match(html, /#statusBox \.counts b \{[^}]*white-space: nowrap;/)
})

test('as conexoes ficam ocultas e o trilho das fases permanece visivel', () => {
  assert.match(html, /#edgePaths, #hubPaths, #structPaths \.s-base \{ display: none; \}/)
  assert.doesNotMatch(html, /#structPaths(?:,| \{)[^}]*display: none/)
  const ui = dashboard('pt-BR')
  ui.render({ run: 'dependencias', plan: { phases: [{ id: 'F1', title: 'Fase' }] }, tasks: { T1: task('T1'), T2: task('T2', 'pending', { deps: ['T1'] }) },
    derived: { T1: { effective: 'ready' }, T2: { effective: 'waiting', blockedBy: ['T1'] } } })
  assert.match(ui.nodes.get('#structPaths').innerHTML, /class="s-rail next"/)
  assert.match(ui.nodes.get('#nodes').innerHTML, /← T1/)
})

test('Concluido ocupa uma linha central e plano e filtros compartilham a mesma seta', () => {
  assert.match(html, /#statusBox \.counts > span\[data-state="done"\] \{ grid-column: 1 \/ -1; justify-content: center;/)
  assert.match(html, /#statusBox \.counts > span\[data-state="done"\] \.count-label \{ flex: none;/)
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'))
  const chevrons = [...header.matchAll(/<svg class="control-chevron"[^>]*>[\s\S]*?<\/svg>/g)].map(match => match[0])
  assert.equal(chevrons.length, 4)
  assert.equal(new Set(chevrons).size, 1)
  assert.doesNotMatch(header, /control-chevron[^>]*tabindex/)
  assert.doesNotMatch(html, /(?:\.filter-toggle|\.header-menu summary)::after \{ content: '⌄'/)
})

test('o card abre resumido, expande para os detalhes e volta ao resumo sem controles de modos ou PIN', () => {
  const ui = dashboard('pt-BR')
  const tasks = { T: task('T', 'ready', { summary: 'Resumo curto', taskPlan: { ...plan, steps: ['PASSO_COMPLETO'] } }), U: task('U') }
  ui.render({ run: 'card', plan: {}, tasks, derived: { T: { effective: 'ready' }, U: { effective: 'ready' } } })
  ui.run("localStorage = { getItem: () => 'detail', setItem: () => { throw Error('Nao deve persistir modo') } }; openTask('T')")
  assert.equal(ui.run('POP_EXPANDED'), false)
  assert.match(ui.nodes.get('#popBody').innerHTML, /Resumo curto/)
  assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, /PASSO_COMPLETO|see detail|setPopMode/)
  assert.doesNotMatch(html, /id="popPin"|class="pmode"|id="selectedBox"|id="selectedTask"/)
  ui.run('togglePopExpand()')
  assert.equal(ui.nodes.get('#popExpand').getAttribute('aria-expanded'), 'true')
  assert.match(ui.nodes.get('#popBody').innerHTML, /PASSO_COMPLETO/)
  ui.run('fillPop(POP.id)')
  assert.match(ui.nodes.get('#popBody').innerHTML, /PASSO_COMPLETO/, 'atualizar preserva a leitura expandida')
  ui.run('togglePopExpand(false)')
  assert.equal(ui.nodes.get('#popExpand').getAttribute('aria-expanded'), 'false')
  assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, /PASSO_COMPLETO/)
  ui.run("togglePopExpand(true); openTask('U')")
  assert.equal(ui.run('POP_EXPANDED'), false)
  assert.equal(ui.nodes.get('#popScrim').classList.contains('on'), false)
  ui.run("togglePopExpand(true); closePop(); openTask('T')")
  assert.equal(ui.run('POP_EXPANDED'), false)
  assert.equal(ui.nodes.get('#availableBox').hidden, false)
  ui.dispatchDocument('keydown', { key: 'Escape' })
  assert.equal(ui.nodes.get('#popBody').innerHTML, '')
  assert.equal(ui.nodes.get('#pop').hidden, true)
  assert.equal(ui.nodes.get('#pop').dataset.run, undefined)
})

test('a paleta do card tem contraste legivel e preserva as cores sem alterar o painel inteiro', () => {
  const cardTokens = Object.fromEntries([...html.match(/#pop \{ --ease:[\s\S]*?\n\s*\}/)[0].matchAll(/--([\w-]+): (#[a-f\d]{6})/gi)].map(match => [match[1], match[2]]))
  const rootTokens = Object.fromEntries([...html.match(/:root \{[\s\S]*?\n\s*\}/)[0].matchAll(/--([\w-]+): (#[a-f\d]{6})/gi)].map(match => [match[1], match[2]]))
  const luminance = hex => hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0)
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
  assert.notEqual(cardTokens.panel, rootTokens.panel)
  for (const key of ['text', 'dim', 'faint', 'waiting', 'skipped', 'failed', 'running', 'discussion', 'planning', 'done', 'review', 'ready', 'ready-plan', 'ready-discussion', 'validated', 'blocked']) {
    const foreground = cardTokens[key] ?? rootTokens[key]
    for (const surface of ['panel', 'bg', 'card']) assert.ok(contrast(foreground, cardTokens[surface]) >= 4.5, key + ' sobre ' + surface)
  }
  const ui = dashboard('pt-BR')
  ui.render({ run: 'cores', plan: {}, tasks: { T: task('T', 'done') }, derived: { T: { effective: 'done' } } })
  ui.run("openTask('T')")
  assert.equal(ui.nodes.get('#popTitle').textContent, 'T')
  assert.equal(ui.nodes.get('#popStatus').textContent, 'no prumo')
  assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, /id="popTitle"|class="st"/)
  assert.doesNotMatch(html.match(/:root \{[\s\S]*?\n\s*\}/)[0], /#123441/)
})

test('o cabecalho mostra tarefa e estado sem confundir tentativas com conclusao', () => {
  const ui = dashboard('pt-BR')
  const attempts = [
    { n: 1, agent: 'executor', startedAt: instant(1), endedAt: instant(2), result: 'failed' },
    { n: 2, agent: 'executor', startedAt: instant(3), endedAt: instant(4), result: 'passed' },
  ]
  ui.render({ run: 'concluido', plan: { maxAttempts: 3 }, tasks: { T24: task('T24', 'done', { attempts }) },
    derived: { T24: { effective: 'done' } } })
  for (const expanded of [false, true]) {
    ui.run('POP_EXPANDED = expanded; fillPop("T24")', { expanded })
    assert.equal(ui.nodes.get('#popTitle').textContent, 'T24')
    assert.equal(ui.nodes.get('#popStatus').textContent, 'no prumo')
    assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, /2 de 3|tentativa 2 de 3|id="popTitle"/)
  }
})

test('cada familia de estado tem fundo proprio no quadro, inclusive antes da discussao', () => {
  const families = [
    ['waiting', 'pending', '#27343c'], ['ready_for_discussion', 'discussing', '#443517'],
    ['ready_to_plan', 'planning', '#302e4d'], ['ready', 'running', '#4a2b1f'], ['ready_for_review', 'reviewing', '#183b4a'],
  ]
  for (const [queued, active, color] of families) {
    assert.ok(html.includes(`.node:is([data-st="${queued}"], [data-st="${active}"]) { --ticket-bg: ${color}; }`))
  }
  for (const [state, color] of [['done', '#323c21'], ['blocked', '#472a36'],
    ['failed', '#4b242b'], ['skipped', '#30332d']]) {
    assert.ok(html.includes(`.node[data-st="${state}"] { --ticket-bg: ${color}; }`))
  }
  assert.match(html, /\.node \{[^}]*background: var\(--ticket-bg\)/)
})

test('o card aberto e suas superficies internas seguem o estado da tarefa', () => {
  assert.match(html, /#pop\[data-st\]:not\(\[data-st="done"\]\) \{[^}]*--panel: var\(--ticket-bg\);[^}]*--bg: color-mix[^}]*--card: color-mix[^}]*--line: color-mix/)
  const families = [
    ['ready_for_discussion', '#443517'], ['ready_to_plan', '#302e4d'],
    ['running', '#4a2b1f'], ['reviewing', '#183b4a'], ['blocked', '#472a36'],
    ['failed', '#4b242b'], ['waiting', '#27343c'], ['skipped', '#30332d'],
  ]
  for (const [state, color] of families) {
    assert.match(html, new RegExp(`#pop[^\\n{]*\\[data-st="${state}"\\][^\\n{]*\\{ --ticket-bg: ${color}; \\}`))
    const ui = dashboard('pt-BR')
    ui.render({ run: `estado-${state}`, plan: {}, tasks: { T9: task('T9', state) },
      derived: { T9: { effective: state } } })
    ui.run("fillPop('T9')")
    assert.equal(ui.nodes.get('#pop').dataset.st, state)
    assert.equal(ui.nodes.get('#popTitle').textContent, 'T9')
  }
  const ui = dashboard('pt-BR')
  ui.render({ run: 'estado-done', plan: {}, tasks: { T9: task('T9', 'done') }, derived: { T9: { effective: 'done' } } })
  ui.run("fillPop('T9')")
  assert.equal(ui.nodes.get('#pop').dataset.st, 'done')
  assert.match(html, /#pop \{ --ease:[^}]*--panel: #323c21/)
})

test('Aguardando no resumo usa a mesma cor legivel dos cards de espera', () => {
  assert.match(html, /--waiting: #a2b6bd/)
  const ui = dashboard('pt-BR')
  ui.render({ run: 'espera', plan: { phases: [] }, tasks: {
    T1: task('T1', 'pending', { deps: ['T2'] }),
    T2: task('T2', 'blocked'),
  }, derived: { T1: { effective: 'waiting' }, T2: { effective: 'blocked' } } })
  assert.match(ui.nodes.get('#counts').innerHTML, /data-state="waiting" style="color:var\(--waiting\)"[^>]*>[\s\S]*?Aguardando[\s\S]*?<b>1<\/b>/)
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-st="waiting"[^>]*data-id="T1"/)
})

test('expandir e seguir dependencias mantem o card aberto sem duplicar a tarefa na lateral', () => {
  const ui = dashboard('pt-BR')
  ui.render({ run: 'x', plan: {}, tasks: { T: task('T'), U: task('U', 'pending', { deps: ['T'] }) },
    derived: { T: { effective: 'ready' }, U: { effective: 'waiting' } } })
  const pop = { matches: selector => selector === '#pop' }
  // the clicked control was replaced by fillPop: it is detached, so closest() finds nothing,
  // but the dispatch path captured before the re-render still contains #pop
  const detached = path => ({ target: { closest: () => null }, composedPath: () => [{ matches: () => false }, ...path] })

  ui.run("POP_EXPANDED = false; openPop('T', true)")
  ui.dispatchDocument('click', detached([pop]), () => ui.run('togglePopExpand(true)'))
  assert.equal(ui.run('POP?.id'), 'T', '"see detail" keeps the pinned popover open')
  assert.equal(ui.run('POP_EXPANDED'), true)
  assert.equal(ui.nodes.get('#availableBox').hidden, false)

  ui.dispatchDocument('click', detached([pop]), () => ui.run("jumpTo('U')"))
  assert.equal(ui.run('POP?.id'), 'U', 'a dependency chip opens the linked task')
  assert.equal(ui.run('POP.pinned'), true)
  assert.equal(ui.nodes.get('#availableBox').hidden, false)
  assert.match(ui.nodes.get('#popBody').innerHTML, /Task U/)
  assert.equal(ui.cards.find(card => card.dataset.id === 'U').classList.contains('lit-self'), true, 'the linked card is highlighted')

  ui.dispatchDocument('click', { target: { closest: () => null }, composedPath: () => [{ matches: () => false }] })
  assert.equal(ui.run('POP'), null, 'a click outside still closes it')
})

test('IDs exibidos em chips normalizam T/F sem alterar o alvo real da dependência', () => {
  const ui = dashboard('pt-BR')
  const state = { run: 'ids', plan: { phases: [{ id: 'f1A', title: 'Fase' }] }, tasks: {
    t1A: task('t1A', 'done', { phase: 'f1A' }),
    f2B: task('f2B', 'pending', { phase: 'f1A', deps: ['t1A'] }),
  }, derived: { t1A: { effective: 'done' }, f2B: { effective: 'waiting', blockedBy: ['t1A'] } } }
  ui.render(state)
  ui.run("openTask('f2B')")
  const pop = ui.nodes.get('#popBody').innerHTML
  assert.match(pop, /onclick="jumpTo\('t1A'\)"[^>]*>[\s\S]*<b>T1a/)
  assert.equal(ui.nodes.get('#popTitle').textContent, 'F2b')
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-id="t1A"[^>]*>[\s\S]*<span class="id">T1a/)
  ui.run("jumpTo('t1A')")
  assert.equal(ui.run('POP.id'), 't1A', 'o alvo mantém o ID real, com sua capitalização original')
})

test('115h23 phase envelope stays out of displayed time while measured work and critical path stay exact', () => {
  const elapsedSeconds = (115 * 60 + 23) * 60
  const phaseStart = instant(100 - elapsedSeconds)
  for (const open of [false, true]) {
    const ui = dashboard('pt-BR')
    const taskValue = task('A', 'done', {
      title: 'A tarefa tem um título muito comprido',
      label: 'Tarefa curta',
      phase: 'F0',
      attempts: [{ startedAt: instant(95), endedAt: instant(100) }],
    })
    const state = {
      run: 'phase-long',
      createdAt: phaseStart,
      plan: { phases: [{ id: 'F0', title: 'Título completo da fase F0 muito grande', label: 'Fase curta' }] },
      tasks: { A: taskValue },
      derived: { A: { effective: 'done', blockedBy: [] } },
      phaseWorkflows: { F0: {
        id: 'F0', state: open ? 'planning' : 'planned',
        planningAttempts: [{ startedAt: phaseStart, ...(open ? {} : { endedAt: instant(100) }) }],
      } },
    }
    const events = [
      { type: 'task_start', task: 'A', attempt: 1, at: instant(95) },
      { type: 'task_progress', task: 'A', attempt: 1, at: instant(100) },
      { type: 'task_done', task: 'A', attempt: 1, at: instant(100) },
    ]
    const result = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
    assert.equal(result.phasePlanning[0].elapsed, elapsedSeconds * 1000)
    assert.equal(result.phasePlanning[0].duration, 0)
    assert.equal(result.planningTotal, 0)
    assert.equal(result.agentTotal, 5000)
    assert.equal(result.activeElapsed, 5000)
    assert.equal(result.wall, elapsedSeconds * 1000)
    assert.equal(result.cpLen, 5000, 'the measured task alone remains available to internal calculations')
    assert.equal(result.criticalPathMeasured, false, 'unmeasured phase planning suppresses the displayed critical path')
    ui.render(state, events)
    const graph = ['#lanes', '#nodes', '#parallel', '#orch', '#planSub']
      .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
    assert.match(graph, /00:00:05/)
    assert.match(graph, /não aferido/)
    assert.doesNotMatch(ui.nodes.get('#doneCount').innerHTML, /5s|não aferido|00:00:05/)
    assert.doesNotMatch(graph, /115h|76h|192h|115:23|24h/)
    ui.run('FULL_EVENTS = inputEvents; renderResults(input)', { input: state, inputEvents: events })
    const results = ui.nodes.get('#results').innerHTML
    assert.match(results, /Ganho com prumo e paralelismo/)
    assert.doesNotMatch(results, /Caminho crítico/, 'an unmeasured critical path is not shown')
    assert.doesNotMatch(results, /115h|76h|192h|115h23|aberta por|decorrido/)
  }
})

test('blocked execution keeps only its two measured slices across graph, results and popover', () => {
  const waitSeconds = 115 * 3600 + 23 * 60
  const startSeconds = 100 - waitSeconds - 10
  const events = [
    { type: 'task_start', task: 'A', attempt: 1, at: instant(startSeconds) },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(startSeconds + 5), current: 1, total: 2 },
    { type: 'task_block', task: 'A', attempt: 1, at: instant(startSeconds + 5) },
    { type: 'task_unblock', task: 'A', attempt: 1, at: instant(startSeconds + waitSeconds + 5), state: 'running' },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(100), current: 2, total: 2 },
  ]
  const value = task('A', 'running', { phase: 'F0', agent: 'executor-1', attempts: [{ n: 1, startedAt: instant(startSeconds) }] })
  const state = { run: 'blocked-gap', createdAt: instant(startSeconds), plan: { phases: [{ id: 'F0', title: 'Fase longa' }] },
    tasks: { A: value }, derived: { A: { effective: 'running', blockedBy: [] } } }
  const ui = dashboard('pt-BR')
  ui.render(state, events)

  const graph = ['#doneCount', '#lanes', '#nodes', '#parallel', '#orch', '#planSub']
    .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
  assert.match(graph, /10s/)
  assert.match(graph, /não aferido/)
  assert.doesNotMatch(graph, /115h|76h|192h|115:23|24h/)

  const metrics = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
  assert.equal(metrics.agentTotal, 10000)
  assert.equal(metrics.activeElapsed, 10000)
  assert.equal(metrics.cpLen, 10000)
  assert.deepEqual(JSON.parse(JSON.stringify(metrics.per[0].spans.map(([kind, from, to]) => [kind, Math.round((to - from) / 1000)]))), [['exec', 5], ['exec', 5]])

  ui.run('FULL_EVENTS = inputEvents; RESULTS_OPEN = true; renderResults(STATE)', { inputEvents: events })
  const results = ui.nodes.get('#results').innerHTML
  assert.match(results, /Ganho com prumo e paralelismo/)
  assert.doesNotMatch(results, /115h|76h|192h|115:23|24h|115 hours/)

  ui.run("POP = { id: 'A', pinned: true }; POP_EXPANDED = false; fillPop('A')")
  const popover = ui.nodes.get('#popBody').innerHTML
  assert.match(popover, /10s/)
  assert.doesNotMatch(popover, /115h|76h|192h|115:23|24h/)
})

test('more than 120 events preserve long pauses and never display unmeasured envelope time', () => {
  const waitSeconds = 115 * 3600 + 23 * 60
  const startSeconds = 100 - waitSeconds - 10
  const events = [
    { type: 'task_start', task: 'A', attempt: 1, at: instant(startSeconds) },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(startSeconds + 5), current: 1, total: 2 },
    { type: 'task_block', task: 'A', attempt: 1, at: instant(startSeconds + 5) },
    ...Array.from({ length: 121 }, (_, index) => ({ type: 'task_note', task: 'OTHER', at: instant(90 + index / 100), text: `event-${index}` })),
    { type: 'task_unblock', task: 'A', attempt: 1, at: instant(startSeconds + waitSeconds + 5), state: 'running' },
    { type: 'task_progress', task: 'A', attempt: 1, at: instant(100), current: 2, total: 2 },
  ]
  const value = task('A', 'running', { agent: 'executor-1', attempts: [{ n: 1, startedAt: instant(startSeconds) }] })
  const state = { run: 'long-block', createdAt: instant(startSeconds), plan: {}, tasks: { A: value },
    derived: { A: { effective: 'running', blockedBy: [] } } }
  assert.ok(events.length > 120)
  const ui = dashboard('en')
  const truncated = events.slice(-120)
  const truncatedCalculation = ui.run('analyse(input, inputEvents, true)', { input: state, inputEvents: truncated })
  assert.equal(truncatedCalculation.agentTotal, 5000, 'a long gap without its opening pause marker remains unknown')

  ui.run('EVENTS_COMPLETE = false')
  ui.render(state, truncated)
  const visibleWhileIncomplete = ['#orch', '#doneCount', '#parallel', '#nodes', '#planSub']
    .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
  assert.match(visibleWhileIncomplete, /Live[\s\S]*not measured/)
  assert.match(ui.nodes.get('#orch').innerHTML, /aria-label="Agent time: not measured"/)
  assert.equal(ui.nodes.get('#orch').classList.contains('live'), true)
  assert.match(visibleWhileIncomplete, /not measured/)
  assert.doesNotMatch(visibleWhileIncomplete, /115h|115:23|415390s/)
  ui.run("POP = { id: 'A', pinned: true }; POP_EXPANDED = false; fillPop('A')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /Agent time[\s\S]*· not measured/)
  ui.run('FULL_EVENTS = inputEvents; RESULTS_OPEN = true; renderResults(STATE)', { inputEvents: truncated })
  const incompleteResults = ui.nodes.get('#results').innerHTML
  assert.match(incompleteResults, /Event history is incomplete; technical gain is not measured\./)
  assert.doesNotMatch(incompleteResults, /115h|115:23|415390s/)

  ui.run('EVENTS_COMPLETE = true; FULL_EVENTS = inputEvents; EVENTS = inputEvents; render(STATE, inputEvents); renderResults(STATE)',
    { input: state, inputEvents: events })
  const completeMetrics = ui.run('analyse(input, inputEvents, true)', { input: state, inputEvents: events })
  assert.equal(completeMetrics.agentTotal, 10000)
  assert.equal(completeMetrics.per[0].blocked, waitSeconds * 1000)
  assert.match(ui.nodes.get('#orch').innerHTML, /Live[\s\S]*00:00:10/)
  assert.match(ui.nodes.get('#orch').innerHTML, /aria-label="Agent time: 00:00:10 · not measured"/)
  const visibleWithCompleteHistory = ['#orch', '#doneCount', '#parallel', '#results', '#popBody']
    .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
  assert.doesNotMatch(visibleWithCompleteHistory, /115h|115:23|415390s/)
})

test('late event pages from a previous run cannot contaminate the newly selected run', async () => {
  const ui = dashboard()
  let resolvePage
  ui.run('fetch = inputFetch', { inputFetch: () => new Promise(resolve => { resolvePage = resolve }) })
  ui.run("TICK_GENERATION = 1; resetEventHistory('root/run-a')")
  const oldRun = ui.run("syncEventHistory(1, 'root/run-a')")
  ui.run("TICK_GENERATION = 2; resetEventHistory('root/run-b'); FULL_EVENTS = [{ id: 'new-run' }]; EVENTS = FULL_EVENTS; EVENT_OFFSET = 1; EVENT_HISTORY_REVISION = 'rev-b'; EVENTS_COMPLETE = true")
  const staleEntry = ui.run("syncEventHistory(1, 'root/run-a')")
  assert.equal(ui.run('EVENT_HISTORY_KEY'), 'root/run-b', 'an obsolete entry cannot reset the newly selected history')
  resolvePage({ ok: true, json: async () => ({ events: [{ id: 'old-run' }], next: 1, total: 1, complete: true, revision: 'rev-a' }) })
  await oldRun
  await staleEntry
  assert.equal(ui.run('EVENT_HISTORY_KEY'), 'root/run-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'new-run' }])
  assert.equal(ui.run('EVENT_HISTORY_REVISION'), 'rev-b')
  assert.equal(ui.run('EVENTS_COMPLETE'), true)
})

test('a late state response after selecting another run cannot replace its state or history', async () => {
  const ui = dashboard()
  const oldState = { run: 'run-a', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  const newState = { run: 'run-b', createdAt: instant(0), plan: { phases: [] },
    tasks: { B: task('B', 'done') }, derived: { B: { effective: 'done', blockedBy: [] } } }
  const runs = {
    a: { currentRoot: 'root-a', current: 'run-a', runs: [{ root: 'root-a', run: 'run-a', plan: '' }] },
    b: { currentRoot: 'root-b', current: 'run-b', runs: [{ root: 'root-b', run: 'run-b', plan: '' }] },
  }
  let activeRun = 'a', resolveOldState, announceOldState
  const oldStateStarted = new Promise(resolve => { announceOldState = resolve })
  const pendingOldState = new Promise(resolve => { resolveOldState = resolve })
  ui.run('fetch = inputFetch', { inputFetch: (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/runs') return Promise.resolve({ ok: true, json: async () => runs[activeRun] })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-a') {
      return Promise.resolve({ ok: true, json: () => { announceOldState(); return pendingOldState } })
    }
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => newState })
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => ({ events: [{ id: 'run-b-event' }], next: 1, total: 1, complete: true, revision: 'rev-b' }) })
    throw new Error(`Unexpected request: ${url}`)
  } })

  ui.run("SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; TICK_GENERATION = 1")
  const oldTick = ui.run('tick(1)')
  await oldStateStarted

  activeRun = 'b'
  ui.run("SELECTED_ROOT = 'root-b'; SELECTED_RUN = 'run-b'; TICK_GENERATION = 2; resetEventHistory()")
  await ui.run('tick(2)')
  assert.equal(ui.run('STATE.run'), 'run-b')
  assert.equal(ui.run('EVENT_HISTORY_KEY'), 'root-b\u0000run-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'run-b-event' }])
  assert.equal(ui.run('EVENTS_COMPLETE'), true)

  resolveOldState(oldState)
  await oldTick
  assert.equal(ui.run('STATE.run'), 'run-b', 'the stale state body cannot repaint run A over run B')
  assert.equal(ui.run('EVENT_HISTORY_KEY'), 'root-b\u0000run-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'run-b-event' }])
  assert.equal(ui.run('EVENT_HISTORY_REVISION'), 'rev-b')
  assert.equal(ui.run('EVENTS_COMPLETE'), true)
  assert.equal(ui.nodes.get('#runName').textContent, 'run-b')
})

test('a late runs catalog cannot move the header back to a previous run', async () => {
  const ui = dashboard()
  const oldState = { run: 'run-a', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  const newState = { run: 'run-b', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  const runs = {
    a: { currentRoot: 'root-a', current: 'run-a', runs: [{ root: 'root-a', run: 'run-a', plan: '' }] },
    b: { currentRoot: 'root-b', current: 'run-b', runs: [{ root: 'root-b', run: 'run-b', plan: '' }] },
  }
  let activeRun = 'a', resolveOldRuns, announceOldRuns
  const oldRunsStarted = new Promise(resolve => { announceOldRuns = resolve })
  const pendingOldRuns = new Promise(resolve => { resolveOldRuns = resolve })
  ui.run('fetch = inputFetch', { inputFetch: (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/runs' && activeRun === 'a')
      return Promise.resolve({ ok: true, json: () => { announceOldRuns(); return pendingOldRuns } })
    if (url.pathname === '/api/runs') return Promise.resolve({ ok: true, json: async () => runs.b })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-a')
      return Promise.resolve({ ok: true, json: async () => oldState })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => newState })
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => ({ events: [{ id: 'run-b-event' }], next: 1, total: 1, complete: true, revision: 'rev-b' }) })
    throw new Error(`Unexpected request: ${url}`)
  } })

  ui.run("SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; TICK_GENERATION = 1")
  const oldTick = ui.run('tick(1)')
  await oldRunsStarted
  activeRun = 'b'
  ui.run("SELECTED_ROOT = 'root-b'; SELECTED_RUN = 'run-b'; TICK_GENERATION = 2; resetEventHistory()")
  await ui.run('tick(2)')
  assert.equal(ui.nodes.get('#runName').textContent, 'run-b')

  resolveOldRuns(runs.a)
  await oldTick
  assert.equal(ui.nodes.get('#runName').textContent, 'run-b', 'the previous catalog cannot repaint the run selector')
  assert.equal(ui.run('STATE.run'), 'run-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'run-b-event' }])
  assert.equal(ui.run('EVENTS_COMPLETE'), true)
})

test('late result events from run A cannot replace results for run B', async () => {
  const ui = dashboard()
  const stateA = { run: 'run-a', createdAt: instant(0), plan: { phases: [] },
    tasks: { A: task('A', 'done') }, derived: { A: { effective: 'done' } } }
  const stateB = { run: 'run-b', createdAt: instant(0), plan: { phases: [] },
    tasks: { B: task('B', 'done') }, derived: { B: { effective: 'done' } } }
  let resolveEventsA, announceEventsA
  const eventsAStarted = new Promise(resolve => { announceEventsA = resolve })
  const pendingEventsA = new Promise(resolve => { resolveEventsA = resolve })
  let eventsBStarted
  const eventsBLoaded = new Promise(resolve => { eventsBStarted = resolve })
  ui.run('fetch = inputFetch', { inputFetch: (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-a')
      return Promise.resolve({ ok: true, json: () => { announceEventsA(); return pendingEventsA } })
    if (url.pathname === '/api/runs')
      return Promise.resolve({ ok: true, json: async () => ({ currentRoot: 'root-b', current: 'run-b', runs: [{ root: 'root-b', run: 'run-b', plan: '' }] }) })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => stateB })
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => {
        eventsBStarted()
        return { events: [{ id: 'run-b-event' }], next: 1, total: 1, complete: true, revision: 'rev-b' }
      } })
    throw new Error(`Unexpected request: ${url}`)
  } })
  ui.run("STATE = input; SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; CURRENT_ROOT = 'root-a'; CURRENT_RUN = 'run-a'; TICK_GENERATION = 1; STATE_RUN_KEY = 'root-a\\0run-a'; EVENT_HISTORY_KEY = STATE_RUN_KEY; EVENTS_COMPLETE = true; RESULTS_OPEN = true; renderResults(STATE)", { input: stateA })
  const oldResults = ui.run('loadResults()')
  await eventsAStarted

  ui.run("selectRun('root-b/run-b')")
  await eventsBLoaded
  for (let tries = 0; tries < 60 && ui.run("STATE?.run !== 'run-b' || !EVENTS_COMPLETE || !$('#results').innerHTML.includes('run-b')"); tries++)
    await Promise.resolve()
  assert.equal(ui.run('STATE.run'), 'run-b')
  assert.match(ui.nodes.get('#results').innerHTML, /data-results-run="run-b"/)

  resolveEventsA({ events: [{ id: 'stale-run-a-event' }], next: 1, total: 1, complete: true, revision: 'rev-a' })
  await oldResults
  assert.match(ui.nodes.get('#results').innerHTML, /data-results-run="run-b"/)
  assert.doesNotMatch(ui.nodes.get('#results').innerHTML, /data-results-run="run-a"|stale-run-a-event/)
  assert.equal(ui.run('EVENT_HISTORY_KEY'), 'root-b\u0000run-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'run-b-event' }])
})

test('opening results while the selected run state is still loading never shows the previous run', async () => {
  const ui = dashboard()
  const stateA = { run: 'run-a', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  const stateB = { run: 'run-b', createdAt: instant(0), plan: { phases: [] },
    tasks: { B: task('B', 'done') }, derived: { B: { effective: 'done' } } }
  let resolveStateB, announceStateB
  const stateBStarted = new Promise(resolve => { announceStateB = resolve })
  const pendingStateB = new Promise(resolve => { resolveStateB = resolve })
  let eventsBRequests = 0
  ui.run('fetch = inputFetch', { inputFetch: (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/runs')
      return Promise.resolve({ ok: true, json: async () => ({ currentRoot: 'root-b', current: 'run-b', runs: [{ root: 'root-b', run: 'run-b', plan: '' }] }) })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: () => { announceStateB(); return pendingStateB } })
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-b') {
      eventsBRequests++
      return Promise.resolve({ ok: true, json: async () => ({ events: [{ id: 'run-b-event' }], next: 1, total: 1, complete: true, revision: 'rev-b' }) })
    }
    throw new Error(`Unexpected request: ${url}`)
  } })
  ui.run("STATE = input; SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; CURRENT_ROOT = 'root-a'; CURRENT_RUN = 'run-a'; TICK_GENERATION = 1; STATE_RUN_KEY = 'root-a\\0run-a'; EVENT_HISTORY_KEY = STATE_RUN_KEY; EVENTS_COMPLETE = true; renderResults(STATE)", { input: stateA })
  ui.run("selectRun('root-b/run-b')")
  await stateBStarted

  await ui.run('toggleResults()')
  assert.equal(ui.run('RESULTS_OPEN'), true)
  assert.equal(ui.nodes.get('#results').innerHTML, '')
  assert.equal(ui.nodes.get('#results').getAttribute('aria-busy'), 'true')
  assert.equal(eventsBRequests, 0, 'events are not fetched against the old state')

  resolveStateB(stateB)
  for (let tries = 0; tries < 60 && ui.run("STATE?.run !== 'run-b' || !EVENTS_COMPLETE || !$('#results').innerHTML.includes('run-b')"); tries++)
    await Promise.resolve()
  assert.equal(ui.run('STATE.run'), 'run-b')
  assert.match(ui.nodes.get('#results').innerHTML, /data-results-run="run-b"/)
  assert.equal(ui.nodes.get('#results').getAttribute('aria-busy'), 'false')
})

test('resultados limpam quando a selecao muda durante a sincronizacao do historico', async () => {
  const ui = dashboard()
  let reads = 0
  const state = new Proxy({}, {
    get(target, property, receiver) {
      if (property === 'run') return reads++ === 0 ? 'run-a' : 'run-b'
      return Reflect.get(target, property, receiver)
    },
  })
  ui.run('fetch = inputFetch', { inputFetch: async () => ({ ok: true, json: async () => ({ events: [], next: 0, total: 0, complete: true, revision: 'rev-a' }) }) })
  ui.run("STATE = input; SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; CURRENT_ROOT = 'root-a'; CURRENT_RUN = 'run-a'; TICK_GENERATION = 1; STATE_RUN_KEY = 'root-a\\0run-a'; EVENT_HISTORY_KEY = STATE_RUN_KEY; RESULTS_OPEN = true", { input: state })
  await ui.run('loadResults()')
  assert.equal(ui.nodes.get('#results').getAttribute('aria-busy'), 'true')
  assert.equal(ui.nodes.get('#results').innerHTML, '')
  assert.equal(reads, 2)
})

test('tick repinta o ganho sem campos editáveis; ao trocar de run, limpa A e exibe B', async () => {
  const ui = dashboard()
  const makeRun = (run, id) => ({
    run, createdAt: instant(0), plan: { phases: [] },
    tasks: { [id]: task(id, 'done', {
      attempts: [{ n: 1, startedAt: instant(0), endedAt: instant(10) }],
      validations: [{ by: 'review', at: instant(15) }],
    }) },
    derived: { [id]: { effective: 'done' } },
  })
  const stateA = makeRun('run-a', 'A')
  const stateB = makeRun('run-b', 'B')
  ui.run('fetch = inputFetch', { inputFetch: (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/runs')
      return Promise.resolve({ ok: true, json: async () => ({ currentRoot: 'root-b', current: 'run-b', runs: [{ root: 'root-b', run: 'run-b', plan: '' }] }) })
    if (url.pathname === '/api/state' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => stateB })
    if (url.pathname === '/api/events' && url.searchParams.get('root') === 'root-b')
      return Promise.resolve({ ok: true, json: async () => ({ events: [{ id: 'run-b-event' }], next: 1, total: 1, complete: true, revision: 'rev-b' }) })
    throw new Error('Requisição inesperada: ' + url)
  } })
  ui.run("STATE = input; SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; CURRENT_ROOT = 'root-a'; CURRENT_RUN = 'run-a'; TICK_GENERATION = 1; STATE_RUN_KEY = 'root-a\\0run-a'; EVENT_HISTORY_KEY = STATE_RUN_KEY; EVENTS_COMPLETE = true; RESULTS_OPEN = true; renderResults(STATE)", { input: stateA })
  const previousMarkup = ui.nodes.get('#results').innerHTML
  assert.doesNotMatch(previousMarkup, /<input|data-gain-minutes|gain-input/, 'o cartão de ganho não tem minutos editáveis')

  await ui.run('loadResults(true)')
  assert.equal(ui.nodes.get('#results').innerHTML, previousMarkup, 'o mesmo estado repinta o mesmo cartão')

  ui.run("selectRun('root-b/run-b')")
  assert.equal(ui.nodes.get('#results').innerHTML, '')
  assert.equal(ui.nodes.get('#results').getAttribute('aria-busy'), 'true')
  assert.equal(ui.run('STATE'), null)
  for (let tries = 0; tries < 60 && ui.run("STATE?.run !== 'run-b' || !EVENTS_COMPLETE || !$('#results').innerHTML.includes('data-results-run=\"run-b\"')"); tries++)
    await Promise.resolve()
  assert.equal(ui.run('STATE.run'), 'run-b')
  assert.match(ui.nodes.get('#results').innerHTML, /data-results-run="run-b"/)
  assert.doesNotMatch(ui.nodes.get('#results').innerHTML, /data-results-run="run-a"|data-run="A"/)
})
test('closing results while event history is pending prevents a late repaint', async () => {
  const ui = dashboard()
  const state = { run: 'run-a', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  let resolvePage, announcePage
  const pageStarted = new Promise(resolve => { announcePage = resolve })
  const pendingPage = new Promise(resolve => { resolvePage = resolve })
  ui.run('fetch = inputFetch', { inputFetch: () => Promise.resolve({
    ok: true, json: () => { announcePage(); return pendingPage },
  }) })
  ui.run("STATE = input; TICK_GENERATION = 1; STATE_RUN_KEY = 'root-a\\0run-a'; EVENT_HISTORY_KEY = STATE_RUN_KEY; EVENTS_COMPLETE = true; RESULTS_OPEN = true; renderResults(STATE)", { input: state })
  const pendingResults = ui.run('loadResults()')
  await pageStarted
  await ui.run('toggleResults()')
  assert.equal(ui.run('RESULTS_OPEN'), false)
  ui.nodes.get('#results').innerHTML = 'closed-tab marker'
  resolvePage({ events: [{ id: 'late' }], next: 1, total: 1, complete: true, revision: 'rev-a' })
  await pendingResults
  assert.equal(ui.nodes.get('#results').innerHTML, 'closed-tab marker')
})

test('unchanged inactive plans skip rendering while new events and active clocks still refresh', async () => {
  const ui = dashboard()
  const state = { run: 'run-a', createdAt: instant(0), plan: { phases: [] }, tasks: { A: task('A', 'done') }, derived: {} }
  let history = { events: [], next: 0, total: 0, complete: true, revision: 'one' }
  ui.run("SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; TICK_GENERATION = 1; let paints = 0; const realRender = render; render = (...args) => { paints++; return realRender(...args) }; fetch = inputFetch", {
    inputFetch: async url => ({ ok: true, json: async () => String(url).includes('/api/runs')
      ? { currentRoot: 'root-a', current: state.run, runs: [] }
      : String(url).includes('/api/events') ? history : state }),
  })
  await ui.run('tick(1)')
  await ui.run('tick(1)')
  assert.equal(ui.run('paints'), 1, 'unchanged inactive data must not redraw the graph')
  history = { events: [{ type: 'task_note', task: 'A', at: instant(30), note: 'New evidence' }], next: 1, total: 1, complete: true, revision: 'two', reset: true }
  await ui.run('tick(1)')
  assert.equal(ui.run('paints'), 2, 'an event must refresh even when the task state is unchanged')
  state.tasks.A.state = 'running'
  await ui.run('tick(1)')
  await ui.run('tick(1)')
  assert.equal(ui.run('paints'), 4, 'active clocks keep refreshing between state changes')
})

test('hidden dashboards stop polling and refresh immediately when visible again', async () => {
  const ui = dashboard()
  const state = { run: 'run-a', createdAt: instant(0), plan: { phases: [] }, tasks: {}, derived: {} }
  let requests = 0
  ui.run("document.hidden = true; SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; TICK_GENERATION = 1; fetch = inputFetch", {
    inputFetch: async url => { requests++; return { ok: true, json: async () => String(url).includes('/api/runs')
      ? { currentRoot: 'root-a', current: state.run, runs: [] }
      : String(url).includes('/api/events') ? { events: [], next: 0, total: 0, complete: true, revision: 'one' } : state } },
  })
  await ui.run('tick(1)')
  assert.equal(requests, 0)
  ui.dispatchDocument('visibilitychange')
  assert.equal(ui.run("document.documentElement.classList.contains('page-paused')"), true)
  ui.run('document.hidden = false')
  ui.dispatchDocument('visibilitychange')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(requests >= 3, 'returning to the dashboard immediately fetches state, catalog and events')
  assert.equal(ui.run('STATE.run'), 'run-a')
  assert.equal(ui.run("document.documentElement.classList.contains('page-paused')"), false)
})

test('a changed event revision replaces the cached browser history from its first page', async () => {
  const ui = dashboard()
  const responses = [
    { events: [{ id: 'old-run' }], next: 1, total: 1, complete: true, revision: 'rev-a' },
    { events: [{ id: 'new-run-1' }], next: 1, total: 2, complete: false, reset: true, revision: 'rev-b' },
    { events: [{ id: 'new-run-2' }], next: 2, total: 2, complete: true, revision: 'rev-b' },
  ]
  ui.run('fetch = inputFetch', { inputFetch: async () => ({ ok: true, json: async () => responses.shift() }) })
  ui.run("TICK_GENERATION = 1; resetEventHistory('root/run-a')")
  assert.equal(await ui.run("syncEventHistory(1, 'root/run-a')"), true)
  assert.equal(ui.run('EVENT_HISTORY_REVISION'), 'rev-a')
  assert.equal(await ui.run("syncEventHistory(1, 'root/run-a')"), false, 'revision change restarts at the first page and waits for the next page')
  assert.equal(ui.run('EVENT_HISTORY_REVISION'), 'rev-b')
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'new-run-1' }])
  assert.equal(await ui.run("syncEventHistory(1, 'root/run-a')"), true)
  assert.deepEqual(JSON.parse(ui.run('JSON.stringify(FULL_EVENTS)')), [{ id: 'new-run-1' }, { id: 'new-run-2' }])
})

test('historico interrompe apos o limite de paginas sem fingir que terminou', async () => {
  const ui = dashboard()
  const responses = Array.from({ length: 10 }, (_, index) => ({
    events: [{ id: `page-${index}` }], next: index + 1, total: 20, complete: false, revision: 'long-history',
  }))
  ui.run('fetch = inputFetch', { inputFetch: async () => ({ ok: true, json: async () => responses.shift() }) })
  ui.run("TICK_GENERATION = 1; resetEventHistory('root/run-long')")
  assert.equal(await ui.run("syncEventHistory(1, 'root/run-long')"), false)
  assert.equal(ui.run('EVENT_OFFSET'), 10)
  assert.equal(ui.run('FULL_EVENTS.length'), 10)
})

test('relogio de tarefa preserva planejamento nao aferido e mede discussoes execucao e revisao', () => {
  const ui = dashboard()
  const planning = task('P', 'planning', { planningAttempts: [{ startedAt: instant(1), endedAt: instant(2) }] })
  const discussing = task('D', 'discussing', { discussionAttempts: [{ attempt: 1, startedAt: instant(1) }] })
  const running = task('R', 'running', { attempts: [{ n: 1, startedAt: instant(1), endedAt: instant(3) }] })
  const reviewing = task('V', 'reviewing', { attempts: [{ n: 1, startedAt: instant(1), reviewStartedAt: instant(1), endedAt: instant(3) }] })
  const events = [
    { type: 'task_discussion', task: 'D', attempt: 1, at: instant(1) },
    { type: 'task_discussed', task: 'D', attempt: 1, at: instant(2) },
    { type: 'task_start', task: 'R', attempt: 1, at: instant(1) },
    { type: 'task_progress', task: 'R', attempt: 1, at: instant(2) },
    { type: 'task_review_progress', task: 'V', attempt: 1, at: instant(2) },
  ]
  ui.run('EVENTS_COMPLETE = true')
  assert.equal(ui.run('taskClock(input, "planning", inputEvents)', { input: planning, inputEvents: events }), null)
  assert.equal(ui.run('taskClock(input, "discussing", inputEvents)', { input: discussing, inputEvents: events }), 1000)
  assert.equal(ui.run('taskClock(input, "running", inputEvents)', { input: running, inputEvents: events }), 1000)
  assert.equal(ui.run('taskClock(input, "reviewing", inputEvents)', { input: reviewing, inputEvents: events }), 1000)
})

test('helpers do relogio inline somam apenas atividade comprovada e excluem pausas e lacunas', () => {
  const ui = dashboard()
  const call = (code, values = {}) => ui.run(code, values)
  const start = Date.parse(instant(0)), end = start + 2000
  assert.deepEqual(call('activeSegments(NaN, 10)'), [])
  assert.deepEqual(call('activeSegments(0, 10, null)'), [[0, 10]])
  assert.deepEqual(call('activeSegments(0, 50, inputPauses)', { inputPauses: [
    [10, 20], [15, 30], [0, 5], [40, 60], [NaN, 44], [7, 7],
  ] }), [[5, 10], [30, 40]])
  assert.deepEqual(call('splitMeasuredActivity(0, MAX_ACTIVITY_GAP_MS + 1, null, null)'), {
    measured: [], unknown: [[0, 1_800_001]],
  })
  assert.deepEqual(call('splitMeasuredActivity(0, MAX_ACTIVITY_GAP_MS * 2, [MAX_ACTIVITY_GAP_MS], [])'), {
    measured: [[0, 1_800_000], [1_800_000, 3_600_000]], unknown: [],
  })

  const activityEvents = [
    { task: 'T', type: 'task_start', at: instant(0) },
    { task: 'T', type: 'task_start', attempt: 1, at: instant(0) },
    { task: 'T', type: 'task_start', attempt: 2, at: instant(1) },
    { task: 'other', type: 'task_start', at: instant(1) },
    { task: 'T', type: 'task_unblock', state: 'running', at: instant(2) },
    { task: 'T', type: 'task_unblock', state: 'pending', at: instant(1) },
    { task: 'T', type: 'task_start', at: 'invalid' },
  ]
  assert.deepEqual(call('activityTimes("T", 1, null, ["task_start"], inputStart, inputEnd)', { inputStart: start, inputEnd: end }), [])
  assert.deepEqual(call('activityTimes("T", 1, inputEvents, ["task_start", "task_unblock"], inputStart, inputEnd)', {
    inputEvents: activityEvents, inputStart: start, inputEnd: end,
  }), [start, end])

  const pauseEvents = [
    { task: 'other', type: 'task_block', at: instant(0) },
    { task: 'T', type: 'task_block', at: 'invalid' },
    { task: 'T', type: 'task_block', at: instant(0) },
    { task: 'T', type: 'task_block', at: instant(1) },
    { task: 'T', type: 'task_unblock', at: instant(5) },
    { task: 'T', type: 'task_planned', state: 'blocked', at: instant(10) },
    { task: 'T', type: 'task_done', at: instant(10) },
    { task: 'T', type: 'task_block', at: instant(20) },
  ]
  assert.deepEqual(call('taskPauses("T", null, inputNow)', { inputNow: end }), [])
  assert.deepEqual(call('taskPauses("T", inputEvents, inputNow)', {
    inputEvents: pauseEvents, inputNow: Date.parse(instant(30)),
  }), [[start, Date.parse(instant(5))], [Date.parse(instant(20)), Date.parse(instant(30))]])

  const taskEvents = [
    { task: 'other', type: 'task_start', at: instant(1) },
    { task: 'T', type: 'task_start', attempt: 2, at: instant(1) },
    { task: 'T', type: 'task_unblock', state: 'pending', at: instant(1) },
    { task: 'T', type: 'task_start', at: 'invalid' },
    { task: 'T', type: 'task_start', at: instant(2) },
    { task: 'T', type: 'task_start', attempt: 1, at: instant(1) },
  ]
  assert.equal(call('latestTaskActivity("T", 1, "unknown", null)'), null)
  assert.equal(call('latestTaskActivity("T", 1, "running", inputEvents)', { inputEvents: taskEvents }), Date.parse(instant(2)))
  assert.equal(call('latestReviewReceipt(inputTask, 1, inputStart, inputEnd)', {
    inputTask: { validations: null }, inputStart: start, inputEnd: end,
  }), null)
  assert.equal(call('latestReviewReceipt(inputTask, 1, inputStart, inputEnd)', {
    inputTask: { validations: [
      { by: 'executor', at: instant(2) }, { by: 'review', attempt: 2, at: instant(2) },
      { by: 'review', at: 'invalid' }, { by: 'review', at: instant(0) }, { by: 'review', attempt: 1, at: instant(2) },
    ] }, inputStart: start, inputEnd: end,
  }), end)
  assert.equal(call('latestReviewActivity(inputTask, 1, inputStart, inputEnd, null)', {
    inputTask: { id: 'T' }, inputStart: start, inputEnd: end,
  }), null)
  assert.equal(call('latestReviewActivity(inputTask, 1, inputStart, inputEnd, inputEvents)', {
    inputTask: { id: 'T' }, inputStart: start, inputEnd: end,
    inputEvents: [
      { task: 'other', type: 'task_review_progress', at: instant(1) },
      { task: 'T', type: 'task_review_progress', attempt: 2, at: instant(1) },
      { task: 'T', type: 'task_review_progress', at: 'invalid' },
      { task: 'T', type: 'task_review_progress', at: instant(2) },
    ],
  }), end)

  const running = task('R', 'running', { attempts: [{ n: 1, startedAt: instant(0), endedAt: instant(1) }] })
  const discussion = task('D', 'discussing', { discussionAttempts: [{ startedAt: instant(0) }] })
  assert.equal(call('taskClock(inputTask, "unknown", [])', { inputTask: task('U') }), null)
  assert.equal(call('taskClock(inputTask, "running", inputEvents)', {
    inputTask: running, inputEvents: [{ task: 'R', type: 'task_start', at: instant(0) }],
  }), null)
  assert.equal(call('taskClock(inputTask, "discussing", inputEvents)', {
    inputTask: discussion, inputEvents: [
      { task: 'D', type: 'task_discussion', attempt: 1, at: instant(0) },
      { task: 'D', type: 'task_discussed', attempt: 1, at: instant(1) },
    ],
  }), 1000)
  assert.equal(call('subState(inputTask)', { inputTask: task('R', 'running', { attempts: [{}], validations: [{ attempt: 1, ok: true }] }) }), 'validated')
  assert.equal(call('subState(inputTask)', { inputTask: task('R', 'running', { attempts: [{}], validations: [{ attempt: 1, ok: false }] }) }), 'valfail')
  assert.equal(call('fmtMs(input)', { input: null }), '—')
  assert.equal(call('fmtMs(input)', { input: 30_000 }), '30s')
  assert.equal(call('fmtMs(input)', { input: 60_000 }), '1m00')
  assert.equal(call('fmtMs(input)', { input: 3_600_000 }), '1h00')
})

test('115h task planning envelopes stay unmeasured and cannot inflate the critical path', () => {
  const waitSeconds = 115 * 3600 + 23 * 60
  const planStart = instant(100 - waitSeconds)
  const taskValue = task('P', 'done', {
    planningAttempts: [{ startedAt: planStart, endedAt: instant(95) }],
    attempts: [{ n: 1, startedAt: instant(95), endedAt: instant(100) }],
  })
  const state = { run: 'task-plan-envelope', createdAt: planStart, plan: {}, tasks: { P: taskValue },
    derived: { P: { effective: 'done' } } }
  const events = [
    { type: 'task_start', task: 'P', attempt: 1, at: instant(95) },
    { type: 'task_progress', task: 'P', attempt: 1, at: instant(100) },
    { type: 'task_done', task: 'P', attempt: 1, at: instant(100) },
  ]
  const ui = dashboard('pt-BR')
  const result = ui.run('analyse(input, inputEvents, true)', { input: state, inputEvents: events })
  assert.equal(result.planningTotal, 0)
  assert.equal(result.execTotal, 5000)
  assert.equal(result.agentTotal, 5000)
  assert.equal(result.planningMeasured, false)
  assert.equal(result.criticalPathMeasured, false)
  assert.equal(result.per[0].unmeasured, true)
  ui.render(state, events)
  const graph = ['#orch', '#doneCount', '#nodes', '#parallel'].map(selector => ui.nodes.get(selector).innerHTML).join('\n')
  assert.match(graph, /concluída[\s\S]*00:00:05/i)
  assert.match(graph, /não aferido/)
  assert.doesNotMatch(ui.nodes.get('#doneCount').innerHTML, /não aferido|00:00:05/)
  assert.doesNotMatch(graph, /115h|115:23|415390s/)
  ui.run('FULL_EVENTS = inputEvents; renderResults(input)', { input: state, inputEvents: events })
  const results = ui.nodes.get('#results').innerHTML
  assert.match(results, /períodos não aferidos ficam fora/)
  assert.doesNotMatch(results, /Caminho crítico|115h|115:23|415390s/, 'an unmeasured critical path is not shown')
  ui.run("POP = { id: 'P', pinned: true }; POP_EXPANDED = false; fillPop('P')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /Agent time[\s\S]*· 5s · não aferido/)
  assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, /115h|115:23|415390s/)
})

test('review time ends at the last validation receipt even when done arrives 115h later', () => {
  const waitSeconds = 115 * 3600 + 23 * 60
  const startSeconds = 100 - waitSeconds - 10
  const reviewAt = startSeconds + 5
  const receiptAt = startSeconds + 10
  const events = [
    { type: 'task_start', task: 'A', attempt: 1, at: instant(startSeconds) },
    { type: 'task_review', task: 'A', attempt: 1, at: instant(reviewAt) },
    { type: 'task_review_progress', task: 'A', attempt: 1, at: instant(receiptAt) },
    { type: 'task_validate', task: 'A', attempt: 1, by: 'review', ok: true, at: instant(receiptAt) },
    { type: 'task_done', task: 'A', attempt: 1, at: instant(100) },
  ]
  const value = task('A', 'done', { phase: 'F0', attempts: [{ n: 1, startedAt: instant(startSeconds), reviewStartedAt: instant(reviewAt), endedAt: instant(100) }],
    validations: [{ by: 'review', attempt: 1, ok: true, at: instant(receiptAt) }] })
  const state = { run: 'review-wait', createdAt: instant(startSeconds), plan: {}, tasks: { A: value }, derived: { A: { effective: 'done', blockedBy: [] } } }
  const ui = dashboard('pt-BR')
  const result = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
  assert.equal(result.execTotal, 5000)
  assert.equal(result.reviewTotal, 5000)
  assert.equal(result.agentTotal, 10000)
  assert.equal(result.activeElapsed, 10000)
  assert.equal(result.cpLen, 10000)
  assert.equal(result.criticalPathMeasured, false, 'the 115h tail after the last reviewer activity stays unknown')
  ui.render(state, events)
  ui.run('FULL_EVENTS = inputEvents; renderResults(STATE)', { inputEvents: events })
  const results = ui.nodes.get('#results').innerHTML
  assert.match(results, /10s/)
  assert.doesNotMatch(results, /115h|76h|192h|115:23|24h/)
})

test('large gaps between activity milestones are unknown and never counted as agent time', () => {
  const waitSeconds = 115 * 3600 + 23 * 60
  const startSeconds = 100 - waitSeconds - 10
  const endSeconds = 100
  const cases = [
    {
      name: 'late execution milestone',
      events: [
        { type: 'task_start', task: 'E', attempt: 1, at: instant(startSeconds) },
        { type: 'task_progress', task: 'E', attempt: 1, at: instant(startSeconds + waitSeconds + 5) },
        { type: 'task_done', task: 'E', attempt: 1, at: instant(endSeconds) },
      ],
      value: task('E', 'done', { attempts: [{ n: 1, startedAt: instant(startSeconds), endedAt: instant(endSeconds) }] }),
      expected: 0,
    },
    {
      name: 'late review start',
      events: [
        { type: 'task_start', task: 'E', attempt: 1, at: instant(startSeconds) },
        { type: 'task_review', task: 'E', attempt: 1, at: instant(startSeconds + waitSeconds + 5) },
        { type: 'task_review_progress', task: 'E', attempt: 1, at: instant(endSeconds - 1) },
        { type: 'task_validate', task: 'E', attempt: 1, by: 'review', at: instant(endSeconds) },
        { type: 'task_done', task: 'E', attempt: 1, at: instant(endSeconds) },
      ],
      value: task('E', 'done', { attempts: [{ n: 1, startedAt: instant(startSeconds), reviewStartedAt: instant(startSeconds + waitSeconds + 5), endedAt: instant(endSeconds) }],
        validations: [{ by: 'review', attempt: 1, ok: true, at: instant(endSeconds) }] }),
      expected: 4000,
    },
    {
      name: 'late review progress',
      events: [
        { type: 'task_start', task: 'E', attempt: 1, at: instant(startSeconds) },
        { type: 'task_review', task: 'E', attempt: 1, at: instant(startSeconds + 5) },
        { type: 'task_review_progress', task: 'E', attempt: 1, at: instant(startSeconds + waitSeconds + 5) },
        { type: 'task_validate', task: 'E', attempt: 1, by: 'review', at: instant(endSeconds) },
        { type: 'task_done', task: 'E', attempt: 1, at: instant(endSeconds) },
      ],
      value: task('E', 'done', { attempts: [{ n: 1, startedAt: instant(startSeconds), reviewStartedAt: instant(startSeconds + 5), endedAt: instant(endSeconds) }],
        validations: [{ by: 'review', attempt: 1, ok: true, at: instant(endSeconds) }] }),
      expected: 5000,
    },
    {
      name: 'late validation receipt without review progress',
      events: [
        { type: 'task_start', task: 'E', attempt: 1, at: instant(startSeconds) },
        { type: 'task_review', task: 'E', attempt: 1, at: instant(startSeconds + 5) },
        { type: 'task_validate', task: 'E', attempt: 1, by: 'review', at: instant(endSeconds) },
        { type: 'task_done', task: 'E', attempt: 1, at: instant(endSeconds) },
      ],
      value: task('E', 'done', { attempts: [{ n: 1, startedAt: instant(startSeconds), reviewStartedAt: instant(startSeconds + 5), endedAt: instant(endSeconds) }],
        validations: [{ by: 'review', attempt: 1, ok: true, at: instant(endSeconds) }] }),
      expected: 5000,
    },
  ]
  for (const item of cases) {
    const state = { run: item.name, createdAt: instant(startSeconds), plan: {}, tasks: { E: item.value }, derived: { E: { effective: 'done' } } }
    const ui = dashboard('pt-BR')
    const metrics = ui.run('analyse(input, inputEvents, true)', { input: state, inputEvents: item.events })
    assert.equal(metrics.agentTotal, item.expected, item.name)
    assert.equal(metrics.per[0].unmeasured, true, item.name)
    assert.equal(metrics.criticalPathMeasured, false, item.name)
    ui.render(state, item.events)
    ui.run('FULL_EVENTS = inputEvents; renderResults(STATE); POP = { id: "E", pinned: true }; POP_EXPANDED = true; fillPop("E")',
      { inputEvents: item.events })
    const visible = ['#orch', '#doneCount', '#parallel', '#nodes', '#results', '#popBody']
      .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
    assert.doesNotMatch(visible, /115h|115:23|415390s/, item.name)
    assert.match(ui.nodes.get('#popBody').innerHTML, /Agent time[\s\S]*não aferido/, item.name)
    if (item.expected === 0) assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, />0s</, item.name)
  }
})

test('switching runs clears the previous graph and exposes a loading state until the new run paints', () => {
  const ui = dashboard('pt-BR')
  const stateA = { run: 'run-a', createdAt: instant(0), plan: {}, tasks: { A: task('A', 'done') }, derived: { A: { effective: 'done' } } }
  const stateB = { run: 'run-b', createdAt: instant(0), plan: {}, tasks: { B: task('B', 'done') }, derived: { B: { effective: 'done' } } }
  ui.render(stateA)
  ui.run("SELECTED_ROOT = 'root-a'; SELECTED_RUN = 'run-a'; CURRENT_ROOT = 'root-a'; CURRENT_RUN = 'run-a'")
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-id="A"/)

  ui.run("selectRun('root-b/run-b')")
  assert.equal(ui.nodes.get('#nodes').innerHTML, '')
  assert.equal(ui.nodes.get('#lanes').innerHTML, '')
  assert.equal(ui.nodes.get('#runLoading').hidden, false)
  assert.equal(ui.nodes.get('#runLoadingStatus').hidden, false)
  assert.equal(ui.nodes.get('#main').inert, true)
  assert.equal(ui.nodes.get('#main').getAttribute('aria-busy'), 'true')
  assert.ok(html.indexOf('id="runLoadingStatus"') < html.indexOf('<main id="main">'), 'the live loading status remains outside the inert main')
  assert.equal(ui.nodes.get('#runName').textContent, 'run-b')
  assert.doesNotMatch(ui.nodes.get('#parallel').innerHTML + ui.nodes.get('#events').innerHTML, /run-a|A/)

  ui.run('STATE = stateB; STATE_RUN_KEY = "root-b\\0run-b"; render(STATE, [])', { stateB })
  assert.match(ui.nodes.get('#nodes').innerHTML, /data-id="B"/)
  assert.equal(ui.nodes.get('#runLoading').hidden, true)
  assert.equal(ui.nodes.get('#runLoadingStatus').hidden, true)
  assert.equal(ui.nodes.get('#main').inert, false)
  assert.equal(ui.nodes.get('#viewport').getAttribute('aria-busy'), 'false')
})

test('open execution without progress telemetry stays unmeasured in every visible surface', () => {
  const elapsedSeconds = 115 * 3600 + 23 * 60
  const start = instant(100 - elapsedSeconds)
  const events = [{ type: 'task_start', task: 'A', attempt: 1, at: start }]
  const value = task('A', 'running', { attempts: [{ n: 1, startedAt: start }] })
  const state = { run: 'no-progress', createdAt: start, plan: {}, tasks: { A: value },
    derived: { A: { effective: 'running', blockedBy: [] } } }
  const ui = dashboard('pt-BR')
  ui.render(state, events)
  const metrics = ui.run('analyse(input, inputEvents)', { input: state, inputEvents: events })
  assert.equal(metrics.agentTotal, 0)
  assert.equal(metrics.activeElapsed, 0)
  assert.equal(metrics.cpLen, 0)
  assert.equal(metrics.per[0].unmeasured, true)
  const graph = ['#doneCount', '#lanes', '#nodes', '#parallel', '#orch']
    .map((selector) => ui.nodes.get(selector).innerHTML + ui.nodes.get(selector).textContent).join('\n')
  assert.match(graph, /não aferido/)
  assert.doesNotMatch(graph, /115h|76h|192h|115:23|24h/)
  ui.run('FULL_EVENTS = inputEvents; renderResults(STATE)', { inputEvents: events })
  assert.match(ui.nodes.get('#results').innerHTML, /Não aferido/)
  assert.doesNotMatch(ui.nodes.get('#results').innerHTML, /115h|76h|192h|115:23|24h/)
  ui.run("POP = { id: 'A', pinned: true }; POP_EXPANDED = false; fillPop('A')")
  assert.match(ui.nodes.get('#popBody').innerHTML, /não aferido/)
  assert.doesNotMatch(ui.nodes.get('#popBody').innerHTML, /115h|76h|192h|115:23|24h/)
})

test('replanning a paused attempt never counts its waiting or research as execution or review', () => {
  const ui = dashboard()
  for (const [state, replanEnd, resumed, reviewAt, expected] of [
    ['done', 60, true, null, { planning: 0, exec: 30, review: 0, blocked: 40 }],
    ['blocked', 60, false, null, { planning: 0, exec: 10, review: 0, blocked: 60 }],
    ['planning', null, false, null, { planning: 0, exec: 10, review: 0, blocked: 20 }],
    ['done', 60, true, 15, { planning: 0, exec: 5, review: 25, blocked: 40 }],
    ['blocked', 60, false, 15, { planning: 0, exec: 5, review: 5, blocked: 60 }],
    ['planning', null, false, 15, { planning: 0, exec: 5, review: 5, blocked: 20 }],
  ]) {
    const attempt = { startedAt: instant(10), ...(state === 'done' ? { endedAt: instant(100) } : {}),
      ...(reviewAt == null ? {} : { reviewStartedAt: instant(reviewAt) }) }
    const reviewReceipt = reviewAt == null ? [] : [{ by: 'review', attempt: 1, ok: true, at: instant(state === 'done' ? 100 : 20) }]
    const paused = task('T', state, { attempts: [attempt], validations: reviewReceipt,
      ...(state === 'blocked' ? { stateBeforeBlock: reviewAt == null ? 'running' : 'reviewing' } : {}),
      planningAttempts: [
        { startedAt: instant(0), endedAt: instant(10) },
        { startedAt: instant(40), ...(replanEnd == null ? {} : { endedAt: instant(replanEnd) }) },
      ], ...(state === 'planning' ? { planningReturn: { stateBeforeBlock: reviewAt == null ? 'running' : 'reviewing' } } : {}),
    })
    const events = [{ type: 'task_block', task: 'T', at: instant(20) }, { type: 'task_planning', task: 'T', at: instant(40) }]
    if (replanEnd != null) events.push({ type: 'task_planned', task: 'T', at: instant(replanEnd), state: 'blocked' })
    if (resumed) {
      events.push({ type: 'task_unblock', task: 'T', attempt: 1, at: instant(80), state: reviewAt == null ? 'running' : 'reviewing' })
      events.push({ type: reviewAt == null ? 'task_progress' : 'task_review_progress', task: 'T', attempt: 1, at: instant(100) })
    }
    if (reviewAt != null) events.push({ type: 'task_review_progress', task: 'T', attempt: 1, at: instant(20) })
    const result = ui.run('analyse(input, inputEvents)', { input: { createdAt: instant(0), plan: {}, tasks: { T: paused } }, inputEvents: events })
    for (const [key, seconds] of Object.entries(expected)) assert.equal(result.per[0][key], seconds * 1000, `${state}, reviewAt=${reviewAt}: ${key}`)
    assert.equal(result.agentTotal, (expected.planning + expected.exec + expected.review) * 1000)
    assert.equal(result.wall, 100000)
  }
})
test('task labels, summaries and plan identities stay visible across concise and historical dashboard views', () => {
  const state = graphState(1, 1)
  state.createdAt = instant(0)
  const value = state.tasks.T001
  value.title = 'Synchronize the approved card status with the customer account'
  value.label = 'Cartões'
  value.summary = 'A conta recebe o status aprovado antes da próxima compra.'
  value.validationSummary = 'A conta mostra o status de cartão aprovado.'
  value.validation = [{ run: 'node check.cjs', expect: 'The approved status appears in the account.' }]
  value.taskPlan = { ...plan, summary: 'Reuse the existing account update path.', digest: 'b'.repeat(64) }
  value.state = 'failed'
  value.attempts = [
    { n: 1, agent: 'executor-1', startedAt: instant(1), reviewStartedAt: instant(2), endedAt: instant(3),
      result: 'failed', planDigest: 'a'.repeat(64) },
    { n: 2, agent: 'executor-2', startedAt: instant(4), reviewStartedAt: instant(5), endedAt: instant(6),
      result: 'failed', planDigest: 'b'.repeat(64) },
  ]
  value.validations = [
    { by: 'review', ok: false, at: instant(3), evidence: 'Complete observation one.', summary: 'O status não atualizou no primeiro cenário.' },
    { by: 'review', ok: false, at: instant(6), evidence: 'Complete observation two.', summary: 'A conta ainda mostra o status anterior.' },
  ]
  state.derived.T001 = { effective: 'ready', blockedBy: [] }

  const ui = dashboard('pt-BR')
  ui.render(state)
  const graph = ui.nodes.get('#nodes').innerHTML
  assert.match(graph, /<span class="nt">Cartões<\/span>/)
  assert.ok(graph.includes(value.title), 'the graph tooltip retains the complete task title')
  const available = ui.nodes.get('#available').innerHTML
  assert.ok(available.includes('Cartões'))
  assert.ok(available.includes(value.summary))
  assert.ok(available.includes(value.validationSummary))
  assert.ok(available.includes(value.title), 'the available task tooltip retains the complete task title')

  ui.run("POP = { id: 'T001', pinned: true }; POP_EXPANDED = false; fillPop('T001')")
  const lean = ui.nodes.get('#popBody').innerHTML
  assert.ok(lean.includes(value.title), 'the popover keeps the full task title')
  assert.ok(lean.includes(value.summary))
  assert.ok(lean.includes(value.validationSummary))
  assert.ok(lean.includes('Plano bbbb'))
  assert.ok(lean.includes('mudou de aaaa'), 'the journey calls out a changed plan between attempts')

  ui.run("POP_EXPANDED = true; fillPop('T001')")
  const history = ui.nodes.get('#popBody').innerHTML
  assert.ok(history.includes('A conta ainda mostra o status anterior.'), 'the detail view keeps the validation summary')
  assert.ok(history.includes('Complete observation two.'), 'the detail view retains the full evidence')
})
