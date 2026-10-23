import { z } from "zod";

/**
 * Zod contracts for Shield AI (PLAN_V2 §2). This module is the single source
 * of truth for every external shape: API payloads, AI structured output,
 * MCP tool schemas, webhook payloads, and environment configuration. The
 * Rust CLI mirrors these shapes by hand (PLAN_V2 §8.6).
 */

export const SeveritySchema = z.enum(["Critical", "High", "Medium", "Low", "Info"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ConfidenceSchema = z.enum(["High", "Medium", "Low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const ScanActionSchema = z.enum(["quick", "verify", "incremental", "full"]);
export type ScanAction = z.infer<typeof ScanActionSchema>;

export const ScanStatusSchema = z.enum([
  "pending",
  "uploading",
  "analyzing",
  "completed",
  "failed",
]);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

export const VerificationStatusSchema = z.enum([
  "open",
  "fixed_verified",
  "still_present",
  "not_rechecked",
]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const RemediationTaskSchema = z.object({
  id: z.string(),
  findingId: z.string(),
  title: z.string().min(1),
  guidance: z.string().min(1),
  status: z.enum(["open", "done"]),
});
export type RemediationTask = z.infer<typeof RemediationTaskSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  scanId: z.string(),
  fingerprint: z.string().min(16),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: SeveritySchema,
  confidence: ConfidenceSchema,
  cwe: z.string().regex(/^CWE-\d+$/, "expected a CWE identifier"),
  owasp: z.array(z.string()).min(1),
  filePath: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  evidence: z.string().min(1),
  impact: z.string().min(1),
  verificationStatus: VerificationStatusSchema,
});
export type Finding = z.infer<typeof FindingSchema>;

/* ---------------------------------- API ---------------------------------- */

export const ProjectSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string().min(1),
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectRequestSchema = z.object({ name: z.string().min(1).max(120) });

export const RepoLinkRequestSchema = z.object({
  projectId: z.string(),
  repoName: z.string().min(1),
  remoteUrlHash: z.string().nullable(),
});

export const ListProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema),
  singleProject: z.boolean(),
  linkedRepos: z.array(
    z.object({
      repoName: z.string(),
      remoteUrlHash: z.string().nullable(),
      projectId: z.string(),
    }),
  ),
});

export const SnapshotFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});

export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

export const CreateScanRequestSchema = z.object({
  projectId: z.string(),
  action: ScanActionSchema,
  files: z.array(SnapshotFileSchema).min(1),
  /** Optional: finding to verify when action === "verify". */
  findingId: z.string().optional(),
  idempotencyKey: z.string().min(8),
});
export type CreateScanRequest = z.infer<typeof CreateScanRequestSchema>;

export const CreateScanResponseSchema = z.object({
  scanId: z.string(),
  costShields: z.number().int().nonnegative(),
  needed: z.array(z.string()),
  status: ScanStatusSchema,
});

export const UploadFileRequestSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string(),
});

export const CompleteScanResponseSchema = z.object({ status: ScanStatusSchema });

export const ScanViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  action: ScanActionSchema,
  status: ScanStatusSchema,
  costShields: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

/* ------------------------------- Device flow ------------------------------ */

export const DeviceStartResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  expiresInSec: z.number().int().positive(),
  intervalSec: z.number().int().positive(),
});

export const DevicePollRequestSchema = z.object({ deviceCode: z.string() });
export const DevicePollResponseSchema = z.object({
  status: z.enum(["pending", "approved", "denied", "expired"]),
  token: z.string().optional(),
});

export const DeviceApproveRequestSchema = z.object({ userCode: z.string().min(4) });

/* ------------------------------ AI stage I/O ------------------------------ */

export const ProjectUnderstandingSchema = z.object({
  summary: z.string().min(1),
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  trustBoundaries: z.array(z.string()),
  aiFeatures: z.array(z.string()),
});
export type ProjectUnderstanding = z.infer<typeof ProjectUnderstandingSchema>;

