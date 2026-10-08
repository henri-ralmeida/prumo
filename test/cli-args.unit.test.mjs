import test from 'node:test'
import assert from 'node:assert/strict'
import { assertCliOptions } from '../lib/cli-args.mjs'
import { HARNESSES } from '../lib/install.mjs'

const harnessFlags = [...HARNESSES]
const options = {
  install: [...harnessFlags, 'all', 'lang', 'dry-run', 'project'],
  doctor: [...harnessFlags, 'lang', 'project', 'shell-filter-config', 'shell-block-evidence'],
  update: ['lang', 'dry-run', 'project'], status: ['verify-install', 'project'],
  migrate: ['check', 'run'], dashboard: [], restore: [],
}
const flags = [...harnessFlags, 'all', 'lang', 'dry-run', 'project', 'check', 'run', 'verify-install', 'shell-filter-config', 'shell-block-evidence']
for (const [command, accepted] of Object.entries(options)) for (const flag of flags) test(`CLI ${command} ${accepted.includes(flag) ? 'aceita' : 'recusa'} --${flag}`, () => {
  const values = { [flag]: ['lang', 'run'].includes(flag) ? 'en' : flag === 'project' ? ['projeto'] : true }
  if (accepted.includes(flag)) assert.doesNotThrow(() => assertCliOptions(command, values))
  else assert.throws(() => assertCliOptions(command, values), /does not accept/)
})
for (const command of ['', 'constructor', 'toString', '__proto__', 'desconhecido']) test(`CLI recusa comando herdado ou desconhecido ${command}`, () => {
  assert.throws(() => assertCliOptions(command, {}), /Unknown command/)
})
