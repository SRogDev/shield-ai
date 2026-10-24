# GitHub App — Specification (FINAL PHASE, not yet built)

> **Status: documented only.** Per Roger's decision (2026-10-23), the
> GitHub App is the last integration to be built, after his GitHub account
> (SRogDev) is restored. Nothing in this document is implemented: no app
> registration, no webhook receiver, no GitHub API calls exist in the
> codebase, and the current account suspension makes them impossible.
> The CLI path fully satisfies the MVP definition (PLAN_V2 §19) without it.

## Purpose

Connect hosted GitHub repositories to Shield so pushes can be analyzed
through the **same** backend pipeline the CLI uses (one shared workflow,
one entitlement path). The GitHub App is an ingestion adapter, never a
second analysis system.

## Registration (when the account is restored)

- App name: `Shield AI` (slug to confirm at registration).
- Homepage: the production web URL. Support contact: rogeroriaglez.com
  domain (exact mailbox still to be confirmed by Roger — do not invent).
- Webhook URL: `https://<web>/api/github/webhook` (to be built).
- Webhook secret: generated at registration, stored server-side only.

## Permissions (minimum necessary)

- Repository contents: **read-only** (fetch the tree/tarball at a commit).
- Metadata: read-only (default).
- Pull requests: read-only (future: annotate findings on PRs — not MVP).
- Checks: write — **only if** PR annotations are approved as a feature;
  not requested at initial registration.
- No administration, no contents write, no secrets access.

## Events

- `installation` / `installation_repositories`: maintain the
  installation ↔ user ↔ project mapping.
- `push` (default branch only at first): candidate trigger for analysis.
- `pull_request` (opened/synchronize): candidate trigger **only if** the
  project enables PR scans.

## Invariants (binding when built)

1. **Signature verification** on every webhook (HMAC with the app secret)
   before any processing; invalid signatures are rejected and logged
   (metadata only).
2. **Idempotency:** deliveries are deduplicated by delivery id, and scans
   by (repo, commit SHA, action) — a redelivered or repeated event never
   creates a second scan or a second Shield debit.
3. **Entitlement first:** the backend checks user, project↔repo
   association, plan, and Shield balance **before** fetching contents or
   starting any analysis. An unauthorized or unentitled event is recorded
   as ignored, never executed.
4. **No unlimited automatic work:** automatic scans on push are OFF by
   default per project; when enabled, they are bounded by the project's
   plan and balance, and the user can see and disable them. Connect the
   repo first, spend later (same onboarding rule as the CLI).
5. **Transient contents:** repository contents at a commit are fetched
   into memory / the workflow input exactly like a CLI snapshot — never
   persisted (PLAN_V2 §10). The scan manifest records paths/sizes/SHA-256
   only, plus the commit SHA as provenance metadata.
6. **Installation tokens** are minted per operation, scoped to the single
   installation, never stored beyond the request, and never exposed to
   the browser or the CLI.
7. **Cost preview parity:** the Shield cost of a GitHub-triggered scan is
   computed by the same `costForAction` table; the dashboard shows
   projected cost for automatic scans before the user enables them.

## Data additions when built

- `github_installations` (installation id ↔ user id).
- `github_repo_links` (installation id + repo full name ↔ project id,
  auto-scan flag).
- `github_deliveries` (delivery id, event, processed_at) for dedupe.
- All with RLS owner policies mirroring the existing tables.

## Build order when unblocked

1. Roger restores the GitHub account and registers the app (his action —
   requires his credentials and judgment on the slug/permissions screen).
2. Backend: installation mapping + webhook receiver with the invariants
   above, behind a feature flag, tested with recorded webhook fixtures.
3. Contents ingestion into the existing scan pipeline (reuse
   `createScan` semantics with a server-side snapshot source).
4. Dashboard: connect/disconnect, auto-scan toggle with cost preview.
5. Eval: duplicate-delivery, cross-installation, and entitlement tests
   before the flag is enabled for any real repository.
