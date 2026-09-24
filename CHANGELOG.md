# Changelog / Histórico

Historical tag and commit corrections are documented in [Release history recovery](references/release-recovery.md).

## 2.0.0 — 2026-09-24

### Fixed — Content-addressed installations

- Identify same-version installations by the bytes in their distributed package and verify the full payload.
- Compare registered installations in the same language, including DeepSeek Harness.

### Fixed — Durable dashboard refresh

- Expose the served package identity through `/api/about` and the dashboard footer.
- Persist same-version CLI refreshes in the managed global package and verify the restarted server serves the expected identity.
- Identify port occupants without terminating another process or changing ports.

### Improved — Versioned package safety

- Require a SemVer bump when distributed package bytes differ from the last-release baseline.
- Validate local CLI archives in isolation and restore the previous global package if replacement verification fails.

## 1.3.17 — 2026-09-21

### Fixed — Safe plan synchronization

- Synchronize approved contracts for every nonterminal task while preserving lifecycle, attempts, evidence and terminal history.
- Recheck dependencies after synchronization, including legacy attempts, and prevent `--force` from bypassing unfinished prerequisites.
- Invalidate prior validation receipts when dependencies, phase, touched paths or other execution scope changes.

### Improved — Actionable graph diagnostics

- Show bounded field-level contract changes and exact dependency differences after `sync-plan`.
- Warn when a blocked task cites missing or reversed dependencies, and when a newly added task has no dependents.
- Recover stale pre-migration plan sources from central Prumo storage and record diagnostic-only synchronization events.

### Fixed — Partial run migration

- Adopt the current planning structure without interrupting active legacy attempts or holding unrelated new work.
- Apply discussion and planning gates to unstarted tasks and keep engine and dashboard state derivation aligned.
- Supersede stale discussion rounds after an approved plan changes so the complete current scope can be discussed again.

## 1.3.16 — 2026-09-18

### Improved — Complete installed guidance

- Document recoverable updates, safe run migration, transactional graph-foreman storage migration and dashboard restart ownership in English and Brazilian Portuguese.
- Explain the current PO First evidence, counterexample and prioritized-suggestion rules in both installation guides.
- Install and update both READMEs, the skill and runtime references consistently across Claude Code, Kiro and Codex.

### Fixed — Immutable skip decisions

- Require a nonempty reason when explicitly skipping work.
- Close an active delivery attempt as skipped without creating a validation receipt.
- Refuse to rewrite tasks that are already done or skipped.

## 1.3.15 — 2026-09-18

### Fixed — Recoverable updates

- Recover damaged installation markers only from registered installations and byte-verified Prumo backups.
- Reapply an update when managed files differ, an activation remains pending or the global CLI is absent.
- Refuse to replace a newer global CLI with an older npm `latest` release.

### Fixed — Transactional legacy migration

- Detect concurrent workspace changes before deleting generated legacy execution data.
- Restore a relocated workspace when a later installation step fails and preserve durable internal links across migration and restore.
- Refuse a migration before changing its source when a durable link targets an empty directory that cannot be recreated.

### Fixed — Dashboard restart ownership

- Wait for the previous Windows dashboard to release its port before starting its replacement.
- Avoid duplicate managed processes when the scheduled task is missing but the dashboard is already running.
- Persist a created Startup fallback before reporting a restart failure so a later disable removes it.

### Fixed — Task history consistency

- Close the active delivery attempt when a task is explicitly skipped without fabricating a validation receipt.
- Require `sync-plan` before retry when approved global plan decisions changed.

## 1.3.14 — 2026-09-18

### Fixed — Minimal legacy migration

- Move only graph state, saved graph backups and top-level plan or handoff files from a legacy graph-foreman workspace.
- Delete generated execution directories, dependency copies and build outputs after the required state is verified in Prumo storage.
- Complete the shared migration once instead of repeating a full workspace copy for Claude Code, Kiro and Codex.

### Improved — Fast first update

- Keep the recoverable state backup proportional to the plan data instead of the full execution workspace.
- Preserve conflicting graph copies and refuse migration rather than replacing current state.

## 1.3.13 — 2026-09-18

### Fixed — Bounded workspace updates

- Relocate a previously unmigrated central workspace without retaining its file payloads in the Node.js heap.
- Keep the original workspace inside the recoverable installation backup while copying and byte-verifying the destination.
- Detect concurrent workspace changes, preserve junction targets and report the migration instead of leaving the progress label on a harness update.

