import * as ts from "typescript";
import { NotConfiguredError } from "./errors.js";
import type { EvidenceItem } from "./schemas.js";

/**
 * Deterministic security checks (PLAN_V2 §6.2). These run inside workflow
 * steps: exact rules for exact problems — secrets, known-vulnerable
 * dependencies, insecure configuration, and AST-level patterns in TS/JS.
 * They never guess: every item cites the file, line, and matched construct.
 * Secret VALUES are redacted in evidence (first 4 chars only).
 */

export interface SourceFileInput {
  path: string;
  content: string;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function redact(value: string): string {
  return value.length <= 4 ? "••••" : `${value.slice(0, 4)}…[redacted]`;
}

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const PLACEHOLDER =
  /(example|changeme|placeholder|your[_-]|xxxx|\.\.\.|process\.env|os\.environ|getenv)/i;

interface SecretRule {
  id: string;
  regex: RegExp;
  label: string;
  valueGroup: number;
}

const SECRET_RULES: SecretRule[] = [
  {
    id: "private-key-block",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    label: "private key block committed to source",
    valueGroup: 0,
  },
  {
    id: "aws-access-key",
    regex: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16})\b/,
    label: "AWS access key id in source",
    valueGroup: 1,
  },
  {
    id: "jwt-token",
    regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/,
    label: "hardcoded JWT in source",
    valueGroup: 1,
  },
  {
    id: "generic-secret-assignment",
    regex:
      /(api[_-]?key|client[_-]?secret|auth[_-]?token|password|passwd|secret)\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    label: "secret-looking literal assigned in source",
    valueGroup: 2,
  },
];

