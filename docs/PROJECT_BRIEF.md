# Project Brief — Shield AI (handoff)

## What this is

Shield AI: security analysis for indie developers building AI-powered
micro-SaaS. It scans the user's own project (Rust CLI for local repos;
dashboard on the web), produces evidence-backed findings with severity
(CWE + OWASP), correction plans a coding agent can execute (exposed
read-only via a remote MCP server), and verifies fixes on rescan. Source
code is never persisted. Full specification: `docs/PLAN_V2.md`.

## Stack

- **Monorepo** (pnpm workspaces): `apps/web`, `packages/shared`, `cli/`,
  `supabase/`, `eval/`.
- **Web:** Next.js 16.4.3 on Vercel; React 19; Zustand (client mirror
  only); Biome; TypeScript strict.
- **Contracts:** Zod schemas in `packages/shared` are the single source
  of truth (API, AI output, env, MCP, webhooks). The Rust CLI mirrors
  them by hand (`cli/src/api.rs`).
- **Data:** Supabase Postgres + Auth, schema + RLS in
  `supabase/migrations/`. The service layer
  (`packages/shared/src/services.ts`) holds all backend authority:
  device flow, CLI tokens (hashed), projects/repo links, scan lifecycle,
  append-only Shield ledger (idempotent grants/debits).
- **Analysis:** one 8-stage workflow — Vercel Workflow DevKit entry
  (`apps/web/workflows/scan.ts`) over the platform-neutral engine
  (`packages/shared/src/workflow.ts`). Deterministic checks in TS
  (secrets, lockfile→OSV contract, insecure config, AST route checks) +
  Vercel Sandbox runner for Linux tools (gitleaks/semgrep class). AI via
  Vercel AI SDK → AI Gateway, model table in
  `packages/shared/src/ai.ts` (provisional candidates; benchmark pending
  a real key). Stub provider implements the same interface for $0 tests.
- **Billing:** Polar (merchant of record). Checkout route + signed,
  deduplicated webhooks → ledger grants. Plans: trial 15 Shields
  one-time; Indie $9/mo = 40/mo, 1 project; Builder $19/mo = 100/mo,
  multi-project; packs 30/$10, 100/$29, never expire, no auto-recharge.
- **CLI:** Rust (clap, ureq, ignore, sha2, keyring) — exactly
  `shield login|scan|logout`. Gitignore-aware discovery, content-based
  text detection, `.env*` always excluded, in-memory snapshot with
  SHA-256, preview with Shield cost, per-file resumable upload,
  server-side project resolution (single-project users never prompted).

## State (2026-10-23)

Local MVP build complete: plan v2 compiled; phases 1, 2, 4, 5, 6, 7, 8
implemented and tested locally; linear git history, one branch per
phase, zero GitHub calls (account suspended). Verified: shared vitest
suites, cargo test + clippy, Next production build, an API smoke script
(`scripts/smoke-local.mjs`, 17/17 checks), and a real CLI↔server
end-to-end run (login → scan → findings → logout).

## Not done / needs Roger

- **Supabase store adapter**: runtime store is in-memory (local/tests);
  migrations are production-shaped. Needs Roger's Supabase project.
- **Polar**: code complete against the real API/webhook contract;
  needs Roger's Polar org, products, and secrets to go live.
- **Real AI models**: gateway provider implemented; model benchmark and
  any quality/cost claims need Roger's AI Gateway key.
- **Vercel deploy**: not deployed (no account wiring done here).
- **GitHub App**: specified in `docs/GITHUB_APP.md`; blocked on GitHub
  account restoration; deliberately unimplemented.
- **Support mailbox** on rogeroriaglez.com: unconfirmed; placeholders in
  docs/UI must not be replaced with an invented address.

## Invariants a future agent must not break

1. Backend authorizes identity + ownership + plan + Shield balance on
   every analysis-starting path; partial uploads never start analysis.
2. Ledger entries are append-only and idempotent; duplicates never
   double-charge or double-grant.
3. Source contents exist only transiently (workflow data / process
   memory) and are purged at scan terminal state; never in DB or logs.
4. A failed scan is marked failed with a reason — never "completed".
5. Stub results are always labeled; unconfigured integrations error
   honestly instead of fabricating output.
