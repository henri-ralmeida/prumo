# Security audit (ethical hacker)

An opt-in offensive audit after every delivery task is `done` or `skipped`. The demand remains **DONE**
while the independent auditor tests delivered business behavior locally and records proven findings.
The audit has its own contract, attempts and results panel; it never creates task cards or task filters.
Only correction tasks chosen by the user after the report finishes enter the same graph and reactivate
delivery. Those tasks follow ordinary planning, execution and independent review. The auditor is never
the executor, reviewer or planner of a delivery task.

The goal is not a list of weaknesses. It is a short set of **proven** findings, each scored the same way by any
auditor, each precise enough to become a fix task. The test roadmap (WSTG categories, API Top 10, CWE order,
specialist lenses) is in [security-audit-playbook.md](security-audit-playbook.md); read it when you reach
the vulnerability analysis phase.

The dashboard and interactive guide place the ethical hacker beside the orchestrator, directly above
the reviewer. Its gray, solid connection indicates inactivity. Only a running audit uses its highlight
color and a dashed, animated connection, so activity remains distinguishable from availability.

Click **Ethical hacker** beside the Orchestrator, then **Audit overview**, to inspect recorded attempts,
findings, evidence, reproduction and remediation on the same page. Close the panel to return to the graph.
The task filters apply only to delivery and correction tasks. The guide demonstrates the independent audit
with disposable data; its connection is inactive while another entity is being demonstrated. Active
connections start at the Orchestrator using the color of the role being served, without an extra yellow segment.

## Contents

