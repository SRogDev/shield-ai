# Shield AI — Product & Engineering Plan v2 (Compiled Specification)

> **Status:** Source of truth for the build. Compiled 2026-10-23 from the original
> 19-section plan plus three rounds of decisions with Roger (2026-10-23).
> Where v1 and this document disagree, this document wins. Decisions that came
> from Roger are marked **[Roger]**; defaults chosen by the builder where Roger
> delegated ("encárgate tú") are marked **[Default]** and are recalibratable.
>
> **Build constraints in force:** greenfield repo; local-only development
> (Roger's GitHub account is suspended — zero GitHub calls of any kind);
> no live API keys exist yet (Supabase, Polar, AI Gateway), so every external
> integration is implemented against its real SDK/contract and must fail
> honestly with a clear "not configured" error when its env is absent.

---

## 1. Mission and product philosophy

Shield AI is a security analysis product for indie developers building
AI-powered micro-SaaS applications. It helps small AI product builders
discover, understand, prioritize, and fix security weaknesses in **their own**
applications without a dedicated security team.

Shield is a security analysis and remediation-planning product. It is **not**
a general-purpose coding agent, a hosting platform, or a runtime security
gateway.

### Philosophy (confirmed with Roger, 2026-10-23)

1. **The user's real project, not generic checklists.** Every finding is
   grounded in evidence in the user's actual code, with affected file, impact,
   and a correction plan. A finding without evidence is never presented as a
   confirmed vulnerability.
2. **Each tool does its own job.** Deterministic tools do deterministic work
   (secrets, dependencies, known patterns); AI does contextual reasoning,
   correlation, explanation, and remediation planning.
3. **The backend is the authority.** Authorization, entitlement, and billing
   decisions are enforced server-side on every path. Nothing depends on the
   CLI or an external agent behaving correctly.
4. **Code is an input, never an asset.** Source is processed transiently and
   never persisted (see §10). Shield stores findings, tasks, and minimal
   metadata — never the user's repository.
5. **Find → fix plan → verify.** Each finding carries an actionable correction
   plan (executable by a coding agent through MCP) and is re-checked on the
   next scan. Shield **never modifies the user's code autonomously**.
6. **Honesty over comfort.** A scan never proves an application secure.
   Severity reflects real impact and exploitability. Failed or partial scans
   never appear as successful.
7. **Indie economics throughout.** Small architecture one founder can
   operate, pricing an indie can pay, no speculative enterprise machinery.
   MVP first; everything else must earn its place.
8. **Tranquility is the brand.** Security should reduce the builder's mental
   load, not add fear. Tagline: **"Security that lets you build."**

### Out of scope for the MVP

- Runtime protection / inline interception of live LLM requests.
- Hosting or deploying customer applications.
- Infrastructure outside the code/configuration under analysis.
- Automatically modifying customer repositories.
- Replacing a penetration test or a full security audit.
- Teams, roles, organizations (single-user MVP) **[Roger]**.
- The GitHub App integration — **documented only** in this version, built as
  the final phase after Roger's GitHub account is restored (see §14).

---

## 2. Repository shape — greenfield monorepo **[Roger]**

pnpm workspaces, one repository, linear git history, one branch per build
phase (branches become PRs when GitHub access is restored).

```
shield-ai/
  apps/web/          Next.js commercial web app: landing, dashboard, API
                     routes, analysis orchestration entry points, remote MCP.
  packages/shared/   The TypeScript contract source of truth:
                     Zod schemas (API inputs/outputs, AI structured output,
                     env, MCP tool schemas, webhook payloads), plan/cost
                     tables, Shield ledger logic, finding fingerprinting,
                     deterministic checks, the 8-stage workflow engine.
  cli/               Rust binary crate ("shield"). Mirrors the shared Zod
                     contracts by hand (documented mirror, see §8.6).
  supabase/          SQL migrations: schema + RLS policies.
  eval/              Seeded vulnerable sample repositories + eval harness.
  docs/              This plan, PROJECT_BRIEF, GITHUB_APP spec, SETUP.
```

- **Zod everywhere** **[Roger]**: API request/response validation, structured
  AI output validation, environment variables, MCP tool input/output schemas,
  and Polar webhook payloads are all Zod schemas living in `packages/shared`.
  No endpoint accepts unvalidated input.
- **Formatting/linting:** Biome (never ESLint/Prettier). TypeScript `strict`.
  Rust: `cargo fmt` + Clippy clean.
- **Next.js:** current release at build time (16.4.3, verified via
  `npm view next version`).

---

## 3. Target user and business model

Target user: an indie founder or solo builder shipping an AI-powered
micro-SaaS (LLM APIs, tools, agents, retrieval, third-party integrations),
who may rely heavily on AI coding agents and has limited application-security
expertise.

### Pricing — Polar, Shields **[Roger]**

Billing provider: **Polar** (merchant of record). Nothing billable runs until
the backend confirms entitlement. Pricing and entitlements live in one
config table in `packages/shared` — never hardcoded across the app.

The consumption unit is the **Shield**: a unit of security work, never
exposed to the user as tokens. Action costs are proportional to real
relative cost, are computed from the snapshot **before** execution, and are
shown to the user before confirmation (CLI preview and web UI).

Internal budget: **1 Shield = at most ~$0.05 real COGS**, enforced by
per-action token/cost budgets in the workflow **[Default]**.

| Plan       | Price      | Shields                        | Projects | Notes            |
| ---------- | ---------- | ------------------------------ | -------- | ---------------- |
| Free trial | $0         | **15, one-time** (not monthly) | 1        | No card required |
| Indie      | **$9/mo**  | **40 / month**                 | 1        | Single-project   |
| Builder    | **$19/mo** | **100 / month**                | Multiple | Multi-project    |
- Subscription Shields **expire at month end** (no rollover).
- **Shield packs** (pay-as-you-go): **30 Shields / $10**, **100 Shields / $29**.
  Pack Shields **never expire**. **No auto-recharge, ever**, without the
  user's explicit authorization for that purchase.
- When the balance reaches zero, billable work is blocked; the user sees
  balance and consumption history in the dashboard and may wait for renewal,
  buy a pack, or upgrade.

### Action costs (Shields) **[Default, decided 2026-10-23]**

| Action                   | Cost | Definition                                        |
| ------------------------ | ---- | ------------------------------------------------- |
| Quick deterministic scan | 1    | Deterministic checks only, no AI stages           |
| Verify one finding       | 1    | Targeted re-check of a single finding             |
| Incremental rescan       | 3    | Changed files only (by SHA-256 diff vs last scan) |
| Full scan — standard     | 5    | ≤ 100 files and ≤ 500 KB of selected text         |
| Full scan — large        | 12   | ≤ 300 files and ≤ 2 MB of selected text           |

Snapshots above the large tier are rejected with a clear error in the MVP
(no silent truncation).

### Unit economics (planning hypotheses, to be recalibrated in Phase 7)

Planning COGS per full standard scan ≈ $0.30 all-in (tokens ~$0.25,
Vercel Sandbox ~$0.01–0.02, Workflow/compute ~$0.01), assuming cheap
AI Gateway models for bulk stages. At Polar Starter fees (5% + 50¢):
Indie nets $8.05 → ~$6.05 kept per user/month at 100% Shield burn;
Builder nets $17.55 → ~$12.55 kept. These are hypotheses, not measurements;
Phase 7 measures pipeline costs with the stub provider (labeled as pipeline
mechanics) and real-model benchmarking happens only when Roger provides an
AI Gateway key.

---

## 4. Security scope

In scope (where relevant to the analyzed project): authentication and
authorization mistakes; missing ownership checks / IDOR; tenant isolation
and cross-user data exposure; unsafe API routes; secret handling and
credential exposure; prompt injection and unsafe handling of untrusted model
input; insecure tool execution and excessive agent permissions; unsafe use
of model-generated output; data leakage through logs, responses, prompts,
and integrations; weak validation at trust boundaries; unsafe file, URL,
and external-resource handling; conventional application vulnerabilities.

Taxonomy **[Roger]**: findings map to **OWASP LLM Top 10** and **OWASP
Top 10 (web)**, and carry a **CWE** identifier.

Findings must be grounded in the actual repository and evidence. Shield
analyzes code and configuration it can inspect and must never claim a scan
proves an application secure.

---

## 5. Architecture

- **Web app + backend:** Next.js on Vercel. Next is the control plane for
  authorization, quotas, analysis orchestration, findings, project history,
  and results. The analysis workflow never moves into the CLI.
- **Database:** Supabase Postgres (canonical data) with **RLS** and
  server-side authorization as defense in depth. Supabase Auth is the web
  identity system.
- **Client state:** Zustand where appropriate; canonical business state
  always lives on the backend.
- **Models:** Vercel AI SDK calling models **through Vercel AI Gateway**
  **[Roger]**. Model selection is a **config table** (§6.3), not code.
- **Execution:** the analysis runs as **one Vercel Workflow** (Workflow
  DevKit, `"use workflow"` / `"use step"`) — see §6.
- **Deterministic tools in a sandbox:** a **Vercel Sandbox** step provides a
  real Linux environment for semgrep/gitleaks-class tooling behind a clean
  tool interface (§6.4) **[Roger]**.
- **Integrations:** (1) Shield CLI (built in this version), (2) remote MCP
  server (built in this version, core — not optional), (3) GitHub App
  (documented only, §14). Composio is not used.

### Data model (Supabase Postgres)

- `profiles` — user id (Supabase Auth), plan, created_at.
- `projects` — id, owner, name, created_at.
- `repo_links` — project ↔ repository identity (repo name + git remote URL
  hash) for CLI project resolution (§8.5).
- `device_codes` — CLI device authorization sessions (§7.2).
- `cli_tokens` — backend-issued CLI/MCP tokens, **stored hashed**, scoped,
  revocable.
- `scans` — id, project, status (`pending|uploading|analyzing|completed|
  failed`), action type, Shield cost, snapshot manifest metadata (paths,
  sizes, hashes — **never file contents**), timestamps, error.
- `scan_files` — per-file upload acknowledgment (scan, path, sha256, size).
- `findings` — see §9.
- `remediation_tasks` — per-finding correction tasks with status.
- `shield_ledger` — append-only entitlement ledger: grants (subscription,
  pack, trial), debits (per action), each row idempotent via a unique
  idempotency key; balance is derived, never a mutable counter that retries
  can double-spend.
- `polar_events` — processed Polar webhook event ids (deduplication).

All user-owned tables enforce RLS by owner. The backend service role is
used only in server code paths that first establish identity and ownership.

---

## 6. The analysis workflow

One AI agent inside a controlled, eight-stage **Vercel Workflow**. No
multiple autonomous agents. The workflow function orchestrates; each stage
is a `"use step"` function with explicit input, output, and failure
behavior. Steps retry on transient failure; a failed stage fails the scan
honestly (never a "completed" scan).

| #   | Stage                  | Kind                    | Output                                                                       |
| --- | ---------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| 1   | Understand the project | AI (cheap)              | Architecture, languages, frameworks, trust boundaries, AI features           |
| 2   | Gather evidence        | Deterministic + Sandbox | Selected source/config, deterministic check results, tool output             |
| 3   | Identify risks         | AI (cheap)              | Candidate findings from concrete evidence                                    |
| 4   | Evaluate findings      | AI (strong)             | Validity, severity, confidence, false-positive filtering                     |
| 5   | Explain findings       | AI (cheap)              | Problem, evidence, affected component, realistic consequences                |
| 6   | Create correction plan | AI (cheap)              | Specific remediation tasks per finding                                       |
| 7   | Verify corrections     | Mixed                   | For rescans: match findings by fingerprint (§9.2), mark resolved/open        |
| 8   | Record results         | Deterministic           | Persist findings, tasks, verification status, minimal metadata; debit ledger |

Rules:
- Structured model output is **validated with Zod before it is trusted**.
  Malformed output fails the step, not the data model.
- **Budgets are hard:** per-stage token caps derived from the action's
  Shield budget (1 Shield ≈ $0.05 max COGS). Budget exhaustion fails the
  scan with a clear reason; it never silently truncates findings.
- Provider errors, timeouts, and interruptions produce explicit scan
  states. Sufficient execution state is persisted to explain what happened.
- Automatic remediation is **not** in the MVP: the workflow creates plans
  and tasks; it never modifies customer files.

### 6.1 Where the code lives during analysis

File contents travel **as workflow input and step data** (repos here are
small — KBs to low MBs). Contents are never written to Supabase, Supabase
Storage, or any application database. See the honest privacy wording in §10.

### 6.2 Deterministic checks (in-step, TypeScript)

Implemented in `packages/shared`, running inside workflow steps:
- Secret patterns + entropy heuristics over text content.
- Lockfile parsing → dependency inventory → OSV-shaped vulnerability
  lookup contract (the lookup client is implemented against the OSV API
  contract; tests use a stub — no live calls in the build environment).
- Insecure configuration patterns (e.g. permissive CORS, debug flags,
  missing security headers in framework config).
- AST-level patterns for TS/JS (e.g. route handlers without an auth
  check, direct use of request input in queries) using a real parser.

### 6.3 Model selection (config table, benchmarked later) **[Roger]**

Models are chosen per stage from a config table in `packages/shared`:
relatively economical AI Gateway models that are especially strong at
cybersecurity for the bulk stages (1, 3, 5, 6) and one stronger model for
the evaluation stage (4). **No model is claimed "best" in this plan:** the
Phase 7 eval phase benchmarks cheap candidates on security accuracy and
cost on the seeded eval set, and the table is filled from that evidence.
Until an AI Gateway key exists, all tests run against a deterministic
**stub provider** that implements the same interface and is labeled as a
stub everywhere it appears.

### 6.4 Vercel Sandbox step

Stage 2 may run inside a **Vercel Sandbox** (ephemeral Linux microVM)
behind a `DeterministicToolRunner` interface with two implementations:
in-process TS checks (above) and sandbox tools (semgrep/gitleaks-class
binaries). Sandbox sessions are capped at **~3 minutes**. The sandbox step
is standard in the pipeline; its measured cost (~$0.005–0.02 per run at
published Vercel rates) is a small fraction of scan COGS and is not a
margin risk. Without Vercel credentials the sandbox runner fails with a
clear "not configured" error and the workflow records that the TS checks
ran and sandbox tools were unavailable — it never fabricates tool output.

---

## 7. Authentication and authorization

### 7.1 Web

Supabase Auth. All dashboard and API access requires a session; RLS plus
server-side checks enforce ownership on every query.

### 7.2 CLI device flow (built on Supabase) **[Roger]**

Supabase Auth has no native device grant, so the device protocol is built
on top of it — Supabase provides identity and storage; the backend runs
the protocol:
1. `shield login` asks the backend to create a device session
   (`device_codes` row: device code (hashed), user code, expiry, poll
   interval).
2. The terminal shows the verification URL + user code.
3. The user opens the URL, signs in with Supabase Auth, and approves the
   code on the web approval page.
4. The CLI polls the backend at the specified interval until approval,
   denial, or expiry.
5. On approval the backend issues **its own scoped, revocable CLI token**
   (not a Supabase JWT): a random token whose hash is stored in
   `cli_tokens` with user, scope, and timestamps. The CLI stores the raw
   token in the OS credential store where available (documented fallback:
   a user-only file under the OS config dir, with a printed warning).
6. `shield logout` deletes the locally stored token and asks the backend
   to revoke it.

Possessing a CLI token is never proof of entitlement: the backend checks
identity, project access, plan, and Shield balance on **every**
analysis-starting request.

### 7.3 Authorization invariant

For **every** analysis-starting path (CLI, web, MCP-adjacent actions,
future GitHub events): authenticated user, project ownership, valid
project↔repo association, plan permits the operation, sufficient Shield
balance, and the operation has not already been created for the same
logical request (idempotency key). Duplicate charges and duplicate jobs
are prevented by the ledger's unique idempotency keys.

---

## 8. Shield CLI (Rust)

A thin local adapter. It is **not** an AI agent and contains **no** analysis
workflow. Exactly three top-level commands **[from v1, kept]**:
- `shield login`
- `shield scan [path]` (defaults to the current directory)
- `shield logout`

Plus `--help` on the binary and every subcommand, and `shield scan --auto`.
No additional product commands without an explicit requirement.

Rust organization: one Cargo binary crate, `main.rs` + modules by
responsibility (`cli`, `auth`, `files`, `api`). `clap` for parsing.
Clippy clean, `cargo fmt` applied.

### 8.1 File discovery — two filtering stages

1. **Repository/git rules:** discover the repo root; respect `.gitignore`
   and applicable ignore rules; never traverse outside the requested scope;
   exclude dependency and generated-content directories.
2. **Content filtering:** select code and relevant textual project files.
   No closed extension allowlist — text vs binary is decided by **content
   inspection** (null-byte/encoding heuristics), so media, PDFs, Office
   documents, 3D assets, and other binary files are excluded even with
   misleading extensions.

**Hard rule [Roger]: `.env*` files are ALWAYS excluded**, even when not
covered by `.gitignore`. (This overrides v1's "the user's `.gitignore` is
their responsibility" position.)

### 8.2 Scan preview and confirmation

Before upload the CLI shows: repository/directory, selected file count,
estimated total size, exclusion summary, the **Shield cost of the action**
(computed from the snapshot tiers in §3), and a notice that selected source
will be transmitted to Shield and processed by external AI models. Normal
mode requires explicit confirmation. `--auto` skips **only** the
confirmation — never authentication, authorization, size limits, or checks.

### 8.3 Snapshot semantics

A scan is the exact file versions selected when the scan begins: contents
are read **once, into memory**; a **SHA-256** is computed per file; the
upload sends the captured bytes, never a re-read of the working tree. A
documented maximum total snapshot size applies (large tier cap, §3);
exceeding it is a clear error, never silent truncation. The snapshot is
released when the operation ends and is never written to disk by the CLI.

### 8.4 Resumable upload (file-level)

Each file is an independent upload unit identified by **repository-relative
path + SHA-256**. Retries resend only files the backend has not
acknowledged. The backend exposes an explicit completion step: analysis
starts **only after every required file is acknowledged**. Partial uploads
never become analyses. Cross-process resume is not required (a terminated
process loses its in-memory snapshot; a later invocation starts a new scan).

### 8.5 Project resolution **[Roger]**

- On the first scan of a repository, the CLI fetches the user's projects
  from the backend and asks the user which project this repo belongs to,
  or to create a new one. The choice is stored server-side as a repo link
  (identity: user + repo name + git remote URL when present); later scans
  of the same repo resolve automatically.
- **Single-project (Indie / trial) users are never asked:** every scan,
  from any repo, goes into their one project. If they scan two different
  repos into it, that is accepted — they manage that complexity themselves.
- `scan --auto` with an unresolved repo and a multi-project plan fails
  with a clear instruction to run once interactively (no silent guessing).

### 8.6 Contract mirror

The backend API contract is defined by the Zod schemas in
`packages/shared`. The CLI mirrors the same shapes in Rust types
(`cli/src/api.rs`), kept in sync by contract tests against recorded
request/response fixtures generated from the Zod schemas. Any contract
change must update both sides in the same phase.

### 8.7 CLI responsibilities vs backend

CLI: discovery/filtering, preview/confirmation, snapshot + hashes, device
flow, upload + retry, progress + final status.
Backend: authentication, project authorization, plan/quota enforcement,
upload-session validation, completion confirmation, workflow execution,
findings/tasks persistence, status reporting.

---

## 9. Findings and remediation data

Every finding contains, where applicable:
- Stable identifier and a **fingerprint** (§9.2).
- Clear title and concise description.
- **Severity** — exactly one of `Critical | High | Medium | Low | Info`
  **[Default]** — reflecting actual impact and exploitability, and a
  separate **confidence** (`High | Medium | Low`).
- Affected file and line range.
- Evidence supporting the claim (the minimal snippet necessary).
- Category: **CWE id** + **OWASP** mapping (LLM Top 10 and/or web Top 10).
- Potential impact and a practical correction plan (remediation tasks).
- Verification status: `open | fixed_verified | still_present |
  not_rechecked`, and references to the scans that produced/verified it.

### 9.2 Finding fingerprint **[decided 2026-10-23]**

Cross-scan identity is **not** the file hash and **not** line numbers (the
file hash changes precisely when a fix lands, and lines move). The
fingerprint is a hash of: category/CWE + repository-relative path +
route/function identity + a **normalized form of the vulnerable pattern**
(whitespace/comment-normalized code shape). Stage 7 matches new findings
to prior ones by fingerprint: a previously open fingerprint absent from a
rescan — with the surrounding code re-checked — becomes `fixed_verified`;
present again becomes `still_present`.

### 9.3 Severity scale

`Critical` (directly exploitable, severe impact: auth bypass, RCE, mass
data exposure) · `High` (exploitable with major impact: IDOR exposing
sensitive data, stored secrets) · `Medium` (real weakness needing
conditions or chaining) · `Low` (hardening gap, limited impact) · `Info`
(observation, no direct exploit path). Confidence is recorded separately
so a low-confidence High never masquerades as a confirmed High.

---

## 10. Data privacy and retention

- Uploaded source is **never** saved to Supabase Storage or any permanent
  source-code database. It is processed transiently (workflow input/step
  data, sandbox filesystem during the sandbox step) and discarded.
- Persisted: findings, remediation tasks, results, snapshot manifests
  (paths/sizes/hashes), and the minimum operational metadata.
- **Honest provider wording (required in product copy):** analysis runs on
  Vercel infrastructure; Vercel retains workflow run data for a period per
  its own retention policy, and code snippets are transmitted to the model
  providers behind Vercel AI Gateway under their terms. Shield itself does
  not persist source code. No copy may claim providers "never retain data"
  unless verified against the configured providers' actual terms.
- No source content or secrets in logs, error messages, or telemetry.
- Project and history deletion removes the project's retained records and
  metadata, subject only to explicitly documented legal/operational
  retention (billing records).

---

## 11. Billing integration (Polar)

- Polar is the merchant of record for subscriptions and Shield packs.
- Checkout is created server-side; entitlement changes arrive **only** via
  Polar webhooks. Webhook payloads are validated with Zod and signature
  verification per Polar's contract; event ids are stored in
  `polar_events` so duplicate deliveries never double-grant.
- Webhook → ledger: subscription activation/renewal grants the plan's
  monthly Shields (idempotent per billing period); pack purchases grant
  non-expiring Shields; cancellation stops future grants (existing pack
  balance remains).
- Without Polar env configuration, checkout/webhook endpoints return a
  clear "billing not configured" error. Nothing pretends a payment
  succeeded.

---

## 12. Remote MCP server **[Roger: remote, core]**

MCP is a core product integration, hosted on the web app as a **remote
MCP server (Streamable HTTP)**. Authentication uses the same scoped token
system as the CLI (§7.2) — an MCP client presents a user-scoped token;
every operation enforces project ownership and tenant isolation.

Read-only tool surface (names/schemas defined by Zod in `packages/shared`):
- `list_projects` — the user's projects.
- `list_findings` — findings for a project/scan, with severity/confidence.
- `get_finding` — one finding with evidence and correction plan.
- `list_remediation_tasks` — outstanding correction tasks.
- `get_verification_status` — verification state across scans.

No write tools. No unrestricted database access. MCP never starts a
billable analysis in the MVP. Automatic code correction through MCP is
deferred: MCP gives a coding agent the information to make a correction;
Shield itself does not edit code.

---

## 13. Web experience — design system

Recovered brand system (Roger, 2026-10-19/23) reconciled with the
ui-ux-pro-max design pass run at build time; **Roger's decisions win**
where they conflict with the tool's generic output (the tool suggested
indigo + Plus Jakarta Sans + motion-heavy style; the brand decisions
below override all three):
- **Color:** blue primary, family ratified around **#2563EB**; calm slate
  neutrals; severity colors are semantic (red/amber/…) and are not brand.
- **Typography:** **Inter** for identity, headings, UI, and content.
- **Tagline:** "Security that lets you build."
- **Landing:** simple, **no 3D**, transparent pricing, primary CTA
  direction "Secure your project."
- **Motion:** discreet, functional animations only; respect
  `prefers-reduced-motion`.
- **Dashboard:** one unified dashboard — projects, latest scans, findings
  by severity, outstanding remediation tasks, Shield balance and history,
  plan/usage. Findings, severity, and fixes must be understandable at a
  glance by a non-security-expert.
- **Explicitly avoided:** generic hacker aesthetics — no padlocks, no
  matrix green, no dark-terminal cosplay.
- **Logo:** an original, minimal SVG mark — a shield fused with an AI
  symbol (node/spark), futuristic, extreme minimalist strokes, legible at
  favicon size. Roger rejected stock-style icon sets; the mark is drawn
  for this product, not copied.
- Information is presented clearly for humans and **structured for coding
  agents** (the same finding model powers UI and MCP).

### Onboarding sequence

1. Land → connect a repository or install the CLI.
2. Connection confirmed **without** immediately spending Shields.
3. Plan/pricing shown before the first billable analysis.
4. After entitlement, the user starts the analysis and watches status
   (pending → uploading → analyzing → completed/failed) in the dashboard.

---

## 14. GitHub App — documented only, final phase

The GitHub App is the primary integration for hosted repositories **when
built** — after Roger's GitHub account is restored. It is fully specified
in `docs/GITHUB_APP.md` and **not implemented** in this version: no app
registration, no webhooks, no GitHub API calls (also impossible under the
current account suspension). Design invariants already fixed there:
minimum permissions, signed webhooks, idempotent/deduplicated events,
backend entitlement check before any analysis, no automatic unlimited
billable work on push, installation↔user↔project scoping. The CLI path
fully satisfies the MVP definition without it.

---

## 15. Reliability and error handling

Partial failure is normal: network interruptions, API timeouts, expired
credentials, permission revocation, rate limiting, duplicate webhooks,
duplicate client requests, failed/incomplete uploads, AI provider errors,
malformed model output, analysis timeouts, inaccessible repos, files
changing during snapshot creation, oversize snapshots. Mechanisms:
bounded retries, timeouts, idempotency keys, explicit job states, clear
error reporting. Observability is privacy-conscious: operational metadata
only, never source content.

---

## 16. Testing and evaluation

- **CLI tests (cargo test):** command/help surface; device flow success,
  denial, expiry against a mock HTTP server; credential storage/logout;
  gitignore behavior; exclusion of binaries/media/PDF/Office/deps and of
  `.env*` even when not ignored; inclusion of text source/config across
  languages; snapshot consistency when the tree changes mid-upload;
  hash/ack semantics; interrupted-upload retry; no analysis before
  completion; size-limit errors; `--auto` skips confirmation only.
- **Backend/shared tests (vitest):** auth + project authorization;
  cross-tenant isolation logic; entitlement enforcement on every
  analysis-starting path; ledger idempotency (duplicate debits/grants
  never double-apply); upload completion semantics; partial upload never
  starts analysis; fingerprint stability across line moves and its change
  on real fixes; deletion behavior; MCP authorization and isolation;
  status transitions and failure recovery; Zod contract validation.
- **Security-analysis evaluation (Phase 7):** seeded sample repositories
  with known, labeled vulnerabilities (the eval set in `eval/`). Measure:
  recall on seeded issues, false positives, severity calibration,
  evidence quality, remediation actionability, verification accuracy,
  and pipeline cost/latency **with the stub provider, labeled as pipeline
  mechanics — not model quality**. Real-model quality/cost benchmarking
  requires Roger's AI Gateway key and is a documented residual.
- No production-grade coverage claims from demos.

---

## 17. Deployment and operations

Initial target: Vercel (Next.js + Workflow + Sandbox) and Supabase
(Postgres/Auth). No separate always-on services. All secrets are
server-side env vars; privileged keys never reach browser or CLI. Local
development, migrations, tests, and deployment steps are documented in
`docs/SETUP.md` and the README. In the build environment nothing is
deployed (no accounts/keys); the repo must build and test green locally.

Support contact domain: **rogeroriaglez.com** — the exact mailbox address
is **not yet confirmed by Roger** and must not be invented; docs carry a
clearly marked placeholder.

---

## 18. Build phases (adapted order, as executed)

- **Phase 0** — This plan + repo scaffold (workspace, Biome, docs standard).
- **Phase 1 — Core:** schema + RLS SQL, auth, device-flow API, projects,
  Shield ledger + entitlement service.
- **Phase 2 — Workflow:** the 8 stages, deterministic checks + Sandbox
  step, Zod-validated structured AI output (stub provider in tests),
  fingerprinting, verification on rescan.
- **Phase 4 — CLI:** full command surface + Rust tests vs mock server.
  (Numbering keeps v1's phase ids; Phase 3 is the deferred GitHub App.)
- **Phase 5 — MCP:** remote MCP server, read-only tools, token auth.
- **Phase 6 — Web UI:** landing, onboarding + pricing gate, dashboard,
  device approval page, Polar checkout/webhooks (honest unconfigured
  behavior without env).
- **Phase 7 — Evaluation + hardening:** seeded eval set, cost measurement
  (stub, labeled), failure-path tests (partial upload, duplicates,
  expired tokens, oversize).
- **Phase 8 — Docs + launch readiness:** README, SETUP, PROJECT_BRIEF,
  `marketing.md` (audience, positioning, value proposition, pricing as
  decided here), GITHUB_APP spec.

Each phase: its own local branch off the previous, tests green before the
branch is merged forward, README/STATUS touched in the same change.

---

## 19. Definition of MVP success

A user can scan a local repository through the Rust CLI (GitHub connection
arrives with the deferred Phase 3); the backend enforces authentication,
ownership, entitlement, and Shield balance; selected code is analyzed
through the one shared workflow; partial uploads cannot trigger analysis;
findings carry evidence, severity, explanations, and correction plans; a
coding agent retrieves authorized findings and tasks through the remote
MCP; updated code can be rescanned to verify remediation; source code is
not persistently stored by Shield; the dashboard presents results and
history clearly; the system behaves predictably under network failures
and duplicate requests; tests demonstrate the critical invariants; setup
and deployment are documented.

---

## 20. Decisions log (this compilation)

| Decision                                                                          | Source                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------- |
| Greenfield repo, not an existing codebase                                         | Roger, round 1                              |
| Monorepo; Zod everywhere; models via Vercel AI Gateway                            | Roger, initial brief                        |
| Engine: Vercel Workflow DevKit; code travels as workflow data (KBs, no DB)        | Roger, round 1                              |
| Billing: Polar; $9 / $19 / pay-as-you-go packs; unit = Shields                    | Roger, rounds 1–2                           |
| Shield quantities & action costs; trial 15 one-time; packs 30/$10, 100/$29        | Builder, under Roger's "encárgate tú"       |
| Device flow built on Supabase (custom protocol, backend-issued CLI token)         | Roger (asked feasibility), confirmed viable |
| GitHub App documented, built last, after account restoration                      | Roger, round 1                              |
| CLI project resolution prompt; single-project users never asked                   | Roger, round 2                              |
| Finding fingerprint ≠ file hash (category+path+function+pattern hash)             | Builder, explained round 2                  |
| Taxonomy: OWASP LLM Top 10 + CWE (+ web Top 10 mapping)                           | Roger, round 1                              |
| Severity scale Critical/High/Medium/Low/Info + separate confidence                | Builder default                             |
| Deterministic tools: TS checks + Vercel Sandbox (in, standard)                    | Roger, rounds 2–3                           |
| Models: economical, cybersecurity-strong, chosen by eval benchmark                | Roger, round 3                              |
| Single-user MVP                                                                   | Roger, round 1                              |
| MCP remote (hosted HTTP)                                                          | Roger, round 1                              |
| `.env*` always excluded in the CLI                                                | Roger, round 1                              |
| Design system: blue (#2563EB family), Inter, tagline, no 3D, no hacker aesthetics | Roger, recovered Oct 19 + round 3           |
| Logo: original minimal shield+AI mark; stock-style icons rejected                 | Roger, round 3                              |
