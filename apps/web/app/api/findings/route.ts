import { errorResponse, json, requireUserId, serverEnv, service } from "@/lib/server";

export async function GET(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId");
    if (!projectId) return json({ error: "projectId is required" }, 400);
    const scanId = url.searchParams.get("scanId") ?? undefined;
    return json({
      findings: service().listFindings(userId, projectId, scanId),
      tasks: service().listTasks(userId, projectId),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
