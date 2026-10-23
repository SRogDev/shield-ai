import type { z } from "zod";
import type { AiProvider, StageUsage, StructuredResult, WorkflowStageName } from "./ai.js";
import { MODEL_CONFIG } from "./ai.js";
import type { SourceFileInput } from "./checks.js";
import type {
  CandidateFinding,
  EvaluatedFinding,
  EvidenceItem,
  ExplainedFinding,
  ProjectUnderstanding,
  Severity,
} from "./schemas.js";

/**
 * STUB AI provider — deterministic, $0, no network. It exists so the whole
 * pipeline (workflow stages, Zod validation, budgets, verification) can be
 * tested and demonstrated locally. Its outputs are mechanical derivations
 * from deterministic evidence, NOT model judgments. Every usage figure it
 * reports is flagged `synthetic: true`. Never present stub results as AI
 * analysis quality.
 */

export interface StubContext {
  files: SourceFileInput[];
  evidence: EvidenceItem[];
}

const CHECK_META: Record<
  string,
  { cwe: string; owasp: string[]; title: string; severity: Severity }
> = {
  "secret:private-key-block": {
    cwe: "CWE-798",
    owasp: ["LLM02:2025 Sensitive Information Disclosure"],
    title: "Private key committed to source",
    severity: "Critical",
  },
  "secret:aws-access-key": {
    cwe: "CWE-798",
    owasp: ["LLM02:2025 Sensitive Information Disclosure"],
    title: "AWS access key in source",
    severity: "High",
  },
  "secret:jwt-token": {
    cwe: "CWE-798",
    owasp: ["LLM02:2025 Sensitive Information Disclosure"],
    title: "Hardcoded JWT in source",
    severity: "High",
  },
  "secret:generic-secret-assignment": {
    cwe: "CWE-798",
    owasp: ["LLM02:2025 Sensitive Information Disclosure"],
    title: "Hardcoded secret in source",
    severity: "High",
  },
  "config:cors-wildcard": {
    cwe: "CWE-942",
    owasp: ["A05:2025 Security Misconfiguration"],
    title: "CORS allows any origin",
    severity: "Medium",
  },
  "config:tls-verification-disabled": {
    cwe: "CWE-295",
    owasp: ["A02:2025 Cryptographic Failures"],
    title: "TLS certificate verification disabled",
    severity: "High",
  },
  "config:debug-enabled": {
    cwe: "CWE-489",
    owasp: ["A05:2025 Security Misconfiguration"],
    title: "Debug mode enabled",
    severity: "Low",
  },
  "ast:missing-auth-check": {
    cwe: "CWE-862",
    owasp: ["A01:2025 Broken Access Control"],
    title: "Route handler without an authentication check",
    severity: "High",
  },
};

function metaFor(evidence: EvidenceItem): {
  cwe: string;
  owasp: string[];
  title: string;
  severity: Severity;
} {
  const exact = CHECK_META[evidence.checkId];
  if (exact) return exact;
  if (evidence.checkId.startsWith("dependency:")) {
    return {
      cwe: "CWE-1395",
      owasp: ["A03:2025 Software Supply Chain Failures"],
      title: "Known-vulnerable dependency",
      severity: "Medium",
    };
  }
  return {
    cwe: "CWE-20",
    owasp: ["A05:2025 Security Misconfiguration"],
    title: evidence.message,
    severity: "Low",
  };
}

/** Mechanical evidence → candidate conversion (also used for `quick` scans). */
export function deterministicCandidates(evidence: EvidenceItem[]): CandidateFinding[] {
  return evidence.map((e) => {
    const meta = metaFor(e);
    return {
      title: meta.title,
      cwe: meta.cwe,
      owasp: meta.owasp,
      filePath: e.filePath,
      lineStart: e.line,
      lineEnd: e.line,
      evidence: e.message,
      pattern: e.pattern,
      routeIdentity: e.filePath,
    };
  });
}

export function deterministicSeverity(evidence: EvidenceItem): Severity {
  return metaFor(evidence).severity;
}

