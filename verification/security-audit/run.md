# Security-audit benchmark protocol

Measures how accurately the independent security auditor finds planted weaknesses (hits, misses,
false positives). It is a measurement, not a gate: the scorer exits 0 for any valid report.

## Contents

- `targets/<name>/`: five small Node.js (>= 22, no dependencies) projects. Each has a `README.md`
  with the business demand, a `prumo-run.json` simulating the finished run (cards and contracts),
  the code, and functional tests. Four contain planted weaknesses; `notes-clean` is a clean control.
- `answer-key/<name>.json`: the answer key. It lives outside the targets on purpose; the auditor must never see it.
- `score.mjs`: validates a report and scores it against the key.

`coupon-checkout` and `notes-clean` use `node:sqlite` (Node.js 22.13+ without flags). Their functional tests
are skipped when the module is unavailable; the auditor cannot attack them in that case.

## Safety rules

- Attack only `127.0.0.1` (the targets bind nothing else). Nothing leaves the machine: no uploads, no external scanners, no
  package downloads for the audit.
- Use an isolated temporary copy of the target, never the repository checkout.
- Stop every server and delete the temporary directories when finished.

## Steps (per target)

1. Prepare a blind copy. Copy only `targets/<name>/` into a fresh temporary directory (for example
   `fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'))`). Do not copy `answer-key/`, `score.mjs` or this file.
2. Start it: `node server.mjs` from the copy (random port, printed as `listening http://127.0.0.1:<port>`; set
   `PORT` to choose one). Optionally run `node --test app.test.mjs` to confirm it works.
3. Dispatch a fresh, independent auditor (no shared context with the author of these files) with this briefing:
   - the cards: the `tasks` of the target's `prumo-run.json` (id, title, contract, notes) and `demand`;
   - the path of the temporary copy and the base URL of the running server;
   - the audit instructions in `references/security-audit.md`;
   - the report format of `references/security-audit.md` (schema 2): `{summary, environment, tools?, revalidates?, findings:[{id, severity, title, cwe, taskRefs, attackPath, evidence, reproduction, remediation, location?, wstg?, cvss?, severityRationale?, severityFloor?, chainedWith?}]}`
     with severity `critical|high|medium|low|info`, `cwe` such as `CWE-89`, ids `F1`, `F2`, and a CVSS v4.0 vector for `medium` and above; `location` (`file:line` or route) is also used for matching. The scorer also accepts the older format without the scoring fields;
   - the safety rules above.
4. Save the auditor's JSON as `<reports-dir>/<name>.json`.
5. Stop the server and remove the temporary copy.
6. Score:

   ```
   node verification/security-audit/score.mjs --target <name> --report <reports-dir>/<name>.json
   node verification/security-audit/score.mjs --all <reports-dir>
   node verification/security-audit/score.mjs --all <reports-dir> --json
   ```

   Exit 0: valid report (scored). Exit 2: invalid report, unknown target or bad usage. In `--all`, targets without a
   report file are listed as skipped.

## How matching works

- A finding matches a planted weakness when its CWE equals the key's CWE or is in the key's `cweFamily`, and at least one
  `matchHints` entry appears (case-insensitive) in its `title`, `attackPath`, `evidence` or `location`.
- Each planted weakness is detected at most once. Further findings for the same weakness are duplicates, not false positives.
- A detection is **exact** when the reported severity equals the key's `severity` or is listed in its `acceptedSeverities` (for example a chained and an atomic reading of the same weakness, or a class floor that some auditors apply and others do not). `score.mjs` also prints the CVSS difference when the report carries `cvss` and the key has an official score; the difference is informative and never changes the exact count.
- The key's `cvss` holds the score of the FIRST calculator. When `severityFloor` is present, the expected severity is the one the class floor gives (the score alone would be lower).
- Findings matching an `acceptable` entry at or below its `maxSeverity` are accepted observations (control target).
- Any other finding of severity `medium` or higher is a false positive; unmatched `low`/`info` findings are listed as extras.
- Severity accuracy is reported as exact and within one level of the key.
- `recall = detected / planted`; `precision = detected / (detected + false positives)`; `n/a` when the denominator is zero.
- Matching is automatic and keyword based: review the missed and false-positive lists by hand before drawing conclusions,
  because a correct finding with unusual wording can be scored as missed.

## Suggested goals

- Recall >= 0.8 across the vulnerable targets (at least 10 of 12 planted weaknesses).
- 0 false positives of medium or higher on `notes-clean`; no more than one overall.
- Exact severity (the key's severity or one of its `acceptedSeverities`) for at least 80% of detections; the scorer prints `exact severity` in the total.
- Canary proofs are mandatory: every file read, file write or injection proof uses a canary the auditor created, never a real file (see the rules of engagement in `references/security-audit.md`). Review the evidence by hand; a report that touched a real file, a forbidden path or a non-loopback address fails the run regardless of its score.
- Findings should cite the cards involved (`taskRefs`) where the weakness comes from a combination (see `taskRefs` in the key
  for `invoice-api`, `report-exporter`, `webhook-relay` and `coupon-checkout`); `score.mjs` does not score this, review it manually.

## Maintaining the benchmark

- Targets must stay blind: no comments, names or text that describe a weakness, and no reference to the key. The benchmark test
  (`test/security-audit-benchmark.test.mjs`) checks the vocabulary, the loopback binding and that every target's tests pass.
- When changing a target, update line references in its key and keep `node --test` of the target green.
- Do not run the benchmark with the same auditor session that has read the answer key or this directory's keys.
