# Status

## 2026-10-23 — Local MVP build complete (phases 0–8)

All work is local (GitHub account suspended — zero GitHub calls). Linear
history, one branch per phase, merged fast-forward into `main`.

- **Phase 0** `55a62ac` — PLAN_V2 compiled (docs/PLAN_V2.md), monorepo
  scaffold.
- **Phase 1** `4ff89c5` — core: Zod contracts, plans/pricing, Shield
  ledger, fingerprinting, services (auth/device flow/projects/scans),
  Supabase schema + RLS migrations.
- **Phase 2** `f56540e` — deterministic checks (secrets, lockfile→OSV
  contract, insecure config, TS AST), 8-stage workflow engine with stub
  AI provider, fingerprint verification on rescan. (MCP core landed here.)
- **Phase 4** `1e1d002` — Rust CLI: login/scan/logout, device flow,
  snapshot + resumable upload, project resolution.
- **Phase 5–6** `5d0e1fd` — Next.js web app: landing, dashboard, device
  approval, full API, remote MCP endpoint, Polar checkout/webhooks,
  Vercel Workflow entry, Vercel Sandbox tool runner.
- **Phase 7** — eval set (seeded vulnerable / fixed / clean fixtures),
  eval harness, failure-path tests.
- **Phase 8** — docs: SETUP, PROJECT_BRIEF, GITHUB_APP spec, marketing.

## Verification (2026-10-23)

- `packages/shared`: **64/64 vitest** (9 suites: ledger, plans,
  fingerprint, services, checks, workflow, MCP, eval, failure paths).
- `cli/`: **32/32 cargo tests**, clippy `-D warnings` clean, fmt clean.
- `apps/web`: `next build` green (Next 16.4.3); Biome clean (87 files).
- `scripts/smoke-local.mjs`: **17/17 checks** against the running server
  (auth, device flow, scan lifecycle, idempotent debit, MCP auth,
  honest 503s).
- Real CLI↔server run: login → scan (5 Shields) → findings (CWE-862,
  CWE-489) → logout.

## Next (needs Roger — see docs/SETUP.md residuals)

Supabase project + store adapter wiring, Polar org/products, AI Gateway
key + real model benchmark, Vercel deploy, support mailbox, GitHub App
after account restoration.
