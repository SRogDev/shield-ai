import { describe, expect, it } from "vitest";
import { ForbiddenError } from "./errors.js";
import { MCP_TOOLS, callMcpTool } from "./mcp.js";
import { ShieldService } from "./services.js";

function setup() {
  const svc = new ShieldService();
  const alice = svc.createUser({ id: "alice", email: "alice@example.com", planId: "builder" });
  const bob = svc.createUser({ id: "bob", email: "bob@example.com", planId: "builder" });
  const aliceProject = svc.createProject(alice.id, "alice-app");
  const bobProject = svc.createProject(bob.id, "bob-app");
  return { svc, alice, bob, aliceProject, bobProject };
}

describe("remote MCP tool surface (PLAN_V2 §12)", () => {
  it("exposes exactly the five read-only tools", () => {
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual([
      "get_finding",
      "get_verification_status",
      "list_findings",
      "list_projects",
      "list_remediation_tasks",
    ]);
  });

  it("lists only the caller's projects", () => {
    const { svc, alice, bob, aliceProject } = setup();
    const projects = callMcpTool(svc, alice.id, "list_projects", {}) as { id: string }[];
    expect(projects.map((p) => p.id)).toEqual([aliceProject.id]);
    expect(() => callMcpTool(svc, bob.id, "list_findings", { projectId: aliceProject.id })).toThrow(ForbiddenError);
  });

  it("rejects unknown tools (no hidden write surface)", () => {
    const { svc, alice } = setup();
    expect(() => callMcpTool(svc, alice.id, "delete_project", {})).toThrow(ForbiddenError);
    expect(() => callMcpTool(svc, alice.id, "start_scan", {})).toThrow(ForbiddenError);
  });

  it("validates tool input with Zod", () => {
    const { svc, alice } = setup();
    expect(() => callMcpTool(svc, alice.id, "list_findings", {})).toThrow();
    expect(() => callMcpTool(svc, alice.id, "get_finding", { findingId: 42 })).toThrow();
  });

  it("returns findings and verification status for the owner", () => {
    const { svc, alice, aliceProject } = setup();
    expect(callMcpTool(svc, alice.id, "list_findings", { projectId: aliceProject.id })).toEqual([]);
    expect(callMcpTool(svc, alice.id, "get_verification_status", { projectId: aliceProject.id })).toEqual([]);
    expect(callMcpTool(svc, alice.id, "list_remediation_tasks", { projectId: aliceProject.id })).toEqual([]);
  });
});
