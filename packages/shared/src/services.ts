import { randomBytes } from "node:crypto";
import { ForbiddenError, UnauthorizedError } from "./errors.js";
import { sha256Hex } from "./fingerprint.js";
import { ShieldLedger } from "./ledger.js";
import { PLANS, type PlanDefinition, costForAction } from "./plans.js";
import type {
  CreateScanRequest,
  Finding,
  Project,
  RemediationTask,
  ScanAction,
  ScanStatus,
  SnapshotFile,
  VerificationStatus,
} from "./schemas.js";
import { runScanWorkflow, type WorkflowDeps } from "./workflow.js";

/**
 * Service layer (PLAN_V2 §5, §7, §8.7). All backend authority lives here:
 * identity, project ownership, plan limits, Shield entitlement, upload
 * completion semantics. Storage is behind plain in-memory structures in
 * this build — the Supabase schema in supabase/migrations enforces the same
 * shapes and RLS in production; this store is the local/test runtime and
 * never writes uploaded contents to disk.
 *
 * Uploaded file CONTENTS are held in process memory only, attached to the
 * scan record while status is uploading/analyzing, and purged the moment
 * the scan reaches a terminal state.
 */

export type PlanId = PlanDefinition["id"];

export interface UserRecord {
  id: string;
  email: string;
  planId: PlanId;
}

interface DeviceCodeRecord {
  deviceCodeHash: string;
  userCode: string;
  status: "pending" | "approved" | "denied";
  userId: string | null;
  cliToken: string | null;
  expiresAt: number;
  intervalSec: number;
}

interface CliTokenRecord {
  userId: string;
  scope: string;
  revoked: boolean;
  createdAt: string;
}

export interface ScanRecord {
  id: string;
  ownerId: string;
  projectId: string;
  action: ScanAction;
  status: ScanStatus;
  costShields: number;
  manifest: SnapshotFile[];
  acked: Set<string>;
  /** TRANSIENT: in-memory only, purged at terminal state. Never persisted. */
  contents: Map<string, string>;
  error: string | null;
  createdAt: string;
  idempotencyKey: string;
  verifyFindingId: string | null;
}

