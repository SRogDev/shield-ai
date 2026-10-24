import { PLANS, SHIELD_PACKS } from "@shield/shared";
import { Logo } from "../components/Logo";

const FINDINGS_EXAMPLES = [
  "Routes that return other users' data (IDOR / missing ownership checks)",
  "Secrets and API keys committed to source",
  "Prompt injection paths and unsafe handling of model output",
  "Agents and tools with more permission than they need",
  "Known-vulnerable dependencies in your lockfile",
  "Auth and tenant-isolation mistakes in your own API routes",
];

export default function LandingPage() {
  return (
    <div className="container">
      <section className="rise" style={{ textAlign: "center", padding: "4.5rem 0 3rem" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Logo size={56} />
        </div>
        <h1 style={{ fontSize: "2.6rem", lineHeight: 1.15, margin: "1rem 0 0.75rem" }}>
          Security that lets you build.
        </h1>
        <p style={{ color: "var(--muted)", fontSize: "1.15rem", maxWidth: 640, margin: "0 auto" }}>
          Shield AI analyzes <strong>your actual project</strong> — not a generic checklist — and
          gives you evidence-backed findings, a concrete correction plan your coding agent can
          execute, and verification that the fix really landed.
        </p>
        <div
          style={{
            marginTop: "1.75rem",
            display: "flex",
            gap: "0.75rem",
            justifyContent: "center",
          }}
        >
          <a href="/dashboard">
            <button type="button" className="primary" style={{ padding: "0.7rem 1.4rem" }}>
              Secure your project
            </button>
          </a>
          <a href="#pricing">
            <button type="button" style={{ padding: "0.7rem 1.4rem" }}>
              See pricing
            </button>
          </a>
        </div>
        <p style={{ color: "var(--faint)", fontSize: "0.9rem", marginTop: "1rem" }}>
          15 Shields free to start. No card. Your source code is never stored.
        </p>
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "1rem",
          margin: "1rem 0 2.5rem",
        }}
      >
        {[
          {
            title: "1 · Scan",
            body: "Connect a project or run `shield scan` locally. You preview every file and the exact Shield cost before anything is sent.",
          },
          {
            title: "2 · Understand",
            body: "Deterministic tools check secrets, dependencies, and known patterns; AI stages judge context, severity, and real impact on your code.",
          },
          {
            title: "3 · Fix & verify",
            body: "Every finding ships with a correction plan. Your coding agent can pull tasks through MCP, and the next scan verifies the fix.",
          },
        ].map((s) => (
          <div key={s.title} className="card">
            <h3 style={{ marginTop: 0 }}>{s.title}</h3>
            <p style={{ color: "var(--muted)", marginBottom: 0 }}>{s.body}</p>
          </div>
        ))}
      </section>

      <section className="card" style={{ marginBottom: "2.5rem" }}>
        <h2 style={{ marginTop: 0 }}>What Shield looks for</h2>
        <ul style={{ color: "var(--muted)", lineHeight: 1.9, marginBottom: 0 }}>
          {FINDINGS_EXAMPLES.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <p style={{ color: "var(--faint)", fontSize: "0.9rem" }}>
          Findings are mapped to CWE and the OWASP Top 10 / LLM Top 10, with severity based on real
          impact — never on a suspicious pattern alone.
        </p>
      </section>

      <section id="pricing" style={{ marginBottom: "3rem" }}>
        <h2 style={{ textAlign: "center" }}>Pricing in Shields</h2>
        <p
          style={{
            textAlign: "center",
            color: "var(--muted)",
            maxWidth: 620,
            margin: "0 auto 1.5rem",
          }}
        >
          You pay for security work in <strong>Shields</strong>, never for tokens. A full scan costs
          5 Shields (12 for large repos), an incremental rescan 3, a quick deterministic scan or a
          single-fix verification 1. The cost is always shown before you confirm.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            gap: "1rem",
          }}
        >
          {[PLANS.trial, PLANS.indie, PLANS.builder].map((plan) => (
            <div key={plan.id} className="card" style={{ textAlign: "center" }}>
              <h3 style={{ marginTop: 0 }}>{plan.name}</h3>
              <p style={{ fontSize: "2rem", fontWeight: 800, margin: "0.25rem 0" }}>
                ${plan.priceUsdMonthly}
                <span style={{ fontSize: "0.95rem", color: "var(--muted)", fontWeight: 500 }}>
                  /mo
                </span>
              </p>
              <p style={{ color: "var(--muted)" }}>
                {plan.shieldsPerPeriod} Shields {plan.recurring ? "per month" : "one-time"}
                <br />
                {plan.maxProjects === 1 ? "1 project" : "Multiple projects"}
              </p>
              <a href="/dashboard">
                <button type="button" className={plan.id === "indie" ? "primary" : undefined}>
                  Start with {plan.shieldsPerPeriod} Shields
                </button>
              </a>
            </div>
          ))}
        </div>
        <p style={{ textAlign: "center", color: "var(--muted)", marginTop: "1rem" }}>
          Need more? Shield packs:{" "}
          {SHIELD_PACKS.map((p) => `${p.shields} for $${p.priceUsd}`).join(" · ")}. Pack Shields
          never expire and are never auto-recharged.
        </p>
      </section>
    </div>
  );
}
