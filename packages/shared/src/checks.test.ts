import { describe, expect, it } from "vitest";
import {
  StubOsvClient,
  TsToolRunner,
  extractDependencies,
  findInsecureConfig,
  findSecrets,
  findUnauthenticatedRoutes,
  findVulnerableDependencies,
  parsePackageLock,
  shannonEntropy,
} from "./checks.js";

describe("findSecrets", () => {
  it("detects private keys, AWS keys, and high-entropy assignments — with values redacted", () => {
    const files = [
      {
        path: "src/config.ts",
        content: [
          'const aws = "AKIAIOSFODNN7EXAMPLE";',
          'const apiKey = "sk-live-9f8e7d6c5b4a3210fedc";',
          "-----BEGIN PRIVATE KEY-----",
        ].join("\n"),
      },
    ];
    const evidence = findSecrets(files);
    expect(evidence.length).toBeGreaterThanOrEqual(3);
    const joined = JSON.stringify(evidence);
    expect(joined).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(joined).not.toContain("9f8e7d6c5b4a3210fedc");
    expect(joined).toContain("[redacted]");
  });

  it("ignores placeholders and env lookups", () => {
    const files = [
      {
        path: "src/config.ts",
        content: 'const apiKey = "your-api-key-here";\nconst other = process.env.API_KEY;',
      },
    ];
    expect(findSecrets(files)).toEqual([]);
  });

  it("entropy helper separates random strings from words", () => {
    expect(shannonEntropy("aaaaaaaaaaaaaaaa")).toBeLessThan(1);
    expect(shannonEntropy("9f8e7d6c5b4a3210fedcba9876543210")).toBeGreaterThan(3.5);
  });
});

describe("findInsecureConfig", () => {
  it("flags wildcard CORS, disabled TLS verification, and debug mode", () => {
    const files = [
      { path: "src/server.ts", content: 'app.use(cors({ origin: "*" }));\nconst agent = { rejectUnauthorized: false };\nconst cfg = { debug: true };' },
    ];
    const ids = findInsecureConfig(files).map((e) => e.checkId);
    expect(ids).toContain("config:cors-wildcard");
    expect(ids).toContain("config:tls-verification-disabled");
    expect(ids).toContain("config:debug-enabled");
  });
});

describe("dependency extraction + OSV (stub)", () => {
  const lock = JSON.stringify({
    packages: {
      "": { name: "app" },
      "node_modules/lodash": { version: "4.17.20" },
      "node_modules/react": { version: "19.0.0" },
    },
  });

  it("parses package-lock dependencies", () => {
    expect(parsePackageLock(lock)).toEqual([
      { ecosystem: "npm", name: "lodash", version: "4.17.20" },
      { ecosystem: "npm", name: "react", version: "19.0.0" },
    ]);
    expect(extractDependencies([{ path: "package-lock.json", content: lock }])).toHaveLength(2);
  });

  it("reports stub-fixture vulnerabilities, labeled as stub data", async () => {
    const evidence = await findVulnerableDependencies(
      [{ path: "package-lock.json", content: lock }],
      new StubOsvClient(),
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.checkId).toBe("dependency:GHSA-35jh-r3h4-6jhm");
    expect(evidence[0]?.message).toContain("[stub fixture]");
  });
});

describe("findUnauthenticatedRoutes (AST)", () => {
  it("flags a route handler with no auth marker", () => {
    const files = [
      {
        path: "app/api/orders/route.ts",
        content:
          "export async function GET(req: Request) { const id = new URL(req.url).searchParams.get('id'); return Response.json(await db.orders.find(id)); }",
      },
    ];
    const evidence = findUnauthenticatedRoutes(files);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.checkId).toBe("ast:missing-auth-check");
  });

  it("does not flag a handler that checks the session", () => {
    const files = [
      {
        path: "app/api/orders/route.ts",
        content:
          "export async function GET(req: Request) { const session = await auth(); if (!session) return new Response('unauthorized', { status: 401 }); return Response.json([]); }",
      },
    ];
    expect(findUnauthenticatedRoutes(files)).toEqual([]);
  });

  it("ignores non-route files", () => {
    const files = [{ path: "src/util.ts", content: "export async function GET() { return 1; }" }];
    expect(findUnauthenticatedRoutes(files)).toEqual([]);
  });
});

describe("TsToolRunner", () => {
  it("aggregates all check families", async () => {
    const runner = new TsToolRunner();
    const result = await runner.run([
      { path: "app/api/x/route.ts", content: "export async function POST() { return Response.json({}); }" },
      { path: "src/k.ts", content: "-----BEGIN PRIVATE KEY-----" },
    ]);
    expect(result.unavailableTools).toEqual([]);
    expect(result.evidence.length).toBeGreaterThanOrEqual(2);
  });
});
