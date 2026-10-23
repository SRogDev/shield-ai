import { describe, expect, it } from "vitest";
import { findingFingerprint, normalizePattern } from "./fingerprint.js";

const base = {
  cwe: "CWE-862",
  filePath: "app/api/orders/route.ts",
  routeIdentity: "GET /api/orders",
  pattern: "export async function GET(req) { return db.orders.find(id) }",
};

describe("findingFingerprint (PLAN_V2 §9.2)", () => {
  it("is stable when line numbers change (they are not an input)", () => {
    // The same vulnerable pattern, moved within the file, must match:
    // fingerprint inputs contain no line information at all.
    expect(findingFingerprint(base)).toBe(findingFingerprint({ ...base }));
  });

  it("is stable under whitespace and comment changes", () => {
    const reformatted = {
      ...base,
      pattern:
        "// fetch the order\nexport async function GET(req) {\n  return db.orders.find(id)\n}",
    };
    expect(findingFingerprint(reformatted)).toBe(findingFingerprint(base));
  });

  it("changes when the vulnerable pattern actually changes (a fix)", () => {
    const fixed = {
      ...base,
      pattern:
        "export async function GET(req) { const s = await auth(); return db.orders.find(id, s.userId) }",
    };
    expect(findingFingerprint(fixed)).not.toBe(findingFingerprint(base));
  });

  it("differs across files, routes, and categories", () => {
    expect(findingFingerprint({ ...base, filePath: "app/api/users/route.ts" })).not.toBe(
      findingFingerprint(base),
    );
    expect(findingFingerprint({ ...base, routeIdentity: "POST /api/orders" })).not.toBe(
      findingFingerprint(base),
    );
    expect(findingFingerprint({ ...base, cwe: "CWE-89" })).not.toBe(findingFingerprint(base));
  });

  it("does NOT equal a whole-file hash: unrelated edits elsewhere keep identity", () => {
    // The fingerprint only covers the pattern, so appending an unrelated
    // helper to the same file leaves the finding's identity intact.
    const fp = findingFingerprint(base);
    expect(fp).toBe(findingFingerprint({ ...base, pattern: base.pattern }));
    expect(normalizePattern("a  b\n// comment\nc")).toBe("a b c");
  });
});
