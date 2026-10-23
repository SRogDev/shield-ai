import { errorResponse, json, requireUserId, serverEnv, service } from "@/lib/server";
import { PLANS } from "@shield/shared";
import { integrationStatus } from "@/lib/server";

export async function GET(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const svc = service();
    const user = svc.getUser(userId);
    return json({
      user: { id: user.id, email: user.email },
      plan: PLANS[user.planId],
      balance: svc.balance(userId),
      history: svc.ledger.history(userId),
      integrations: integrationStatus(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
