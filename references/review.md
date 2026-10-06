# Independent review, validation and rejection

[Português](review.pt-BR.md)

Read this when a task is `reviewing` or has a current validation receipt, before dispatching a reviewer,
before `validate`/`done`, and when a verdict comes back `failed` or the task is `failed`. The contract
rules the reviewer applies are in [contracts.md](contracts.md).

## Contents

- [What the reviewer gets](#what-the-reviewer-gets)
- [How deep the review goes](#how-deep-the-review-goes)
- [Inspecting checks and recording the verdict](#inspecting-checks-and-recording-the-verdict)
- [Failures that are not rejections](#failures-that-are-not-rejections)
- [After the verdict](#after-the-verdict)
- [Real rejection, including an approved contract change](#real-rejection-including-an-approved-contract-change)

## What the reviewer gets

Give the reviewer the **current validation contract**, relevant **approved context** and the
**diff or delivered artifacts**, without the executor's persuasive narrative. Identify
superseded requirements as history. The reviewer runs the project's gate ITSELF (see Project
overrides in [SKILL.md](../SKILL.md)), checks the contract clause by clause, and answers `--ok` or `--failed`.

```bash
node $ENGINE review T4 --agent rev-scenes       # executor finished → hand to a fresh reviewer
node $ENGINE validate T4 --ok --evidence "..." --cwd <absolute-project>  # the REVIEWER's verdict
node $ENGINE done T4
```

```text
You are the REVIEWER for <T4>: <title>. You did NOT produce this delivery.
Inspect actual `git status --short`, staged and unstaged diffs, then compare with this pre-start baseline: <baseline>.
Judge only new changes under declared `writes` (or approved `touches` when `writes` is absent): <diff, delivered artifacts or before/after state>
Against this contract, clause by clause: <validation>
Relevant approved context and constraints: <references; distinguish superseded history>.
Recorded taskPlan: <artifact>; treat it as evidence to inspect, not authority over the approved objective.
Challenge missing or incorrect planning/criteria instead of approving a flawed plan's implementation.
Read the project's agent rules and the relevant implementation, inputs, outputs and checks.
Inspect new comments, tests, messages, README and other product text. Reject new references there to
task/round/finding/criterion identifiers, internal process or orchestrator names, people's names, or a
decision's date or authorship; those belong in the approved contract, commit or ticket. Preserve dates that
support a measurement or describe product behavior. Check that business rules
state why and name the owning area or organization when known. If ownership is unknown, flag it for the PO
without inventing one; absence of a known owner is a notice, not by itself a rejection. Technical reasons
must not claim a business owner without evidence.
Check that the contract proves the changed behavior and that any inspection exception fits the diff.
Check each verification item's `requires`; report manual inspection as pending until you have inspected it.
Run the gate YOURSELF through engine validate: <Project overrides, engine path, absolute project cwd>.
Check the recorded output, actual relevant test count, and results against every criterion.
Never accept lint/build/typecheck, echo instructions, or zero relevant tests as functional proof.
Answer:
  verdict:  ok | failed
  summary: one sentence stating the result and why it meets or misses acceptance
  evidence: what you RAN and what it ANSWERED — commands and counts, not impressions.
  if failed: what is missing, specific enough for the next executor to act on.
```

What is absent from that message is the point: no executor report, no attempt count, no "the
suite was already green". A fresh agent, a clean context, and the contract.

## How deep the review goes

The first reviewer must inspect the full behavioral path and the relevance of the tests, not only
the changed lines. Independently derive one focused counterexample for the highest-risk applicable
criterion, especially an ordering, boundary, invalid-input or transition rule; do not copy the
executor's examples or mirror the implementation. If the approved checks cannot establish a current
criterion, reject it with an actionable reason instead of approving on unrelated passing tests. Under the
one-planner rule, unchanged-contract feedback returns to the executor; a missing acceptance decision blocks
for the user rather than silently dispatching another planner. Keep this probe
proportional: one discriminating case is preferable to a generic matrix. On a bounded corrective retry,
the next reviewer inspects the rejection, changed paths and remaining checks, and may trust current step
receipts that the engine explicitly reuses.
Once every applicable criterion has current evidence and the independent probe passes, stop the review.
Continue only for a failure, contradiction, uncovered criterion or concrete risk; repeated equivalent
commands and broad speculative checks add cost without strengthening the verdict.
Browser/API workflows need checks that exercise that workflow at the
appropriate layer; a pure helper test cannot prove a user journey. Keep tests scoped to the
task and add a final integration check when separate tasks must work together.

## Inspecting checks and recording the verdict

Before `validate --ok`, inspect the approved check output. Use `show-check <task> --check N --attempt K`
for the full stdout, stderr, working directory, exit code and reuse status of a stored check. On a first
review, run each approved check yourself and inspect its output before recording the verdict. Mark each
reviewed check or structured inspection criterion with `review-progress <task> --step N --agent <reviewer>`;
inspection tasks with structured criteria cannot pass validation until every criterion is traversed.
This progress is a traceable reviewer report, not proof that an inspection happened or that work passed.
Legacy inspection work without a recorded denominator stays unknown and does not gain invented criteria.
`validate --ok` reruns the approved commands and prints up to 15 output lines from functional and failed
checks; use `--tail 0` to suppress that preview. Summary labels only call out output text: judge the exit
code and relevant result against the criterion, never keywords alone.

Call `validate --ok --summary "<one-sentence PO First verdict>" --evidence "<complete observations against each criterion>" --cwd <absolute-project>`
after inspecting real `git status --short` and staged/unstaged diffs against the pre-start baseline,
the declared `writes` and approved `touches`, and the approved commands. Discount paths and hunks
already present before execution; a dirty path alone does not attribute a change to the current task.
Check every verification item's `requires`, including pending manual inspection, and record observations.
This runs the plan's commands and records
their output and exit codes; inspect those receipts before `done`. Avoid logging credentials.
Do not mutate the reviewed code while checks run; rerun validation if it changes afterward.
All steps rerun by default. Mark only deterministic `static` steps as `cacheable: true`; Prumo
may reuse their passing result within the same attempt and task state when the contract and Git
workspace are unchanged. Add safe relative `cachePaths` when that static check covers an isolated
set of files: after a corrective retry, the next reviewer resumes at the first failed or invalidated
step and reuses earlier passing receipts only while those declared paths are byte-for-byte unchanged.
Functional steps always run, and unscoped static steps restart on a new attempt. The engine checks
execution, not the semantic truth of `expect` or the declared `kind`.
Never label lint as functional to satisfy the gate. Shell commands execute with the caller's
permissions; the approved plan is not permission for unrelated or destructive side effects.

A rejection is recorded the same way with `validate <task> --failed --summary "..." --evidence "..."`.

## Failures that are not rejections

- `validate --ok` **executes the contract commands**, including database and network operations. It is not a manual approval flag. Read each check's output and failed index before deciding whether failure is implementation, environment, or contract related.
- A failed network/VPN check keeps the gate failed even if the reviewer considers the implementation correct. Restore the environment and have the independent reviewer validate again in the same attempt. Use `fail`/`retry` for an actual rejected implementation, not a transient environment failure. Functional checks always rerun; only explicitly cacheable static checks can reuse unchanged evidence.
- The executor must not approve its own work. The orchestrator must not impersonate the reviewer by issuing approval on its behalf. The engine checks recorded roles, not the identity of the shell caller. If the reviewer session is gone, dispatch a fresh independent review agent; hand off through `block` and `unblock --reviewer <new-agent>`, then let that actual agent run validation.
- Quote absolute working directories. In a POSIX shell on Windows use forward slashes, for example `--cwd "C:/work/project"`. Invalid directories are rejected before a gate receipt is created.

## Delivered scope verification

With `scopePolicy: "explicit"`, compare actual delivery to the pre-`start` baseline, including tracked and untracked files visible to Git. New `files` changes must fit `touches`; `read-only` may not change files. A path already dirty before execution and unchanged afterward is not this task's delivery. Also check authorized external-resource access and its evidence; Git does not observe tables, services or environments.

The engine checks scope during `validate` and again at `done`, but Git-ignored files are outside this observation. When Git or its baseline is unavailable, record that limitation and require current evidence from the independent reviewer through `validate --ok --scope-evidence "<scope observations and limitations>"`. This receipt does not pretend an automatic comparison happened or waive observed unauthorized writes. Preserve production validation and independent review.

The attempt records the disjoint file scopes of contemporaneous executors; a new executor also updates earlier active attempts with its scope. Git observes changed paths globally, not authorship. Changes outside this task may be excluded only when they fit those recorded other scopes and the current independent reviewer supplies explicit attribution through `--scope-evidence`. The scope receipt records `excludedPaths` and the authorship limitation. Observed changes outside every authorized recorded scope always block, even with reviewer evidence. `done` requires the same delivery fingerprint and reviewer identity as the passing receipt; changes after validation require fresh verification. Ignored files are not audited automatically: the scope receipt always exposes that limitation and the independent reviewer must inspect them separately, without a mandatory `--scope-evidence` flag just for ignored paths. Unavailable Git/baseline, submodules and non-Git workspaces require explicit `--scope-evidence`, as does attribution to another executor; external-resource effects need their own observations. The fingerprint conservatively covers all Git-visible changes: any change after validation, including another executor's change, requires new validation so attribution evidence cannot become stale.

## After the verdict

- **`--summary` records the reviewer's concise PO First verdict** when supplied; blank values are refused.
  **`--evidence` records the complete behavioral observations** and must not be empty or replaced by the summary.
  Command results are collected by the engine; the reviewer still checks their relevance.
  `done` refuses without a passing review validation for the CURRENT attempt — the one rule
  that stops "it looks right" from becoming state.
- **Rejected delivery** → follow "Real rejection" below; synchronize any approved contract
  change before retry. The reason travels to the next executor and must be actionable.
- Past **3 attempts** the engine warns — escalate to the dev instead of spending more.
- The reviewer needs the dev, or a decision is missing → block the task as described in
  [recovery.md](recovery.md#blocking-and-user-decisions).
- Discussion/planning skip receipts never waive the independent reviewer. New Prumo work keeps review on;
  `requireReview: false` is compatibility state for older runs, not a current routing recommendation.

## Real rejection, including an approved contract change

Distinguish an implementation that failed an applicable criterion from a request for new scope
or missing verification. Fixing an actual defect within the approved scope is already authorized.
Reuse explicit user steering as approval; ask only when a new requirement remains undecided.

| Situation | Next action |
| --- | --- |
| Actual rejected delivery, unchanged contract and sound plan | Record the reviewer's actionable `fail --reason`, then `retry` and `start`; the engine reuses the approved plan only while its contract, discovery, scope and dependency binding remain current. |
| Reviewer finds implementation guidance incomplete, but the approved contract is unchanged | Record an actionable `fail --reason` without `--plan-defect`, then `retry` and send the same task plan plus that reason to the next executor; do not dispatch another planner. |
| Actual rejected delivery, approved contract also changed | Record the real failure; edit the approved plan; `sync-plan` while `failed`; inspect the persisted contract, `touches` and dependencies; then `retry`, fresh task planning and execution. |
| Delivered work needs only an approved validation update | `refresh-contract`, then verification by an independent reviewer in the same attempt; no invented failure or executor. |
| New scope after `done`/`skipped` | Create an explicit follow-up through the approved planning workflow; preserve completed history. |

For the combined rejection case, phased runs use their phase workflow. A selective defect targets only
the affected task; a shared phase decision targets the phase's nonterminal members. Legacy task-scoped
runs retain `begin-discussion`, `finish-discussion`, `plan-task` and `finish-planning`. For a phased run:

```bash
node $ENGINE fail T4 --reason "review: <actual unmet criterion>" --run <run-name>
# Edit the approved plan; separate current criteria from superseded context.
node $ENGINE sync-plan --plan <approved-plan.json> --run <run-name>
node $ENGINE graph --run <run-name>  # inspect T4's persisted definition before retry
node $ENGINE show-contract T4 --diff --run <run-name>
node $ENGINE retry T4 --run <run-name>
node $ENGINE begin-phase-discussion F2 --run <run-name> # before the principal-chat question
node $ENGINE finish-phase-discussion F2 --context <discovery.json> --run <run-name>
node $ENGINE plan-phase F2 --agent <planner> --run <run-name> # pair with one read-only planner dispatch
node $ENGINE finish-phase-planning F2 --plan-dir <artifact-directory> --run <run-name>
node $ENGINE start T4 --agent <executor> --run <run-name>  # pair with actual dispatch
```

Resume from the recorded phase if some steps already happened. `retry` alone does not reload
the plan and refuses to proceed when the recorded failed task differs from its approved source;
run `sync-plan` and inspect first. `sync-plan` updates every nonterminal definition without changing its
lifecycle and preserves completed definitions as immutable history; refresh only updates validation fields
and does not record a rejection. Preserve the prior attempt's
reason and evidence. A bounded corrective retry records `planSourceAttempt` separately from the
immediately rejected `correctionOf` attempt and carries that review reason as execution context,
without changing the approved task plan or adding a fabricated planning round. Missing reviewer rationale,
`--plan-defect`, or a changed contract, discovery, scope or dependency result makes the engine require
planning. Do not set `--plan-defect` for unchanged-contract review feedback under the one-planner rule;
block and obtain an explicit contract decision when the existing contract cannot resolve the gap. Prefer the harness's structured editor for the approved plan. If a
temporary program is the safest way to change a large plan, verify its backup and exact diff,
then remove it; that helper is not a Prumo transition.

A reviewer-rejected implementation with an unchanged approved contract must reuse its current approved
plan for every correction, regardless of retry count, while the complete recorded planning context still
matches. Review feedback travels to the next executor; it does not dispatch a planner. Only an explicitly
approved material contract change requires fresh planning while preserving prior plans and evidence.
