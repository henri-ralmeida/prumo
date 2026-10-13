# Phase discussion

Read this when a phase or task is `ready_for_discussion` or `discussing`, when the user must choose
whether to discuss or plan, or when the engine reports a newly eligible phase. Decisions and questions
remain in the principal conversation; a phase may also assign active target workers. Those assignments are
engine records only, so the orchestrator must create native agents with the exact names before dispatching them. Planning itself is in
[planning.md](planning.md); the discovery JSON schema is in [runtime.md](runtime.md#task-plan-artifact).

When `status` or `ready` reports `contractConfirmationRequired`, discussion and planning cannot be skipped:
inspect `show-contract <task> --diff`, present the changed contract and record explicit acceptance in a
fresh discussion with `confirmsContract`, following the contract-change section below.

## Cancelling a task during phase discussion

When the user cancels a task, record `skip <task> --reason "<user decision>"`. The skipped task is removed from the phase's pending contract confirmations and open discussion targets. If no active targets remain, the round closes as superseded; its original targets, excluded task, confirmation requirement and any recorded discoveries remain in history. The engine records an audit event and closes activity for the cancelled target. If other targets remain, the same round continues with current contract digests; their acceptance, authorization and independent review requirements are not waived. Follow `status` or `ready` for the remaining work. Completed rounds are not rewritten, and cancelling a task does not approve it or unblock unrelated tasks.

## Two planning levels

Global Plan/Spec mode defines and approves the graph and remains mandatory. Discussion and planning are
two independent optional gates for every eligible phase; execution and independent review remain mandatory.
Before each gate, inspect observable signals such as scope size and complexity, ambiguity, impact,
dependencies, novelty, risk and
whether the approved contract/context is already sufficient. Give a reasoned recommendation to perform or
skip that gate, state clearly that it is optional, offer both choices and wait for the user's explicit choice.
Never use token economy as the reason to skip and never impose the recommendation. The gate exists to catch
consequential uncertainty, and only the user can accept the risk of skipping it. Record a skip with a
nonempty reason and `--confirmed-by-user`. Supported combinations are discuss+plan, skip discussion+plan,
discuss+skip planning and skip both.

```bash
node $ENGINE begin-phase-discussion F2 --agent T1=disc-f2-t1 --agent T2=disc-f2-t2 # exact native names
node $ENGINE skip-phase-discussion F2 --reason "..." --confirmed-by-user
node $ENGINE skip-phase-planning F2 --reason "..." --confirmed-by-user
```

A phase can begin discussion
or planning only when every external dependency of every unfinished member is `done` or `skipped`.
An externally blocked member is excluded from the current phase targets and recorded in
`originalTargets`/`excludedTargets`; the remaining active/queued batch may finish. After `unblock`, that
task uses its own task-scoped discussion and planning flow. Internal dependencies
within the same phase gate execution, not phase planning. Phase numbering alone never blocks independent
phases. The user chooses which eligible phases to plan, including multiple phases in parallel; eligibility
does not authorize opening all phases automatically. Keep the approved phase assignments and dependency
chains. Overlapping `touches` must be resolved through the approved dependency graph, not by moving tasks.
For explicit plans, also investigate `writeScope` and `sharedResources`: writers to the same resource require dependencies even with distinct files. Resolve `unknown` through an approved `sync-plan` change before execution. Preserve existing recorded discussion and planning choices.

## When a phase becomes eligible

After `done`, `skip` or `sync-plan`, inspect any `phase_eligible` event and the engine's suggestion. Tell the
user which phase and tasks are ready for discussion, then recommend `begin-phase-discussion <phase>`. Wait
for the user's choice before beginning it; eligibility alone never opens a phase.

## Questions found while creating or updating tasks

After global scope is approved, graph authoring is not an unrecorded discussion round. Collect phase/task
questions as pending context without inventing answers or changing the approved contract. Keep them with
the plan until a run exists, then persist them through `note <task> --text`; use `sync-plan` for an approved
contract change before opening another round. Once the phase is eligible and the user chooses discussion,
successfully run `begin-phase-discussion` before asking those questions. Task-scoped runs use
`begin-discussion` in the same order. This does not defer questions needed to approve global scope or
authorize a contract change, the choice of gates, or a recorded execution blocker.

If an answer was already given outside a round, reuse it as settled context in discovery `decisions` and
`coverage`, with its real origin, instead of asking the same question again. Never backdate the round or
label that answer with its new `roundId`. Only a question actually answered after the round opened may
satisfy its fresh-question requirement or confirm its current contract digests. If no consequential
question remains, recommend the explicit discussion skip and wait for the user's choice; prior answers
do not authorize a skip automatically.

## Running discovery

When the user chooses discussion, the orchestrator runs an agnostic discovery protocol in the principal
Codex, Claude Code, Kiro or DSH conversation. Load the global plan, settled decisions and dependency outputs;
scout the phase's current code and artifacts; identify specific PO First gray areas; then ask at
least one contextual question. Select the question channel from tools actually exposed and allowed in
the principal session, respecting their current schema and mode restrictions (see the channels below).

Discussion resolves meaning and decisions; it does not deliver a task. Local source inspection is allowed.
Do not run builds, tests, acceptance commands, database or cluster queries, external API probes, migrations,
or writes when their output is itself a target task's result or acceptance evidence. The planner may perform
read-only research needed to determine **how** the executor should work, but it must not produce the requested
result. The executor performs every task deliverable, including a read-only measurement when that measurement
is the task. Classify an ambiguous command by its purpose: if a successful result could satisfy a task or one
of its acceptance criteria, defer it to that task's executor.

### Question channels

- **Codex:** before falling back to chat, inspect the actually exposed tool names. Call
  `request_user_input_async` first when it is present; it is the preferred nonblocking wrapper and may be
  available in Default mode. Otherwise call `request_user_input` only when its current mode rules permit.
  The app-server protocol name `tool/requestUserInput` describes the host/client request beneath these
  wrappers; it is not itself a model-callable tool name. A Plan-only `request_user_input` being unavailable
  does not prove that `request_user_input_async` is absent, and remembering a tool from another session does
  not prove that the current host exposed it.
- **Claude Code:** use `AskUserQuestion` when exposed. Keep discovery in the principal conversation;
  do not assume the tool is available to a subagent or a restricted SDK integration.
- **Kiro, DSH or another harness:** use an exposed native clarification tool if available. Do not invent
  a tool name or infer support from the product name or Plan mode alone.
- **Fallback:** only after the current tool inventory has no permitted native wrapper, or the exposed wrapper
  explicitly reports unsupported operation,
  ask in the same conversation using **What I understood**, **Gray areas**, **Suggestions** and focused
  numbered **Questions**, translated to the user's language. In Kiro CLI, the user may optionally use
  `/reply` to answer point by point; it is a user command, not an agent question tool.

Preserve pending questions when changing channels; do not repeat an unsupported call or change host
permissions to force it. Wait for actual answers before closing discovery or dispatching its planner.
An asynchronous call returning, a timeout, an empty result or a preselected suggestion is not an answer.
Continue independent research while waiting. Record only the channel that actually received each answer.
Reuse current answers, ask adaptive follow-ups, and stop only when no uncertainty capable of
changing behavior, scope, acceptance or execution remains. Put out-of-scope ideas in `deferred`.

## Contract changes before and during a round

`--propose` applies to affected tasks that use the current planning lifecycle, including newly added tasks; it does not require those new tasks to have completed discussion or planning already. If an affected existing task uses the legacy lifecycle, the command refuses the proposal and lists its ID before saving state or replacing the recovery backup. In that case, synchronize the candidate with `sync-plan --plan <candidate.json>` without `--propose`, then inspect `status` or `ready` and follow the indicated task or phase discussion/planning path. This preserves existing blocks, authorization requirements, attempts and independent review; it does not migrate legacy tasks automatically or grant execution permission.

To avoid two approvals for one change, prepare the candidate plan and run `sync-plan --plan <candidate.json> --propose` before asking for acceptance. This stages the proposal, revokes affected execution authorization and requires exact contract confirmation; it does not authorize execution. Existing invalidation safeguards still apply. Open the task or phase discussion, then show `show-contract <task> --full` for each target (including executable checks and its digest). Ask once whether the user accepts this exact contract and the requested continuation scope/mode. Record that answer in the current discovery question with the printed `confirmsContract` values; use the same actual answer to record `authorize` only for the scope/mode the user accepted. Do not invent continuation consent from contract acceptance alone.

If synchronization or a later answer changes the displayed contract, the current round is stale: show the new contract and obtain a new acceptance. Never reuse an earlier generic approval or relabel an old answer with a new round ID. This path avoids the preliminary authorization question; it does not retroactively validate an answer received before the exact contract and round existed. Unanswered external blockers still need their recorded resolution, and active attempts retain their pause and explicit resumption.

Edit the approved plan and run `sync-plan` BEFORE `begin-phase-discussion` or `begin-discussion`. Changing a
task contract while its round is open invalidates that round: `sync-plan` warns, and the next `begin-*`
prints the superseded round with its cause, including the contract fields `sync-plan` changed. If the
user's answers change the contract mid-round, record the decision, edit the plan, run `sync-plan`, and then
begin a fresh round instead of closing the stale one. The synchronization rules themselves are in
[recovery.md](recovery.md#synchronizing-an-approved-plan-change).

A phase reopened after a synchronized contract change also needs an explicit acceptance. Run `show-contract
<task> --diff` for each current target, present its full business text to the user and ask whether to accept
the changed contract. Add the exact task/digest list printed by `begin-phase-discussion` to
`questions[].confirmsContract` on one freshly answered question. `finish-phase-discussion` checks that every
current task and digest is present. A stale digest or a discussion/planning skip cannot satisfy this gate.

## Recording discovery

Run `begin-phase-discussion` before presenting the first question. It persists the phase as `discussing` and issues the
current `roundId` and `nonce`. Write the resulting discovery JSON with those values and bind at least
one freshly answered question to that `roundId`; include light research, the real `native` or
`chat-fallback` channel, PO First coverage, decisions, deferred ideas, `executionBoundary` and closure.
`executionBoundary.deferredToExecutor` must name exactly the current `activeTargets`, not the queued targets, and
`prematureTaskWork` is normally empty. `finish-phase-discussion` validates discovery only for the current
`activeTargets`; it accumulates each completed wave and opens the next one until all targets are covered.
The start command lists active targets and targets waiting for a slot. If the artifact includes queued
targets, the refusal identifies them and explains that they need a later closure call. After each
wave, inspect the next active targets and repeat `finish-phase-discussion`; the phase remains open
until every wave closes. This preserves the shared agent limit and each recorded discovery.
If task work occurred during discussion, record its task and action, stop, tell the user, and do not
reuse its result. Only after explicit user approval may `finish-*-discussion --accept-premature-work` close
the round; the executor still repeats the work. Then run:

```bash
node $ENGINE finish-phase-discussion F2 --context <discovery.json>
node $ENGINE plan-phase F2 --agent T1=plan-f2-t1 --agent T2=plan-f2-t2 --plan-dir <artifact-directory>
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory>
```

Passing the artifact directory to `plan-phase` is optional; with it, `status` and `ready` count the
`task-plan-<id>.json` files already written there while the round is open. `finish-phase-planning` validates
only the active wave, stages accepted plans and opens the next wave; the final wave records every task plan
atomically. Before dispatching the workers, read [planning.md](planning.md).

## Task-scoped discussion in existing runs

Existing task-scoped runs use `begin-discussion`, `finish-discussion`, `plan-task` and
`finish-planning` when the user explicitly selected one existing task or when legacy phase boundaries
cannot be mapped without broadening scope. That path still receives current discovery and exactly one
read-only planner. Otherwise adopt one whole safe phase explicitly with
`begin-phase-discussion <phase> --adopt-legacy`; terminal history is preserved and every adopted
nonterminal member must still be pre-execution with no open round. The task-level skips are
`skip-discussion <task>` and `skip-planning <task>`, with the same `--reason` and `--confirmed-by-user`.