### Fixed — Current-version updates

- End `prumo update` before launching the isolated npm updater when the CLI and every managed Claude Code, Kiro and Codex installation already match npm `latest`.
- Continue the update when any one managed harness is stale or when an explicit language change was requested.

## 1.3.12 — 2026-09-17

### Improved — Evidence-focused PO First

- Preserve ordering, precedence, boundaries, invalid input and state transitions as explicit acceptance dimensions instead of collapsing them into a happy-path rule.
- Stop investigation once every material criterion and the highest-risk focused counterexample have current evidence, avoiding repeated sources and equivalent checks.
- Lead final reports with the observable result, followed by the relevant change, evidence and material limitation in language product stakeholders can use.

### Improved — Independent adversarial review

- Require the reviewer to derive one focused counterexample independently from the executor and implementation.
- Reject a plan defect when approved checks cannot establish a current criterion, even if unrelated tests pass.
- Keep reviews and suggestions proportional to concrete risks and useful next actions.

## 1.3.11 — 2026-09-17

### Fixed — Filtered graph context

- Keep every task and phase visible while dimming and disabling cards outside the selected filter.
- Preserve graph positions, zoom and canvas size when filters or dependency context change.
- Keep only matching tasks and their requested dependency context interactive.

### Fixed — Safe candidate updates

- Refuse to replace a locally installed newer candidate with an older npm `latest` release.
- Allow longer Windows cleanup retries after the isolated npm updater exits.

### Fixed — macOS path aliases

- Canonicalize the user home before checking linked installation paths, accepting macOS `/var` to `/private/var` aliases without weakening protection for linked skill directories.

## 1.3.10 — 2026-09-16

### Improved — Assertive next steps

- Give one to three concrete, prioritized suggestions when a substantive response warrants a next action.
- Add a fourth suggestion only when critical to prevent material failure, loss or blockage.
- Omit suggestions from trivial confirmations and completed work with no useful next action.

## 1.3.9 — 2026-09-16

### Fixed — Persistent Windows dashboard

- Launch the Windows Startup fallback with the configured environment and a stable working directory.
- Resolve and persist the actual server PID across activation, login and restart, accepting equivalent Windows path spelling while verifying process ownership.
- Bound process discovery and include the actual startup or restart error in CLI failures.

### Fixed — Dashboard failure recovery

- Keep healthy runs accessible when another graph directory is damaged or an update temporarily removes the dashboard page.
- Keep workspace auto-sync alive across incomplete state writes and retry synchronization failures.
- Report the version loaded at process startup instead of reading a newer package version into an older running process.

### Fixed — Complete harness updates

- Report invalid installation markers, continue updating independent harnesses and refuse to report overall success after a partial failure.
- Treat empty configuration and storage variables as unset, avoiding a false migration conflict with the current directory.

### Fixed — Dashboard filters and zoom

- Show matching tasks across all phases, compact empty lanes and include direct dependencies only when requested.
- Reveal a filtered-out task when opening its details from another panel.
- Preserve zoom and pan when opening or closing the legend.

### Fixed — Legacy workspace migration

- Preserve dependency links and Windows junctions, rebase internal targets and leave external targets untouched, with verified backup and rollback.
- Keep active legacy attempts resumable through independent review while structural migration is deferred; block new work until migration is safe.
- Exercise every version published on npm through its real updater, including merged history and in-flight work.

### Fixed — Interrupted update history

- Show release notes and the installed CLI version even when migration or activation remains incomplete.
- Retain the original update version until every installation succeeds, so retrying cannot lose missed release notes.
- Include the original npm releases in the update catalog, covering upgrades from 1.0.2 onward.
- Report each shared migration failure once across installed harnesses.

## 1.3.8 — 2026-09-15

- Allow user-selected independent phases to enter discussion and planning concurrently, regardless of phase numbering.
- Block an entire phase while any unfinished member has an unfinished external dependency, and show the blocking phase in the CLI and dashboard.
- Tell agents to preserve approved phase assignments and dependencies instead of rewriting the graph to bypass planning blockers.
- Keep new central runs in `~/.local/share/prumo` and follow stale central root references after verified graph-foreman migration.

## 1.3.7 — 2026-09-14

- Toggle the dashboard fit button between fitting the complete graph and a centered 100% view.
- Recover Windows dashboard restart when its saved process identity is stale or process discovery trails dashboard readiness.
- Wait for the previous dashboard to release its port and allow up to five seconds for startup before reporting failure.

