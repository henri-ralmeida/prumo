---
name: prumo
description: Executes an approved plan as a task GRAPH — one read-only planner researches each phase and writes immutable task plans, parallel subagents deliver, and independent review validates before done. Includes PO First and a live dashboard.
---

# /prumo [plan|run]


Runs an **already approved** plan through the graph engine bundled with this skill: a DAG of
tasks, one read-only planner researching each phase and composing immutable plans for its tasks, parallel executors, a validation gate before anything
is `done`, and a read-only dashboard the dev can watch.

## When to use

- An **approved plan of ~5+ tasks** where the ORDER of work matters
- Tasks **independent enough to parallelise** across subagents — that is the graph's payoff
- When "done" must mean something **checked** by a fresh reviewer, never a self-report
- Long runs the dev wants to **watch live** instead of reading a report afterwards

## When NOT to use

- **No approved global plan yet** — approve the overall scope first; phase planning then refines each task's execution
- **Small or strictly sequential work** — a 3-task chain needs no orchestrator; just do it
- **Solo agents without subagent dispatch** — without dedicated planners, executors and reviewers, the
  gate has nothing to enforce

**"Approved" means the DEV said yes to that plan** — one you wrote yourself this conversation
is not approved by existing. Translating an approved task list into the plan format is
mechanical and fine; inventing the overall scope still requires global planning and approval.
Arriving with only a prompt: route to the planning workflow, or draft the plan and SHOW it.
The run starts after their yes, never before.

Native global Plan/Spec modes are authoring and approval layers, not Prumo
plan formats. After approval, invoke Prumo and mechanically translate their tasks into
`.plan.json`; do not treat native plan approval or native execution as a Prumo run. Prumo
must pass `init` before dispatch. A functional task always uses a nonempty validation array,
for example `"validation": [{ "kind": "functional", "run": "<real check>", "expect": "<observable result>" }]`.
A prose validation is valid only with `validationMode: "inspection"` and a concrete
`inspectionReason`.

Argument: a plan file, a run name to RESUME, or nothing (then
`$PRUMO_ROOT/.specs/graph/CURRENT`). With
neither, do not guess — use the plan this session just produced, or ask where it lives, naming
any candidates you found. The source plan lives wherever the project keeps it; only run state
is fixed under the central Prumo workspace.

## Product-first behavior

Apply [PO First](references/po-first.md), also configured globally by the installer, in every role. Respond in the user's language. A functional check means evidence of the requested effect, whether the work concerns data, automation, migration, software, or another domain. Use the host's native subagent tools; if dedicated planning, execution or independent review are unavailable, report that limitation rather than inventing agent dispatch. The engine records transitions; it does not create agents. In Codex invoke this skill as `$prumo`; Claude Code and Kiro use `/prumo`.

## Invocation router

The top-level Prumo skill is the orchestrator. On every invocation, inspect the user's requested
scope, the approved source plan, persisted `status`/`ready`, dashboard `/api/runs`, and actual native
agent state before selecting exactly one current flow:

| Observed context | Route |
| --- | --- |
| No approved global plan | Global planning and user approval; do not initialize or dispatch |
| Approved plan, but no persisted run | Storage/dashboard bootstrap, then `init` and visibility verification |
| `ready_for_discussion`, `discussing`, `discussed`, `ready_to_plan` or `planning` | Discussion and read-only planning flow |
| `ready` or `running` with a current task plan | Executor flow |
| `reviewing` or a current validation receipt | Independent reviewer flow |
| `failed` | Classify unchanged-contract correction versus an explicit contract change before retrying |
| `blocked` | Resolve or wait for the recorded blocker; never route around it |
| Every task terminal | Close-out and results flow |

Persisted state wins over conversational recollection. Never route a task to an executor merely because
the user requested implementation or because a plan file exists: its current discussion, planning,
dependency and dashboard gates must also agree. Never combine planner, executor and reviewer into one
agent turn.

### One planner per approved task contract

Dispatch the planner exactly once for a task's approved contract. Any number of reviewer rejections or
executor retries stays in the `executor -> reviewer -> executor` loop and reuses the same immutable task
plan; carry the latest actionable review reason to the next executor. Incomplete implementation guidance
is not permission to dispatch another planner or mark `--plan-defect` when the approved contract already
settles the behavior. If feedback truly requires a new business rule, acceptance condition, dependency or
write scope, block the task and return that contract change to the user. Only an explicitly approved
contract revision may open a new discussion/planning round; that is a new contract, not a retry.

## 0. Resolving the engine

The scripts live under `scripts/` in **this skill's own directory** — resolve them relative to
where this `SKILL.md` sits, never the workspace root, never a fixed install path:

