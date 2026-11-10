const definitions = {
  brief: [1, 'role'],
  'set-role': [0, 'role model effort'],
  'pause-run': [0, 'reason until'], 'resume-run': [0],
  'report-usage': [1, 'role attempt phase receipt tokens tools'],
  'verify-provenance': [1],
  init: [0, 'plan run cwd', 'force allow-overlap'],
  migrate: [0, '', 'check'],
  'renumber-tasks': [0, 'map', 'dry-run confirmed-by-user'],
  'reorder-phases': [0, 'order', 'dry-run confirmed-by-user'],
  'sync-plan': [0, 'plan cwd remove reason complete-audit', 'allow-overlap dry-run confirm-invalidation propose confirmed-by-user'],
  status: [0, '', 'verify-install verbose'], ready: [0], graph: [0], runs: [0],
  'show-contract': [1, '', 'diff full'], 'show-check': [1, 'check attempt'],
  authorize: [0, 'scope mode channel', 'confirmed-by-user'],
  'answer-question': [1, 'answer', 'confirmed-by-user'],
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
  'redo-execution': [1, 'reason', 'confirmed-by-user'],
  'redo-review': [1, 'reason agent', 'confirmed-by-user'],
  block: [1, 'reason question option'],
  defer: [1, 'reason'],
  'discard-plan': [1, 'reason', 'confirmed-by-user'],
  'pause-replanning': [1, 'reason'],
  unblock: [1, 'answer reviewer channel', 'confirmed-by-user'],
  'recover-replanning': [1, '', 'check confirmed-by-user'],
  skip: [1, 'reason'], note: [1, 'text'],
  'activity-start': [1, 'scope role agent'], 'activity-stop': [1, 'scope role agent'],
  'audit-propose': [0, 'environment out'],
  'audit-enable': [0, '', 'confirmed-by-user'], 'audit-skip': [0, 'reason', 'confirmed-by-user'],
  'audit-start': [0, 'agent environment contract', 'confirmed-by-user'], 'audit-finish': [0, 'report'],
  'audit-accept': [1, 'reason', 'confirmed-by-user'], 'audit-status': [0], 'audit-cvss': [1], 'audit-fix-plan': [0, 'out test-command'],
}

const dispatchCommands = ['start', 'review', 'unblock', 'begin-discussion', 'begin-phase-discussion', 'plan-task', 'plan-phase', 'finish-phase-discussion', 'finish-phase-planning', 'audit-start']

const commandDescriptions = {
  brief: 'Show a role briefing',
  'set-role': 'Record model preferences for a role',
  'pause-run': 'Pause the run without interrupting external processes',
  'resume-run': 'Resume a paused run',
  'report-usage': 'Record reported token and tool usage',
  'verify-provenance': 'Verify the declared numeric provenance',
  init: 'Create a run from a plan',
  migrate: 'Inspect or migrate a legacy run',
  'renumber-tasks': 'Preview or apply an approved task renumbering',
  'reorder-phases': 'Preview or apply an approved phase reorder and renumbering',
  'sync-plan': 'Compare or synchronize the approved plan',
  status: 'Show task states and summaries; use status --verbose for dispatches',
  ready: 'Show available tasks and next actions',
  graph: 'Show the full run state, including validations',
  runs: 'List the workspace runs',
  'show-contract': 'Show the task contract, notes and decisions',
  'show-check': 'Show stored validation checks and outputs',
  authorize: 'Record authorization for a run, phase or tasks',
  'answer-question': 'Record a confirmed answer to an open question',
  'begin-phase-discussion': 'Begin a phase discussion',
  'skip-phase-discussion': 'Record an approved phase discussion waiver',
  'finish-phase-discussion': 'Finish a phase discussion with its context',
  'plan-phase': 'Begin planning for a phase',
  'skip-phase-planning': 'Record an approved phase planning waiver',
  'finish-phase-planning': 'Record the phase task plans',
  'begin-discussion': 'Begin a task discussion',
  'set-agent-limit': 'Set the shared agent limit',
  'skip-discussion': 'Record an approved task discussion waiver',
  'finish-discussion': 'Finish a task discussion with its context',
  'plan-task': 'Begin planning for a task',
  defer: 'Defer a task without blocking the remaining phase planning',
  'redo-execution': 'Request another execution attempt with explicit user confirmation',
  'redo-review': 'Request another independent review round with explicit user confirmation',
  'discard-plan': 'Discard a task plan with explicit user confirmation and preserve its history',
  'skip-planning': 'Record an approved task planning waiver',
  'finish-planning': 'Record the task plan',
  start: 'Start an authorized task attempt',
  progress: 'Report executor progress',
  review: 'Assign the task to its reviewer',
  'review-progress': 'Report progress through review criteria',
  'refresh-contract': 'Refresh an approved validation contract',
  validate: 'Run checks or record a reviewer verdict',
  done: 'Complete a task after required validation',
  fail: 'Record a failed task attempt',
  retry: 'Open a new attempt for a failed task',
  block: 'Block a task and optionally record a question',
  'pause-replanning': 'Pause active work for replanning',
  unblock: 'Resolve a block and resume the task',
  'recover-replanning': 'Inspect or recover interrupted replanning',
  skip: 'Skip a task with a reason',
  note: 'Record a task note',
  'activity-start': 'Start an activity interval',
  'activity-stop': 'Stop an activity interval',
  'audit-propose': 'Prepare the optional independent audit contract without creating tasks',
  'audit-enable': 'Pre-authorize the run-level security audit',
  'audit-skip': 'Record the user decision to skip the security audit',
  'audit-start': 'Start the security audit with an independent auditor on a local environment',
  'audit-finish': 'Record the security audit report',
  'audit-accept': 'Accept a blocking finding with a justification',
  'audit-status': 'Show the security audit state and findings',
  'audit-cvss': 'Calculate the CVSS v4.0 score of a vector offline',
  'audit-fix-plan': 'Propose a fix phase with one task per blocking security finding',
}

export function engineGeneralHelp() {
  return Object.keys(definitions).map(command => ({ command, description: commandDescriptions[command] }))
}

// A ajuda deriva das opções aceitas, para orientar sem executar nem alterar o plano.
export function engineCommandHelp(command) {
  const [positionals, strings = '', booleans = ''] = definitions[command]
  const flags = ['--help', '--run <name>', '--lang <en|pt-BR>', '--force',
    ...strings.split(/\s+/).filter(Boolean).map(flag => `--${flag} <value>`),
    ...booleans.split(/\s+/).filter(flag => flag && flag !== 'help' && flag !== 'force').map(flag => `--${flag}`),
    ...(dispatchCommands.includes(command) ? ['--model <value>', '--effort <value>'] : [])]
  return { usage: `${command}${positionals ? command === 'answer-question' ? ' <ref>' : command === 'audit-accept' ? ' <finding>' : ' [<task-or-phase>]' : ''} [options]`, flags }
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
