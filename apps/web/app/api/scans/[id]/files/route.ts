import { errorResponse, json, requireUserId, serverEnv, service } from "@/lib/server";
import { UploadFileRequestSchema } from "@shield/shared";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const { id } = await ctx.params;
    const body = UploadFileRequestSchema.parse(await req.json());
    return json(service().uploadFile(userId, id, body));
  } catch (err) {
    return errorResponse(err);
  }
}
