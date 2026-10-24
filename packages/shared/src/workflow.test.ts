import { describe, expect, it } from "vitest";
import type { AiProvider, StructuredResult, WorkflowStageName } from "./ai.js";
import { CompositeToolRunner, TsToolRunner } from "./checks.js";
import { NotConfiguredError, StageFailedError } from "./errors.js";
import type { DeterministicToolRunner } from "./checks.js";
import { StubAiProvider } from "./stub-provider.js";
import { runScanWorkflow } from "./workflow.js";
import type { Finding } from "./schemas.js";

const VULNERABLE_FILES = [
  {
    path: "app/api/orders/route.ts",
    content:
      "export async function GET(req: Request) { const id = new URL(req.url).searchParams.get('id'); return Response.json(await db.orders.find(id)); }",
  },
  { path: "src/config.ts", content: 'export const cfg = { debug: true };' },
];

const FIXED_FILES = [
  {
    path: "app/api/orders/route.ts",
    content:
      "export async function GET(req: Request) { const session = await auth(); if (!session) return new Response('unauthorized', { status: 401 }); const id = new URL(req.url).searchParams.get('id'); return Response.json(await db.orders.findForUser(id, session.userId)); }",
  },
  { path: "src/config.ts", content: "export const cfg = { debug: false };" },
];

async function runWith(files: typeof VULNERABLE_FILES, priorFindings: Finding[] = [], action: "full" | "quick" | "incremental" = "full") {
  const tools = new TsToolRunner();
  const evidence = (await tools.run(files)).evidence;
  const ai = new StubAiProvider({ files, evidence });
  return runScanWorkflow(
    { scanId: "scan-test", projectId: "proj-1", action, files, priorFindings },
    { ai, tools, budgetUsd: 0.25 },
  );
}

describe("runScanWorkflow (stub provider — pipeline mechanics)", () => {
  it("runs all 8 stages and produces evidence-backed findings with tasks", async () => {
    const result = await runWith(VULNERABLE_FILES);
    expect(result.stagesRun).toEqual([
      "1-understand-project",
      "2-gather-evidence",
      "3-identify-risks",
      "4-evaluate-findings",
      "5-explain-findings",
      "6-create-correction-plan",
      "7-verify-corrections",
      "8-record-results",
    ]);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    const routeFinding = result.findings.find((f) => f.cwe === "CWE-862");
    expect(routeFinding).toBeDefined();
    expect(routeFinding?.severity).toBe("High");
    expect(routeFinding?.filePath).toBe("app/api/orders/route.ts");
    expect(result.tasks.length).toBe(result.findings.length);
    expect(result.syntheticUsage).toBe(true); // stub usage is labeled synthetic
    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(result.totalCostUsd).toBeLessThanOrEqual(0.25);
  });

  it("verifies corrections on rescan: fixed findings flip to fixed_verified", async () => {
    const first = await runWith(VULNERABLE_FILES);
    const second = await runWith(FIXED_FILES, first.findings);
    const updates = new Map(second.verificationUpdates.map((u) => [u.findingId, u.status]));
    for (const prior of first.findings) {
      expect(updates.get(prior.id)).toBe("fixed_verified");
    }
    expect(second.findings).toHaveLength(0);
  });

  it("keeps still-present findings marked on rescan", async () => {
    const first = await runWith(VULNERABLE_FILES);
    const second = await runWith(VULNERABLE_FILES, first.findings);
    expect(second.findings.length).toBe(first.findings.length);
    for (const finding of second.findings) {
      expect(finding.verificationStatus).toBe("still_present");
    }
  });

  it("does not judge prior findings in files that were not rescanned", async () => {
    const first = await runWith(VULNERABLE_FILES);
    const partial = await runWith([FIXED_FILES[1] as (typeof FIXED_FILES)[number]], first.findings, "incremental");
    const routePrior = first.findings.find((f) => f.filePath.includes("route.ts"));
    expect(partial.verificationUpdates.find((u) => u.findingId === routePrior?.id)).toBeUndefined();
  });

  it("quick scans run deterministically with no AI stages", async () => {
    const result = await runWith(VULNERABLE_FILES, [], "quick");
    expect(result.stagesRun).not.toContain("1-understand-project");
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    expect(result.totalCostUsd).toBe(0);
  });

  it("verify action re-checks a single finding", async () => {
    const first = await runWith(VULNERABLE_FILES);
    const target = first.findings[0];
    if (!target) throw new Error("expected a finding");
    const tools = new TsToolRunner();
    const evidence = (await tools.run(FIXED_FILES)).evidence;
    const ai = new StubAiProvider({ files: FIXED_FILES, evidence });
    const result = await runScanWorkflow(
      { scanId: "scan-verify", projectId: "proj-1", action: "verify", files: FIXED_FILES, priorFindings: first.findings, verifyFindingId: target.id },
      { ai, tools, budgetUsd: 0.05 },
    );
    expect(result.verificationUpdates).toEqual([{ findingId: target.id, status: "fixed_verified" }]);
  });

  it("fails the stage (not the data) when the AI returns malformed output", async () => {
    const broken: AiProvider = {
      name: "broken",
      async generateStructured<T>(_stage: WorkflowStageName): Promise<StructuredResult<T>> {
        return { data: { nonsense: true } as T, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, synthetic: true } };
      },
    };
    const tools = new TsToolRunner();
    await expect(
      runScanWorkflow(
        { scanId: "s", projectId: "p", action: "full", files: VULNERABLE_FILES, priorFindings: [] },
        { ai: broken, tools, budgetUsd: 1 },
      ),
    ).rejects.toBeInstanceOf(StageFailedError);
  });

  it("stops instead of truncating when the budget is exceeded", async () => {
    const pricey: AiProvider = {
      name: "pricey",
      async generateStructured<T>(_stage: WorkflowStageName): Promise<StructuredResult<T>> {
        return { data: {} as T, usage: { inputTokens: 1, outputTokens: 1, costUsd: 10, synthetic: true } };
      },
    };
    const tools = new TsToolRunner();
    await expect(
      runScanWorkflow(
        { scanId: "s", projectId: "p", action: "full", files: VULNERABLE_FILES, priorFindings: [] },
        { ai: pricey, tools, budgetUsd: 0.25 },
      ),
    ).rejects.toThrow(/exceeded its cost budget/);
  });

  it("records unconfigured tools instead of fabricating their output", async () => {
    const unconfigured: DeterministicToolRunner = {
      name: "sandbox-tools",
      async run() {
        throw new NotConfiguredError("Vercel Sandbox", ["VERCEL_OIDC_TOKEN"]);
      },
    };
    const tools = new CompositeToolRunner([new TsToolRunner(), unconfigured]);
    const evidence = (await tools.run(VULNERABLE_FILES)).evidence;
    const ai = new StubAiProvider({ files: VULNERABLE_FILES, evidence });
    const result = await runScanWorkflow(
      { scanId: "s", projectId: "p", action: "full", files: VULNERABLE_FILES, priorFindings: [] },
      { ai, tools, budgetUsd: 0.25 },
    );
    expect(result.unavailableTools).toEqual(["sandbox-tools: not configured"]);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
  });
});
