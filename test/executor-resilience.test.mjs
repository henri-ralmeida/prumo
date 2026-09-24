import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (file) => readFileSync(join(root, file), 'utf8')

test('executor owns recoverable obstacles before independent review', () => {
  const skill = read('SKILL.md')
  const english = read('README.md')
  const portuguese = read('README.pt-BR.md')
  const runtimeEnglish = read('references/runtime.md')
  const runtimePortuguese = read('references/runtime.pt-BR.md')

  assert.match(skill, /A recoverable obstacle is executor work, not a reason to hand incomplete work to review/)
  assert.match(skill, /The reviewer is a validation gate, not failure triage/)
  assert.match(skill, /Planner dispatch remains exactly once per\s+approved contract/)
  assert.match(english, /Early blocking is reserved for missing authority/)
  assert.match(portuguese, /O revisor é uma etapa de validação, não uma triagem de falhas/)
  assert.match(portuguese, /o planejador continua executando exatamente uma vez por contrato aprovado/)
  assert.match(runtimeEnglish, /strategy rotations reuse the same immutable plan/)
  assert.match(runtimePortuguese, /rotações de estratégia\s+reutilizam o mesmo plano imutável/)
})