export function findSecrets(files: SourceFileInput[]): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const file of files) {
    for (const rule of SECRET_RULES) {
      // Always iterate with a global copy: a non-global regex never advances
      // lastIndex and would loop forever on its first match.
      const flags = rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`;
      const re = new RegExp(rule.regex.source, flags);
      for (let m = re.exec(file.content); m !== null; m = re.exec(file.content)) {
        const rawValue = m[rule.valueGroup] ?? m[0];
        if (rule.id === "generic-secret-assignment") {
          if (PLACEHOLDER.test(rawValue) || shannonEntropy(rawValue) < 3.2) continue;
        }
        out.push({
          checkId: `secret:${rule.id}`,
          filePath: file.path,
          line: lineOf(file.content, m.index),
          message: `${rule.label}: ${redact(rawValue)}`,
          pattern: (m[0] ?? "").replace(rawValue, redact(rawValue)).trim(),
          source: "ts-check",
        });
        if (m[0].length === 0) re.lastIndex += 1;
      }
    }
  }
  return out;
}

const CONFIG_RULES: { id: string; regex: RegExp; message: string }[] = [
  {
    id: "cors-wildcard",
    regex: /(Access-Control-Allow-Origin|cors|origin)\s*[:=]\s*["']\*["']/,
    message: "CORS allows any origin (*)",
  },
  {
    id: "tls-verification-disabled",
    regex:
      /(NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|rejectUnauthorized\s*:\s*false|verify\s*:\s*false)/,
    message: "TLS certificate verification is disabled",
  },
  {
    id: "debug-enabled",
    regex: /(^|[^a-zA-Z])debug\s*[:=]\s*true/,
    message: "debug mode enabled in configuration",
  },
];

export function findInsecureConfig(files: SourceFileInput[]): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const file of files) {
    for (const rule of CONFIG_RULES) {
      const m = rule.regex.exec(file.content);
      if (m) {
        out.push({
          checkId: `config:${rule.id}`,
          filePath: file.path,
          line: lineOf(file.content, m.index),
          message: rule.message,
          pattern: m[0].trim(),
          source: "ts-check",
        });
      }
    }
  }
  return out;
}

/* ------------------------------ Dependencies ------------------------------ */

export interface Dependency {
  ecosystem: "npm";
  name: string;
  version: string;
}

export function parsePackageLock(content: string): Dependency[] {
  const deps = new Map<string, string>();
  try {
    const json = JSON.parse(content) as { packages?: Record<string, { version?: string }> };
    for (const [key, value] of Object.entries(json.packages ?? {})) {
      const match = /^node_modules\/(.+)$/.exec(key);
      if (match?.[1] && value.version && !match[1].includes("node_modules/")) {
        deps.set(match[1], value.version);
      }
    }
  } catch {
    // Not JSON (or a different lockfile): no npm deps extracted.
  }
  return [...deps.entries()].map(([name, version]) => ({
    ecosystem: "npm" as const,
    name,
    version,
  }));
}

export function parsePnpmLock(content: string): Dependency[] {
  const deps = new Map<string, string>();
  for (const m of content.matchAll(
    /^\s{2}(\/?[@a-z0-9._-]+(?:\/[a-z0-9._-]+)?)@(\d+\.\d+\.\d+[^:\s]*)/gm,
  )) {
    if (m[1] && m[2]) deps.set(m[1].replace(/^\//, ""), m[2]);
  }
  return [...deps.entries()].map(([name, version]) => ({
    ecosystem: "npm" as const,
    name,
    version,
  }));
}

export function extractDependencies(files: SourceFileInput[]): Dependency[] {
  const all: Dependency[] = [];
  for (const file of files) {
    if (file.path.endsWith("package-lock.json")) all.push(...parsePackageLock(file.content));
    else if (file.path.endsWith("pnpm-lock.yaml")) all.push(...parsePnpmLock(file.content));
  }
  return all;
}

export interface OsvVulnerability {
  id: string;
  packageName: string;
  version: string;
  summary: string;
}

/** OSV lookup contract (https://api.osv.dev/v1/querybatch shape). */
export interface OsvClient {
  queryBatch(deps: Dependency[]): Promise<OsvVulnerability[]>;
}

/** Real OSV client. Only constructed when a workflow explicitly enables live lookups. */
export class HttpOsvClient implements OsvClient {
  async queryBatch(deps: Dependency[]): Promise<OsvVulnerability[]> {
    const res = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: deps.map((d) => ({
          package: { name: d.name, ecosystem: "npm" },
          version: d.version,
        })),
      }),
    });
    if (!res.ok) throw new Error(`OSV querybatch failed with HTTP ${res.status}`);
    const body = (await res.json()) as {
      results?: { vulns?: { id: string; summary?: string }[] }[];
    };
    const out: OsvVulnerability[] = [];
    (body.results ?? []).forEach((result, i) => {
      const dep = deps[i];
      if (!dep) return;
      for (const vuln of result.vulns ?? []) {
        out.push({
          id: vuln.id,
          packageName: dep.name,
          version: dep.version,
          summary: vuln.summary ?? vuln.id,
        });
      }
    });
    return out;
  }
}

/**
 * STUB OSV client for tests and local runs: canned fixture data, clearly
 * labeled. It does NOT query the real OSV database.
 */
export class StubOsvClient implements OsvClient {
  static readonly FIXTURES: Record<string, OsvVulnerability[]> = {
    "lodash@4.17.20": [
      {
        id: "GHSA-35jh-r3h4-6jhm",
        packageName: "lodash",
        version: "4.17.20",
        summary: "[stub fixture] Command Injection in lodash",
      },
    ],
    "jsonwebtoken@8.5.1": [
      {
        id: "GHSA-8cf7-32gw-wr33",
        packageName: "jsonwebtoken",
        version: "8.5.1",
        summary: "[stub fixture] jsonwebtoken signature validation issue",
      },
    ],
  };
  async queryBatch(deps: Dependency[]): Promise<OsvVulnerability[]> {
    return deps.flatMap((d) => StubOsvClient.FIXTURES[`${d.name}@${d.version}`] ?? []);
  }
}

export async function findVulnerableDependencies(
  files: SourceFileInput[],
  osv: OsvClient,
): Promise<EvidenceItem[]> {
  const deps = extractDependencies(files);
  if (deps.length === 0) return [];
  const vulns = await osv.queryBatch(deps);
  const lockPath =
    files.find((f) => f.path.endsWith("lock.json") || f.path.endsWith("lock.yaml"))?.path ??
    "package-lock.json";
  return vulns.map((v) => ({
    checkId: `dependency:${v.id}`,
    filePath: lockPath,
    line: 1,
    message: `vulnerable dependency ${v.packageName}@${v.version}: ${v.summary} (${v.id})`,
    pattern: `${v.packageName}@${v.version}`,
    source: "ts-check" as const,
  }));
}

/* ---------------------------- AST checks (TS/JS) --------------------------- */

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const AUTH_MARKERS =
  /(auth|session|currentUser|requireAuth|requireUser|getUser|verifyToken|verifySession|clerk|unauthorized)/i;

function routeIdentityFor(filePath: string, method: string): string {
  const routePath = filePath
    .replace(/\\/g, "/")
    .replace(/^.*\/app\//, "/")
    .replace(/\/route\.[tj]sx?$/, "")
    .replace(/^app\//, "/");
  return `${method} ${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
}

/**
 * Route handlers (Next.js `route.ts` convention and `/api/` files) whose
 * body shows no authentication/authorization marker at all. Heuristic by
 * design — the AI evaluation stage (or a human) judges exploitability;
 * this check only guarantees the pattern is surfaced with evidence.
 */
export function findUnauthenticatedRoutes(files: SourceFileInput[]): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const file of files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(file.path)) continue;
    if (!/(route\.[tj]sx?$|[/\\]api[/\\])/.test(file.path)) continue;
    const sf = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        HTTP_METHODS.has(node.name.text) &&
        node.body
      ) {
        const bodyText = node.body.getText(sf);
        if (!AUTH_MARKERS.test(bodyText)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          out.push({
            checkId: "ast:missing-auth-check",
            filePath: file.path,
            line: line + 1,
            message: `route handler ${node.name.text} shows no authentication/authorization check`,
            pattern: `export async function ${node.name.text}(...) { ... }`,
            route: routeIdentityFor(file.path, node.name.text),
            source: "ts-check",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/* ------------------------------ Tool runners ------------------------------ */

export interface ToolRunResult {
  evidence: EvidenceItem[];
  /** Tools that could not run (e.g. unconfigured) — recorded, never hidden. */
  unavailableTools: string[];
}

export interface DeterministicToolRunner {
  readonly name: string;
  run(files: SourceFileInput[]): Promise<ToolRunResult>;
}

/** In-process TypeScript checks (PLAN_V2 §6.2). */
export class TsToolRunner implements DeterministicToolRunner {
  readonly name = "ts-checks";
  constructor(private readonly osv: OsvClient = new StubOsvClient()) {}
  async run(files: SourceFileInput[]): Promise<ToolRunResult> {
    const evidence = [
      ...findSecrets(files),
      ...findInsecureConfig(files),
      ...findUnauthenticatedRoutes(files),
      ...(await findVulnerableDependencies(files, this.osv)),
    ];
    return { evidence, unavailableTools: [] };
  }
}

/**
 * Runs several runners; a runner that is not configured (NotConfiguredError)
 * is reported in `unavailableTools` instead of failing the scan or — worse —
 * having its output fabricated.
 */
export class CompositeToolRunner implements DeterministicToolRunner {
  readonly name = "composite";
  constructor(private readonly runners: DeterministicToolRunner[]) {}
  async run(files: SourceFileInput[]): Promise<ToolRunResult> {
    const evidence: EvidenceItem[] = [];
    const unavailableTools: string[] = [];
    for (const runner of this.runners) {
      try {
        const result = await runner.run(files);
        evidence.push(...result.evidence);
        unavailableTools.push(...result.unavailableTools);
      } catch (err) {
        if (err instanceof NotConfiguredError) {
          unavailableTools.push(`${runner.name}: not configured`);
        } else {
          throw err;
        }
      }
    }
    return { evidence, unavailableTools };
  }
}
