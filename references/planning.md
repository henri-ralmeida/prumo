# Phase research and per-task plans

Read this when a phase or task is `ready_to_plan` or `planning`: before dispatching the planner (or
planning locally), when a planner returns artifacts, and after `finish-phase-planning`/`finish-planning`
prints open questions. The artifact schema is in [runtime.md](runtime.md#task-plan-artifact); discovery
comes first, in [discussion.md](discussion.md).

## Contents

- [Who plans, and with what permissions](#who-plans-and-with-what-permissions)
- [What the planner produces](#what-the-planner-produces)
- [Planner prompt](#planner-prompt)

- [Recording the artifacts](#recording-the-artifacts)
- [Baseline before execution](#baseline-before-execution)
- [Open questions after planning](#open-questions-after-planning)

## Who plans, and with what permissions

After discovery closes, every active phase target gets one assigned read-only planning worker, and every
approved task contract gets exactly one task planner (see "One planner per approved task contract" in
[SKILL.md](../SKILL.md)). Phase commands accept repeated `--agent <task>=<native-agent>` assignments that
must cover every target exactly once with distinct names, or one prefix that records `<prefix>:<task>`.
These names are persisted assignments, not native agent creation: inspect the actual tools and create the
native agents with the exact names before dispatching only `activeTargets`; one coordinator must not stand in
for several workers. First inspect the actual tools
and permissions in this session to determine whether dedicated workers can be dispatched and whether they
can write to the indicated artifact directory. Never infer either capability from the harness name. Every
worker remains read-only for project work and may write only the designated plan artifact for its target.
Research the current code, artifacts, dependency outputs, project rules and relevant source
documentation first; reuse useful prior research, but verify that it still applies. Read-only
inspection and safe research checks are allowed. The planner writes only its designated task-plan
artifact; it does not implement the task or edit graph state. If no dedicated planner subagent is
available, the orchestrator reports that limitation and performs the same planning locally, with
read-only research and only the designated artifact write. This fallback does not authorize product
implementation. Register the local planning actor using the same capacity rules; never describe it as a
native subagent. If only one actor is available, obtain the user's choice to set the limit to 1 before
opening a phase, so parallel identities are not invented. Active planning workers use the same shared `maxAgents` cap as discussion,
execution and review; queued phase targets consume no slot. Legacy `maxParallel`/`maxExecutors` fields are
metadata only ([dispatch.md](dispatch.md#capacity)).

Consume the persisted discovery and do not repeat its questions. Apply PO First to research the selected
implementation approach, impacts and verification in depth. If research reveals a new consequential
decision, return it to the orchestrator: update discovery through the principal conversation and dispatch
fresh planning. Never invent an answer or label a material gap nonblocking to pass the gate.
Ordinary refinement within approved scope needs no new task approval. Material changes to
scope, behavior, acceptance or shared decisions return to the user and global plan workflow.
Stop research once every material criterion and dependency is mapped to current evidence and no
concrete unresolved risk remains. Do not reread equivalent sources or expand the investigation merely
to accumulate confidence; record a real gap instead of searching indefinitely for certainty.

Treat known operating conditions as part of that evidence decision when they can materially change the
result: data volume and file size, existing persisted state, concurrency and slow operations. Map each
material risk to an observable criterion and a representative scenario, and explain why the chosen real
or synthetic data represents the known condition. A small fixture does not cover a known large workload
unless the plan establishes why it exercises the same risk. Record limitations instead of inventing a
performance threshold. Keep this proportional: a bounded low-risk change does not require load testing
when scale or state cannot materially affect its outcome.

## What the planner produces

When planning is chosen, the active worker writes `task-plan-<id>.json` for its target. Never turn steps, evidence gaps,
prerequisites or dependency outputs inside an explicitly selected task into separate graph tasks or
planner assignments without explicit user approval. The engine validates the whole batch
before recording any final artifact. Phase planning validates the active wave, stages its accepted plans,
opens the next queued wave and records every task plan atomically only after the final wave. Each artifact is immutable and lists incomplete direct dependencies as
unresolved inputs. A later producer's independently reviewed validation receipt, or an explicit skip waiver,
satisfies that input at execution time without rewriting the plan. Contract changes stale only the affected
plan and true downstream scopes; shared phase discovery stales nonterminal plans in that phase; a marked
plan defect stales only that task.

Every task plan may add `verification[].requires` using the documented resource vocabulary and a `writes`
list of anticipated project paths. `writes` must fit the task's approved `touches`; no or empty `writes`
is a warning that the reviewer must resolve from the real diff. A required and unavailable resource is a
nonblocking planning warning. Keep `manual-inspection` visible as pending for the reviewer and user until
the inspection has current evidence; never infer it from a harness name.

The engine hashes the validated discovery and issued receipt with canonical JSON and binds that digest to
the planning round and final task plans. Repeating `plan-phase` while that round is active preserves its
assignments and can activate the next queued wave. `finish-phase-discussion` validates discovery only for
the active wave, accumulates each completed wave and opens the next one. `finish-phase-planning` refuses a
round whose discovery no longer matches the persisted context.

For plans with `scopePolicy: "explicit"`, investigate `writeScope`, `touches` and `sharedResources` before proposing `writes`. For `read-only`, `writes` is empty or absent. For `files`, `writes` must fit approved prefixes; omission remains a warning, not permission to write elsewhere. `unknown` does not authorize execution: return the research for a contract change via `sync-plan`, without inventing paths. Any shared-resource writer requires dependencies; never infer independence from files alone.

## Planner prompt

```text
You are the read-only PLANNING WORKER assigned to the active target(s) of the approved phase. Inspect the actual tools and write permissions available to you; do not infer capabilities from the harness name. Work
only on the target IDs assigned to your exact native agent name; do not act on queued targets and do not implement them.
Read project rules, approved objective/constraints, member contracts and known dependency outputs: <references>.
Read the persisted phase discovery and its locked decisions: <phaseWorkflows.F2.discovery from state.json>.
Use the available tools to inspect the current implementation/artifacts, real project rules, dependency outputs
and relevant sources; identify existing solutions and impacts.
Apply PO First. Do not repeat discovery questions; return newly found consequential gaps to the orchestrator.
Consider known result-shaping operating conditions, including data volume and file size, persisted state,
concurrency and slow operations. For each material risk, plan an observable check on the path people use with
representative real or synthetic data; justify why the data represents that condition and record limitations.
Do not let a small fixture stand in for a known large workload without evidence that it exercises the same risk,
and do not impose generic load tests or invent performance limits for a bounded low-risk change.
For product text you recommend, state the observable business rule and why; name its owner only when approved
context establishes it, otherwise surface the ownership question to the PO. Keep workflow identifiers and
internal process details out of comments, tests, messages and README drafts; required planning identifiers
belong only in the designated task-plan contract fields.
Preserve known decisions; propose any material contract change for the authorized global-plan workflow.
Include `summary` in each artifact: 1–2 sentences describing the chosen approach and why it meets the expected result.
Write ONLY the exact `task-plan-<id>.json` for each active target in <absolute artifact directory>: research, decisions,
steps, verification, open questions, writes, phaseBinding and unresolvedInputs. For every open question,
state who decides and by when with `decideBy`: `executor` (with the proposed `answer` the executor applies),
`user-now`, `{ "beforeTask": "<id>" }` or `{ "beforePhase": "<id>" }`. Each verification item may
declare required resources with `requires`; use only the documented vocabulary. Record anticipated project
paths in `writes`, all contained by that task's `touches`; use no file writes for `read-only`. Investigate shared resource access and unresolved scope; never invent paths. Copy the exact phaseBinding and
that task's unresolvedInputs from the `plan-phase` output; do not recalculate them or renumber plannerRound.
When discussion was skipped, discussionRoundId is the confirmed skip decisionId printed by the engine.
Schema: references/runtime.md#task-plan-artifact.
Inspect the real `git status --short` and relevant staged/unstaged diff while planning. Identify changes
already present before execution so the reviewer can distinguish them from this task's delivery.
If you can write to the indicated directory, write only the exact task-plan-<id>.json file there for each
target. If you cannot write it, return one complete artifact per task: put its exact filename on the line
immediately before a block opened with ```json containing the entire valid JSON object. Do not abbreviate, omit
fields, use ellipses or return a partial object. The orchestrator decodes &gt;, &lt;, &amp; and &quot; in JSON
string values, validates each complete object, writes each artifact to the indicated directory and then
finishes planning. If validation reports a correction, send it back to the planner to fix; the orchestrator
must not invent missing plan content.
Inspect the actual available tools and permissions; never infer file-write or subagent capability from the
harness name. If no planner subagent is available, report that limitation and do this planning locally with
read-only research, writing only the designated task-plan artifact. Do not implement product work.
Do not edit .specs/graph/ state. Report the artifact path, findings and any decision that blocks execution.
```

The same artifact, capability, complete-JSON fallback and correction rules apply to task-scoped planning.
Use the artifact directory and task schema given for that task, without adding phase-only binding fields.



## Recording the artifacts

The orchestrator parses each returned block as JSON, decodes the listed HTML entities only within its string
values, validates the complete artifact, writes it under the indicated filename and then records
finish-phase-planning or finish-planning. If parsing or validation fails, send the concrete correction back to
the planner. The engine requires research, steps, a mapping to every validation check and no unanswered blocking question;
it checks structure and freshness, not the truth of research or real agent identity. `init` still
requires a valid behavioral contract: planning never permits fake `echo` checks or inspection
exceptions for functional work. The executor reads and rechecks the plan; the independent reviewer
can challenge an incomplete or incorrect plan against the approved objective and current criteria.
These roles reduce opportunities for error; none guarantees that models cannot make mistakes.

```bash
node $ENGINE plan-phase F2 --agent T1=plan-f2-t1 --agent T2=plan-f2-t2  # exact native workers for active targets
# A single --agent plan-f2 prefix records plan-f2:T1, plan-f2:T2, ...; queued targets wait for a slot.
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory>
node $ENGINE plan-task T4 --agent <planner>     # task-scoped runs
node $ENGINE finish-planning T4 --plan <artifact.json>
```

## Baseline before execution

Before the executor starts, record the real `git status --short`, staged and unstaged diff for the
task's declared `writes` (or approved `touches` when `writes` is absent), and relevant pre-existing
untracked paths in a durable task note or review handoff. The planner identifies those existing
changes; the reviewer compares against this baseline and excludes them from the delivery judgment.

The attempt records the disjoint file scopes of contemporaneous executors; a new executor also updates earlier active attempts with its scope. Git observes changed paths globally, not authorship. Changes outside this task may be excluded only when they fit those recorded other scopes and the current independent reviewer supplies explicit attribution through `--scope-evidence`. The scope receipt records `excludedPaths` and the authorship limitation. Observed changes outside every authorized recorded scope always block, even with reviewer evidence. `done` requires the same delivery fingerprint and reviewer identity as the passing receipt; changes after validation require fresh verification. Ignored files are not audited automatically: the scope receipt always exposes that limitation and the independent reviewer must inspect them separately, without a mandatory `--scope-evidence` flag just for ignored paths. Unavailable Git/baseline, submodules and non-Git workspaces require explicit `--scope-evidence`, as does attribution to another executor; external-resource effects need their own observations. The fingerprint conservatively covers all Git-visible changes: any change after validation, including another executor's change, requires new validation so attribution evidence cannot become stale.

## Open questions after planning

Before the task-plan artifact has been recorded, the user's literal answer may be entered in the
question's `answer` field. After recording, use the reference printed by `finish-phase-planning`,
`status` or `ready`: `node $ENGINE answer-question <ref> --answer "..." --confirmed-by-user`.
This records the actual user answer to a `user-now` question without reopening discussion or changing
the recorded plan. Already answered questions are refused and their original answers are preserved.
The flag confirms that the user supplied the answer; it does not authorize task execution.

Antes de o artefato do plano da tarefa ser registrado, a resposta literal do usuário pode entrar no
campo `answer` da pergunta. Depois do registro, use a referência exibida por `finish-phase-planning`,
`status` ou `ready`: `node $ENGINE answer-question <ref> --answer "..." --confirmed-by-user`.
O comando registra a resposta real do usuário a uma pergunta `user-now`, sem reabrir a discussão nem
alterar o plano registrado. Perguntas já respondidas são recusadas e preservam a resposta original.
A opção confirma que o usuário forneceu a resposta; ela não autoriza a execução da tarefa.


After `finish-phase-planning` or `finish-planning`, user questions with an answer recorded in the plan
appear separately as answered, with their recorded answer; they are not offered as pending decisions.
No answer is inferred or rewritten. The engine lists unanswered questions for the user now and
those with a later deadline, and warns when an `executor` question has no proposed answer. Before execution,
take to the user only the `user-now` questions. A nonblocking question whose proposed answer the executor
applies is not a user question. A question due before a later task or phase is not asked now and is not
bundled with the execution authorization; it reappears in that target's discussion or planning.

`openQuestions[].decideBy` may be `executor`, `user-now`, `{ "beforeTask": "T2" }` or
`{ "beforePhase": "F2" }` (the only accepted values; any other is refused with a message that lists them); blocking questions still need answers before planning closes and mean
`user-now`. A future deadline does not hold its source task. At the named task or phase, the reference
appears in discussion/planning and `status` reports it when overdue. Resolve it in a later `decisions`
entry with `resolvesQuestion` set to the displayed reference; start remains gated only after that
deadline has arrived. In task-planning mode, a `{ "beforePhase": "F2" }` deadline becomes due when any
task in F2 begins discussion or planning.

An unanswered open question with beforeTask set to its own task ID must be answered before finish-planning or finish-phase-planning accepts that task plan. Task-plan validation rejects this deadline immediately when the artifact is submitted. Batch errors identify the task, question index, a bounded excerpt and artifact path; correct the answer or the approved deadline, then retry the batch. plan-phase opens the round and cannot inspect an artifact that has not yet been submitted.

After a fresh phase discussion is accepted, `finish-phase-planning <phase> --plan-dir <directory> --reuse-unchanged-plans` can rebind an older artifact only when its task contract, dependency digests, global plan context and material discussion decisions are unchanged. Changed tasks need current artifacts. All artifact, question and batch gates still apply. The original file remains unchanged; the persisted plan records its old binding in `reusedFrom`. Without the flag, an old binding remains an error. Shared decision changes require replanning.
