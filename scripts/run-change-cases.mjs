#!/usr/bin/env node
// U15 and U16: what happens when the rules or a tool definition change between
// creating a request, approving it and running it.
//
//   node scripts/run-change-cases.mjs
//
// It copies this repository twice into a temporary folder (your files are not
// touched), edits only the copies, and starts each copy against the same temporary
// database:
//   copy A  original code
//   copy B  POLICY_VERSION changed by adding -b (U15)
//   copy C  the deploy.production definition loosened (U16): lower base risk, no
//           production flag, wider scopes and resource schemes
// Synthetic data only. Output: change-results.md and change-results.json here.

import { spawn } from "node:child_process";
import { createServer as netServer } from "node:net";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "humangate-change-"));
const MODERN = "2026-07-28";
const KEY = "change-run-key-0123456789";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const children = [];

function copyRepo(name, edit) {
  const dir = join(tmp, name);
  cpSync(root, dir, { recursive: true, filter: (p) => !/node_modules|\/results|\.git(\/|$)|\/dist/.test(p) });
  if (edit) edit(dir);
  return dir;
}
function patch(file, from, to) {
  const t = readFileSync(file, "utf8");
  if (!t.includes(from)) throw new Error(`patch target not found in ${file}: ${from}`);
  writeFileSync(file, t.replace(from, to));
}
const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

async function start(dir, db) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: db, MCP_AGENT_ID: "mcp-agent-demo", AUDIT_HMAC_KEY: KEY } });
  children.push(child);
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100 && !log.includes("listening"); i++) { if (child.exitCode !== null) throw new Error("did not start: " + log.slice(0, 300)); await sleep(100); }
  const base = `http://127.0.0.1:${port}`;
  let nid = 1;
  const meta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "change-runner", version: "1" } };
  const tool = async (name, args) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name }, body: JSON.stringify({ jsonrpc: "2.0", id: nid++, method: "tools/call", params: { name, arguments: args, _meta: meta } }) });
    const j = await r.json().catch(() => null); return j?.result?.structuredContent ?? j?.error ?? j;
  };
  const api = async (path, body, method = "POST") => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const approve = (id) => api(`/api/requests/${id}/decision`, { reviewerId: "lead-morgan", reviewerRole: "security-lead", decision: "approve", reason: "Human Review" });
  const verify = async () => (await fetch(`${base}/api/audit/verify`)).json();
  const stop = () => new Promise((res) => { if (child.exitCode !== null) return res(); child.once("exit", res); child.kill("SIGINT"); setTimeout(() => child.kill("SIGKILL"), 3000); });
  return { tool, api, approve, verify, stop, base };
}

const BASE = (tag) => ({ action: "deploy", resource: "service://payment-api", environment: "production", requestedScopes: ["deploy:production"], dataClassification: "confidential", existingScopes: [], justification: `Change run, ${tag}`, arguments: { release: "v1", traceId: "t-001" } });
const show = (o) => JSON.stringify({ outcome: o?.outcome, code: o?.code ?? o?.denyCode, message: (o?.message ?? o?.reason ?? "").toString().slice(0, 90), status: o?.status }).slice(0, 260);
function record(id, title, expected, observed, ok, note = "") { rows.push({ id, title, expected, observed, verdict: ok === null ? "recorded" : ok ? "as expected" : "different from prediction", note }); console.log(id.padEnd(10), (ok === null ? "recorded" : ok ? "as expected" : "different").padEnd(12), title); }

