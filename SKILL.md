---
name: prumo
description: Executes an approved global plan as a task GRAPH — optional user-decided phase discussion and planning, persistent executors, and mandatory independent review before done. Includes PO First and a live dashboard.
---

# /prumo [plan|run]

Runs an **already approved** global plan through the graph engine bundled with this skill: a DAG of
tasks, optional phase discussion and read-only planning chosen explicitly by the user, parallel executors, a validation gate before anything
is `done`, and a dashboard for observing work and adjusting its agent limit through the engine.

This file is the router: it says what to do in each state and which reference holds the detail. Read a
reference when the state machine below sends you there, not up front.

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

Apply [PO First](references/po-first.md), also configured globally by the installer, in every role. Respond in the user's language. A functional check means evidence of the requested effect, whether the work concerns data, automation, migration, software, or another domain. Use the host's native subagent tools; if dedicated planning, execution or independent review are unavailable, report that limitation rather than inventing agent dispatch. The engine records transitions; it does not create agents. In Codex invoke this skill as `$prumo`; Claude Code, Kiro and DeepSeek Harness (DSH) use `/prumo`. DSH integration (`prumo install --dsh`, `prumo doctor --dsh`, `DSH_HOME`) is described in [runtime.md](references/runtime.md#dsh-integration).

Antigravity e Grok Build também permitem `/prumo`. No OpenCode, peça ao agente para carregar a skill
`prumo` com sua ferramenta nativa de skills. Os modos nativos de planejamento não substituem os gates
do Prumo nem autorizam gravações: confira as permissões reais antes de produzir os artefatos aprovados.
Consulte [as integrações](references/runtime.md#additional-harnesses) para os diretórios de instalação.

**Open the discussion before asking its questions.** When creating or updating tasks from an approved
global plan, collect unresolved phase/task questions instead of starting discovery during graph authoring.
Keep them with the plan context; after `init` or `sync-plan`, persist them with `note <task> --text`.
Recommend discussion for the eligible phase, obtain the user's gate choice, and successfully run
`begin-phase-discussion` (or `begin-discussion` for task-scoped runs) before asking its first question.
General "confirm understanding before acting" guidance does not move phase discovery outside this round.
Questions necessary to approve the global scope or authorize a contract change, gate choices and recorded
execution blockers still belong in their respective flows. Reuse prior answers as settled context and
record them in discovery `decisions`/`coverage`; do not repeat settled questions or attach the current
`roundId` to an answer received before the round. The current round still needs its own freshly answered
question. Read [discussion.md](references/discussion.md) for recording and skip rules.

**Identificadores estáveis.** No plano inicial, use `T1`, `T2`, ... sem lacunas ou letras.
Declare as fases na ordem do plano com `F1`, `F2`, ...; novas fases usam o próximo número.
Novos planos não podem usar `HO1`, `REL1`, `T01`, `F0`, `F1B` ou outros formatos legados.
Nomes antigos persistidos permanecem legíveis; uma padronização deles exige uma migração explícita
das referências, preservando o conteúdo das tarefas e as provas já registradas.
Ao ampliar o plano por `sync-plan`, preserve os números originais: uma correção vinculada a `T9`
usa `T9a`, a próxima `T9b`, até `T9z`. Toda derivada permanece na mesma fase original de `T9`;
não crie uma fase nova para acomodar letras e não mova a tarefa-base para contornar essa regra.
Registre a ligação nas dependências: se a correção
destrava `T9`, `T9` depende de `T9a`; se é um complemento posterior, `T9a` depende de `T9`.
Nunca crie esse vínculo nos dois sentidos, pois isso gera um ciclo. Tarefas já concluídas mantêm
seu contrato; uma ampliação posterior precisa depender delas. Execuções antigas preservam seus
identificadores existentes. O motor recusa novas numerações incrementais durante a sincronização.

**Role-written summaries.** Before creating or synchronizing a new task, the orchestrator must write a
nonblank `summary` of 1–2 sentences stating the expected result and why it matters, using the approved
scope. If it is missing, fill it before `init` or `sync-plan`; a warning is not permission to leave it
empty. `sync-plan` refuses newly added tasks without it. Do not invent scope or substitute a generic
placeholder. An existing task being updated should also receive its missing summary through metadata
synchronization without rewriting its historical contract. For every new task, write an approved
business `label` (1–3 words, at most 24 characters); a one-sentence `validationSummary` may describe
acceptance. Write only text the approved scope supports. Use the label to identify the topic briefly
and the summary to explain the result and purpose,
including relevant effects or acceptance conditions rather than merely paraphrasing the title. Preserve
approved titles and summaries; do not rewrite stored task text automatically to remove repetition. They are display
text: changing them alone changes neither the contract nor planning authorization. Do not invent, generate
or truncate a label to fill a missing one. The planner writes `taskPlan.summary` (1–2 sentences: chosen
approach and why it fits); the executor reports a 1–2 sentence outcome and why for `task.summary`, which the
orchestrator may synchronize without changing the approved contract; the reviewer supplies a one-sentence
PO First verdict through `validate --summary` and keeps `--evidence` as the complete behavioral
observations. Old stored tasks without summaries remain readable; summaries supplied in a plan must be nonblank.

**Traceability stays out of the product.** When the orchestrator writes or synchronizes a task contract,
it keeps traceability there: task and round ids, process names, who decided and when belong in the
contract, task notes or the commit, never in the delivered product text. State that explicitly in the contract so the executor and reviewer
apply it. Record the area that owns a business rule only when approved context confirms it; otherwise ask
the PO before naming an owner.

## References — read when the step needs them

| Reference | Read it when |
| --- | --- |
| [po-first.md](references/po-first.md) | Always in force for every role (installed globally) |
| [discussion.md](references/discussion.md) | A phase/task is `ready_for_discussion` or `discussing`; the user must choose discuss/plan or skip; a `phase_eligible` event appears |
| [planning.md](references/planning.md) | `ready_to_plan` or `planning`: dispatching the planner (prompts in English and Portuguese), recording task plans, open questions, pre-start baseline |
| [dispatch.md](references/dispatch.md) | Recording the execution authorization; `ready`/`running`: executor prompt, obstacles, progress, capacity, interruptions |
| [contracts.md](references/contracts.md) | Writing, translating or adapting `validation`; checking the plan's behavioral checks before the first dispatch |
| [review.md](references/review.md) | `reviewing` or a validation receipt exists; `validate`/`done`; a verdict failed or the task is `failed` |
| [recovery.md](references/recovery.md) | `blocked`; a user decision is needed; the plan changed after `init`; resuming or migrating an existing/legacy run |
| [runtime.md](references/runtime.md) | Exact plan/task-plan/discovery schemas, CLI flags, effective states, dashboard |

Each reference has a Portuguese counterpart beside it (`*.pt-BR.md`) with the same content.

## Invocation router

The top-level Prumo skill is the orchestrator. On every invocation, inspect the user's requested
scope, the approved source plan, persisted `status`/`ready`, dashboard `/api/runs`, and actual native
agent state before selecting exactly one current flow:

| Observed context | Route | Read |
| --- | --- | --- |
| No approved global plan | Global planning and user approval; do not initialize or dispatch | — |
| Approved plan, but no persisted run | Storage/dashboard bootstrap, then `init` and visibility verification (§0–§2); the state machine below then leads through discussion, planning and dispatch | contracts.md |
| Existing run, first command this session | Compare the `status` version line; check legacy contracts and plan drift | recovery.md |
| `ready_for_discussion`, `discussing`, `discussed`, `ready_to_plan` or `planning` | Ask for the independent discussion/planning decisions, then follow or explicitly skip each gate | discussion.md, planning.md |
| `ready` or `running` with a current task plan or planning-skip receipt | Executor flow | dispatch.md |
| `reviewing` or a current validation receipt | Independent reviewer flow | review.md |
| `failed` | Classify unchanged-contract correction versus an explicit contract change before retrying | review.md |
| `blocked` | Resolve or wait for the recorded blocker; never route around it | recovery.md |
| Every task terminal | Close-out and results flow (§6) | — |

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

On Windows, match the syntax to the shell you are actually in: in PowerShell use environment assignment
(`$env:PRUMO_ROOT`) and quoted paths; in Git Bash/MSYS2 the POSIX lines above work. Start background helpers
hidden. The `progress` line that `start` prints already follows the shell that ran `start` (POSIX when
`MSYSTEM`/`SHELL` is set, PowerShell otherwise): paste it into a shell of the same kind, and if yours differs,
adapt only the quoting.

The first line of `node $ENGINE status` identifies the code actually running: version, content ID and the
harness recorded in its installation marker (a source checkout says so and reports no harness). When it says
the content ID is missing, or warns that the running `engine.mjs` differs from the marker, run
`prumo status --verify-install` before trusting or reporting engine behavior, and propose `prumo update` to
the user. When you resume a run or diagnose unexpected engine behavior, compare this line with the
repository you are reading: a fix present in the repository may not be installed yet.

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
  for behavioral tests and `kind: "static"` for lint/build/typecheck. The rules are in
  [contracts.md](references/contracts.md).
- **`touches` lists the path prefixes the task writes.** `init` refuses two parallel tasks with
  overlapping paths, catching the collision while it is still a planning mistake. New explicit plans
  require it for `writeScope: "files"`; optional legacy scope relies on the dependency graph.

**Explicit scope for new translations.** When translating an approved plan from any harness,
set `scopePolicy: "explicit"` and declare every task's `writeScope`: `files`, `read-only` or `unknown`.
For `files`, investigate the real paths and provide nonempty `touches`; never invent paths to pass
validation. `read-only` means no project file writes; it can still change declared external resources.
`unknown` may initialize and appear on the dashboard, but must be resolved by an approved contract
change through `sync-plan` before execution; never turn it into `read-only` automatically.
Declare `sharedResources: [{ "id": "<stable resource>", "access": "read"|"write" }]` for shared tables,
services or environments. Equal resource ids with any writer require a dependency chain; simultaneous
readers may proceed. File separation alone does not prove independence. Task-plan `writes` must remain
inside `touches`, and independent review compares actual changes with the pre-start baseline.
Plans without `scopePolicy` retain legacy behavior. Adopt the policy explicitly through `sync-plan`,
never by editing state. This adds scope checks without skipping discussion, planning or independent review.
See [contracts.md](references/contracts.md) and [runtime.md](references/runtime.md) for limits.

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

Resuming an existing run instead? Read [recovery.md](references/recovery.md#resuming-or-migrating-an-existing-run)
first: `migrate --check`, automatic safe migration and the mandatory normalization of legacy contracts.

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

Then ask the user which execution scope they authorize (run, one phase, or selected tasks) and whether
dispatch is `auto` (default) or `manual`, and record only what they accepted with
`node $ENGINE authorize --scope run|phase:<id>|tasks:<ids> [--mode auto|manual] --confirmed-by-user`.
Manual mode needs `--confirmed-by-user` on every `start`, `review`, `retry` and on an `unblock` that
resumes an active attempt. Details, auto-mode slot refilling and revocation by contract changes:
[dispatch.md](references/dispatch.md#authorization-scope-and-mode).

**Two runs at once** work only when neither leans on the defaults: pass `--run <name>` to every
command for the non-current run, and give the second dashboard its own port AND pin —
`node $SERVE --port 4950 --run <name>`. State never collides (each run owns its directory and
its lock); `CURRENT` is the only thing they share. Prefer one run at a time anyway: two runs
also share the real ceiling — the machine and the API limits — without knowing about each other.

## 3. The loop

**One shared agent limit.** `maxAgents` defaults to 3 for discussion, planning, execution and review
combined. Read the current dashboard/engine occupancy before every native dispatch. Register each
phase worker with `--agent T1=planner-a --agent T2=planner-b`; dispatch only `activeTargets`, never
`queuedTargets`. A plain phase-agent prefix generates task-specific registration names; it does not
create native agents. Complete the active wave with `finish-phase-*`, then dispatch the next recorded
wave. Plans are committed together only when every eligible phase target has finished. The board's
agent control or `set-agent-limit --max N --actor <user> --confirmed-by-user` changes the run's current
limit and records an audit event. There is no hidden review reservation and `--force` cannot bypass
capacity. A review handoff replaces the executor in its existing slot.

**External block means no work.** `block`, including `--question`, prevents all discussion,
planning, execution and review until `unblock`. Blocked phase members leave the round and need no
artifact; after unblocking, an excluded member uses task-scoped discussion/planning in its original
phase. Use `pause-replanning` only for an active attempt whose approved contract requires a revised
plan; this internal pause permits planning and returns to blocked until explicit `unblock`.

**The principal conversation discusses. Planners research. Executors deliver. A fresh REVIEWER judges.** These are separate assignments: `review`
refuses a reviewer that authored the task, and `done` refuses a validation the executor
recorded. That is the contract, and everything below serves it.
Use a different native agent for each role on a task; recording another label is not a substitute.

```bash
node $ENGINE ready                              # separate planning/execution readiness and capacity
node $ENGINE begin-phase-discussion F2          # after the user chooses discussion
node $ENGINE skip-phase-discussion F2 --reason "..." --confirmed-by-user
node $ENGINE finish-phase-discussion F2 --context <discovery.json>
node $ENGINE plan-phase F2 --agent T4=plan-scenes --agent T5=plan-review  # one recorded worker per target
node $ENGINE skip-phase-planning F2 --reason "..." --confirmed-by-user
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory>
node $ENGINE start T4 --agent ag-scenes         # dispatch up to the cap, in the SAME message
node $ENGINE review T4 --agent rev-scenes       # executor finished → hand to a fresh reviewer
node $ENGINE validate T4 --ok --evidence "..." --cwd <absolute-project>  # the REVIEWER's verdict
node $ENGINE done T4
```

Para medir trabalho real, marque o começo quando a pessoa ou agente efetivamente iniciar cada papel e
marque a parada antes de aguardar resposta, pausar ou encerrar a atividade. Use
`activity-start <id> --scope task|phase --role discussion|planning|execution|review --agent <name>` e
`activity-stop` com os mesmos argumentos. Em rodadas de fase, use `--scope task` com o ID e o nome
exato de cada worker registrado; `--scope phase` também aceita esse nome. Execução e revisão usam
`--scope task`. Os comandos de despacho e de abertura de rodada não iniciam
atividade automaticamente, pois pode haver espera até o trabalho começar. Ao retomar, abra outro
intervalo. O motor fecha um intervalo ainda aberto quando a rodada ou tentativa muda de estado;
isso impede que uma pausa conte como trabalho após o bloqueio. Uma rodada antiga ainda aberta
pode começar a medir no primeiro `activity-start`; recebe `activityLegacy: true` para indicar
que o trabalho anterior ao primeiro START não foi medido nem presumido.

### State machine

| State (from `ready`/`status`) | Next move | Command | Read |
| --- | --- | --- | --- |
| `ready_for_discussion` | Recommend discuss or skip, with reasons; wait for the user's choice | `begin-phase-discussion` / `skip-phase-discussion --reason --confirmed-by-user` | discussion.md |
| `discussing` | Ask in the principal conversation until no consequential gray area remains; write discovery JSON | `finish-phase-discussion --context` | discussion.md |
| `ready_to_plan` | Recommend plan or skip; dispatch one read-only planner per active target within the shared limit, or skip by user choice | `plan-phase --agent [--plan-dir]` / `skip-phase-planning` | planning.md |
| `planning` | Validate and record the returned artifacts; bring `user-now` questions to the user | `finish-phase-planning --plan-dir` | planning.md |
| `pending` | Awaiting migration or phase adoption of a legacy run; follow the recovery steps before any new round | — | recovery.md |
| `waiting` | Dependencies incomplete; explain the blocker, do not reshape the graph | — | runtime.md |
| `ready` | Record the pre-start baseline; dispatch a real executor in the same message | `start --agent` | dispatch.md |
| `running` | Keep the executor on recoverable obstacles; record step progress | `progress --step --agent`; then `review --agent` | dispatch.md |
| `reviewing` | Dispatch a fresh reviewer with contract + diff only; the reviewer validates | `show-check`, `review-progress`, `validate --ok\|--failed` | review.md |
| `reviewing` with an approved validation | Close the task | `done` | review.md |
| `failed` | Unchanged contract: reuse the plan. Changed contract: sync first | `fail --reason`, `retry`, `sync-plan` | review.md |
| `blocked` | Present the recorded question; resume with the answer | `block --question --option`, `unblock [--answer\|--reviewer]` | recovery.md |
| plan edited after approval | Synchronize before any new round, then run `begin-*` again (it supersedes the stale round); show the diff and get acceptance. `refresh-contract` only for a validation-only change to active work | `sync-plan`, `show-contract --diff`, `refresh-contract` | recovery.md |

Task-scoped (legacy) runs use `begin-discussion`, `finish-discussion`, `plan-task` and `finish-planning`
for the same gates ([discussion.md](references/discussion.md#task-scoped-discussion-in-existing-runs)).

### Invariants for every step

These hold in every state; each one protects the property that makes the graph trustworthy.

- **A recorded role is not an agent.** The engine only sees the `--agent` string, so `--agent` must name an
  agent that exists. Every `start` pairs with an actual native executor dispatch in the SAME message, and
  every `review` with an actual reviewer. If dispatch is unavailable, report or block; never do the role
  yourself under another label.
- **Planner dispatch remains exactly once per approved contract.** Rejections and retries reuse the same
  immutable task plan; only an explicitly approved contract revision opens a new round.
- **A recoverable obstacle is executor work, not a reason to hand incomplete work to review.**
  The reviewer is a validation gate, not failure triage: handing it unfinished work spends a fresh
  reviewer on a verdict everyone already knows ([dispatch.md](references/dispatch.md#recoverable-obstacles-stay-with-the-executor)).
- **Author ≠ verifier.** The executor never approves its own work and the orchestrator never impersonates
  the reviewer. `done` requires a passing independent validation for the current attempt. Discussion and
  planning skips never waive review.
- **One agent, one active task; a fresh reviewer per task.** All roles share `maxAgents`; a handoff
  replaces the current role in its slot, with no hidden reservation ([dispatch.md](references/dispatch.md#capacity)).
- **Gates are the user's choice.** Discussion and planning are optional only by the user's explicit choice,
  recorded with `--reason` and `--confirmed-by-user`; never skip for token economy.
- **Eligibility is not permission.** A phase opens only when every external dependency of every unfinished member is `done` or `skipped`,
  and even then it waits for the user to choose it.
- **A named task in the user's request is a hard scope boundary.** Its prerequisites and internal
  deliverables stay inside its one task plan; broadening the graph needs explicit approval.
- **Change the plan, not the state.** Never edit `state.json`, move tasks, drop dependencies or disable
  gates to manufacture readiness. An approved change goes into the source plan, then `sync-plan`, before
  any `begin-*` — and a changed contract needs the user's fresh acceptance.
- **Blocked is a real state.** A wait on the user is `block` with `--question`/`--option`, not a task left
  `running`.
- **State is truth.** After any interruption, inspect persisted state and actual agents before repeating a
  command; a dispatch problem is not an implementation failure.

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

## Engine-generated context and optional controls

Use `brief <task> --role executor|reviewer` from the current persisted run instead of
reconstructing handoff context. A new reviewer independently inspects and validates the
current delivery; historical receipts never replace that review. Review handoff checks
new delivery identifiers inside approved scope before changing state.
Optional model/effort preferences, reported token/tool counts, numeric provenance,
whole-run pause/resume, run selection shortcuts and check discovery are documented in
[runtime.md](references/runtime.md#optional-evidence-and-run-controls). A paused run waits
for explicit resume-run; --until is a forecast. Recording a pause does not interrupt
external agents. Recorded stage duration may include waiting; never call it measured
active work or use it as measured savings.
