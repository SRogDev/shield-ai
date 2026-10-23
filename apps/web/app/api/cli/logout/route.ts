import { errorResponse, json, requireUserId, serverEnv, service } from "@/lib/server";

export async function POST(req: Request): Promise<Response> {
  try {
    const authorization = req.headers.get("authorization");
    if (authorization?.startsWith("Bearer ")) {
      service().revokeToken(authorization.slice("Bearer ".length).trim());
    }
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
