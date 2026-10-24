import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProvider, StructuredResult, WorkflowStageName } from "./ai.js";
import { TsToolRunner } from "./checks.js";
import { sha256Hex } from "./fingerprint.js";
import { ShieldService } from "./services.js";

/**
 * Failure-path tests (PLAN_V2 §15, §16): partial failure is the normal
 * case. A scan that fails must say so; nothing may silently succeed.
 */

function seedScan(svc: ShieldService, userId: string, projectId: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  const files = [{ path: "src/index.ts", sha256: sha256Hex(bytes), size: bytes.length }];
  const { scanId } = svc.createScan(userId, {
    projectId,
    action: "full",
    files,
    idempotencyKey: `fp-${Math.random()}`,
  });
  svc.uploadFile(userId, scanId, {
    path: "src/index.ts",
    sha256: files[0]?.sha256 ?? "",
    contentBase64: bytes.toString("base64"),
  });
  return scanId;
}

describe("device code expiry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("poll returns expired after the 10-minute window", () => {
    const svc = new ShieldService();
    svc.createUser({ id: "u1", email: "u1@example.com" });
    const start = svc.startDeviceFlow();
    expect(svc.pollDevice(start.deviceCode).status).toBe("pending");
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(svc.pollDevice(start.deviceCode).status).toBe("expired");
  });
});

describe("analysis failure handling", () => {
  it("marks the scan failed (never completed) when a stage throws, with the reason recorded", async () => {
    const svc = new ShieldService();
    const user = svc.createUser({ id: "u1", email: "u1@example.com" });
    const project = svc.createProject(user.id, "app");
    const scanId = seedScan(svc, user.id, project.id, "export const x = 1;");
    svc.completeScan(user.id, scanId);
    const broken: AiProvider = {
      name: "broken",
      async generateStructured<T>(_stage: WorkflowStageName): Promise<StructuredResult<T>> {
        throw new Error("provider exploded");
      },
    };
    await svc.runAnalysis(scanId, { ai: broken, tools: new TsToolRunner(), budgetUsd: 0.25 });
    const view = svc.getScan(user.id, scanId);
    expect(view.status).toBe("failed");
    expect(view.error).toContain("understand");
  });

  it("a completed upload with zero findings is a successful empty scan, not a failure", async () => {
    const svc = new ShieldService();
    const user = svc.createUser({ id: "u1", email: "u1@example.com" });
    const project = svc.createProject(user.id, "clean");
    const scanId = seedScan(svc, user.id, project.id, "export const x = 1;");
    svc.completeScan(user.id, scanId);
    const { StubAiProvider } = await import("./stub-provider.js");
    const files = [{ path: "src/index.ts", content: "export const x = 1;" }];
    await svc.runAnalysis(scanId, {
      ai: new StubAiProvider({ files, evidence: [] }),
      tools: new TsToolRunner(),
      budgetUsd: 0.25,
    });
    expect(svc.getScan(user.id, scanId).status).toBe("completed");
    expect(svc.listFindings(user.id, project.id)).toEqual([]);
  });

  it("runAnalysis refuses scans that are not in analyzing state", async () => {
    const svc = new ShieldService();
    const user = svc.createUser({ id: "u1", email: "u1@example.com" });
    const project = svc.createProject(user.id, "app");
    const bytes = Buffer.from("x");
    const files = [{ path: "a.ts", sha256: sha256Hex(bytes), size: 1 }];
    const { scanId } = svc.createScan(user.id, {
      projectId: project.id,
      action: "quick",
      files,
      idempotencyKey: "fp-not-analyzing",
    });
    await expect(
      svc.runAnalysis(scanId, { ai: {} as AiProvider, tools: new TsToolRunner(), budgetUsd: 0.05 }),
    ).rejects.toThrow(/not analyzing/);
  });
});
