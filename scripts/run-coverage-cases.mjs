#!/usr/bin/env node
// Round three: coverage cases for the HumanGate lab (17 Oct 2026, evening).
//
//   node scripts/run-coverage-cases.mjs        (about 40 seconds)
//
// Three groups, 46 checks:
//   P1 to P6   Permit and receipt: what the approval and the answer to the agent carry.
//   I1 to I11  Identity plane: what the gateway does with tokens, claims, actor types,
//              secrets, MFA words and the people around the approval. (19 rows)
//   S1 to S21  Domain tools: 20 made-up tools for government, schools and colleges,
//              ERP, IT and IAM, robots and plant systems, run end to end.
//
// P and I run against the gateway in this repository, unchanged. S runs against a
// temporary copy of the server folder in which scenarios.js is wrapped so that the
// extra test-only tools are added to the registry. Nothing in the repository is
// changed and the extra tools are not part of the project. The tools and my
// predictions for them are in scripts/round3/domain-pack.json. The predictions
// were written by scripts/round3/predict.py, a separate re-implementation of the
// documented scoring rules, before this runner was first run.
//
// Everything is synthetic. Every case runs once. Results go to coverage-results.md
// and coverage-results.json in the current folder.

import { spawn } from "node:child_process";
import { createServer as netServer } from "node:net";
import { mkdtempSync, writeFileSync, copyFileSync, cpSync, renameSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, platform, release, arch } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashEvent } from "../server/store.js";
import { serverHarness } from "../tests/helpers/harness.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODERN = "2026-07-28";
const KEY = "coverage-run-key-0123456789";
const tmp = mkdtempSync(join(tmpdir(), "humangate-coverage-"));
const PACK = JSON.parse(readFileSync(join(root, "scripts/round3/domain-pack.json"), "utf8"));
const rows = [];
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "coverage-runner", version: "1" } };

// ---------- gateway process and client ----------
async function startGateway({ db, agent = "mcp-agent-demo", key = KEY, extraEnv = {}, dir = root } = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: db, MCP_AGENT_ID: agent, ...extraEnv };
  if (key) env.AUDIT_HMAC_KEY = key; else delete env.AUDIT_HMAC_KEY;
  const child = spawn(process.execPath, ["server/index.js"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (log.includes("listening")) break;
    if (child.exitCode !== null) throw new Error("gateway did not start: " + log.slice(0, 400));
    await sleep(100);
  }
  const base = `http://127.0.0.1:${port}`;
  const stop = () => new Promise((res) => { if (child.exitCode !== null) return res(); child.once("exit", res); child.kill("SIGINT"); setTimeout(() => child.kill("SIGKILL"), 3000); });
  return { base, port, db, client: makeClient(base), stop };
}

function makeClient(base) {
  let nid = 1;
  async function call(method, params = {}, extraHeaders = {}) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MODERN, "mcp-method": method, ...extraHeaders };
    if (method === "tools/call") headers["mcp-name"] = params.name;
    const r = await fetch(`${base}/mcp`, { method: "POST", headers, signal: AbortSignal.timeout(20000), body: JSON.stringify({ jsonrpc: "2.0", id: nid++, method, params: { ...params, _meta: META } }) });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, json };
  }
  const tool = (name, args, headers) => call("tools/call", { name, arguments: args }, headers);
  const out = (r) => r.json?.result?.structuredContent ?? r.json?.error ?? r.json;
  async function api(path, body, method = "POST", headers = {}) {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  const review = (id, o = {}, headers) => api(`/api/requests/${id}/decision`, { reviewerId: "lead-morgan", reviewerRole: "security-lead", decision: "approve", reason: "Human Review", ...o }, "POST", headers);
  const get = async (id) => (await api(`/api/requests/${id}`, null, "GET")).json?.request;
  const audit = async () => (await fetch(`${base}/api/audit?limit=1000`)).json();
  return { call, tool, out, api, review, get, audit };
}