## 1.3.6 — 2026-09-14

- Preserve the configured isolated environment when starting the dashboard in the background.
- Recognize Windows Startup dashboard processes despite harmless command-line spacing and filter candidates before exact ownership checks.
- Bound Windows process queries and refuse to downgrade runs written by a newer state schema.
- Verify clean npm/Bun installation, published 1.0.8 upgrade, legacy workspace migration, merged-task preservation and real Windows Startup restart end to end.

## 1.3.5 — 2026-09-14

- Move central graph-foreman workspaces to `~/.local/share/prumo` only after copying and byte-checking every file; preserve project-local runs and roll back conflicts.
- Treat a Windows-locked but empty legacy directory as completed data migration, while refusing cleanup if any file remains.
- Adopt a running legacy dashboard without a saved preference during update and preserve explicit opt-out.
- Choose phase columns from the available canvas, but grow each phase lane only as far as its task cards require.
- Expose `prumo migrate [--check] [--run <name>]` through the main CLI.

## 1.3.4 — 2026-09-14

- Show every missed release note when `prumo update` crosses multiple versions.
- Use the oldest installed CLI or harness version as the starting point so every updated environment receives its full change history.
- Add a versioned, idempotent state migration that runs before engine commands, backs up legacy state and enables discussion and planning gates without opening a round.
- Preserve `done` and `skipped` tasks byte-for-byte and refuse migration when active work or attempts make structural conversion unsafe.
- Add `migrate --check` for a read-only compatibility check and mark affected runs in `runs` output.

## 1.3.3 — 2026-09-14

- Resume corrective review at the first invalid validation step instead of repeating every earlier deterministic check.
- Add opt-in `cachePaths` to `cacheable` static steps, allowing a later reviewer to reuse prior passing receipts only when those declared files are unchanged.
- Keep functional checks and any static check without a safe path scope non-reusable across attempts.

## 1.3.2 — 2026-09-13

- Treat an explicitly named task as a hard planning boundary: use one discussion and one planner, and keep its prerequisites, evidence gaps and internal deliverables inside that task plan.
- Require explicit user approval before adding helper tasks, planning sibling tasks or dispatching extra planners.
- Keep graph-wide legacy contract normalization separate from planning scope, so migration does not silently expand the requested work.

## 1.3.1 — 2026-09-13

- Enforce declared phase order for discussion and planning: a later phase opens only after earlier phases are terminal, except when it provides a direct or transitive dependency required by nonterminal earlier work.
- Keep task dependencies from hiding the discussion and planning readiness of an eligible phase; they continue to gate executor dispatch after task plans exist.
- Require the Prumo skill to normalize every nonterminal legacy contract in the approved source, synchronize the original run and adopt eligible phases in order instead of creating an auxiliary run or migrating only the blocked task.

## 1.3.0 — 2026-09-13

- Start the read-only dashboard automatically after a global npm installation, with managed per-user startup on Windows, macOS and Linux and explicit `dashboard enable`, `disable` and `status` commands. Windows tries Task Scheduler first and falls back to one hidden current-user Startup entry when task creation is unavailable, without requiring administrator access.
- Discover registered Prumo workspaces without scanning the disk, expose `/api/health`, and preserve the dashboard as an observer that never synchronizes plans in global mode.
- Make large graphs responsive with lifecycle filters, optional direct dependency context, adaptive density, fixed-size arrowheads and a collapsible details panel.
- Discuss and plan once per phase. A read-only planner emits one immutable plan per task, records later-phase inputs and invalidates only plans affected by a material contract change.
- Reuse an approved task plan for ordinary executor retries; require a new revision only for a confirmed plan defect or changed contract.

## 1.2.2 — 2026-09-12

- Select discovery questions from the principal harness session's permitted native tools, including Codex asynchronous input and Claude Code AskUserQuestion, with structured conversational fallback for Kiro or other sessions without one. Require real answers before planning.
- Order the dashboard legend by lifecycle and color planning, execution and review counters consistently.
- Show executor step and validation-check fractions in event history, with attempt resets and explicit reused checks.

## 1.2.1 — 2026-09-12

### Added — Discuss before planning

