import { describe, expect, it } from "vitest";
import { ForbiddenError, InsufficientShieldsError } from "./errors.js";
import { sha256Hex } from "./fingerprint.js";
import { ShieldService } from "./services.js";

function makeService() {
  const svc = new ShieldService();
  const user = svc.createUser({ id: "user-1", email: "a@example.com" }); // trial: 15 Shields, 1 project
  const other = svc.createUser({ id: "user-2", email: "b@example.com", planId: "builder" });
  return { svc, user, other };
}

function manifestFor(content: string, path = "src/index.ts") {
  const bytes = Buffer.from(content, "utf8");
  return [{ path, sha256: sha256Hex(bytes), size: bytes.length }];
}

describe("projects and plan limits", () => {
  it("trial user gets 15 one-time Shields", () => {
    const { svc, user } = makeService();
    expect(svc.balance(user.id)).toBe(15);
  });

  it("single-project plans cannot create a second project", () => {
    const { svc, user } = makeService();
    svc.createProject(user.id, "one");
    expect(() => svc.createProject(user.id, "two")).toThrow(ForbiddenError);
    expect(svc.listProjects(user.id).singleProject).toBe(true);
  });

  it("builder can create multiple projects", () => {
    const { svc, other } = makeService();
    svc.createProject(other.id, "one");
    svc.createProject(other.id, "two");
    expect(svc.listProjects(other.id).projects).toHaveLength(2);
    expect(svc.listProjects(other.id).singleProject).toBe(false);
  });

  it("repo links persist and are owner-scoped", () => {
    const { svc, user, other } = makeService();
    const project = svc.createProject(user.id, "app");
    svc.linkRepo(user.id, project.id, "app", "abc123");
    expect(svc.listProjects(user.id).linkedRepos).toEqual([
      { repoName: "app", remoteUrlHash: "abc123", projectId: project.id },
    ]);
    expect(svc.listProjects(other.id).linkedRepos).toEqual([]);
  });
});

describe("device flow", () => {
  it("runs start → approve → poll(approved, token once)", () => {
    const { svc, user } = makeService();
    const start = svc.startDeviceFlow();
    expect(svc.pollDevice(start.deviceCode).status).toBe("pending");
    svc.approveDevice(user.id, start.userCode);
    const approved = svc.pollDevice(start.deviceCode);
    expect(approved.status).toBe("approved");
    expect(approved.token).toMatch(/^shld_/);
    // Token is handed out exactly once.
    expect(svc.pollDevice(start.deviceCode).token).toBeUndefined();
    // And it authenticates its owner.
    expect(svc.userIdForToken(approved.token)).toBe(user.id);
  });

  it("supports denial and revocation (logout)", () => {
    const { svc, user } = makeService();
    const start = svc.startDeviceFlow();
    svc.denyDevice(start.userCode);
    expect(svc.pollDevice(start.deviceCode).status).toBe("denied");
    const token = svc.issueCliToken(user.id);
    expect(svc.userIdForToken(token)).toBe(user.id);
    svc.revokeToken(token);
    expect(svc.userIdForToken(token)).toBeNull();
  });

  it("rejects approval of an unknown code", () => {
    const { svc, user } = makeService();
    expect(() => svc.approveDevice(user.id, "ZZZZZZZZ")).toThrow(ForbiddenError);
  });
});

