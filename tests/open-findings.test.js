// Fixes for the open findings from the lab report: status view of stale
// requests, reviewer allowlist, unsigned-audit warning, approvalId length.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDownstream } from "../server/downstream.js";
import { createMcpServer } from "../server/mcp.js";
import { EXECUTION_TIMEOUT_MINUTES } from "../server/service.js";
import { REVIEW_WINDOW_MINUTES } from "../server/policy.js";
import { TOOL_REGISTRY } from "../server/scenarios.js";
import { serverHarness } from "./helpers/harness.js";

test("getFresh: a request left in the queue past the review window reads as expired", async (t) => {
  const h = serverHarness();
  t.after(() => h.close());
  const { request } = await h.service.submit({ scenarioId: "production-deployment" });
  assert.equal(request.status, "pending_human");
  assert.equal(h.service.getFresh(request.id).status, "pending_human");
  h.time.advanceMinutes(REVIEW_WINDOW_MINUTES + 1);
  assert.equal(h.service.get(request.id).status, "pending_human", "plain get stays read-only");
  assert.equal(h.service.getFresh(request.id).status, "expired");
  assert.ok(h.service.audit(request.id, 50).some((e) => e.eventType === "review.expired"));
});

test("getFresh: a stuck reservation reads as unknown_outcome", async (t) => {
  const downstream = createFakeDownstream();
  const h = serverHarness({ downstream });
  t.after(() => h.close());
  const { request } = await h.service.submit({ scenarioId: "public-research" });
  downstream.injectFault("timeout_after_effect");
  const run = await h.service.execute(request.id, {
    requestHash: request.requestHash,
    actorId: request.actorId,
    idempotencyKey: "stuck-key-0001",
  });
  assert.equal(run.execution.state, "executing");
  h.time.advanceMinutes(EXECUTION_TIMEOUT_MINUTES + 1);
  assert.equal(h.service.get(request.id).status, "executing");
  assert.equal(h.service.getFresh(request.id).status, "unknown_outcome");
});

test("reviewer allowlist: unlisted names and wrong roles are refused", async (t) => {
  const h = serverHarness({ reviewerAllowlist: { "lead-morgan": "security-lead" } });
  t.after(() => h.close());
  const { request } = await h.service.submit({ scenarioId: "production-deployment" });
  const stranger = await h.service.decide(request.id, {
    reviewerId: "stranger",
    reviewerRole: "security-lead",
    decision: "approve",
    reason: "Looks fine to me today.",
  });
  assert.equal(stranger.code, "insufficient_role");
  const wrongRole = await h.service.decide(request.id, {
    reviewerId: "lead-morgan",
    reviewerRole: "security-analyst",
    decision: "approve",
    reason: "Looks fine to me today.",
  });
  assert.equal(wrongRole.ok, false);
  const listed = await h.service.decide(request.id, {
    reviewerId: "Lead-Morgan",
    reviewerRole: "security-lead",
    decision: "approve",
    reason: "Checked the change window.",
  });
  assert.equal(listed.ok, true);
});

test("audit verify says so when the chain is unsigned", async (t) => {
  const h = serverHarness();
  t.after(() => h.close());
  await h.service.submit({ scenarioId: "public-research" });
  const v = await h.service.verifyAudit();
  assert.equal(v.valid, true);
  assert.equal(v.signed, false);
  assert.match(v.warning, /unsigned/);
  const keyed = serverHarness({ storeOptions: { auditKey: "k".repeat(32) } });
  t.after(() => keyed.close());
  await keyed.service.submit({ scenarioId: "public-research" });
  const kv = await keyed.service.verifyAudit();
  assert.equal(kv.signed, true);
  assert.equal(kv.warning, undefined);
});

test("mcp: an approvalId over 128 characters is invalid_arguments, not not_found", async (t) => {
  const h = serverHarness();
  t.after(() => h.close());
  const mcp = createMcpServer({ service: h.service, store: h.store, toolRegistry: TOOL_REGISTRY, agentId: "a-1", log: () => {} });
  const res = await mcp.handle(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_approval_status", arguments: { approvalId: "x".repeat(129) } } },
    { transport: "stdio", headers: null, session: null },
  );
  assert.equal(res.body.result.structuredContent.outcome, "invalid_arguments");
});

test("binding rules: whitespace, environment case and scope order do not change the hash; arguments do", async () => {
  const { normalizeRequest, bindingPayload } = await import("../server/policy.js");
  const { hashEvent } = await import("../server/store.js");
  const base = {
    actorId: "agent-1",
    toolId: "deploy.production",
    action: "deploy",
    resource: "svc/payments",
    environment: "production",
    dataClassification: "internal",
    requestedScopes: ["deploy:write", "deploy:read"],
    arguments: { build: "A1" },
    justification: "Ship the fix.",
    context: "ticket 42",
  };
  const h = (r) => hashEvent(bindingPayload(normalizeRequest(r)));
  const same = { ...base, action: "  deploy ", environment: "PRODUCTION", requestedScopes: ["deploy:read", "deploy:write"] };
  assert.equal(h(same), h(base), "trim, lowercase enums, sorted scopes");
  assert.notEqual(h({ ...base, arguments: { build: "a1" } }), h(base), "arguments are exact");
  assert.notEqual(h({ ...base, resource: "svc/Payments" }), h(base), "resource keeps its case");
  assert.equal(h({ ...base, existingScopes: ["x"] }), h(base), "existingScopes are not bound");
});
