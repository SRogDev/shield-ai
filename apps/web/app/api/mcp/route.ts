import { MCP_TOOLS, UnauthorizedError, callMcpTool } from "@shield/shared";
import { z } from "zod";
import { errorResponse, json, requireUserId, service } from "@/lib/server";

/**
 * Remote MCP server (PLAN_V2 §12): Streamable-HTTP-style JSON-RPC endpoint.
 * Auth: the same scoped bearer tokens as the CLI (device-flow issued).
 * Read-only: the tool registry contains no write operations, and this
 * endpoint never starts a billable analysis.
 */
const JsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

function rpcResult(id: string | number | undefined, result: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: string | number | undefined, message: string, code = -32000): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = JsonRpcRequest.parse(await req.json());
    if (body.method === "initialize") {
      return rpcResult(body.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "shield-ai", version: "0.1.0" },
      });
    }
    if (body.method === "notifications/initialized" || body.method === "ping") {
      return rpcResult(body.id, {});
    }
    const userId = await requireUserId(req);
    if (body.method === "tools/list") {
      return rpcResult(body.id, {
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.inputSchema),
        })),
      });
    }
    if (body.method === "tools/call") {
      const params = z.object({ name: z.string(), arguments: z.unknown().optional() }).parse(body.params);
      const result = callMcpTool(service(), userId, params.name, params.arguments ?? {});
      return rpcResult(body.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    }
    return rpcError(body.id, `method not found: ${body.method}`, -32601);
  } catch (err) {
    if (err instanceof UnauthorizedError) return errorResponse(err);
    return errorResponse(err);
  }
}

export async function GET(): Promise<Response> {
  return json({ error: "this MCP endpoint accepts POST (Streamable HTTP transport)" }, 405);
}
