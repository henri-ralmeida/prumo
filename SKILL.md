---
name: prumo
description: Executes an approved plan as a task GRAPH — orchestrator + parallel subagents, validation before any task counts as done, live dashboard. Use for any plan big enough that the order of work matters.
---

# /prumo [plan|run]


Runs an **already approved** plan through the graph engine bundled with this skill: a DAG of
tasks, subagents executing the independent ones in parallel, a validation gate before anything
is `done`, and a read-only dashboard the dev can watch.

## When to use

- An **approved plan of ~5+ tasks** where the ORDER of work matters
- Tasks **independent enough to parallelise** across subagents — that is the graph's payoff
- When "done" must mean something **checked** by a fresh reviewer, never a self-report
- Long runs the dev wants to **watch live** instead of reading a report afterwards

## When NOT to use

- **No approved plan yet** — this skill executes, it never plans
- **Small or strictly sequential work** — a 3-task chain needs no orchestrator; just do it
- **Solo agents without subagent dispatch** — without separate executors and reviewers, the
  gate has nothing to enforce

**"Approved" means the DEV said yes to that plan** — one you wrote yourself this conversation
is not approved by existing. Translating an approved task list into the plan format is
mechanical and fine; inventing the tasks is planning, and planning is not this skill's job.
Arriving with only a prompt: route to the planning workflow, or draft the plan and SHOW it.
The run starts after their yes, never before.

Claude Code Plan mode and Kiro Plan/Spec mode are authoring and approval layers, not Prumo
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

Apply [PO First](references/po-first.md), also configured globally by the installer. Respond in the user's language. A functional check means evidence of the requested effect, whether the work concerns data, automation, migration, software, or another domain. Use the host's native subagent tools; if independent execution and review are unavailable, report that limitation rather than inventing agent dispatch. The engine records transitions; it does not create agents. In Codex invoke this skill as `$prumo`; Claude Code and Kiro use `/prumo`.

## 0. Resolving the engine

The scripts live under `scripts/` in **this skill's own directory** — resolve them relative to
where this `SKILL.md` sits, never the workspace root, never a fixed install path:

```bash
ENGINE="<this skill's directory>/scripts/engine.mjs"    # e.g. .claude/skills/prumo/scripts/engine.mjs
SERVE="<this skill's directory>/scripts/serve.mjs"
```

Node.js 22+, no project dependencies to install. New run state **lives in a central workspace**. Existing legacy runs remain at their original paths, including project-local state. Reuse their existing GRAPH_ROOT / GRAPH_FOREMAN_HOME settings or select that same existing workspace; do not move or recreate its state. For new work, before every
engine or dashboard command, select one central workspace:

```bash
DEFAULT_PRUMO_HOME="$HOME/.local/share/prumo"
[ ! -d "$HOME/.local/share/graph-foreman" ] || DEFAULT_PRUMO_HOME="$HOME/.local/share/graph-foreman"
PRUMO_HOME="${PRUMO_HOME:-${GRAPH_FOREMAN_HOME:-$DEFAULT_PRUMO_HOME}}"
PRUMO_ROOT="$PRUMO_HOME/<workspace>"
mkdir -p "$PRUMO_ROOT/.specs/graph/plans"
export PRUMO_HOME PRUMO_ROOT
```

Local harnesses running as the same user share this central store. Preserve existing overrides and the legacy store; do not choose a different store per harness. These commands create missing directories. Access still depends on each harness's permissions; cloud sessions do not automatically share local files.

`<workspace>` groups related runs, for example `ai-memory-migration`. `PRUMO_ROOT` must be an
existing child of `PRUMO_HOME` for new work; existing legacy workspaces are also accepted. When cwd is already
inside a central workspace, `PRUMO_ROOT` may be omitted. Never add `.specs/` to a project's
`.gitignore` for Prumo.

## 1. The plan file

Plans live in `$PRUMO_ROOT/.specs/graph/plans/<name>.plan.json`. Translation is mechanical;
three fields carry judgment:

- **`deps` is the entire scheduling model.** A task is ready when every dep is `done` or
  `skipped`. Anything that must not run in parallel is a dep chain — migrations serialize
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

A task is **isolated in space, ordered in time**.

Full task contract (every field, defaults, per-task `requireReview`/`maxAttempts`) and the CLI:
[runtime reference](references/runtime.md).

