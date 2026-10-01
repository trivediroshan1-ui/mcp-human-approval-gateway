// MCP server tests. They start the real HTTP server and drive it with raw
// JSON-RPC, the way an MCP client would, so they cover the wire format and
// the gateway behind it. Revision under test: 2026-07-28, plus the
// initialize-based 2025-11-25 era on the same endpoint.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createMcpServer } from "../server/mcp.js";
import { TOOL_REGISTRY } from "../server/scenarios.js";
import {
  AGENT_ID,
  AUDIT_KEY,
  LEGACY_VERSION,
  MODERN_VERSION,
  SCENARIOS,
  modernHeaders,
  modernMessage,
  scenarioArguments,
  startMcpFixture,
  validateSubset,
} from "./helpers/mcp-fixture.js";

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const approverFor = { "resource-owner": "owner-aria", "security-analyst": "analyst-dev", "security-lead": "lead-morgan" };

// fetch() will not let a script set the Host header, so the rebinding cases
// use node:http, which sends exactly what it is given.
function postWithHost(baseUrl, headers, body) {
  const url = new URL(`${baseUrl}/mcp`);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function withFixture(t, options) {
  const app = await startMcpFixture(options);
  t.after(() => app.close());
  return app;
}

function structured(response) {
  return response.json.result.structuredContent;
}

// ------------------------------------------------------------ lifecycle

test("2026-07-28: server/discover and tools/list work with no handshake", async (t) => {
  const app = await withFixture(t);
  const discover = await app.call("server/discover");
  assert.equal(discover.status, 200);
  const result = discover.json.result;
  assert.equal(result.resultType, "complete");
  assert.deepEqual(result.supportedVersions, [MODERN_VERSION, LEGACY_VERSION]);
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "mcp-human-approval-gateway");
  assert.equal(typeof result.ttlMs, "number");
  assert.equal(result.cacheScope, "public");

  const list = await app.call("tools/list");
  assert.equal(list.status, 200);
  assert.equal(list.json.result.resultType, "complete");
  assert.equal(list.json.result.tools.length, Object.keys(TOOL_REGISTRY).length + 1);
});

test("2025-11-25: initialize, initialized notification, ping and tools/list", async (t) => {
  const app = await withFixture(t);
  const init = await app.post(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: "legacy-test", version: "1" } },
    },
    JSON_HEADERS,
  );
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, LEGACY_VERSION);
  assert.deepEqual(init.json.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.json.result.serverInfo.name, "mcp-human-approval-gateway");
  assert.equal(init.json.result.resultType, undefined);
  assert.equal(init.headers.get("mcp-session-id"), null, "no session id is minted");

  const legacyHeaders = { ...JSON_HEADERS, "mcp-protocol-version": LEGACY_VERSION };
  const initialized = await app.post({ jsonrpc: "2.0", method: "notifications/initialized" }, legacyHeaders);
  assert.equal(initialized.status, 202);
  assert.equal(initialized.text, "");

  const ping = await app.post({ jsonrpc: "2.0", id: 2, method: "ping" }, legacyHeaders);
  assert.deepEqual(ping.json, { jsonrpc: "2.0", id: 2, result: {} });

  const list = await app.post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, legacyHeaders);
  assert.equal(list.status, 200);
  assert.ok(list.json.result.tools.length > 0);
  assert.equal(list.json.result.resultType, undefined);
});

test("ping is not part of 2026-07-28 and is answered with method not found", async (t) => {
  const app = await withFixture(t);
  const ping = await app.call("ping");
  assert.equal(ping.status, 404);
  assert.equal(ping.json.error.code, -32601);
});

test("initialize rejects a request without clientInfo", async (t) => {
  const app = await withFixture(t);
  const bad = await app.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY_VERSION, capabilities: {} } }, JSON_HEADERS);
  assert.equal(bad.json.error.code, -32602);
});

// ------------------------------------------------------------ tools/list

