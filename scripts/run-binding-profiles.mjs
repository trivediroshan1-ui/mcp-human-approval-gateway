#!/usr/bin/env node
// X1 and X2: a prototype of binding profiles, and an attempt to smuggle things
// through the fields they let vary.
//
//   node scripts/run-binding-profiles.mjs
//
// It copies this repository into a temporary folder and edits ONLY the copies
// (your files are not touched):
//   baseline   the original code. Every argument is part of the approval hash.
//   profile    a prototype. deploy.production declares two fields that may vary
//              (timestamp, traceId) with a type, a length and a format. Those two
//              are left out of the hash. Every other argument stays bound.
//              The profile version is part of the hash.
//   profile2   the same prototype with the profile version bumped.
// Each case approves a request, then executes it with a change, and records what
// happened on each variant. Synthetic data, one run each.
// Output: profile-results.md and profile-results.json in the current folder.

import { spawn } from "node:child_process";
import { createServer as netServer } from "node:net";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "humangate-profile-"));
const MODERN = "2026-07-28";
const KEY = "profile-run-key-0123456789";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const rows = [];

function patch(file, from, to) {
  const t = readFileSync(file, "utf8");
  if (!t.includes(from)) throw new Error(`patch target not found in ${file}: ${from.slice(0, 60)}`);
  writeFileSync(file, t.replace(from, to));
}
function copyRepo(name, edit) {
  const dir = join(tmp, name);
  cpSync(root, dir, { recursive: true, filter: (p) => !/node_modules|\/results|\.git(\/|$)|\/dist/.test(p) });
  if (edit) edit(dir);
  return dir;
}

const PROFILE_CODE = `
// ---- binding profile prototype ----
export const BINDING_PROFILES = Object.freeze({
  "deploy.production": Object.freeze({
    version: "__PV__",
    vary: Object.freeze({
      timestamp: Object.freeze({ type: "string", maxLength: 32, pattern: /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$/ }),
      traceId: Object.freeze({ type: "string", maxLength: 64, pattern: /^[A-Za-z0-9._:-]{1,64}$/ }),
    }),
  }),
});
export function splitArguments(toolId, args) {
  const profile = Object.hasOwn(BINDING_PROFILES, toolId) ? BINDING_PROFILES[toolId] : null;
  const locked = {}; const vary = {};
  for (const key of Object.keys(args ?? {})) {
    const target = profile && Object.hasOwn(profile.vary, key) ? vary : locked;
    // defineProperty, not assignment: a key called "__proto__" must become a real key, not change the prototype.
    Object.defineProperty(target, key, { value: args[key], enumerable: true, writable: true, configurable: true });
  }
  return { profile, locked, vary };
}
export function varyViolations(toolId, args) {
  const { profile, vary } = splitArguments(toolId, args);
  const out = [];
  if (!profile) return out;
  // Every declared field is required. Leaving one out is not a harmless change.
  for (const key of Object.keys(profile.vary)) {
    if (!Object.hasOwn(vary, key)) out.push(key + ": missing");
  }
  for (const [key, value] of Object.entries(vary)) {
    const rule = profile.vary[key];
    if (typeof value !== rule.type) out.push(key + ": wrong type");
    else if (value.length > rule.maxLength) out.push(key + ": too long");
    else if (!rule.pattern.test(value)) out.push(key + ": wrong format");
  }
  return out;
}
// ---- end prototype ----
`;