const GUIDANCE: Record<string, string> = {
  secret:
    "Remove the secret from source, rotate it immediately (assume it is compromised), and load it from a server-side environment variable or secret manager. Add the file pattern to .gitignore if it is a local env file.",
  config:
    "Tighten the configuration to the least permissive value that keeps the feature working (explicit origin allowlist / TLS verification on / debug off outside development) and add a regression test for it.",
  ast: "Add the project's standard session check at the top of the handler and verify resource ownership before reading or mutating data. Add a test that an unauthenticated request is rejected.",
  dependency:
    "Upgrade the dependency to a fixed version (or replace it), regenerate the lockfile, and re-run this scan to verify the vulnerable version is gone.",
};

function guidanceFor(checkId: string): string {
  if (checkId.startsWith("secret:")) return GUIDANCE.secret ?? "";
  if (checkId.startsWith("config:")) return GUIDANCE.config ?? "";
  if (checkId.startsWith("ast:")) return GUIDANCE.ast ?? "";
  if (checkId.startsWith("dependency:")) return GUIDANCE.dependency ?? "";
  return "Review the flagged code, apply the minimal fix that removes the pattern, and re-scan to verify.";
}

export class StubAiProvider implements AiProvider {
  readonly name = "stub";
  constructor(private readonly ctx: StubContext) {}

  private usage(stage: WorkflowStageName, prompt: string): StageUsage {
    const config = MODEL_CONFIG[stage];
    const inputTokens = Math.max(1, Math.round(prompt.length / 4));
    const outputTokens = 200;
    return {
      inputTokens,
      outputTokens,
      costUsd:
        (inputTokens / 1_000_000) * config.inputUsdPerMillion +
        (outputTokens / 1_000_000) * config.outputUsdPerMillion,
      synthetic: true,
    };
  }

  async generateStructured<T>(
    stage: WorkflowStageName,
    _schema: z.ZodType<T>,
    prompt: string,
  ): Promise<StructuredResult<T>> {
    const usage = this.usage(stage, prompt);
    let data: unknown;
    switch (stage) {
      case "understand": {
        const extensions = new Set(this.ctx.files.map((f) => f.path.split(".").pop() ?? ""));
        const allText = this.ctx.files.map((f) => f.content).join("\n");
        const understanding: ProjectUnderstanding = {
          summary: `[stub] Project with ${this.ctx.files.length} analyzed files.`,
          languages: [...extensions].filter((e) => e.length <= 5).sort(),
          frameworks: [
            ...(allText.includes("next") ? ["Next.js"] : []),
            ...(allText.includes("react") ? ["React"] : []),
            ...(allText.includes("express") ? ["Express"] : []),
          ],
          trustBoundaries: ["HTTP API boundary"],
          aiFeatures: /(openai|anthropic|generateText|@ai-sdk|langchain)/i.test(allText)
            ? ["LLM calls detected in source"]
            : [],
        };
        data = understanding;
        break;
      }
      case "identify": {
        data = { candidates: deterministicCandidates(this.ctx.evidence) };
        break;
      }
      case "evaluate": {
        const candidates = deterministicCandidates(this.ctx.evidence);
        const evaluated: EvaluatedFinding[] = candidates.map((c, i) => {
          const evidence = this.ctx.evidence[i];
          return {
            ...c,
            valid: true,
            severity: evidence ? deterministicSeverity(evidence) : "Low",
            confidence: "Medium" as const,
            impact: `[stub] Impact derived mechanically from check ${evidence?.checkId ?? "unknown"}; a real model evaluation is required for production severity judgment.`,
          };
        });
        data = { evaluated };
        break;
      }
      case "explain": {
        const candidates = deterministicCandidates(this.ctx.evidence);
        const explained: ExplainedFinding[] = candidates.map((c, i) => {
          const evidence = this.ctx.evidence[i];
          return {
            ...c,
            valid: true,
            severity: evidence ? deterministicSeverity(evidence) : "Low",
            confidence: "Medium" as const,
            impact: `[stub] See check ${evidence?.checkId ?? "unknown"}.`,
            description: `${c.title} in ${c.filePath} (line ${c.lineStart}): ${c.evidence}`,
          };
        });
        data = { explained };
        break;
      }
      case "plan": {
        const candidates = deterministicCandidates(this.ctx.evidence);
        data = {
          tasks: candidates.map((c, i) => ({
            candidateIndex: i,
            title: `Fix: ${c.title}`,
            guidance: guidanceFor(this.ctx.evidence[i]?.checkId ?? ""),
          })),
        };
        break;
      }
    }
    return { data: data as T, usage };
  }
}