const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomUserCode(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join("");
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${randomBytes(3).toString("hex")}`;
}

export class ShieldService {
  readonly ledger = new ShieldLedger();
  private users = new Map<string, UserRecord>();
  private projects = new Map<string, Project>();
  private repoLinks: { ownerId: string; projectId: string; repoName: string; remoteUrlHash: string | null }[] = [];
  private deviceCodes = new Map<string, DeviceCodeRecord>();
  private userCodes = new Map<string, string>(); // userCode -> deviceCodeHash
  private cliTokens = new Map<string, CliTokenRecord>(); // tokenHash -> record
  private scans = new Map<string, ScanRecord>();
  private scanIdempotency = new Map<string, string>(); // userId:key -> scanId
  private findings = new Map<string, Finding>();
  private tasks = new Map<string, RemediationTask>();
  private polarEvents = new Set<string>();

  /* --------------------------------- Users -------------------------------- */
  createUser(input: { id: string; email: string; planId?: PlanId }): UserRecord {
    const user: UserRecord = { id: input.id, email: input.email, planId: input.planId ?? "trial" };
    this.users.set(user.id, user);
    if (user.planId === "trial") {
      this.ledger.grant({
        userId: user.id,
        amount: PLANS.trial.shieldsPerPeriod,
        kind: "grant_trial",
        idempotencyKey: `trial:${user.id}`,
        expiresAt: null, // one-time trial grant; Shields are spent, not renewed
      });
    }
    return user;
  }

  getUser(id: string): UserRecord {
    const user = this.users.get(id);
    if (!user) throw new UnauthorizedError("unknown user");
    return user;
  }

  setPlan(userId: string, planId: PlanId): void {
    this.getUser(userId).planId = planId;
  }

  /* ------------------------------- Projects ------------------------------- */
  listProjects(userId: string) {
    const user = this.getUser(userId);
    const projects = [...this.projects.values()].filter((p) => p.ownerId === userId);
    return {
      projects,
      singleProject: PLANS[user.planId].maxProjects === 1,
      linkedRepos: this.repoLinks
        .filter((l) => l.ownerId === userId)
        .map((l) => ({ repoName: l.repoName, remoteUrlHash: l.remoteUrlHash, projectId: l.projectId })),
    };
  }

  createProject(userId: string, name: string): Project {
    const user = this.getUser(userId);
    const mine = [...this.projects.values()].filter((p) => p.ownerId === userId);
    if (mine.length >= PLANS[user.planId].maxProjects) {
      throw new ForbiddenError(
        `the ${PLANS[user.planId].name} plan allows ${PLANS[user.planId].maxProjects} project(s)`,
      );
    }
    const project: Project = {
      id: nextId("proj"),
      ownerId: userId,
      name,
      createdAt: new Date().toISOString(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  getOwnedProject(userId: string, projectId: string): Project {
    const project = this.projects.get(projectId);
    if (!project) throw new ForbiddenError("project not found");
    if (project.ownerId !== userId) throw new ForbiddenError("project belongs to another user");
    return project;
  }

  linkRepo(userId: string, projectId: string, repoName: string, remoteUrlHash: string | null): void {
    this.getOwnedProject(userId, projectId);
    const existing = this.repoLinks.findIndex(
      (l) => l.ownerId === userId && l.repoName === repoName && l.remoteUrlHash === remoteUrlHash,
    );
    const link = { ownerId: userId, projectId, repoName, remoteUrlHash };
    if (existing >= 0) this.repoLinks[existing] = link;
    else this.repoLinks.push(link);
  }

  deleteProject(userId: string, projectId: string): void {
    this.getOwnedProject(userId, projectId);
    this.projects.delete(projectId);
    this.repoLinks = this.repoLinks.filter((l) => l.projectId !== projectId);
    for (const scan of [...this.scans.values()]) {
      if (scan.projectId === projectId) this.scans.delete(scan.id);
    }
    for (const finding of [...this.findings.values()]) {
      if (finding.projectId === projectId) {
        this.findings.delete(finding.id);
        for (const task of [...this.tasks.values()]) {
          if (task.findingId === finding.id) this.tasks.delete(task.id);
        }
      }
    }
    // Ledger entries are billing records and are intentionally retained
    // (PLAN_V2 §10: deletion covers product records, not billing records).
  }

  /* ------------------------------ Device flow ----------------------------- */
  startDeviceFlow(): { deviceCode: string; userCode: string; expiresInSec: number; intervalSec: number } {
    const deviceCode = randomBytes(32).toString("hex");
    const userCode = randomUserCode();
    const record: DeviceCodeRecord = {
      deviceCodeHash: sha256Hex(deviceCode),
      userCode,
      status: "pending",
      userId: null,
      cliToken: null,
      expiresAt: Date.now() + 10 * 60 * 1000,
      intervalSec: 2,
    };
    this.deviceCodes.set(record.deviceCodeHash, record);
    this.userCodes.set(userCode, record.deviceCodeHash);
    return { deviceCode, userCode, expiresInSec: 600, intervalSec: record.intervalSec };
  }

  approveDevice(userId: string, userCode: string): void {
    this.getUser(userId);
    const hash = this.userCodes.get(userCode.toUpperCase());
    const record = hash ? this.deviceCodes.get(hash) : undefined;
    if (!record || record.expiresAt < Date.now()) throw new ForbiddenError("device code is invalid or expired");
    record.status = "approved";
    record.userId = userId;
    record.cliToken = this.issueCliToken(userId);
  }

  denyDevice(userCode: string): void {
    const hash = this.userCodes.get(userCode.toUpperCase());
    const record = hash ? this.deviceCodes.get(hash) : undefined;
    if (record) record.status = "denied";
  }

  pollDevice(deviceCode: string): { status: "pending" | "approved" | "denied" | "expired"; token?: string } {
    const record = this.deviceCodes.get(sha256Hex(deviceCode));
    if (!record || record.expiresAt < Date.now()) return { status: "expired" };
    if (record.status === "approved" && record.cliToken) {
      const token = record.cliToken;
      record.cliToken = null; // the raw token is handed out exactly once
      return { status: "approved", token };
    }
    return { status: record.status };
  }

  /* ------------------------------- CLI tokens ----------------------------- */
  issueCliToken(userId: string): string {
    const raw = `shld_${randomBytes(24).toString("hex")}`;
    this.cliTokens.set(sha256Hex(raw), {
      userId,
      scope: "cli",
      revoked: false,
      createdAt: new Date().toISOString(),
    });
    return raw;
  }

  userIdForToken(rawToken: string | null | undefined): string | null {
    if (!rawToken) return null;
    const record = this.cliTokens.get(sha256Hex(rawToken));
    if (!record || record.revoked) return null;
    return record.userId;
  }

  revokeToken(rawToken: string): void {
    const record = this.cliTokens.get(sha256Hex(rawToken));
    if (record) record.revoked = true;
  }

  /* --------------------------------- Scans -------------------------------- */
  createScan(userId: string, req: CreateScanRequest) {
    const idemKey = `${userId}:${req.idempotencyKey}`;
    const existingId = this.scanIdempotency.get(idemKey);
    if (existingId) {
      const existing = this.scans.get(existingId);
      if (existing) return this.scanView(existing);
    }
    const project = this.getOwnedProject(userId, req.projectId);
    const bytes = req.files.reduce((sum, f) => sum + f.size, 0);
    const cost = costForAction(req.action, { files: req.files.length, bytes });
    // Entitlement: debit is idempotent on the same key, so a retried
    // createScan can never double-charge (PLAN_V2 §7.3).
    this.ledger.debit({
      userId,
      amount: cost,
      idempotencyKey: `debit:${idemKey}`,
      reference: `scan-action:${req.action}`,
    });
    const scan: ScanRecord = {
      id: nextId("scan"),
      ownerId: userId,
      projectId: project.id,
      action: req.action,
      status: "uploading",
      costShields: cost,
      manifest: req.files,
      acked: new Set(),
      contents: new Map(),
      error: null,
      createdAt: new Date().toISOString(),
      idempotencyKey: req.idempotencyKey,
      verifyFindingId: req.findingId ?? null,
    };
    this.scans.set(scan.id, scan);
    this.scanIdempotency.set(idemKey, scan.id);
    return this.scanView(scan);
  }

  private scanView(scan: ScanRecord) {
    return {
      scanId: scan.id,
      costShields: scan.costShields,
      needed: scan.manifest.filter((f) => !scan.acked.has(f.path)).map((f) => f.path),
      status: scan.status,
    };
  }

  private getOwnedScan(userId: string, scanId: string): ScanRecord {
    const scan = this.scans.get(scanId);
    if (!scan) throw new ForbiddenError("scan not found");
    if (scan.ownerId !== userId) throw new ForbiddenError("scan belongs to another user");
    return scan;
  }

  uploadFile(userId: string, scanId: string, input: { path: string; sha256: string; contentBase64: string }): { acked: true } {
    const scan = this.getOwnedScan(userId, scanId);
    const manifestEntry = scan.manifest.find((f) => f.path === input.path);
    if (!manifestEntry) throw new ForbiddenError("file is not part of this scan's manifest");
    if (manifestEntry.sha256 !== input.sha256) {
      throw new ForbiddenError("declared sha256 does not match the scan manifest");
    }
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (sha256Hex(bytes) !== input.sha256) {
      throw new ForbiddenError("uploaded content does not match its declared sha256");
    }
    scan.contents.set(input.path, bytes.toString("utf8"));
    scan.acked.add(input.path);
    return { acked: true };
  }

  completeScan(userId: string, scanId: string): { status: ScanStatus; missing: string[] } {
    const scan = this.getOwnedScan(userId, scanId);
    const missing = scan.manifest.filter((f) => !scan.acked.has(f.path)).map((f) => f.path);
    if (missing.length > 0) return { status: scan.status, missing };
    if (scan.status === "uploading") scan.status = "analyzing";
    return { status: scan.status, missing: [] };
  }

  getScan(userId: string, scanId: string) {
    const scan = this.getOwnedScan(userId, scanId);
    return {
      id: scan.id,
      projectId: scan.projectId,
      action: scan.action,
      status: scan.status,
      costShields: scan.costShields,
      error: scan.error,
      createdAt: scan.createdAt,
    };
  }

  /**
   * Runs the workflow for a completed upload and records results
   * (stage 8). On any failure the scan is marked failed — never completed.
   */
  async runAnalysis(scanId: string, deps: WorkflowDeps): Promise<void> {
    const scan = this.scans.get(scanId);
    if (!scan) throw new ForbiddenError("scan not found");
    if (scan.status !== "analyzing") {
      throw new ForbiddenError(`scan is ${scan.status}, not analyzing`);
    }
    try {
      const priorFindings = [...this.findings.values()].filter(
        (f) => f.projectId === scan.projectId && f.verificationStatus !== "fixed_verified",
      );
      const result = await runScanWorkflow(
        {
          scanId: scan.id,
          projectId: scan.projectId,
          action: scan.action,
          files: scan.manifest.map((f) => ({
            path: f.path,
            content: scan.contents.get(f.path) ?? "",
          })),
          priorFindings,
          verifyFindingId: scan.verifyFindingId ?? undefined,
        },
        deps,
      );
      for (const finding of result.findings) this.findings.set(finding.id, finding);
      for (const task of result.tasks) this.tasks.set(task.id, task);
      for (const update of result.verificationUpdates) {
        const prior = this.findings.get(update.findingId);
        if (prior) prior.verificationStatus = update.status;
      }
      scan.status = "completed";
    } catch (err) {
      scan.status = "failed";
      scan.error = err instanceof Error ? err.message : String(err);
    } finally {
      scan.contents.clear(); // transient source is purged at terminal state
    }
  }

  /* -------------------------------- Findings ------------------------------ */
  listFindings(userId: string, projectId: string, scanId?: string): Finding[] {
    this.getOwnedProject(userId, projectId);
    return [...this.findings.values()].filter(
      (f) => f.projectId === projectId && (scanId === undefined || f.scanId === scanId),
    );
  }

  getFinding(userId: string, findingId: string): Finding {
    const finding = this.findings.get(findingId);
    if (!finding) throw new ForbiddenError("finding not found");
    this.getOwnedProject(userId, finding.projectId);
    return finding;
  }

  listTasks(userId: string, projectId: string): RemediationTask[] {
    this.getOwnedProject(userId, projectId);
    const projectFindingIds = new Set(
      [...this.findings.values()].filter((f) => f.projectId === projectId).map((f) => f.id),
    );
    return [...this.tasks.values()].filter((t) => projectFindingIds.has(t.findingId));
  }

  verificationStatus(userId: string, projectId: string): { findingId: string; status: VerificationStatus }[] {
    return this.listFindings(userId, projectId).map((f) => ({
      findingId: f.id,
      status: f.verificationStatus,
    }));
  }

  /* --------------------------------- Polar -------------------------------- */
  /** Returns true if the event was newly applied; false if it was a duplicate. */
  applySubscriptionGrant(userId: string, planId: PlanId, periodKey: string, periodEnd: string | null): boolean {
    const key = `sub:${userId}:${periodKey}`;
    const before = this.ledger.history(userId).length;
    this.setPlan(userId, planId);
    this.ledger.grant({
      userId,
      amount: PLANS[planId].shieldsPerPeriod,
      kind: "grant_subscription",
      idempotencyKey: key,
      expiresAt: periodEnd,
    });
    return this.ledger.history(userId).length > before;
  }

  applyPackGrant(userId: string, shields: number, orderId: string): boolean {
    const before = this.ledger.history(userId).length;
    this.ledger.grant({
      userId,
      amount: shields,
      kind: "grant_pack",
      idempotencyKey: `pack:${orderId}`,
      expiresAt: null,
    });
    return this.ledger.history(userId).length > before;
  }

  /** Webhook-level deduplication, independent of ledger idempotency. */
  markPolarEventProcessed(eventId: string): boolean {
    if (this.polarEvents.has(eventId)) return false;
    this.polarEvents.add(eventId);
    return true;
  }

  balance(userId: string): number {
    return this.ledger.balance(userId);
  }
}
