import { DeviceApproveRequestSchema } from "@shield/shared";
import { errorResponse, json, requireUserId, service } from "@/lib/server";

export async function POST(req: Request): Promise<Response> {
  try {
    await requireUserId(req);
    const body = DeviceApproveRequestSchema.parse(await req.json());
    service().denyDevice(body.userCode);
    return json({ denied: true });
  } catch (err) {
    return errorResponse(err);
  }
}
