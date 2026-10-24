import {
  ForbiddenError,
  InsufficientShieldsError,
  missingKeysFor,
  NotConfiguredError,
  parseServerEnv,
  type ServerEnv,
  ShieldService,
  UnauthorizedError,
} from "@shield/shared";
import { ZodError } from "zod";

/**
 * Server-side singletons + identity resolution.
 *
 * Identity sources, in order:
 * 1. Bearer token issued by the CLI device flow (cli_tokens, hashed).
 * 2. Supabase access token — only when Supabase env is configured; validated
 *    against the Supabase Auth API, and the user record is provisioned on
 *    first sight.
 * 3. LOCAL DEV session cookie — only when Supabase is NOT configured. This
 *    mode is labeled in the UI; data lives in process memory and is gone on
 *    restart. It exists so the product is runnable/testable before Roger
 *    creates the Supabase project.
 */

const globalStore = globalThis as unknown as {
  __shieldService?: ShieldService;
  __shieldEnv?: ServerEnv;
};

export function serverEnv(): ServerEnv {
  if (!globalStore.__shieldEnv) globalStore.__shieldEnv = parseServerEnv(process.env);
  return globalStore.__shieldEnv;
}

export function service(): ShieldService {
  if (!globalStore.__shieldService) globalStore.__shieldService = new ShieldService();
  return globalStore.__shieldService;
}

export function supabaseConfigured(): boolean {
  return missingKeysFor(serverEnv(), "supabase").length === 0;
}

export function integrationStatus(): Record<string, boolean> {
  const env = serverEnv();
  return {
    supabase: missingKeysFor(env, "supabase").length === 0,
    aiGateway: missingKeysFor(env, "ai-gateway").length === 0,
    polar: missingKeysFor(env, "polar").length === 0,
    vercelSandbox: missingKeysFor(env, "vercel-sandbox").length === 0,
  };
}

function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export async function userIdFromRequest(req: Request): Promise<string | null> {
  const svc = service();
  const authorization = req.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    const viaCliToken = svc.userIdForToken(token);
    if (viaCliToken) return viaCliToken;
    if (supabaseConfigured()) {
      const env = serverEnv();
      try {
        const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
          headers: {
            authorization: `Bearer ${token}`,
            apikey: env.SUPABASE_ANON_KEY ?? "",
          },
        });
        if (res.ok) {
          const supaUser = (await res.json()) as { id: string; email?: string };
          try {
            svc.getUser(supaUser.id);
          } catch {
            svc.createUser({ id: supaUser.id, email: supaUser.email ?? "" });
          }
          return supaUser.id;
        }
      } catch {
        // Network failure validating the token: treat as unauthenticated.
      }
    }
    return null;
  }
  if (!supabaseConfigured()) {
    const localId = cookieValue(req, "shield_session");
    if (localId) {
      try {
        svc.getUser(localId);
        return localId;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function requireUserId(req: Request): Promise<string> {
  const userId = await userIdFromRequest(req);
  if (!userId) throw new UnauthorizedError();
  return userId;
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return headers ? Response.json(data, { status, headers }) : Response.json(data, { status });
}

/** Maps typed errors to HTTP responses. Messages never include source code. */
export function errorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    return json({ error: "invalid request", issues: err.issues.map((i) => i.message) }, 400);
  }
  if (err instanceof NotConfiguredError) return json({ error: err.message }, 503);
  if (err instanceof UnauthorizedError) return json({ error: err.message }, 401);
  if (err instanceof InsufficientShieldsError) return json({ error: err.message }, 402);
  if (err instanceof ForbiddenError) return json({ error: err.message }, 403);
  if (err instanceof Error) return json({ error: err.message }, 400);
  return json({ error: "unexpected error" }, 500);
}
