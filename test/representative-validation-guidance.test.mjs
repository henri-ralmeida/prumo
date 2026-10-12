import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const guidance = {
  planning: read('references/planning.md'),
  planningPtBR: read('references/planning.pt-BR.md'),
  contracts: read('references/contracts.md'),
  contractsPtBR: read('references/contracts.pt-BR.md'),
  dispatch: read('references/dispatch.md'),
  dispatchPtBR: read('references/dispatch.pt-BR.md'),
  review: read('references/review.md'),
  reviewPtBR: read('references/review.pt-BR.md'),
  closeOut: read('SKILL.md'),
}

test('uma carga grande conhecida não pode ser aprovada apenas com uma amostra pequena', () => {
  assert.match(guidance.planning, /small fixture does not cover a known large workload/)
  assert.match(guidance.planningPtBR, /amostra pequena não cobre uma carga grande conhecida/)
  assert.match(guidance.contracts, /exercise the relevant user-facing path under a representative condition/)
  assert.match(guidance.contractsPtBR, /exercitar o caminho relevante usado pela pessoa sob uma condição representativa/)
  assert.match(guidance.dispatch, /Distinguish empty state from existing persisted\s+state/)
  assert.match(guidance.dispatchPtBR, /Diferencie estado vazio de estado\s+persistido existente/)
  assert.match(guidance.review, /Reject insufficient coverage even when\s+the existing tests pass/)
  assert.match(guidance.reviewPtBR, /Reprove\s+cobertura insuficiente mesmo quando os testes existentes passarem/)
  assert.match(guidance.closeOut, /test counts are not a general guarantee/)
})

test('uma correção delimitada de baixo risco mantém validação proporcional sem carga genérica', () => {
  assert.match(guidance.planning, /bounded low-risk change does not require load testing/)
  assert.match(guidance.planningPtBR, /mudança delimitada de baixo risco não exige teste de carga/)
  assert.match(guidance.contracts, /Do not invent a performance target or require generic load/)
  assert.match(guidance.contractsPtBR, /Não invente uma meta de desempenho nem exija teste de carga/)
  assert.match(guidance.review, /bounded low-risk correction with no material scale or state risk/)
  assert.match(guidance.reviewPtBR, /correção delimitada de baixo risco sem risco material de escala ou estado/)
})

test('os READMEs apresentam os mesmos dez harnesses do guia integrado', () => {
  const readmes = [read('README.md'), read('README.pt-BR.md')]
  const harnesses = ['Claude Code', 'Codex', 'Kiro', 'DeepSeek Harness', 'Antigravity', 'OpenCode', 'Grok Build', 'GitHub Copilot', 'Hermes Agent', 'OpenClaw']
  for (const readme of readmes) {
    for (const harness of harnesses) assert.ok(readme.includes(`[${harness}](https://`), harness)
  }
})
