/** Typed errors shared by the backend, workflow engine, and API layer. */

export class NotConfiguredError extends Error {
  readonly integration: string;
  readonly missingKeys: string[];
  constructor(integration: string, missingKeys: string[]) {
    super(
      `${integration} is not configured: missing environment variable(s): ${missingKeys.join(", ")}. ` +
        "See docs/SETUP.md. Shield does not fabricate results for unconfigured integrations.",
    );
    this.name = "NotConfiguredError";
    this.integration = integration;
    this.missingKeys = missingKeys;
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "you do not have access to this resource") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class InsufficientShieldsError extends Error {
  readonly balance: number;
  readonly required: number;
  constructor(balance: number, required: number) {
    super(`insufficient Shields: balance is ${balance}, this action costs ${required}`);
    this.name = "InsufficientShieldsError";
    this.balance = balance;
    this.required = required;
  }
}

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`idempotency key ${key} was already used with a different payload`);
    this.name = "IdempotencyConflictError";
  }
}

export class SnapshotTooLargeError extends Error {
  constructor(files: number, bytes: number) {
    super(
      `snapshot too large for the MVP tiers: ${files} files / ${bytes} bytes ` +
        "(limits: 300 files and 2 MB of selected text). Nothing was uploaded or charged.",
    );
    this.name = "SnapshotTooLargeError";
  }
}

export class StageFailedError extends Error {
  readonly stage: string;
  constructor(stage: string, cause: string) {
    super(`analysis stage "${stage}" failed: ${cause}`);
    this.name = "StageFailedError";
    this.stage = stage;
  }
}

export class BudgetExceededError extends Error {
  constructor(stage: string, budgetUsd: number) {
    super(
      `analysis stage "${stage}" exceeded its cost budget of $${budgetUsd.toFixed(2)}. ` +
        "The scan was stopped instead of silently truncating results.",
    );
    this.name = "BudgetExceededError";
  }
}
