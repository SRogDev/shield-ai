# AGENTS.md — Shield AI working agreement

## Source of truth
`docs/PLAN_V2.md` is the compiled specification (original plan + all of
Roger's 2026-10-23 decisions). Build to it; if code and plan disagree, the
plan wins until the plan is amended in the same change.

## Hard rules
- **Zero GitHub calls** while Roger's account (SRogDev) is suspended. Local
  git only, linear history, one branch per phase, never push.
- **No live keys exist** (Supabase, Polar, Vercel, AI Gateway). Integrations
  are coded against real SDKs/contracts and must fail honestly with a clear
  "not configured" error when env is absent. Tests run at $0 with stub/mock
  providers, labeled as stubs. Never claim a live integration works.
- **Source code is never persisted.** File contents travel as workflow
  input/step data only. DB stores findings, tasks, manifests (path/size/
  SHA-256), and metadata — never contents.
- **Backend is the authority** for identity, project access, plan, and
  Shield balance on every analysis-starting path.
- **Zod everywhere** for external input: API, AI structured output, env,
  MCP schemas, webhook payloads. Schemas live in `packages/shared`.
- **Biome** only (no ESLint/Prettier). TypeScript strict. Rust: fmt+clippy.
- **UI** goes through ui-ux-pro-max + the brand system in PLAN_V2 §13
  (blue #2563EB family, Inter, no 3D, no hacker aesthetics).
- README + STATUS.md updated in the same change as any significant work.

## Layout
- `apps/web` — Next.js app (landing, dashboard, API, MCP, workflow entry).
- `packages/shared` — Zod contracts, plans/costs, ledger, fingerprint,
  deterministic checks, workflow engine.
- `cli/` — Rust `shield` binary (login / scan / logout only).
- `supabase/migrations/` — schema + RLS.
- `eval/` — seeded vulnerable repos + eval harness.

## Commands
- Install: `pnpm install` (PATH needs `~/.local/bin` and `~/.cargo/bin`).
- Test all: `pnpm test` and `cd cli && cargo test`.
- Lint: `pnpm lint`; Rust: `cargo clippy -- -D warnings`.