test("tools/list returns valid, stable, honestly annotated tool definitions", async (t) => {
  const app = await withFixture(t);
  const first = (await app.call("tools/list")).json.result.tools;
  const second = (await app.call("tools/list")).json.result.tools;
  assert.deepEqual(first, second, "order and content are deterministic");

  const names = first.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.slice(0, -1), Object.keys(TOOL_REGISTRY));
  assert.equal(names.at(-1), "check_approval_status");

  for (const tool of first) {
    assert.match(tool.name, /^[A-Za-z0-9_.-]{1,128}$/);
    assert.equal(typeof tool.description, "string");
    const schema = tool.inputSchema;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(Object.keys(schema.properties).length > 0);
    for (const required of schema.required) assert.ok(required in schema.properties, `${tool.name}.${required}`);
    for (const [key, property] of Object.entries(schema.properties)) {
      assert.ok(property.type, `${tool.name}.${key} has a type`);
      if (property.enum) assert.ok(property.enum.length > 0 && property.enum.every((v) => typeof v === "string"));
    }
    assert.equal(tool.outputSchema.type, "object");
    assert.ok(tool.outputSchema.required.includes("outcome"));
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(tool.annotations.openWorldHint, false);
  }

  const byName = Object.fromEntries(first.map((tool) => [tool.name, tool]));
  assert.equal(byName["docs.search"].annotations.readOnlyHint, true);
  assert.equal(byName["repo.read"].annotations.readOnlyHint, true);
  assert.equal(byName["storage.delete"].annotations.readOnlyHint, false);
  assert.equal(byName["storage.delete"].annotations.destructiveHint, true);
  assert.equal(byName["ticket.create"].annotations.destructiveHint, false);
  assert.equal(byName["check_approval_status"].annotations.readOnlyHint, true);
  assert.deepEqual(byName["docs.search"].inputSchema.properties.action.enum, ["read"]);
  assert.ok(!("actorId" in byName["docs.search"].inputSchema.properties), "a client cannot choose its identity");
});

test("tools/list refuses a cursor because none is ever issued", async (t) => {
  const app = await withFixture(t);
  const response = await app.call("tools/list", { cursor: "abc" });
  assert.equal(response.json.error.code, -32602);
});

// ------------------------------------------------------------ the nine scenarios

for (const scenario of SCENARIOS) {
  test(`scenario "${scenario.id}" through tools/call: ${scenario.expected}`, async (t) => {
    const app = await withFixture(t);
    const response = await app.tool(scenario.request.toolId, scenarioArguments(scenario));
    const { expect } = scenario;

    if (scenario.id === "unknown-tool") {
      assert.equal(response.json.error.code, -32602, "unknown tool is a protocol error");
      assert.match(response.json.error.message, /Unknown tool/);
      assert.equal(response.json.result, undefined);
      assert.equal(response.json.error.data.denyCode, "unregistered_tool");
      const record = app.service.get(response.json.error.data.requestId);
      assert.equal(record.status, "denied");
      assert.equal(record.executionId ?? null, null, "nothing ran");
      return;
    }

    assert.equal(response.status, 200);
    const result = response.json.result;
    assert.equal(result.resultType, "complete");
    const out = result.structuredContent;
    assert.deepEqual(validateSubset(app.mcp.tools.find((tool) => tool.name === scenario.request.toolId).outputSchema, out), []);
    // An auto-approved call has already been consumed by the time it returns.
    assert.equal(out.status, expect.status === "auto_approved" ? "executed" : expect.status);
    assert.equal(out.riskLevel, expect.riskLevel);
    assert.equal(out.requiredRole, expect.approvalRole);

    const record = app.service.get(out.requestId);
    assert.equal(record.actorId, AGENT_ID, "identity comes from configuration, not the client");

    if (expect.status === "auto_approved") {
      assert.equal(result.isError, false);
      assert.equal(out.outcome, "executed");
      assert.equal(out.simulated, true);
      assert.equal(app.service.get(out.requestId).status, "executed");
    } else if (expect.status === "pending_human") {
      assert.equal(result.isError, false);
      assert.equal(out.outcome, "pending_approval");
      assert.match(result.content[0].text, /^NOT EXECUTED/);
      assert.match(result.content[0].text, new RegExp(out.requestId));
      assert.equal(app.service.get(out.requestId).executionId ?? null, null);
    } else if (expect.status === "denied") {
      assert.equal(result.isError, true);
      assert.equal(out.outcome, "denied");
      assert.equal(out.denyCode, expect.denyCode);
      assert.match(result.content[0].text, /^DENIED/);
    } else if (expect.status === "gate_rejected") {
      assert.equal(result.isError, true);
      assert.equal(out.outcome, "rejected_by_gate");
      assert.match(result.content[0].text, /^NOT SENT TO A HUMAN/);
    }
  });
}

