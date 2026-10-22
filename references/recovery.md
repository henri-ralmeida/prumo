# Blocks, resumption, plan changes and legacy runs

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

The global dashboard observes and exposes only the explicit user-confirmed agent-limit control; it never synchronizes a plan. Before resuming an existing run, use
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
Migration also adopts the shared `maxAgents: 3` default when absent, preserves plan fields, tasks and
histories, and appends the change to `agentLimitHistory`. Legacy `maxParallel`/`maxExecutors` values remain
metadata; blocked legacy tasks without `blockKind` remain external, regardless of their reason text.

## Synchronizing an approved plan change

For a change not yet accepted in the current planning lifecycle (including new tasks), use `sync-plan --propose` to stage a candidate for one exact acceptance, not to authorize execution. Then open discussion, present `show-contract --full`, and record the user's acceptance and requested continuation scope/mode once. See [discussion.md](discussion.md#contract-changes-before-and-during-a-round). The existing completed-round invalidation safeguards and active-attempt pause still apply; completed tasks are not reopened. If the proposal lists affected legacy tasks, use `sync-plan --plan <candidate.json>` without `--propose` and follow the next steps shown by `status` or `ready`; do not change historical lifecycle markers to force a proposal.

The order matters: edit the approved plan and run `sync-plan` **before** `begin-phase-discussion` or
`begin-discussion`, so the new round opens on the current contract (see
[discussion.md](discussion.md#contract-changes-before-and-during-a-round)).

```bash
node $ENGINE sync-plan --plan <approved-plan.json> --run <run-name>
node $ENGINE show-contract <task> --diff --run <run-name>
```

`sync-plan` adds approved tasks and refreshes contracts in every nonterminal state while preserving the
current lifecycle, agents, attempts, notes and evidence. Active work whose scope changed cannot advance
through review or completion until current planning is restored; use `pause-replanning` for an active
planning-required attempt, then replan and explicitly `unblock` it without inventing a failure. An ordinary
external `block` must be unblocked before planning. Done/skipped contracts remain immutable history and need an explicit follow-up task. Task removal
requires explicit `--remove <task,...> --reason <reason>` and is limited to pending, never-executed tasks
without notes, validation receipts, dependents or open planning/discussion. The complete record stays
in removal history and its ID cannot be reused. Use `--dry-run` first; an implicit omission still refuses
synchronization. External work items are unchanged. If a migrated run still names a missing graph-foreman source, `sync-plan` recovers the matching
plan from the central Prumo workspace. Its output lists bounded per-task field changes, summarizes validation
contracts without printing their contents and warns when a waiting `blockReason` contradicts dependency
direction; the event log keeps the same structured audit. A named task in the user's request is a hard scope boundary: its
dependencies, prerequisites or internal deliverables are context, not permission to add tasks, plan
siblings or dispatch more planners. Keep one discussion and one planner for that task unless the user
explicitly approves a broader graph change. Otherwise, adopt a migrated task-scoped run one eligible phase
at a time with `begin-phase-discussion <phase> --adopt-legacy`. An approved validation change for active
work needs `refresh-contract`, not fail/retry. Always check the persisted task before review.

Phase discussion and planning refuse targets that are still running or under review and need a new
plan. Pause only the affected task with `pause-replanning <task> --reason <reason>`, follow its task
discussion/planning flow, then explicitly unblock it. Other tasks with current plans continue normally.
Older records with a phase plan bound to a different execution attempt remain readable; `status` and
`ready` show the same recovery without creating attempts or replacing historical plans.

When an active task changes only its verification command, keeping the validation mode and acceptance
criteria unchanged, `refresh-contract` preserves its current phase plan or explicit planning skip.
It still revokes execution authorization and makes old validation receipts stale. The independent
reviewer must validate the current contract; changing criteria, dependencies or scope requires planning.

A description change that invalidates completed discussion or planning rounds lists the affected phases and tasks before any persistence and requires `--confirm-invalidation`. Inspect `sync-plan --plan <approved-plan.json> --dry-run` first: the preview writes no state, events, source files, backups or migration. An unchanged description or phases without completed rounds need no confirmation. Contract invalidation and touches warnings still apply.

`sync-plan` warns without refusing synchronization when it invalidates an open discussion/planning round or
a current skip. `status` and `ready` also warn when the approved plan source differs from persisted task
contracts, naming changed fields, new tasks not yet synchronized and tasks missing from the approved plan;
this warning does not block readiness. Treat it as "run `sync-plan`" after the user approved the edit. Use `show-contract <task> [--diff]` to present complete
business text before and after a change; it omits executable `validation.run` commands. When a changed
contract reopens a phase or task that already had a discussion, planning round or current skip, the next
discussion records the old open round as superseded with its cause and prints the current task digests. Run
`show-contract <task> --diff` for every affected contract, present the complete business text and ask the user
to accept the changed behavior. For phase planning, put the exact `{ "task": "...", "digest": "..." }` entries
printed by `begin-phase-discussion` in `questions[].confirmsContract` on one freshly answered question.
Only changed contracts, affected dependency contexts and still-pending acceptances are requested;
unchanged siblings retain their acceptance and authorization. For task planning,
use the single entry printed by `begin-discussion` in one freshly answered question. In both modes, the
confirmation must be on the same question bound to the current `roundId`; an old-round answer, stale digest,
discussion skip or planning skip cannot replace it. After the confirmation is recorded, the ordinary explicit
planning skip remains available.

A contract change also revokes that task's execution authorization; get fresh acceptance before executing it
([dispatch.md](dispatch.md#authorization-scope-and-mode)).

For an open phase planning round, unchanged artifact content can be reused with
`finish-phase-planning --reuse-unchanged-plans --plan-dir <directory>`. The engine updates only the
round binding after checking the original contract, dependencies and material discussion content.
Changed decisions or affected contracts require a fresh artifact; an old artifact alone is not approval.
Completed plans for unaffected tasks remain untouched.

A question due before a phase must have a corresponding `decisions[].resolvesQuestion` answer before
its discussion or planning can close. A refusal names the question and leaves the round open, so the
answer can be recorded in the current artifact without reopening a completed round. Questions whose
deadline belongs to another phase remain scheduled.
When the agent limit splits planning into batches, intermediate artifacts can be staged to free
capacity for the next agents. The phase remains open and its plans are not approved until the final
batch supplies all due answers.

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

For an active phase-planned attempt, changing only validation commands or their execution parameters
can preserve the original task plan when the validation mode, inspection reason, check count, kinds and
expected outcomes remain unchanged. The recorded phase binding and plan are not rewritten. Current
validation and independent review are still required; earlier receipts never approve the changed contract.
A changed execution scope, dependency context, global decision or acceptance criterion still requires
current planning. Historical completed phase rounds identify affected tasks without reopening unchanged tasks.


## Blocking and user decisions

Needs the dev → `block T4 --reason "..."`. `block` is always an external pause and records
`blockKind: "external"`; leaving the task `running` while you wait is how a graph lies. A user decision is
recorded with `--question "<the decision in one sentence>" --option "<answer> => <effect>"` (repeat
`--option` per answer). The block event and dashboard carry the question, and
`unblock T4 --answer "<answer>"` records the choice.

External blocks exclude a phase task from its current `activeTargets` and `queuedTargets`, preserve the
original set in `originalTargets`, append the exclusion reason to `excludedTargets`, and mark the task for
individual planning (`individualPlanning: true`). The remaining phase wave may finish. After `unblock`, the excluded task uses its own `begin-discussion`, `plan-task` and
`finish-planning` flow within its original phase. Direct commands fail before mutation with the task's `is blocked` message and the
`unblock` instruction. No discussion, planning, execution, review or activity command may route around an
external block. A legacy `blocked` task without `blockKind` is external; never infer an internal pause from
`blockReason` wording.

If an external block pauses a planning-required attempt in `running` or `reviewing` and the approved scope
changes before resumption, `unblock --answer` records the decision but keeps the task blocked and converts it
to `blockKind: "replan"` with reason `approved scope needs current planning`. The original attempt and reviewer
remain attached. Start a fresh task discussion, then run `plan-task` and `finish-planning` while it remains
blocked; `finish-planning` keeps it blocked, and a later explicit `unblock` resumes the same attempt or review.

When a block includes a recorded `blockQuestion`, present that exact question and its `blockOptions`
through PO First, ask the user for the decision, then pass the answer with `unblock <task> --answer`.
Keep the recorded reason, question, answer and time in the block history. Reason-only legacy blocks remain
resumable with `unblock <task>` but are still external.

For an active planning-required attempt whose approved contract must be refreshed, use
`pause-replanning <task> --reason "..."`. It records `blockKind: "replan"` without an external question;
the same attempt may run task planning while blocked, `finish-planning` leaves it blocked, and explicit
`unblock` resumes it.

If the user explicitly chooses to skip discussion for the unchanged contract during this internal pause,
record `skip-discussion <task> --reason "..." --confirmed-by-user` before `plan-task`. The skip records
the decision without unblocking the task, replacing the attempt or waiving independent review. An external
block, unanswered external question or required fresh contract acceptance cannot be bypassed by this skip.

Resolve or wait for the recorded blocker; never route around it. Use `note <task> --text "..."` for what a
later reader needs and the states cannot say.

## Resuming paused work

An answered external block during task replanning must preserve the original attempt's internal
return state and reason through the next discussion and planning round. Completing discussion
does not reopen an external decision or resume execution; planning completion still requires an
explicit `unblock` before the same attempt continues.

For an older engine's interrupted transition that left a task `blocked` with no block metadata,
but retained `planningReturn`, inspect `recover-replanning <task> --check --run <name>`.
Recovery requires matching current discussion/discovery, the superseded planning round, the
answered external block, and the original open execution/review in the append-only event history.
Missing or contradictory evidence is a refusal, never permission to infer readiness from wording.
After authorization, `recover-replanning <task> --confirmed-by-user --run <name>` saves a uniquely
named `state.pre-replanning-recovery-<id>.json` backup and records the repair event. It restores only
the lost internal pause metadata, leaving the task blocked for current planning. It does not
dispatch agents, resolve new questions, change contracts, reset attempts or waive independent review.

`unblock <task>` restores the recorded phase (pending, planning, running, reviewing or failed), preserving
the attempt and previous work. For delivered work paused during execution or review, use
`unblock <task> --reviewer <independent-agent>` to hand it directly to review in the same attempt.
A direct review is a handoff in the task's existing occupied slot, not a fourth agent or a reserved review slot. It
rechecks dependencies, shared `maxAgents` capacity and the reviewer's availability; ordinary execution resume
also checks the same shared cap. Lowering the cap never kills current agents and only delays new work. A refusal
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
scope changes, keep its attempt, use `pause-replanning`, synchronize the approved change and use the task-scoped
planning workflow. `finish-planning` returns this work to **blocked**, preserving its original phase and reason;
explicit `unblock` then resumes the same attempt. Do not use ordinary external `block` followed by planning,
and do not fabricate fail/retry for replanning.
Validation-only changes can still use `refresh-contract` and fresh review in the same attempt.

## Legacy lifecycle notes

- Existing tasks without `planningRequired` keep their original lifecycle, states and history;
  do not force completed or active legacy work through planning. Tasks added to an old run get
  the new planning requirement. Installation never resets a run.
- `sync-plan` preserves `done` and `skipped` contracts as history. Their old prose does not block synchronization or retry of other tasks. Do not relabel completed functional work as inspection. New and nonterminal tasks still need valid contracts; graph structure is checked for every task.

### Renumerar tarefas preservando a entrega aprovada

Use `renumber-tasks` quando a mudança for apenas de identificação: o conteúdo das tarefas,
as fases, as dependências e os aceites existentes devem continuar representando as mesmas entregas.
O mapa aceita trocas e ciclos, mas recusa identificadores repetidos, colisões e números reservados
por tarefas removidas, para não misturar históricos.

```sh
node $ENGINE renumber-tasks --map T14=T16,T15=T17,T16=T14,T17=T15 --dry-run --run <run-name>
node $ENGINE renumber-tasks --map T14=T16,T15=T17,T16=T14,T17=T15 --confirmed-by-user --run <run-name>
```

Confira a prévia com `--dry-run` antes de aplicar o mapa autorizado pelo usuário com
`--confirmed-by-user`. A prévia não altera tarefas, planos, eventos nem backups. O plano de origem
precisa estar sincronizado para as tarefas ainda não encerradas. Diferenças de contrato em tarefas
`done` ou `skipped` permanecem históricas e não impedem a renumeração; não apague campos da fonte
para contorná-las. Tarefas ausentes e diferenças atuais continuam bloqueando, com os identificadores
e campos que precisam ser conferidos por `sync-plan --dry-run`.

A prévia mostra o mapa e os bloqueios encontrados, com saída diferente de zero quando a aplicação
não é permitida. Execução, revisão, discussão, planejamento ou a última tentativa aberta de uma
tarefa não encerrada continuam bloqueando. Tentativas anteriores e tentativas legadas de tarefas
`done` ou `skipped` não representam trabalho ativo. Pausar com `pause-run` não encerra trabalho;
aguarde seu encerramento antes de renumerar.

Use `migrate --check` para identificar tentativas legadas sem encerramento. O `migrate` explícito
preserva backup e registra auditoria ao fechá-las usando o próximo início ou evento de encerramento
comprovado. Sem evidência, mantém o registro sem inventar datas. Consultas e a renumeração não
executam esse reparo implicitamente.

Ao aplicar, o comando preserva cópias do estado, plano e eventos anteriores em
`task-id-backups/<identificador>/`. Prepara um novo plano versionado e um novo log de eventos;
ambos passam a ser usados na troca atômica do estado. Os arquivos originais permanecem preservados.
Somente referências e vínculos correspondentes à renumeração são atualizados: tentativas,
resultados, aprovações e decisões de planejamento continuam associados à mesma entrega.
O painel mantém a identificação anterior na dica da tarefa para facilitar a conferência.

Run the write command on its own, with enough time for the complete run. A preview reports
`dryRun: true, applied: false`; only a completed activation reports `applied: true`, `backup` and
`source`. `taskChanges` shows the actual source IDs, destination IDs and task titles: applying the
same swap again reverses it, so inspect a fresh preview before intentionally repeating a mapping.
An interrupted preparation is reported in `interrupted`. Confirming the same mapping resumes its
backup only while the original state, source plan and events still match; otherwise a new preparation
uses the current state and preserves the old backup. If activation already completed before the
interruption, the next matching application reports `alreadyApplied: true` without applying it again.

Execute o comando de escrita isoladamente, com tempo suficiente para processar a execução inteira.
A prévia informa `dryRun: true, applied: false`; somente a ativação concluída informa `applied: true`,
`backup` e `source`. `taskChanges` mostra os IDs e títulos reais; repetir uma troca pode invertê-la,
portanto confira uma nova prévia antes de repetir um mapa intencionalmente. O campo `interrupted`
identifica uma preparação interrompida: ela é retomada no mesmo backup somente se estado, plano e
eventos originais ainda conferirem. Se mudaram, a preparação usa o estado atual e preserva o backup
anterior. Se a ativação já terminou, a próxima aplicação correspondente informa `alreadyApplied: true`
sem repetir a troca. Não interprete um timeout do shell como confirmação de gravação.

Lightweight records (`note`, `progress`, `activity-start`, `activity-stop`) wait up to 30 seconds for
a concurrent writer. A live owner remains protected regardless of lock age. A missing or unreadable
owner reports lock age and the unavailable PID verification; age alone never authorizes deletion.
The complete lock directory is detached before cleanup and before command metrics, so delayed or
partially failed cleanup cannot leave an active lock without its metadata. Metadata is written before
entering the protected command; the short acquisition interval does not authorize another writer.

Registros leves (`note`, `progress`, `activity-start`, `activity-stop`) aguardam até 30 segundos por
uma escrita concorrente. Donos vivos continuam protegidos independentemente da idade da trava.
Se os metadados estiverem ausentes ou ilegíveis, a mensagem informa a idade e a impossibilidade de
verificar o PID; a idade, sozinha, não autoriza apagar a trava. O diretório inteiro é retirado do nome
ativo antes da limpeza e das métricas, evitando que uma remoção parcial deixe uma trava sem dono.
Os metadados são gravados antes de entrar no comando protegido; o intervalo curto de aquisição não
autoriza outro gravador. Aguarde o processo em execução; não apague a trava manualmente.

Confira `status` após a mudança. Atualize manualmente os títulos dos itens espelhados em serviços
externos, quando necessário: a renumeração local não altera esses serviços.

### Appending a phase to the plan

After approval of the new scope, `sync-plan` accepts phases appended at the end with the next `F` IDs
and next available `T` numbers. Preserve previous IDs, phases and history; declare the new phase's actual
dependencies and inspect `sync-plan --dry-run` before writing. New numbers in existing phases remain
refused; extensions use letters linked to the base task. The new phase follows the same discussion,
planning, authorization, execution and review gates.

A user-cancelled task should be recorded with `skip <task> --reason "<user decision>"`. It no longer requires phase contract acceptance. An open phase discussion with no active targets closes as superseded, retaining its history; remaining targets keep their controls. Do not edit state or invent a contract acceptance to clear a cancelled task. This transition applies when `skip` is executed; it does not silently rewrite already-recorded runs.

## Reordenação de fases sem inferir dependências

Para trocar fases ainda não executadas, altere a ordem de `phases` no plano candidato e ajuste explicitamente os `deps` que precisam mudar. Execute `sync-plan --plan <candidato> --dry-run`. A prévia mostra a ordem resultante e recusa relações que apontem para uma fase posterior, listando tarefa e dependência. Nenhuma relação é reconectada automaticamente. A liberação de tarefas continua seguindo `deps`, não a posição visual da fase.

A reordenação recusa fases movidas com tentativas ou tarefas encerradas, preservando o trabalho histórico. Discussões e planejamentos já registrados seguem a análise habitual de invalidação da sincronização; confira a prévia e use `--confirm-invalidation` somente para o impacto autorizado. A aplicação usa o fluxo normal de backup, confirmação e histórico de `sync-plan`.
