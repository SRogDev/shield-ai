import {
  NotConfiguredError,
  PLANS,
  SHIELD_PACKS,
  assertConfigured,
} from "@shield/shared";
import { z } from "zod";
import { errorResponse, json, requireUserId, serverEnv, service } from "@/lib/server";

const Body = z.object({ product: z.enum(["indie", "builder", "pack-30", "pack-100"]) });

function productEnvKey(product: z.infer<typeof Body>["product"]): string {
  switch (product) {
    case "indie":
      return "POLAR_INDIE_PRODUCT_ID";
    case "builder":
      return "POLAR_BUILDER_PRODUCT_ID";
    case "pack-30":
      return "POLAR_PACK30_PRODUCT_ID";
    case "pack-100":
      return "POLAR_PACK100_PRODUCT_ID";
  }
}

/**
 * Creates a Polar checkout for a plan or Shield pack. Entitlement is NEVER
 * granted here — only the Polar webhook grants Shields (PLAN_V2 §11).
 * Without Polar configuration this returns an honest 503.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const env = serverEnv();
    assertConfigured(env, "polar");
    const body = Body.parse(await req.json());
    const key = productEnvKey(body.product) as keyof typeof env;
    const productId = env[key];
    if (!productId) throw new NotConfiguredError("Polar", [key]);
    service().getUser(userId); // must exist locally before billing identity is used

    const res = await fetch("https://api.polar.sh/v1/checkouts/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        product_id: productId,
        customer_external_id: userId,
        success_url: `${env.SHIELD_PUBLIC_URL}/dashboard?billing=success`,
        metadata: { shield_product: body.product },
      }),
    });
    if (!res.ok) {
      return json({ error: `Polar checkout creation failed with HTTP ${res.status}` }, 502);
    }
    const checkout = (await res.json()) as { url: string };
    const label =
      body.product === "indie" || body.product === "builder"
        ? `${PLANS[body.product].name} plan`
        : (SHIELD_PACKS.find((p) => p.id === body.product)?.shields ?? 0) + " Shields pack";
    return json({ url: checkout.url, product: body.product, label });
  } catch (err) {
    return errorResponse(err);
  }
}
