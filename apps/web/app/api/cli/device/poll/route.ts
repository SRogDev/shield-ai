import { DevicePollRequestSchema } from "@shield/shared";
import { errorResponse, json, service } from "@/lib/server";

export async function POST(req: Request): Promise<Response> {
  try {
    const body = DevicePollRequestSchema.parse(await req.json());
    return json(service().pollDevice(body.deviceCode));
  } catch (err) {
    return errorResponse(err);
  }
}