## 2. Start the run AND the dashboard

```bash
node $ENGINE init --plan "$PRUMO_ROOT/.specs/graph/plans/<name>.plan.json" --run <name>-01
node $SERVE --sync-plan  # http://localhost:4949 — background, safe to kill anytime
```

`--sync-plan` watches the plan recorded by `init`. When an approved plan changes, it calls
`engine.mjs sync-plan` through the run lock: new tasks are added, pending/failed/blocked task
contracts are refreshed, and active/done task history is preserved. Task removal is refused.
If a preserved task differs, sync-plan reports it; an approved validation change for active
work needs refresh-contract, not fail/retry. Always check the persisted task before review.

On Windows, use PowerShell environment assignment ($env:PRUMO_ROOT) and quoted paths instead of POSIX shell syntax. Start background helpers hidden. Keep the actual working directory in the approved validation step; do not translate or rewrite its commands.

Start the server **in the background and give the dev the URL before dispatching a single
agent** — a dashboard offered after the run is a log, not observability. It follows
`$PRUMO_ROOT/.specs/graph/CURRENT`, which `init` just repointed at this run. A taken port usually means the
previous run's dashboard is still up and already serving this one.

**Two runs at once** work only when neither leans on the defaults: pass `--run <name>` to every
command for the non-current run, and give the second dashboard its own port AND pin —
`node $SERVE --port 4950 --run <name>`. State never collides (each run owns its directory and
its lock); `CURRENT` is the only thing they share. Prefer one run at a time anyway: two runs
also share the real ceiling — the machine and the API limits — without knowing about each other.

## 3. The loop

**Executors write. A REVIEWER bangs the gavel.** They are different agents, always: `review`
refuses a reviewer that authored the task, and `done` refuses a validation the executor
recorded. That is the contract, and everything below serves it.

```bash
node $ENGINE ready                              # what can start NOW, and free EXECUTOR slots
node $ENGINE start T4 --agent ag-scenes         # dispatch up to the cap, in the SAME message
node $ENGINE review T4 --agent rev-scenes       # executor finished → hand to a fresh reviewer
node $ENGINE validate T4 --ok --evidence "..." --cwd <absolute-project>  # the REVIEWER's verdict
node $ENGINE done T4
```

### Dispatch — `start` records it, it does not make it

**Every `start` is paired with a subagent call in the SAME message** (Claude Code: the Task
tool). Every ready task the executor cap allows goes out in that one message — parallelism is
the point of the graph, and tasks that share no dep share no file. The engine only ever sees
the `--agent` string, so an orchestrator that runs `start` and then writes the code itself
passes every check and leaves a state file that lies: `--agent` must name an agent that
EXISTS. That is the one rule here the engine cannot enforce for you.

`review` is a subagent call too — a `review` with no reviewer behind it is the same self-report
wearing a different label. It is not capacity-capped, so it goes out the moment work finishes.

After an interruption, inspect persisted state and the harness's actual agent status before
repeating commands. If `start` or `review` was recorded but no agent was dispatched, complete
that dispatch in the same attempt when authorized; do not repeat fail/retry/start. Record the
actual agent handle in a note if it differs from the engine label. If dispatch is unavailable
or the user paused work, block with the real orchestration reason. A recorded label is not
proof that an agent is running, and a dispatch problem is not an implementation failure.

Each executor gets the task and nothing else about the run:

```text
You are the EXECUTOR for <T4>: <title>. Deliver exactly that, then stop.
Read the project's agent rules first.
Write ONLY under: <touches>  — another executor owns the rest, right now.
Build on what these already produced: <deps>.
Relevant approved context: <purpose, constraints and source references; identify superseded history>.
Your work must satisfy, clause by clause: <validation>
  A DIFFERENT agent checks your delivery against that contract and never sees this message.
<on a retry: the reviewer's --reason, verbatim>
Commit policy: <Project overrides>. Never touch .specs/graph/ — the orchestrator owns the state.
Report back: what you changed, and what a reviewer needs to reproduce it.
```

### Capacity

- **3 executors out of 4 busy agents** by default (`maxExecutors`/`maxParallel` per plan).
  Scale both, but keep executors **strictly below the total**: that headroom is what keeps
  review unblockable, and work finished but unverified is the worst state the graph can hold.
