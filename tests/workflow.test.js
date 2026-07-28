import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayService } from "../server/service.js";
import { createStore } from "../server/store.js";

const analysis = async () => ({
  provider: "test-analyzer",
  summary: "Synthetic analysis",
  hypotheses: [],
  uncertainty: ["Synthetic fixture"],
  questions: [],
});

function fixture(initialTime = "2026-07-28T08:00:00.000Z") {
  let now = new Date(initialTime);
  const store = createStore();
  const service = createGatewayService({
    store,
    analyzer: analysis,
    clock: () => new Date(now),
  });
  return {
    store,
    service,
    setTime(value) {
      now = new Date(value);
    },
    close() {
      store.close();
    },
  };
}

test("a security lead can approve and execute a critical action exactly once", async (t) => {
  const app = fixture();
  t.after(() => app.close());
  const submitted = await app.service.submit({ scenarioId: "iam-privilege-change" });

  const insufficient = app.service.decide(submitted.request.id, {
    reviewerId: "reviewer-analyst",
    reviewerRole: "security-analyst",
    decision: "approve",
    reason: "The requested access is needed for the exercise.",
  });
  assert.equal(insufficient.ok, false);
  assert.equal(insufficient.code, "insufficient_role");

  const approved = app.service.decide(submitted.request.id, {
    reviewerId: "reviewer-lead",
    reviewerRole: "security-lead",
    decision: "approve",
    reason: "Approved for the synthetic exercise with ten-minute authorization.",
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.request.status, "approved");

  const executed = app.service.execute(submitted.request.id);
  assert.equal(executed.ok, true);
  assert.equal(executed.execution.simulated, true);
  assert.equal(executed.request.status, "executed");

  const replay = app.service.execute(submitted.request.id);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "replay_blocked");
  assert.equal(app.service.verifyAudit().valid, true);
});

test("expired approval is consumed by neither an agent nor a human", async (t) => {
  const app = fixture();
  t.after(() => app.close());
  const submitted = await app.service.submit({ scenarioId: "private-repo-review" });
  const approved = app.service.decide(submitted.request.id, {
    reviewerId: "repository-owner",
    reviewerRole: "resource-owner",
    decision: "approve",
    reason: "Read-only access is appropriate for this synthetic security review.",
  });
  assert.equal(approved.ok, true);

  app.setTime("2026-07-28T08:31:00.000Z");
  const execution = app.service.execute(submitted.request.id);

  assert.equal(execution.ok, false);
  assert.equal(execution.code, "authorization_expired");
  assert.equal(app.service.get(submitted.request.id).status, "expired");
});

test("a human denial cannot be executed", async (t) => {
  const app = fixture();
  t.after(() => app.close());
  const submitted = await app.service.submit({ scenarioId: "private-repo-review" });
  const denied = app.service.decide(submitted.request.id, {
    reviewerId: "repository-owner",
    reviewerRole: "resource-owner",
    decision: "deny",
    reason: "The scope is not sufficiently narrow for the stated review.",
  });

  assert.equal(denied.ok, true);
  assert.equal(denied.request.status, "denied");
  assert.equal(app.service.execute(submitted.request.id).code, "not_authorized");
});

test("decision and request transition are atomic on a version conflict", async (t) => {
  const app = fixture();
  t.after(() => app.close());
  const submitted = await app.service.submit({ scenarioId: "private-repo-review" });
  const request = app.store.getRequest(submitted.request.id);
  const advanced = app.store.updateRequest(request.id, request.version, {
    status: request.status,
    updatedAt: "2026-07-28T08:01:00.000Z",
  });
  assert.equal(advanced.ok, true);

  const result = app.store.recordDecisionAndTransition(
    {
      id: "decision-conflict",
      requestId: request.id,
      reviewerId: "repository-owner",
      reviewerRole: "resource-owner",
      decision: "approve",
      reason: "A decision that must not survive a stale state transition.",
      createdAt: "2026-07-28T08:02:00.000Z",
      authorizationExpiresAt: "2026-07-28T08:32:00.000Z",
    },
    request.version,
    {
      status: "approved",
      authorizationExpiresAt: "2026-07-28T08:32:00.000Z",
      updatedAt: "2026-07-28T08:02:00.000Z",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "version_conflict");
  assert.deepEqual(app.store.listDecisions(request.id), []);
});

test("the audit chain detects stored-event tampering", async (t) => {
  const app = fixture();
  t.after(() => app.close());
  await app.service.submit({ scenarioId: "public-research" });
  assert.equal(app.service.verifyAudit().valid, true);

  app.store.db
    .prepare("UPDATE audit_events SET payload = ? WHERE sequence = 1")
    .run('{"tampered":true}');
  const verification = app.service.verifyAudit();

  assert.equal(verification.valid, false);
  assert.equal(verification.failedSequence, 1);
});