// ------------------------------------------------------------ approval flow

test("pending, approve, execute, then replay is refused", async (t) => {
  const app = await withFixture(t);
  const scenario = SCENARIOS.find((s) => s.id === "production-deployment");
  const args = scenarioArguments(scenario);

  const first = await app.tool("deploy.production", args, { record: true });
  const pending = structured(first);
  assert.equal(pending.outcome, "pending_approval");
  const approvalId = pending.approvalId;

  // Calling again before anyone reviewed it must not execute.
  const early = await app.tool("deploy.production", { ...args, approvalId });
  assert.equal(structured(early).outcome, "pending_approval");

  const status = await app.tool("check_approval_status", { approvalId }, { record: true });
  assert.equal(structured(status).status, "pending_human");
  assert.equal(structured(status).consumed, false);

  const decision = await app.review(approvalId, { reviewerId: approverFor["security-lead"], reviewerRole: "security-lead" });
  assert.equal(decision.status, 200);

  const approved = await app.tool("check_approval_status", { approvalId }, { record: true });
  assert.equal(structured(approved).status, "approved");
  assert.equal(structured(approved).decision.decision, "approve");
  assert.ok(!JSON.stringify(approved.json).includes("minimum needed"), "reviewer comments are not shown to the agent");

  const run = await app.tool("deploy.production", { ...args, approvalId }, { record: true });
  assert.equal(run.json.result.isError, false);
  assert.equal(structured(run).outcome, "executed");
  assert.equal(structured(run).simulated, true);

  const replay = await app.tool("deploy.production", { ...args, approvalId }, { record: true });
  assert.equal(replay.json.result.isError, true);
  assert.equal(structured(replay).outcome, "replay_blocked");

  const final = await app.tool("check_approval_status", { approvalId });
  assert.equal(structured(final).status, "executed");
  assert.equal(structured(final).consumed, true);

  if (process.env.MCP_TRANSCRIPT_FILE) writeFileSync(process.env.MCP_TRANSCRIPT_FILE, JSON.stringify(app.transcript, null, 2));
});

test("an approval cannot be reused with different arguments", async (t) => {
  const app = await withFixture(t);
  const args = scenarioArguments(SCENARIOS.find((s) => s.id === "private-repo-review"));
  const pending = structured(await app.tool("repo.read", args));
  await app.review(pending.approvalId, { reviewerId: "owner-aria", reviewerRole: "resource-owner" });

  const tampered = await app.tool("repo.read", { ...args, resource: "repo://synthetic/another-service", approvalId: pending.approvalId });
  assert.equal(structured(tampered).outcome, "binding_mismatch");
  assert.equal(tampered.json.result.isError, true);
  assert.equal(app.service.get(pending.approvalId).status, "approved", "the approval is still intact");

  const honest = await app.tool("repo.read", { ...args, approvalId: pending.approvalId });
  assert.equal(structured(honest).outcome, "executed");
});

