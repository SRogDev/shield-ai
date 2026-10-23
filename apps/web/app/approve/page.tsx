"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function ApproveForm() {
  const params = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  async function call(path: string): Promise<void> {
    setError(null);
    setMessage(null);
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userCode: code.trim().toUpperCase() }),
    });
    const body = (await res.json()) as { error?: string };
    if (res.status === 401) {
      setNeedsAuth(true);
      setError("Sign in first, then approve the code.");
      return;
    }
    if (!res.ok) {
      setError(body.error ?? `HTTP ${res.status}`);
      return;
    }
    setMessage(
      path.endsWith("approve")
        ? "Device approved. The CLI now holds a scoped token — you can close this tab."
        : "Device denied.",
    );
  }

  async function signIn(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const res = await fetch("/api/auth/local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.ok) {
      setNeedsAuth(false);
      setError(null);
      setMessage("Signed in locally. Now approve the code.");
    } else {
      const body = (await res.json()) as { error?: string };
      setError(body.error ?? "sign-in failed");
    }
  }

  return (
    <div className="container" style={{ paddingTop: "2.5rem", maxWidth: 560 }}>
      <div className="card">
        <h1 style={{ marginTop: 0, fontSize: "1.5rem" }}>Approve a CLI device</h1>
        <p style={{ color: "var(--muted)" }}>
          Enter the user code shown by <code>shield login</code>. Approving gives that terminal a
          scoped, revocable token for your account — it never proves entitlement by itself; the
          backend still checks your plan and Shield balance on every scan.
        </p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="User code (e.g. ABCD2345)"
          style={{ width: "100%", marginBottom: "0.75rem", textTransform: "uppercase" }}
        />
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            className="primary"
            onClick={() => void call("/api/device/approve")}
          >
            Approve device
          </button>
          <button type="button" onClick={() => void call("/api/device/deny")}>
            Deny
          </button>
        </div>
        {needsAuth && (
          <form onSubmit={signIn} style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit">Sign in (local)</button>
          </form>
        )}
        {message && <p style={{ color: "var(--blue)" }}>{message}</p>}
        {error && <p style={{ color: "var(--high)" }}>{error}</p>}
      </div>
    </div>
  );
}

export default function ApprovePage() {
  return (
    <Suspense
      fallback={
        <div className="container" style={{ paddingTop: "2.5rem" }}>
          Loading…
        </div>
      }
    >
      <ApproveForm />
    </Suspense>
  );
}