```bash
ENGINE="<this skill's directory>/scripts/engine.mjs"    # e.g. .claude/skills/prumo/scripts/engine.mjs
SERVE="<this skill's directory>/scripts/serve.mjs"
```

Node.js 22+, no project dependencies to install. New run state **lives in a central workspace**. Installation migrates durable central graph-foreman data to Prumo: graph state, saved graph backups and top-level plan or handoff files. Generated execution directories, dependency copies and build outputs are discarded only after verification; existing project-local runs remain at their original paths. Before every
engine or dashboard command, select one central workspace:

```bash
PRUMO_HOME="${PRUMO_HOME:-$HOME/.local/share/prumo}"
PRUMO_ROOT="$PRUMO_HOME/<workspace>"
mkdir -p "$PRUMO_ROOT/.specs/graph/plans"
export PRUMO_HOME PRUMO_ROOT
```

Local harnesses running as the same user share this Prumo store. Preserve explicit compatibility overrides and do not choose a different store per harness. These commands create missing directories. Access still depends on each harness's permissions; cloud sessions do not automatically share local files.

Use the same `PRUMO_HOME` as the per-user global dashboard. A sandbox or filesystem restriction
is not a reason to redirect a real run into a session, visualization or temporary directory: request
the required access to the user's central store instead. A different `PRUMO_HOME` creates a valid but
isolated run that the managed dashboard will not discover.

`<workspace>` groups related runs, for example `ai-memory-migration`. `PRUMO_ROOT` must be an
existing child of `PRUMO_HOME` for new work; existing legacy workspaces are also accepted. When cwd is already
inside a central workspace, `PRUMO_ROOT` may be omitted. Never add `.specs/` to a project's
`.gitignore` for Prumo.

## 1. The plan file

Plans live in `$PRUMO_ROOT/.specs/graph/plans/<name>.plan.json`. Translation is mechanical;
three fields carry judgment:

- **`deps` orders execution and external phase inputs.** Internal phase dependencies may finish after planning;
  a task becomes ready to execute only with a current task plan and every dep `done` or `skipped`. Anything that must not run in parallel is a dep chain — migrations serialize
  because each depends on the last, not because the engine knows what a migration is. A dep
  added "to be safe" costs parallelism; one omitted hands two agents the same file.
- **`validation` is what must be TRUE before done**, written so a DIFFERENT agent could check
  it. "tests pass" is not that; "suite green + the 3 new cases named in the task" is. When the
  contract is executable, prefer `[{ "run": "<command>", "expect": "<what green means>" }]` so
  the engine executes the approved commands and records their results. Include `kind: "functional"`
  for behavioral tests and `kind: "static"` for lint/build/typecheck. See the gate rules below.
- **`touches` lists the path prefixes the task writes.** `init` refuses two parallel tasks with
  overlapping paths, catching the collision while it is still a planning mistake. Optional;
  omitting it leaves the dep chain as the only guard.

Missing `touches` means unknown write scope, not proof that work is independent. Inspect `ready`,
the task dependencies and the phase planning blockers before describing a task as runnable.
Never move tasks into an earlier phase, remove dependencies, disable planning gates or change
configuration merely to make the dashboard show readiness. Preserve the approved graph and explain
the blocker. A user-approved scheduling change must update the source plan coherently and pass
`sync-plan`; a failed synchronization is not permission to edit persisted state directly.

A task is **isolated in space, ordered in time**.

Full task contract (every field, defaults, per-task `requireReview`/`maxAttempts`) and the CLI:
[runtime reference](references/runtime.md).

## 2. Start the run AND the dashboard

```bash
node $ENGINE init --plan "$PRUMO_ROOT/.specs/graph/plans/<name>.plan.json" --run <name>-01
prumo dashboard enable  # http://localhost:4949 — per-user background service
prumo dashboard logs    # recent bounded lifecycle and crash diagnostics
```

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

On Windows, use PowerShell environment assignment ($env:PRUMO_ROOT) and quoted paths instead of POSIX shell syntax. Start background helpers hidden. Keep the actual working directory in the approved validation step; do not translate or rewrite its commands.

Ensure the server is available and give the dev the URL before dispatching a single agent. It discovers
known central workspaces and registered projects and follows their current runs. A taken port may be a
managed Prumo or an unrelated process; use `prumo dashboard status` and never terminate an unidentified owner.
If the managed dashboard disappears, inspect `prumo dashboard logs` before restarting it. Preserve the
reported timestamp, PID, signal or fatal message in the incident evidence.