async function main() {
  const A = copyRepo("a");
  const B = copyRepo("b", (d) => { const f = join(d, "server/policy.js"); writeFileSync(f, readFileSync(f, "utf8").replace(/POLICY_VERSION = "([^"]+)"/, 'POLICY_VERSION = "$1-b"')); });
  const C = copyRepo("c", (d) => {
    const f = join(d, "server/scenarios.js");
    patch(f, '    baseRisk: 78,\n    allowedActions: ["deploy"],\n    allowedScopes: ["deploy:production"],\n    allowedResourceSchemes: ["service"],\n    sensitivity: "confidential",\n    destructive: false,\n    credentialAccess: false,\n    privilegeChange: false,\n    productionChange: true,',
      '    baseRisk: 10,\n    allowedActions: ["deploy", "delete"],\n    allowedScopes: ["deploy:production", "secrets:read"],\n    allowedResourceSchemes: ["service", "storage"],\n    sensitivity: "confidential",\n    destructive: false,\n    credentialAccess: false,\n    privilegeChange: false,\n    productionChange: false,');
  });

  // ---- U15a: approved under A, executed under B (policy version changed after approval)
  let db = join(tmp, "u15a.db");
  let gw = await start(A, db); const a1 = BASE("U15a"); const f1 = await gw.tool("deploy.production", a1); await gw.approve(f1.approvalId); await gw.stop();
  gw = await start(B, db); const e1 = await gw.tool("deploy.production", { ...a1, approvalId: f1.approvalId }); const v1 = await gw.verify(); await gw.stop();
  record("U15a", "Policy version bumped after approval, then execute", "refused (policy version is in the hash)", show(e1) + ` | audit valid=${v1.valid}`, /mismatch|integrity|not_authorized|rejected|denied/i.test(JSON.stringify(e1)) && !/executed/.test(e1?.outcome ?? ""));

  // ---- U15b: created under A (pending), approved under B
  db = join(tmp, "u15b.db");
  gw = await start(A, db); const f2 = await gw.tool("deploy.production", BASE("U15b")); await gw.stop();
  gw = await start(B, db); const d2 = await gw.approve(f2.approvalId); const st2 = await gw.api(`/api/requests/${f2.approvalId}`, null, "GET"); await gw.stop();
  record("U15b", "Policy version bumped while the request is still pending, then a person approves", "refused or flagged (hash no longer matches)", `decision http ${d2.status} ${d2.json?.code ?? d2.json?.error ?? ""}; request status ${st2.json?.request?.status}`, d2.status !== 200);

  // ---- U15c: a fresh request under B works normally
  db = join(tmp, "u15c.db");
  gw = await start(B, db); const f3 = await gw.tool("deploy.production", BASE("U15c")); await gw.approve(f3.approvalId); const e3 = await gw.tool("deploy.production", { ...BASE("U15c"), approvalId: f3.approvalId }); await gw.stop();
  record("U15c", "Control: new request created, approved and run entirely under the new policy version", "executed", show(e3), e3?.outcome === "executed");

  // ---- U16a: approved under A, executed under C (tool definition loosened after approval)
  db = join(tmp, "u16a.db");
  gw = await start(A, db); const a4 = BASE("U16a"); const f4 = await gw.tool("deploy.production", a4); await gw.approve(f4.approvalId); await gw.stop();
  gw = await start(C, db); const e4 = await gw.tool("deploy.production", { ...a4, approvalId: f4.approvalId }); const v4 = await gw.verify(); await gw.stop();
  const hasFix = readFileSync(join(root, "server/policy.js"), "utf8").includes("toolDefinitionText");
  const ran = e4?.outcome === "executed";
  record("U16a", "Tool definition loosened after approval (lower risk, wider scopes), then execute",
    hasFix ? "refused (this copy puts the tool definition into the approved hash)" : "predicted: runs, because only the tool id is in the hash",
    show(e4) + ` | audit valid=${v4.valid}`, hasFix ? !ran : ran,
    ran ? "A run means an approval given for the old definition covers the new one." : "The approval did not carry over to the changed definition.");

  // ---- U16b: new request with the looser definition: does the risk drop?
  db = join(tmp, "u16b.db");
  gw = await start(C, db); const f5 = await gw.tool("deploy.production", { ...BASE("U16b"), requestedScopes: ["deploy:production", "secrets:read"] }); await gw.stop();
  record("U16b", "Control: with the loosened definition, a request for an extra scope", "no longer denied; risk lower than before", show(f5) + ` level=${f5?.riskLevel ?? f5?.level ?? "?"}`, null, "Shows what a changed definition can allow.");
}

try { await main(); } finally { for (const c of children) if (c.exitCode === null) c.kill("SIGKILL"); }

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");
let md = `# Change cases U15 and U16 (${new Date().toISOString()})\n\nSynthetic data, temporary databases, copies of the repo edited in a temporary folder. One run each. A script run, not hand-run evidence.\n\n| ID | Case | Predicted | What came back | Verdict | Note |\n|---|---|---|---|---|---|\n`;
for (const r of rows) md += `| ${r.id} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${esc(r.note)} |\n`;
writeFileSync("change-results.md", md); writeFileSync("change-results.json", JSON.stringify(rows, null, 2));
rmSync(tmp, { recursive: true, force: true });
console.log("Wrote change-results.md");
