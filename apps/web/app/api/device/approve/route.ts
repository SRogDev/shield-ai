import { DeviceApproveRequestSchema } from "@shield/shared";
import { errorResponse, json, requireUserId, service } from "@/lib/server";

export async function POST(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const body = DeviceApproveRequestSchema.parse(await req.json());
    service().approveDevice(userId, body.userCode);
    return json({ approved: true });
  } catch (err) {
    return errorResponse(err);
  }
}