Process health is not enough: before presenting the dashboard URL, read `<reported-url>/api/runs` and
confirm that the exact workspace and run just initialized are present. If they are absent, stop before
dispatch. Compare the engine's effective `PRUMO_HOME` with the managed dashboard's central store and
correct the storage mismatch while preserving the existing workspace and history; do not recreate the
run or claim that the dashboard is ready. Recheck `/api/runs`, then open the URL pinned with
`?root=<workspace>&run=<run>` so the dev lands on the intended execution.

**Two runs at once** work only when neither leans on the defaults: pass `--run <name>` to every
command for the non-current run, and give the second dashboard its own port AND pin —
`node $SERVE --port 4950 --run <name>`. State never collides (each run owns its directory and
its lock); `CURRENT` is the only thing they share. Prefer one run at a time anyway: two runs
also share the real ceiling — the machine and the API limits — without knowing about each other.

## 3. The loop

**The principal conversation discusses. Planners research. Executors deliver. A fresh REVIEWER judges.** These are separate assignments: `review`
refuses a reviewer that authored the task, and `done` refuses a validation the executor
recorded. That is the contract, and everything below serves it.
Use a different native agent for each role on a task; recording another label is not a substitute.

```bash
node $ENGINE ready                              # separate planning/execution readiness and capacity
node $ENGINE begin-phase-discussion F2          # persist phase discussion BEFORE asking
node $ENGINE finish-phase-discussion F2 --context <discovery.json>
node $ENGINE plan-phase F2 --agent plan-scenes  # one read-only planner for the phase
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory>
node $ENGINE start T4 --agent ag-scenes         # dispatch up to the cap, in the SAME message
node $ENGINE review T4 --agent rev-scenes       # executor finished → hand to a fresh reviewer
node $ENGINE validate T4 --ok --evidence "..." --cwd <absolute-project>  # the REVIEWER's verdict
node $ENGINE done T4
```

### Two planning levels

Global Plan/Spec mode defines and approves the graph. For new phased runs, each phase follows
**one discussion → one read-only planner → separate immutable plans per task**. A phase can begin discussion
or planning only when every external dependency of every unfinished member is `done` or `skipped`.
One blocked member blocks the whole phase, including members without dependencies. Internal dependencies
within the same phase gate execution, not phase planning. Phase numbering alone never blocks independent
phases. The user chooses which eligible phases to plan, including multiple phases in parallel; eligibility
does not authorize opening all phases automatically. Keep the approved phase assignments and dependency
chains. Overlapping `touches` must be resolved through the approved dependency graph, not by moving tasks.

Before dispatching the planner, the orchestrator runs an agnostic discovery protocol in the principal
Codex, Claude Code or Kiro conversation. Load the global plan, settled decisions and dependency outputs;
scout the phase's current code and artifacts; identify specific PO First gray areas; then always ask at
least one contextual question. Select the question channel from tools actually exposed and allowed in
the principal session, respecting their current schema and mode restrictions:

Discussion resolves meaning and decisions; it does not deliver a task. Local source inspection is allowed.
Do not run builds, tests, acceptance commands, database or cluster queries, external API probes, migrations,
or writes when their output is itself a target task's result or acceptance evidence. The planner may perform
read-only research needed to determine **how** the executor should work, but it must not produce the requested
result. The executor performs every task deliverable, including a read-only measurement when that measurement
is the task. Classify an ambiguous command by its purpose: if a successful result could satisfy a task or one
of its acceptance criteria, defer it to that task's executor.

- **Codex:** prefer `request_user_input_async` when available; use `request_user_input` only where its
  mode rules permit. A Plan-only tool being unavailable does not rule out an asynchronous native tool.
- **Claude Code:** use `AskUserQuestion` when exposed. Keep discovery in the principal conversation;
  do not assume the tool is available to a subagent or a restricted SDK integration.
- **Kiro or another harness:** use an exposed native clarification tool if available. Do not invent
  a tool name or infer support from the product name or Plan mode alone.
- **Fallback:** when no permitted native tool exists, or it explicitly reports unsupported operation,
  ask in the same conversation using **What I understood**, **Gray areas**, **Suggestions** and focused
  numbered **Questions**, translated to the user's language. In Kiro CLI, the user may optionally use
  `/reply` to answer point by point; it is a user command, not an agent question tool.

