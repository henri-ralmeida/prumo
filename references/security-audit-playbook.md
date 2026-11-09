# Security audit playbook

The test roadmap for the vulnerability analysis and exploitation phases of the [security audit](security-audit.md).
The rules of engagement, the severity rules and the report schema live there; nothing here relaxes them. Run only
the categories the reconnaissance found; do not pad.

## Contents

- [Test plan by category (OWASP WSTG)](#test-plan-by-category-owasp-wstg)
- [OWASP API Security Top 10](#owasp-api-security-top-10-2023)
- [OWASP Top 10 and CWE as priority order](#owasp-top-10-and-cwe-as-priority-order)
- [Specialist lenses](#specialist-lenses)

## Test plan by category (OWASP WSTG)

Identifiers follow OWASP WSTG v4.2. Items marked *(latest)* exist only in the WSTG development edition; cite them
only if you are sure of the identifier, otherwise cite the nearest v4.2 test. Put the identifiers you used in each
finding's `wstg` (format `WSTG-XXXX-NN`).

| Category | Highest-value tests | Objective | Local proof |
| --- | --- | --- | --- |
| Information gathering `WSTG-INFO` | 06 entry points, 07 execution paths, 10 application architecture | Complete route and sink inventory | Route list from code matched against live responses |
| Configuration `WSTG-CONF` | 02 platform configuration, 04 backup and unreferenced files, 05 admin interfaces, 06 HTTP methods, 07 HSTS (when TLS is in scope) | Debug modes, default keys, exposed admin or debug routes, unexpected methods | Request to the route or method and its response |
| Identity `WSTG-IDNT` | 01 role definitions, 02 registration, 04 account enumeration | Can a user choose their role? Can accounts be enumerated? | Registration or profile request that sets a role; differing responses for existing and new accounts |
| Authentication `WSTG-ATHN` | 02 default credentials, 03 lockout, 04 bypassing the schema, 07 password policy, 09 password reset | Forged or skipped authentication, brute force without limits | Forged token accepted; 50 failed attempts without throttling (within the limit) |
| Authorization `WSTG-ATHZ` | 01 directory traversal and file include, 02 bypassing authorization, 03 privilege escalation, 04 IDOR | Object-, property- and function-level access control | Second fixture account reads or changes the first one's object; canary read through traversal |
| Session `WSTG-SESS` | 01 session schema, 02 cookie attributes, 03 fixation, 05 CSRF, 06 logout, 07 timeout; 10 JWT *(latest)* | Token integrity, expiry, revocation, CSRF on cookie sessions | Expired or logged-out token still accepted; `alg` or signature tampering accepted |
| Input validation `WSTG-INPV` | 01 and 02 XSS, 05 SQL injection, 11 code injection, 12 command injection, 17 host header, 18 SSTI, 19 SSRF; 20 mass assignment *(latest)* | Untrusted input reaching a sink | Boolean or UNION difference on fixture data; nonce file in the sandbox; nonce returned by your local listener |
| Error handling `WSTG-ERRH` | 01 improper error handling, 02 stack traces | Internals or secrets in errors | Malformed request and the leaked stack or path |
| Cryptography `WSTG-CRYP` | 03 sensitive data over unencrypted channels, 04 weak encryption | Weak hashing, predictable tokens, non-constant-time comparison, home-made crypto | Code location plus a test that shows predictability or the weak primitive |
| Business logic `WSTG-BUSL` | 01 data validation, 02 forged requests, 04 process timing, 05 function use limits, 06 workflow circumvention, 09 malicious file upload | Price, quantity, limit and workflow abuse, races | Order at a tampered price; single-use resource used more than once within the race limits |
| Client side `WSTG-CLNT` | 01 DOM XSS, 04 client-side redirect, 07 CORS, 09 clickjacking, 12 browser storage | Script execution and cross-origin trust | Inert marker executes; permissive CORS response to a foreign `Origin` header |
| API `WSTG-APIT` | 01 GraphQL (v4.2); for REST use the API Top 10 below | Introspection, batching, depth limits | Introspection query response; batched or deep query accepted |

## OWASP API Security Top 10 (2023)

Use it for every HTTP API, mapped to the WSTG tests above.

| ID | Risk | Where to test |
| --- | --- | --- |
| API1 | Broken Object Level Authorization | WSTG-ATHZ-04 with two fixture accounts |
| API2 | Broken Authentication | WSTG-ATHN, WSTG-SESS |
| API3 | Broken Object Property Level Authorization | mass assignment, over-exposed response fields |
| API4 | Unrestricted Resource Consumption | missing size, page and rate limits (within the DoS limits) |
| API5 | Broken Function Level Authorization | WSTG-ATHZ-02/03: admin routes with a customer token |
| API6 | Unrestricted Access to Sensitive Business Flows | WSTG-BUSL: coupons, checkout, sign-up automation |
| API7 | Server Side Request Forgery | WSTG-INPV-19 against a local listener |
| API8 | Security Misconfiguration | WSTG-CONF, CORS, verbose errors |
| API9 | Improper Inventory Management | undocumented, debug or old-version routes |
| API10 | Unsafe Consumption of APIs | trust in data returned by integrations and callbacks |

## OWASP Top 10 and CWE as priority order

Map a finding to its OWASP Top 10 category in `summary` only when it helps the reader. The 2021 edition: A01 Broken
Access Control, A02 Cryptographic Failures, A03 Injection, A04 Insecure Design, A05 Security Misconfiguration, A06
Vulnerable and Outdated Components, A07 Identification and Authentication Failures, A08 Software and Data Integrity
Failures, A09 Security Logging and Monitoring Failures, A10 Server-Side Request Forgery. If the project already
references the 2025 edition, use its categories instead.

Pick the most specific CWE that the proof demonstrates (`CWE-639` for an IDOR rather than `CWE-284`). When time is
short, hunt in the order of the CWE Top 25 (2024 edition), filtered by the reconnaissance: CWE-79 XSS, CWE-89 SQL
injection, CWE-352 CSRF, CWE-22 path traversal, CWE-78 OS command injection, CWE-862 missing authorization, CWE-434
unrestricted upload, CWE-94 code injection, CWE-20 improper input validation, CWE-77 command injection, CWE-287
improper authentication, CWE-269 improper privilege management, CWE-502 unsafe deserialization, CWE-200 information
exposure, CWE-863 incorrect authorization, CWE-918 SSRF, CWE-798 hard-coded credentials, CWE-400 uncontrolled
resource consumption, CWE-306 missing authentication for a critical function. Memory-safety entries (CWE-787,
CWE-125, CWE-416, CWE-119, CWE-476, CWE-190) apply only to native code.

## Specialist lenses

Activate a lens only when a card touches its subject. Each lens is run with the project's own files and tools;
never add an external scanner.

**Cloud and infrastructure as code** (Terraform, CloudFormation, Bicep, Helm, Kubernetes manifests)

- Secrets in variables, defaults, state files or outputs; wildcard IAM actions or resources; public buckets or storage; security groups open to `0.0.0.0/0` on admin ports; encryption disabled; logging disabled.
- SSRF that could reach a metadata service: prove the SSRF against your local listener only and state the metadata reach in `severityRationale` when the contract's deployment is a cloud host. Never send a request to `169.254.169.254`.
- Proof: file and line of the configuration and the effective permission it grants. Validate with the project's own `terraform validate` or `plan` against local state only when it needs no cloud credentials.

**Containers and Kubernetes**

- Containers running as root, `privileged`, host mounts, `hostNetwork`, added capabilities, no resource limits, `latest` image tags, secrets in image layers or environment, service accounts with cluster-wide rights, missing network policies.
- Proof: manifest location and the concrete escalation it allows. No `kubectl` against a cluster.

**CI/CD and supply chain**

- Secrets printed or echoed in pipelines; untrusted pull-request code running with secrets (`pull_request_target` with a checkout of the head); third-party actions not pinned to a full commit SHA; script injection through `${{ github.event.* }}` in `run:` steps; overly broad `permissions`.
- Dependencies: missing or ignored lockfile, install scripts, unscoped internal package names exposed to dependency confusion, known vulnerable versions found by the project's own audit command (`npm audit`, `pip-audit`, `dotnet list package --vulnerable`) when it already exists.
- Proof: workflow or manifest location and the attacker-controlled input that reaches the secret or the runner. Do not trigger pipelines.

**OAuth 2.0, OIDC, SAML and JWT**

- JWT: `alg: none`, algorithm confusion (RS256 key used as HS256 secret), missing `exp`, `aud` or `iss` checks, weak HMAC secret, `kid` path or SQL injection, signature compared in non-constant time.
- OAuth/OIDC: `redirect_uri` not matched exactly, missing or unchecked `state`, missing PKCE for public clients, `nonce` not checked, tokens in URLs or logs, implicit flow, refresh tokens without rotation.
- SAML: unsigned assertions accepted, signature wrapping, audience and recipient not checked, replay.
- Proof: a forged or modified token or assertion built with fixture keys that the local target accepts. A forged identity is the `auth-bypass` floor class.

**AI and LLM features** (OWASP Top 10 for LLM Applications 2025)

Run these probes yourself against the local target, with crafted inputs; no external tool or model service:

- LLM01 prompt injection, direct and indirect (instructions planted in documents, web pages, tool output or stored records the model later reads);
- LLM02 sensitive information disclosure; LLM07 system prompt leakage;
- LLM05 improper output handling (model output reaching HTML, SQL, shell, file paths or URLs);
- LLM06 excessive agency (tools with more permission than the task needs, actions without confirmation);
- LLM10 unbounded consumption (within the DoS limits); LLM08 vector and embedding weaknesses (cross-tenant retrieval);
- LLM03 supply chain, LLM04 data and model poisoning, LLM09 misinformation: review only, from the code and configuration.
- Proof: the exact input, the model's output and the effect it caused (a canary written, a foreign record retrieved, a tool called). Record the model and settings the target uses in `summary`.