test("an approval for one tool cannot run a different tool", async (t) => {
  const app = await withFixture(t);
  const pending = structured(await app.tool("repo.read", scenarioArguments(SCENARIOS.find((s) => s.id === "private-repo-review"))));
  await app.review(pending.approvalId, { reviewerId: "owner-aria", reviewerRole: "resource-owner" });
  const other = scenarioArguments(SCENARIOS.find((s) => s.id === "public-research"));
  const attempt = await app.tool("docs.search", { ...other, approvalId: pending.approvalId });
  assert.equal(structured(attempt).outcome, "approval_not_found");
  assert.equal(app.service.get(pending.approvalId).status, "approved");
});

test("the requesting agent cannot approve its own request", async (t) => {
  const app = await withFixture(t);
  const pending = structured(await app.tool("iam.roles.update", scenarioArguments(SCENARIOS.find((s) => s.id === "iam-privilege-change"))));
  const self = await app.review(pending.approvalId, { reviewerId: AGENT_ID, reviewerRole: "security-lead" });
  assert.equal(self.status, 409);
  assert.equal(self.json.code, "self_approval");
  const attempt = await app.tool("iam.roles.update", { ...scenarioArguments(SCENARIOS.find((s) => s.id === "iam-privilege-change")), approvalId: pending.approvalId });
  assert.equal(structured(attempt).outcome, "pending_approval", "still pending, nothing ran");
});

test("a human denial reaches the agent as an error and nothing runs", async (t) => {
  const app = await withFixture(t);
  const args = scenarioArguments(SCENARIOS.find((s) => s.id === "secret-metadata"));
  const pending = structured(await app.tool("secrets.read", args));
  await app.review(pending.approvalId, { reviewerId: "lead-morgan", reviewerRole: "security-lead", decision: "deny", reason: "Not needed for this exercise." });
  const attempt = await app.tool("secrets.read", { ...args, approvalId: pending.approvalId });
  assert.equal(attempt.json.result.isError, true);
  assert.equal(structured(attempt).outcome, "denied");
});

test("an approval expires and then cannot execute", async (t) => {
  let now = new Date("2026-07-28T08:00:00.000Z");
  const app = await withFixture(t, { clock: () => new Date(now) });
  const args = scenarioArguments(SCENARIOS.find((s) => s.id === "production-deployment"));
  const pending = structured(await app.tool("deploy.production", args));
  await app.review(pending.approvalId, { reviewerId: "lead-morgan", reviewerRole: "security-lead" });
  now = new Date(now.getTime() + 11 * 60_000); // critical approvals last 10 minutes
  const late = await app.tool("deploy.production", { ...args, approvalId: pending.approvalId });
  assert.equal(structured(late).outcome, "expired");
  assert.equal(late.json.result.isError, true);
});

test("approval ids are private to the configured agent", async (t) => {
  const app = await withFixture(t);
  const args = scenarioArguments(SCENARIOS.find((s) => s.id === "private-repo-review"));
  const pending = structured(await app.tool("repo.read", args));
  const intruder = createMcpServer({
    service: app.service,
    store: app.store,
    toolRegistry: TOOL_REGISTRY,
    agentId: "some-other-agent",
    log: () => {},
  });
  const seen = await intruder.handle(modernMessage(1, "tools/call", { name: "check_approval_status", arguments: { approvalId: pending.approvalId } }), {
    transport: "stdio",
    headers: null,
    session: null,
  });
  assert.equal(seen.body.result.structuredContent.outcome, "approval_not_found");
  const missing = await app.tool("check_approval_status", { approvalId: "00000000-0000-0000-0000-000000000000" });
  assert.equal(structured(missing).outcome, "approval_not_found");
});

