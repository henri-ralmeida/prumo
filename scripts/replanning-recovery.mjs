// Recover only the interrupted replanning transition proven by persisted history;
// an unresolved external decision must never become an internal planning pause.
export function replanningRecovery(task, events, context, discoveryCurrent) {
  const fail = () => { throw new Error('Replanning recovery requires matching discussion, answered block and original attempt history') }
  const saved = task.planningReturn
  const attempt = task.attempts?.at(-1)
  const discussion = task.discussionAttempts?.at(-1)
  const planning = task.planningAttempts?.at(-1)
  if (task.state !== 'blocked' || task.blockKind || task.blockReason || task.blockQuestion ||
      task.blockOptions || task.stateBeforeBlock || task.planningRequired !== true ||
      saved?.blockKind !== 'replan' || !['running', 'reviewing'].includes(saved.stateBeforeBlock) ||
      typeof saved.blockReason !== 'string' || !saved.blockReason.trim() ||
      !attempt || attempt.endedAt || attempt.result || attempt.agent !== task.agent ||
      (saved.stateBeforeBlock === 'reviewing' && (!task.reviewer || attempt.reviewer !== task.reviewer || task.reviewer === task.agent)) ||
      !discussion?.endedAt || discussion.result !== 'discussed' || discussion.context !== context ||
      discussion.attempt !== task.attempts.length || !discoveryCurrent ||
      planning?.result !== 'superseded' || planning.attempt !== task.attempts.length) fail()
  const lifecycle = events.filter(event => event.task === task.id && /^task_(?:block|block_updated|unblock|discussion|discussed|planning|planned|start|review|fail|done|retry|skip|replanning_recovered)$/.test(event.type))
  const [blocked, resumed, opened, closed] = lifecycle.slice(-4)
  const answer = task.blockHistory?.at(-1)
  if (blocked?.type !== 'task_block' || blocked.blockKind !== 'external' || !blocked.question ||
      resumed?.type !== 'task_unblock' || resumed.state !== 'planning' || resumed.attempt !== task.attempts.length ||
      resumed.agent !== planning.agent || !resumed.answer || answer?.question !== blocked.question ||
      answer.answer !== resumed.answer || answer.reason !== blocked.reason ||
      opened?.type !== 'task_discussion' || opened.roundId !== discussion.roundId ||
      opened.attempt !== task.attempts.length ||
      !opened.superseded?.some(item => item.workflow === 'planning' && item.round === planning.n) ||
      closed?.type !== 'task_discussed' || closed.state !== 'blocked' || closed.roundId !== discussion.roundId) fail()
  const openIndex = events.indexOf(opened)
  if (events.slice(openIndex + 1).some(event => event.type === 'plan_sync' && event.updated?.includes(task.id))) fail()
  const origin = lifecycle.slice(0, -4).findLast(event => event.type === (saved.stateBeforeBlock === 'reviewing' ? 'task_review' : 'task_start'))
  if (!origin || origin.attempt !== task.attempts.length ||
      (saved.stateBeforeBlock === 'reviewing' ? origin.reviewer !== task.reviewer : origin.agent !== task.agent)) fail()
  const pause = lifecycle.slice(0, -4).findLast(event =>
    event.type === 'task_block' && event.blockKind === 'replan' || event.type === 'task_unblock' && event.state === 'blocked')
  if (!pause || events.indexOf(pause) < events.indexOf(origin) ||
      (pause.type === 'task_block' ? pause.reason !== saved.blockReason : saved.blockReason !== 'approved scope needs current planning')) fail()
  return { stateBeforeBlock: saved.stateBeforeBlock, blockKind: 'replan', blockReason: saved.blockReason,
    roundId: discussion.roundId, attempt: task.attempts.length }
}
