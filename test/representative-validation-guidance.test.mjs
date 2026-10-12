import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const guidance = {
  planning: read('references/planning.md'),
  contracts: read('references/contracts.md'),
  dispatch: read('references/dispatch.md'),
  review: read('references/review.md'),
  closeOut: read('SKILL.md'),
}

test('uma carga grande conhecida não pode ser aprovada apenas com uma amostra pequena', () => {
  assert.match(guidance.planning, /small fixture does not cover a known large workload/)
  assert.match(guidance.contracts, /exercise the relevant user-facing path under a representative condition/)
  assert.match(guidance.dispatch, /Distinguish empty state from existing persisted\s+state/)
  assert.match(guidance.review, /Reject insufficient coverage even when\s+the existing tests pass/)
  assert.match(guidance.closeOut, /test counts are not a general guarantee/)
})

test('uma correção delimitada de baixo risco mantém validação proporcional sem carga genérica', () => {
  assert.match(guidance.planning, /bounded low-risk change does not require load testing/)
  assert.match(guidance.contracts, /Do not invent a performance target or require generic load/)
  assert.match(guidance.review, /bounded low-risk correction with no material scale or state risk/)
})

test('os READMEs apresentam os mesmos dez harnesses do guia integrado', () => {
  const readmes = [read('README.md'), read('README.pt-BR.md')]
  const harnesses = ['Claude Code', 'Codex', 'Kiro', 'DeepSeek Harness', 'Antigravity', 'OpenCode', 'Grok Build', 'GitHub Copilot', 'Hermes Agent', 'OpenClaw']
  for (const readme of readmes) {
    for (const harness of harnesses) assert.ok(readme.includes(`[${harness}](https://`), harness)
  }
})
