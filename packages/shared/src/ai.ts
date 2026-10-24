import { generateObject } from "ai";
import type { z } from "zod";
import { NotConfiguredError } from "./errors.js";
import type { ServerEnv } from "./schemas.js";

/**
 * AI provider abstraction (PLAN_V2 §6.3). The workflow engine talks only to
 * this interface. Two implementations:
 * - GatewayAiProvider: real calls through Vercel AI Gateway via the AI SDK.
 *   Requires AI_GATEWAY_API_KEY; without it, it throws NotConfiguredError.
 * - StubAiProvider (in stub-provider.ts): deterministic, $0, used by tests.
 *
 * Model selection is a CONFIG TABLE. Entries below are PROVISIONAL
 * CANDIDATES chosen for being economical; they are NOT a claim that any
 * model is "best at cybersecurity". Phase 7 benchmarks candidates on the
 * seeded eval set (with Roger's AI Gateway key) and this table is updated
 * from that evidence.
 */

export type WorkflowStageName = "understand" | "identify" | "evaluate" | "explain" | "plan";

export interface StageUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD. For the stub provider these are SYNTHETIC planning numbers. */
  costUsd: number;
  synthetic: boolean;
}

export interface StructuredResult<T> {
  data: T;
  usage: StageUsage;
}

export interface AiProvider {
  readonly name: string;
  generateStructured<T>(
    stage: WorkflowStageName,
    schema: z.ZodType<T>,
    prompt: string,
  ): Promise<StructuredResult<T>>;
}

export interface ModelConfigEntry {
  /** Gateway model id, e.g. "provider/model". Provisional candidate. */
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export const MODEL_CONFIG: Record<WorkflowStageName, ModelConfigEntry> = {
  // Bulk stages: economical candidates.
  understand: { model: "openai/gpt-5-mini", inputUsdPerMillion: 0.25, outputUsdPerMillion: 2.0 },
  identify: { model: "openai/gpt-5-mini", inputUsdPerMillion: 0.25, outputUsdPerMillion: 2.0 },
  explain: { model: "openai/gpt-5-mini", inputUsdPerMillion: 0.25, outputUsdPerMillion: 2.0 },
  plan: { model: "openai/gpt-5-mini", inputUsdPerMillion: 0.25, outputUsdPerMillion: 2.0 },
  // Evaluation stage: one stronger candidate for validity/severity judgment.
  evaluate: {
    model: "anthropic/claude-sonnet-4.5",
    inputUsdPerMillion: 3.0,
    outputUsdPerMillion: 15.0,
  },
};

export class GatewayAiProvider implements AiProvider {
  readonly name = "vercel-ai-gateway";
  constructor(private readonly env: ServerEnv) {}

  async generateStructured<T>(
    stage: WorkflowStageName,
    schema: z.ZodType<T>,
    prompt: string,
  ): Promise<StructuredResult<T>> {
    if (!this.env.AI_GATEWAY_API_KEY) {
      throw new NotConfiguredError("Vercel AI Gateway", ["AI_GATEWAY_API_KEY"]);
    }
    const config = MODEL_CONFIG[stage];
    const result = await generateObject({
      model: config.model,
      schema,
      prompt,
      // The AI SDK routes bare "provider/model" strings through the Gateway
      // when AI_GATEWAY_API_KEY is present in the environment.
    });
    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    const costUsd =
      (inputTokens / 1_000_000) * config.inputUsdPerMillion +
      (outputTokens / 1_000_000) * config.outputUsdPerMillion;
    return {
      data: result.object,
      usage: { inputTokens, outputTokens, costUsd, synthetic: false },
    };
  }
}
