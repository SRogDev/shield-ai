import { errorResponse, json, requireUserId, serverEnv, service } from "@/lib/server";
import { DevicePollRequestSchema } from "@shield/shared";

export async function POST(req: Request): Promise<Response> {
  try {
    const body = DevicePollRequestSchema.parse(await req.json());
    return json(service().pollDevice(body.deviceCode));
  } catch (err) {
    return errorResponse(err);
  }
}