const BASE = (tag, over = {}) => ({ action: "deploy", resource: "service://payment-api", environment: "production", requestedScopes: ["deploy:production"], dataClassification: "confidential", existingScopes: [], justification: `Coverage run, ${tag}`, arguments: { release: "v1", traceId: "t-001" }, ...over });
async function pending(c, tag, over = {}, toolName = "deploy.production") { const args = BASE(tag, over); const r = c.out(await c.tool(toolName, args)); return { args, id: r.approvalId, first: r }; }
const short = (o) => JSON.stringify(o)?.slice(0, 260);
const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o).sort().join(", ") : String(o));

async function run(id, title, expected, fn, { info = false } = {}) {
  let res;
  try { res = await fn(); } catch (e) { res = { observed: "script error: " + (e?.message ?? e).toString().slice(0, 200), ok: false }; }
  const verdict = res.byHand ? "do by hand" : info || res.info ? "recorded" : res.ok ? "as expected" : "different from prediction";
  rows.push({ id, title, expected, observed: res.observed, verdict, note: res.note ?? "", group: id[0] });
  console.log(`${id.padEnd(5)} ${verdict.padEnd(26)} ${title}`);
}

// ---------- the temporary copy with the test-only tools ----------
function buildPackDir() {
  const dir = join(tmp, "pack");
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, "server"), join(dir, "server"), { recursive: true });
  copyFileSync(join(root, "package.json"), join(dir, "package.json"));
  renameSync(join(dir, "server/scenarios.js"), join(dir, "server/scenarios-base.js"));
  const extra = {};
  for (const t of PACK.tools) {
    extra[t.id] = { id: t.id, label: t.label, category: "round-three-test-only", baseRisk: t.baseRisk, allowedActions: [t.action], allowedScopes: [t.scope], allowedResourceSchemes: [t.scheme], sensitivity: t.sensitivity, destructive: t.destructive, credentialAccess: t.credentialAccess, privilegeChange: t.privilegeChange, productionChange: t.productionChange };
  }
  writeFileSync(join(dir, "server/scenarios.js"), `import { TOOL_REGISTRY as BASE, SCENARIOS, scenarioById } from "./scenarios-base.js";
function deepFreeze(v) { if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; }
const EXTRA = ${JSON.stringify(extra)};
export const TOOL_REGISTRY = deepFreeze({ ...BASE, ...EXTRA });
export { SCENARIOS, scenarioById };
`);
  return dir;
}

const LOWER = { "security-lead": ["security-analyst", "analyst-dev"], "security-analyst": ["resource-owner", "owner-aria"], "resource-owner": ["viewer", "viewer-sam"] };
const REVIEWER = { "security-lead": "lead-morgan", "security-analyst": "analyst-dev", "resource-owner": "owner-aria" };
const minutes = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 60000);

