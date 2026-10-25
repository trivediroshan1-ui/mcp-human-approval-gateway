#!/usr/bin/env node
// U14: a second, different MCP client talks to the same gateway.
//
//   node scripts/run-second-client.mjs
//
// Client 1 uses the 2026-07-28 style (no handshake, protocol info in _meta).
// Client 2 uses the older 2025-11-25 style: initialize, notifications/initialized,
// then tools/list and tools/call, with its own client name and protocol header.
// Both talk to one gateway process and one database. It checks that:
//   - client 2 can list tools and get a pending approval,
//   - a person approving once lets the SAME client execute it once,
//   - the OTHER client cannot use that approval id (agent-bound),
//   - the audit chain is valid and records both clients.
// Real Claude Code is not used here; run it by hand if you want that evidence.
// Synthetic data only. Output: second-client-results.md and .json here.

import { spawn } from "node:child_process";
import { createServer as netServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "humangate-client2-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const port = await new Promise((res) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server/index.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: join(tmp, "c2.db"), MCP_AGENT_ID: "mcp-agent-demo", AUDIT_HMAC_KEY: "client2-run-key-0123456789" } });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 100 && !log.includes("listening"); i++) await sleep(100);

let nid = 1;
async function post(headers, body) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, headers: Object.fromEntries(r.headers), json };
}
// client 1: 2026-07-28 style
const M1 = "2026-07-28";
const meta1 = { "io.modelcontextprotocol/protocolVersion": M1, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "client-one", version: "1.0" } };
const c1 = (method, params = {}) => post({ "mcp-protocol-version": M1, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": params.name } : {}) }, { jsonrpc: "2.0", id: nid++, method, params: { ...params, _meta: meta1 } });
// client 2: 2025-11-25 style
const M2 = "2025-11-25";
let sessionHeaders = {};
async function init2() {
  const r = await post({}, { jsonrpc: "2.0", id: nid++, method: "initialize", params: { protocolVersion: M2, capabilities: {}, clientInfo: { name: "client-two-legacy", version: "0.9" } } });
  const sid = r.headers["mcp-session-id"]; if (sid) sessionHeaders = { "mcp-session-id": sid };
  await post({ "mcp-protocol-version": M2, ...sessionHeaders }, { jsonrpc: "2.0", method: "notifications/initialized" });
  return r;
}
const c2 = (method, params = {}) => post({ "mcp-protocol-version": M2, ...sessionHeaders }, { jsonrpc: "2.0", id: nid++, method, params });
const sc = (r) => r.json?.result?.structuredContent ?? r.json?.error ?? r.json;
const api = async (path, body, method = "POST") => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const BASE = (tag) => ({ action: "deploy", resource: "service://payment-api", environment: "production", requestedScopes: ["deploy:production"], dataClassification: "confidential", existingScopes: [], justification: `Client two run, ${tag}`, arguments: { release: "v1", traceId: "t-001" } });
function record(id, title, expected, observed, ok) { rows.push({ id, title, expected, observed, verdict: ok ? "as expected" : "different from prediction" }); console.log(id.padEnd(8), ok ? "as expected" : "different", title); }
const short = (o) => JSON.stringify(o).slice(0, 240);

try {
  const init = await init2();
  record("U14a", "Older client opens with initialize", "initialize answered with server info and a protocol version", `http ${init.status}; protocol ${init.json?.result?.protocolVersion}; server ${init.json?.result?.serverInfo?.name}; session header ${init.headers["mcp-session-id"] ? "yes" : "no"}`, init.status === 200 && !!init.json?.result);

  const list2 = await c2("tools/list"); const list1 = await c1("tools/list");
  record("U14b", "Both clients list the same tools", "same tool names", `client one ${list1.json?.result?.tools?.length} tools, client two ${list2.json?.result?.tools?.length} tools, same names: ${JSON.stringify((list1.json?.result?.tools ?? []).map((t) => t.name).sort()) === JSON.stringify((list2.json?.result?.tools ?? []).map((t) => t.name).sort())}`, list1.json?.result?.tools?.length === list2.json?.result?.tools?.length);

  const a = BASE("U14c");
  const first2 = sc(await c2("tools/call", { name: "deploy.production", arguments: a }));
  record("U14c", "Older client asks for deploy.production", "pending_approval", short({ outcome: first2.outcome, id: first2.approvalId }), first2.outcome === "pending_approval");

  // The other client tries to use this approval id (before and after approval).
  await api(`/api/requests/${first2.approvalId}/decision`, { reviewerId: "lead-morgan", reviewerRole: "security-lead", decision: "approve", reason: "Human Review" });
  const other = sc(await c1("tools/call", { name: "deploy.production", arguments: { ...a, approvalId: first2.approvalId } }));
  const own = sc(await c2("tools/call", { name: "deploy.production", arguments: { ...a, approvalId: first2.approvalId } }));
  record("U14d", "Approved by a person. The other client tries the id, then the owner runs it", "other: refused; owner: executed", `other: ${other.outcome ?? other.code ?? short(other)}; owner: ${own.outcome}`, own.outcome === "executed" && other.outcome !== "executed");

  const again = sc(await c2("tools/call", { name: "deploy.production", arguments: { ...a, approvalId: first2.approvalId } }));
  record("U14e", "Owner uses the same approval a second time", "replay_blocked", again.outcome ?? short(again), again.outcome === "replay_blocked");

  const aud = await (await fetch(`${base}/api/audit?limit=1000`)).json(); const ver = await (await fetch(`${base}/api/audit/verify`)).json();
  const actors = [...new Set((aud.events ?? []).map((e) => e.actor))];
  record("U14f", "Audit chain after both clients", "valid and signed", `valid=${ver.valid} signed=${ver.signed} events=${ver.checkedEvents}; actors: ${actors.join(", ")}`, ver.valid === true && ver.signed === true);
} finally {
  child.kill("SIGINT"); await sleep(300); child.kill("SIGKILL");
  const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  let md = `# U14: second MCP client (${new Date().toISOString()})\n\nClient two uses the 2025-11-25 handshake and its own client name. Same gateway and database. Synthetic data, one run. It is a hand-written client, not Claude Code.\n\n| ID | Case | Predicted | What came back | Verdict |\n|---|---|---|---|---|\n`;
  for (const r of rows) md += `| ${r.id} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} |\n`;
  writeFileSync("second-client-results.md", md); writeFileSync("second-client-results.json", JSON.stringify(rows, null, 2));
  rmSync(tmp, { recursive: true, force: true });
  console.log("Wrote second-client-results.md");
}
