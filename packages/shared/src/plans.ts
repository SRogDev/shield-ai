import { SnapshotTooLargeError } from "./errors.js";
import type { ScanAction } from "./schemas.js";

/**
 * Commercial configuration (PLAN_V2 §3). This table is the ONLY place plan
 * numbers live; UI, API, and CLI preview all derive from it (the CLI mirrors
 * the snapshot tiers in Rust, PLAN_V2 §8.6).
 */

export interface PlanDefinition {
  id: "trial" | "indie" | "builder";
  name: string;
  priceUsdMonthly: number;
  shieldsPerPeriod: number;
  /** Grants repeat monthly; the trial grant is one-time. */
  recurring: boolean;
  maxProjects: number;
}

export const PLANS: Record<PlanDefinition["id"], PlanDefinition> = {
  trial: {
    id: "trial",
    name: "Free trial",
    priceUsdMonthly: 0,
    shieldsPerPeriod: 15,
    recurring: false,
    maxProjects: 1,
  },
  indie: {
    id: "indie",
    name: "Indie",
    priceUsdMonthly: 9,
    shieldsPerPeriod: 40,
    recurring: true,
    maxProjects: 1,
  },
  builder: {
    id: "builder",
    name: "Builder",
    priceUsdMonthly: 19,
    shieldsPerPeriod: 100,
    recurring: true,
    maxProjects: Number.POSITIVE_INFINITY,
  },
};

export interface ShieldPack {
  id: string;
  shields: number;
  priceUsd: number;
}

export const SHIELD_PACKS: ShieldPack[] = [
  { id: "pack-30", shields: 30, priceUsd: 10 },
  { id: "pack-100", shields: 100, priceUsd: 29 },
];

/** Internal planning budget: 1 Shield may cost at most ~$0.05 real COGS. */
export const SHIELD_MAX_COGS_USD = 0.05;

/** Fixed Shield costs for actions that do not depend on snapshot size. */
export const FIXED_ACTION_COSTS: Partial<Record<ScanAction, number>> = {
  quick: 1,
  verify: 1,
  incremental: 3,
};

/** Snapshot tiers for full scans (PLAN_V2 §3). */
export const FULL_TIERS = [
  { maxFiles: 100, maxBytes: 500 * 1024, cost: 5 },
  { maxFiles: 300, maxBytes: 2 * 1024 * 1024, cost: 12 },
] as const;

export const MAX_SNAPSHOT_FILES = 300;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/**
 * Shield cost of an action, known BEFORE execution (shown in CLI preview
 * and web UI). Throws SnapshotTooLargeError for oversize full scans.
 */
export function costForAction(
  action: ScanAction,
  snapshot: { files: number; bytes: number },
): number {
  if (action !== "full") {
    const fixed = FIXED_ACTION_COSTS[action];
    if (fixed === undefined) throw new Error(`no fixed cost configured for action ${action}`);
    return fixed;
  }
  for (const tier of FULL_TIERS) {
    if (snapshot.files <= tier.maxFiles && snapshot.bytes <= tier.maxBytes) return tier.cost;
  }
  throw new SnapshotTooLargeError(snapshot.files, snapshot.bytes);
}

/** Token/cost budget (USD) an action may spend across AI stages. */
export function budgetUsdForAction(
  action: ScanAction,
  snapshot: { files: number; bytes: number },
): number {
  return costForAction(action, snapshot) * SHIELD_MAX_COGS_USD;
}
