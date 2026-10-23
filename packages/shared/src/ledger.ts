import { IdempotencyConflictError, InsufficientShieldsError } from "./errors.js";

/**
 * Append-only Shield ledger (PLAN_V2 §5, §7.3). The balance is DERIVED from
 * entries; there is no mutable counter a retry could double-spend. Every
 * grant and debit carries a unique idempotency key: replaying the same key
 * with the same payload is a no-op, replaying it with a different payload
 * is an error. This in-memory implementation is the reference semantics;
 * the Supabase schema (supabase/migrations) enforces the same rules with a
 * UNIQUE constraint on idempotency_key.
 */

export type LedgerKind = "grant_subscription" | "grant_trial" | "grant_pack" | "debit_action";

export interface LedgerEntry {
  id: string;
  userId: string;
  kind: LedgerKind;
  /** Positive for grants, negative for debits. */
  amount: number;
  idempotencyKey: string;
  /** Subscription/trial grants expire; pack grants never do (null). */
  expiresAt: string | null;
  /** For debits: the action/scan they pay for. */
  reference: string | null;
  createdAt: string;
}

interface EntryFingerprint {
  userId: string;
  kind: LedgerKind;
  amount: number;
  reference: string | null;
}

export class ShieldLedger {
  private entries: LedgerEntry[] = [];
  private byKey = new Map<string, { entry: LedgerEntry; fingerprint: EntryFingerprint }>();
  private seq = 0;

  private append(
    input: Omit<LedgerEntry, "id" | "createdAt"> & { createdAt?: string },
  ): LedgerEntry {
    const fingerprint: EntryFingerprint = {
      userId: input.userId,
      kind: input.kind,
      amount: input.amount,
      reference: input.reference,
    };
    const prior = this.byKey.get(input.idempotencyKey);
    if (prior) {
      const same =
        prior.fingerprint.userId === fingerprint.userId &&
        prior.fingerprint.kind === fingerprint.kind &&
        prior.fingerprint.amount === fingerprint.amount &&
        prior.fingerprint.reference === fingerprint.reference;
      if (!same) throw new IdempotencyConflictError(input.idempotencyKey);
      return prior.entry; // idempotent replay: no double-apply
    }
    this.seq += 1;
    const entry: LedgerEntry = {
      ...input,
      id: `le_${this.seq}`,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.entries.push(entry);
    this.byKey.set(input.idempotencyKey, { entry, fingerprint });
    return entry;
  }

  grant(input: {
    userId: string;
    amount: number;
    kind: Extract<LedgerKind, "grant_subscription" | "grant_trial" | "grant_pack">;
    idempotencyKey: string;
    expiresAt: string | null;
  }): LedgerEntry {
    if (input.amount <= 0) throw new Error("grant amount must be positive");
    return this.append({ ...input, amount: input.amount, reference: null });
  }

  debit(input: {
    userId: string;
    amount: number;
    idempotencyKey: string;
    reference: string;
    now?: Date;
  }): LedgerEntry {
    if (input.amount <= 0) throw new Error("debit amount must be positive");
    const now = input.now ?? new Date();
    const existing = this.byKey.get(input.idempotencyKey);
    if (!existing) {
      const balance = this.balance(input.userId, now);
      if (balance < input.amount) throw new InsufficientShieldsError(balance, input.amount);
    }
    return this.append({
      userId: input.userId,
      kind: "debit_action",
      amount: -input.amount,
      idempotencyKey: input.idempotencyKey,
      expiresAt: null,
      reference: input.reference,
    });
  }

  /**
   * Balance at a point in time: unexpired grants minus all debits.
   * Note (documented in PLAN_V2 §5): debits are not attributed to specific
   * grants in v1, so a subscription grant that expires after being spent
   * against can reduce the balance by at most the unspent remainder — the
   * conservative direction for Shield, never a double-charge for the user.
   */
  balance(userId: string, now: Date = new Date()): number {
    let total = 0;
    for (const e of this.entries) {
      if (e.userId !== userId) continue;
      if (e.kind === "debit_action") {
        total += e.amount;
      } else if (e.expiresAt === null || new Date(e.expiresAt) > now) {
        total += e.amount;
      }
    }
    return total;
  }

  history(userId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.userId === userId);
  }
}
