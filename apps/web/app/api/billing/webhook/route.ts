import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PLANS,
  PolarWebhookEventSchema,
  SHIELD_PACKS,
  assertConfigured,
} from "@shield/shared";
import { errorResponse, json, serverEnv, service } from "@/lib/server";

/**
 * Polar webhook receiver (PLAN_V2 §11). Signature: Polar uses the Standard
 * Webhooks scheme (webhook-id / webhook-timestamp / webhook-signature,
 * HMAC-SHA256 over `${id}.${timestamp}.${body}`). Events are deduplicated
 * twice: by webhook-id here, and by the ledger's idempotency keys in the
 * service layer. Duplicate deliveries never double-grant.
 */
function verifyStandardWebhook(rawBody: string, req: Request, secret: string): boolean {
  const id = req.headers.get("webhook-id");
  const timestamp = req.headers.get("webhook-timestamp");
  const signatureHeader = req.headers.get("webhook-signature");
  if (!id || !timestamp || !signatureHeader) return false;
  const keyMaterial = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyMaterial, "base64");
    if (key.length === 0) key = Buffer.from(secret, "utf8");
  } catch {
    key = Buffer.from(secret, "utf8");
  }
  const signed = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", key).update(signed).digest("base64");
  return signatureHeader.split(" ").some((part) => {
    const sig = part.includes(",") ? (part.split(",")[1] ?? "") : part;
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const env = serverEnv();
    assertConfigured(env, "polar");
    const rawBody = await req.text();
    if (!verifyStandardWebhook(rawBody, req, env.POLAR_WEBHOOK_SECRET ?? "")) {
      return json({ error: "invalid webhook signature" }, 401);
    }
    const webhookId = req.headers.get("webhook-id") ?? "";
    const svc = service();
    if (!svc.markPolarEventProcessed(webhookId)) {
      return json({ duplicate: true });
    }
    const event = PolarWebhookEventSchema.parse(JSON.parse(rawBody));
    const userId = event.data.customer_external_id;
    if (!userId) return json({ ignored: "no customer_external_id" });

    const productToPlan: Record<string, "indie" | "builder"> = {
      [env.POLAR_INDIE_PRODUCT_ID ?? ""]: "indie",
      [env.POLAR_BUILDER_PRODUCT_ID ?? ""]: "builder",
    };
    const productToPack: Record<string, number> = {
      [env.POLAR_PACK30_PRODUCT_ID ?? ""]: SHIELD_PACKS[0]?.shields ?? 30,
      [env.POLAR_PACK100_PRODUCT_ID ?? ""]: SHIELD_PACKS[1]?.shields ?? 100,
    };

    if (event.type.startsWith("subscription.") && event.data.status === "active") {
      const planId = event.data.product_id ? productToPlan[event.data.product_id] : undefined;
      if (planId) {
        svc.applySubscriptionGrant(
          userId,
          planId,
          `${event.data.id}:${event.data.current_period_end ?? ""}`,
          event.data.current_period_end ?? null,
        );
        return json({ applied: "subscription", plan: planId, shields: PLANS[planId].shieldsPerPeriod });
      }
    }
    if (event.type === "order.paid" && event.data.product_id) {
      const shields = productToPack[event.data.product_id];
      if (shields) {
        svc.applyPackGrant(userId, shields, event.data.id);
        return json({ applied: "pack", shields });
      }
      const planId = productToPlan[event.data.product_id];
      if (planId) {
        svc.applySubscriptionGrant(userId, planId, `order:${event.data.id}`, null);
        return json({ applied: "subscription-via-order", plan: planId });
      }
    }
    return json({ ignored: event.type });
  } catch (err) {
    return errorResponse(err);
  }
}
