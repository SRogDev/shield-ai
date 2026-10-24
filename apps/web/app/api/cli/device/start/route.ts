import { errorResponse, json, serverEnv, service } from "@/lib/server";

export async function POST(): Promise<Response> {
  try {
    const env = serverEnv();
    const start = service().startDeviceFlow();
    return json({
      deviceCode: start.deviceCode,
      userCode: start.userCode,
      verificationUrl: `${env.SHIELD_PUBLIC_URL}/approve?code=${start.userCode}`,
      expiresInSec: start.expiresInSec,
      intervalSec: start.intervalSec,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
