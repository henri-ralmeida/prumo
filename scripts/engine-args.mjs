const definitions = {
  brief: [1, 'role'],
  'set-role': [0, 'role model effort'],
  'pause-run': [0, 'reason until'], 'resume-run': [0],
  'report-usage': [1, 'role attempt phase receipt tokens tools'],
  'verify-provenance': [1],
  init: [0, 'plan run cwd', 'force allow-overlap'],
  migrate: [0, '', 'check'],
  'sync-plan': [0, 'plan cwd remove reason', 'allow-overlap dry-run confirm-invalidation propose'],
  status: [0, '', 'verify-install'], ready: [0], graph: [0], runs: [0],
  'show-contract': [1, '', 'diff full'], 'show-check': [1, 'check attempt'],
  authorize: [0, 'scope mode channel', 'confirmed-by-user'],
  'begin-phase-discussion': [1, 'agent', 'adopt-legacy'],
  'skip-phase-discussion': [1, 'reason', 'confirmed-by-user'],
  'finish-phase-discussion': [1, 'context', 'accept-premature-work'],
  'plan-phase': [1, 'agent plan-dir'],
  'skip-phase-planning': [1, 'reason', 'confirmed-by-user'],
  'finish-phase-planning': [1, 'plan-dir', 'reuse-unchanged-plans'],
  'begin-discussion': [1, 'agent', 'adopt-legacy'],
  'set-agent-limit': [0, 'max actor', 'confirmed-by-user default'],
  'skip-discussion': [1, 'reason', 'confirmed-by-user'],
  'finish-discussion': [1, 'context', 'accept-premature-work'],
  'plan-task': [1, 'agent context', 'accept-premature-work'],
  'skip-planning': [1, 'reason', 'confirmed-by-user'],
  'finish-planning': [1, 'plan'],
  start: [1, 'agent executor channel', 'confirmed-by-user'],
  progress: [1, 'agent step'], review: [1, 'agent channel', 'confirmed-by-user'],
  'review-progress': [1, 'agent step', 'help'],
  'refresh-contract': [1, 'plan'],
  validate: [1, 'evidence scope-evidence summary cwd tail', 'ok failed'],
  done: [1], fail: [1, 'reason', 'plan-defect'],
  retry: [1, 'channel', 'confirmed-by-user'],
  block: [1, 'reason question option'],
  'pause-replanning': [1, 'reason'],
  unblock: [1, 'answer reviewer channel', 'confirmed-by-user'],
  'recover-replanning': [1, '', 'check confirmed-by-user'],
  skip: [1, 'reason'], note: [1, 'text'],
  'activity-start': [1, 'scope role agent'], 'activity-stop': [1, 'scope role agent'],
}

const dispatchCommands = ['start', 'review', 'unblock', 'begin-discussion', 'begin-phase-discussion', 'plan-task', 'plan-phase', 'finish-phase-discussion', 'finish-phase-planning']

// A ajuda deriva das opções aceitas, para orientar sem executar nem alterar o plano.
export function engineCommandHelp(command) {
  const [positionals, strings = '', booleans = ''] = definitions[command]
  const flags = ['--help', '--run <name>', '--lang <en|pt-BR>', '--force',
    ...strings.split(/\s+/).filter(Boolean).map(flag => `--${flag} <value>`),
    ...booleans.split(/\s+/).filter(flag => flag && flag !== 'help' && flag !== 'force').map(flag => `--${flag}`),
    ...(dispatchCommands.includes(command) ? ['--model <value>', '--effort <value>'] : [])]
  return { usage: `${command}${positionals ? ' [<task-or-phase>]' : ''} [options]`, flags }
}

// Argumentos inválidos são recusados antes de qualquer gravação, para que erros de
// digitação não executem uma transição diferente da solicitada.
export function parseEngineArgs(command, tokens) {
  if (!Object.hasOwn(definitions, command)) throw new Error(`Unknown engine command: ${command ?? ''}; available commands: ${Object.keys(definitions).join(', ')}; use <command> --help`)
  const [positionals, strings = '', booleans = ''] = definitions[command]
  const stringFlags = new Set(('run lang ' + strings).trim().split(/\s+/))
  const booleanFlags = new Set(('force help ' + booleans).trim().split(/\s+/))
  if (dispatchCommands.includes(command)) { stringFlags.add('model'); stringFlags.add('effort') }
  const args = { _: [] }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] === '-r' ? '--run' : tokens[i]
    if (!token.startsWith('--')) { args._.push(token); continue }
    const key = token.slice(2)
    if (command === 'start' && key === 'cwd') throw new Error('start does not support --cwd; use start <task> --agent <executor> --run <run> and wait for success before dispatching the agent. Set the project directory with init --cwd or sync-plan --cwd; validate also accepts --cwd.')
    if (command === 'validate' && key === 'agent') throw new Error('validate does not accept --agent; it uses the reviewer recorded by review <task> --agent <reviewer>. Use validate <task> --ok|--failed --evidence <observations>; functional run fields must contain shell commands, while manual inspection uses validationMode: inspection.')
    if (!stringFlags.has(key) && !booleanFlags.has(key)) throw new Error(`Unknown option --${key} for ${command}`)
    const repeatedAgent = key === 'agent' && ['plan-phase', 'begin-phase-discussion'].includes(command)
    if (Object.hasOwn(args, key) && key !== 'option' && !repeatedAgent) throw new Error(`Duplicate option --${key}`)
    if (booleanFlags.has(key)) { args[key] = true; continue }
    const next = tokens[++i]
    if (next === undefined || next.startsWith('--')) throw new Error(`Option --${key} requires a value`)
    if (key === 'option') (args[key] ??= []).push(next)
    else if (repeatedAgent && Object.hasOwn(args, key)) args[key] = [...(Array.isArray(args[key]) ? args[key] : [args[key]]), next]
    else args[key] = next
  }
  if (args._.length > positionals) throw new Error(`${command} accepts at most ${positionals} positional argument(s)`)
  if (args.ok && args.failed) throw new Error('Choose only one of --ok or --failed')
  return args
}