test("tool arguments are checked and identity cannot be supplied by the client", async (t) => {
  const app = await withFixture(t);
  const base = scenarioArguments(SCENARIOS[0]);
  const spoof = await app.tool("docs.search", { ...base, actorId: "lead-morgan" });
  assert.equal(spoof.json.result.isError, true);
  assert.equal(structured(spoof).outcome, "invalid_arguments");
  const missing = await app.tool("docs.search", { action: "read" });
  assert.equal(structured(missing).outcome, "invalid_arguments");
  const wrongType = await app.tool("docs.search", { ...base, requestedScopes: "public:docs" });
  assert.equal(structured(wrongType).outcome, "invalid_arguments");
  const notObject = await app.call("tools/call", { name: "docs.search", arguments: ["x"] });
  assert.equal(notObject.json.error.code, -32602);
});

test("a policy edge case is decided by policy, not by the schema", async (t) => {
  const app = await withFixture(t);
  const base = scenarioArguments(SCENARIOS[0]);
  const wrongAction = await app.tool("docs.search", { ...base, action: "delete" });
  assert.equal(structured(wrongAction).outcome, "denied");
  assert.equal(structured(wrongAction).denyCode, "action_not_allowed");
  const wrongResource = await app.tool("docs.search", { ...base, resource: "vault://prod/secrets" });
  assert.equal(structured(wrongResource).denyCode, "resource_not_allowed");
});

// ------------------------------------------------------------ protocol errors

test("malformed JSON-RPC is rejected with the right codes", async (t) => {
  const app = await withFixture(t);
  const headers = modernHeaders("tools/list");

  const badJson = await app.post("{not json", headers, { raw: true });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, -32700);
  assert.equal(badJson.json.id, null);

  const batch = await app.post([modernMessage(1, "tools/list"), modernMessage(2, "tools/list")], headers);
  assert.equal(batch.status, 400);
  assert.equal(batch.json.error.code, -32600);
  assert.match(batch.json.error.message, /Batch/);

  const emptyBatch = await app.post([], headers);
  assert.equal(emptyBatch.json.error.code, -32600);

  const noVersion = await app.post({ id: 1, method: "tools/list" }, headers);
  assert.equal(noVersion.json.error.code, -32600);

  const nullId = await app.post({ jsonrpc: "2.0", id: null, method: "tools/list", params: { _meta: modernMessage(1, "x").params._meta } }, headers);
  assert.equal(nullId.status, 400);
  assert.equal(nullId.json.error.code, -32600);

  const noMethod = await app.post({ jsonrpc: "2.0", id: 1 }, headers);
  assert.equal(noMethod.json.error.code, -32600);

  const arrayParams = await app.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: [] }, headers);
  assert.equal(arrayParams.json.error.code, -32602);

  const response = await app.post({ jsonrpc: "2.0", id: 1, result: {} }, headers);
  assert.equal(response.status, 400);
  assert.match(response.json.error.message, /no requests/);

  const unknown = await app.call("resources/list");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, -32601);
});

