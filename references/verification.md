# Verification

Observed checks, not a guarantee that every model, client configuration or operating system behaves identically.

Release candidate end-to-end checks can be repeated with `npm pack`, `node scripts/package-smoke.mjs`
and `node scripts/published-update-smoke.mjs`. The published-version matrix runs every Prumo version
available on npm against a local registry serving the candidate package. It preserves completed/skipped
tasks and exercises discussing, planning, running, reviewing, blocked, failed and validated continuation.
`node --test test/autostart-process.test.mjs` uses a real Windows dashboard process and the generated Startup VBS
in an isolated profile and port. Scheduler denial is simulated; the VBS is executed directly, without rebooting
or logging out. This does not claim that a real Windows login or native agent session has been tested.

| Layer | Evidence |
|---|---|
| Current automated suite | Engine, installer, update, autostart, server and dashboard checks run in CI; tests cover cumulative update notes, verified marker recovery, downgrade refusal, transactional central migration and legacy dashboard adoption |
| Phase discussion and planning | Engine lifecycle tests cover a persisted discussion before questions, current round receipts, one phase planner, atomic immutable task-plan batches, stale context, selective invalidation, legacy adoption and retry reuse |
| Later-phase inputs | Tests require a current independently reviewed validation receipt, or an explicit skip waiver, before execution; changing that receipt invalidates review and completion |
| Behavioral gate | Lint-only rejection, real code execution, justified documentation inspection, obsolete receipts and independent review |
| Global install and recovery | Isolated profiles cover global versus local postinstall, detected harnesses, partial success with nonzero exit, idempotent repair, disabled scripts, dry-run, update and preserved opt-out |
| Autostart | Simulated Windows Task Scheduler, macOS LaunchAgent, Linux user systemd and XDG fallback checks cover paths with spaces, enable, status, restart and removal without changing the test machine |
| Global read-only server | Fixtures cover no runs, one run, multiple known workspaces, registered projects, dynamic discovery, safe paths and `/api/health`; the global service does not use `--sync-plan` |
| Dashboard | Browser-oriented tests cover status filters, direct dependency context, 6/48/206-task density, responsive wrapping, fixed arrowheads, reduced motion, sidebar order and collapse, English and PT-BR |
| Packaged npm | `scripts/package-smoke.mjs` uses isolated npm prefixes and registries to verify the packed CLI, four complete adapters, update and registry failure; it does not alter real harness profiles |

The [CI matrix](../.github/workflows/ci.yml) runs supported automated checks on Windows, macOS and Linux with Node.js 22 and 24. Check the [Actions run for the release commit](https://github.com/henri-ralmeida/prumo/actions) and release notes for the exact result; platform-specific tests may be skipped elsewhere. Automated fixtures do not prove a real login startup, a real Claude Code/Kiro/Codex/DSH session, native question UI availability or model behavior. For DSH, fixture installation, `doctor --dsh` and `dsh --profile headless --dump-config` establish structural configuration only: they do not prove provider credentials, a real model conversation, model behavior or upstream stability. The source validated for this adapter was `@deepseek-ai/dsh` `0.1.6-alpha.2`, still alpha/developer preview. Verify broader claims on the target machine and harness before reporting them as observed.

The current version preserves graph-foreman durable state, older task-scoped runs and their history. Installation migrates graph state, saved graph backups and top-level plan or handoff files transactionally; generated execution directories, dependency copies and build outputs are discarded after verification, while project-local runs stay in place. The skill normalizes nonterminal legacy contracts before synchronization without widening the requested planning scope. New phased runs use one principal-conversation discussion and one read-only planner per phase. The user may plan independent phases in parallel; a phase waits when any unfinished member has an unfinished external dependency. When the user explicitly selects one existing task, it keeps one discussion and one planner; internal deliverables remain inside that task plan unless the user approves a graph expansion. Corrective review can reuse deterministic static step receipts only when declared paths remain unchanged; functional checks always rerun. The engine verifies record structure, freshness and receipts. The orchestrator, planner, executor and independent reviewer remain responsible for semantic quality and real dispatch.
