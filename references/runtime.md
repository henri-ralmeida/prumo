# PRUMO engine reference

**A foreman for your task graph**: executes an approved plan as a DAG — dispatching parallel
subagent executors, refusing to sign off any task a fresh reviewer has not inspected, and
watching the whole site on a live dashboard.

Install the skill and PO First for your environment; see the [installation guide](../README.md).

```bash
npx @henri-ralmeida/prumo@latest install --claude
```

## What it does

- **Parallel executors, capped** — independent tasks run at once; up to 3 executors out of
  4 total slots, so a finished task never waits for capacity to be reviewed.
- **Author ≠ verifier, enforced** — every task is validated by a FRESH reviewer agent that
  never saw the code being written. `done` refuses a self-reported validation; `review`
  refuses the task's own author. Evidence is recorded per verdict.
- **Collision-proof plans** — `init` rejects dependency cycles (naming the loop) and two
  parallel tasks that declare overlapping `touches` paths, before any agent starts.
- **Live dashboard** — a read-only server on `:4949` renders the DAG as phase swimlanes with
  animated dep edges, per-task state, retries and an event log. Killing it never affects a run.
- **Zero runtime dependencies** — Node.js 22+. State is plain JSON +
  append-only NDJSON in a central PRUMO workspace outside project repositories.
- **Tokens are spent only by agents** — the engine and the dashboard are plain Node
  processes making no model calls. Executors and reviewers (subagents) are the cost; the
  orchestrator adds a small constant overhead; watching the dashboard costs nothing.

## What you need before running it

The skill executes, it never plans:

1. **An approved plan** in the engine's format
   (`$PRUMO_ROOT/.specs/graph/plans/<name>.plan.json` — tasks,
   deps, validation contracts; format below). Where it comes from is up to you: a spec
   workflow's task list translated mechanically, any planning skill you already use, or
   written by hand — a plan does not require any other tooling. Without one, the skill stops
   and says so.
2. **Node.js 22+** (no project dependencies to install).
3. **An agent that can dispatch subagents** (e.g. Claude Code) to act as orchestrator,
   executors and reviewers.