- Run an agnostic discovery protocol in the principal Codex, Claude Code or Kiro conversation before dispatching the per-task planner. Every new task asks at least one contextual question, closes consequential PO First gray areas and records the answers for downstream work.
- Keep two planning levels explicit: global Plan/Spec mode defines the approved graph; each task then follows **discuss → plan → executor → reviewer** without requiring the whole execution to remain in Plan mode.
- Require `plan-task --context <discovery.json>` for new 1.2.1 tasks. The engine validates and atomically persists current discovery before changing the task to planning; the planner consumes it instead of asking again.
- Bind a canonical discovery digest to each planning round and taskPlan. Identical resubmission is a no-op; changed discovery supersedes the open round, and stale discovery cannot finish planning.

### Preserved — Compatibility and honest evidence

- Preserve 1.2.0 tasks and runs without retroactive discovery requirements. Tasks newly created by `init` or `sync-plan` receive `discoveryRequired: true`.
- Show escaped discovery research, questions, channels, coverage, decisions, deferred ideas and closure in the dashboard. The engine verifies structure and order, not the semantic quality of the conversation or the host UI used.

## 1.2.0 — 2026-09-12

### Added — Per-task research and planning

- Require a dedicated native planner for every new task after dependencies deliver and before execution. Apply PO First to current research, consequential questions, recorded decisions and task-specific execution plans without repeating global approval for ordinary refinement.
- Add `plan-task` and `finish-planning`, with structured sources/findings, decisions, steps, verification mappings and resolved blocking questions. Planning shares total agent capacity and does not consume an execution attempt.

### Added — Planning visibility

- Distinguish blue **ready to plan**, pink **in planning** and teal **ready to execute** in English and Brazilian Portuguese.
- Show a planner hub, role connections, task-plan details and planning time excluding pauses; retain all existing task states.
- Give the native run selector and its options explicit dark-theme colors to keep their text readable.

### Preserved — Existing work and independent review

- Preserve legacy tasks and history; tasks added to old runs require planning. Retry needs current research while retaining previous plans and receipts.
- Replan approved scope changes on paused active work, return it to blocked and explicitly resume the same attempt. Validation-only refresh still preserves execution.
- Keep independent review and behavioral gates. The engine checks structural evidence and context freshness; it does not certify research quality or real model dispatch.

## 1.1.2

### Fixed — Legacy run recovery

- Preserve completed and skipped legacy contracts during synchronization and retry; keep current contract and graph validation mandatory.
- Diagnose shell-consumed Windows paths before recording a validation attempt.

### Fixed — Windows state persistence

- Retry transient atomic rename failures with bounded backoff, preserve the previous state on failure and clean up owned temporary files when possible.

### Added — Executor alias and review guidance

- Accept `start --executor` as an alias for `--agent`, rejecting conflicting names.
- Explain that `validate --ok` executes real checks, environment failures require revalidation, and only an actual independent reviewer may approve work.

## 1.1.1

### English

#### Fixed

- Normal installation now uses the same compact progress display as updates; detailed file, backup and conflict output remains available with `--dry-run`.
- Harness detection now requires an executable, real configuration or managed installation marker; empty `~/.claude`, `~/.kiro` and `~/.codex` directories no longer select an environment.
- `retry` now refuses a failed task when its recorded contract differs from the approved plan and directs the agent to synchronize and inspect it first.
- New plans reject malformed functional validation during `init`; legacy pending tasks refuse dispatch until `sync-plan`, while active work can use `refresh-contract` without losing its attempt.
- Deterministic `static` steps marked `cacheable: true` can resume within the same attempt when the task, contract and Git workspace are unchanged; functional steps always run, and failures identify the exact step.

#### Added

- Successful updates now show English `Fixed` and `Added` highlights with descriptive subtitles for the installed version.
- The README now includes direct commands for automatic selection and each supported harness.

### Português (Brasil)

#### Corrigido

- A instalação normal agora usa o mesmo progresso enxuto das atualizações; arquivos, backups e conflitos continuam disponíveis com `--dry-run`.
- A detecção dos ambientes agora exige executável, configuração real ou marcador de instalação gerenciado; pastas vazias `~/.claude`, `~/.kiro` e `~/.codex` não selecionam mais um ambiente.
- `retry` agora recusa uma tarefa reprovada quando o contrato registrado difere do plano aprovado e orienta sincronizar e conferir primeiro.
- Planos novos recusam validação funcional malformada no `init`; tarefas legadas pendentes não são disparadas até `sync-plan`, enquanto trabalho ativo pode usar `refresh-contract` sem perder a tentativa.
- Passos `static` determinísticos marcados com `cacheable: true` podem ser retomados na mesma tentativa quando tarefa, contrato e árvore Git continuam iguais; passos funcionais sempre executam, e falhas identificam o passo exato.

