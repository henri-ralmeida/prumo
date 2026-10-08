# Prumo engine reference

**A foreman for your task graph**: executes an approved plan as a DAG — dispatching parallel
planners and executors, refusing to sign off any task a fresh reviewer has not inspected, and
watching the whole site on a live dashboard.

This file documents the MECHANISM (schemas, commands, states, dashboard). The workflow for each step is
in [SKILL.md](../SKILL.md) and the step references beside this file. [Português](runtime.pt-BR.md)

## Contents

- [DSH integration](#dsh-integration)
- [What it does](#what-it-does) · [What you need before running it](#what-you-need-before-running-it) · [What makes a project graph-ready](#what-makes-a-project-graph-ready)
- [Domain-neutral outcomes](#domain-neutral-outcomes) · [Mechanism vs discipline](#mechanism-vs-discipline) · [Pieces](#pieces)
- [Plan format](#plan-format)
  - [Task contract](#task-contract) — fields, structured validation, cache, deadlines, exit codes, `refresh-contract`, `sync-plan`, `show-contract`
  - [Rejection with an approved contract change](#rejection-with-an-approved-contract-change)
  - [Pause and resume](#pause-and-resume)
  - [Task-plan artifact](#task-plan-artifact) — discovery JSON, task-plan JSON, open questions, digests
  - [Dashboard startup](#dashboard-startup) · [Effective states](#effective-states)
- [Driving a run](#driving-a-run) — authorization, command walkthrough, [command reference](#command-reference), enforced rules
- [Watching](#watching) — [layout](#layout), [navigating](#navigating), [results](#results)

Install the global CLI, skill, PO First and per-user dashboard service; see the [installation guide](../README.md).

```bash
npm install -g @henri-ralmeida/prumo
```

The global npm `postinstall` configures detected supported harnesses and starts the dashboard with its read-only state view.
A local npm install is inert. Use `prumo install --all` after disabled npm scripts or to repair a new harness.
`prumo update` refreshes the CLI, skill, both READMEs, references, scripts and PO First configuration in
every registered Claude Code, Kiro, Codex, DSH, Antigravity, OpenCode and Grok Build installation. It compares managed contents, resumes a pending
activation and never downgrades a global CLI newer than npm `latest`. A damaged marker is recovered only
for its exact registered harness/path and only from a byte-verified Prumo backup.
Installation and update restart the dashboard when it is enabled, so it serves the installed version, and
preserve an explicit disable. They never restart agents. The global dashboard reads the run and offers only
the explicit user-confirmed agent-limit control; only an explicit orchestrator call to `sync-plan` reconciles
an approved plan.

### DSH integration

DSH must already be installed and detected before `prumo install --dsh`; Prumo never installs the external `@deepseek-ai/dsh` package. A nonempty `DSH_HOME` takes precedence, otherwise `~/.dsh` is used. The managed destinations are `<DSH_HOME>/skills/prumo` and the PO First block in the global `<DSH_HOME>/AGENTS.md`. Explicit installation exits nonzero without writes when DSH is absent; `--all` and `postinstall` act only on detected harnesses, while update can repair an exact detected or registered Prumo installation.

`prumo install --dsh` integrates only with an already detected external DSH installation and `prumo doctor --dsh` diagnoses that integration. It never installs `@deepseek-ai/dsh`; explicit installation fails without writes when DSH is absent. The upstream version validated for this adapter was `0.1.6-alpha.2`, still alpha/developer preview. DSH already supplies skills, instructions, subagents and workflows in applicable profiles, so Prumo does not create or edit Cordis configuration, profiles, plugins, subagents, workflows or credentials. Structural install, doctor and `dsh --profile headless --dump-config` checks do not establish a real model conversation.

### Additional harnesses

Use `prumo install --antigravity`, `prumo install --opencode` or `prumo install --grok` only after installing that harness. `prumo doctor` accepts the same flag. Automatic installation acts only on detected harnesses. Prumo installs its skill and adds a managed PO First block without replacing personal instructions or selecting a model.

| Harness | Global Prumo skill | Global PO First rules |
| --- | --- | --- |
| Antigravity IDE / 2.0 | `~/.gemini/config/skills/prumo` | `~/.gemini/AGENTS.md` |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills/prumo` | `~/.gemini/AGENTS.md` |
| OpenCode | `~/.config/opencode/skills/prumo` | `~/.config/opencode/AGENTS.md` |
| Grok Build | `~/.grok/skills/prumo` | `~/.grok/AGENTS.md` |

Antigravity installation covers both global skill locations. OpenCode respects `XDG_CONFIG_HOME` and also copies the skill into `OPENCODE_CONFIG_DIR/skills` when configured; PO First remains in the global rules location. Grok respects `GROK_HOME`. Existing project skills are refreshed only for their own registered harness; Codex and Antigravity never overwrite each other's managed `.agents/skills/prumo`.

Choose the harness's native planning mode when available, and load the Prumo skill explicitly. A read-only mode may prevent writing a plan artifact: obtain permission for that designated artifact or hand it back to the orchestrator, rather than granting broad write access or beginning execution. Prumo's discussion, planning, execution and independent review gates continue to apply regardless of model or native mode.

Official references: [Antigravity skills](https://antigravity.google/docs/skills/), [Antigravity rules](https://antigravity.google/docs/rules/), [OpenCode skills](https://opencode.ai/docs/skills/), [OpenCode rules](https://opencode.ai/docs/rules/), [Grok skills](https://docs.x.ai/build/features/skills-plugins-marketplaces), [Grok rules](https://docs.x.ai/build/features/project-rules).

## What it does

- **Research before execution** — each active phase target gets a read-only worker that records sources
  and decisions and writes its separately bound immutable execution plan.
- **One shared agent cap** — discussion, planning, execution and review use the same per-run
  `maxAgents` limit (default 3). A review is a handoff in the task's existing slot; lowering the
  limit leaves current work alive and delays only new work until occupancy is below the cap.
- **Author ≠ verifier, enforced** — every task is validated by a FRESH reviewer agent that
  never saw the code being written. `done` refuses a self-reported validation; `review`
  refuses the task's own author. Evidence is recorded per verdict.
- **Collision-proof plans** — `init` rejects dependency cycles (naming the loop) and two
  parallel tasks that declare overlapping `touches` paths, before any agent starts.
- **Live dashboard** — a dashboard server on `:4949` renders the read-only state view as phase swimlanes with
  animated dep edges, per-task state, retries and an event log. Killing it never affects a run.
- **Zero runtime dependencies** — Node.js 22+. State is plain JSON +
  append-only NDJSON in a central Prumo workspace outside project repositories.
- **Tokens are spent only by agents** — the engine and the dashboard are plain Node
  processes making no model calls. Planners, executors and reviewers (subagents) are the cost; the
  orchestrator adds a small constant overhead; watching the dashboard costs nothing.

## What you need before running it

The global scope must be approved before phase research and task execution:

1. **An approved plan** in the engine's format
   (`$PRUMO_ROOT/.specs/graph/plans/<name>.plan.json` — tasks,
   deps, validation contracts; format below). Where it comes from is up to you: a spec
   workflow's task list translated mechanically, any planning skill you already use, or
   written by hand — a plan does not require any other tooling. Without one, the skill stops
   and says so.
2. **Node.js 22+** (no project dependencies to install).
3. **An agent that can dispatch subagents** (e.g. Claude Code) to act as orchestrator,
   dedicated planners, executors and independent reviewers.

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
| `serve.mjs`      | HTTP server for the dashboard; its state view is read-only and its explicit agent-limit control delegates to the engine. Killing it never affects a run.                                                                                                                                                                                          |
| `dashboard.html` | Live view: DAG laid out as phase swimlanes (toggle to dep-depth layering), animated dep edges, lineage highlight on hover, task details in a popover beside the node (long hover peeks, click pins; side panel = run state + logs only), working/validated sub-state per running task, orchestrator heartbeat, event flashes, retries, event log. Plus a **results** tab (`r`) deriving what the run cost — see below. |

New state lives in `~/.local/share/prumo/<workspace>/.specs/graph/<run>/`, outside project
repositories. Installation migrates durable central graph-foreman data there: graph state,
saved graph backups and top-level plan or handoff files. Generated execution directories,
dependency copies and build outputs are removed only after the durable destination is verified.
`PRUMO_HOME` overrides that base; `GRAPH_FOREMAN_HOME` only locates legacy data for discovery and migration.
Stale root references follow a migrated central workspace once its old graph is absent and the new graph exists. Set `PRUMO_ROOT`
(or legacy `GRAPH_ROOT`) to an existing workspace before running commands. Existing
project-local `.specs/graph` storage remains usable in place; new project-local storage is
not created. When cwd is inside an existing workspace, the root may be omitted.
Each run contains `state.json` (source of truth) and `events.ndjson` (append-only history);
plans live in the workspace's `.specs/graph/plans/`. Node.js 22+, zero runtime dependencies.
`CURRENT` selects the default run; pass `--run <name>` on every call when several runs exist. Run names
accept letters, digits, dot, hyphen and underscore, without a leading dot or path separators. Writes use a
temporary file, a rename and a per-run lock. Validation releases the lock while its commands run and,
before recording the result, rechecks the attempt, contract, reviewer and state.

## Plan format

```json
{
  "name": "my-feature",
  "scopePolicy": "explicit",
  "maxAgents": 3,
  "phases": [{ "id": "F1", "title": "Server side" }],
  "tasks": [
    {
      "id": "T1",
      "phase": "F1",
      "title": "What this task delivers",
      "label": "Card sync",
      "summary": "Approved card details reach the customer account without a second manual step.",
      "validationSummary": "The account shows the approved card status.",
      "manualEstimate": "4h30",
      "deps": ["T0"],
      "validation": [{ "kind": "functional", "run": "pnpm test:changed", "expect": "the task-specific behavior cases pass" }],
      "writeScope": "files",
      "touches": ["supabase/functions/scenes/"],
      "sharedResources": [{ "id": "service:scenes", "access": "write" }],
      "unavailable": ["database", "manual-inspection"],
      "tags": ["migration"]
    }
  ]
}
```

## Explicit file and shared-resource scope

Every new translation of an approved plan, from any harness, sets plan `scopePolicy: "explicit"`.
Each task declares `writeScope: "files"|"read-only"|"unknown"`. `files` requires nonempty `touches`
based on investigation of the actual project, including justified new paths; never invent scope just
to satisfy validation. `read-only` forbids project file writes and uses empty or absent `touches`/task-plan `writes`;
it does not mean external resources are read-only. `unknown` is accepted at initialization and remains
visible in the dashboard, but execution waits for an approved scope contract change via `sync-plan`.
Do not automatically convert missing or unknown scope to `read-only` or edit `state.json`.

Declare task `sharedResources: [{ "id": "<stable resource id>", "access": "read"|"write" }]`.
The same table, service or environment must use the same stable id across tasks. Any writer on a shared
id requires a dependency chain; simultaneous readers are permitted. Inspect external effects as well
as files: different paths alone do not establish independence. An approved `--allow-overlap` override
can accept a conflicting graph, but runtime serializes conflicting files/resources; it does not grant
parallel writes. `writes` in task plans stays within `touches` for `files` and is empty for `read-only`.

Plans without the policy preserve legacy behavior. Adoption is an explicit contract change through
`sync-plan`, with applicable renewed approval/planning; preserve history and existing explicit gate choices.
Discussion → planning → execution → independent review remains the lifecycle, including existing user
choices to skip discussion or planning. Scope checks never waive production validation or independence.

Actual scope checks in `validate`/`done` compare files visible to Git with the `start` baseline; ignored files and external effects require independent observation. Without Git/baseline, `validate --ok --scope-evidence "<evidence and limitations>"` requires the current independent reviewer, records the limitation and never waives observed unauthorized writes. See [review.md](review.md) for evidence limits.

The attempt records the disjoint file scopes of contemporaneous executors; a new executor also updates earlier active attempts with its scope. Git observes changed paths globally, not authorship. Changes outside this task may be excluded only when they fit those recorded other scopes and the current independent reviewer supplies explicit attribution through `--scope-evidence`. The scope receipt records `excludedPaths` and the authorship limitation. Observed changes outside every authorized recorded scope always block, even with reviewer evidence. `done` requires the same delivery fingerprint and reviewer identity as the passing receipt; changes after validation require fresh verification. Ignored files are not audited automatically: the scope receipt always exposes that limitation and the independent reviewer must inspect them separately, without a mandatory `--scope-evidence` flag just for ignored paths. Unavailable Git/baseline, submodules and non-Git workspaces require explicit `--scope-evidence`, as does attribution to another executor; external-resource effects need their own observations. The fingerprint conservatively covers all Git-visible changes: any change after validation, including another executor's change, requires new validation so attribution evidence cannot become stale.

### Task contract

Every field a global planning workflow needs to emit. Initialization requires `id`, `title`
and a valid validation contract; phase planning refines each task's execution without weakening that gate.

| Field           | Type                          | Default   | Meaning                                                                                       |
| --------------- | ----------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `id`            | string                        | required  | Unique task id (`T1`, `T2`…) — referenced by `deps`                                           |
| `title`         | string                        | required  | What this task delivers, one line                                                             |
| `label`         | string                        | —         | Optional business label: 1–3 words, at most 24 characters; display only                      |
| `summary`       | string                        | —         | Required for new tasks added through `sync-plan`: 1–2 sentences stating the expected result and why it matters; optional in old stored tasks; display only |
| `validationSummary` | string                     | —         | Optional acceptance sentence for concise task views; it does not replace `validation`       |
| `manualEstimate` | number \| string            | —         | Optional estimate for doing the task by hand: whole minutes (`45`) or `4h`, `4h30`, `90m`, `45min`, `PT4H30M`; stored as whole minutes; metadata only |
| `phase`         | string                        | —         | Id of a `phases[]` entry; groups the task in status and dashboard swimlanes                   |
| `deps`          | string[]                      | `[]`      | Task ids that must be `done`/`skipped` first — the ENTIRE scheduling model                    |
| `validation`    | string \| {run, expect, kind, cacheable?, cachePaths?, cwd?, env?, shell?, expectedExitCodes?, timeoutMs?}[]    | `""`      | What must be TRUE before done. Prose, or structured steps (see below)                         |
| `validationMode` | "functional" \| "inspection" | "functional" | Behavioral checks required unless this is a justified non-runtime inspection. |
| `inspectionReason` | string | — | Required for inspection; explain why runtime behavior is unaffected. |
| `writeScope` | "files" \| "read-only" \| "unknown" | — | Required for explicit plans; file ownership, no file writes or unresolved execution scope. |
| `sharedResources` | {id, access: "read" \| "write"}[] | `[]` | Stable shared-resource ids and access; any writer requires ordering. |
| `touches`       | string[]                      | `[]`      | Path prefixes the task writes; `init` refuses parallel tasks with overlapping paths           |
| `unavailable`   | resource[]                    | —         | Resources this task cannot use: `database`, `network`, `credential`, `external-service`, `production-data`, `manual-inspection`; changing it requires fresh planning; repeated entries are stored once |
| `tags`          | string[]                      | `[]`      | Free labels (`migration`, `docs`…) — informational only                                       |
| `requireReview` | boolean                       | inherit   | Per-task override of the plan's `requireReview` (e.g. `false` for a mechanical docs task)     |
| `maxAttempts`   | number                        | `3`       | Per-task retry cap before `retry` demands escalation (`--force` overrides)                    |

`unavailable` is part of the task contract, like `touches`: changing what a task cannot use changes what
its validation can prove, so `sync-plan` treats it as a contract change and the task needs current planning.
Repeated resources are normalized to one entry, so listing a resource twice is not reported as drift.

`label`, `summary`, `validationSummary` and `manualEstimate` are metadata. Changing only them through
`sync-plan` updates the presentation (`metadataUpdated` in the sync event) without changing the contract or
invalidating planning. `manualEstimate` is a human estimate for the gains view, never a measurement; the
state keeps it as whole minutes, and invalid values (zero, negative, fractional or unreadable) are refused.

Plan-level fields: `name` (required), `description`, `phases[]` (`{id, title}`),
`maxAgents` (positive integer, default 3), `requireReview` (true), and `scopePolicy` (optional; `"explicit"`).
The old `maxParallel` and `maxExecutors` fields may remain in migrated state as compatibility metadata;
they do not control scheduling. `agentLimitHistory` records the default adopted by migration and later
user changes, including actor and time.

Display text must be nonblank when supplied. Before adding a task through `sync-plan`, the orchestrator
must fill its `summary` from the approved scope; synchronization refuses new tasks without it and
preserves the existing state. Existing stored tasks without summaries remain compatible. A text-only update through `sync-plan`
does not change the task contract or invalidate planning. The dashboard keeps the full `title`
in task details and tooltips; it shows `label` where a compact task name is useful and never
generates or truncates a replacement label.

`init` and `sync-plan` warn when a `touches` prefix is missing from the validation cwd or a step's declared
`cwd`; this does not block the plan because a new file or folder can be intentional. An inaccessible cwd
is reported as unchecked.

Keep purpose and background in `description` or referenced approved documents. Keep current,
consistent acceptance criteria in `validation[].expect` and the checks that establish them in
`validation[].run`. Superseded criteria belong in history/backups, not an active `echo` step.
An expected behavior written beside a build does not turn compilation into behavioral proof.
One functional step is only the structural minimum: the reviewer must check coverage of every
current functional criterion. Use prerequisites before dependent checks, verify actual relevant
test execution against the current delivery, and preserve prior artifacts when writing evidence.
Prefer read-only verification of delivered artifacts when sufficient; validation is not permission
to repeat operational side effects or overwrite the delivery.

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
their working directory, stdout, stderr, exit code and any execution error. Optional
`--summary "<one-sentence reviewer verdict>"` stores concise text beside the full `--evidence`;
when supplied, it must be nonblank. Every step must
return a code in its expectedExitCodes (default [0]), with no execution error or signal. `expect` describes the behavior the reviewer must check; it is not
interpreted as an assertion by the engine. Checks must assert the actual behavior or resulting
state relevant to the task, rather than merely repeat an executor report.

Before `validate --ok`, inspect the approved check output. `show-check <task> --check N --attempt K`
prints the complete stored stdout and stderr, working directory, exit code and reuse status. A fresh
review should run and inspect each approved check before recording its verdict. `validate` then reruns
them and previews up to 15 lines from functional and failed checks; `--tail 0` suppresses the preview.
Marked summary lines identify output text only and do not determine success. For a new prose-only
inspection plan, or an inspection plan with executable checks, traverse every known criterion with
`review-progress` before `validate --ok`. Legacy inspection state without a denominator keeps progress
unknown. `review-progress` records the named reviewer's report; it is not proof that the inspection
occurred or that the work passed.

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
Steps run in order and stop on the first failure. A `static` step may declare `cacheable: true`;
during another validation in the same attempt and task state, Prumo reuses its passing result
only when the contract and Git HEAD/worktree snapshot are unchanged. Functional steps always
run. Without an explicit cacheable marker, every step runs again. A cacheable static step may also
declare nonempty relative `cachePaths`. On a corrective retry with the same contract and task state,
the next reviewer reuses that passing step when the current contents under those paths match its
receipt, then resumes at the first failed or changed step. Functional and unscoped static checks
always restart on a new attempt.

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
The receipt records command, expectation, kind, directory, shell, deadline, expected codes, output, error,
signal and actual exit code; output and evidence keep their original language.
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
`skip <task> --reason <text>` requires a nonempty explicit decision and is terminal: it cannot
rewrite an already done/skipped task. If delivery or review is active, skip closes that attempt
with `result: skipped` and no fabricated validation receipt.

For an approved validation change in an existing run, use
`node $ENGINE refresh-contract <task> --plan <approved-plan.json> --run <run>`.
Only validation, validationMode and inspectionReason are refreshed. State, agent, reviewer,
attempts, block reason and historical evidence remain intact. Previous receipts become stale,
including if a later refresh restores the old text. The task's execution authorization is revoked and
preserved in authorization history whenever this contract changes; accept a fresh authorization before
starting or resuming execution. A fresh validation is required before done.
Done/skipped tasks cannot be refreshed. The command neither dispatches work nor unblocks tasks.
Do not use fail/retry solely for contract migration, redo a delivered fix, or enlarge a data
window because the skill changed. The reviewer can verify delivered work in the same attempt.
`sync-plan` refreshes active contracts while preserving their lifecycle and keeps completed contracts as
immutable history. It prints bounded per-task field changes, summarizes validation contracts without their
contents and records dependency/block-reason diagnostics in structured events. Its final line reads
`run "<run>" synced: +A, updated U, metadata M, preserved P, total T`: `metadata M` counts tasks that had at least
one metadata field applied, such as `label`, `summary`, `validationSummary` or `manualEstimate` (a task that
also changed contract fields appears in `updated` too); metadata changes are applied without invalidating
planning or execution authorization. Synchronization records the
approved definition; it is not proof that active work meets it.

Synchronization also warns when it invalidates an open discussion/planning round or a current skip; it
continues applying the approved plan. `begin-phase-discussion` closes a stale open phase round as
`superseded`, records the cause and prints it, including the contract fields `sync-plan` changed. Edit the
plan and run `sync-plan` before `begin-*-discussion`. `status` and `ready` compare the approved source with persisted task
contracts and report the task IDs and changed fields, each followed by "run sync-plan". A task new in the
approved plan is reported as not synchronized; a task missing from it is reported as missing, because
`sync-plan` refuses task removal. Missing or unreadable sources produce a short warning
without blocking either command. An open planning round shows its age and accepted artifact count (`0/N`);
a recorded batch shows `N/N`. A round that was still open when a later `sync-plan` demanded a contract
confirmation no longer counts as work in progress: `status` and `ready` show it as
`planning round <id> (<n>) is stale after a contract change; artifacts x/y`. Do not wait for its artifacts,
because `finish-phase-planning`/`finish-planning` would refuse them; begin a fresh discussion round and
confirm the changed contract as described below. When `plan-phase` received `--plan-dir`, the open round counts the
`task-plan-<id>.json` files already present in that directory instead.

Use `show-contract <task> [--diff]` to inspect the complete before/after business contract before accepting a
change. It includes full `expect` and inspection text while omitting executable `validation.run` commands.
When a contract change reopens a phase that already had a discussion, planning round or current skip, the
new discussion must ask the user to accept the changed contract. Inspect every current target, then include
the exact task/digest entries printed by `begin-phase-discussion` in `questions[].confirmsContract` on one
answered question. The engine requires all target digests to match. A skip cannot substitute for this
confirmation; after the confirmation is recorded, the usual planning skip choice remains available.

Task planning follows the same acceptance rule. If synchronization invalidates a task's current discussion,
planning round or skip after a contract change, `begin-discussion` prints its current task/digest entry.
Present the complete `show-contract <task> --diff` text and ask the user whether to accept it. Put that entry
on an answered question bound to the current discussion round. An old-round answer, stale digest or skip does
not satisfy the confirmation; once it is recorded, the usual task planning skip remains available.

### Rejection with an approved contract change

An actual unmet criterion and a request for new scope are different. A defect within the approved
scope can be corrected; explicit user steering can approve a changed criterion. Unresolved new
scope needs a decision, not a fabricated implementation failure. No special adaptation script is
required: use the existing plan editor, a unique backup and a diff/concurrent-edit check.

For a genuinely rejected delivery whose approved contract also changes:

1. Preserve the review evidence and record `fail <task> --reason <actual-unmet-criterion>`.
2. Edit the approved plan, replacing superseded criteria rather than retaining contradictions.
3. Run `sync-plan --plan <approved-plan.json>` while the task is `failed`. Inspect the task in
   `graph`: validation, dependencies and write scope must match before proceeding.
4. Run `retry <task>`, then dispatch fresh planning before `start`.

For a rejected implementation whose approved contract and plan remain current, record the reviewer's
actionable reason, run `retry`, and start the corrective executor. The engine records the immutable
plan origin as `planSourceAttempt`, the immediately rejected attempt as `correctionOf`, and binds its
reason to the next attempt. Reuse requires the complete recorded planning context to match, including
contract and planning revisions, canonical discovery, scope and dependency results. Use
`fail --plan-defect --reason "..."` when the plan itself is
wrong; retry then requires discuss and fresh planning. A missing reviewer reason also prevents reuse.

Before any review handoff, a running executor keeps ownership of recoverable obstacles. It inspects the
failure, performs targeted additional research when necessary, changes strategy within the approved
contract, tries safe alternatives and reruns relevant checks until it reasonably believes the complete
plan satisfies every criterion. Review is a validation gate, not failure triage. Blocking before handoff
is appropriate only for missing authority, an unresolved consequential decision, unauthorized destructive
risk, an external dependency unavailable after proportional attempts or evidenced impossibility. These
strategy rotations reuse the same immutable plan and never dispatch another planner for the same contract.

Use the selected `--run` on every call. `sync-plan` refreshes the complete approved contract in every
nonterminal state without changing lifecycle, agents, attempts, notes or evidence. A changed active scope
must be blocked and replanned before review or completion; done/skipped contracts remain immutable history.
If a migrated run's stored graph-foreman source is gone, sync recovers the matching plan from the central
Prumo plans directory. `retry` does not reload a plan and refuses a failed
task whose recorded contract differs from its approved source, or whose global `name`, `description`
or `requireReview` decision differs; synchronize and inspect first.
`refresh-contract` only updates validation fields; it does not record rejection. If no
implementation was rejected and only verification needs updating, refresh and review in the
same attempt instead. Completed tasks need explicit follow-up work, not rewritten history.
Prefer structured file editing. If a temporary program is needed for a large plan, verify its
backup and exact diff and remove it afterward; it is not an engine command.

Resume from persisted state rather than replaying the sequence. When `plan-task`/`start`/`review` succeeded
but native agent dispatch did not happen, complete that dispatch in the same attempt if authorized.
Confirm the actual agent handle; if dispatch is unavailable or the user paused, block with the
orchestration reason. Do not invent another failed implementation or claim an agent is running
from its engine label alone. Record corrections in notes, preserving historical attempts.

### Pause and resume

`block` is always an **external** pause and stores the current phase with `blockKind: "external"`.
That includes blocks carrying a question or options. Blocking an already blocked task updates the reason
and keeps the original phase. Completed/skipped tasks cannot be paused. An external block removes the task
from a phase round's `activeTargets` and `queuedTargets`, records `originalTargets`/`excludedTargets`, and
marks it for individual planning (`individualPlanning: true`), and prevents discussion, planning, execution,
review or activity commands until explicit `unblock`.
Direct blocked-task commands fail before mutation with `<task> is blocked: ... Use unblock before discussing,
planning, reviewing or executing.`
If a phase task is unblocked after exclusion, it is marked for its own `begin-discussion` → `plan-task` →
`finish-planning` flow within its original phase; it does not silently re-enter the old phase batch. An old blocked task with no
`blockKind` is external for compatibility; never infer an internal pause from `blockReason` text.

`pause-replanning <task> --reason <text>` is the separate internal pause. It is allowed only for an active
attempt of a task with `planningRequired`, carries no external question, and records `blockKind: "replan"`.
The same attempt may run its task planning while blocked; `finish-planning` keeps it blocked, and explicit
`unblock` resumes that attempt. This command never turns an external decision into planning work.

| Command | Result |
| --- | --- |
| `unblock <task>` | Restores pending/planning/running/reviewing/failed without adding an attempt. |
| `unblock <task> --reviewer <agent>` | Paused running/reviewing work goes directly to independent review in the same open attempt. |
| `pause-replanning <task> --reason <text>` | Pauses an active planning-required attempt internally so its plan can be refreshed before the same attempt is unblocked. |

`block --question <text>` stores the decision needed to resume, and repeatable `--option <text>`
stores its choices. When a question was recorded, `unblock` requires `--answer <text>` and appends
the reason, question, answer and time to block history. A legacy reason-only block can still use
`unblock <task>`.

Resume reacquires the shared `maxAgents` capacity and checks dependencies and the active agent's availability.
Direct review is a handoff in the same occupied task slot, not a fourth agent or a reserved review slot.
For tasks requiring planning, `--force` cannot bypass planning, dependencies, total capacity or concurrent
agent uniqueness; it cannot manufacture an open attempt or a valid review. Reducing `maxAgents` never kills
current agents; it only prevents new workers until occupancy falls below the limit.
No command dispatches an agent. A rejected resume leaves the block reason and history intact.
Resuming pending work still needs current planning before start when required; failed work still needs retry.

A legacy blocked task without a recorded phase defaults to pending only if it has never started.
Missing/invalid history on an existing attempt is refused rather than guessed. Inspect that
history explicitly. An in-flight validation spanning a pause cannot become a pass after resume;
a completed receipt remains subject to the same attempt, reviewer and contract checks as before.

Regression checks: `node --test scripts/validation.test.mjs`.

### Task-plan artifact

Before planning, inspect the tools and permissions actually available in the session. Never infer subagent
dispatch or file-write support from the harness name. If no planner subagent exists, report that limitation
and let the orchestrator plan locally using read-only project research; the local planning role may write
only the designated task-plan artifact and must not implement product work.

Each planner uses the available tools to inspect current project rules, code, artifacts, dependency outputs
and relevant sources. It may write only the exact task-plan-<id>.json file in the indicated artifact
directory. If it cannot write there, return one full JSON object per target in a block opened with ```json, with
the exact filename on the preceding line. Never abbreviate JSON or replace fields with ellipses.

The orchestrator parses each returned JSON block, decodes &gt;, &lt;, &amp; and &quot; only within JSON string
values, validates the resulting artifact, writes it under the indicated filename and then calls
finish-phase-planning or finish-planning. If parsing or validation fails, send the concrete correction back
to the planner; do not invent or patch missing plan content locally. Apply this protocol to both phase and
task-scoped planning; omit phase-only binding fields from a task-scoped artifact.

New tasks, including tasks added by `sync-plan` to old runs, receive
`discussionRequired: true`, `discoveryRequired: true` and `planningRequired: true`.
Existing tasks without that marker keep their original lifecycle and history. Do not reset
completed or active 1.2.0/legacy work on upgrade. Discovery and planner metadata are generated by the engine, not
an opt-out field in the source plan.

Planning has two levels. Global Plan/Spec mode defines and approves the graph and remains mandatory.
For runs with declared phases, discussion and planning are independent optional gates. Recommend each
gate separately from observable scope complexity, ambiguity, impact, dependencies and risk, then wait for
the user's explicit choice. Record a skip with `--reason` and `--confirmed-by-user`; execution and
independent review remain mandatory. Corrective homologation work may skip either gate only by explicit
user choice. When selected, discussion uses the visible principal conversation and each active phase target
receives one assigned read-only worker. `--agent` assignments are persisted labels, not native agent creation:
the orchestrator must create exact named agents and dispatch only active workers. The workers emit one
separately bound immutable `task-plan-<id>.json` per targeted task. A phase opens only when every
external dependency of every unfinished member is `done` or `skipped`. An external-blocked member is
excluded from the current phase targets and recorded in `originalTargets`/`excludedTargets`, so the
remaining batch can finish; it must later use the task-scoped flow after `unblock`. Internal dependencies gate execution, not planning. Independent phases can be discussed
and planned in parallel when the user chooses them, regardless of their declared order. Never move tasks
between phases or remove dependencies to bypass a blocker. An explicitly named existing task is a hard planning boundary: prerequisites,
evidence gaps and internal deliverables remain inside its single task plan, and adding helper tasks or
planning siblings requires explicit user approval. When the user chooses discussion, the conversation
loads the global context and known dependency outputs, scouts the phase and asks at least one contextual question. It
uses the host's native question UI when available or a structured text fallback in the same
conversation. Follow-up rounds continue until behavior, scope, acceptance and execution have no
consequential gray area; out-of-scope ideas are deferred.

Question routing follows the tools available in the principal session, not the harness name. Codex may
expose `request_user_input_async` outside Plan; `request_user_input` retains its own mode restrictions.
Claude Code documents [AskUserQuestion](https://code.claude.com/docs/en/tools-reference), while
[SDK integrations](https://code.claude.com/docs/en/agent-sdk/user-input) must surface user input and
cannot assume that tool is available in subagents. Kiro's documented
[built-in catalog](https://kiro.dev/docs/reference/built-in-tools/) does not establish an equivalent
question-box tool; inspect actual tools before choosing native input. Its
[/reply command](https://kiro.dev/docs/cli/chat/responding/) lets users answer chat questions point by
point. DSH likewise requires inspecting the tools actually exposed in the principal session; do not infer
a clarification wrapper from the harness name. Otherwise present What I understood, Gray areas, Suggestions and numbered Questions in the
user's language. Preserve pending questions across fallback and wait for real answers; empty results,
timeouts and suggested defaults never close discovery. These are orchestration instructions, not a
new UI supplied by the engine.

After the user chooses discussion, the orchestrator runs `begin-phase-discussion F1`; the engine persists the phase as `discussing` and
issues a `roundId` and `nonce`. The principal conversation writes discovery before dispatching a planner. Example:

Before continuing a run created by an older engine, `migrate --check` reports structural compatibility.
Every single-run engine command automatically migrates a safe pre-planning state, writes a versioned
backup, enables missing gates and leaves every phase pending without opening a discussion. Terminal tasks
stay unchanged. A task with an existing legacy attempt keeps its previous lifecycle and may resume, retry,
receive independent review and finish without retroactive discussion or planning. New or never-started
tasks receive the current gates and can proceed when their own dependencies are complete. Only an
in-flight planning workflow that cannot be mapped safely blocks migration, with a task-specific reason.
Migration also adopts `maxAgents: 3` when an old run has no shared limit, preserves the old plan fields,
tasks and histories, and appends the migration entry to `agentLimitHistory`; it does not infer a new limit
from `maxParallel`, `maxExecutors` or block prose.
If the schema is current and only the shared limit is missing, commands use the default 3 without
rewriting state on a query or refusal. Persist it explicitly with `migrate` or the board limit control.
`sync-plan` can repair approved contracts without rewriting active or terminal history.
Workspace relocation preserves dependency links without traversing their targets; internal absolute links
follow the new workspace location, and external targets remain untouched.
The skill must still inspect every nonterminal contract,
normalize obsolete or prose validation in the approved source using repository evidence, and `sync-plan`
the original run. This graph-wide contract migration does not authorize graph or planning expansion.
When the user names one existing task, keep one task-scoped discussion and planner. Otherwise the run can
adopt each eligible phase with `begin-phase-discussion F1 --adopt-legacy`. Terminal history is
untouched; every adopted nonterminal member must be pre-execution and have no open task discussion or
planning round. Unsafe adoption changes nothing.

```json
{
  "roundId": "<issued-roundId>", "nonce": "<issued-nonce>",
  "research": [{ "source": "src/import.mjs", "findings": "The importer validates before writing." }],
  "questions": [{ "question": "Should invalid input reject the whole import?", "answer": "Yes; no partial writes.", "channel": "chat-fallback", "round": 1, "roundId": "<issued-roundId>" }],
  "coverage": {
    "problem": "Partial imports leave inconsistent records.", "affected": "Operators importing rows.",
    "outcome": "Invalid input changes no stored record.", "currentBehavior": "Validation already runs before writes.",
    "desiredBehavior": "Preserve atomic rejection.", "rules": "Reject the whole input.",
    "exceptions": "None approved.", "scope": "Importer validation only.", "acceptance": "The invalid-row check passes without writes."
  },
  "decisions": [{ "question": "Allow partial import?", "answer": "No." }],
  "deferred": [],
  "executionBoundary": { "deferredToExecutor": ["T1"], "prematureTaskWork": [] },
  "closure": "The user resolved the task-specific behavior; no consequential gray area remains."
}
```

`finish-phase-discussion F1 --context <discovery.json>` requires the current receipt, nonempty light research,
at least one answered question with a positive round and `native` or `chat-fallback` channel,
all nine PO First coverage fields, resolved decisions, a `deferred` string array, an `executionBoundary`
that defers every target task to its executor, and a closure
reason. It validates everything before atomically persisting discovery and returning `ready_to_plan`.
If `prematureTaskWork` reports that discussion produced a task result, closure is refused. After the
orchestrator discloses it and receives explicit user approval, `--accept-premature-work` records the incident;
the planner treats that result as untrusted context and the executor repeats the work.
If the phase was reopened after a synchronized contract change, first run `show-contract <task> --diff` for
each target, present the full business text and ask the user to accept it. The answered discovery question
must carry `confirmsContract: [{ "task": "<id>", "digest": "<current-64-character-digest>" }]` for every
current target. Missing tasks, old digests and either discussion/planning skip leave the confirmation
unsatisfied.
The engine computes a canonical SHA-256 digest from the persisted fields and discussion receipt and
binds it to `plan-phase`. A phase round can have one native read-only worker per active target. Repeat
`--agent <task>=<native-agent>` for every target, with distinct exact names, or give one prefix and let
the engine record `<prefix>:<task>` for each target. These assignments are state records, not agent creation:
the orchestrator or harness must create native agents with those exact names and only for `activeTargets`;
`queuedTargets` remain undispatched until a slot opens. The planner workers research the current code and
contracts without editing them, then write deterministic `task-plan-<id>.json` files. `plan-phase` prints a
copyable JSON fragment for each active target; copy that task's `phaseBinding` and `unresolvedInputs` unchanged
into its artifact. `discussionRoundId` is the discussion `roundId`, or the user-confirmed `decisionId` when
discussion was skipped. Keep `plannerRound` as printed; never renumber it. Repeating `plan-phase` in the same
open round keeps the same assignments and activates the next queued wave when possible.
`finish-phase-discussion --context <discovery.json>` validates discovery only for the current active wave,
accumulates the recorded discoveries and opens the next wave until all targets are covered. Likewise,
`finish-phase-planning --plan-dir <directory>` validates only the active wave, stages its plans and opens the
next wave; only the final wave atomically records every task plan. New material uncertainty returns to
principal discovery and fresh planning.
Only the orchestrator records engine transitions. See [the workflow](discussion.md#two-planning-levels).

Example for a task with one executable validation check:

```json
{
  "summary": "Reuse the existing validation boundary to reject malformed rows before any write.",
  "research": [{ "source": "src/import.mjs", "findings": "The existing importer validates each row before writing; reuse that boundary." }],
  "decisions": [{ "question": "How should invalid rows behave?", "answer": "The approved contract requires rejection without partial writes." }],
  "steps": ["Extend the existing importer validation.", "Add the missing invalid-row scenario to the existing behavioral check."],
  "verification": [{ "criterion": "An invalid row produces the approved error and leaves stored records unchanged.", "check": 1, "requires": ["database"] }],
  "writes": ["src/import.mjs", "test/import.test.mjs"],
  "openQuestions": [],
  "phaseBinding": { "phaseId": "F1", "discussionRoundId": "<roundId-or-skip-decisionId>", "plannerRound": 1 },
  "unresolvedInputs": [{ "task": "T2", "phase": "F2", "requiredEvidence": "current terminal receipt for T2" }]
}
```

Each task plan may include a nonblank `summary` of 1–2 sentences about the chosen approach and
why it fits. Each phase task artifact requires nonempty `research` (`source`, `findings`),
`steps` (strings) and `verification` (`criterion`, `check`). Each verification item may add
`requires`, a list using the same closed resource vocabulary as task `unavailable`. When a required
resource is also unavailable, finish planning warns with its task, verification index and resource;
the warning does not reject the plan. Manual inspection is shown as pending in status and the dashboard
until the current independent reviewer records a passing inspection; no harness name implies capability.
`writes` is an optional list of safe relative file or folder paths. When present alongside task `touches`,
every write must fit one declared prefix by path segment; separators and `./` are normalized, and case is
ignored only on Windows. A missing or empty `writes` warns but remains valid for older task plans.
Every entry in the task's
`validation` array must be mapped by its **1-based numeric index**; `verification.check` does not
index `taskPlan.steps`. Use `"inspection"` only for an approved prose
inspection contract. `decisions` is an array of resolved `question`/`answer` pairs; it may be
empty. `openQuestions` entries contain `question`, boolean `blocking`, optional `answer`, and
optional `decideBy`: `"executor"` (the default), `"user-now"`, `{ "beforeTask": "T2" }`, or
`{ "beforePhase": "F2" }`. A blocking question still requires an answer before planning can
finish and is treated as due now. An unanswered nonblocking question with a future deadline does
not hold its source task; it appears when the named task or phase begins and becomes an execution
gate only at that point. `status` reports scheduled and overdue questions. Use the displayed
question reference in a later resolved decision, for example
`{ "question": "Which protocol?", "answer": "Use the existing client.", "resolvesQuestion": "T1:plan:abc123" }`.
In task-planning mode, a `{ "beforePhase": "F2" }` deadline becomes due when any task in F2 begins
discussion or planning. After a plan is recorded, `finish-phase-planning` and `finish-planning` print the
questions for the user now (with any proposed answer) and those with a later deadline, and warn when an
explicit `"executor"` question has no proposed `answer`. Only the `user-now` questions go to the user before
execution.
Never invent an answer or downgrade a consequential uncertainty to pass this check.

The engine stores each `taskPlan`, planner/timing/context metadata and immutable planning history, then
returns ordinary work to pending with effective `ready`. It verifies structure and recorded
freshness, not source truth or agent identity. The executor must read and recheck the artifact;
the fresh independent reviewer judges the delivery against approved objectives/current criteria
and can reject flawed planning. Planning does not replace a behavioral gate.

Every stored `taskPlan` has a SHA-256 `digest` of its canonical execution content, excluding
display-only summaries, recording timestamps and planner/context metadata. `start` stores the full digest in `attempts[].planDigest`;
status and the `task_start` event show its first four characters. This identity is separate from
`inputDigest`, which continues to identify dependency receipts. Older runs without either plan
digest remain readable and can start normally.

Phase plans hash task and dependency contracts without mutable delivery state. A contract change invalidates
that task and true downstream contract scopes; shared phase discovery invalidates affected nonterminal phase
plans; `--plan-defect` invalidates only that task. Ordinary findings and dependency completion do not replan.
At `start`, direct dependencies must be terminal: `done` supplies its current passing validation receipt and
`skipped` supplies an explicit waiver bound to its reason. Review, validation and completion reject a changed
input receipt. If the execution scope changes during running/reviewing,
use `pause-replanning` for the active planning-required attempt, synchronize the approved change, then
dispatch `plan-task` on that internally paused task. `finish-planning` returns it to **blocked**, preserving
the original phase, reason and open execution attempt; only explicit `unblock` resumes it. An ordinary
external `block` must be unblocked before any planning command. Do not invent fail/retry to refresh planning.
Validation-only `refresh-contract` remains possible within the same attempt and requires fresh validation.
Receipts from the old planning scope cannot approve the new scope.

Persisted task-scoped runs continue to use `begin-discussion`, `finish-discussion`, `plan-task` and
`finish-planning` with their existing dependency-ready semantics.

### Dashboard startup

`prumo dashboard enable` starts the dashboard server immediately and registers it for the current user.
On Windows, Prumo tries the `Prumo Dashboard` ONLOGON Task Scheduler task first. If Windows refuses or
cannot create that task, it automatically writes one hidden Prumo-owned launcher to the current user's
Startup folder; no administrator access is requested. The selected mechanism is persisted across status,
restart, update and reinstall. `prumo dashboard status` reports it, and `prumo dashboard disable` removes
only that registration and stops only a process whose complete absolute Node and server command is proven.
An unrelated listener on port 4949 is never terminated.

The dashboard exposes `agentUsage.used`, shared `agentUsage.maxAgents` and a per-process
`agentControlToken` through `GET /api/state`. Its local same-origin control form sends
`POST /api/agent-limit` with `Content-Type: application/json` and JSON `{ "maxAgents": N }`; it must use
the exact loopback origin and `x-prumo-control` token from that response. The server rejects every other
method, origin, token, content type, malformed or oversized body, and noninteger limit before writing; the
selected root/run must belong to the discovered catalog, so query strings cannot authorize an arbitrary path.
Valid requests delegate `set-agent-limit --max N --actor dashboard-user --confirmed-by-user` and record actor
and time in `agentLimitHistory`. A new limit applies to the next engine operation. Reducing it never kills
active agents; it only prevents new dispatch until occupancy is below the cap.

### Effective states

Task `pending` is stored; task readiness is derived from current planning and dependencies.
Before a task has a current phase plan, any unfinished external dependency of any unfinished member
blocks discussion and planning for the entire phase. Internal dependencies only gate execution.
After planning, incomplete task inputs produce `waiting`. Blocked phases include
`planningBlockedBy` with the external dependency phase IDs (or task IDs for unphased/missing dependencies).
The phase workflow persists `ready_for_discussion`, `discussing`, `ready_to_plan` and `planning`
independently, so discussion and planning can be active while a card is still `waiting` on its own inputs.

| Effective state | Meaning | Dashboard color |
| --- | --- | --- |
| `waiting` | Dependencies are incomplete | Gray |
| `ready_for_discussion` | The phase needs current discovery; dependency completion is not required | Violet |
| `discussing` | Persisted phase discussion is active in the principal conversation | Violet |
| `ready_to_plan` | Persisted phase discussion is closed; its planner may start before dependencies finish | Blue |
| `planning` | Assigned read-only phase workers are composing separate task plans; queued targets are not dispatched | Pink |
| `ready` | Ready to execute with a current plan, or original legacy readiness | Teal |
| `running` | Executor working | Amber |
| `reviewing` | Independent reviewer working | Cyan |
| `done` | Accepted delivery | Green |
| `failed` | Rejected attempt | Red |
| `blocked` | Paused pending a decision or another impediment | Purple |
| `skipped` | Explicitly skipped | Gray |

**Tuning parallelism.** `maxAgents` (default 3) is the one shared cap for active discussion,
planning, execution and review workers. `maxParallel` and `maxExecutors` in an old state are metadata
only and do not create a second cap. Lowering `maxAgents` never terminates current work; it prevents
new workers until the number of active agents is below the new limit. A review is a handoff in the same
task slot, so it does not reserve a fourth slot or require spare capacity. Phase targets beyond the active
wave remain queued and do not occupy the cap.

`deps` orders execution. Phase discussion and planning may finish before dependencies, but a task is
**ready to execute** only with a current immutable plan and every dep `done` or `skipped`.
Serialization is expressed as a dep chain, not as engine logic.

A task is **isolated in space, ordered in time**: it must never share a file with a task that
can run beside it (that is what `touches` checks), while depending on upstream tasks is the
whole point — an agent builds on what its deps produced.

## Driving a run

Event fractions show the active executor step from `taskPlan.steps`, reported through `progress`,
and the current validation check for review. Starting a planned attempt emits `[1/total]`; retries
restart that index. Validation emits started, passed, failed and reused check events automatically.
The fraction indicates position, not approval or completed checks. Legacy events without a known
total show no fraction. The legend follows the lifecycle: hollow discuss reflects the engine's
persisted `discussing` state and the orchestrator's visible principal conversation; it is not a separate agent.

`start` prints the ready `progress` line in the syntax of the shell that ran `start`: POSIX quoting when
`MSYSTEM` or `SHELL` is set (Git Bash, MSYS2, any non-Windows shell), otherwise PowerShell syntax with the
`&` call operator. Paste it into a shell of the same kind. When the executor's shell differs from the one
that ran `start`, adapt only the quoting and call operator; keep the paths, task, `--step`, `--agent` and
`--run` values unchanged.

Execution needs a saved user authorization after the approved graph is in place. Ask whether the
scope is the current run, one phase, or selected tasks, and whether dispatch should continue
automatically within that scope or wait for a user prompt each time. Record only an authorization
the user accepted:

```bash
node $ENGINE authorize --scope run --mode auto --confirmed-by-user
node $ENGINE authorize --scope phase:F2 --mode manual --confirmed-by-user
node $ENGINE authorize --scope tasks:T4,T5 --confirmed-by-user  # auto is the default
```

`authorize` stores the accepted scope, mode, time and channel; it neither starts tasks nor creates
agents. `ready` and `status` show each task's authorization, available execution slots and a
suggested action. A run with no recorded scope keeps the earlier behavior: `start` works and reports that
no scope is recorded. Once any scope exists, `start` refuses tasks outside it. In auto mode, keep filling
free slots from authorized ready tasks after review or completion; when `review` or `done` opens a slot for
authorized ready work, the engine prints the next `start` commands and records a `slot_freed` event
(`freedBy`, `cause`, `slots`, `next`). In manual mode, ask before each dispatch. A task whose contract changes in `sync-plan` or
`refresh-contract` loses its authorization until the user accepts that task again. A changed global plan decision requires
renewed acceptance for the affected nonterminal tasks; attempts already running continue under their
recorded state. In manual mode, require `--confirmed-by-user` on each `start`, `review` and `retry`, and when
`unblock` resumes an active attempt. The engine records the confirmation, authorization ID, time and
channel in the task event and the ordered `manualConfirmations[]` list on that attempt. The older singular
confirmation fields continue to show the latest value for compatibility. Auto mode needs no repeated confirmation.

```bash
node $ENGINE start T4 --agent <executor> --confirmed-by-user  # manual only
node $ENGINE review T4 --agent <reviewer> --confirmed-by-user # manual only
node $ENGINE retry T4 --confirmed-by-user                     # manual only
node $ENGINE unblock T4 --confirmed-by-user                   # resume active work
```

When `done`, `skip` or `sync-plan` makes a phase newly eligible for discussion, the engine records
`phase_eligible` with its phase, task IDs and cause and prints a suggestion. Tell the user which
phase is ready and recommend `begin-phase-discussion <phase>`; wait for the user's choice before
opening it. Eligibility alone never opens a phase.

```bash
PRUMO_HOME="${PRUMO_HOME:-$HOME/.local/share/prumo}"
PRUMO_ROOT="$PRUMO_HOME/my-workspace"
mkdir -p "$PRUMO_ROOT/.specs/graph/plans" && export PRUMO_ROOT
node .claude/skills/prumo/scripts/engine.mjs init --plan "$PRUMO_ROOT/.specs/graph/plans/x.plan.json" --run x-01
node .claude/skills/prumo/scripts/engine.mjs migrate --check          # read-only compatibility report
node .claude/skills/prumo/scripts/engine.mjs ready                 # what can start now
node .claude/skills/prumo/scripts/engine.mjs begin-phase-discussion F1 --agent T1=disc-f1-t1 --agent T2=disc-f1-t2 # exact native worker names
node .claude/skills/prumo/scripts/engine.mjs skip-phase-discussion F1 --reason "The approved contract is clear" --confirmed-by-user # after explicit user choice
node .claude/skills/prumo/scripts/engine.mjs finish-phase-discussion F1 --context <discovery.json>
node .claude/skills/prumo/scripts/engine.mjs plan-phase F1 --agent T1=plan-f1-t1 --agent T2=plan-f1-t2 --plan-dir <artifact-dir>  # dir optional
# A single prefix, for example --agent plan-f1, records plan-f1:T1, plan-f1:T2, and so on.
node .claude/skills/prumo/scripts/engine.mjs skip-phase-planning F1 --reason "The global contract is sufficient" --confirmed-by-user # after explicit user choice
node .claude/skills/prumo/scripts/engine.mjs finish-phase-planning F1 --plan-dir <artifact-directory>
node .claude/skills/prumo/scripts/engine.mjs start T1 --agent ag-server      # shared maxAgents cap
node .claude/skills/prumo/scripts/engine.mjs progress T1 --step 2 --agent ag-server  # actual executor report
node .claude/skills/prumo/scripts/engine.mjs review T1 --agent rev-server    # hand to a fresh reviewer
node .claude/skills/prumo/scripts/engine.mjs review-progress T1 --step 1 --agent rev-server # after inspecting check 1
node .claude/skills/prumo/scripts/engine.mjs show-check T1 --check 1 --attempt 1 # full stored output
node .claude/skills/prumo/scripts/engine.mjs validate T1 --ok --summary "The import rejects invalid rows before writing." --evidence "reviewed all 3 behavior cases" --cwd <absolute-project> --tail 15
node .claude/skills/prumo/scripts/engine.mjs done T1               # refuses without a passing validation
node .claude/skills/prumo/scripts/engine.mjs fail T2 --reason "typecheck broke"
node .claude/skills/prumo/scripts/engine.mjs retry T2              # warns after 3 attempts
node .claude/skills/prumo/scripts/engine.mjs block T9 --reason "needs dev decision" --question "Which policy applies?" --option "Keep current" --option "Adopt proposed"
node .claude/skills/prumo/scripts/engine.mjs unblock T9 --answer "Keep current"
node .claude/skills/prumo/scripts/engine.mjs pause-replanning T9 --reason "approved contract changed during the active attempt"
node .claude/skills/prumo/scripts/engine.mjs set-agent-limit --max 3 --actor dashboard-user --confirmed-by-user
node .claude/skills/prumo/scripts/engine.mjs status | graph        # human table | full JSON
node .claude/skills/prumo/scripts/engine.mjs status --verify-install # also compare installed files with the marker
```

The first `status` line identifies the running code: `Prumo <version> (<contentId>) — <harness>`, read
from the installation marker beside `scripts/`. A source checkout reports its computed content ID and no
harness. An old marker without `contentId` asks for `prumo update`. When the running `engine.mjs` differs from
the marker's `engineHash`, `status` warns without blocking; `status --verify-install` recomputes the content
ID of the installed files. `prumo status --verify-install` checks every registered installation.

### Command reference

Resolve `scripts/engine.mjs` from the installed skill. Add `--run <name>` to select a run.

| Command after `node <ENGINE>` | Effect |
|---|---|
| `init --plan <file> --run <name> [--cwd <project>]` | Initializes a run of the approved plan and records its project directory for touches diagnostics |
| `migrate [--check]` | Migrates a safe legacy schema with a backup; `--check` only diagnoses |
| `status`, `ready`, `graph`, `runs` | State, work ready now, full JSON or the list of runs |
| `status --verify-install` | Also compares the installed files with the installation marker |
| `authorize --scope run\|phase:<phase>\|tasks:<T1,T2> [--mode auto\|manual] [--channel <name>] --confirmed-by-user` | Records the dispatch scope and mode the user accepted; `auto` is the default |
| `show-contract <task> [--diff]` | Shows the business contract before/after without `validation.run` commands |
| `show-check <task> --check <N> --attempt <K>` | Shows the stored check's stdout, stderr, directory, exit code and reuse status |
| `begin-phase-discussion <phase> [--agent <task>=<name>]... [--adopt-legacy]` | Persists the phase discussion and exact per-target worker assignments; one unqualified name expands to `<name>:<task>` |
| `skip-phase-discussion <phase> --reason <text> --confirmed-by-user` | Records the explicit choice to skip the phase discussion |
| `finish-phase-discussion <phase> --context <discovery.json> [--accept-premature-work]` | Validates discovery for the active wave, accumulates it and opens the next wave when needed |
| `plan-phase <phase> --agent <task>=<name>... [--plan-dir <directory>]` | Records distinct per-target read-only workers; only active targets are dispatched and the optional directory lets status count artifacts |
| `skip-phase-planning <phase> --reason <text> --confirmed-by-user` | Records the explicit choice to skip phase planning after the discussion decision |
| `finish-phase-planning <phase> --plan-dir <directory>` | Validates/stages the active wave and opens the next; the final wave atomically records every task plan |
| `begin-discussion <task> [--adopt-legacy]` | Persists an active task discussion; the option adopts only an eligible legacy task |
| `skip-discussion <task> --reason <text> --confirmed-by-user` | Records the explicit choice to skip the task discussion |
| `finish-discussion <task> --context <discovery.json>` | Validates the current round's answers and releases planning |
| `plan-task <task> --agent <name> [--context <file>] [--accept-premature-work]` | Records the planner after the discussion closed |
| `skip-planning <task> --reason <text> --confirmed-by-user` | Records the explicit choice to skip task planning |
| `finish-planning <task> --plan <artifact.json>` | Checks and records the task plan; releases execution unless a preserved pause remains |
| `set-agent-limit --max <N> --actor <name> --confirmed-by-user` | Records a user-approved shared per-run agent limit and its actor/time in `agentLimitHistory` |
| `start <task> --agent <name>` | Records the executor and opens an attempt (`--executor` is an alias) |
| `activity-start <id> --scope task\|phase --role discussion\|planning\|execution\|review --agent <name>` | Starts a real work interval for the active round; phase workers must use the exact task ID and assigned worker name (or the exact phase ID and worker name) |
| `activity-stop <id> --scope task\|phase --role discussion\|planning\|execution\|review --agent <name>` | Closes that interval before waiting, pausing or finishing; use the same exact task/phase ID and assigned worker name, then start a new interval after resume |
| `progress <task> --step <index> --agent <executor>` | Records the current plan step during execution, starting at 1 |
| `review <task> --agent <name>` | Hands the work to review |
| `review-progress <task> --step <index> --agent <reviewer>` | Records the criteria traversed in review, in order |
| `validate <task> --ok --summary <sentence> --evidence <text> --cwd <directory> [--tail <lines>]` | Runs the contract, stores the short summary and complete evidence, previews up to 15 lines; a real failure prevents approval |
| `validate <task> --failed --summary <sentence> --evidence <text>` | Records a rejection with an optional summary and complete evidence |
| `done <task>` | Completes with valid evidence from the current attempt and reviewer |
| `fail <task> --reason <text> [--plan-defect]` | Records a real attempt failure; `--plan-defect` marks the plan itself as wrong |
| `retry <task>` | Returns failed to pending; reuses the current plan only for a bounded correction with unchanged context and a valid review reason |
| `block <task> --reason <text> [--question <text>] [--option <text>...]` | Pauses, preserving the previous phase and, when given, the decision needed to resume |
| `pause-replanning <task> --reason <text>` | Internally pauses an active planning-required attempt so task planning can refresh before the same attempt resumes |
| `unblock <task> [--answer <text>]` | Restores the previous phase; records question and answer in history when there is a decision |
| `unblock <task> --reviewer <name>` | Takes a paused active attempt directly to review |
| `skip <task> --reason <text>` | Skips once by a nonempty explicit decision; an active attempt ends as skipped without a fabricated receipt |
| `note <task> --text <text>` | Appends a note to history |
| `refresh-contract <task> --plan <approved-file>` | Updates only validation, validationMode and inspectionReason |
| `sync-plan --plan <approved-file> [--cwd <project>]` | Adds tasks and reconciles the allowed changes; uses the recorded project directory unless explicitly replaced |

`--force` never approves lint as functional proof, never completes with an invalid receipt or a
self-review. Explicit scheduling exceptions (`--allow-overlap`) and overwriting an initial run need the
relevant authorization.

Rules the engine enforces (everything else is the orchestrator's judgment):

- `init` refuses a plan with a dependency cycle, naming the loop (`T1 → T2 → T1`). Without
  this the run would init fine and deadlock in silence — every task on the cycle waiting for
  the others forever, and `ready` never listing them. Duplicate IDs and unknown dependencies are
  refused too.

- Phase discussion and planning do not require completed task dependencies. `start` does: it requires
  a current per-task plan and binds current validated or explicitly waived direct-dependency receipts.
  `--force` cannot bypass planning or those receipts.
- `start` and every new discussion/planning worker refuse when active occupancy reaches shared
  `maxAgents` (default **3**). `review` is a handoff in the task's existing slot, so it does not reserve
  a fourth agent or require a separate review quota. A lower limit leaves active work running and waits
  for occupancy to fall before opening new work; phase targets still in `queuedTargets` do not count.
- Planning, execution and review refuse an agent already busy on another task: **one agent, one task**. A label
  on two concurrent tasks means either a mislabelled dispatch or one agent doing both — and
  then the parallelism is a fiction the graph would happily record as real.
- `review` refuses a reviewer that authored the task, and `done` refuses a validation recorded
  by the executor rather than a reviewer (`"requireReview": false` in the plan opts out).
  **Author ≠ verifier** is the point: a self-report is not a verdict.
- `init` refuses a plan where two tasks that can run in parallel declare overlapping `touches`
  paths — the same file handed to two agents at once. For legacy plans, `touches` is optional (prefixes, not
  globs); a plan that omits it falls back to the dep chain as the only guard. Override with
  `--allow-overlap`, which is NOT what `--force` does (that one only overwrites an existing run).
- `done` refuses without a **passing validation recorded for the current attempt**.
- `retry` warns past 3 attempts — the loop-guard is a human/orchestrator escalation, not an
  infinite retry.

## Watching

```bash
node .claude/skills/prumo/scripts/serve.mjs      # http://localhost:4949 — polls state every 1.5s
```

The dashboard is observability plus an explicit user-confirmed agent-limit control. Its state view reads the
same `state.json` the engine writes; the limit control delegates `set-agent-limit` to the engine and never
becomes a second source of truth or a second orchestrator.

The managed service is `prumo dashboard enable` (`prumo dashboard status` reports it; plain
`prumo dashboard` runs it in the foreground). Its default address, `http://localhost:4949`, is restricted
to the local machine; a taken port never terminates another process. The language follows the
installation preference or an explicit run choice; there is no browser selector. User text is escaped and
never translated. The derived numbers do not prove test coverage, defect causes or business rules.
Stopping the dashboard never cancels work.

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

The **planner**, **orchestrator** and **reviewer** sit above the graph, with role connections
to their active tasks. Task details show the planner, sources/findings, decisions, execution
steps, verification mapping and open questions. Labels and distinct colors separate ready to
plan, in planning and ready to execute without replacing existing states.

### Navigating

The canvas is a whiteboard, not a scroll area: **drag** the board to pan, **ctrl/⌘+wheel** to
zoom at the cursor, plain wheel/trackpad to pan, **`0`** or the `fit` button to toggle between
the complete graph and a centered 100% view, `+`/`-` to zoom. It auto-fits on first paint, so
the first thing on screen is the whole graph.

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
- **Plan vs build vs verify** — agent time split between planners, executors and reviewers;
  planning time excludes paused intervals. This is the
  cost question: reviewing is a real share of the bill, and it is only visible as a share.
- **Critical path** vs wall clock. The longest chain of dependent work is the floor no number
  of executors can go under, so this is what separates "add agents" from "restructure the
  plan" — if the path is ~all of the wall clock, more executors buy nothing.
- **Slots busy over the run**, sampled, with the executor cap drawn in — where the graph ran
  wide and where it ran on one thread.
- **Per task**: planning, exec, review, time queued waiting on deps, time blocked on the dev, attempts
  and verdicts.
- **What the numbers support** — findings stated with their evidence, not advice: whether
  review cost is FIXED across tasks (the signature of running the whole suite per task,
  rather than a gate scoped to what changed), what the review gate actually caught, and which
  tasks were reviewed above the median cost and never rejected.

That last one exists for one decision: `requireReview` is authored by hand in the plan, and
the engine deliberately never decides it — an orchestrator that picks which of its own tasks
skip verification is the gate guarding itself. The tab's job is to replace the guess with the
previous run's evidence. It names candidates; the dev marks them.

The engine does not measure tokens or call models. Read consumption from the harness;
optional `report-usage` receipts store explicitly supplied counts, identified as reported.

## License

[MIT](../LICENSE)

## Optional evidence and run controls

Existing plans remain valid. No new field is mandatory, no update recreates a run or
fabricates attempts, and stored contracts, authorization, dependencies and history are preserved.

| Feature | Interface | Default and behavior |
|---|---|---|
| Run selection | `--run name`, `-r name`, `PRUMO_RUN`, `CURRENT` | Precedence in that order; both CLI flags are the same option (duplicates refused). Same safe slug validation applies to all sources and init. Init keeps CURRENT selection. |
| Engine briefing | `brief T1 --role executor\|reviewer` | Current persisted contract, checks, task-plan or skip receipts, dependency deliveries if recorded, relevant receipts and last rejection. Shell-appropriate quoted commands. No executor persuasion, invented paths or borrowed reviewer experiences. |
| Role preferences | Optional `rolePreferences` in plan; `set-role --role review --model name --effort high` | Roles: discussion, planning, execution, review. Applies to future dispatches only, with history; authorization and contracts are unchanged. |
| Dispatch metadata | `--model name --effort high` on assignment commands | `modelDispatches` records requested preference and supplied dispatch values on attempts/workers. Missing values are null; these are reports, not verified model calls. Status/brief show both. |
| Whole-run pause | `pause-run --reason text [--until future-ISO-timestamp]` | Preserves task states, rounds, queue and external blockers. Closes open activity, discounts recorded pause and stops new dispatch/ready suggestions. Until is a forecast, never automatic resume. Does not stop external harness processes. |
| Explicit resume | `resume-run` | Keeps history/attempts and applies current agent limits on subsequent dispatch. Does not implicitly restart measured activity. |
| Reported usage | `report-usage T1 --role execution --attempt 1 --receipt id --tokens 100 --tools 3` | Optional nonnegative integer counts on an attempt/worker. Same receipt is idempotent, conflicting reports refused. Summed by task/run without validate/done duplication; no financial cost or independent measurement claim. Specify phase round attempt explicitly for workers. |
| Check query | `show-check T1 [--attempt K] [--check N]` | No check lists attempts/checks with exact commands. Without attempt, a selected check uses the latest recorded execution attempt, never an older validation fallback. Missing current receipts and invalid indices explain available choices. Full receipt output is preserved. |

### Delivery identifiers

Before review or direct reviewer handoff, inspect new/changed or explicitly declared delivery filenames and added lines inside
approved touches against the pre-start baseline. Task/phase ids, run and plan names are
case-insensitive literals with letter/digit boundaries (underscore separates identifiers).
Common role words are not indiscriminately prohibited. Baseline stores line hashes, not source text;
identical pre-existing lines are discounted by occurrence. Review remains independent.

Optional task fields: `deliveries: ["out/result.json"]` includes declared ignored artifacts;
`textRules: { "patterns": ["internal-literal"], "exceptions": [{ "path": "out/example.json", "line": 4, "identifier": "T6" }] }`.
Patterns/exceptions are bounded to 64; literal strings to 128 characters. Exceptions match
one path, line and identifier; line 0 means filename. All declared paths must be inside touches.
These are contract fields, updated through approved sync-plan and existing gates.
Links and linked parents are refused. Binary content is omitted with a recorded limitation.
Reading limits: 256 files, 1 MiB per file, 8 MiB total. Errors contain path/line, never source content.
Without Git, traversal stays under approved touches and visits at most 4096 entries.
Legacy attempts without a baseline check only explicitly recorded deliveries and report that
limitation. Missing file scope/cwd never invents a baseline. validate/done check freshness again.

### Executable numeric provenance

Optional task contract: `numericProvenance: { "manifest": "out/provenance.json", "sources": ["data/input.json"] }`.
The delivered JSON manifest has 1–256 `claims`, each with `source`, JSON Pointer `pointer`,
`operation` (`value`, numeric array `sum`, array `count`), numeric declared `value`, and
`result: { "source": "out/result.json", "pointer": "/total" }`.
Origin must be explicitly approved; manifest/results must be inside touches. Empty pointer
selects the document, `~0`/`~1` escape tilde/slash. Missing evidence, invalid reference,
malformed JSON or divergent source/calculation/result is refused by `verify-provenance T1`
and validate. Sources are fingerprinted before/after executable checks and again at done;
even a concurrent edit preserving the total invalidates obsolete evidence. The checker does
not infer every number in prose or treat a dependency receipt as proof of a count.
Without this field, historical contracts gain no mandatory numeric gate.
Explicit `verify-provenance` refuses a missing numeric contract; ordinary historical validation remains unchanged.

### Recorded durations

The activity panel sums each agent by role; phase workers replace, rather than add to,
the phase envelope. Explicit intervals show measured active work. Empty intervals with
valid stage timestamps show recorded stage duration, which may include waiting and is
not measured work or measured savings. The live clock unions stage intervals across roles
and discounts recorded pauses/blocks: three workers for ten minutes means thirty summed
minutes and ten elapsed. Missing evidence/partial history is labeled honestly.

### Shell filter diagnostics

Doctor accepts `--shell-filter-config file.json` and `--shell-block-evidence file.json`, each
bounded to 64 KiB. Accessible configuration shape:
`{"allowedCommands":["approved command"]}`. This identifies the
list but does not establish a runtime block. Recorded evidence shape:
`{"decision":"blocked","command":"node scripts/engine.mjs ready"}`.
Relevant block evidence permits advising an allowed-list adjustment, never bypassing the
filter. The report's origin is not authenticated. Without relevant evidence or configuration, this diagnostic stays silent.

### Planning feedback and artifact identity

Finishing planning warns when an open question literally repeats an answered discussion
question or decision, ignoring case and whitespace. It is advisory: no answer, semantic
equivalence or resolution is inferred, and the original question stays recorded. Contract
decisions phrased differently still require human inspection of the current briefing.

New task plans record the artifact's actual `sourcePath`. Start, corrective retry and brief
show the approved embedded plan's full digest, source attempt and phase planner round.
An old plan with no source path reports null; the engine does not invent one or reload a
changed artifact to silently replace the approved plan. Source path is provenance metadata,
not evidence that the file's present contents still match the embedded plan.

If the planner cannot write, return complete JSON on stdout with the designated
`task-plan-<task>.json` filename. The orchestrator saves that exact artifact and invokes
the existing finish command. Empty output is not a plan; normal schema, binding, freshness,
authorization and independent review gates still apply. Phase dispatch prints this route.

Declared deliveries are inspected in full, including preexisting contents; unrelated unchanged baseline lines stay discounted. For historical phase rounds without workers, usage can be attached to the existing round only when its recorded targets include the task; `--phase` disambiguates phase history. Aggregate tokens/tools must stay within safe integer limits.

After explicit run resume, a checkpoint closed by pause contributes new recorded stage duration until the next checkpoint or stage end; it does not create measured work. Stored task-plan timestamps can supply a partial historical planning duration when no planning round exists; no attempts are invented.

Each task may declare optional `project`, an absolute Git repository root. Its `touches` and delivery paths are relative to that root; never use `..` or absolute touches. Tasks without `project` retain the run project. `start` does not accept `--cwd`: it captures the approved task project automatically. `validate` defaults to this project, while step.cwd or --cwd selects the command directory and warns on a different explicit --cwd; scope and delivery evidence remain bound to the approved project. Shared resource IDs remain global across repositories. Changing project via sync-plan changes the task contract and requires replanning.