test("wrong protocol versions and header mismatches follow 2026-07-28", async (t) => {
  const app = await withFixture(t);
  const meta = (version, extra = {}) => ({
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientCapabilities": {},
    ...extra,
  });
  const body = (version) => ({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta(version) } });
  const headers = (version) => ({ ...modernHeaders("tools/list"), "mcp-protocol-version": version });

  const unsupported = await app.post(body("1900-01-01"), headers("1900-01-01"));
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.json.error.code, -32022);
  assert.deepEqual(unsupported.json.error.data.supported, [MODERN_VERSION, LEGACY_VERSION]);
  assert.equal(unsupported.json.error.data.requested, "1900-01-01");

  const mismatch = await app.post(body(MODERN_VERSION), headers("2025-11-25"));
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.json.error.code, -32020);

  const noHeader = await app.post(body(MODERN_VERSION), { "content-type": "application/json" });
  assert.equal(noHeader.status, 400);
  assert.equal(noHeader.json.error.code, -32020);

  const wrongMethodHeader = await app.post(body(MODERN_VERSION), { ...headers(MODERN_VERSION), "mcp-method": "tools/call" });
  assert.equal(wrongMethodHeader.json.error.code, -32020);

  const callBody = modernMessage(1, "tools/call", { name: "docs.search", arguments: {} });
  const wrongName = await app.post(callBody, { ...modernHeaders("tools/call", { name: "docs.search" }), "mcp-name": "repo.read" });
  assert.equal(wrongName.json.error.code, -32020);
  const withoutName = modernHeaders("tools/call", { name: "docs.search" });
  delete withoutName["mcp-name"];
  const noName = await app.post(callBody, withoutName);
  assert.equal(noName.status, 400);
  assert.equal(noName.json.error.code, -32020);
  const encodedName = Buffer.from("docs.search").toString("base64");
  const okName = await app.post(callBody, { ...modernHeaders("tools/call", { name: "docs.search" }), "mcp-name": `=?base64?${encodedName}?=` });
  assert.equal(okName.status, 200, "a base64 encoded Mcp-Name is decoded before comparison");

  const noCaps = await app.post(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION } } },
    headers(MODERN_VERSION),
  );
  assert.equal(noCaps.status, 400);
  assert.equal(noCaps.json.error.code, -32602);

  // No _meta at all but a 2026-07-28 header.
  const noMeta = await app.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, headers(MODERN_VERSION));
  assert.equal(noMeta.status, 400);
  assert.equal(noMeta.json.error.code, -32602);

  // Legacy era with a header that names an unknown version.
  const legacyBad = await app.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...JSON_HEADERS, "mcp-protocol-version": "2024-01-01" });
  assert.equal(legacyBad.status, 400);
  assert.equal(legacyBad.json.error.code, -32022);

  // Legacy era with no header at all.
  const legacyNone = await app.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, JSON_HEADERS);
  assert.equal(legacyNone.status, 400);
});

test("notifications get 202 and no body, and responses are refused", async (t) => {
  const app = await withFixture(t);
  const note = await app.post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }, JSON_HEADERS);
  assert.equal(note.status, 202);
  assert.equal(note.text, "");
  const unknownNote = await app.post({ jsonrpc: "2.0", method: "notifications/made-up" }, JSON_HEADERS);
  assert.equal(unknownNote.status, 202);
});

// ------------------------------------------------------------ HTTP transport rules

test("Origin validation blocks DNS rebinding and cross-site pages", async (t) => {
  const app = await withFixture(t);
  const message = modernMessage(1, "tools/list");
  const headers = modernHeaders("tools/list");

  const evil = await app.post(message, { ...headers, origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal(evil.json.error.code, -32600);
  assert.equal(evil.json.id, null);

  const nullOrigin = await app.post(message, { ...headers, origin: "null" });
  assert.equal(nullOrigin.status, 403);

  const sameOrigin = await app.post(message, { ...headers, origin: app.baseUrl });
  assert.equal(sameOrigin.status, 200);

  // A rebinding page: Origin and Host agree, but the name is not one we expect.
  const rebinding = await postWithHost(app.baseUrl, { ...headers, origin: "http://attacker.example", host: "attacker.example" }, message);
  assert.equal(rebinding.status, 403);

  const badHost = await postWithHost(app.baseUrl, { ...headers, host: "attacker.example" }, message);
  assert.equal(badHost.status, 403);
  assert.match(badHost.json.error.message, /Host not allowed/);

  const noOrigin = await app.post(message, headers);
  assert.equal(noOrigin.status, 200);
});

test("configured hosts and origins are honoured", async (t) => {
  const app = await withFixture(t, { allowedHosts: ["gateway.internal"], allowedOrigins: ["https://console.example"] });
  const message = modernMessage(1, "tools/list");
  const headers = modernHeaders("tools/list");
  const listed = await app.post(message, { ...headers, origin: "https://console.example" });
  assert.equal(listed.status, 200);
  const other = await app.post(message, { ...headers, origin: "https://other.example" });
  assert.equal(other.status, 403);
});

test("transport rules: methods, content type, size, accept", async (t) => {
  const app = await withFixture(t, { maxBodyBytes: 2048 });
  const get = await fetch(`${app.baseUrl}/mcp`);
  assert.equal(get.status, 405);
  const del = await fetch(`${app.baseUrl}/mcp`, { method: "DELETE" });
  assert.equal(del.status, 405);

  const text = await app.post(JSON.stringify(modernMessage(1, "tools/list")), { ...modernHeaders("tools/list"), "content-type": "text/plain" }, { raw: true });
  assert.equal(text.status, 415);

  const notAcceptable = await app.post(modernMessage(1, "tools/list"), { ...modernHeaders("tools/list"), accept: "text/html" });
  assert.equal(notAcceptable.status, 406);

  const big = await app.post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(5000) }), modernHeaders("tools/list"), { raw: true });
  assert.equal(big.status, 413);

  const jsonResponse = await app.call("tools/list");
  assert.match(jsonResponse.headers.get("content-type"), /^application\/json/);
  assert.equal(jsonResponse.headers.get("access-control-allow-origin"), null, "no CORS");
  assert.equal(jsonResponse.headers.get("mcp-session-id"), null);
});