#### Adicionado

- Atualizações concluídas agora mostram destaques em inglês com subtítulos descritivos de `Fixed` e `Added` para a versão instalada.
- O README agora inclui comandos diretos para seleção automática e cada ambiente compatível.

## 1.1.0

- Improve installation progress and harness detection, contract preflight, safe retry and resumable deterministic validation.
- Add English update highlights and direct installation commands. The original 1.1.0 snapshot is preserved by its recovered tag; 1.1.1 carries the subsequent release adjustments.

## 1.0.10

### English

- Migrate an existing graph-foreman skill into Prumo during installation: preserve non-product files, verify every written byte, then remove the legacy skill directory.
- Block conflicting custom files and roll back the affected installation group; existing run data stays at its original path.

### Português (Brasil)

- Migra uma skill graph-foreman existente para Prumo durante a instalação: preserva arquivos adicionais, confere cada byte gravado e depois remove a pasta legada da skill.
- Bloqueia conflitos entre arquivos personalizados e reverte o conjunto afetado; os dados das runs permanecem no caminho original.

## 1.0.9

### English

- Make `npx`/`bunx prumo update` install or update the global CLI, closing the upgrade gap for installations created by 1.0.5 or earlier; dry runs remain non-mutating.
- Keep one personal Prumo skill in Codex: prefer the shared `.agents/skills` root, while preserving `.codex/skills` when it is the only legacy installation.

### Português (Brasil)

- Faz `prumo update` via `npx`/`bunx` instalar ou atualizar a CLI global, fechando a lacuna de atualização para instalações criadas pela 1.0.5 ou anterior; a prévia continua sem alterações.
- Mantém uma única skill pessoal do Prumo no Codex: prioriza a raiz compartilhada `.agents/skills`, preservando `.codex/skills` quando ela for a única instalação legada.

## 1.0.8

### English

- Repaint the update progress line before every phase and use ASCII segments, preventing stale labels and broken bar glyphs in Windows terminals.
- Print the installed version below the success result and suppress successful npm runner notices while preserving actionable failure output.
- Move GitHub Actions from Node.js 20 runtimes to Node.js 24 and silence the optional empty-artifact warning.

### Português (Brasil)

- Limpa a linha de progresso antes de cada etapa e usa segmentos ASCII, evitando texto antigo e caracteres quebrados da barra em terminais Windows.
- Exibe a versão instalada abaixo do resultado de sucesso e oculta avisos do executor npm quando a atualização funciona, preservando erros úteis em falhas.
- Migra as GitHub Actions do runtime Node.js 20 para Node.js 24 e silencia o aviso de artefato opcional vazio.

## 1.0.7

### English

- Replace Windows `shell: true` npm launches with an explicit `cmd.exe` invocation, removing Node's `DEP0190` warning from `prumo -v`, installation and future updates.
- Make normal updates concise: hide npm chatter, show a colored phase progress bar in interactive terminals and finish with a single `Prumo updated successfully` result. `--dry-run` retains the detailed file and conflict preview; failures retain actionable errors.
- Detect complete same-version harness installations and report them without rewriting files or creating backups. The installer also skips reinstalling an already-current global CLI.

### Português (Brasil)

- Substitui chamadas npm com `shell: true` no Windows por invocação explícita do `cmd.exe`, removendo o aviso `DEP0190` de `prumo -v`, instalações e atualizações futuras.
- Torna a atualização normal enxuta: oculta o ruído do npm, exibe uma barra colorida de progresso por etapas em terminais interativos e termina com `Prumo atualizado com sucesso`. `--dry-run` preserva a prévia detalhada de arquivos e conflitos; falhas preservam erros úteis.
- Detecta instalações completas da mesma versão e informa o estado sem regravar arquivos nem criar backups. O instalador também evita reinstalar uma CLI global já atualizada.

## 1.0.6

### English

- Make a real installation persist the global `prumo` command. `prumo update` now updates that CLI and installed harness adapters together, so `prumo -v` reports the new version. Runner-based `npx`/`bunx update` remains non-global.
- Verify install, dry-run, self-update and `prumo -v` against an isolated npm prefix and registry; no test writes to the user's global installation.
- Remove nested borders from the dashboard's empty parallel-work state and ignore stale requests when switching runs, preventing old data from briefly repainting the selected plan.

