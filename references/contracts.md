# Validation contracts

[Português](contracts.pt-BR.md)

Read this when writing or translating a plan's `validation`, when checking an approved plan before the
first dispatch, and when adapting an old contract. Field-level syntax (`kind`, `cacheable`, `cachePaths`,
`env`, `shell`, `expectedExitCodes`, `timeoutMs`) is in [runtime.md](runtime.md#task-contract); how a
reviewer uses the contract is in [review.md](review.md).

## Domain-neutral contracts

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

## Context, current criteria and executable proof

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

## Behavioral validation

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
dispatch and review. Preserve every result-shaping dimension in that mapping: order and
precedence, boundaries, malformed or absent input, repetition and state transitions when they
apply. Do not let a broader check such as membership, success or nonempty output stand in for
one of those explicit rules. Commands run in order: prepare prerequisites before checks that need
them, and ensure skipped-build or filtered tests use the current delivery and execute relevant
cases. Do not hide failures or discard unrelated edits to make a check pass. Preserve earlier
evidence with distinct output paths when a check writes artifacts. Review existing artifacts
with read-only checks where sufficient; repeating an operational side effect needs its own
authorization and must not overwrite the delivery being reviewed.

## Legitimate inspection

Documentation and other tasks that do not affect runtime behavior may use
`validationMode: "inspection"` with a concrete `inspectionReason` in the approved plan.
Review the actual diff before accepting the exception. Do not use inspection for changed
runtime behavior, missing tools, unavailable environments, or a failing test. Those need an
actionable rejection or a blocked task. `requireReview: false` never waives functional checks.

## Environment, exit codes and deadlines

Before executing a check, make its environment and accepted outcomes explicit: use step.env
for environment variables (Unix NAME=value prefixes do not work in Windows cmd.exe),
step.expectedExitCodes for approved nonzero outcomes (default [0]), and step.timeoutMs for
long checks (default 600000; 0 explicitly disables the deadline). Never widen accepted codes
or increase a data window merely to satisfy the gate. See references/runtime.md for execution options.

This holds on Windows too. Keep the actual working directory in the approved validation step; do not translate or
rewrite its commands.
