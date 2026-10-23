import type { ReactNode } from "react";
import { Logo } from "../components/Logo";
import "./globals.css";

export const metadata = {
  title: "Shield AI — Security that lets you build",
  description:
    "Security analysis for indie developers building AI-powered micro-SaaS. Evidence-backed findings, correction plans, and verified fixes. Your source code is never stored.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none'%3E%3Cpath d='M24 4 40 10v12c0 10.5-6.8 17.7-16 22C14.8 39.7 8 32.5 8 22V10L24 4Z' stroke='%232563EB' stroke-width='3' stroke-linejoin='round'/%3E%3Ccircle cx='24' cy='19' r='2.6' fill='%232563EB'/%3E%3Ccircle cx='16.5' cy='28' r='2.2' fill='%232563EB'/%3E%3Ccircle cx='31.5' cy='28' r='2.2' fill='%232563EB'/%3E%3C/svg%3E"
        />
      </head>
      <body>
        <header
          style={{
            borderBottom: "1px solid var(--border)",
            background: "var(--card)",
          }}
        >
          <div
            className="container"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              paddingTop: "0.8rem",
              paddingBottom: "0.8rem",
            }}
          >
            <Logo />
            <a href="/" style={{ fontWeight: 800, fontSize: "1.1rem", color: "var(--ink)" }}>
              Shield AI
            </a>
            <nav style={{ marginLeft: "auto", display: "flex", gap: "1.25rem", fontSize: "0.95rem" }}>
              <a href="/dashboard">Dashboard</a>
              <a href="/approve">Approve a device</a>
              <a href="/#pricing">Pricing</a>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer
          style={{
            borderTop: "1px solid var(--border)",
            marginTop: "4rem",
            padding: "1.5rem 0",
            color: "var(--muted)",
            fontSize: "0.88rem",
          }}
        >
          <div className="container">
            Shield AI never stores your source code. Analysis runs on Vercel infrastructure,
            which retains workflow run data under its own retention policy, and snippets are
            sent to the model providers behind Vercel AI Gateway under their terms. A scan
            helps you find weaknesses — it never proves an application secure.
            <br />
            Support: <em>[mailbox on rogeroriaglez.com to be confirmed]</em>
          </div>
        </footer>
      </body>
    </html>
  );
}