Preserve pending questions when changing channels; do not repeat an unsupported call or change host
permissions to force it. Wait for actual answers before closing discovery or dispatching its planner.
An asynchronous call returning, a timeout, an empty result or a preselected suggestion is not an answer.
Continue independent research while waiting. Record only the channel that actually received each answer.
Reuse current answers, ask adaptive follow-ups, and stop only when no uncertainty capable of
changing behavior, scope, acceptance or execution remains. Put out-of-scope ideas in `deferred`.

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
node $ENGINE plan-phase F2 --agent <planner>
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory>
```

The planner writes `task-plan-<id>.json` for every targeted member. Never turn steps, evidence gaps,
prerequisites or dependency outputs inside an explicitly selected task into separate graph tasks or
planner assignments without explicit user approval. The engine validates the whole batch
before recording any artifact. Each artifact is immutable and lists incomplete direct dependencies as
unresolved inputs. A later producer's independently reviewed validation receipt, or an explicit skip waiver,
satisfies that input at execution time without rewriting the plan. Contract changes stale only the affected
plan and true downstream scopes; shared phase discovery stales nonterminal plans in that phase; a marked
plan defect stales only that task.

Existing task-scoped runs use `begin-discussion`, `finish-discussion`, `plan-task` and
`finish-planning` when the user explicitly selected one existing task or when legacy phase boundaries
cannot be mapped without broadening scope. That path still receives current discovery and exactly one
read-only planner. Otherwise adopt one whole safe phase explicitly with
`begin-phase-discussion <phase> --adopt-legacy`; terminal history is preserved and every adopted
nonterminal member must still be pre-execution with no open round.

The engine hashes the validated discovery and issued receipt with canonical JSON and binds that digest to
the planning round and final task plans. Repeating `plan-phase` while that round is active is a no-op.
`finish-phase-planning` refuses a round whose discovery no longer matches the persisted context.

### Phase research and per-task plans

Every phase gets one dedicated native planner after its discovery closes. The planner remains read-only:
it researches the phase and writes only a separate plan artifact for each targeted task.
Research the current code, artifacts, dependency outputs, project rules and relevant source
documentation first; reuse useful prior research, but verify that it still applies. Read-only
inspection and safe research checks are allowed. The planner writes only its designated task-plan
artifact; it does not implement the task or edit graph state.

Consume the persisted discovery and do not repeat its questions. Apply PO First to research the selected
implementation approach, impacts and verification in depth. If research reveals a new consequential
decision, return it to the orchestrator: update discovery through the principal conversation and dispatch
fresh planning. Never invent an answer or label a material gap nonblocking to pass the gate.
Ordinary refinement within approved scope needs no new task approval. Material changes to
scope, behavior, acceptance or shared decisions return to the user and global plan workflow.
Stop research once every material criterion and dependency is mapped to current evidence and no
concrete unresolved risk remains. Do not reread equivalent sources or expand the investigation merely
to accumulate confidence; record a real gap instead of searching indefinitely for certainty.

```text
You are the read-only PLANNER for phase <F2>. Research every targeted task; do not implement them.
Read project rules, approved objective/constraints, member contracts and known dependency outputs: <references>.
Read the persisted phase discovery and its locked decisions: <phaseWorkflows.F2.discovery from state.json>.
Inspect the current implementation/artifacts and relevant sources; identify existing solutions and impacts.
Apply PO First. Do not repeat discovery questions; return newly found consequential gaps to the orchestrator.
Preserve known decisions; propose any material contract change for the authorized global-plan workflow.
Write ONLY task-plan-<id>.json in <absolute artifact directory> for each target: research, decisions,
steps, verification, open questions, phaseBinding and unresolvedInputs. Schema: references/runtime.md#task-plan-artifact.
Do not edit .specs/graph/ state. Report the artifact path, findings and any decision that blocks execution.
```

The orchestrator records `finish-phase-planning` only after inspecting the complete artifact batch. The engine
requires research, steps, a mapping to every validation check and no unanswered blocking question;
it checks structure and freshness, not the truth of research or real agent identity. `init` still
requires a valid behavioral contract: planning never permits fake `echo` checks or inspection
exceptions for functional work. The executor reads and rechecks the plan; the independent reviewer
can challenge an incomplete or incorrect plan against the approved objective and current criteria.
These roles reduce opportunities for error; none guarantees that models cannot make mistakes.

### Dispatch — recording a role does not create an agent

**Every `plan-phase` and `start` is paired with a native subagent call in the SAME message**.
Dispatch ready planning tasks within total capacity and ready execution tasks within both caps — parallelism is
the point of the graph, and tasks that share no dep share no file. The engine only ever sees
the `--agent` string, so an orchestrator that runs `start` and then writes the code itself
passes every check and leaves a state file that lies: `--agent` must name an agent that
EXISTS. That is the one rule here the engine cannot enforce for you.

`review` is a subagent call too — a `review` with no reviewer behind it is the same self-report
wearing a different label. It is not capacity-capped, so it goes out the moment work finishes.

After an interruption, inspect persisted state and the harness's actual agent status before
repeating commands. If `plan-phase`, `start` or `review` was recorded but no agent was dispatched, complete
that dispatch in the same attempt when authorized; do not repeat fail/retry/start. Record the
actual agent handle in a note if it differs from the engine label. If dispatch is unavailable
or the user paused work, block with the real orchestration reason. A recorded label is not
proof that an agent is running, and a dispatch problem is not an implementation failure.

Each executor gets its current task contract, approved context and recorded task plan:

```text
You are the EXECUTOR for <T4>: <title>. Deliver exactly that, then stop.
Read the project's agent rules first.
Write ONLY under: <touches>  — another executor owns the rest, right now.
Build on what these already produced: <deps>.
Read the current taskPlan and recheck its research/steps against the actual workspace: <artifact>.
Report a stale plan or unresolved consequential decision; do not silently change the approved contract.
Relevant approved context: <purpose, constraints and source references; identify superseded history>.
Your work must satisfy, clause by clause: <validation>
  A DIFFERENT agent checks your delivery against that contract and never sees this message.
