# Phase discussion

[Português](discussion.pt-BR.md)

Read this when a phase or task is `ready_for_discussion` or `discussing`, when the user must choose
whether to discuss or plan, or when the engine reports a newly eligible phase. Discussion happens in the
principal conversation; it is an engine state, not another agent. Planning itself is in
[planning.md](planning.md); the discovery JSON schema is in [runtime.md](runtime.md#task-plan-artifact).

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
node $ENGINE begin-phase-discussion F2          # after the user chooses discussion
node $ENGINE skip-phase-discussion F2 --reason "..." --confirmed-by-user
node $ENGINE skip-phase-planning F2 --reason "..." --confirmed-by-user
```

A phase can begin discussion
or planning only when every external dependency of every unfinished member is `done` or `skipped`.
One blocked member blocks the whole phase, including members without dependencies. Internal dependencies
within the same phase gate execution, not phase planning. Phase numbering alone never blocks independent
phases. The user chooses which eligible phases to plan, including multiple phases in parallel; eligibility
does not authorize opening all phases automatically. Keep the approved phase assignments and dependency
chains. Overlapping `touches` must be resolved through the approved dependency graph, not by moving tasks.

## When a phase becomes eligible

After `done`, `skip` or `sync-plan`, inspect any `phase_eligible` event and the engine's suggestion. Tell the
user which phase and tasks are ready for discussion, then recommend `begin-phase-discussion <phase>`. Wait
for the user's choice before beginning it; eligibility alone never opens a phase.

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
`executionBoundary.deferredToExecutor` must name every targeted task and `prematureTaskWork` is normally
empty. If task work occurred during discussion, record its task and action, stop, tell the user, and do not
reuse its result. Only after explicit user approval may `finish-*-discussion --accept-premature-work` close
the round; the executor still repeats the work. Then run:

```bash
node $ENGINE finish-phase-discussion F2 --context <discovery.json>
node $ENGINE plan-phase F2 --agent <planner> --plan-dir <artifact-directory>
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory>
```

Passing the artifact directory to `plan-phase` is optional; with it, `status` and `ready` count the
`task-plan-<id>.json` files already written there while the round is open. Before dispatching the
planner, read [planning.md](planning.md).

## Task-scoped discussion in existing runs

Existing task-scoped runs use `begin-discussion`, `finish-discussion`, `plan-task` and
`finish-planning` when the user explicitly selected one existing task or when legacy phase boundaries
cannot be mapped without broadening scope. That path still receives current discovery and exactly one
read-only planner. Otherwise adopt one whole safe phase explicitly with
`begin-phase-discussion <phase> --adopt-legacy`; terminal history is preserved and every adopted
nonterminal member must still be pre-execution with no open round. The task-level skips are
`skip-discussion <task>` and `skip-planning <task>`, with the same `--reason` and `--confirmed-by-user`.
