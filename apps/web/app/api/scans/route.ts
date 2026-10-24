import { CreateScanRequestSchema } from "@shield/shared";
import { errorResponse, json, requireUserId, service } from "@/lib/server";

export async function POST(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const body = CreateScanRequestSchema.parse(await req.json());
    return json(service().createScan(userId, body), 201);
  } catch (err) {
    return errorResponse(err);
  }
}