<on a retry: the reviewer's --reason, verbatim>
Commit policy: <Project overrides>. Never touch .specs/graph/ — the orchestrator owns the state.
Report back: what you changed, and what a reviewer needs to reproduce it.
```

Report each execution step as it starts, using the 1-based index in the recorded `taskPlan.steps`.
The orchestrator records actual executor reports with `progress <task> --step <index> --agent <executor>`.
`start` records step 1; repeated progress is a no-op, and a new attempt starts over. These counters describe
the current step, not verified completion; they never replace review. Legacy tasks without a task plan
have no invented denominator. During validation the engine automatically emits each check's index/total,
including its start, pass, failure or cache reuse. A retry reruns functional checks as usual.

### Capacity

- **3 executors out of 4 busy agents** by default (`maxExecutors`/`maxParallel` per plan).
  Scale both, but keep executors **strictly below the total**: that headroom is what keeps
  review unblockable, and work finished but unverified is the worst state the graph can hold.
- **Review is never capacity-blocked and runs in parallel.** `review` is a role handoff on a
  slot the task already holds, so three tasks finishing together get three reviewers at once.
  They do occupy the total cap: 1 running + 3 reviewing = 4 busy.
- **Planning uses total capacity, not executor capacity or an execution attempt.** Planning,
  running and reviewing together occupy `maxParallel`; prioritize ready execution and review
  when allocating released slots. New tasks cannot bypass planning, dependencies, total capacity
  or concurrent agent uniqueness with `--force`; the legacy executor-quota override remains.
- **One agent, one active task**, across planning, execution and review; the engine refuses a busy `--agent`.
  A label on two concurrent tasks records parallelism that did not happen.
- **A FRESH reviewer per task.** One agent reviewing thirty accumulates exactly the context the
  graph exists to avoid, and stops reading with fresh eyes long before the end.

### Domain-neutral contracts

The engine manages dependencies, roles, attempts, pauses and evidence, independent of domain.
Execution can produce code, transformed data, automation results, migrated configuration or
other deliverables. Do not infer new scope or prescribe a framework from the task category.
Here, functional means verifying the intended observable outcome, not necessarily a unit test:
check migrated values and the destination consumer, resulting records, or an automation's
completed action, as appropriate. The plan supplies the criterion and verification method.
When there is no code diff, give the reviewer the delivered artifacts and relevant before/after state.
An inspection exception is for deliverables whose correctness can be established by inspection;
it must not replace observing a changed executable workflow or an operational side effect.
The engine currently collects executable checks through shell commands. It does not itself
drive a GUI, query a connector or certify a human observation. For such work, use an approved
verification command when one exists; surface an unsupported verification method rather than
inventing a passing command or treating unavailable tools as an inspection exception.

Keep these three things distinct, using the existing plan format:

- **Context:** purpose, decisions and background in the plan's `description` or referenced
  approved documents. Preserve prior criteria in history/backups, clearly marked as superseded.
- **Current criteria:** consistent, observable acceptance conditions. Each step's `expect`
  states what that step can actually establish; it is not a place to paste the entire old plan.
- **Executable proof:** `run` performs the corresponding check against the current delivery.
  A build proves compilation; writing a behavioral promise beside it does not prove that promise.

When an approved change replaces a criterion, replace the obsolete criterion rather than
keeping contradictory requirements active. Do not create `echo` steps to store context,
historical contracts or instructions. For legitimate inspection, a nonempty prose `validation`
with `validationMode: "inspection"` and `inspectionReason` needs no placeholder command.
Use the existing plan editor; a custom adaptation script is not required. Before changing a
plan, keep a uniquely named backup, check for concurrent edits and inspect the resulting diff.
Record the approved change and its reason in a note; never edit run history to hide a mistake.

### Behavioral validation and legitimate inspection

Before dispatch, check that the approved plan contains executable behavioral checks for
functional tasks. The default is `validationMode: "functional"`. At least one validation
step must have `kind: "functional"`, a real `run` command, and an observable `expect`.
Classify lint, syntax, build and typecheck steps as `kind: "static"`; untyped steps are static.
An `echo` instruction, static analysis, a test that only searches source text, or a test that
reimplements the production logic does not qualify as functional coverage. Inspect the test
and its actual execution count; a successful process with zero relevant tests is insufficient.
For a bug fix, demonstrate that the behavioral test detects the defect when practical.

At least one functional step is a structural minimum, not sufficient coverage by itself.
Map every current functional criterion to a relevant check and its observable result before
dispatch and review. Preserve every result-shaping dimension in that mapping: order and
precedence, boundaries, malformed or absent input, repetition and state transitions when they
apply. Do not let a broader check such as membership, success or nonempty output stand in for
one of those explicit rules. Commands run in order: prepare prerequisites before checks that need
them, and ensure skipped-build or filtered tests use the current delivery and execute relevant
cases. Do not hide failures or discard unrelated edits to make a check pass. Preserve earlier
evidence with distinct output paths when a check writes artifacts. Review existing artifacts
with read-only checks where sufficient; repeating an operational side effect needs its own
authorization and must not overwrite the delivery being reviewed.

Documentation and other tasks that do not affect runtime behavior may use
`validationMode: "inspection"` with a concrete `inspectionReason` in the approved plan.
Review the actual diff before accepting the exception. Do not use inspection for changed
runtime behavior, missing tools, unavailable environments, or a failing test. Those need an
actionable rejection or a blocked task. `requireReview: false` never waives functional checks.

The first reviewer must inspect the full behavioral path and the relevance of the tests, not only
the changed lines. Independently derive one focused counterexample for the highest-risk applicable
criterion, especially an ordering, boundary, invalid-input or transition rule; do not copy the
executor's examples or mirror the implementation. If the approved checks cannot establish a current
criterion, reject it with an actionable reason instead of approving on unrelated passing tests. Under the
one-planner rule, unchanged-contract feedback returns to the executor; a missing acceptance decision blocks
for the user rather than silently dispatching another planner. Keep this probe
proportional: one discriminating case is preferable to a generic matrix. On a bounded corrective retry,
the next reviewer inspects the rejection, changed paths and remaining checks, and may trust current step
receipts that the engine explicitly reuses.
Once every applicable criterion has current evidence and the independent probe passes, stop the review.
Continue only for a failure, contradiction, uncovered criterion or concrete risk; repeated equivalent
commands and broad speculative checks add cost without strengthening the verdict.
Browser/API workflows need checks that exercise that workflow at the
appropriate layer; a pure helper test cannot prove a user journey. Keep tests scoped to the
task and add a final integration check when separate tasks must work together.

Call `validate --ok --evidence "<observations against each criterion>" --cwd <absolute-project>`
after inspecting the diff and the approved commands. This runs the plan's commands and records
their output and exit codes; inspect those receipts before `done`. Avoid logging credentials.
Do not mutate the reviewed code while checks run; rerun validation if it changes afterward.
All steps rerun by default. Mark only deterministic `static` steps as `cacheable: true`; Prumo
may reuse their passing result within the same attempt and task state when the contract and Git
workspace are unchanged. Add safe relative `cachePaths` when that static check covers an isolated
set of files: after a corrective retry, the next reviewer resumes at the first failed or invalidated
step and reuses earlier passing receipts only while those declared paths are byte-for-byte unchanged.
Functional steps always run, and unscoped static steps restart on a new attempt. The engine checks
execution, not the semantic truth of `expect` or the declared `kind`.
Never label lint as functional to satisfy the gate. Shell commands execute with the caller's
permissions; the approved plan is not permission for unrelated or destructive side effects.

### Adapting an existing run without redoing delivered work

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
refresh a contract; reserve that path for an actual rejected implementation.

Before executing a check, make its environment and accepted outcomes explicit: use step.env
for environment variables (Unix NAME=value prefixes do not work in Windows cmd.exe),
step.expectedExitCodes for approved nonzero outcomes (default [0]), and step.timeoutMs for
long checks (default 600000; 0 explicitly disables the deadline). Never widen accepted codes
or increase a data window merely to satisfy the gate. See references/runtime.md for execution options.

### Real rejection, including an approved contract change

Distinguish an implementation that failed an applicable criterion from a request for new scope
or missing verification. Fixing an actual defect within the approved scope is already authorized.
Reuse explicit user steering as approval; ask only when a new requirement remains undecided.

| Situation | Next action |
| --- | --- |
| Actual rejected delivery, unchanged contract and sound plan | Record the reviewer's actionable `fail --reason`, then `retry` and `start`; the engine reuses the approved plan only while its contract, discovery, scope and dependency binding remain current. |
| Reviewer finds implementation guidance incomplete, but the approved contract is unchanged | Record an actionable `fail --reason` without `--plan-defect`, then `retry` and send the same task plan plus that reason to the next executor; do not dispatch another planner. |
| Actual rejected delivery, approved contract also changed | Record the real failure; edit the approved plan; `sync-plan` while `failed`; inspect the persisted contract, `touches` and dependencies; then `retry`, fresh task planning and execution. |
| Delivered work needs only an approved validation update | `refresh-contract`, then verification by an independent reviewer in the same attempt; no invented failure or executor. |
| New scope after `done`/`skipped` | Create an explicit follow-up through the approved planning workflow; preserve completed history. |

For the combined rejection case, phased runs use their phase workflow. A selective defect targets only
the affected task; a shared phase decision targets the phase's nonterminal members. Legacy task-scoped
runs retain `begin-discussion`, `finish-discussion`, `plan-task` and `finish-planning`. For a phased run:

```bash
node $ENGINE fail T4 --reason "review: <actual unmet criterion>" --run <run-name>
# Edit the approved plan; separate current criteria from superseded context.
node $ENGINE sync-plan --plan <approved-plan.json> --run <run-name>
node $ENGINE graph --run <run-name>  # inspect T4's persisted definition before retry
node $ENGINE retry T4 --run <run-name>
node $ENGINE begin-phase-discussion F2 --run <run-name> # before the principal-chat question
node $ENGINE finish-phase-discussion F2 --context <discovery.json> --run <run-name>
node $ENGINE plan-phase F2 --agent <planner> --run <run-name> # pair with one read-only planner dispatch
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory> --run <run-name>
node $ENGINE start T4 --agent <executor> --run <run-name>  # pair with actual dispatch
```

Resume from the recorded phase if some steps already happened. `retry` alone does not reload
the plan and refuses to proceed when the recorded failed task differs from its approved source;
run `sync-plan` and inspect first. `sync-plan` updates every nonterminal definition without changing its
lifecycle and preserves completed definitions as immutable history; refresh only updates validation fields
and does not record a rejection. Preserve the prior attempt's
reason and evidence. A bounded corrective retry records `planSourceAttempt` separately from the
immediately rejected `correctionOf` attempt and carries that review reason as execution context,
without changing the approved task plan or adding a fabricated planning round. Missing reviewer rationale,
`--plan-defect`, or a changed contract, discovery, scope or dependency result makes the engine require
planning. Do not set `--plan-defect` for unchanged-contract review feedback under the one-planner rule;
block and obtain an explicit contract decision when the existing contract cannot resolve the gap. Prefer the harness's structured editor for the approved plan. If a
temporary program is the safest way to change a large plan, verify its backup and exact diff,
then remove it; that helper is not a Prumo transition.

### Resuming paused work

`unblock <task>` restores the recorded phase (pending, planning, running, reviewing or failed), preserving
the attempt and previous work. For delivered work paused during execution or review, use
`unblock <task> --reviewer <independent-agent>` to hand it directly to review in the same attempt.
This does not acquire an executor slot. It does recheck dependencies, total capacity and the
reviewer's availability; ordinary execution resume also checks executor capacity. A refusal
leaves the task blocked. Pending/failed tasks cannot use this handoff to bypass start/retry.

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

### Legacy runs and validation failures

- Existing tasks without `planningRequired` keep their original lifecycle, states and history;
  do not force completed or active legacy work through planning. Tasks added to an old run get
  the new planning requirement. Installation never resets a run.
- `sync-plan` preserves `done` and `skipped` contracts as history. Their old prose does not block synchronization or retry of other tasks. Do not relabel completed functional work as inspection. New and nonterminal tasks still need valid contracts; graph structure is checked for every task.
- `start --executor <name>` is an alias for `start --agent <name>`. These commands record assignment; they do not spawn the agent.
- `validate --ok` **executes the contract commands**, including database and network operations. It is not a manual approval flag. Read each check's output and failed index before deciding whether failure is implementation, environment, or contract related.
- A failed network/VPN check keeps the gate failed even if the reviewer considers the implementation correct. Restore the environment and have the independent reviewer validate again in the same attempt. Use `fail`/`retry` for an actual rejected implementation, not a transient environment failure. Functional checks always rerun; only explicitly cacheable static checks can reuse unchanged evidence.
- The executor must not approve its own work. The orchestrator must not impersonate the reviewer by issuing approval on its behalf. The engine checks recorded roles, not the identity of the shell caller. If the reviewer session is gone, dispatch a fresh independent review agent; hand off through `block` and `unblock --reviewer <new-agent>`, then let that actual agent run validation.
- Quote absolute working directories. In a POSIX shell on Windows use forward slashes, for example `--cwd "C:/work/project"`. Invalid directories are rejected before a gate receipt is created.

### What the reviewer gets, and what it decides

Give the reviewer the **current validation contract**, relevant **approved context** and the
**diff or delivered artifacts**, without the executor's persuasive narrative. Identify
superseded requirements as history. The reviewer runs the project's gate ITSELF (see Project
overrides), checks the contract clause by clause, and answers `--ok` or `--failed`.

```text
You are the REVIEWER for <T4>: <title>. You did NOT produce this delivery.
Judge these changes: <diff, delivered artifacts or before/after state under `touches`>
Against this contract, clause by clause: <validation>
Relevant approved context and constraints: <references; distinguish superseded history>.
Recorded taskPlan: <artifact>; treat it as evidence to inspect, not authority over the approved objective.
Challenge missing or incorrect planning/criteria instead of approving a flawed plan's implementation.
Read the project's agent rules and the relevant implementation, inputs, outputs and checks.
Check that the contract proves the changed behavior and that any inspection exception fits the diff.
Run the gate YOURSELF through engine validate: <Project overrides, engine path, absolute project cwd>.
Check the recorded output, actual relevant test count, and results against every criterion.
Never accept lint/build/typecheck, echo instructions, or zero relevant tests as functional proof.
Answer:
  verdict:  ok | failed
  evidence: what you RAN and what it ANSWERED — commands and counts, not impressions.
  if failed: what is missing, specific enough for the next executor to act on.
