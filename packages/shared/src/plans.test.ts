import { describe, expect, it } from "vitest";
import { SnapshotTooLargeError } from "./errors.js";
import { PLANS, SHIELD_PACKS, budgetUsdForAction, costForAction } from "./plans.js";

describe("plan table (PLAN_V2 §3)", () => {
  it("matches the decided pricing", () => {
    expect(PLANS.trial.shieldsPerPeriod).toBe(15);
    expect(PLANS.trial.recurring).toBe(false);
    expect(PLANS.indie.priceUsdMonthly).toBe(9);
    expect(PLANS.indie.shieldsPerPeriod).toBe(40);
    expect(PLANS.indie.maxProjects).toBe(1);
    expect(PLANS.builder.priceUsdMonthly).toBe(19);
    expect(PLANS.builder.shieldsPerPeriod).toBe(100);
    expect(SHIELD_PACKS).toEqual([
      { id: "pack-30", shields: 30, priceUsd: 10 },
      { id: "pack-100", shields: 100, priceUsd: 29 },
    ]);
  });
});

describe("costForAction", () => {
  it("prices fixed actions", () => {
    expect(costForAction("quick", { files: 10, bytes: 1000 })).toBe(1);
    expect(costForAction("verify", { files: 1, bytes: 100 })).toBe(1);
    expect(costForAction("incremental", { files: 3, bytes: 3000 })).toBe(3);
  });

  it("prices full scans by snapshot tier", () => {
    expect(costForAction("full", { files: 100, bytes: 500 * 1024 })).toBe(5);
    expect(costForAction("full", { files: 101, bytes: 1000 })).toBe(12);
    expect(costForAction("full", { files: 50, bytes: 600 * 1024 })).toBe(12);
    expect(costForAction("full", { files: 300, bytes: 2 * 1024 * 1024 })).toBe(12);
  });

  it("rejects oversize snapshots instead of truncating", () => {
    expect(() => costForAction("full", { files: 301, bytes: 1000 })).toThrow(SnapshotTooLargeError);
    expect(() => costForAction("full", { files: 10, bytes: 3 * 1024 * 1024 })).toThrow(SnapshotTooLargeError);
  });

  it("derives the USD budget from the Shield budget (1 Shield ≈ $0.05)", () => {
    expect(budgetUsdForAction("full", { files: 10, bytes: 1000 })).toBeCloseTo(0.25);
    expect(budgetUsdForAction("quick", { files: 10, bytes: 1000 })).toBeCloseTo(0.05);
  });
});
