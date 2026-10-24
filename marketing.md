# Shield AI — Marketing

## Target audience

Indie founders and solo builders shipping AI-powered micro-SaaS products:
people building with LLM APIs, tools, agents, and retrieval — often with
heavy help from AI coding agents — who know security matters but have no
security team, no security hires, and no time to become security experts.

## Positioning

Shield AI is the security analyst an indie AI builder would hire if they
could: it reads _your_ project, tells you what is actually wrong with
evidence, hands you (or your coding agent) the fix, and checks the fix
landed. It is not a generic scanner spraying checklist warnings, not a
runtime gateway, and not an autonomous agent that rewrites your code.

Tagline: **Security that lets you build.**

## Value proposition

- **Find real problems in your code, not theoretical ones.** Every finding
  is grounded in your repository, with file, line, evidence, CWE/OWASP
  mapping, and severity based on real impact.
- **Fixes you can hand to your coding agent.** Remediation tasks are
  structured for agents and retrievable through a read-only MCP server —
  your agent fixes, Shield verifies.
- **Proof, not promises.** The next scan verifies whether each weakness
  is actually gone, tracked finding by finding.
- **Your code is never the product.** Source is processed transiently and
  never stored by Shield.
- **Priced for indies.** Security work is sold in Shields — a unit of
  work, never tokens — with the cost shown before anything runs.

## Pricing (as decided, October 2026)

- **Free trial:** 15 Shields, one-time, 1 project. No card.
- **Indie — $9/month:** 40 Shields/month, 1 project.
- **Builder — $19/month:** 100 Shields/month, multiple projects.
- **Shield packs:** 30 Shields for $10 · 100 Shields for $29. Never
  expire, never auto-recharged.

Action costs: full scan 5 Shields (12 for large repos), incremental
rescan 3, quick deterministic scan 1, verify one fix 1.

## Messaging pillars

1. _Built for AI builders._ The threat model includes prompt injection,
   over-permissioned agents, and model-output handling — not just classic
   web bugs (OWASP LLM Top 10 + CWE).
2. _Calm, not fear._ Shield reduces the mental load of "is my app safe?"
   to a short, prioritized list with fixes. No hacker aesthetics, no
   alarmism.
3. _Honest by design._ A scan never proves an app secure; Shield says
   what it checked, what it found, and what it could not verify.
4. _Agent-native._ Findings and tasks are as readable to coding agents
   (via MCP) as they are to the founder in the dashboard.

## Proof points (only claims the product can back)

- One shared analysis pipeline for CLI scans (GitHub App arrives in the
  final phase — do not advertise it as available until it ships).
- Findings carry evidence and verification status across scans.
- Append-only Shield ledger: retries and duplicate events can never
  double-charge.
- Source code is never persisted by Shield; processing runs on Vercel
  with its documented retention, stated plainly in the product.

## Support

Support domain: rogeroriaglez.com — exact mailbox **to be confirmed by
Roger** (do not publish an address until confirmed).
