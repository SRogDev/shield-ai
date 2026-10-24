import { errorResponse, json, requireUserId, serverEnv, service } from "@/lib/server";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const { id } = await ctx.params;
    return json(service().getScan(userId, id));
  } catch (err) {
    return errorResponse(err);
  }
}
