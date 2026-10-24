import { runAnalysisForScan } from "../lib/analysis";

/**
 * Vercel Workflow entry for a scan (PLAN_V2 §6). The workflow function is
 * the durable orchestrator; the actual stage work happens inside the step,
 * which delegates to the platform-neutral engine in @shield/shared
 * (runScanWorkflow) via ShieldService.runAnalysis. If a step throws, the
 * Workflow runtime retries it; the engine marks the scan failed honestly
 * on terminal errors instead of leaving it "analyzing" forever.
 */
export async function scanWorkflow(scanId: string): Promise<void> {
  "use workflow";
  await runAnalysisStep(scanId);
}

async function runAnalysisStep(scanId: string): Promise<void> {
  "use step";
  await runAnalysisForScan(scanId);
}
