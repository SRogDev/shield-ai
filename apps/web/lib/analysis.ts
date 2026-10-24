import {
  CompositeToolRunner,
  GatewayAiProvider,
  SHIELD_MAX_COGS_USD,
  StubAiProvider,
  StubOsvClient,
  HttpOsvClient,
  TsToolRunner,
} from "@shield/shared";
import { SandboxToolRunner } from "./sandbox-runner";
import { serverEnv, service } from "./server";

/**
 * Builds the workflow dependencies from the environment and runs a scan's
 * analysis (stage 8 recording happens inside ShieldService.runAnalysis).
 *
 * Provider selection is honest by construction:
 * - AI: Vercel AI Gateway when AI_GATEWAY_API_KEY is set; otherwise the
 *   deterministic STUB provider (labeled in every output it touches).
 * - OSV: the real OSV API client only when SHIELD_OSV_LIVE=1; otherwise the
 *   labeled stub fixture client (no live calls by default).
 * - Sandbox tools: attempted always; without Vercel credentials the
 *   composite runner records them as unavailable.
 */
export async function runAnalysisForScan(scanId: string): Promise<void> {
  const env = serverEnv();
  const svc = service();
  const osv = process.env.SHIELD_OSV_LIVE === "1" ? new HttpOsvClient() : new StubOsvClient();
  const tools = new CompositeToolRunner([new TsToolRunner(osv), new SandboxToolRunner(env)]);
  const ai = env.AI_GATEWAY_API_KEY
    ? new GatewayAiProvider(env)
    : (ctx: { files: { path: string; content: string }[]; evidence: import("@shield/shared").EvidenceItem[] }) =>
        new StubAiProvider(ctx);
  const budgetUsd = svc.scanCostShields(scanId) * SHIELD_MAX_COGS_USD;
  await svc.runAnalysis(scanId, { ai, tools, budgetUsd });
}

/**
 * Starts analysis for a completed upload. On Vercel (VERCEL=1) the run is
 * started as a durable Vercel Workflow (see workflows/scan.ts); its step
 * calls runAnalysisForScan. Locally there is no Workflow backend executing
 * runs — start() would accept the run and it would sit "analyzing" forever
 * — so local runs execute inline. Same engine either way.
 */
export async function startAnalysis(scanId: string): Promise<void> {
  if (process.env.VERCEL === "1") {
    const { start } = await import("workflow/api");
    const { scanWorkflow } = await import("../workflows/scan");
    await start(scanWorkflow, [scanId]);
    return;
  }
  await runAnalysisForScan(scanId);
}
