# Phase research and per-task plans

[Português](planning.pt-BR.md)

Read this when a phase or task is `ready_to_plan` or `planning`: before dispatching the planner (or
planning locally), when a planner returns artifacts, and after `finish-phase-planning`/`finish-planning`
prints open questions. The artifact schema is in [runtime.md](runtime.md#task-plan-artifact); discovery
comes first, in [discussion.md](discussion.md).

## Contents

- [Who plans, and with what permissions](#who-plans-and-with-what-permissions)
- [What the planner produces](#what-the-planner-produces)
- [Planner prompt](#planner-prompt)
- [Portuguese planner prompt](#portuguese-planner-prompt)
- [Recording the artifacts](#recording-the-artifacts)
- [Baseline before execution](#baseline-before-execution)
- [Open questions after planning](#open-questions-after-planning)

## Who plans, and with what permissions

Every phase gets one planner after its discovery closes, and every approved task contract gets exactly one
planner (see "One planner per approved task contract" in [SKILL.md](../SKILL.md)). First inspect the actual tools and permissions
in this session to determine whether a dedicated planner can be dispatched and whether it can write to
the indicated artifact directory. Never infer either capability from the harness name. The planner
remains read-only for project work: it researches the phase and may write only the designated plan
artifact for each targeted task.
Research the current code, artifacts, dependency outputs, project rules and relevant source
documentation first; reuse useful prior research, but verify that it still applies. Read-only
inspection and safe research checks are allowed. The planner writes only its designated task-plan
artifact; it does not implement the task or edit graph state. If no dedicated planner subagent is
available, the orchestrator reports that limitation and performs the same planning locally, with
read-only research and only the designated artifact write. This fallback does not authorize product
implementation. Local planning writes only the designated artifact and does not invent a dispatched
agent or consume an agent slot. Planning uses total capacity, not executor capacity or an execution
attempt ([dispatch.md](dispatch.md#capacity)).

Consume the persisted discovery and do not repeat its questions. Apply PO First to research the selected
implementation approach, impacts and verification in depth. If research reveals a new consequential
decision, return it to the orchestrator: update discovery through the principal conversation and dispatch
fresh planning. Never invent an answer or label a material gap nonblocking to pass the gate.
Ordinary refinement within approved scope needs no new task approval. Material changes to
scope, behavior, acceptance or shared decisions return to the user and global plan workflow.
Stop research once every material criterion and dependency is mapped to current evidence and no
concrete unresolved risk remains. Do not reread equivalent sources or expand the investigation merely
to accumulate confidence; record a real gap instead of searching indefinitely for certainty.

## What the planner produces

When planning is chosen, the planner writes `task-plan-<id>.json` for every targeted member. Never turn steps, evidence gaps,
prerequisites or dependency outputs inside an explicitly selected task into separate graph tasks or
planner assignments without explicit user approval. The engine validates the whole batch
before recording any artifact. Each artifact is immutable and lists incomplete direct dependencies as
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
the planning round and final task plans. Repeating `plan-phase` while that round is active is a no-op.
`finish-phase-planning` refuses a round whose discovery no longer matches the persisted context.

## Planner prompt

```text
You are the read-only PLANNER for the approved phase. Inspect the actual tools and write permissions available
to you; do not infer capabilities from the harness name. Research every targeted task; do not implement them.
Read project rules, approved objective/constraints, member contracts and known dependency outputs: <references>.
Read the persisted phase discovery and its locked decisions: <phaseWorkflows.F2.discovery from state.json>.
Use the available tools to inspect the current implementation/artifacts, real project rules, dependency outputs
and relevant sources; identify existing solutions and impacts.
Apply PO First. Do not repeat discovery questions; return newly found consequential gaps to the orchestrator.
For product text you recommend, state the observable business rule and why; name its owner only when approved
context establishes it, otherwise surface the ownership question to the PO. Keep workflow identifiers and
internal process details out of comments, tests, messages and README drafts; required planning identifiers
belong only in the designated task-plan contract fields.
Preserve known decisions; propose any material contract change for the authorized global-plan workflow.
Include `summary` in each artifact: 1–2 sentences describing the chosen approach and why it meets the expected result.
Write ONLY task-plan-<id>.json in <absolute artifact directory> for each target: research, decisions,
steps, verification, open questions, writes, phaseBinding and unresolvedInputs. For every open question,
state who decides and by when with `decideBy`: `executor` (with the proposed `answer` the executor applies),
`user-now`, `{ "beforeTask": "<id>" }` or `{ "beforePhase": "<id>" }`. Each verification item may
declare required resources with `requires`; use only the documented vocabulary. Record anticipated project
paths in `writes`, all contained by that task's `touches`. Copy the exact phaseBinding and
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

## Portuguese planner prompt

When the planning conversation is in Portuguese, use this equivalent planner prompt:

```text
Você é o PLANEJADOR somente leitura da fase aprovada. Confira as ferramentas e permissões de gravação realmente
disponíveis; não deduza capacidades pelo nome do harness. Pesquise todas as tarefas alvo sem implementá-las.
Leia as regras do projeto, o objetivo e as restrições aprovados, os contratos das tarefas e as saídas de
dependências conhecidas: <referências>.
Leia a descoberta persistida da fase e suas decisões travadas: <phaseWorkflows.F2.discovery do state.json>.
Use as ferramentas disponíveis para inspecionar a implementação e os artefatos atuais, as regras reais do
projeto, as saídas de dependências e as fontes relevantes; identifique soluções existentes e impactos.
Aplique PO First. Não repita perguntas da descoberta; devolva ao orquestrador novas lacunas consequenciais.
Se recomendar texto de produto, descreva a regra observável e o motivo; nomeie a área responsável apenas
quando o contexto aprovado confirmar essa informação; caso contrário, leve a dúvida de responsabilidade ao PO.
Mantenha identificadores e detalhes internos do fluxo fora de comentários, testes, mensagens e rascunhos de
README; identificadores exigidos pelo planejamento pertencem somente aos campos do contrato do task-plan.
Preserve as decisões conhecidas; proponha qualquer mudança material de contrato para o fluxo autorizado do plano global.
Inclua `summary` em cada artefato: 1–2 frases descrevendo a abordagem escolhida e por que ela atende ao resultado esperado.
Grave SOMENTE task-plan-<id>.json em <diretório absoluto do artefato> para cada tarefa: research, decisions,
steps, verification, openQuestions, writes, phaseBinding e unresolvedInputs. Para cada pergunta em aberto,
diga quem decide e até quando com `decideBy`: `executor` (com a resposta proposta em `answer`, que o executor
aplica), `user-now`, `{ "beforeTask": "<id>" }` ou `{ "beforePhase": "<id>" }`. Cada item de verificação pode
declarar recursos exigidos com `requires`; use somente o vocabulário documentado. Registre em `writes` os
caminhos de projeto previstos, todos contidos nos `touches` da tarefa. Copie exatamente phaseBinding e os
unresolvedInputs da tarefa do resultado de `plan-phase`; não os recalcule nem renumere plannerRound.
Quando a discussão foi pulada, discussionRoundId é o decisionId da confirmação do pulo impresso pelo motor.
Schema: references/runtime.md#task-plan-artifact.
Inspecione o `git status --short` real e o diff relevante, staged e unstaged, durante o planejamento.
Identifique mudanças já presentes antes da execução para que o revisor as distinga da entrega desta tarefa.
Se puder gravar no diretório indicado, grave somente o arquivo exato task-plan-<id>.json para cada tarefa.
Se não puder gravar, devolva um artefato completo por tarefa: escreva o nome exato do arquivo na linha
imediatamente antes de um bloco aberto com ```json que contenha o objeto JSON inteiro e válido. Não abrevie,
omita campos, use reticências nem devolva objeto parcial. O orquestrador decodifica &gt;, &lt;, &amp; e &quot;
nos valores de texto do JSON, valida cada objeto completo, grava cada artefato no diretório indicado e então
conclui o planejamento. Se a validação apontar uma correção, ela volta ao planejador; o orquestrador não
inventa conteúdo de plano ausente.
Se não houver subagente planejador disponível, informe essa limitação e faça o planejamento localmente, com
pesquisa somente leitura, gravando apenas o artefato task-plan indicado. Não implemente o trabalho de produto.
Não edite o estado em .specs/graph/. Reporte o caminho do artefato, as descobertas e qualquer decisão que
bloqueie a execução.
```

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
node $ENGINE plan-phase F2 --agent plan-scenes  # one read-only planner for the phase
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory>
node $ENGINE plan-task T4 --agent <planner>     # task-scoped runs
node $ENGINE finish-planning T4 --plan <artifact.json>
```

## Baseline before execution

Before the executor starts, record the real `git status --short`, staged and unstaged diff for the
task's declared `writes` (or approved `touches` when `writes` is absent), and relevant pre-existing
untracked paths in a durable task note or review handoff. The planner identifies those existing
changes; the reviewer compares against this baseline and excludes them from the delivery judgment.

## Open questions after planning

After `finish-phase-planning` or `finish-planning`, the engine lists open questions for the user now and
those with a later deadline, and warns when an `executor` question has no proposed answer. Before execution,
take to the user only the `user-now` questions. A nonblocking question whose proposed answer the executor
applies is not a user question. A question due before a later task or phase is not asked now and is not
bundled with the execution authorization; it reappears in that target's discussion or planning.

`openQuestions[].decideBy` may be `executor`, `user-now`, `{ "beforeTask": "T2" }` or
`{ "beforePhase": "F2" }`; blocking questions still need answers before planning closes and mean
`user-now`. A future deadline does not hold its source task. At the named task or phase, the reference
appears in discussion/planning and `status` reports it when overdue. Resolve it in a later `decisions`
entry with `resolvesQuestion` set to the displayed reference; start remains gated only after that
deadline has arrived. In task-planning mode, a `{ "beforePhase": "F2" }` deadline becomes due when any
task in F2 begins discussion or planning.