test("the MCP route is rate limited", async (t) => {
  const app = await withFixture(t, { maxRequestsPerMinute: 3 });
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await app.call("tools/list")).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

// ------------------------------------------------------------ audit and secrets

test("every MCP outcome is audited, the chain verifies, and no secret leaks", async (t) => {
  const app = await withFixture(t);
  await app.call("server/discover");
  await app.call("tools/list");
  await app.tool("docs.search", scenarioArguments(SCENARIOS[0]));
  await app.tool("shell.root", {});
  await app.post("{bad", modernHeaders("tools/list"), { raw: true });
  await app.post(modernMessage(1, "tools/list"), { ...modernHeaders("tools/list"), origin: "https://evil.example" });
  await app.post({ jsonrpc: "2.0", method: "notifications/initialized" }, JSON_HEADERS);
  await app.call("resources/list");
  const unsupported = modernMessage(1, "tools/list");
  unsupported.params._meta["io.modelcontextprotocol/protocolVersion"] = "1900-01-01";
  await app.post(unsupported, { ...modernHeaders("tools/list"), "mcp-protocol-version": "1900-01-01" });

  const events = app.service.audit(null, 200);
  const mcpEvents = events.filter((event) => event.eventType.startsWith("mcp."));
  assert.ok(mcpEvents.length >= 9);
  for (const event of mcpEvents) {
    assert.equal(event.payload.source, "mcp");
    assert.match(event.payload.identity, /unauthenticated/);
    assert.equal(event.payload.agentId, AGENT_ID);
  }
  const outcomes = mcpEvents.map((event) => event.payload.outcome);
  for (const expected of ["ok", "executed", "unknown_tool", "parse_error", "origin_rejected", "accepted", "method_not_found", "unsupported_version"]) {
    assert.ok(outcomes.includes(expected), `audited outcome ${expected}`);
  }
  const call = mcpEvents.find((event) => event.payload.tool === "docs.search");
  assert.equal(call.payload.client.name, "raw-test-client");
  assert.ok(call.requestId, "the MCP event links to the gateway request");

  assert.equal((await app.service.verifyAudit()).valid, true);

  const everything = JSON.stringify(events) + JSON.stringify((await app.call("tools/list")).json);
  assert.ok(!everything.includes(AUDIT_KEY), "the audit key is never exposed");
});

test("an internal failure does not leak details", async (t) => {
  const app = await withFixture(t);
  const original = app.service.submit;
  app.service.submit = async () => {
    throw new Error("secret stack detail /home/x/secret.js");
  };
  const response = await app.tool("docs.search", scenarioArguments(SCENARIOS[0]));
  app.service.submit = original;
  assert.equal(response.json.error.code, -32603);
  assert.ok(!JSON.stringify(response.json).includes("secret"));
});
