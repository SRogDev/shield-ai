# Shield AI — Setup, environment, and deployment

## Local development (no accounts needed)

Requirements: Node 24, pnpm (`~/.local/bin`), Rust toolchain
(`~/.cargo/bin`) for the CLI.

```bash
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
pnpm install
pnpm --filter @shield/shared build     # build the shared contracts first
pnpm --filter @shield/web dev          # web app on http://localhost:3000
node scripts/smoke-local.mjs           # in another terminal: API smoke test
cd cli && cargo test                   # CLI suite
../cli/target/debug/shield --help     # CLI surface
```

With **no environment variables set**, the app runs in **local mode**:
- Web sign-in is a labeled local form (email → local user). Data lives in
  process memory and disappears on restart.
- Analysis runs on the **stub AI provider** (deterministic, $0) and the
  **stub OSV client** (canned fixtures). Outputs are mechanical and are
  labeled as stub results — they demonstrate the pipeline, not model
  quality.
- Polar checkout/webhook endpoints return `503 … not configured`.
- The Vercel Sandbox tool runner reports itself unavailable; the
  TypeScript deterministic checks still run.
- The CLI works end-to-end against the local server
  (`SHIELD_API_URL=http://localhost:3000 shield login`).

## Environment variables (server-side only)

| Variable                                               | Purpose                                               | Needed for              |
| ------------------------------------------------------ | ----------------------------------------------------- | ----------------------- |
| `SUPABASE_URL`                                         | Supabase project URL                                  | Production auth + DB    |
| `SUPABASE_ANON_KEY`                                    | Supabase anon key                                     | Validating web sessions |
| `SUPABASE_SERVICE_ROLE_KEY`                            | Service role (server only, never ship to clients)     | Backend writes          |
| `AI_GATEWAY_API_KEY`                                   | Vercel AI Gateway                                     | Real model analysis     |
| `POLAR_ACCESS_TOKEN`                                   | Polar API token                                       | Checkout creation       |
| `POLAR_WEBHOOK_SECRET`                                 | Polar webhook signing secret                          | Webhook verification    |
| `POLAR_INDIE_PRODUCT_ID` / `POLAR_BUILDER_PRODUCT_ID`  | Polar product ids for plans                           | Webhook → plan mapping  |
| `POLAR_PACK30_PRODUCT_ID` / `POLAR_PACK100_PRODUCT_ID` | Polar product ids for Shield packs                    | Webhook → pack mapping  |
| `VERCEL_OIDC_TOKEN`                                    | Vercel OIDC token                                     | Sandbox tool runner     |
| `SHIELD_PUBLIC_URL`                                    | Public base URL (device verification links)           | CLI device flow         |
| `SHIELD_OSV_LIVE`                                      | `1` = real OSV API lookups instead of the stub client | Live dependency data    |

All variables are validated with Zod at boot (`ServerEnvSchema` in
`packages/shared`). Missing keys degrade only their own integration —
each failure says exactly which variables are missing.

## Database (Supabase)

1. Create the Supabase project (Roger's action — his account/keys).
2. Apply the migrations in `supabase/migrations/` in order
   (`20261023000001_core_schema.sql`, then
   `20261023000002_ledger_and_billing.sql`) via the Supabase SQL editor or
   CLI.
3. Set the Supabase env variables above and restart the web app.

> **Wiring note (honest residual):** the migrations are complete and the
> service layer's semantics (`packages/shared/src/services.ts`) mirror
> them 1:1, but the production adapter that swaps the in-memory store for
> Supabase queries is **not yet implemented** — it lands when Roger
> creates the project, and it must pass the same service test suite
> before replacing the local store.

## Billing (Polar)

1. Create the Polar organization and four products: Indie ($9/mo),
   Builder ($19/mo), Shield pack 30 ($10 one-time), Shield pack 100 ($29
   one-time). Subscription products must pass the buyer's Shield user id
   as `customer_external_id` (the checkout route already does this).
2. Configure the webhook endpoint `https://<web>/api/billing/webhook`
   for subscription and order events; set the secret env var.
3. Entitlement flows **only** from webhooks: subscription activation
   grants the plan's monthly Shields (idempotent per period); a paid pack
   order grants non-expiring Shields. Checkout creation alone grants
   nothing.

## Deployment (Vercel)

1. Import the repo as a monorepo project; root directory `apps/web`.
2. Set all env variables above in the Vercel project.
3. Deploy. On Vercel, completed uploads start analysis as a durable
   **Workflow** run (`workflows/scan.ts`); the Workflow DevKit endpoints
   are generated at build time.
4. The Sandbox runner activates when `VERCEL_OIDC_TOKEN` is present.

## CLI distribution (current state)

Build locally: `cd cli && cargo build --release`. The binary is
`shield` (login / scan / logout). Packaged installers and signed releases
are a post-MVP task; the CLI talks to any deployment via
`SHIELD_API_URL`.

## Residuals — what needs Roger

- Supabase project + keys, and the Supabase store adapter (above).
- Polar organization, products, webhook secret.
- AI Gateway key + the Phase 7 model benchmark that turns the provisional
  model table into an evidence-based one (benchmark harness is the eval
  suite + a real provider run; not possible at $0).
- Vercel project/deploy.
- Support mailbox address on rogeroriaglez.com (docs carry a placeholder;
  the address must not be invented).
- GitHub account restoration → GitHub App phase (`docs/GITHUB_APP.md`).
