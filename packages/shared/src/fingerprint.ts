import { createHash } from "node:crypto";

/**
 * Finding fingerprint (PLAN_V2 §9.2). Cross-scan identity of a finding:
 * category/CWE + path + route/function identity + hash of the NORMALIZED
 * vulnerable pattern. Deliberately NOT the whole-file hash (it changes
 * exactly when a fix lands) and NOT line numbers (they move).
 */

/** Normalize a code pattern: strip comments and collapse whitespace. */
export function normalizePattern(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/#[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface FingerprintInput {
  cwe: string;
  filePath: string;
  routeIdentity: string;
  pattern: string;
}

export function findingFingerprint(input: FingerprintInput): string {
  const material = [
    input.cwe.trim().toUpperCase(),
    input.filePath.replace(/\\/g, "/").trim(),
    input.routeIdentity.trim(),
    normalizePattern(input.pattern),
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