describe("scan lifecycle and entitlement", () => {
  it("charges the Shield cost once, even when createScan is retried", () => {
    const { svc, user } = makeService();
    const project = svc.createProject(user.id, "app");
    const files = manifestFor("export const x = 1;");
    const req = {
      projectId: project.id,
      action: "full" as const,
      files,
      idempotencyKey: "req-0001-abcd",
    };
    const first = svc.createScan(user.id, req);
    const second = svc.createScan(user.id, req);
    expect(second.scanId).toBe(first.scanId);
    expect(first.costShields).toBe(5);
    expect(svc.balance(user.id)).toBe(10); // 15 - 5, not 15 - 10
  });

  it("blocks scans the balance cannot pay for", () => {
    const { svc, user } = makeService();
    const project = svc.createProject(user.id, "app");
    const big = Array.from({ length: 150 }, (_, i) => ({
      path: `src/f${i}.ts`,
      sha256: sha256Hex(`content-${i}`),
      size: 100,
    }));
    expect(() =>
      svc.createScan(user.id, {
        projectId: project.id,
        action: "full",
        files: big,
        idempotencyKey: "req-big-0001",
      }),
    ).not.toThrow(); // 12 Shields, balance 15: allowed
    expect(() =>
      svc.createScan(user.id, {
        projectId: project.id,
        action: "full",
        files: big,
        idempotencyKey: "req-big-0002",
      }),
    ).toThrow(InsufficientShieldsError);
  });

  it("enforces project ownership on every path", () => {
    const { svc, user, other } = makeService();
    const project = svc.createProject(user.id, "app");
    expect(() =>
      svc.createScan(other.id, {
        projectId: project.id,
        action: "quick",
        files: manifestFor("x"),
        idempotencyKey: "req-other-01",
      }),
    ).toThrow(ForbiddenError);
    expect(() => svc.listFindings(other.id, project.id)).toThrow(ForbiddenError);
  });

  it("upload → complete only when every file is acknowledged", () => {
    const { svc, user } = makeService();
    const project = svc.createProject(user.id, "app");
    const c1 = "export const a = 1;";
    const c2 = "export const b = 2;";
    const files = [...manifestFor(c1, "src/a.ts"), ...manifestFor(c2, "src/b.ts")];
    const { scanId } = svc.createScan(user.id, {
      projectId: project.id,
      action: "full",
      files,
      idempotencyKey: "req-upload-1",
    });
    svc.uploadFile(user.id, scanId, {
      path: "src/a.ts",
      sha256: files[0]?.sha256 ?? "",
      contentBase64: Buffer.from(c1).toString("base64"),
    });
    const partial = svc.completeScan(user.id, scanId);
    expect(partial.status).toBe("uploading");
    expect(partial.missing).toEqual(["src/b.ts"]);
    svc.uploadFile(user.id, scanId, {
      path: "src/b.ts",
      sha256: files[1]?.sha256 ?? "",
      contentBase64: Buffer.from(c2).toString("base64"),
    });
    const done = svc.completeScan(user.id, scanId);
    expect(done.status).toBe("analyzing");
    expect(done.missing).toEqual([]);
  });

  it("rejects uploads whose bytes do not match the declared hash", () => {
    const { svc, user } = makeService();
    const project = svc.createProject(user.id, "app");
    const files = manifestFor("real content");
    const { scanId } = svc.createScan(user.id, {
      projectId: project.id,
      action: "quick",
      files,
      idempotencyKey: "req-upload-2",
    });
    expect(() =>
      svc.uploadFile(user.id, scanId, {
        path: "src/index.ts",
        sha256: files[0]?.sha256 ?? "",
        contentBase64: Buffer.from("tampered content").toString("base64"),
      }),
    ).toThrow(ForbiddenError);
  });

  it("re-uploading the same file is idempotent", () => {
    const { svc, user } = makeService();
    const project = svc.createProject(user.id, "app");
    const content = "export const a = 1;";
    const files = manifestFor(content);
    const { scanId } = svc.createScan(user.id, {
      projectId: project.id,
      action: "quick",
      files,
      idempotencyKey: "req-upload-3",
    });
    const upload = {
      path: "src/index.ts",
      sha256: files[0]?.sha256 ?? "",
      contentBase64: Buffer.from(content).toString("base64"),
    };
    expect(svc.uploadFile(user.id, scanId, upload)).toEqual({ acked: true });
    expect(svc.uploadFile(user.id, scanId, upload)).toEqual({ acked: true });
  });
});

describe("polar grants", () => {
  it("applies a subscription grant once per period", () => {
    const { svc, user } = makeService();
    expect(svc.applySubscriptionGrant(user.id, "indie", "2026-10", "2026-11-23T00:00:00Z")).toBe(
      true,
    );
    expect(svc.applySubscriptionGrant(user.id, "indie", "2026-10", "2026-11-23T00:00:00Z")).toBe(
      false,
    );
    expect(svc.balance(user.id)).toBe(15 + 40);
  });

  it("pack grants never expire and apply once per order", () => {
    const { svc, user } = makeService();
    expect(svc.applyPackGrant(user.id, 30, "order-1")).toBe(true);
    expect(svc.applyPackGrant(user.id, 30, "order-1")).toBe(false);
    expect(svc.balance(user.id)).toBe(45);
    expect(svc.ledger.balance(user.id, new Date("2030-01-01"))).toBe(45);
  });

  it("webhook event ids deduplicate", () => {
    const { svc } = makeService();
    expect(svc.markPolarEventProcessed("evt-1")).toBe(true);
    expect(svc.markPolarEventProcessed("evt-1")).toBe(false);
  });
});

describe("project deletion", () => {
  it("removes project data but retains billing ledger records", () => {
    const { svc, user } = makeService();
    const project = svc.createProject(user.id, "app");
    svc.deleteProject(user.id, project.id);
    expect(svc.listProjects(user.id).projects).toHaveLength(0);
    expect(svc.balance(user.id)).toBe(15); // trial grant is a billing record
    expect(() => svc.deleteProject(user.id, project.id)).toThrow(ForbiddenError);
  });
});