- **Review is never capacity-blocked and runs in parallel.** `review` is a role handoff on a
  slot the task already holds, so three tasks finishing together get three reviewers at once.
  They do occupy the total cap: 1 running + 3 reviewing = 4 busy.
- **One agent, one task**, executors and reviewers alike; the engine refuses a busy `--agent`.
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
dispatch and review. Commands run in order: prepare prerequisites before checks that need
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

The reviewer must inspect the full behavioral path and the relevance of the tests, not only
the changed lines. Browser/API workflows need checks that exercise that workflow at the
appropriate layer; a pure helper test cannot prove a user journey. Keep tests scoped to the
task and add a final integration check when separate tasks must work together.

Call `validate --ok --evidence "<observations against each criterion>" --cwd <absolute-project>`
after inspecting the diff and the approved commands. This runs the plan's commands and records
their output and exit codes; inspect those receipts before `done`. Avoid logging credentials.
Do not mutate the reviewed code while checks run; rerun validation if it changes afterward.
All steps rerun by default. Mark only deterministic `static` steps as `cacheable: true`; Prumo
may reuse their passing result within the same attempt and task state when the contract and Git
workspace are unchanged. Functional steps always run. The engine checks execution, not the
semantic truth of `expect` or the declared `kind`.
Never label lint as functional to satisfy the gate. Shell commands execute with the caller's
permissions; the approved plan is not permission for unrelated or destructive side effects.

### Adapting an existing run without redoing delivered work

A skill upgrade does not add business scope, enlarge a data window, or require a new executor.
Keep validation proportional to the approved task. A reviewer can run missing verification
on delivered work in the current attempt. Existing artifacts help the review; an executor's
report alone is still not approval.

For a legacy graph-foreman run, preserve state and history. If a pending task has an invalid
functional contract, `start` refuses dispatch; correct the approved source and run `sync-plan`.
If work is already running or reviewing, keep the attempt and use `refresh-contract` below.

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
| Actual rejected delivery, unchanged contract | Record `fail --reason`, then `retry`, then `start` paired with the actual executor dispatch. |
| Actual rejected delivery, approved contract also changed | Record the real failure; edit the approved plan; `sync-plan` while the task is `failed`; inspect the persisted contract, `touches` and dependencies; then `retry` and `start` with the actual executor dispatch. |
| Delivered work needs only an approved validation update | `refresh-contract`, then verification by an independent reviewer in the same attempt; no invented failure or executor. |
| New scope after `done`/`skipped` | Create an explicit follow-up through the approved planning workflow; preserve completed history. |

For the combined rejection case, the sequence is:

```bash
node $ENGINE fail T4 --reason "review: <actual unmet criterion>" --run <run-name>
# Edit the approved plan; separate current criteria from superseded context.
node $ENGINE sync-plan --plan <approved-plan.json> --run <run-name>
node $ENGINE graph --run <run-name>  # inspect T4's persisted definition before retry
node $ENGINE retry T4 --run <run-name>
node $ENGINE start T4 --agent <executor> --run <run-name>  # pair with actual dispatch
```

Resume from the recorded phase if some steps already happened. `retry` alone does not reload
the plan and refuses to proceed when the recorded failed task differs from its approved source;
run `sync-plan` and inspect first. `sync-plan` preserves active/completed definitions; refresh
only updates validation fields and does not record a rejection. Preserve the prior attempt's
reason and evidence; carry the current contract and actionable rejection into the next
executor's assignment. Prefer the harness's structured editor for the approved plan. If a
temporary program is the safest way to change a large plan, verify its backup and exact diff,
then remove it; that helper is not a Prumo transition.

### Resuming paused work

`unblock <task>` restores the recorded phase (pending, running, reviewing or failed), preserving
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

### Legacy runs and validation failures

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
only for a genuinely ARCHITECTURAL decision or an ambiguity that could change what the project
is — and `block` the task when you do, so the graph shows why it stopped.

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

Then point the dev at the dashboard's **results** tab (`r`): wall clock vs agent time, the
build/verify split, the critical path against the wall clock, and which tasks were reviewed
above the median cost without ever being rejected. That last list is the input to the NEXT
plan's `requireReview` — a field the dev authors and the engine never decides for itself. Never
propose turning a gate off from your own impression of a task's difficulty; cite the tab or
leave it on.
