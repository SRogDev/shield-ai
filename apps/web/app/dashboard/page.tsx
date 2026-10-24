"use client";

import { useEffect, useState } from "react";
import { useDashboard } from "../../lib/store";

const SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"] as const;

export default function DashboardPage() {
  const state = useDashboard();
  const [email, setEmail] = useState("");
  const [projectName, setProjectName] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount by design
  useEffect(() => {
    void state.loadMe();
  }, []);

  const anyIntegrationMissing = state.me && Object.values(state.me.integrations).some((ok) => !ok);

  return (
    <div className="container" style={{ paddingTop: "2rem" }}>
      <h1 style={{ marginTop: 0 }}>Dashboard</h1>

      {anyIntegrationMissing && (
        <div className="banner" style={{ marginBottom: "1rem" }}>
          <strong>Local mode.</strong> Some integrations are not configured in this environment (
          {Object.entries(state.me?.integrations ?? {})
            .filter(([, ok]) => !ok)
            .map(([name]) => name)
            .join(", ")}
          ). Unconfigured integrations return clear errors and nothing is fabricated; analysis runs
          on the labeled stub provider until an AI Gateway key is set. See{" "}
          <code>docs/SETUP.md</code>.
        </div>
      )}

      {state.loading && <p style={{ color: "var(--muted)" }}>Loading…</p>}

      {state.needsAuth && (
        <div className="card" style={{ maxWidth: 440 }}>
          <h3 style={{ marginTop: 0 }}>Sign in</h3>
          <p style={{ color: "var(--muted)" }}>
            Local development sign-in (Supabase Auth takes over once configured).
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void state.localSignIn(email);
            }}
            style={{ display: "flex", gap: "0.5rem" }}
          >
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="primary" type="submit">
              Sign in
            </button>
          </form>
          {state.error && <p style={{ color: "var(--high)" }}>{state.error}</p>}
        </div>
      )}

      {state.me && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <div className="card">
              <p style={{ color: "var(--muted)", margin: "0 0 0.25rem" }}>Plan</p>
              <p style={{ fontSize: "1.3rem", fontWeight: 700, margin: 0 }}>
                {state.me.plan.name} · ${state.me.plan.priceUsdMonthly}/mo
              </p>
            </div>
            <div className="card">
              <p style={{ color: "var(--muted)", margin: "0 0 0.25rem" }}>Shield balance</p>
              <p style={{ fontSize: "1.3rem", fontWeight: 700, margin: 0 }}>
                {state.me.balance} Shields
              </p>
            </div>
            <div className="card">
              <p style={{ color: "var(--muted)", margin: "0 0 0.25rem" }}>Projects</p>
              <p style={{ fontSize: "1.3rem", fontWeight: 700, margin: 0 }}>
                {state.projects.length}
              </p>
            </div>
          </div>

          <div className="card" style={{ marginBottom: "1rem" }}>
            <h3 style={{ marginTop: 0 }}>Projects</h3>
            {state.projects.length === 0 && (
              <p style={{ color: "var(--muted)" }}>
                No projects yet. Create one here, or run <code>shield scan</code> in a repo —
                connecting a project never spends Shields by itself.
              </p>
            )}
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1rem" }}>
              {state.projects.map((p) => (
                <li key={p.id} style={{ padding: "0.35rem 0" }}>
                  <button
                    type="button"
                    onClick={() => void state.selectProject(p.id)}
                    className={state.selectedProjectId === p.id ? "primary" : undefined}
                  >
                    {p.name}
                  </button>
                </li>
              ))}
            </ul>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (projectName.trim()) void state.createProject(projectName.trim());
                setProjectName("");
              }}
              style={{ display: "flex", gap: "0.5rem" }}
            >
              <input
                placeholder="New project name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />
              <button type="submit">Create project</button>
            </form>
          </div>

          <div className="card" style={{ marginBottom: "1rem" }}>
            <h3 style={{ marginTop: 0 }}>Findings</h3>
            {state.findings.length === 0 && (
              <p style={{ color: "var(--muted)" }}>
                No findings recorded for this project yet. Run a scan to see evidence-backed
                findings here, grouped by severity.
              </p>
            )}
            {SEVERITIES.map((severity) => {
              const group = state.findings.filter((f) => f.severity === severity);
              if (group.length === 0) return null;
              return (
                <div key={severity} style={{ marginBottom: "1rem" }}>
                  <p>
                    <span className={`badge ${severity}`}>{severity}</span>{" "}
                    <span style={{ color: "var(--muted)" }}>{group.length} finding(s)</span>
                  </p>
                  {group.map((f) => (
                    <article
                      key={f.id}
                      style={{ borderTop: "1px solid var(--border)", padding: "0.75rem 0" }}
                    >
                      <strong>{f.title}</strong>{" "}
                      <span style={{ color: "var(--muted)", fontSize: "0.88rem" }}>
                        {f.cwe} · {f.owasp.join(", ")} · confidence {f.confidence} ·{" "}
                        {f.verificationStatus.replace("_", " ")}
                      </span>
                      <p style={{ color: "var(--muted)", margin: "0.35rem 0" }}>{f.description}</p>
                      <p style={{ margin: 0, fontSize: "0.9rem" }}>
                        <code>
                          {f.filePath}:{f.lineStart}–{f.lineEnd}
                        </code>{" "}
                        — {f.evidence}
                      </p>
                    </article>
                  ))}
                </div>
              );
            })}
          </div>

          <div className="card" style={{ marginBottom: "1rem" }}>
            <h3 style={{ marginTop: 0 }}>Remediation tasks</h3>
            {state.tasks.length === 0 && (
              <p style={{ color: "var(--muted)" }}>No outstanding tasks.</p>
            )}
            <ul style={{ color: "var(--muted)", lineHeight: 1.7 }}>
              {state.tasks.map((t) => (
                <li key={t.id}>
                  <strong style={{ color: "var(--ink)" }}>{t.title}</strong> — {t.guidance}
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Shield history</h3>
            {state.me.history.length === 0 && (
              <p style={{ color: "var(--muted)" }}>No Shield movements yet.</p>
            )}
            <ul style={{ listStyle: "none", padding: 0, margin: 0, color: "var(--muted)" }}>
              {[...state.me.history].reverse().map((entry) => (
                <li
                  key={entry.id}
                  style={{ padding: "0.3rem 0", borderTop: "1px solid var(--border)" }}
                >
                  <strong style={{ color: entry.amount > 0 ? "var(--blue)" : "var(--high)" }}>
                    {entry.amount > 0 ? "+" : ""}
                    {entry.amount}
                  </strong>{" "}
                  {entry.kind.replaceAll("_", " ")}
                  {entry.reference ? ` · ${entry.reference}` : ""}{" "}
                  <span style={{ color: "var(--faint)" }}>
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