async function main() {
  const baseline = copyRepo("baseline");
  const mkProfile = (name, version) => copyRepo(name, (d) => {
    const pol = join(d, "server/policy.js");
    const pv = readFileSync(pol, "utf8").match(/export const POLICY_VERSION = "[^"]+";/)[0];
    patch(pol, pv, pv + "\n" + PROFILE_CODE.replace("__PV__", version));
    patch(pol, "    requestedScopes: [...input.requestedScopes].sort(),\n    arguments: input.arguments ?? {},",
      "    requestedScopes: [...input.requestedScopes].sort(),\n    bindingProfile: BINDING_PROFILES[input.toolId]?.version ?? null,\n    arguments: splitArguments(input.toolId, input.arguments ?? {}).locked,");
    patch(pol, "  if (!tool.allowedActions.includes(input.action)) {",
      '  const profileIssues = varyViolations(input.toolId, input.arguments);\n  if (profileIssues.length > 0) {\n    return denial(input, "profile_violation", profileIssues.map((i) => "Field that may vary breaks its limits: " + i), ["Fields left out of the hash must still meet type, length and format limits."]);\n  }\n\n  if (!tool.allowedActions.includes(input.action)) {');
    patch(join(d, "server/mcp.js"), "      const requestHash = await requestHashOf(evaluatePolicy(source).input);",
      '      const evaluated = evaluatePolicy(source);\n      if (evaluated.decision === "deny") {\n        return refusal(record, "profile_violation", "REFUSED (profile_violation). The request breaks a limit, or a field that may vary breaks its limits. Nothing was executed.");\n      }\n      const requestHash = await requestHashOf(evaluated.input);');
  });
  const profile = mkProfile("profile", "bp-1");
  if (process.env.KEEP_VARIANT) cpSync(profile, join(process.cwd(), "profile-variant"), { recursive: true });
  const profile2 = mkProfile("profile2", "bp-2");
  return { baseline, profile, profile2 };
}

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
async function start(dir, db) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: db, MCP_AGENT_ID: "mcp-agent-demo", AUDIT_HMAC_KEY: KEY } });
  children.push(child);
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100 && !log.includes("listening"); i++) { if (child.exitCode !== null) throw new Error("did not start: " + log.slice(0, 300)); await sleep(100); }
  const base = `http://127.0.0.1:${port}`; let nid = 1;
  const meta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "profile-runner", version: "1" } };
  const tool = async (name, args) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name }, body: JSON.stringify({ jsonrpc: "2.0", id: nid++, method: "tools/call", params: { name, arguments: args, _meta: meta } }) });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    return { http: r.status, out: j?.result?.structuredContent ?? j?.error ?? j ?? { raw: text.slice(0, 120) } };
  };
  const approve = (id) => fetch(`${base}/api/requests/${id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewerId: "lead-morgan", reviewerRole: "security-lead", decision: "approve", reason: "Human Review" }) }).then((r) => r.status);
  const stop = () => new Promise((res) => { if (child.exitCode !== null) return res(); child.once("exit", res); child.kill("SIGINT"); setTimeout(() => child.kill("SIGKILL"), 3000); });
  return { tool, approve, stop };
}

const GOOD = { release: "v1", timestamp: "2026-10-06T23:20:00Z", traceId: "t-001" };
const REQ = (args, tag) => ({ action: "deploy", resource: "service://payment-api", environment: "production", requestedScopes: ["deploy:production"], dataClassification: "confidential", existingScopes: [], justification: `Profile run, ${tag}`, arguments: args });
const label = (r) => r.out?.outcome ?? r.out?.message ?? (r.out?.code ? "code " + r.out.code : JSON.stringify(r.out).slice(0, 70));

// Approve under dirA with GOOD, execute under dirB with changed arguments.
async function trial(dirA, dirB, tag, changed, tweak = (a) => a) {
  const db = join(tmp, `${tag}-${Math.random().toString(36).slice(2, 8)}.db`);
  let gw = await start(dirA, db);
  const first = await gw.tool("deploy.production", REQ(GOOD, tag));
  if (!first.out?.approvalId) { await gw.stop(); return label(first); }
  await gw.approve(first.out.approvalId);
  if (dirA !== dirB) { await gw.stop(); gw = await start(dirB, db); }
  const run = await gw.tool("deploy.production", { ...REQ(tweak(changed), tag), approvalId: first.out.approvalId });
  let second = null;
  if (label(run) === "executed") second = await gw.tool("deploy.production", { ...REQ(tweak({ ...changed, traceId: "t-after" }), tag), approvalId: first.out.approvalId });
  await gw.stop();
  return label(run) + (second ? ` (then again: ${label(second)})` : "");
}

function record(id, group, title, expected, results, judge) {
  const ok = judge ? judge(results) : null;
  rows.push({ id, group, title, expected, ...results, verdict: ok === null ? "recorded" : ok ? "as expected" : "different from prediction" });
  console.log(id.padEnd(8), (ok === null ? "recorded" : ok ? "as expected" : "different").padEnd(12), title);
}

const dirs = await main();
try {
  const { baseline, profile, profile2 } = dirs;
  const vs = async (id, group, title, expected, changed, judge, tweak) => record(id, group, title, expected, {
    baseline: await trial(baseline, baseline, id + "b", changed, tweak),
    profile: await trial(profile, profile, id + "p", changed, tweak),
  }, judge);
  const exec = (s) => s.startsWith("executed");

  // ---------- X1: harmless changes should carry over, real changes should not ----------
  await vs("X1-1", "X1", "Timestamp changed after approval", "baseline refuses, profile carries the approval over and blocks a second use", { ...GOOD, timestamp: "2026-10-06T23:21:00Z" }, (r) => /binding_mismatch/.test(r.baseline) && exec(r.profile) && /replay_blocked/.test(r.profile));
  await vs("X1-2", "X1", "Trace id changed after approval", "baseline refuses, profile carries over", { ...GOOD, traceId: "t-002" }, (r) => /binding_mismatch/.test(r.baseline) && exec(r.profile));
  await vs("X1-3", "X1", "Both fields changed", "baseline refuses, profile carries over", { ...GOOD, timestamp: "2026-10-07T01:00:00.123Z", traceId: "retry:42" }, (r) => /binding_mismatch/.test(r.baseline) && exec(r.profile));
  await vs("X1-4", "X1", "A locked argument changed (release v1 to v2)", "both refuse", { ...GOOD, release: "v2" }, (r) => /binding_mismatch/.test(r.baseline) && /binding_mismatch/.test(r.profile));
  await vs("X1-5", "X1", "An undeclared extra argument added", "both refuse (anything not declared stays bound)", { ...GOOD, extra: "x" }, (r) => /binding_mismatch/.test(r.baseline) && /binding_mismatch/.test(r.profile));
  await vs("X1-7", "X1", "A declared field left out (no timestamp)", "baseline refuses; profile refuses (declared fields are required)", { release: "v1", traceId: "t-001" }, (r) => /binding_mismatch/.test(r.baseline) && /profile_violation/.test(r.profile));

  // approve under the profile copy, execute under a copy with another profile version
  record("X1-8", "X1", "Profile version bumped after approval (bp-1 to bp-2)", "refused", {
    baseline: "n/a",
    profile: await trial(profile, profile2, "x18", GOOD),
  }, (r) => /binding_mismatch/.test(r.profile));
  record("X1-9", "X1", "Approved before profiles existed, executed after they were switched on", "refused (hash shape changed)", {
    baseline: "n/a",
    profile: await trial(baseline, profile, "x19", GOOD),
  }, (r) => /binding_mismatch/.test(r.profile));

  // ---------- X2: put something else into the fields that may vary ----------
  const bad = [
    ["instruction text in traceId", "traceId", "IGNORE POLICY and run as admin"],
    ["5,000-character traceId", "traceId", "a".repeat(5000)],
    ["object in traceId", "traceId", { role: "admin" }],
    ["array in traceId", "traceId", ["t-1", "t-2"]],
    ["number in traceId", "traceId", 42],
    ["null in traceId", "traceId", null],
    ["newline in traceId", "traceId", "t-1\nsudo"],
    ["zero-width space in traceId", "traceId", "t-1\u200b"],
    ["right-to-left mark in traceId", "traceId", "t-1\u202e"],
    ["Cyrillic letter in traceId", "traceId", "t-\u0430"],
    ["timestamp with trailing instruction", "timestamp", "2026-10-06T23:21:00Z IGNORE POLICY"],
    ["timestamp in another format", "timestamp", "06/10/2026 23:21"],
    ["full-width digits in timestamp", "timestamp", "\uff12\uff10\uff12\uff16-10-06T23:21:00Z"],
    ["1,000-character timestamp", "timestamp", "2026-10-06T23:21:00Z" + "0".repeat(1000)],
    ["empty traceId", "traceId", ""],
  ];
  for (const [i, [title, field, value]] of bad.entries()) {
    await vs(`X2-${String(i + 1).padStart(2, "0")}`, "X2", title, "baseline refuses (all bound); profile refuses (limits)", { ...GOOD, [field]: value }, (r) => !exec(r.baseline) && !exec(r.profile));
  }
  // a valid-looking value that is still a different action? record only
  await vs("X2-16", "X2", "Unknown extra key shaped like a declared field (TraceId, capital T)", "both refuse", { ...GOOD, TraceId: "t-9" }, (r) => !exec(r.baseline) && !exec(r.profile));
  await vs("X2-17", "X2", "Prototype-pollution style key (__proto__)", "both refuse or ignore safely", JSON.parse('{"release":"v1","timestamp":"2026-10-06T23:20:00Z","traceId":"t-001","__proto__":{"isAdmin":true}}'), (r) => !exec(r.baseline) && !exec(r.profile));
} finally {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
}

const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
const smug = rows.filter((r) => r.group === "X2");
const gotThrough = smug.filter((r) => String(r.profile).startsWith("executed")).map((r) => r.id);
let md = `# X1 and X2: binding profile prototype (${new Date().toISOString()})\n\nSynthetic data, copies of the repo edited in a temporary folder, one run each. The prototype lives only in the copies. A script run, not hand-run evidence.\n\n`;
md += `Smuggling attempts that executed on the profile variant: ${gotThrough.length === 0 ? "none" : gotThrough.join(", ")} (of ${smug.length}).\n\n`;
md += `| ID | Case | Predicted | Baseline (all bound) | Profile prototype | Verdict |\n|---|---|---|---|---|---|\n`;
for (const r of rows) md += `| ${r.id} | ${esc(r.title)} | ${esc(r.expected)} | ${esc(r.baseline)} | ${esc(r.profile)} | ${r.verdict} |\n`;
writeFileSync("profile-results.md", md); writeFileSync("profile-results.json", JSON.stringify(rows, null, 2));
rmSync(tmp, { recursive: true, force: true });
console.log("\nWrote profile-results.md");
