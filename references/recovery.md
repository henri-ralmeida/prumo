# Blocks, resumption, plan changes and legacy runs

[Português](recovery.pt-BR.md)

Read this when a task is `blocked`, when a block or an executor needs a user decision, when the approved
plan changed after `init` (before continuing any discussion, planning or execution), when `status`/`ready`
warn that the approved source differs from persisted contracts, and before resuming an existing or
legacy run. A rejected delivery is handled in [review.md](review.md#real-rejection-including-an-approved-contract-change).

## Contents

- [Resuming or migrating an existing run](#resuming-or-migrating-an-existing-run)
- [Synchronizing an approved plan change](#synchronizing-an-approved-plan-change)
- [Adapting a legacy run without redoing delivered work](#adapting-a-legacy-run-without-redoing-delivered-work)
- [Blocking and user decisions](#blocking-and-user-decisions)
- [Resuming paused work](#resuming-paused-work)
- [Legacy lifecycle notes](#legacy-lifecycle-notes)

## Resuming or migrating an existing run

The global dashboard only observes; it never synchronizes a plan. Before resuming an existing run, use
`node $ENGINE migrate --check --run <name>` when you need a read-only compatibility report. Every
single-run engine command automatically applies a safe, versioned structural migration first, creates
`state.pre-migrate-v<schema>.json`, enables missing discussion and planning gates, and opens no rounds.
It preserves terminal tasks. A safe partial migration creates the current run structure while marking each
already-started legacy task to keep its previous lifecycle; those attempts can resume, retry and finish through
independent review without retroactive planning. New or never-started tasks receive the current discussion and
planning gates and can proceed when their own dependencies are ready. Explicit `migrate` still names unsafe
in-flight planning blockers; do not clear attempts, skip real work or rewrite history to bypass them. Synchronize
corrected contracts with `sync-plan` while finishing existing work. Before `init`, `sync-plan` or resuming
an existing run, inspect the approved source and persisted graph for legacy contracts. Normalize every
nonterminal prose or obsolete validation into the current executable validation schema using repository
evidence, restore declared phase order and membership from the approved plan structure, preserve task IDs,
dependencies, scope and history, then run `sync-plan` on the same run
and inspect the persisted result. Do not create an auxiliary run to avoid adapting old tasks. Ask in the
principal discussion only when a consequential contract meaning cannot be established from the repository.

## Synchronizing an approved plan change

The order matters: edit the approved plan and run `sync-plan` **before** `begin-phase-discussion` or
`begin-discussion`, so the new round opens on the current contract (see
[discussion.md](discussion.md#contract-changes-before-and-during-a-round)).

```bash
node $ENGINE sync-plan --plan <approved-plan.json> --run <run-name>
node $ENGINE show-contract <task> --diff --run <run-name>
```

`sync-plan` adds approved tasks and refreshes contracts in every nonterminal state while preserving the
current lifecycle, agents, attempts, notes and evidence. Active work whose scope changed cannot advance
through review or completion until current planning is restored; block and replan it without inventing a
failure. Done/skipped contracts remain immutable history and need an explicit follow-up task. Task removal
is refused. If a migrated run still names a missing graph-foreman source, `sync-plan` recovers the matching
plan from the central Prumo workspace. Its output lists bounded per-task field changes, summarizes validation
contracts without printing their contents and warns when a waiting `blockReason` contradicts dependency
direction; the event log keeps the same structured audit. A named task in the user's request is a hard scope boundary: its
dependencies, prerequisites or internal deliverables are context, not permission to add tasks, plan
siblings or dispatch more planners. Keep one discussion and one planner for that task unless the user
explicitly approves a broader graph change. Otherwise, adopt a migrated task-scoped run one eligible phase
at a time with `begin-phase-discussion <phase> --adopt-legacy`. An approved validation change for active
work needs `refresh-contract`, not fail/retry. Always check the persisted task before review.

`sync-plan` warns without refusing synchronization when it invalidates an open discussion/planning round or
a current skip. `status` and `ready` also warn when the approved plan source differs from persisted task
contracts, naming changed fields, new tasks not yet synchronized and tasks missing from the approved plan;
this warning does not block readiness. Treat it as "run `sync-plan`" after the user approved the edit. Use `show-contract <task> [--diff]` to present complete
business text before and after a change; it omits executable `validation.run` commands. When a changed
contract reopens a phase or task that already had a discussion, planning round or current skip, the next
discussion records the old open round as superseded with its cause and prints the current task digests. Run
`show-contract <task> --diff` for every affected contract, present the complete business text and ask the user
to accept the changed behavior. For phase planning, put the exact `{ "task": "...", "digest": "..." }` entries
for all current targets in `questions[].confirmsContract` on one freshly answered question. For task planning,
use the single entry printed by `begin-discussion` in one freshly answered question. In both modes, the
confirmation must be on the same question bound to the current `roundId`; an old-round answer, stale digest,
discussion skip or planning skip cannot replace it. After the confirmation is recorded, the ordinary explicit
planning skip remains available.

A contract change also revokes that task's execution authorization; get fresh acceptance before executing it
([dispatch.md](dispatch.md#authorization-scope-and-mode)).

## Adapting a legacy run without redoing delivered work

A skill upgrade does not add business scope, enlarge a data window, or require a new executor.
Keep validation proportional to the approved task. A reviewer can run missing verification
on delivered work in the current attempt. Existing artifacts help the review; an executor's
report alone is still not approval.

For a legacy graph-foreman run, contract adaptation is mandatory before new dispatch. Inspect each
nonterminal task, translate old prose validation into current executable checks supported by repository
evidence, update the approved source, and run `sync-plan` against the original run. This graph-wide
contract normalization does not authorize planning every task. Preserve IDs, dependency edges, phase
membership, delivered history and existing attempts; never edit `state.json`. When the user selects one
task, plan only that existing task and keep its internal work inside the one immutable task plan. If work
is already running or reviewing, keep the attempt and use `refresh-contract` below. If the old wording leaves a consequential meaning unresolved, settle only that
point in the principal discussion, then complete the migration instead of abandoning it.

After adapting the approved plan, use:

```bash
node $ENGINE refresh-contract T4 --plan <approved-plan.json> --run <run-name>
```

This copies only validation, validationMode and inspectionReason to the task, preserving its
state, executor, reviewer, attempt history and block reason. It invalidates older validation
receipts, so the reviewer must validate the current contract. It does not dispatch an agent
or unblock a paused task. Done/skipped history is immutable. Never use fail/retry solely to
refresh a contract; reserve that path for an actual rejected implementation. Contract-writing
rules for the adapted validation are in [contracts.md](contracts.md).

## Blocking and user decisions

Needs the dev → `block T4 --reason "..."`. Blocked is a real state; leaving it `running`
while you wait is how a graph lies. When the block is a user decision, record it as one:
`block T4 --reason "..." --question "<the decision in one sentence>" --option "<answer> => <effect>"`
(repeat `--option` per answer). The block event and the dashboard then carry the question, and
`unblock T4 --answer "<answer>"` records what the user chose.

A block that waits for a user decision must be recorded with `--question` and `--option`, not only
`--reason`; when resuming finds a reason-only block that is really a decision, re-record it with
`block <task> --reason "..." --question "..." --option "<answer> => <effect>"` before asking the user.
When a block includes a recorded `blockQuestion`, present that exact question and its `blockOptions`
through PO First, ask the user for the decision, then pass the answer with `unblock <task> --answer`.
Keep the recorded reason, question, answer and time in the block history. Older reason-only blocks remain
resumable with `unblock <task>`.

Resolve or wait for the recorded blocker; never route around it. Use `note <task> --text "..."` for what a
later reader needs and the states cannot say.

## Resuming paused work

`unblock <task>` restores the recorded phase (pending, planning, running, reviewing or failed), preserving
the attempt and previous work. For delivered work paused during execution or review, use
`unblock <task> --reviewer <independent-agent>` to hand it directly to review in the same attempt.
This does not acquire an executor slot. It does recheck dependencies, total capacity and the
reviewer's availability; ordinary execution resume also checks executor capacity. A refusal
leaves the task blocked. Pending/failed tasks cannot use this handoff to bypass start/retry.
In manual authorization mode, `unblock` that resumes an active attempt also needs `--confirmed-by-user`.

These commands record state only. Resume the appropriate actual agent or dispatch the reviewer;
do not start a new executor for work already delivered. Respect the user's pause until resumption
is authorized. For an approved contract change while paused, refresh-contract comes before
unblock. Both a pending in-flight validation and a changed contract need fresh verification;
completed evidence and attempt history remain recorded. Explain an earlier orchestration mistake
with a note; do not rewrite it as an implementation failure or erase historical attempts.

For tasks requiring planning, task/dependency/global decision changes can make research stale. Pending work needs new planning.
A reviewer-rejected implementation with an unchanged approved contract must reuse its current approved
plan for every correction, regardless of retry count, while the complete recorded planning context still
matches. Review feedback travels to the next executor; it does not dispatch a planner. Only an explicitly
approved material contract change requires fresh planning while preserving prior plans and evidence. If an active execution
scope changes, keep its attempt, block it, synchronize the approved change and use its phase discussion/planning workflow.
`finish-phase-planning` returns this work to **blocked**, preserving its original phase and reason;
explicit `unblock` then resumes the same attempt. Do not fabricate fail/retry for replanning.
Validation-only changes can still use `refresh-contract` and fresh review in the same attempt.

## Legacy lifecycle notes

- Existing tasks without `planningRequired` keep their original lifecycle, states and history;
  do not force completed or active legacy work through planning. Tasks added to an old run get
  the new planning requirement. Installation never resets a run.
- `sync-plan` preserves `done` and `skipped` contracts as history. Their old prose does not block synchronization or retry of other tasks. Do not relabel completed functional work as inspection. New and nonterminal tasks still need valid contracts; graph structure is checked for every task.