### Português (Brasil)

- Faz a instalação real persistir o comando global `prumo`. `prumo update` passa a atualizar a CLI e os adaptadores instalados juntos; `prumo -v` mostra a nova versão. `npx`/`bunx update` continuam sem criar instalação global.
- Verifica instalação, prévia, autoatualização e `prumo -v` com prefixo e registro npm isolados; nenhum teste grava na instalação global do usuário.
- Remove bordas duplicadas do estado vazio no dashboard e ignora respostas antigas ao trocar de run, evitando que dados do plano anterior reapareçam brevemente.

## 1.0.5

### English

- Clarify domain-neutral contracts: separate approved context, current acceptance criteria and executable proof using existing fields. Replace superseded criteria instead of keeping contradictory historical requirements active.
- Document real rejection combined with an approved contract change: preserve the failure, synchronize the plan before retry, verify persisted criteria and dispatch the actual agent. Recover interrupted dispatch in the same attempt without inventing an implementation failure.
- Require relevant evidence for every functional criterion; clarify prerequisites, current test execution, artifact preservation and legitimate prose inspection without placeholder commands.
- Add an executable regression covering the combined rejection/change/retry lifecycle, including rejection of the old behavior and preservation of earlier evidence and unrelated active work. Keep engine commands, run formats and installer behavior unchanged.

### Português (Brasil)

- Esclarece contratos agnósticos: separa contexto aprovado, critérios vigentes e provas executáveis usando os campos existentes. Substitui critérios obsoletos sem manter requisitos históricos contraditórios ativos.
- Documenta reprovação real com mudança aprovada do contrato: preserva a falha, sincroniza o plano antes do retry, confere critérios persistidos e dispara o agente real. Recupera disparos interrompidos na mesma tentativa sem inventar falha da implementação.
- Exige evidência relevante para cada critério funcional; esclarece pré-requisitos, execução de testes atuais, preservação de artefatos e inspeção legítima em texto sem comandos de fachada.
- Adiciona regressão executável do ciclo de reprovação/alteração/retry, incluindo recusa do comportamento antigo e preservação das evidências anteriores e de trabalho ativo independente. Preserva comandos do motor, formatos das runs e comportamento do instalador.

## 1.0.4

### English

- Detect available Claude Code, Kiro and Codex environments and let users select one, several or all with terminal checkboxes. Add `install --all` for unattended installation; keep explicit harness flags and preview support.
- Use the operating system's configured country/region for the initial language: Brazil selects PT-BR; other regions or unavailable settings select English. Preserve installed preferences and explicit `--lang` overrides.
- Remove the dashboard language selector. The dashboard follows the installation, including when served by an already-running legacy server; browser language and old browser preferences no longer override it.
- Preserve existing graph-foreman runs, backups, compatibility entrypoints and automatic updates.

### Português (Brasil)

- Detecta Claude Code, Kiro e Codex disponíveis e permite selecionar um, vários ou todos com caixas de seleção no terminal. Adiciona `install --all` para instalação sem interação; preserva opções explícitas de ambiente e prévia.
- Usa o país/região configurado no sistema para o idioma inicial: Brasil seleciona PT-BR; demais regiões ou configuração indisponível selecionam inglês. Preserva preferências instaladas e escolhas explícitas com `--lang`.
- Remove o seletor de idioma do dashboard. O dashboard segue a instalação, inclusive em servidores legados já abertos; o idioma e as preferências antigas do navegador não o sobrescrevem.
- Preserva runs do graph-foreman, backups, caminhos de compatibilidade e atualização automática.

## 1.0.3

### English

- Standardize the displayed product name as Prumo across documentation, the installer, messages, skill instructions and dashboard. Keep commands, environment variables, storage keys and data formats compatible.
- Use version-only GitHub release titles. Register 1.0.1 retrospectively from the npm-scope change preceding 1.0.2; it was not previously published on npm.
- Align workspace setup examples with the engine: preserve explicit paths and reuse an existing central graph-foreman store across local harnesses; create the central directories when absent.
- Preserve the immutable npm 1.0.2 package; the branding adjustment ships as 1.0.3.

### Português (Brasil)

