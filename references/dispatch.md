# Authorization, dispatch and execution

[Português](dispatch.pt-BR.md)

Before `start` opens an attempt, every validation step must have the environment variables named in its optional `requiresEnv`. Configure missing values in the executor process environment or the approved `step.env` and retry. A refusal lists only variable names and creates no attempt; it does not waive authorization, planning or reviewer requirements.

Read this when a task is `ready` or `running`: before recording an execution authorization, before each
`start`, while an executor reports obstacles or progress, and when resuming after an interruption.
Review is in [review.md](review.md); blocks and resumption are in [recovery.md](recovery.md).

## Authorization scope and mode

After the user approves the graph and `init` or `sync-plan` has persisted it, ask what execution scope
they authorize: the current run, one phase, or selected tasks. Ask whether dispatch should continue
automatically within that scope (`auto`, the default) or pause for a user prompt before each dispatch
(`manual`). Record the accepted scope only after the user agrees:

```bash
node $ENGINE authorize --scope run --mode auto --confirmed-by-user
node $ENGINE authorize --scope phase:F2 --mode manual --confirmed-by-user
node $ENGINE authorize --scope tasks:T4,T5 --confirmed-by-user  # auto is the default
```

Authorization records the user's scope, mode, time and channel. It does not dispatch an agent or open a
phase. Use `ready` or `status` for per-task authorization, available slots and the next suggested action.
A run with no recorded scope keeps the earlier behavior: `start` still works and says that no scope is
recorded. Once any scope is recorded, `start` refuses tasks outside it and tasks whose authorization was
revoked by a contract change. In auto mode, keep filling free slots from authorized ready tasks after a review
or completion: when `review` or `done` opens a slot for authorized ready work, the engine prints
`execution slot freed by ...; authorized next: start <task> ...` and records a `slot_freed` event. Dispatch
those tasks without asking again; stop only at user gates. In manual
mode, ask before every dispatch. If `sync-plan` or `refresh-contract` changes a task contract, show the changed contract and get
fresh acceptance for that task before execution. A changed global plan decision renews acceptance for the
affected nonterminal tasks; work already running continues under its recorded attempt.
For manual authorization, pass `--confirmed-by-user` on each `start`, `review` and `retry`. Resuming an
active attempt through `unblock` also needs that flag. The engine records each confirmation with its
authorization ID, time and channel in the task event and an ordered `manualConfirmations[]` list on the
attempt. The older singular confirmation fields keep the latest value for compatibility. Auto mode needs
no repeated confirmation.

```bash
node $ENGINE start T4 --agent <executor> --confirmed-by-user  # manual only
node $ENGINE review T4 --agent <reviewer> --confirmed-by-user # manual only
node $ENGINE retry T4 --confirmed-by-user                     # manual only
node $ENGINE unblock T4 --confirmed-by-user                   # resuming active execution
```

## Recording a role does not create an agent

Run the suggested `start` command from `ready` and require a successful result before dispatching the executor. If it fails, correct the command or resolve the reported gate before dispatch; an agent must not start product work without its recorded attempt. `start` does not accept `--cwd`: record the project directory with `init --cwd` or `sync-plan --cwd`, and use `validate --cwd` for executable checks. Only call `activity-start` when work actually begins; call `activity-stop` before waiting or finishing so elapsed stage time is not presented as active work.

**Use one native subagent for each active plan-phase target when available; otherwise report the limitation and follow the local, read-only planner fallback in [planning.md](planning.md). Every start still requires an actual native executor dispatch in the SAME message.**
Dispatch ready agents of every role within the shared `maxAgents` limit — parallelism is
the point of the graph, but inspect declared file and shared-resource conflicts before treating tasks as independent. The engine only ever sees
the `--agent` string, so an orchestrator that runs `start` and then writes the code itself
passes every check and leaves a state file that lies: `--agent` must name an agent that
EXISTS. That is the one rule here the engine cannot enforce for you.
Local planning writes only the designated artifact and follows the same registration and capacity rules.
If only one local actor is available, obtain the user's choice to set the limit to 1 before opening a phase;
do not register extra identities to simulate parallel agents.

`review` is a subagent call too — a `review` with no reviewer behind it is the same self-report
wearing a different label. It shares the same limit; a handoff replaces the executor in the occupied task slot.
After a limit reduction, that replacement remains allowed so existing attempts can finish; it opens no extra slot.

`start --executor <name>` is an alias for `start --agent <name>`. These commands record assignment; they
do not spawn the agent.

## After an interruption

After an interruption, inspect persisted state and the actual agent status before repeating commands.
If planning intended a native planner, or start/review was recorded without dispatch, complete that dispatch
in the same attempt when authorized; do not repeat fail/retry/start. For the documented local-planning
fallback, resume read-only research and artifact work instead of inventing a dispatch. Record the
actual agent handle in a note if it differs from the engine label. If dispatch is unavailable
or the user paused work, block with the real orchestration reason. A recorded label is not
proof that an agent is running, and a dispatch problem is not an implementation failure.

## Executor prompt

Each executor gets its current task contract, approved context and recorded task plan when one exists.
When planning was explicitly skipped, give it the global contract, dependency outputs, recorded gate
reasons and all available homologation/review feedback; do not invent a task plan or reduce the acceptance contract:

