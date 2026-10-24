/**
 * Local smoke test against a RUNNING Shield web server (stub provider).
 * Usage: node scripts/smoke-local.mjs [baseUrl]
 * Exercises: local sign-in, project creation, CLI device flow, scan
 * create/upload/complete, findings, MCP tools, honest billing 503.
 */
import { createHash } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:3100";
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
}
async function call(path, { method = "GET", body, cookie, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

// 1. Local sign-in
const signin = await call("/api/auth/local", {
  method: "POST",
  body: { email: "smoke@example.com" },
});
const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0];
check("local sign-in", signin.status === 200 && cookie.includes("shield_session"));

// 2. /api/me shows trial plan + 15 Shields
const me = await call("/api/me", { cookie });
check(
  "me: trial + 15 shields",
  me.data?.plan?.id === "trial" && me.data?.balance === 15,
  `balance=${me.data?.balance}`,
);

// 3. Create project
const project = await call("/api/projects", {
  method: "POST",
  cookie,
  body: { name: "smoke-app" },
});
check("create project", project.status === 201, project.data?.id);

// 4. Device flow: start -> approve (web session) -> poll -> token
const start = await call("/api/cli/device/start", { method: "POST" });
check("device start", Boolean(start.data?.userCode));
await call("/api/device/approve", {
  method: "POST",
  cookie,
  body: { userCode: start.data.userCode },
});
const poll = await call("/api/cli/device/poll", {
  method: "POST",
  body: { deviceCode: start.data.deviceCode },
});
const token = poll.data?.token;
check(
  "device poll approved with CLI token",
  poll.data?.status === "approved" && typeof token === "string",
);

// 5. Scan with the CLI token: a route handler with no auth check
const filesContent = {
  "app/api/orders/route.ts":
    "export async function GET(req: Request) { const id = new URL(req.url).searchParams.get('id'); return Response.json(await db.orders.find(id)); }",
  "src/config.ts": "export const cfg = { debug: true };",
};
const manifest = Object.entries(filesContent).map(([path, content]) => ({
  path,
  sha256: createHash("sha256").update(content).digest("hex"),
  size: Buffer.byteLength(content),
}));
const scan = await call("/api/scans", {
  method: "POST",
  token,
  body: {
    projectId: project.data.id,
    action: "full",
    files: manifest,
    idempotencyKey: "smoke-scan-0001",
  },
});
check(
  "create scan costs 5 shields",
  scan.status === 201 && scan.data?.costShields === 5,
  JSON.stringify(scan.data),
);
const dup = await call("/api/scans", {
  method: "POST",
  token,
  body: {
    projectId: project.data.id,
    action: "full",
    files: manifest,
    idempotencyKey: "smoke-scan-0001",
  },
});
check("duplicate createScan is idempotent", dup.data?.scanId === scan.data?.scanId);
const meAfter = await call("/api/me", { cookie });
check(
  "balance debited once (15-5=10)",
  meAfter.data?.balance === 10,
  `balance=${meAfter.data?.balance}`,
);

for (const [path, content] of Object.entries(filesContent)) {
  const up = await call(`/api/scans/${scan.data.scanId}/files`, {
    method: "PUT",
    token,
    body: {
      path,
      sha256: manifest.find((m) => m.path === path).sha256,
      contentBase64: Buffer.from(content).toString("base64"),
    },
  });
  if (up.status !== 200) check(`upload ${path}`, false, JSON.stringify(up.data));
}
const complete = await call(`/api/scans/${scan.data.scanId}/complete`, { method: "POST", token });
check("complete scan", complete.status === 200, JSON.stringify(complete.data));
const scanView = await call(`/api/scans/${scan.data.scanId}`, { token });
check(
  "scan completed (stub provider)",
  scanView.data?.status === "completed",
  `status=${scanView.data?.status}`,
);

// 6. Findings recorded with evidence
const findings = await call(`/api/findings?projectId=${project.data.id}`, { token });
const routeFinding = (findings.data?.findings ?? []).find((f) => f.cwe === "CWE-862");
check(
  "findings include the unauthenticated route (CWE-862)",
  Boolean(routeFinding),
  `${findings.data?.findings?.length} findings`,
);
check("remediation tasks exist", (findings.data?.tasks ?? []).length >= 1);

// 7. MCP: tools/list + tools/call with the same token
const mcpList = await call("/api/mcp", {
  method: "POST",
  token,
  body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
});
check("MCP tools/list = 5 read-only tools", (mcpList.data?.result?.tools ?? []).length === 5);
const mcpCall = await call("/api/mcp", {
  method: "POST",
  token,
  body: {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_projects", arguments: {} },
  },
});
check(
  "MCP list_projects works",
  (mcpCall.data?.result?.content?.[0]?.text ?? "").includes("smoke-app"),
);
const mcpAnon = await call("/api/mcp", {
  method: "POST",
  body: {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_projects", arguments: {} },
  },
});
check("MCP without token is rejected", mcpAnon.status >= 400);

// 8. Billing without Polar config: honest 503
const checkout = await call("/api/billing/checkout", {
  method: "POST",
  cookie,
  body: { product: "indie" },
});
check(
  "checkout without Polar config -> 503 not configured",
  checkout.status === 503 && String(checkout.data?.error).includes("not configured"),
  `status=${checkout.status}`,
);

console.log(failures === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