- [Rules of engagement](#rules-of-engagement)
- [Phases](#phases)
- [Mandatory minimum checklist](#mandatory-minimum-checklist)
- [Severity](#severity)
- [What is not a finding](#what-is-not-a-finding)
- [Re-audit](#re-audit)
- [Report JSON](#report-json)
- [Lifecycle](#lifecycle)

## Rules of engagement

These rules are not trade-offs. If one cannot be met, **stop and report** the limitation as an `info` finding.

**Scope and target**

- Attack only the approved scope: the tasks in `brief --role security`, the code they delivered and the validated local environment.
- Send traffic only to the host recorded by `audit-start` (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`). Link-local and private addresses (for example `169.254.169.254`, `10.x`, `192.168.x`) are **out of scope**, including as SSRF destinations.
- Run the target from its own start command with fixtures, seed data or disposable state. Never point it at a shared or production database, queue, bucket or API.

**Safety**

- Nothing destructive. No deleting or overwriting data you did not create, no dropping tables, no stopping services you did not start.
- No denial of service. Hard limits per audit:
  - brute force or credential guessing: at most **50** attempts per account and per route;
  - race conditions: at most **25** parallel requests per burst and **5** bursts per hypothesis;
  - total traffic: at most **2,000** requests, at most **20** per second outside race bursts;
  - payloads: at most **1 MB**, or the documented limit plus 1 KB when you test that limit;
  - algorithmic complexity (ReDoS, deep JSON, zip bombs): one request with a client timeout of at most **5 s**; stop at the first sign of slowdown and report it.
- Do not use traffic or concurrency limits as permission for load testing. When an availability hypothesis would require a flood, sustained traffic or a saturation test, record it as an unverified limitation in `summary`, without a blocking finding. A slow password hash or synchronous handler alone does not prove loss of service. An availability failure reproduced with one safe request is scored normally from its observed impact; it has no automatic severity cap. Never continue a proof after observing slowdown.
- No persistence: no backdoors, cron entries, new admin accounts kept after the test, or modified binaries.

**Data and credentials**

- No data leaves the machine: no uploads, telemetry, pastebins, online scanners, online calculators or external callback services. Out-of-band proofs use a listener **you** start on the local host.
- No real credentials. Create test accounts from the project's seed or example configuration. A credential you find in the repository is **identified**, never used outside the local target, and never copied into the report.
- If real personal data or a real secret appears, stop that line of testing, do not copy the value and report its location and type only.

**Proof materials: canaries are mandatory when the target has a file, command or outbound-network sink**

- A canary is required **only** when the target has a sink that reads or writes files, runs commands or makes outbound requests. When it has none, do not create one: record "canary: not applicable (no file, command or outbound sink)" in `summary`.
- File read and write proofs use **canary files you create**, never real files. Create a sandbox `.prumo-audit/` inside the target directory (or a fresh directory under the system temporary folder) and put `canary-<nonce>.txt` there with a random nonce as its only content.
- To prove path traversal, place the canary **outside** the directory the code is meant to confine and read it back. Escaping the intended directory is the proof; the reach beyond it is stated in `severityRationale`, not demonstrated.
- Forbidden proof targets: `C:\Windows\win.ini`, `C:\Windows\System32\drivers\etc\hosts`, `/etc/passwd`, `/etc/shadow`, `~/.ssh/`, `~/.aws/`, browser profiles, the project's real `.env` or any file that may hold a secret.
- Injected commands are harmless and observable: write the nonce to a file in the sandbox, or `echo` the nonce into the response. Never `whoami`, `id`, `env`, `set`, `printenv`, `hostname`, network commands, or anything that reads secrets, lists the user's files or reaches the network.
- SSRF proofs target a local listener you start (an ephemeral port on `127.0.0.1` answering the nonce) or a loopback-only route of the target itself.
- XSS proofs use an inert marker (`<img src=x onerror="document.title='prumo-<nonce>'">`), never a payload that sends cookies anywhere.

**Tools and cleanup**

- Do not install tools. Use what the project already provides (its test runner, its dependency audit command, the language runtime) and the shell. List every tool you ran in `tools`.
- Keep an engagement log (time, request or command, purpose, result) in the sandbox while you work; the report's `reproduction` fields are its durable form.
- When done, remove everything you created: sandbox, canaries, accounts, records, listeners, processes. State in `summary` that cleanup was done, or what could not be removed.
- Remove the sandbox with `node -e` calling `fs.rmSync` on the `.prumo-audit/` directory only, after checking that the resolved path ends in `.prumo-audit` and lies inside the target or the system temporary folder. Do not use recursive shell deletion: environment guards block it and a wrong path would be destructive.

## Phases

The phases follow PTES and NIST SP 800-115 (planning, discovery, attack, reporting), adapted to a run whose
scope and intent are already written in task cards.

1. **Pre-engagement.** Run `brief --role security` and read every card: contract, plan, deliveries and last independent review. Progress notes are not part of the brief: you judge the delivery, not the narrative. When `previousBlocking` is present, this is a re-audit (see [Re-audit](#re-audit)). Write down, before touching the target:
   - the **intended exposure** of each component (public internet, partner network, internal network, local machine only): it drives the CVSS Attack Vector, not the fact that you test on localhost;
   - the **actors and privileges** (anonymous, self-registered user, partner, operator, admin; is registration open?);
   - the **sensitive assets** (personal data, money, credentials, other tenants' data, the host itself);
   - the **decisions the cards made deliberately** (for example "any callback address is accepted"): they are inputs to threat modeling, not exemptions;
   - the **ASVS level**: L1 for low-risk internal tools without personal data; L2 by default for anything with accounts, personal data or money; L3 for payments, health, credentials or safety. Use the ASVS edition the project already follows and say which in `summary`.
   If the approved materials leave intended exposure or impact unclear and the choice could change blocking, state the missing fact and ask the orchestrator to obtain the user's decision. Do not infer internet exposure from a project name or local test URL, or silently choose a lower-impact interpretation.
2. **Reconnaissance.** Read the code before sending traffic. Inventory routes, methods, parameters and authentication per route; data stores and how queries are built; external commands; file paths; outbound requests; configuration files, committed keys and debug switches; dependencies and the project's own audit command; jobs and CLIs that share code with the HTTP surface.
3. **Threat modeling.** Apply STRIDE to each card. Draw the trust boundaries and the data flows that **cross cards**: where does a value produced by one task reach a sink owned by another, and what does one task assume another enforces? These emergent flaws are the audit's main value, because each task was reviewed alone. Typical shapes: task A accepts a value "as requested" and task B uses it in a shell, SQL, path or fetch; task A stores a field and task B trusts it for authorization; task A checks a limit and task B awaits between the check and the write; task A logs or returns data that task B treats as secret. Write prioritized hypotheses (impact times likelihood), each naming its cards.
4. **Vulnerability analysis.** For each hypothesis find the exact location (`file:line`, route) and precondition, map it to the playbook tests and run the project's own dependency audit if it has one. Drop hypotheses the code clearly refutes and note them in `summary`, one line each.
5. **Exploitation.** One **minimal** proof of concept per finding: the smallest request sequence or script that shows the impact. Reproducible (a `node --test` file, a script or a `curl` sequence the user can rerun against a fresh start, with placeholders such as `<fixture-token>` for credentials) and deterministic where possible. For races, show the success count across bursts (for example "3 of 25 parallel checkouts used a single-use coupon, in 5 of 5 bursts"). Record the observed response, status and the canary or nonce that proves it in `evidence`.
6. **Controlled post-exploitation.** Measure impact and chaining only: which data or functions the proof reaches, and whether one finding removes the precondition of another (a committed key that unlocks an authenticated injection). Do not pivot, keep access, escalate on the host or touch anything outside the target. A chain you claim must itself be proven under the canary rules.
7. **Reporting.** Score each finding, write the report JSON, clean up and record it with `audit-finish`.

## Mandatory minimum checklist

Run every item on **every** audit, whatever hypotheses the threat model produced, and record each one in `summary` as
done (with the result) or not applicable (with the reason). The playbook holds the detail of each test.

1. **Brute force and lockout** on login and any other credential check: attempt limit, lockout or throttling (within the 50-attempt cap).
2. **Access control by owner or object (IDOR/BOLA)** on every route that takes an id: can another user read or change it?
3. **Privilege escalation and mass assignment**: can a user set role, owner or privileged fields, or reach admin functions?
4. **Injection** at every point that builds a query, command or path from input (SQL, shell, path traversal, template).
5. **Secrets and credentials** in the repository, configuration and logs: committed keys, tokens or passwords, and values written to logs.
6. **Input validation and size limits**: malformed, oversized or unexpected-type input on each entry point.
7. **Tokens and sessions**: signature checked, expiration enforced, no acceptance of unsigned or altered tokens.
8. **SSRF** wherever the server makes an outbound request from input (not applicable when there is none).
9. **Dependencies**: run the audit command the project already has (not applicable when it has none).
10. **Business rules that cross cards**: price, coupon, balance, quota and concurrency (races) where one task's value is used by another.

## Severity

The severity that decides blocking is the **final CVSS v4.0 score** of the finding, read through the official bands,
with one exception for a short list of classes (the class floor). The score is computed first; the severity
follows from it, never the other way round.

| Final score | Severity |
| --- | --- |
| 9.0 – 10.0 | `critical` |
| 7.0 – 8.9 | `high` |
| 4.0 – 6.9 | `medium` |
| 0.1 – 3.9 | `low` |
| 0.0 (None) | `info` |

### Which score is final

1. **CVSS-B (base).** The default. It scores the vulnerability **as it will be exposed when the demand ships**, as the cards and README describe it; the local test only proves it.
2. **CVSS-BE (base plus environmental).** Used instead of the base score **only when a card or contract proves the context**: the internal service holds secrets, the data classification, the deployment. Environmental metrics are the security requirements `CR`, `IR`, `AR` and the modified base metrics (`MAV` ... `MSA`). Every environmental metric you set must cite, in `severityRationale`, the task (`T<number>`) whose card proves it. Without that evidence, no environmental metric is allowed and the base score stands.
3. Do not set Threat metrics (`E`): the proof already exists, and lowering by exploit maturity would hide risk.
4. Environmental requirements do not amplify impact on a **subsequent system** (`SC`/`SI`/`SA`) in CVSS v4.0, so never use them to push a score up. A finding whose class deserves more weight uses the class floor below, not a tuned vector.

The report records the base vector in `cvss`, and, when a card justified them, the environmental vector in
`cvss.environmental`. The **engine calculates the score** from those vectors; the final score is the one of
`cvss.environmental.vector` when present, otherwise the one of `cvss.vector`. The engine stores the calculated values
as `cvss.computedScore` and `cvss.environmental.computedScore`.

### Scoring the base metrics

- **AV**: the intended exposure stated by the demand (an explicit sentence in a card or README about who reaches it), not where the test harness binds. A README that says the harness "binds to 127.0.0.1" does not make a service `L`. Public or partner API, and internal services reachable over a routed corporate network: `N`. A service intended to listen only on loopback, or a CLI or file reached only from the machine: `L`. Same network segment only: `A`. Physical access: `P`. A loopback-only service that can still be driven from a browser (CSRF, DNS rebinding) and that you proved is `N` with the matching `UI`.
- **AC**: `H` only when the attacker must defeat a security measure (ASLR, a secret nonce, a cryptographic check); otherwise `L`.
- **AT**: `P` when success depends on conditions outside the attacker's control: a race window, a victim's weak password, an attacker-in-the-middle position, a non-default configuration; otherwise `N`.
- **PR**: `N` for anonymous access. Open self-registration still means `L`: the attacker needs an account, even one anyone can create. `H` for operator or admin roles.
- **UI**: `N` none; `P` passive (the victim only views a page, as in stored XSS); `A` active (the victim must click or submit).
- **VC / VI / VA**: impact on the **vulnerable system**, the component the demand delivered. `H` is total loss (all records, any file the process can read, code execution) or a serious direct consequence (orders at a price of zero); `L` is partial or constrained.
- For cross-tenant disclosure, distinguish an unrestricted protected collection (for example, invoice ids that can be enumerated across customers) from a constrained disclosure. Use `VC:H` for the whole protected collection or a direct, serious confidentiality consequence; use `VC:L` for limited disclosure without that consequence. Explain the demonstrated scope and the assets identified by the cards instead of treating any cross-tenant response as automatically high impact. These are the [FIRST confidentiality-impact criteria](https://www.first.org/cvss/v4.0/specification-document#confidentiality-vcsc).
- **SC / SI / SA**: impact on **subsequent systems**: the victim's browser for XSS, internal services reached through SSRF, other systems reached with a leaked credential. `N` unless you can name the subsequent system.

### Computing the score

The CVSS v4.0 score comes from FIRST's lookup table of macro vectors, not from a formula you can reproduce by hand.
The engine embeds that table and calculates offline, so no estimate is needed.

- Run `audit-cvss "<vector>"` (read-only, no run needed): it prints the score, the severity and the nomenclature (`CVSS-B`, `CVSS-BT`, `CVSS-BE`, `CVSS-BTE`). Use it while you decide the metrics, especially near 4.0, 7.0 and 9.0, where a 0.1 difference changes whether the run is blocked.
- Never paste a vector into an online calculator yourself.
- `score` in the report is optional. When you write it and it differs from the engine's calculation, `audit-finish` refuses the report and shows the calculated value. `scoreSource` is accepted and ignored.
- The engine checks the vector syntax, calculates the final score and requires the severity to match its band (or a valid floor).

### Class floor

If the finding belongs to one of these classes **and the proof you executed shows the real impact**, the gate
severity is never below `high`, whatever the score says:

| `severityFloor.class` | Applies when the proof shows |
| --- | --- |
| `ssrf-internal` | a server-side request that reaches the internal network, loopback or a metadata-style address and returns data from it (proved against a local listener or loopback route; the metadata reach is stated, never tested) |
| `rce` | remote code or command execution (the nonce file or the nonce in the response) |
| `auth-bypass` | authentication bypassed: a forged or unsigned token, a skipped login, a session accepted without credentials |
| `credential-exposure` | a valid, reusable credential (token, key, password or session) is reachable by people or processes that should not hold it, through the API, the repository, logs or files those people or processes can read, **and your proof reused it** against the target. It does not depend on `AV`. A committed key you identified and reused counts; a hash you cannot use does not; a secret in a file only its owner can read does not |

Rules:

- The floor only **lifts to `high`**. `critical` needs a final score of 9.0 or more, reached by the score itself or by a documented chain (`chainedWith`, with the chained vector scored and explained).
- A finding with a floor reports `severity: "high"` and `severityFloor: { "class": ..., "evidence": "<what the PoC proved>" }`. The score keeps its honest value; the dashboard shows both.
- No floor for a hypothesis without a proof of concept, and no floor for a class that does not match the proof. When the final score is already `high` or above, the floor changes nothing.
- Without `severityFloor`, the severity **must** match the band of the final score; the engine refuses any other severity.

### Adjustments

Two adjustments to the base score are allowed, each stated in `severityRationale`:

- **Chaining**: when another proven finding in the same report removes a precondition (a committed key turns `PR:L` into `PR:N`), score the chained vector, list the enabling findings in `chainedWith` and explain the chain. The enabling finding keeps its own score.
- **Environmental**: the CVSS-BE rules above, with the card that proves each metric.

`severityRationale` states the intended exposure behind `AV`, who the attacker is (`PR`), what the proof reached
and any adjustment, in one to three sentences. It is required when `cvss.environmental` is present.

`low` and `info` findings may omit `cvss`. A finding without `cvss` cannot be `medium` or higher.

## What is not a finding

- An environment failure, an unavailable service, or a tool the project does not have: `info` with the explicit limitation.
- A hypothesis without a proof of concept: `info` stating what was tried and why it was not proven. Never raise a severity without a proof.
- **An explicit card decision.** When a card or contract consciously accepted the exact risk you observed, the finding is `low` or `info` (without `cvss`), cites the card (`T<number>`) in `severityRationale`, and does not count as `medium` or higher. Examples: a 409 on an existing e-mail so people know to sign in; an account locked after N failed logins, declared as a trade-off against guessing. It **is** a finding, scored normally, when the attack gives more than the card acknowledged: accepting any callback address also lets callers reach internal services, and a lockout that any anonymous caller can trigger for any account, with no per-source limit, is more than the card's "lock after N failures" described.
- A missing hardening control with no demonstrated attack path (a missing header on an API that serves no HTML): `low` at most.
- A vulnerable dependency whose vulnerable code is not reachable from the delivered features: `low`, with the reachability analysis.

## Re-audit

A re-audit is a new, independent attempt after fixes or reopened tasks. `brief --role security` then carries
`previousBlocking`: the blocking findings of the last finished attempt, with their resolution (accepted, fix task
or open).

- Retest **every** blocking finding of the previous attempt that was not accepted: the original reproduction first, then one variant that targets the fix (encoding, another route, another parameter).
- List the ids you retested in the top-level `revalidates`. It is **required** when any unaccepted blocking finding exists: it must contain all of them, and may add other ids of the previous report. An id that was not in the previous report is refused, and so is `revalidates` in a first attempt.
- A finding that persists is reported again in `findings` with the **same id**, fresh evidence and its current score. A fixed finding is listed in `revalidates` and not in `findings`; the `summary` says how the retest failed. Accepted findings are not retested.
- New findings get ids the previous attempt did not use.
- Run the full methodology again on the changed code and on its interactions; fixes create new cross-task flows.

## Report JSON

Strict schema: unknown fields are refused, and `accepted` is set only by `audit-accept`. The engine records
`reportSchema: 2` on every attempt started by `audit-start`; an attempt recorded without it (started by an older
version) keeps the previous format, which has no `location`, `wstg`, `cvss`, `severityRationale`,
`severityFloor`, `chainedWith` or `revalidates`.

```json
{
  "summary": "Audited the invoices API locally against ASVS 4.0.3 L2 (customers, invoices, profile, admin listing). Two high findings and one low finding; the IDOR from attempt 1 is fixed (the same request now answers 404). Sandbox, fixture accounts and listener removed.",
  "environment": "http://localhost:3000",
  "tools": ["node --test", "npm audit"],
  "revalidates": ["F1"],
  "findings": [
    {
      "id": "F2",
      "severity": "high",
      "title": "Profile update lets a customer set their own role",
      "cwe": "CWE-915",
      "wstg": ["WSTG-INPV-20", "WSTG-ATHZ-03"],
      "taskRefs": ["T3", "T4"],
      "location": "server.mjs:123 PATCH /users/me",
      "cvss": {
        "version": "4.0",
        "vector": "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N"
      },
      "severityRationale": "Public API (AV:N); any self-registered customer (PR:L) promotes themselves to admin through T3's generic update and T4 trusts the stored role, exposing every invoice.",
      "attackPath": "Register a fixture customer, PATCH /users/me with a role field set to admin, then call the admin listing.",
      "evidence": "PATCH answered 200 with role admin; GET /admin/invoices then answered 200 instead of 403.",
      "reproduction": "curl -X PATCH -H 'Authorization: Bearer <fixture-token>' -d '{\"role\":\"admin\"}' http://localhost:3000/users/me",
      "remediation": "Apply an allow-list of user-editable fields in the profile update and never accept role or identifier fields from the client."
    },
    {
      "id": "F3",
      "severity": "high",
      "title": "Callback address lets a team reach loopback services",
      "cwe": "CWE-918",
      "wstg": ["WSTG-INPV-19"],
      "taskRefs": ["T2", "T3"],
      "location": "server.mjs:44 deliver",
      "cvss": {
        "version": "4.0",
        "vector": "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N"
      },
      "severityFloor": {
        "class": "ssrf-internal",
        "evidence": "A listener started on 127.0.0.1 returned its nonce through the delivery preview of a registered callback."
      },
      "severityRationale": "Open team registration (PR:L); T2 accepts any address and T3 fetches it and returns 200 characters of the answer. Base score 6.3 is medium; the proven loopback reach lifts the gate severity to high through the ssrf-internal floor.",
      "attackPath": "Register a callback pointing at the local listener, publish an event, read the delivery preview.",
      "evidence": "GET /deliveries showed the listener nonce in the preview of the delivery.",
      "reproduction": "node --test .prumo-audit/ssrf.test.mjs (starts the listener, registers the callback, publishes and reads /deliveries)",
      "remediation": "Resolve the callback host and refuse loopback, link-local and private ranges before every delivery, and do not follow redirects to them."
    },
    {
      "id": "F4",
      "severity": "low",
      "title": "Stack trace returned on malformed JSON",
      "cwe": "CWE-209",
      "wstg": ["WSTG-ERRH-02"],
      "taskRefs": [],
      "severityRationale": "Reveals file paths and the runtime version only; no secret or personal data in the trace.",
      "attackPath": "Send a request body that is not valid JSON to any POST route.",
      "evidence": "Response 500 contained the server file path and line numbers.",
      "reproduction": "curl -X POST -d '{' http://localhost:3000/invoices",
      "remediation": "Return a generic 400 for parse errors and log the detail server-side."
    }
  ]
}
```

Top-level fields: `summary` (required: scope, ASVS level, counts, re-audit outcome, hypotheses refuted, cleanup),
`environment` (required, equals the host given to `audit-start`), `tools` (optional, nonempty strings, every tool
you ran), `revalidates` (see [Re-audit](#re-audit)).

Finding fields:

- `id`: unique, `F` followed by a number; never a task-like id such as `T3`.
- `severity`: `critical|high|medium|low|info`. It matches the band of the final score, unless a valid `severityFloor` lifts it to `high`.
- `title`, `attackPath`, `evidence`, `reproduction`, `remediation`: required, nonempty, structured so a fix task can be created from them.
- `cwe`: the most specific weakness, such as `CWE-639`. Boundary between two common ones: a price or other business parameter the server trusts from the client is `CWE-602` (client-side enforcement of server-side security); assigning client-supplied values to object fields in bulk (role, owner) is `CWE-915`.
- `taskRefs`: existing tasks; empty for a finding that belongs to no single task.
- `location` (optional): `file:line`, route or both, at most 300 characters.
- `wstg` (optional, recommended): unique ids like `WSTG-ATHZ-04`; the engine checks the format only.
- `cvss`: required for `medium` and above. `version` (`"4.0"`) and `vector` (base metrics `AV AC AT PR UI VC VI VA SC SI SA` in that order, then optional metrics in the official order); optionally `score` (0.0 to 10.0, one decimal; refused when it differs from the engine's calculation), `scoreSource` (accepted, ignored) and `environmental: { vector, score? }`. The environmental vector keeps the base metrics of `vector`. The engine adds `computedScore`.
- `severityRationale`: one to three sentences, at most 1,000 characters. Required with `cvss.environmental`, and it must cite at least one of the finding's `taskRefs` as the card evidence.
- `severityFloor` (optional): `{ class, evidence }` with a class from the floor table and a nonempty `evidence`; it requires `cvss`.
- `chainedWith` (optional): ids of other findings in this report whose proof the chained score relies on; requires `cvss`.

No secrets, tokens or personal data anywhere in the report. Use placeholders such as `<fixture-token>`.

## Lifecycle

1. Closing all delivery tasks completes the demand. Explain the optional audit and prepare
   `audit-propose --environment <local URL> --out <contract.json>`. This writes only the proposal file,
   never task state. Review and present its full business context, every source contract, scenarios,
   local environment and safety policy. Tailor scenarios to the approved demand without inventing rules.
2. After the user accepts that contract, start with `audit-start --contract <contract.json> --agent
   <auditor> --environment <accepted local URL> --confirmed-by-user`. The graph must be closed, the auditor
   independent, a slot free and the run unpaused. The contract is persisted and included in `brief --role
   security`. No task card or task filter is created. Mark activity with `activity-start security-audit
   --scope run --role security --agent <name>` and close it with `activity-stop` using the same flags.
3. `audit-finish --report <report.json>` validates and records the report and digest. Findings retain their
   scores and critical/high classification, but the delivery remains DONE. Do not create correction tasks
   while the auditor is still working. Open **Audit overview** for evidence and recorded findings.
4. Present the finished findings in the main chat and ask whether to create corrections in the same graph.
   `audit-fix-plan --out <fixes.json>` proposes one task per unaccepted finding, including medium/low/info,
   with source scope and regression criteria. It does not change state. Keep only corrections the user
   chooses, show their contracts and apply `sync-plan --plan <fixes.json> --propose --complete-audit
   <attempt number> --confirmed-by-user`. The attempt number binds the decision to the finished report.
   New task creation and the correction decision are recorded together. Only this new work reactivates
   the demand; tasks use the existing filters and normal planning, execution, authorization and independent
   review controls. Record the approval already given through the usual commands without asking twice.
5. If the user declines corrections, keep the report. `audit-skip --reason <text> --confirmed-by-user`
   records the decision without adding tasks or implicitly accepting risks. Explicit risk acceptance still
   uses `audit-accept <finding> --reason <text> --confirmed-by-user` for critical/high findings.
6. `audit-status`, `graph` and `brief --role security` expose the persisted audit evidence. Once all chosen
   corrections finish, delivery is DONE again. Another audit remains optional.

### Historical compatibility

Existing audits without the advisory flag retain their recorded behavior: critical/high findings gate
closure until explicit acceptance or a successful re-audit. Their fix-plan contains only blocking findings
and uses `sync-plan --propose`. Reopened work derives `pending-recheck`; re-audits must revalidate previous
unaccepted blocking findings. Never rewrite historical reports or silently remove their existing gates.
New audit offers and accepted independent contracts use the delivery-independent flow above.
