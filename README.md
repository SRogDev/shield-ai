# Shield AI

**Security that lets you build.**

Security analysis for indie developers building AI-powered micro-SaaS:
Shield scans your own project, explains what is actually wrong with
evidence, gives you (or your coding agent) a concrete correction plan,
and verifies the fix on the next scan. Your source code is processed
transiently and never stored.

## Status

Local MVP build (October 2026). All integrations (Supabase, Polar, Vercel
AI Gateway, Vercel Sandbox) are implemented against their real contracts
and are gated on environment configuration: without keys they return
clear "not configured" errors, and the test suite runs entirely on
stub/mock providers at $0. See `STATUS.md` and `docs/SETUP.md`.

## What is in the box

- `apps/web` — Next.js commercial web app: landing, dashboard, API,
  device-approval page, remote MCP server.
- `packages/shared` — the contract source of truth: Zod schemas, plan and
  Shield cost tables, the append-only Shield ledger, finding
  fingerprinting, deterministic security checks, and the 8-stage analysis
  workflow engine.
- `cli/` — the Rust `shield` CLI: `shield login`, `shield scan [path]`,
  `shield logout`.
- `supabase/migrations/` — Postgres schema + Row Level Security.
- `eval/` — seeded vulnerable sample projects + evaluation harness.

## How it works (short version)

1. Connect a project (web) or scan a local repo (`shield scan`).
2. Files are selected locally (gitignore rules + content filtering;
   `.env*` is always excluded), snapshotted in memory with SHA-256
   hashes, previewed with their Shield cost, and uploaded per-file.
3. Only when the backend has acknowledged **every** file does the
   8-stage analysis workflow start: understand → gather evidence
   (deterministic checks + sandboxed tools) → identify → evaluate →
   explain → correction plan → verify → record.
4. Findings land in the dashboard with evidence, severity (CWE + OWASP
   mapped), and remediation tasks — also readable by coding agents
   through the read-only remote MCP server.

## Pricing (Shields)

Work is paid in **Shields**, a unit of security work — never tokens.
Free trial: 15 Shields one-time · Indie $9/mo: 40 Shields/mo, 1 project ·
Builder $19/mo: 100 Shields/mo, multiple projects · Packs: 30/$10,
100/$29 (never expire, never auto-recharged). Full scan: 5 Shields
(standard) / 12 (large); incremental rescan 3; quick deterministic scan
or single-finding verification 1.

## Develop

```bash
pnpm install
pnpm test            # TS test suites
cd cli && cargo test # Rust test suite
pnpm lint            # Biome
```

Full setup, environment variables, and deployment notes:
`docs/SETUP.md`. Specification: `docs/PLAN_V2.md`. Project brief for
handoff: `docs/PROJECT_BRIEF.md`. GitHub App (final phase, not yet
built): `docs/GITHUB_APP.md`.

## License

Elastic License 2.0 (see `LICENSE`). Shield AI is source-available, not
open source: you may use, copy, and modify the software — including
running your own instance for your own use — but you may not offer it to
third parties as a hosted or managed service. Shield AI is a hosted
product; no self-hosting guides or support are provided.

## Privacy, honestly

Shield itself never persists your source code. Analysis runs on Vercel
infrastructure, which retains workflow run data for a period under
Vercel's own retention policy, and code snippets are sent to the model
providers behind Vercel AI Gateway under their terms. A scan helps you
find weaknesses; it never proves an application secure.