```

What is absent from that message is the point: no executor report, no attempt count, no "the
suite was already green". A fresh agent, a clean context, and the contract.

- **`--evidence` records the reviewer's behavioral observations** and must not be empty.
  Command results are collected by the engine; the reviewer still checks their relevance.
  `done` refuses without a passing review validation for the CURRENT attempt — the one rule
  that stops "it looks right" from becoming state.
- **Rejected delivery** → follow "Real rejection" above; synchronize any approved contract
  change before retry. The reason travels to the next executor and must be actionable.
- Past **3 attempts** the engine warns — escalate to the dev instead of spending more.
- Needs the dev → `block T4 --reason "..."`. Blocked is a real state; leaving it `running`
  while you wait is how a graph lies.
- `note <task> --text "..."` for what a later reader needs and the states cannot say.
- Skipping review entirely is `"requireReview": false` in the plan, and only where the gate
  genuinely does not apply.

## 4. What NOT to ask

**No confirmation per task.** The plan is approved; executing it is the job. Consult the dev
only for unresolved decisions that change behavior, scope, acceptance or shared constraints —
research first, reuse prior answers, and `block` when the answer is required.

## 5. Project overrides — FILL THIS IN for your repo

The engine and the discipline above never change between projects; this block does. Replace it
(or record the same answers in your project's `CLAUDE.md`) — an orchestrator running with these
questions unanswered is guessing.

- **The gate per task**: the exact commands a reviewer runs (e.g. `npm test -- --changed && npm
  run lint`). Prefer a scoped run per task and the full suite once at the end — a full run per
  task is minutes spent proving nothing.
- **Commit policy**: does an executor commit its own task, or does the dev commit at the end?
  If agents commit, give the message convention.
- **Plan source**: which skill or document produces the approved plan this skill executes.
- **Shared tree**: can OTHER agents be writing here during a run? If so, a red test in a file no
  task touched is not this run's regression. Name any known-red baseline the project carries.
- **Where durable knowledge goes**: `.specs/` is scratch. A decision, invariant or convention
  discovered mid-run must LEAVE it before the run closes — name the destination your repo uses
  (ADRs, a domain doc, the root agent rules file). A run whose knowledge stayed in `.specs/`
  shipped nothing but code.

## 6. Close-out

Report against the graph, not memory: `node $ENGINE status` is the source. Say what is `done`,
what is `blocked` and on whom, and what a `skipped` task means. Never report a run as finished
while a task is blocked — say "34/36, two waiting on you, here is what for".

Lead the final report with the observable result for the affected person or operation. Then state
the relevant change, evidence and material limitation in that order. Translate unfamiliar technical
terms into their practical effect. Add one to three prioritized suggestions only when a real decision,
risk, pending verification or useful next action remains; never manufacture follow-up work merely to
populate a section.

Then point the dev at the dashboard's **results** tab (`r`): wall clock vs agent time, the
planning/build/verify split, the critical path against the wall clock, and which tasks were reviewed
above the median cost without ever being rejected. That last list is the input to the NEXT
plan's `requireReview` — a field the dev authors and the engine never decides for itself. Never
propose turning a gate off from your own impression of a task's difficulty; cite the tab or
leave it on.
