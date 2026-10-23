import type { z } from "zod";
import { ForbiddenError } from "./errors.js";
import {
  McpGetFindingInputSchema,
  McpListFindingsInputSchema,
  McpListProjectsInputSchema,
  McpListTasksInputSchema,
  McpVerificationInputSchema,
} from "./schemas.js";
import type { ShieldService } from "./services.js";

/**
 * Remote MCP tool surface (PLAN_V2 §12). Read-only by construction: the
 * registry contains exactly the five tools below and no write operation
 * exists. Every handler is scoped to the authenticated user id resolved
 * from the bearer token by the transport layer (apps/web) — a token can
 * only ever see its owner's projects.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType<unknown>;
  handler: (service: ShieldService, userId: string, input: unknown) => unknown;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_projects",
    description: "List the authenticated user's Shield projects.",
    inputSchema: McpListProjectsInputSchema,
    handler: (service, userId) => service.listProjects(userId).projects,
  },
  {
    name: "list_findings",
    description: "List findings (with severity and confidence) for a project, optionally one scan.",
    inputSchema: McpListFindingsInputSchema,
    handler: (service, userId, input) => {
      const parsed = McpListFindingsInputSchema.parse(input);
      return service.listFindings(userId, parsed.projectId, parsed.scanId);
    },
  },
  {
    name: "get_finding",
    description: "Get one finding with its evidence and impact.",
    inputSchema: McpGetFindingInputSchema,
    handler: (service, userId, input) => {
      const parsed = McpGetFindingInputSchema.parse(input);
      return service.getFinding(userId, parsed.findingId);
    },
  },
  {
    name: "list_remediation_tasks",
    description: "List outstanding remediation tasks for a project.",
    inputSchema: McpListTasksInputSchema,
    handler: (service, userId, input) => {
      const parsed = McpListTasksInputSchema.parse(input);
      return service.listTasks(userId, parsed.projectId);
    },
  },
  {
    name: "get_verification_status",
    description: "Verification status of all findings in a project across scans.",
    inputSchema: McpVerificationInputSchema,
    handler: (service, userId, input) => {
      const parsed = McpVerificationInputSchema.parse(input);
      return service.verificationStatus(userId, parsed.projectId);
    },
  },
];

export function callMcpTool(
  service: ShieldService,
  userId: string,
  toolName: string,
  input: unknown,
): unknown {
  const tool = MCP_TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new ForbiddenError(`unknown MCP tool: ${toolName}`);
  tool.inputSchema.parse(input);
  return tool.handler(service, userId, input);
}