export const EvidenceItemSchema = z.object({
  checkId: z.string(),
  filePath: z.string(),
  line: z.number().int().positive(),
  message: z.string().min(1),
  pattern: z.string().min(1),
  /** Route/function identity when the evidence belongs to a handler. */
  route: z.string().optional(),
  source: z.enum(["ts-check", "sandbox-tool"]),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const CandidateFindingSchema = z.object({
  title: z.string().min(1),
  cwe: z.string().regex(/^CWE-\d+$/),
  owasp: z.array(z.string()).min(1),
  filePath: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  evidence: z.string().min(1),
  pattern: z.string().min(1),
  routeIdentity: z.string(),
});
export type CandidateFinding = z.infer<typeof CandidateFindingSchema>;

export const EvaluatedFindingSchema = CandidateFindingSchema.extend({
  valid: z.boolean(),
  severity: SeveritySchema,
  confidence: ConfidenceSchema,
  impact: z.string().min(1),
});
export type EvaluatedFinding = z.infer<typeof EvaluatedFindingSchema>;

export const ExplainedFindingSchema = EvaluatedFindingSchema.extend({
  description: z.string().min(1),
});
export type ExplainedFinding = z.infer<typeof ExplainedFindingSchema>;

export const CorrectionPlanSchema = z.object({
  tasks: z.array(
    z.object({
      candidateIndex: z.number().int().nonnegative(),
      title: z.string().min(1),
      guidance: z.string().min(1),
    }),
  ),
});
export type CorrectionPlan = z.infer<typeof CorrectionPlanSchema>;

/* ---------------------------------- MCP ----------------------------------- */

export const McpListProjectsInputSchema = z.object({});
export const McpListFindingsInputSchema = z.object({
  projectId: z.string(),
  scanId: z.string().optional(),
});
export const McpGetFindingInputSchema = z.object({ findingId: z.string() });
export const McpListTasksInputSchema = z.object({ projectId: z.string() });
export const McpVerificationInputSchema = z.object({ projectId: z.string() });

/* ------------------------------- Polar webhook ---------------------------- */

/**
 * Polar webhook events are validated structurally: the fields Shield acts on
 * are required; everything else is passed through untouched (Polar may add
 * fields without breaking entitlement handling).
 */
export const PolarWebhookEventSchema = z.object({
  type: z.string().min(1),
  data: z.object({
    id: z.string(),
    customer_external_id: z.string().nullish(),
    status: z.string().nullish(),
    product_id: z.string().nullish(),
    current_period_end: z.string().nullish(),
  }),
});
export type PolarWebhookEvent = z.infer<typeof PolarWebhookEventSchema>;

/* ---------------------------------- Env ----------------------------------- */

export const ServerEnvSchema = z.object({
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  POLAR_ACCESS_TOKEN: z.string().min(1).optional(),
  POLAR_WEBHOOK_SECRET: z.string().min(1).optional(),
  POLAR_INDIE_PRODUCT_ID: z.string().min(1).optional(),
  POLAR_BUILDER_PRODUCT_ID: z.string().min(1).optional(),
  POLAR_PACK30_PRODUCT_ID: z.string().min(1).optional(),
  POLAR_PACK100_PRODUCT_ID: z.string().min(1).optional(),
  VERCEL_OIDC_TOKEN: z.string().min(1).optional(),
  SHIELD_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
});
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export type IntegrationName = "supabase" | "ai-gateway" | "polar" | "vercel-sandbox";

/** Which env keys each integration needs; used for honest "not configured" errors. */
export const INTEGRATION_ENV_KEYS: Record<IntegrationName, (keyof ServerEnv)[]> = {
  supabase: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
  "ai-gateway": ["AI_GATEWAY_API_KEY"],
  polar: ["POLAR_ACCESS_TOKEN", "POLAR_WEBHOOK_SECRET"],
  "vercel-sandbox": ["VERCEL_OIDC_TOKEN"],
};
