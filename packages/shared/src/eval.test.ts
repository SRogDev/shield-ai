import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type SourceFileInput, TsToolRunner } from "./checks.js";
import type { Finding } from "./schemas.js";
import { StubAiProvider } from "./stub-provider.js";
import { runScanWorkflow } from "./workflow.js";

/**
 * Evaluation harness (PLAN_V2 §16). Runs the REAL pipeline (deterministic
 * checks + 8-stage workflow) over the seeded fixtures in /eval with the
 * STUB provider. This measures pipeline mechanics: deterministic-stage
 * recall, false positives on the clean fixture, fingerprint verification
 * on the fixed twin, and synthetic cost accounting. It does NOT measure
 * real-model detection quality — that requires an AI Gateway key and is a
 * documented residual (docs/SETUP.md).
 */

const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "eval");

interface ExpectedManifest {
  fixtures: Record<
    string,
    { expectedCwes: string[]; minFindings: number; verifiesFixture?: string }
  >;
}

function loadFixture(name: string): SourceFileInput[] {
  const root = join(EVAL_DIR, name);
  const files: SourceFileInput[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        files.push({
          path: relative(root, full).replace(/\\/g, "/"),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(root);
  return files;
}

async function scanFixture(name: string, priorFindings: Finding[] = []) {
  const files = loadFixture(name);
  const tools = new TsToolRunner();
  const evidence = (await tools.run(files)).evidence;
  const ai = new StubAiProvider({ files, evidence });
  return runScanWorkflow(
    { scanId: `eval-${name}`, projectId: "eval-project", action: "full", files, priorFindings },
    { ai, tools, budgetUsd: 5 * 0.05 },
  );
}

const manifest = JSON.parse(
  readFileSync(join(EVAL_DIR, "expected.json"), "utf8"),
) as ExpectedManifest;

describe("eval: seeded fixtures (stub provider, pipeline mechanics)", () => {
  it("recalls every seeded CWE in the vulnerable fixture", async () => {
    const expected = manifest.fixtures["sample-ai-saas"];
    if (!expected) throw new Error("manifest missing sample-ai-saas");
    const result = await scanFixture("sample-ai-saas");
    const foundCwes = new Set(result.findings.map((f) => f.cwe));
    for (const cwe of expected.expectedCwes) {
      expect(foundCwes.has(cwe), `expected ${cwe} to be found`).toBe(true);
    }
    expect(result.findings.length).toBeGreaterThanOrEqual(expected.minFindings);
    // Cost accounting (synthetic, stub): a standard full scan must fit its
    // 5-Shield budget of $0.25.
    expect(result.syntheticUsage).toBe(true);
    expect(result.totalCostUsd).toBeLessThanOrEqual(0.25);
    console.log(
      `[eval] sample-ai-saas: ${result.findings.length} findings, synthetic cost $${result.totalCostUsd.toFixed(4)}, stages: ${result.stagesRun.length}`,
    );
  });

  it("produces zero findings (no false positives) on the clean fixture", async () => {
    const result = await scanFixture("sample-clean");
    expect(result.findings).toEqual([]);
  });

  it("verifies every seeded finding as fixed on the corrected twin", async () => {
    const vulnerable = await scanFixture("sample-ai-saas");
    const fixed = await scanFixture("sample-ai-saas-fixed", vulnerable.findings);
    expect(fixed.findings).toEqual([]);
    const updates = new Map(fixed.verificationUpdates.map((u) => [u.findingId, u.status]));
    for (const prior of vulnerable.findings) {
      expect(updates.get(prior.id), `finding ${prior.cwe} should verify as fixed`).toBe(
        "fixed_verified",
      );
    }
    console.log(
      `[eval] verification: ${vulnerable.findings.length}/${vulnerable.findings.length} seeded findings verified fixed`,
    );
  });
});