```text
You are the EXECUTOR for <T4>: <title>. Deliver exactly that; do not hand it to review until you
reasonably believe every planned step and validation clause is satisfied.
Read the project's agent rules first.
For comments, tests, messages and other product text you add, state the observable business rule and why;
name its owning area or organization only when known. State technical reasons without inventing an owner.
Do not copy task, round, finding or criterion identifiers, internal process or orchestrator names, people's
names, or a decision's date or authorship into product text. Dates that support a measurement or describe
product behavior may be included. Keep traceability in the approved contract, commit or ticket.
Respect `writeScope`: `files` writes ONLY under <touches>; `read-only` writes no files; `unknown` needs an approved `sync-plan` contract change before starting.
Respect <sharedResources> access and dependencies; distinct files do not prove independence.
Build on what these already produced: <deps>.
Read the current taskPlan and recheck its research/steps against the actual workspace: <artifact, or "planning explicitly skipped" plus its receipt>.
Report a stale plan or unresolved consequential decision; do not silently change the approved contract.
Relevant approved context: <purpose, constraints and source references; identify superseded history>.
Your work must satisfy, clause by clause: <validation>
  A DIFFERENT agent checks your delivery against that contract and never sees this message.
<on a retry: the reviewer's --reason, verbatim>
Treat a recoverable obstacle as executor work, not as a reason to hand incomplete work to review:
inspect the failure, do targeted additional research when needed, change strategy, try safe alternatives
inside the approved contract, and rerun the relevant implementation checks. Continue until the complete
task plan is delivered. Stop early only for missing authority, an unresolved consequential scope/behavior
decision, unauthorized destructive risk, an unavailable external dependency after proportional attempts,
or evidenced impossibility. Record that blocker and the attempts made; do not widen scope or rewrite the plan.
As you begin each planned step, run this progress line with that step's 1-based index:
<the progress command printed by start, with --step <index>>
Commit policy: <Project overrides>. Never touch .specs/graph/ — the orchestrator owns the state.
Report back: what you changed, and what a reviewer needs to reproduce it.
```

Before the executor starts, record the pre-start baseline described in
[planning.md](planning.md#baseline-before-execution); the reviewer needs it to separate this delivery from
changes that were already present.

## Recoverable obstacles stay with the executor

A recoverable obstacle is executor work, not a reason to hand incomplete work to review. If an executor
reports one, keep that executor working (or resume the interrupted execution in the same attempt) with the
same immutable plan and current feedback. Do not run `review` merely because the executor reached a wall.
The reviewer is a validation gate, not failure triage. Handoff is eligible only when the executor reports
the whole plan delivered, every validation clause addressed, relevant safe checks passing and no known
recoverable gap. This persistence does not authorize new scope, destructive action or invented business
decisions; those are real blockers under the conditions above. Planner dispatch remains exactly once per
approved contract, including while the executor rotates strategies.

Corrections discovered during homologation keep their feedback and attempt history. Recommend discussion
and planning separately from the observable uncertainty/risk, but let the user skip either or both. An
unchanged-contract correction normally stays in the executor/reviewer loop; no replanning is invented.

## Progress reporting

Report each execution step as it starts, using the 1-based index in the recorded `taskPlan.steps`.
When reporting completion, give the orchestrator a 1–2 sentence result-and-why summary for `task.summary`.
`start` prints a ready `progress <task> --step 1 --agent <executor> --run <run>` line. Put that line in the
executor prompt; the executor runs it with the current step index as each step begins. Only when the
executor has no shell does the orchestrator record the executor's reported steps with the same command.
The printed line uses the syntax of the shell that ran `start`: outside Windows it is always POSIX; on Windows
it is POSIX when `MSYSTEM` or `SHELL` is set (Git Bash), PowerShell otherwise. The executor pastes it into a shell of the same kind; if its shell differs, it
adapts only the quoting and call operator, never the paths or arguments.
`review` and a direct `unblock --reviewer` warn when the recorded position is before the last step.
`start` records step 1; repeated progress is a no-op, and a new attempt starts over. These counters describe
the current step, not verified completion; they never replace review. Legacy tasks without a task plan
have no invented denominator. During validation the engine automatically emits each check's index/total,
including its start, pass, failure or cache reuse. A retry reruns functional checks as usual.

## Capacity

- **3 agents across all roles** by default (`maxAgents` per run). Discussion, planning, execution
  and review share this ceiling, with no hidden review reservation. Legacy separate limits remain
  historical metadata; migration adopts 3 and records the prior settings without changing tasks.
- **Review replaces execution in its existing slot.** It does not add a fourth agent when three
  tasks hand off to independent reviewers. New assignments cannot bypass capacity with `--force`.
- **Each phase target has its own recorded worker.** Register explicit `task=agent` assignments,
  dispatch only the returned `activeTargets`, and leave `queuedTargets` undispatched. Finishing a
  wave releases its slots; the phase closes only when all eligible targets finish.
- **Change the live limit in the board**, or use `set-agent-limit --max N --actor <user> --confirmed-by-user`.
  The next command uses the current limit. Lowering it lets existing work finish and refuses new
  assignments until capacity becomes available; the engine never terminates native agents.
- **One agent, one active task**, across all roles; the engine refuses a busy `--agent`.
  A label on two concurrent tasks records parallelism that did not happen.
- **A FRESH reviewer per task.** One agent reviewing thirty accumulates exactly the context the
  graph exists to avoid, and stops reading with fresh eyes long before the end.
