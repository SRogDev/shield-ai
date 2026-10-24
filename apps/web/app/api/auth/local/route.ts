import { createHash } from "node:crypto";
import { z } from "zod";
import { errorResponse, json, service, supabaseConfigured } from "@/lib/server";

const Body = z.object({ email: z.string().email() });

/**
 * LOCAL DEV sign-in — available only while Supabase is not configured.
 * Creates (or reuses) a local user and sets a session cookie. Data lives in
 * process memory. When Supabase env exists, web sign-in is Supabase Auth.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    if (supabaseConfigured()) {
      return json({ error: "local sign-in is disabled: Supabase Auth is configured" }, 400);
    }
    const body = Body.parse(await req.json());
    const id = `local_${createHash("sha256").update(body.email.toLowerCase()).digest("hex").slice(0, 16)}`;
    const svc = service();
    try {
      svc.getUser(id);
    } catch {
      svc.createUser({ id, email: body.email });
    }
    return json({ ok: true, userId: id }, 200, {
      "set-cookie": `shield_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