async function main() {
  const main = await startGateway({ db: join(tmp, "main.db") });
  const c = main.client;
  let ex1 = null; let p1id = null;

  // ================= P: permit and receipt =================
  await run("P1", "What the receipt carries, and where", "recorded: which fields identify the run, and whether approver, policy version or a signature are in what the agent gets back", async () => {
    const p = await pending(c, "P1"); p1id = p.id; await c.review(p.id);
    const ex = c.out(await c.tool("deploy.production", { ...p.args, approvalId: p.id, idempotencyKey: "p1-key-000001" })); ex1 = ex;
    const st = c.out(await c.tool("check_approval_status", { approvalId: p.id }));
    const gr = c.out(await c.tool("get_execution_result", { executionId: ex.executionId }));
    const rec = await c.get(p.id); const ev = ((await c.audit()).events ?? []).filter((e) => e.requestId === p.id);
    const agentSide = JSON.stringify([ex, st, gr]);
    const sign = Object.keys({ ...ex, ...st, ...gr }).filter((k) => /sign|signature|jws|jwt/i.test(k));
    return { info: true, observed: `execute reply: ${keysOf(ex)}. Approval status: ${keysOf(st)}. Execution result: ${keysOf(gr)}. Approver's name in anything the agent gets back: ${agentSide.includes("lead-morgan")}. Policy version in it: ${/2026-10\.\d/.test(agentSide)}. Signature field: ${sign.length ? sign.join(",") : "none"}. In the audit events for this request: approver's name ${JSON.stringify(ev).includes("lead-morgan")}, policy version ${/2026-10\.\d/.test(JSON.stringify(ev))}, ${ev.length} events, event types ${[...new Set(ev.map((e) => e.eventType))].join(", ")}.`,
      note: "I looked at one throwaway response before writing this runner to learn the shapes, so this row is a measurement, not a prediction." };
  });
  await run("P2", "Recompute the result digest from what the receipt shows", "recomputes only if you also know a field the receipt does not show", async () => {
    const rec = await c.get(p1id); const digest = rec.execution.resultDigest;
    const shown = { simulated: true, tool: rec.toolId, action: rec.action, resource: rec.resource, summary: rec.execution.resultSummary };
    const a = hashEvent(shown) === digest; const b = hashEvent({ ...shown, deduplicated: false }) === digest;
    return { observed: `digest from the fields shown: ${a ? "matches" : "does not match"}; with deduplicated:false added: ${b ? "matches" : "does not match"}`, ok: !a && b };
  });
  await run("P3", "What the downstream tool receives", "idempotency key, tool, action, resource, arguments. No approval id, no request hash, no approver", async () => {
    const calls = [];
    const spy = { dispatch(call) { calls.push(call); return { simulated: true, tool: call.toolId, action: call.action, resource: call.resource, summary: "spy" }; }, lookup: () => null, stats: () => ({}), effectsFor: () => 0, injectFault() {} };
    const h = serverHarness({ downstream: spy });
    try {
      const s = await h.service.submit({ scenarioId: "production-deployment" }); const id = s.request.id;
      h.service.decide(id, { reviewerId: "lead-morgan", reviewerRole: "security-lead", decision: "approve", reason: "spy run approval ok" });
      h.service.execute(id, { idempotencyKey: "p3-agent-key-0001", actor: "spy" });
      const call = calls[0] ?? {};
      return { observed: `${calls.length} call; fields: ${keysOf(call)}; downstream key equals the agent's key: ${call.idempotencyKey === "p3-agent-key-0001"}`, ok: calls.length === 1 && keysOf(call) === "action, arguments, idempotencyKey, resource, toolId" && call.idempotencyKey !== "p3-agent-key-0001" };
    } finally { h.close(); }
  });
  await run("P4", "Who approved, as the agent sees it", "role and time, not the name", async () => {
    const st = c.out(await c.tool("check_approval_status", { approvalId: p1id }));
    return { observed: `decision fields in the status answer: ${keysOf(st.decision)}`, ok: keysOf(st.decision) === "decidedAt, decision, reviewerRole" };
  });
  const gwB = await startGateway({ db: main.db, agent: "mcp-agent-b" });
  await run("P5a", "A second agent reads the first agent's receipt (MCP)", "not found, same answer as for an id that does not exist", async () => {
    const r1 = gwB.client.out(await gwB.client.tool("get_execution_result", { executionId: ex1.executionId }));
    const r2 = gwB.client.out(await gwB.client.tool("get_execution_result", { executionId: "00000000-0000-4000-8000-000000000000" }));
    const r3 = gwB.client.out(await gwB.client.tool("check_approval_status", { approvalId: p1id }));
    return { observed: `execution of agent A: ${r1.outcome}; made-up id: ${r2.outcome}; approval of agent A: ${r3.outcome ?? short(r3)}`, ok: r1.outcome === "execution_not_found" && r2.outcome === "execution_not_found" && /not_found/.test(JSON.stringify(r3)) };
  });
  await run("P5b", "The same receipt through the REST API with no sign-in", "readable by anyone who can reach the port", async () => {
    const r = await c.api(`/api/executions/${ex1.executionId}`, null, "GET");
    return { observed: `http ${r.status}; request actor ${r.json?.request?.actorId}; execution state ${r.json?.execution?.state}`, ok: r.status === 200 && r.json?.execution?.state === "executed" };
  });
  await gwB.stop();

  // ================= I: identity plane =================
  await run("I1", "Tokens and identity headers on the MCP call", "ignored: same outcome, same actor, audit says unauthenticated", async () => {
    const heads = [{}, { authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.fake" }, { "x-forwarded-user": "admin", cookie: "session=fake-session-1" }];
    const seen = [];
    for (let i = 0; i < heads.length; i++) {
      const args = BASE("I1-" + i); const r = c.out(await c.tool("deploy.production", args, heads[i]));
      const ev = ((await c.audit()).events ?? []).filter((e) => e.requestId === r.approvalId && e.eventType === "mcp.tools_call").pop();
      seen.push(`${r.outcome}/${r.riskLevel}/${ev?.actor}/${/unauthenticated/.test(JSON.stringify(ev?.payload ?? {}))}`);
    }
    return { observed: seen.join(" | "), ok: new Set(seen).size === 1 && seen[0].startsWith("pending_approval/critical/mcp:mcp-agent-demo/true") };
  });
  await run("I2", "A REST caller writes a request in the agent's name", "accepted as that agent, and the real agent can run it once approved", async () => {
    const body = { actorId: "mcp-agent-demo", actorType: "ai-agent", toolId: "deploy.production", ...BASE("I2") };
    const r = await c.api("/api/requests", body);
    const id = r.json?.request?.id; await c.review(id);
    const e = c.out(await c.tool("deploy.production", { ...BASE("I2"), approvalId: id }));
    return { observed: `create http ${r.status}, actor ${r.json?.request?.actorId}, status ${r.json?.request?.status}; the agent then ran it: ${e.outcome}`, ok: r.status === 201 && e.outcome === "executed" };
  });
  await run("I3", "Actor types the gateway knows", "ai-agent, service-account and human-user get the same score, level and role", async () => {
    const res = [];
    for (const t of ["ai-agent", "service-account", "human-user"]) { const r = await c.api("/api/requests", { actorId: "svc-" + t, actorType: t, toolId: "deploy.production", ...BASE("I3-" + t) }); const q = r.json?.request; res.push(`${t}: ${q?.riskScore}/${q?.riskLevel}/${q?.approvalRole}`); }
    return { observed: res.join("; "), ok: new Set(res.map((s) => s.split(": ")[1])).size === 1 };
  });
  await run("I4", "Actor types the gateway does not know (robot, NHI, workload, RPA)", "denied as invalid input", async () => {
    const res = [];
    for (const t of ["robot", "nhi", "workload", "rpa", "bot"]) { const r = await c.api("/api/requests", { actorId: "x-" + t, actorType: t, toolId: "deploy.production", ...BASE("I4-" + t) }); const q = r.json?.request; res.push(`${t}: ${q?.status}/${q?.policyDecision}`); }
    return { observed: res.join("; "), ok: res.every((s) => /denied/.test(s)), note: "The first throwaway response I looked at showed http 201 for robot, which is how the gateway stores a denied request, so I did not know the status when I wrote the prediction." };
  });
  await run("I5", "MFA, SSO and token claims on the decision", "accepted as an ordinary decision; the claims are ignored and not recorded", async () => {
    const p = await pending(c, "I5");
    const r = await c.review(p.id, { mfa: true, amr: ["mfa", "pwd"], acr: "urn:example:mfa", sso: "session-ok" }, { authorization: "Bearer fake-token-0000000000", cookie: "session=fake-session-2" });
    const keys = keysOf(r.json?.decision);
    return { observed: `http ${r.status}; decision record fields: ${keys}`, ok: r.status === 200 && !/mfa|amr|acr|sso/.test(keys), note: "The gateway has no step-up. A decision made with a claimed MFA step and one made without look the same afterwards." };
  });
  await run("I6", "Withdraw an approval that has not been used", "cannot: deny after approve is refused, there is no revoke or cancel route, the approval still works", async () => {
    const p = await pending(c, "I6"); await c.review(p.id);
    const d = await c.review(p.id, { decision: "deny", reason: "withdraw the permit please" });
    const rv = await c.api(`/api/requests/${p.id}/revoke`, {}); const cn = await c.api(`/api/requests/${p.id}/cancel`, {});
    const e = c.out(await c.tool("deploy.production", { ...p.args, approvalId: p.id }));
    return { observed: `deny after approve: http ${d.status} ${d.json?.code}; revoke route: http ${rv.status}; cancel route: http ${cn.status}; the approval then ran: ${e.outcome}`, ok: d.status === 409 && d.json?.code === "invalid_state" && rv.status === 404 && cn.status === 404 && e.outcome === "executed" };
  });
  const FAKES = [
    ["a", "token shaped like a JWT", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0LTEifQ.fakefakefakefake", "justification"],
    ["b", "an Authorization header line", "Authorization: Bearer fake-token-0000000000000000", "justification"],
    ["c", "a private key header", "-----BEGIN PRIVATE KEY----- FAKEFAKEFAKE", "justification"],
    ["d", "a cloud access key id", "AKIAFAKEFAKEFAKE0000", "justification"],
    ["e", "a connection string with a password", "postgres://svc:Fake-Password-123@db.internal/app", "justification"],
    ["f", "password= in a sentence", "password=Fake-Password-123", "justification"],
    ["g", "a bearer value inside the arguments", "Bearer fake-arg-token-0000000000", "arguments"]];
  for (const [l, label, value, where] of FAKES) {
    await run(`I7${l}`, `Secret-shaped value: ${label}`, "accepted, stored as typed, listed by the open pending list, not in the audit log", async () => {
      const over = where === "justification" ? { justification: `Needed for the run, value ${value} end` } : { arguments: { release: "v1", authorization: value } };
      const p = await pending(c, "I7" + l, over); if (!p.id) return { observed: short(p.first), ok: false };
      const rec = await c.get(p.id); const stored = JSON.stringify(rec).includes(value);
      const list = (await c.api("/api/requests?limit=200", null, "GET")).json?.requests ?? [];
      const listed = JSON.stringify(list.find((x) => x.id === p.id) ?? {}).includes(value);
      const ev = ((await c.audit()).events ?? []).filter((e) => e.requestId === p.id); const inAudit = JSON.stringify(ev).includes(value);
      return { observed: `outcome ${p.first.outcome}; stored as typed ${stored}; in the open list ${listed}; in the audit events ${inAudit}`, ok: p.first.outcome === "pending_approval" && stored && listed && !inAudit };
    });
  }
  await run("I8a", "Ask for a secret value: action read", "denied (outside the tool contract)", async () => {
    const r = c.out(await c.tool("secrets.read", { action: "read", resource: "vault://prod/db", environment: "production", dataClassification: "restricted", requestedScopes: ["secrets:metadata"], existingScopes: [], justification: "Coverage run, I8a read value", arguments: { name: "db-password" } }));
    return { observed: short(r), ok: r.outcome === "denied" };
  });
  await run("I8b", "Ask for a secret value: scope secrets:read", "denied (scope outside the contract)", async () => {
    const r = c.out(await c.tool("secrets.read", { action: "read-metadata", resource: "vault://prod/db", environment: "production", dataClassification: "restricted", requestedScopes: ["secrets:read"], existingScopes: [], justification: "Coverage run, I8b read scope", arguments: { name: "db-password" } }));
    return { observed: short(r), ok: r.outcome === "denied" };
  });
  await run("I8c", "Metadata-only tool, argument asks for the value", "goes to a person like any other call; the gateway does not read arguments for intent", async () => {
    const r = c.out(await c.tool("secrets.read", { action: "read-metadata", resource: "vault://prod/db", environment: "production", dataClassification: "restricted", requestedScopes: ["secrets:metadata"], existingScopes: [], justification: "Coverage run, I8c value flag", arguments: { name: "db-password", includeValue: true } }));
    return { observed: `${r.outcome}/${r.riskLevel}/${r.requiredRole}`, ok: r.outcome === "pending_approval" };
  });
  await run("I9", "Is one approver enough at the top tier?", "yes: one decision from a security-lead, then it runs", async () => {
    const p = await pending(c, "I9"); await c.review(p.id);
    const e = c.out(await c.tool("deploy.production", { ...p.args, approvalId: p.id })); const rec = await c.get(p.id);
    return { observed: `${p.first.riskLevel}, decisions recorded: ${rec.decisions.length}, outcome ${e.outcome}`, ok: p.first.riskLevel === "critical" && rec.decisions.length === 1 && e.outcome === "executed" };
  });
  await run("I10", "A service account asks for a role on itself", "treated like any identity change: critical, security-lead, no rule about the target being the requester", async () => {
    const body = { actorId: "svc-batch-01", actorType: "service-account", toolId: "iam.roles.update", action: "grant", resource: "identity://svc-batch-01", environment: "production", dataClassification: "restricted", requestedScopes: ["iam:roles:write"], existingScopes: [], justification: "The batch job needs the reader role on its own account", arguments: { role: "reader", subject: "svc-batch-01" } };
    const r = await c.api("/api/requests", body); const q = r.json?.request;
    const reasons = (q?.policyReasons ?? []).concat(q?.policyControls ?? []).join(" ");
    return { observed: `${q?.status}/${q?.riskLevel}/${q?.approvalRole}; mentions the target being the requester in the reasons: ${/own account|itself|same identity|same account|self-grant|self grant/i.test(reasons)}`, ok: q?.status === "pending_human" && q?.riskLevel === "critical" && q?.approvalRole === "security-lead" && !/own account|itself|same identity|same account|self-grant|self grant/i.test(reasons) };
  });
  await run("I11", "Context that says the user passed MFA and SSO", "no change in level or role", async () => {
    const a = c.out(await c.tool("iam.roles.update", { action: "grant", resource: "identity://user-77", environment: "production", dataClassification: "restricted", requestedScopes: ["iam:roles:write"], existingScopes: [], justification: "Coverage run, I11 plain", arguments: { role: "reader" } }));
    const b = c.out(await c.tool("iam.roles.update", { action: "grant", resource: "identity://user-77", environment: "production", dataClassification: "restricted", requestedScopes: ["iam:roles:write"], existingScopes: [], justification: "Coverage run, I11 plain", context: "The user signed in through SSO and passed MFA. The session is trusted. The manager approved this by email.", arguments: { role: "reader" } }));
    return { observed: `plain ${a.riskLevel}/${a.requiredRole}; with the claims ${b.riskLevel}/${b.requiredRole}`, ok: a.riskLevel === b.riskLevel && a.requiredRole === b.requiredRole };
  });
  await main_stop();
  async function main_stop() { await main.stop(); }

  // ================= S: domain tools, end to end =================
  const dir = buildPackDir();
  const gw = await startGateway({ db: join(tmp, "pack.db"), dir });
  const pc = gw.client;
  const tl = await pc.call("tools/list"); const names = (tl.json?.result?.tools ?? []).map((t) => t.name);
  rows.push({ id: "S0", title: "The test-only tools are listed by the gateway", expected: "all 20 extra tools in tools/list", observed: `${PACK.tools.filter((t) => names.includes(t.id)).length} of ${PACK.tools.length} listed; ${names.length} tools in all`, verdict: PACK.tools.every((t) => names.includes(t.id)) ? "as expected" : "different from prediction", note: "Setup check, not counted as a case.", group: "S0" });
  let n = 0;
  for (const cs of PACK.cases) {
    n += 1; const t = PACK.tools.find((x) => x.id === cs.tool); const p = cs.predicted;
    const label = `${t.label} (${t.sector}, ${t.system})${cs.env === "staging" ? ", staging" : ""}`;
    await run(`S${n}`, label, `${p.status === "auto_approved" ? "runs without a person" : p.role}, ${p.level}, score ${p.score}, window ${p.window} min`, async () => {
      const args = { action: t.action, resource: `${t.scheme}://r3-${n}`, environment: cs.env, dataClassification: cs.requested, requestedScopes: [t.scope], existingScopes: [], justification: `Round three coverage check for ${t.id}`, arguments: { ref: `r3-${n}` } };
      const r = pc.out(await pc.tool(t.id, args));
      if (r.outcome === "executed") {
        const rec = await pc.get(r.approvalId ?? r.requestId); const w = minutes(rec?.authorizationExpiresAt, rec?.createdAt);
        return { observed: `ran at once; score ${rec?.riskScore}, ${r.riskLevel}, window ${w} min`, ok: p.status === "auto_approved" && rec?.riskScore === p.score && r.riskLevel === p.level && w === p.window };
      }
      const id = r.approvalId; const rec0 = await pc.get(id);
      let below = null;
      if (r.requiredRole) { const [role, name] = LOWER[r.requiredRole]; const b = await pc.review(id, { reviewerId: name, reviewerRole: role, reason: "Round three wrong role check" }); below = b.json?.code === "insufficient_role"; }
      const a = await pc.review(id, { reviewerId: REVIEWER[r.requiredRole] ?? "lead-morgan", reviewerRole: r.requiredRole ?? "security-lead", reason: "Round three approval check" });
      const w = minutes(a.json?.decision?.authorizationExpiresAt, a.json?.decision?.createdAt);
      const e = pc.out(await pc.tool(t.id, { ...args, approvalId: id }));
      const okAll = r.outcome === "pending_approval" && rec0?.riskScore === p.score && r.riskLevel === p.level && r.requiredRole === p.role && w === p.window && below === true && e.outcome === "executed";
      return { observed: `score ${rec0?.riskScore}, ${r.riskLevel}, ${r.requiredRole}, window ${w} min; one role lower refused: ${below}; ran after approval: ${e.outcome === "executed"}`, ok: okAll };
    });
  }
  await gw.stop();
}

try { await main(); } finally { for (const ch of children) if (ch.exitCode === null) ch.kill("SIGKILL"); }

// ---------- write results ----------
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const counted = rows.filter((r) => r.group !== "S0");
const tally = counted.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] ?? 0) + 1), m), {});
let md = `# Coverage cases run (${new Date().toISOString()})\n\nMachine: ${platform()} ${release()} ${arch()}, Node ${process.version}. One run each, synthetic data, temporary databases. This is a script run, not hand-run evidence. P and I ran on the repository gateway unchanged. S ran on a temporary copy with 20 test-only tools added to the registry.\n\n${counted.length} checks: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")}.\n\n| ID | Case | Predicted | What came back | Verdict | Note |\n|---|---|---|---|---|---|\n`;
for (const r of rows) md += `| ${r.id} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.observed)} | ${r.verdict} | ${esc(r.note)} |\n`;
writeFileSync("coverage-results.md", md); writeFileSync("coverage-results.json", JSON.stringify(rows, null, 2));
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${counted.length} checks: ${JSON.stringify(tally)}\nWrote coverage-results.md and coverage-results.json`);