- Padroniza o nome visível como Prumo na documentação, instalador, mensagens, instruções da skill e dashboard. Preserva comandos, variáveis de ambiente, identificadores de armazenamento e formatos de dados.
- Usa somente a versão nos títulos das releases do GitHub. Registra a 1.0.1 retrospectivamente a partir da alteração do escopo npm anterior à 1.0.2; ela não havia sido publicada no npm.
- Alinha os exemplos de preparação ao motor: preserva caminhos explícitos e reutiliza o armazenamento central existente do graph-foreman entre ambientes locais; cria as pastas centrais quando ausentes.
- Preserva o pacote npm 1.0.2, que é imutável; o ajuste de marca sai na 1.0.3.

## 1.0.2

### English

- Use the npm package name `@henri-ralmeida/prumo`; keep the product, executable and skill named Prumo / `prumo`.
- Add `prumo update`: fetch the latest published installer, detect previously installed environments and registered custom paths, and preserve each installation's language. Preview, backups, independent conflicts and rollback reuse the installation workflow. Environments containing only graph-foreman remain untouched.
- Verify the public update command against a temporary npm registry, including old installations, preview and download failure.
- This is the first npm publication. GitHub's initial 1.0.0 release remains in history; no 1.0.1 npm package was published.

### Português (Brasil)

- Usa o nome npm `@henri-ralmeida/prumo`; mantém produto, executável e skill como Prumo / `prumo`.
- Adiciona `prumo update`: busca o instalador publicado mais recente, detecta ambientes já instalados e caminhos personalizados registrados, preservando o idioma de cada instalação. Prévia, backups, conflitos independentes e reversão reutilizam a instalação. Ambientes que contêm somente graph-foreman permanecem intactos.
- Verifica o comando público de atualização com registro npm temporário, instalações antigas, prévia e falha no download.
- Esta é a primeira publicação no npm. A release inicial 1.0.0 do GitHub permanece no histórico; não houve pacote 1.0.1 publicado no npm.

## 1.0.1

- Correct the npm scope to `@henri-ralmeida/prumo` and align package metadata with the retrospective 1.0.1 release.
- Recover the existing release commit so the tag and package version agree. This version was not previously published on npm.

## 1.0.0

### English

- Introduce Prumo: graph-foreman plus PO First, with one shared engine for Claude Code, Kiro and Codex.
- Add a persistent, dependency-free installer with preview, complete installation/configuration backups, independent conflict handling and restore.
- Preserve existing run locations, schemas and old entrypoints; installing never resumes tasks or manufactures attempts.
- Require executable behavioral evidence for functional approval while preserving justified inspection for documentation and other non-runtime work.
- Preserve attempts and paused state during contract refresh and direct review handoff; discard obsolete validation receipts.
- Add English/Brazilian Portuguese interface, messages, dashboard and documentation. Keep agent instructions in English and user data unchanged.
- Describe dashboard timings as observations; duration alone does not prove coverage, defects or a reason to disable review.
- Add Windows/macOS/Linux CI for Node.js 22 and 24, plus package-runner smoke checks.

### Português (Brasil)

- Apresenta Prumo: graph-foreman com PO First e motor comum para Claude Code, Kiro e Codex.
- Adiciona instalador persistente, sem dependências, com prévia, backup completo das instalações/configurações, conflitos isolados e reversão.
- Preserva locais dos planos, formatos e caminhos antigos; instalar não retoma tarefas nem cria tentativas.
- Exige evidência comportamental executável para mudanças funcionais, preservando inspeções justificadas de documentação e outros trabalhos sem efeito de execução.
- Preserva tentativas e pausas ao atualizar contratos e encaminhar revisões; descarta recibos desatualizados.
- Adiciona interface, mensagens, dashboard e documentação em inglês/PT-BR. Mantém instruções internas em inglês e dados intactos.
- Apresenta tempos como observações; duração isolada não comprova cobertura, defeitos ou motivo para dispensar revisão.
- Adiciona CI Windows/macOS/Linux com Node.js 22 e 24 e conferência da execução do pacote pelos gerenciadores.

## Upstream

Forked from [JrSantiaggo/graph-foreman](https://github.com/JrSantiaggo/graph-foreman) under its MIT license. Prumo's first public release is 1.0.0; earlier local corrections were not published Prumo releases.

Baseado em graph-foreman, preservando a licença MIT e o histórico Git. A primeira release pública do Prumo é 1.0.0; as correções locais anteriores não foram releases publicadas do Prumo.
