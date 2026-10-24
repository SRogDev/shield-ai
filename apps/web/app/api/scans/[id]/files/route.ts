import { UploadFileRequestSchema } from "@shield/shared";
import { errorResponse, json, requireUserId, service } from "@/lib/server";

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const { id } = await ctx.params;
    const body = UploadFileRequestSchema.parse(await req.json());
    return json(service().uploadFile(userId, id, body));
  } catch (err) {
    return errorResponse(err);
  }
}
