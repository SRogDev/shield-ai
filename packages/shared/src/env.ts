import { NotConfiguredError } from "./errors.js";
import { INTEGRATION_ENV_KEYS, type IntegrationName, type ServerEnv, ServerEnvSchema } from "./schemas.js";

/** Parse + validate server environment with Zod (PLAN_V2 §2). */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  return ServerEnvSchema.parse(source);
}

/** Env keys an integration still needs; empty array means configured. */
export function missingKeysFor(env: ServerEnv, integration: IntegrationName): string[] {
  return INTEGRATION_ENV_KEYS[integration].filter((key) => !env[key]);
}

/** Throws an honest NotConfiguredError when an integration lacks its env. */
export function assertConfigured(env: ServerEnv, integration: IntegrationName): void {
  const missing = missingKeysFor(env, integration);
  if (missing.length > 0) throw new NotConfiguredError(integration, missing);
}
