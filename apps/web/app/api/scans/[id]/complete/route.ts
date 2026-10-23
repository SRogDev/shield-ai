import { errorResponse, json, requireUserId, serverEnv, service } from "@/lib/server";
import { startAnalysis } from "@/lib/analysis";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const { id } = await ctx.params;
    const result = service().completeScan(userId, id);
    if (result.missing.length > 0) {
      return json({ status: result.status, missing: result.missing }, 409);
    }
    await startAnalysis(id);
    return json({ status: service().getScan(userId, id).status });
  } catch (err) {
    return errorResponse(err);
  }
}
