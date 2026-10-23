import {
  assertConfigured,
  type DeterministicToolRunner,
  type EvidenceItem,
  type ServerEnv,
  type SourceFileInput,
  type ToolRunResult,
} from "@shield/shared";
import { Sandbox } from "@vercel/sandbox";

/**
 * Vercel Sandbox tool runner (PLAN_V2 §6.4): runs real Linux security
 * tools (gitleaks / semgrep class) against the snapshot inside an
 * ephemeral microVM, capped at ~3 minutes. Requires Vercel credentials
 * (VERCEL_OIDC_TOKEN); without them assertConfigured throws, which the
 * CompositeToolRunner records as "unavailable" — output is never faked.
 * Secret values from tool output are never copied into evidence.
 */
export class SandboxToolRunner implements DeterministicToolRunner {
  readonly name = "sandbox-tools";
  constructor(private readonly env: ServerEnv) {}

  async run(files: SourceFileInput[]): Promise<ToolRunResult> {
    assertConfigured(this.env, "vercel-sandbox");
    const evidence: EvidenceItem[] = [];
    const unavailableTools: string[] = [];
    const sandbox = await Sandbox.create({ timeout: 180_000 });
    try {
      await sandbox.writeFiles(
        files.map((f) => ({ path: f.path, content: Buffer.from(f.content, "utf8") })),
      );

      const gitleaks = await sandbox.runCommand({
        cmd: "bash",
        args: [
          "-lc",
          "if command -v gitleaks >/dev/null 2>&1; then gitleaks detect --no-git --source . --report-format json --report-path /tmp/gl.json >/dev/null 2>&1; cat /tmp/gl.json; else echo '__MISSING__'; fi",
        ],
      });
      const gitleaksOut = (await gitleaks.stdout()).trim();
      if (gitleaksOut === "__MISSING__" || gitleaksOut === "") {
        unavailableTools.push("gitleaks (not installed in sandbox image)");
      } else {
        try {
          const findings = JSON.parse(gitleaksOut) as {
            RuleID?: string;
            File?: string;
            StartLine?: number;
            Description?: string;
          }[];
          for (const f of findings) {
            evidence.push({
              checkId: `secret:gitleaks-${f.RuleID ?? "unknown"}`,
              filePath: f.File ?? "unknown",
              line: f.StartLine ?? 1,
              message: `gitleaks: ${f.Description ?? f.RuleID ?? "secret detected"} (value not recorded)`,
              pattern: `gitleaks rule ${f.RuleID ?? "unknown"}`,
              source: "sandbox-tool",
            });
          }
        } catch {
          unavailableTools.push("gitleaks (unparseable output)");
        }
      }

      const semgrep = await sandbox.runCommand({
        cmd: "bash",
        args: [
          "-lc",
          "if command -v semgrep >/dev/null 2>&1; then semgrep --config p/security-audit --json --quiet . 2>/dev/null; else echo '__MISSING__'; fi",
        ],
      });
      const semgrepOut = (await semgrep.stdout()).trim();
      if (semgrepOut === "__MISSING__" || semgrepOut === "") {
        unavailableTools.push("semgrep (not installed in sandbox image)");
      } else {
        try {
          const parsed = JSON.parse(semgrepOut) as {
            results?: {
              check_id?: string;
              path?: string;
              start?: { line?: number };
              extra?: { message?: string };
            }[];
          };
          for (const r of parsed.results ?? []) {
            evidence.push({
              checkId: `sandbox:semgrep-${r.check_id ?? "unknown"}`,
              filePath: r.path ?? "unknown",
              line: r.start?.line ?? 1,
              message: `semgrep: ${r.extra?.message ?? r.check_id ?? "finding"}`,
              pattern: `semgrep rule ${r.check_id ?? "unknown"}`,
              source: "sandbox-tool",
            });
          }
        } catch {
          unavailableTools.push("semgrep (unparseable output)");
        }
      }
    } finally {
      await sandbox.stop();
    }
    return { evidence, unavailableTools };
  }
}
