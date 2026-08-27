---
name: graph-foreman
description: Executes an approved plan as a task GRAPH — orchestrator + parallel subagents, validation before any task counts as done, live dashboard. Use for any plan big enough that the order of work matters.
---

# /graph-foreman [plan|run]

![Live dashboard of a run: phase swimlanes, parallel executors, a task under review](https://raw.githubusercontent.com/JrSantiaggo/graph-foreman/media/dashboard.png)

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

Argument: a plan file, a run name to RESUME, or nothing (then `.specs/graph/CURRENT`). With
neither, do not guess — use the plan this session just produced, or ask where it lives, naming
any candidates you found. The source plan lives wherever the project keeps it; only run state
is fixed at `.specs/graph/`.

## 0. Resolving the engine

The scripts live under `scripts/` in **this skill's own directory** — resolve them relative to
where this `SKILL.md` sits, never the workspace root, never a fixed install path:

```bash
ENGINE="<this skill's directory>/scripts/engine.mjs"    # e.g. .claude/skills/graph-foreman/scripts/engine.mjs
SERVE="<this skill's directory>/scripts/serve.mjs"
```

Node 18+, no npm install. State lives in `.specs/graph/` at the **project root**, discovered by
walking up from cwd to the first `.git` or `package.json` (`GRAPH_ROOT` overrides). **`.specs/`
must be gitignored** — run state is local scratch; `init` warns when it is not.

## 1. The plan file

Plans live in `.specs/graph/plans/<name>.plan.json`. Translation is mechanical; three fields
carry judgment:

- **`deps` is the entire scheduling model.** A task is ready when every dep is `done` or
  `skipped`. Anything that must not run in parallel is a dep chain — migrations serialize
  because each depends on the last, not because the engine knows what a migration is. A dep
  added "to be safe" costs parallelism; one omitted hands two agents the same file.
- **`validation` is what must be TRUE before done**, written so a DIFFERENT agent could check
  it. "tests pass" is not that; "suite green + the 3 new cases named in the task" is. When the
  contract is executable, prefer `[{ "run": "<command>", "expect": "<what green means>" }]` so
  the reviewer runs exactly what is written instead of interpreting prose.
- **`touches` lists the path prefixes the task writes.** `init` refuses two parallel tasks with
  overlapping paths, catching the collision while it is still a planning mistake. Optional;
  omitting it leaves the dep chain as the only guard.

A task is **isolated in space, ordered in time**.

Full task contract (every field, defaults, per-task `requireReview`/`maxAttempts`) and the CLI:
[README.md](README.md) beside this file.

## 2. Start the run AND the dashboard

```bash
node $ENGINE init --plan .specs/graph/plans/<name>.plan.json --run <name>-01
node $SERVE     # http://localhost:4949 — background, read-only, safe to kill anytime
```

Start the server **in the background and give the dev the URL before dispatching a single
agent** — a dashboard offered after the run is a log, not observability. It follows
`.specs/graph/CURRENT`, which `init` just repointed at this run. A taken port usually means the
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
node $ENGINE validate T4 --ok --evidence "..."  # the REVIEWER's verdict
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

Each executor gets the task and nothing else about the run:

```text
You are the EXECUTOR for <T4>: <title>. Deliver exactly that, then stop.
Read the project's agent rules first.
Write ONLY under: <touches>  — another executor owns the rest, right now.
Build on what these already produced: <deps>.
Your work must satisfy, clause by clause: <validation>
  A DIFFERENT agent checks your diff against that contract and never sees this message.
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

### What the reviewer gets, and what it decides

The task's **validation contract** and the **diff** — and nothing about how the work went. The
executor's narrative is the thing most likely to talk it into a pass. The reviewer runs the
project's gate ITSELF (see Project overrides), checks the contract clause by clause, and
answers `--ok` or `--failed`.

```text
You are the REVIEWER for <T4>: <title>. You did NOT write this code.
Judge this diff: <the paths under `touches`>
Against this contract, clause by clause: <validation>
Run the gate YOURSELF: <Project overrides>. Reproduce it — never accept a claim.
Answer:
  verdict:  ok | failed
  evidence: what you RAN and what it ANSWERED — commands and counts, not impressions.
  if failed: what is missing, specific enough for the next executor to act on.
```

What is absent from that message is the point: no executor report, no attempt count, no "the
suite was already green". A fresh agent, a clean context, and the contract.

- **`--evidence` is a claim the reviewer is making**: what was run, and what it answered.
  `done` refuses without a passing review validation for the CURRENT attempt — the one rule
  that stops "it looks right" from becoming state.
- **Rejected** → `fail T4 --reason "review: <what is missing>"` then `retry T4`. The reason
  travels to the next executor; a rejection with no actionable reason wastes an attempt.
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
