import { z } from "zod";
import type { AiProvider } from "./ai.js";
import type { DeterministicToolRunner, SourceFileInput } from "./checks.js";
import { BudgetExceededError, StageFailedError } from "./errors.js";
import { findingFingerprint, sha256Hex } from "./fingerprint.js";
import {
  type CorrectionPlan,
  CorrectionPlanSchema,
  type Finding,
  type ProjectUnderstanding,
  ProjectUnderstandingSchema,
  type RemediationTask,
  type ScanAction,
  type VerificationStatus,
} from "./schemas.js";
import { deterministicCandidates, deterministicSeverity } from "./stub-provider.js";

/**
 * The 8-stage analysis workflow (PLAN_V2 §6). In production this module is
 * invoked from a Vercel Workflow function ("use workflow") in apps/web,
 * with each stage below executed as a "use step"; the engine itself is
 * platform-neutral so it can be unit-tested end to end with the stub
 * provider at $0. Stage contract: explicit input/output, Zod-validated AI
 * output, hard cost budget, honest failure (a failed stage fails the scan).
 */

const IdentifyOutSchema = z.object({
  candidates: z.array(
    z.object({
      title: z.string().min(1),
      cwe: z.string(),
      owasp: z.array(z.string()),
      filePath: z.string(),
      lineStart: z.number(),
      lineEnd: z.number(),
      evidence: z.string(),
      pattern: z.string(),
      routeIdentity: z.string(),
    }),
  ),
});
const EvaluateOutSchema = z.object({
  evaluated: z.array(
    IdentifyOutSchema.shape.candidates.element.extend({
      valid: z.boolean(),
      severity: z.enum(["Critical", "High", "Medium", "Low", "Info"]),
      confidence: z.enum(["High", "Medium", "Low"]),
      impact: z.string(),
    }),
  ),
});
const ExplainOutSchema = z.object({
  explained: EvaluateOutSchema.shape.evaluated.element.extend({ description: z.string() }).array(),
});

export interface WorkflowInput {
  scanId: string;
  projectId: string;
  action: ScanAction;
  files: SourceFileInput[];
  /** Open findings recorded by previous scans of this project. */
  priorFindings: Finding[];
  /** For action="verify": the single finding to re-check. */
  verifyFindingId?: string | undefined;
}

export interface WorkflowDeps {
  /**
   * The AI provider, or a factory for providers that need the run context
   * (the stub provider derives its deterministic answers from the gathered
   * evidence, so it is built after stage 2).
   */
  ai: AiProvider | ((ctx: { files: SourceFileInput[]; evidence: import("./schemas.js").EvidenceItem[] }) => AiProvider);
  tools: DeterministicToolRunner;
  /** Hard USD budget for AI spend across stages (from the Shield cost). */
  budgetUsd: number;
}

export interface WorkflowResult {
  understanding: ProjectUnderstanding | null;
  findings: Finding[];
  tasks: RemediationTask[];
  verificationUpdates: { findingId: string; status: VerificationStatus }[];
  unavailableTools: string[];
  totalCostUsd: number;
  syntheticUsage: boolean;
  stagesRun: string[];
}

async function runStage<T>(
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    throw new StageFailedError(stage, err instanceof Error ? err.message : String(err));
  }
}

/** Zod validation failures are stage failures, never data (PLAN_V2 §6). */
function parseStage<T>(stage: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new StageFailedError(stage, err instanceof Error ? err.message : String(err));
  }
}