After installing, fill in the **"Project overrides"** section of [SKILL.md](../SKILL.md) (or your
project's agent rules file): the per-task validation gate, the commit policy, where the
approved plan comes from. The engine never changes between projects; that section is what does.

## What makes a project graph-ready

The engine runs anywhere; the QUALITY of what N parallel executors produce depends on the
repo, because executors are fresh agents by design — the shared session memory a solo agent
accumulates does not exist here. **The repo is the executors' only shared memory.**

1. **A runnable gate** (required): a command that answers pass/fail. Without it,
   `validation` is opinion and the reviewer gate has nothing to enforce.
2. **Written conventions, enforced where possible**: an agent rules file plus lint that
   FAILS on violations. Five executors with no rules produce five styles — and the
   reviewer checks the task's contract, not taste. Prose inside each task works but does
   not scale; a rule written once in the repo reaches every executor for free.
3. **Scaffolding skills** (create-a-module, create-a-component): the difference between
   executors converging on the house pattern and each one improvising it.

## Domain-neutral outcomes

Task categories do not select engine behavior. Data work, RPA, software and migrations use the
same lifecycle and explicit contract. A functional check verifies the intended effect: it can
read migrated configuration, reconcile data, inspect an automation result or test application
behavior. It need not compile code or use a test framework. Example: migrate local records once,
then let the reviewer compare source/destination values and verify the destination consumer;
do not rerun the migration merely to obtain verification evidence.

Inspection remains appropriate for documents and other deliverables without changed executable
behavior. Executable checks currently use shell commands, so a GUI-only or connector-only check
needs an approved executable verification method; the engine does not certify those tools itself.
Domain neutrality does not guarantee every tool integration, environment or verification method.

## Mechanism vs discipline

The engine is deliberately dumb: it holds the graph, the states, the attempts and the history.
Every decision — which agent runs what, when to retry, when to escalate — belongs to the
orchestrator following [SKILL.md](../SKILL.md). The rest of this file documents the MECHANISM;
the skill is the DISCIPLINE. Neither replaces the other.

## Pieces

| File             | Role                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.mjs`     | CLI + state machine. The ONLY writer of state.                                                                                                                                                                                                                                                                                                    |
| `serve.mjs`      | Read-only HTTP server for the dashboard. Killing it never affects a run.                                                                                                                                                                                                                                                                          |
| `dashboard.html` | Live view: DAG laid out as phase swimlanes (toggle to dep-depth layering), animated dep edges, lineage highlight on hover, task details in a popover beside the node (long hover peeks, click pins; side panel = run state + logs only), working/validated sub-state per running task, orchestrator heartbeat, event flashes, retries, event log. Plus a **results** tab (`r`) deriving what the run cost — see below. |

New state lives in `~/.local/share/prumo/<workspace>/.specs/graph/<run>/`, outside project
repositories. An existing central graph-foreman storage directory is reused automatically.
`PRUMO_HOME` overrides that base; `GRAPH_FOREMAN_HOME` remains supported. Set `PRUMO_ROOT`
(or legacy `GRAPH_ROOT`) to an existing workspace before running commands. Existing
project-local `.specs/graph` storage remains usable in place; new project-local storage is
not created. When cwd is inside an existing workspace, the root may be omitted.
Each run contains `state.json` (source of truth) and `events.ndjson` (append-only history);
plans live in the workspace's `.specs/graph/plans/`. Node.js 22+, zero runtime dependencies.

## Plan format

```json
{
  "name": "my-feature",
  "maxParallel": 4,
  "maxExecutors": 3,
  "phases": [{ "id": "F1", "title": "Server side" }],
  "tasks": [
    {
      "id": "T1",
      "phase": "F1",
      "title": "What this task delivers",
      "deps": ["T0"],
      "validation": [{ "kind": "functional", "run": "pnpm test:changed", "expect": "the task-specific behavior cases pass" }],
      "touches": ["supabase/functions/scenes/"],
      "tags": ["migration"]
    }
  ]
}
```

### Task contract

Every field a planning skill needs to emit. Only `id` and `title` are required to initialize; passing review also requires a sufficient validation contract.

| Field           | Type                          | Default   | Meaning                                                                                       |
| --------------- | ----------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `id`            | string                        | required  | Unique task id (`T1`, `T2`…) — referenced by `deps`                                           |
| `title`         | string                        | required  | What this task delivers, one line                                                             |
| `phase`         | string                        | —         | Id of a `phases[]` entry; groups the task in status and dashboard swimlanes                   |
| `deps`          | string[]                      | `[]`      | Task ids that must be `done`/`skipped` first — the ENTIRE scheduling model                    |
| `validation`    | string \| {run, expect, kind, cwd?, env?, shell?, expectedExitCodes?, timeoutMs?}[]    | `""`      | What must be TRUE before done. Prose, or structured steps (see below)                         |
| `validationMode` | "functional" \| "inspection" | "functional" | Behavioral checks required unless this is a justified non-runtime inspection. |
| `inspectionReason` | string | — | Required for inspection; explain why runtime behavior is unaffected. |
| `touches`       | string[]                      | `[]`      | Path prefixes the task writes; `init` refuses parallel tasks with overlapping paths           |
| `tags`          | string[]                      | `[]`      | Free labels (`migration`, `docs`…) — informational only                                       |
| `requireReview` | boolean                       | inherit   | Per-task override of the plan's `requireReview` (e.g. `false` for a mechanical docs task)     |
| `maxAttempts`   | number                        | `3`       | Per-task retry cap before `retry` demands escalation (`--force` overrides)                    |

Plan-level fields: `name` (required), `description`, `phases[]` (`{id, title}`),
`maxParallel` (4), `maxExecutors` (3), `requireReview` (true).

**Structured validation.** When the contract IS executable, prefer steps over prose — the
reviewer then runs exactly what is written instead of interpreting:

```json
"validation": [
  { "kind": "functional", "run": "pnpm test:changed", "expect": "green, includes the 3 new service cases" },
  { "kind": "static", "run": "pnpm lint && pnpm typecheck", "expect": "clean" }
]
```

The default `validationMode` is `functional`: at least one step must declare
`kind: "functional"`. Untyped steps count as `static`, so legacy lint/build/typecheck-only
contracts cannot approve a functional task. `validate --ok` executes the commands and stores
their working directory, stdout, stderr, exit code and any execution error. Every step must
return a code in its expectedExitCodes (default [0]), with no execution error or signal. `expect` describes the behavior the reviewer must check; it is not
interpreted as an assertion by the engine. Checks must assert the actual behavior or resulting
state relevant to the task, rather than merely repeat an executor report.

For documentation or another task with no runtime behavior change, declare
`validationMode: "inspection"` and a nonempty `inspectionReason` explaining the exception.
Such a task may use prose validation plus concrete review evidence, or static commands.
Do not use this exception for untested functionality, missing environments or failing tests.
`requireReview: false` changes who may verify, never what must be verified.

Executable validation requires an absolute `--cwd <project>`; a step may instead declare its
own absolute `cwd` for multi-repository checks. Commands use cmd.exe on Windows and /bin/sh
on Unix. Optional `shell` selects an installed shell executable; the command must use that
shell's syntax. Use `env` for portable environment variables, not Unix NAME=value prefixes
under cmd.exe. Values must be strings; do not put secrets in plans or evidence.
Each step defaults to a 10-minute deadline. `timeoutMs` accepts 0–2147483647 milliseconds;
0 explicitly disables the deadline. Choose a suitable limit before an approved long check.
The engine prints the selected deadline before executing and records it with the shell.
`expectedExitCodes` accepts a nonempty array of integers 0–255, default [0]. For a documented
business warning that legitimately returns 3, declare [0, 3]; the receipt still records 3.
Do not add failure codes just to turn a failed test green. `expect` text never configures codes.

Example for an existing project-specific verification script:

```json
{ "kind": "functional", "run": "node verify.cjs", "env": { "APP_ENV": "Development" },
  "expectedExitCodes": [0, 3], "timeoutMs": 1800000,
  "expect": "assertions pass; exit 3 means only the documented data-quality warning" }
```
An execution error, timeout or output above the 4 MiB buffer limit prevents approval.
On timeout/output overflow, the engine terminates the command tree on Windows or its process
group on Unix. This does not stop commands launched separately by an executor agent.
Commands have the caller's permissions: inspect them and execute only approved, safe checks.

`--evidence` is mandatory. An unsuccessful or interrupted revalidation invalidates the
previous pass. Tests run outside the short state lock; results are discarded if the task,
reviewer, attempt or contract changed while they ran. `done` requires receipts for the current
attempt and contract, including an independent reviewer when required. Neither `--force`
nor an old bare `--ok` bypasses this gate. Receipts do not authenticate agent identities,
verify the declared check kind, or detect later source edits: the reviewer must inspect
coverage, reject zero-test runs, and revalidate after any code change.

Existing completed history is unchanged. Old plans remain readable, but their next approval
must provide typed functional steps or a justified inspection exception. Update the approved
plan through the existing workflow; do not silently reclassify tasks to make them pass.

For an approved validation change in an existing run, use
`node $ENGINE refresh-contract <task> --plan <approved-plan.json> --run <run>`.
Only validation, validationMode and inspectionReason are refreshed. State, agent, reviewer,
attempts, block reason and historical evidence remain intact. Previous receipts become stale,
including if a later refresh restores the old text. A fresh validation is required before done.
Done/skipped tasks cannot be refreshed. The command neither dispatches work nor unblocks tasks.
Do not use fail/retry solely for contract migration, redo a delivered fix, or enlarge a data
window because the skill changed. The reviewer can verify delivered code in the same attempt.
Where sync-plan exists, it preserves active/completed task contracts and reports differences;
use refresh-contract explicitly for active work instead of treating synchronization as proof.

### Pause and resume

`block` stores the current phase. Blocking an already blocked task updates the reason and keeps
the original phase. Completed/skipped tasks cannot be paused.

| Command | Result |
| --- | --- |
| `unblock <task>` | Restores pending/running/reviewing/failed without adding an attempt. |
| `unblock <task> --reviewer <agent>` | Paused running/reviewing work goes directly to independent review in the same open attempt. |

Resume reacquires capacity and checks dependencies and the active agent's availability.
Direct review needs only a total slot, not an executor slot. Existing explicit --force scheduling
overrides still apply; --force cannot manufacture an open attempt or an independent reviewer.
No command dispatches an agent. A rejected resume leaves the block reason and history intact.
Resuming pending work still needs start; failed work still needs retry before another attempt.

A legacy blocked task without a recorded phase defaults to pending only if it has never started.
Missing/invalid history on an existing attempt is refused rather than guessed. Inspect that
history explicitly. An in-flight validation spanning a pause cannot become a pass after resume;
a completed receipt remains subject to the same attempt, reviewer and contract checks as before.

Regression checks: `node --test scripts/validation.test.mjs`.

**Tuning parallelism.** `maxExecutors` (default 3) caps agents WRITING at once;
`maxParallel` (default 4) caps total busy agents (running + reviewing). The defaults are a
safe floor, not a law — a bigger machine and a wide plan can run 6+8 or more. Two things to
know when raising them: keep `maxExecutors` strictly below `maxParallel` (that headroom is
what keeps review permanently unblockable — the engine's core property), and remember the
real ceiling is usually elsewhere: the plan's dep width, your API rate limits, and token
burn scale with every extra executor.

`deps` is the whole scheduling model: a task is **ready** when every dep is `done` or
`skipped`. Serialization (e.g. migrations must never run in parallel) is expressed as a dep
chain, not as engine logic.

A task is **isolated in space, ordered in time**: it must never share a file with a task that
can run beside it (that is what `touches` checks), while depending on upstream tasks is the
whole point — an agent builds on what its deps produced.

## Driving a run

```bash
PRUMO_HOME="${PRUMO_HOME:-$HOME/.local/share/prumo}"
PRUMO_ROOT="$PRUMO_HOME/my-workspace"
mkdir -p "$PRUMO_ROOT/.specs/graph/plans" && export PRUMO_ROOT
node .claude/skills/prumo/scripts/engine.mjs init --plan "$PRUMO_ROOT/.specs/graph/plans/x.plan.json" --run x-01
node .claude/skills/prumo/scripts/engine.mjs ready                 # what can start now
node .claude/skills/prumo/scripts/engine.mjs start T1 --agent ag-server      # max 3 executors
node .claude/skills/prumo/scripts/engine.mjs review T1 --agent rev-server    # hand to a fresh reviewer
node .claude/skills/prumo/scripts/engine.mjs validate T1 --ok --evidence "reviewed the 3 behavior cases" --cwd <absolute-project>
node .claude/skills/prumo/scripts/engine.mjs done T1               # refuses without a passing validation
node .claude/skills/prumo/scripts/engine.mjs fail T2 --reason "typecheck broke"
node .claude/skills/prumo/scripts/engine.mjs retry T2              # warns after 3 attempts
node .claude/skills/prumo/scripts/engine.mjs block T9 --reason "needs dev decision" | unblock T9
node .claude/skills/prumo/scripts/engine.mjs status | graph        # human table | full JSON
```

Rules the engine enforces (everything else is the orchestrator's judgment):

- `init` refuses a plan with a dependency cycle, naming the loop (`T1 → T2 → T1`). Without
  this the run would init fine and deadlock in silence — every task on the cycle waiting for
  the others forever, and `ready` never listing them.

- `start` refuses a task whose deps are not met (override: `--force`).
- `start` refuses past `maxExecutors` (default **3**) and past `maxParallel` (default **4**)
  total busy agents (`running` + `reviewing`). `review` itself is never capacity-checked — it
  is a role handoff on a slot the task already holds — so a finished task is always judged
  immediately, and any number of reviews run in parallel. Executors are capped below the total
  on purpose: that headroom is what keeps review unblockable.
- Both refuse an `--agent` name already busy on another task: **one agent, one task**. A label
  on two concurrent tasks means either a mislabelled dispatch or one agent doing both — and
  then the parallelism is a fiction the graph would happily record as real.
- `review` refuses a reviewer that authored the task, and `done` refuses a validation recorded
  by the executor rather than a reviewer (`"requireReview": false` in the plan opts out).
  **Author ≠ verifier** is the point: a self-report is not a verdict.
- `init` refuses a plan where two tasks that can run in parallel declare overlapping `touches`
  paths — the same file handed to two agents at once. `touches` is optional (prefixes, not
  globs); a plan that omits it falls back to the dep chain as the only guard. Override with
  `--allow-overlap`, which is NOT what `--force` does (that one only overwrites an existing run).
- `done` refuses without a **passing validation recorded for the current attempt**.
- `retry` warns past 3 attempts — the loop-guard is a human/orchestrator escalation, not an
  infinite retry.

## Watching

```bash
node .claude/skills/prumo/scripts/serve.mjs      # http://localhost:4949 — polls state every 1.5s
```

The dashboard is observability ONLY. It reads the same `state.json` the engine writes and
mutates nothing — never a second source of truth, never a second orchestrator.

### Layout

The graph runs **top-down**: phases are horizontal bands, and a task's siblings spread across
its band. Direction is not a preference — cards are wide and short, so this only holds while a
phase stays under ~10 tasks; past that the band grows wider than a left-to-right column would
be tall, and the trade flips. The gain is that the result matches the shape of a screen (~2:1
against 3.5:1 sideways), so fit-to-screen lands at ~70% zoom instead of ~55%.

Bands are the plan's **phases** by default: depth-only layering scatters one phase across the
canvas (in a 36-task run, F6 landed in four separate layers and the first layer stacked 12
unrelated tasks). The header toggles back to depth layering.

Tasks are **not packed from the edge** — that is what turns a wide graph into a fan of long
diagonals. Sweeps settle the ORDER by barycentre, then each band is re-packed tight and each
node drifts toward the average X of what it connects to, bounded by its neighbours' slack: a
parent ends up centred on its children, and no band is left hollow. Two edge routes exist for
what a plain bezier would mangle: a dep inside the same band **dips below the row** (a straight
run would cross every card between the two), and a dep whose source sits in a LATER phase is
routed around the SIDE in its own colour — that one means the phase numbering hides a real
ordering constraint, worth seeing rather than smoothing over.

The **orchestrator** and the **reviewer** sit side by side above the graph: dispatch fans DOWN
from the orchestrator, and a task under review sends its line back UP to the reviewer — it must
climb back and be judged before anything below it proceeds. The reviewer deliberately does NOT
sit at the bottom: down the vertical axis means phase order, and a hub parked there reads as
"review happens after every phase", when it happens at the end of every TASK. Neither hub is
placed in the middle with the graph around it — the moment the graph encircles a hub, "before
and after" is gone, and that ordering is the one thing the graph exists to show.

### Navigating

The canvas is a whiteboard, not a scroll area: **drag** the board to pan, **ctrl/⌘+wheel** to
zoom at the cursor, plain wheel/trackpad to pan, **`0`** or the `fit` button to re-frame, `+`/`-`
to zoom. It auto-fits on first paint, so the first thing on screen is the whole graph.

Two details that are easy to break: the transform is reapplied after every tick (the 1.5s
refresh would otherwise snap the board back to the origin), and pointer capture starts only once
a pan passes the 4px threshold — capturing on `pointerdown` retargets the click and no card
would ever open. Below ~55% zoom the cards drop to **id + colour only**; a subtitle rendered at
40% scale is noise, and reading the run by colour is the whole point of being zoomed out.

Serving a run other than `CURRENT`: `node .claude/skills/prumo/scripts/serve.mjs --run <name>`.

### Results

The header's **results** button (or `r`) swaps the graph for what the run cost. Everything on
it is DERIVED from the attempt timestamps and events the engine already records — no extra
collection, no engine involvement, and nothing it cannot derive is estimated:

- **Wall clock vs agent time**, and the parallel gain between them (agent time ÷ wall clock).
- **Build vs verify** — how the agent time split between executors and reviewers. This is the
  cost question: reviewing is a real share of the bill, and it is only visible as a share.
- **Critical path** vs wall clock. The longest chain of dependent work is the floor no number
  of executors can go under, so this is what separates "add agents" from "restructure the
  plan" — if the path is ~all of the wall clock, more executors buy nothing.
- **Slots busy over the run**, sampled, with the executor cap drawn in — where the graph ran
  wide and where it ran on one thread.
- **Per task**: exec, review, time queued waiting on deps, time blocked on the dev, attempts
  and verdicts.
- **What the numbers support** — findings stated with their evidence, not advice: whether
  review cost is FIXED across tasks (the signature of running the whole suite per task,
  rather than a gate scoped to what changed), what the review gate actually caught, and which
  tasks were reviewed above the median cost and never rejected.

That last one exists for one decision: `requireReview` is authored by hand in the plan, and
the engine deliberately never decides it — an orchestrator that picks which of its own tasks
skip verification is the gate guarding itself. The tab's job is to replace the guess with the
previous run's evidence. It names candidates; the dev marks them.

Tokens are absent on purpose: the engine makes no model calls and never sees them. Read those
from the agent harness.

## License

[MIT](LICENSE)
