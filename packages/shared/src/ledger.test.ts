import { describe, expect, it } from "vitest";
import { InsufficientShieldsError } from "./errors.js";
import { ShieldLedger } from "./ledger.js";

describe("ShieldLedger", () => {
  it("grants and debits, deriving the balance", () => {
    const ledger = new ShieldLedger();
    ledger.grant({ userId: "u1", amount: 40, kind: "grant_subscription", idempotencyKey: "sub:u1:2026-10", expiresAt: "2026-11-01T00:00:00Z" });
    expect(ledger.balance("u1", new Date("2026-10-15"))).toBe(40);
    ledger.debit({ userId: "u1", amount: 5, idempotencyKey: "debit:u1:a", reference: "scan-action:full" });
    expect(ledger.balance("u1", new Date("2026-10-15"))).toBe(35);
  });

  it("never double-applies a replayed grant or debit (idempotency)", () => {
    const ledger = new ShieldLedger();
    const grant = { userId: "u1", amount: 15, kind: "grant_trial" as const, idempotencyKey: "trial:u1", expiresAt: null };
    ledger.grant(grant);
    ledger.grant(grant);
    ledger.grant(grant);
    expect(ledger.balance("u1")).toBe(15);
    const debit = { userId: "u1", amount: 5, idempotencyKey: "debit:u1:x", reference: "scan-action:full" };
    ledger.debit(debit);
    ledger.debit(debit);
    expect(ledger.balance("u1")).toBe(10);
    expect(ledger.history("u1")).toHaveLength(2);
  });

  it("rejects a debit beyond the balance", () => {
    const ledger = new ShieldLedger();
    ledger.grant({ userId: "u1", amount: 3, kind: "grant_pack", idempotencyKey: "pack:o1", expiresAt: null });
    expect(() =>
      ledger.debit({ userId: "u1", amount: 5, idempotencyKey: "debit:u1:y", reference: "scan-action:full" }),
    ).toThrow(InsufficientShieldsError);
    expect(ledger.balance("u1")).toBe(3);
  });

  it("expires subscription grants but never pack grants", () => {
    const ledger = new ShieldLedger();
    ledger.grant({ userId: "u1", amount: 40, kind: "grant_subscription", idempotencyKey: "sub:u1:2026-10", expiresAt: "2026-11-01T00:00:00Z" });
    ledger.grant({ userId: "u1", amount: 30, kind: "grant_pack", idempotencyKey: "pack:o2", expiresAt: null });
    expect(ledger.balance("u1", new Date("2026-10-20"))).toBe(70);
    expect(ledger.balance("u1", new Date("2026-11-05"))).toBe(30);
  });

  it("throws when an idempotency key is replayed with a different payload", () => {
    const ledger = new ShieldLedger();
    ledger.grant({ userId: "u1", amount: 10, kind: "grant_pack", idempotencyKey: "pack:o3", expiresAt: null });
    expect(() =>
      ledger.grant({ userId: "u1", amount: 99, kind: "grant_pack", idempotencyKey: "pack:o3", expiresAt: null }),
    ).toThrow(/different payload/);
  });

  it("keeps users isolated", () => {
    const ledger = new ShieldLedger();
    ledger.grant({ userId: "u1", amount: 10, kind: "grant_pack", idempotencyKey: "pack:o4", expiresAt: null });
    expect(ledger.balance("u2")).toBe(0);
  });
});