export async function runScanWorkflow(
  input: WorkflowInput,
  deps: WorkflowDeps,
): Promise<WorkflowResult> {
  const stagesRun: string[] = [];
  let spentUsd = 0;
  let syntheticUsage = false;

  const spend = (stage: string, costUsd: number, synthetic: boolean) => {
    spentUsd += costUsd;
    if (synthetic) syntheticUsage = true;
    if (spentUsd > deps.budgetUsd) throw new BudgetExceededError(stage, deps.budgetUsd);
  };

  /* Stage 2 (gather evidence) runs first in code order for non-AI stages:
     stage 1 (understand) needs the file inventory, stage 2 needs nothing
     from the model. Logical stage numbers follow PLAN_V2 §6. */
  const gather = await runStage("gather-evidence", () => deps.tools.run(input.files));
  stagesRun.push("2-gather-evidence");
  const evidence = gather.evidence;

  const scannedPaths = new Set(input.files.map((f) => f.path));
  const newFindings: Finding[] = [];
  const tasks: RemediationTask[] = [];
  let understanding: ProjectUnderstanding | null = null;

  const buildFinding = (
    candidate: z.infer<typeof IdentifyOutSchema>["candidates"][number] & {
      severity: Finding["severity"];
      confidence: Finding["confidence"];
      impact: string;
      description: string;
    },
  ): Finding => {
    const fingerprint = findingFingerprint({
      cwe: candidate.cwe,
      filePath: candidate.filePath,
      routeIdentity: candidate.routeIdentity,
      pattern: candidate.pattern,
    });
    const prior = input.priorFindings.find((f) => f.fingerprint === fingerprint);
    return {
      id: `find_${sha256Hex(`${fingerprint}:${input.scanId}`).slice(0, 16)}`,
      projectId: input.projectId,
      scanId: input.scanId,
      fingerprint,
      title: candidate.title,
      description: candidate.description,
      severity: candidate.severity,
      confidence: candidate.confidence,
      cwe: candidate.cwe,
      owasp: candidate.owasp,
      filePath: candidate.filePath,
      lineStart: candidate.lineStart,
      lineEnd: candidate.lineEnd,
      evidence: candidate.evidence,
      impact: candidate.impact,
      verificationStatus: prior ? "still_present" : "open",
    };
  };

  if (input.action === "verify") {
    /* Stage 7 only: targeted re-check of one finding against fresh files. */
    stagesRun.push("7-verify-corrections");
    const target = input.priorFindings.find((f) => f.id === input.verifyFindingId);
    if (!target) throw new StageFailedError("verify-corrections", "target finding not found");
    const candidates = deterministicCandidates(evidence);
    const stillThere = candidates.some(
      (c) =>
        findingFingerprint({
          cwe: c.cwe,
          filePath: c.filePath,
          routeIdentity: c.routeIdentity,
          pattern: c.pattern,
        }) === target.fingerprint,
    );
    return {
      understanding: null,
      findings: [],
      tasks: [],
      verificationUpdates: [
        { findingId: target.id, status: stillThere ? "still_present" : "fixed_verified" },
      ],
      unavailableTools: gather.unavailableTools,
      totalCostUsd: spentUsd,
      syntheticUsage,
      stagesRun,
    };
  }

  const ai: AiProvider =
    typeof deps.ai === "function" ? deps.ai({ files: input.files, evidence }) : deps.ai;

  if (input.action === "quick") {
    /* Deterministic-only path (PLAN_V2 §3): no AI stages at all. */
    const candidates = deterministicCandidates(evidence);
    for (const [i, candidate] of candidates.entries()) {
      const ev = evidence[i];
      if (!ev) continue;
      newFindings.push(
        buildFinding({
          ...candidate,
          severity: deterministicSeverity(ev),
          confidence: "Medium",
          impact: "Determined by a deterministic rule; run a full scan for AI evaluation.",
          description: `${candidate.title} in ${candidate.filePath} (line ${candidate.lineStart}): ${candidate.evidence}`,
        }),
      );
    }
    stagesRun.push("3-identify-risks");
  } else {
    /* Stage 1 — understand the project. */
    const understandRes = await runStage("understand", () =>
      ai.generateStructured(
        "understand",
        ProjectUnderstandingSchema,
        JSON.stringify({
          instruction:
            "Summarize this project's architecture, languages, frameworks, trust boundaries, and AI features from the file inventory and samples.",
          files: input.files.map((f) => ({ path: f.path, bytes: f.content.length })),
          samples: input.files.slice(0, 10).map((f) => ({
            path: f.path,
            head: f.content.slice(0, 1200),
          })),
        }),
      ),
    );
    spend("understand", understandRes.usage.costUsd, understandRes.usage.synthetic);
    understanding = parseStage("understand", () => ProjectUnderstandingSchema.parse(understandRes.data));
    stagesRun.push("1-understand-project");

    /* Stage 3 — identify risks from evidence. */
    const identifyRes = await runStage("identify", () =>
      ai.generateStructured(
        "identify",
        IdentifyOutSchema,
        JSON.stringify({
          instruction:
            "From the deterministic evidence and project context, form candidate findings. Only claim what the evidence supports.",
          understanding,
          evidence,
        }),
      ),
    );
    spend("identify", identifyRes.usage.costUsd, identifyRes.usage.synthetic);
    const candidates = parseStage("identify", () => IdentifyOutSchema.parse(identifyRes.data).candidates);
    stagesRun.push("3-identify-risks");

    /* Stage 4 — evaluate findings (validity, severity, confidence). */
    const evaluateRes = await runStage("evaluate", () =>
      ai.generateStructured(
        "evaluate",
        EvaluateOutSchema,
        JSON.stringify({
          instruction:
            "Assess each candidate: is it a real vulnerability in this context? Set severity by actual impact/exploitability and a separate confidence. Mark false positives valid=false.",
          candidates,
          understanding,
        }),
      ),
    );
    spend("evaluate", evaluateRes.usage.costUsd, evaluateRes.usage.synthetic);
    const evaluated = parseStage("evaluate", () => EvaluateOutSchema.parse(evaluateRes.data).evaluated.filter((e) => e.valid));
    stagesRun.push("4-evaluate-findings");

    /* Stage 5 — explain findings. */
    const explainRes = await runStage("explain", () =>
      ai.generateStructured(
        "explain",
        ExplainOutSchema,
        JSON.stringify({
          instruction:
            "For each evaluated finding, write a clear description: the problem, the supporting evidence, the affected component, and realistic consequences for a non-security-expert founder.",
          evaluated,
        }),
      ),
    );
    spend("explain", explainRes.usage.costUsd, explainRes.usage.synthetic);
    const explained = parseStage("explain", () => ExplainOutSchema.parse(explainRes.data).explained);
    stagesRun.push("5-explain-findings");

    for (const item of explained) newFindings.push(buildFinding(item));

    /* Stage 6 — correction plan. */
    const planRes = await runStage("plan", () =>
      ai.generateStructured(
        "plan",
        CorrectionPlanSchema,
        JSON.stringify({
          instruction:
            "Create one specific, actionable remediation task per finding (by candidateIndex, matching the order of the explained findings). Guidance must be concrete enough for a coding agent to execute.",
          explained,
        }),
      ),
    );
    spend("plan", planRes.usage.costUsd, planRes.usage.synthetic);
    const plan: CorrectionPlan = parseStage("plan", () => CorrectionPlanSchema.parse(planRes.data));
    stagesRun.push("6-create-correction-plan");
    for (const task of plan.tasks) {
      const finding = newFindings[task.candidateIndex];
      if (!finding) continue;
      tasks.push({
        id: `task_${sha256Hex(`${finding.id}:${task.title}`).slice(0, 16)}`,
        findingId: finding.id,
        title: task.title,
        guidance: task.guidance,
        status: "open",
      });
    }
  }

  /* Stage 7 — verify corrections from previous scans (full/incremental/quick).
     Only prior findings in files included in this scan can be judged:
     absence from an unscanned file proves nothing. */
  const newFingerprints = new Set(newFindings.map((f) => f.fingerprint));
  const verificationUpdates: { findingId: string; status: VerificationStatus }[] = [];
  for (const prior of input.priorFindings) {
    if (prior.verificationStatus === "fixed_verified") continue;
    if (!scannedPaths.has(prior.filePath)) continue;
    verificationUpdates.push({
      findingId: prior.id,
      status: newFingerprints.has(prior.fingerprint) ? "still_present" : "fixed_verified",
    });
  }
  stagesRun.push("7-verify-corrections", "8-record-results");
  stagesRun.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  return {
    understanding,
    findings: newFindings,
    tasks,
    verificationUpdates,
    unavailableTools: gather.unavailableTools,
    totalCostUsd: spentUsd,
    syntheticUsage,
    stagesRun,
  };
}
