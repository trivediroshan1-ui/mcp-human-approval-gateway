// Two-phase execution: reserve, dispatch, confirm. These tests run against the
// server service and the browser copy, with a fake downstream that counts how
// many times work really ran. The question each one answers is "how many times
// did the tool do something?", and the answer has to be at most one.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDownstream } from "../server/downstream.js";
import { EXECUTION_TIMEOUT_MINUTES } from "../server/service.js";
import { demoHarness, serverHarness } from "./helpers/harness.js";

const KEY = "client-key-0001";

async function setup(makeHarness, t) {
  const downstream = createFakeDownstream();
  const h = makeHarness({ downstream });
  t.after(() => h.close());
  return { h, downstream, service: h.service, time: h.time };
}

async function autoApproved(service) {
  const { request } = await service.submit({ scenarioId: "public-research" });
  return request;
}

async function approvedDeploy(service, reviewerId = "lead-morgan") {
  const { request } = await service.submit({ scenarioId: "production-deployment" });
  const decided = await service.decide(request.id, {
    reviewerId,
    reviewerRole: "security-lead",
    decision: "approve",
    reason: "Scope and duration are the minimum needed for this test.",
  });
  assert.equal(decided.ok, true);
  return decided.request;
}

const as = (request, extra = {}) => ({ requestHash: request.requestHash, actorId: request.actorId, ...extra });

for (const [label, makeHarness] of [["server", serverHarness], ["demo", demoHarness]]) {
  test(`${label}: eight parallel calls with one key dispatch exactly once`, async (t) => {
    const { downstream, service } = await setup(makeHarness, t);
    const request = await autoApproved(service);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.execute(request.id, as(request, { idempotencyKey: KEY }))),
    );
    assert.ok(results.every((r) => r.ok));
    assert.equal(results.filter((r) => !r.replayed).length, 1, "one winner");
    assert.equal(new Set(results.map((r) => r.execution.executionId)).size, 1);
    assert.deepEqual(downstream.stats(), { attempts: 1, effects: 1, keys: 1 });
    assert.equal((await service.verifyAudit()).valid, true);
  });

  test(`${label}: parallel calls with different or no keys still dispatch once`, async (t) => {
    const { downstream, service } = await setup(makeHarness, t);
    const request = await autoApproved(service);
    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => service.execute(request.id, as(request, { idempotencyKey: `client-key-${i}0000` }))),
      ...Array.from({ length: 4 }, () => service.execute(request.id, as(request))),
    ]);
    assert.equal(results.filter((r) => r.ok && !r.replayed).length, 1);
    for (const r of results.filter((x) => !x.ok || x.replayed)) {
      if (!r.ok) assert.equal(r.code, "replay_blocked");
    }
    assert.equal(downstream.stats().effects, 1);
  });

  test(`${label}: a lost response is recovered by retrying with the same key`, async (t) => {
    const { downstream, service } = await setup(makeHarness, t);
    const request = await autoApproved(service);
    const first = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    assert.equal(first.execution.state, "executed");
    // The caller never saw `first`. It asks again, same approval, same key.
    const retry = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    assert.equal(retry.ok, true);
    assert.equal(retry.replayed, true);
    assert.equal(retry.execution.executionId, first.execution.executionId);
    assert.equal(retry.execution.resultDigest, first.execution.resultDigest);
    assert.match(retry.execution.resultDigest, /^[0-9a-f]{64}$/);
    // It can also ask by execution id and read the result.
    const byId = await service.execute(request.id, { executionId: first.execution.executionId });
    assert.equal(byId.replayed, true);
    const read = await service.getExecution(first.execution.executionId);
    assert.equal(read.execution.state, "executed");
    assert.equal(read.execution.resultDigest, first.execution.resultDigest);
    assert.deepEqual(downstream.stats(), { attempts: 1, effects: 1, keys: 1 });
    const served = service.audit(request.id, 100).filter((e) => e.eventType === "action.retry_served");
    assert.equal(served.length, 2);
  });

  test(`${label}: a different key, no key or changed arguments are refused after the grant is spent`, async (t) => {
    const { downstream, service } = await setup(makeHarness, t);
    const request = await autoApproved(service);
    await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    const other = await service.execute(request.id, as(request, { idempotencyKey: "client-key-9999" }));
    assert.equal(other.ok, false);
    assert.equal(other.code, "replay_blocked");
    const none = await service.execute(request.id, as(request));
    assert.equal(none.code, "replay_blocked");
    const changed = await service.execute(request.id, { requestHash: "0".repeat(64), idempotencyKey: KEY });
    assert.equal(changed.code, "binding_mismatch");
    const wrongActor = await service.execute(request.id, { actorId: "someone-else", idempotencyKey: KEY });
    assert.equal(wrongActor.code, "actor_mismatch");
    const bad = await service.execute(request.id, { idempotencyKey: "short" });
    assert.equal(bad.code, "invalid_idempotency_key");
    assert.equal(downstream.stats().effects, 1);
  });

  test(`${label}: a human-approved request works the same way`, async (t) => {
    const { downstream, service } = await setup(makeHarness, t);
    const request = await approvedDeploy(service);
    const first = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    assert.equal(first.execution.state, "executed");
    assert.equal(first.request.status, "executed");
    const retry = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    assert.equal(retry.replayed, true);
    assert.equal(downstream.stats().effects, 1);
  });

  test(`${label}: a reservation made in time survives expiry, a late first call does not`, async (t) => {
    const { downstream, service, time } = await setup(makeHarness, t);
    const early = await autoApproved(service);
    const late = await autoApproved(service);
    // Auto approvals last 60 minutes. One minute before: allowed.
    time.advanceMinutes(59);
    const reserved = await service.execute(early.id, as(early, { idempotencyKey: KEY }));
    assert.equal(reserved.execution.state, "executed");
    // Exactly at and after the expiry: a first call is refused.
    time.advanceMinutes(1);
    const refused = await service.execute(late.id, as(late, { idempotencyKey: "client-key-0002" }));
    assert.equal(refused.code, "authorization_expired");
    // The earlier reservation still answers its retry after the window closed.
    time.advanceMinutes(30);
    const retry = await service.execute(early.id, as(early, { idempotencyKey: KEY }));
    assert.equal(retry.ok, true);
    assert.equal(retry.replayed, true);
    assert.equal(downstream.stats().effects, 1);
  });

  test(`${label}: a failed tool is recorded as failed and not retried`, async (t) => {
    const { downstream, service } = await setup(makeHarness, t);
    const request = await autoApproved(service);
    downstream.injectFault("fail");
    const run = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    assert.equal(run.ok, true);
    assert.equal(run.execution.state, "failed");
    assert.equal(run.execution.errorCode, "downstream_error");
    assert.equal(run.request.status, "failed");
    const retry = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    assert.equal(retry.replayed, true);
    assert.equal(retry.execution.state, "failed");
    assert.deepEqual(downstream.stats(), { attempts: 1, effects: 0, keys: 0 });
    const types = service.audit(request.id, 100).map((e) => e.eventType);
    assert.ok(types.includes("action.reserved") && types.includes("action.failed"));
    assert.equal((await service.verifyAudit()).valid, true);
  });

  test(`${label}: an unconfirmed execution becomes unknown_outcome and is never re-dispatched`, async (t) => {
    const { downstream, service, time } = await setup(makeHarness, t);
    const request = await approvedDeploy(service);
    downstream.injectFault("timeout_after_effect");
    const run = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    assert.equal(run.ok, true);
    assert.equal(run.execution.state, "executing");
    assert.equal(downstream.stats().effects, 1, "the tool did run, but nobody was told");

    // Still inside the window: a retry reports the open reservation.
    const during = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    assert.equal(during.replayed, true);
    assert.equal(during.execution.state, "executing");

    time.advanceMinutes(EXECUTION_TIMEOUT_MINUTES + 1);
    const read = await service.getExecution(run.execution.executionId);
    assert.equal(read.execution.state, "unknown_outcome");
    const after = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    assert.equal(after.replayed, true);
    assert.equal(after.execution.state, "unknown_outcome");
    const fresh = await service.execute(request.id, as(request, { idempotencyKey: "client-key-7777" }));
    assert.equal(fresh.code, "replay_blocked");
    assert.deepEqual(downstream.stats(), { attempts: 1, effects: 1, keys: 1 }, "no second dispatch, ever");
    assert.equal(service.audit(request.id, 100).filter((e) => e.eventType === "action.unknown_outcome").length, 1);
  });

  test(`${label}: reconcile records the real outcome, with rules about who can do it`, async (t) => {
    const { downstream, service, time } = await setup(makeHarness, t);
    const request = await approvedDeploy(service);
    downstream.injectFault("timeout_before_effect");
    const run = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    const executionId = run.execution.executionId;

    const tooEarly = await service.reconcile(executionId, {
      reviewerId: "lead-morgan", reviewerRole: "security-lead", outcome: "failed", reason: "Checked the downstream system.",
    });
    assert.equal(tooEarly.code, "invalid_state", "only unknown_outcome can be reconciled");

    time.advanceMinutes(EXECUTION_TIMEOUT_MINUTES + 1);
    const base = { outcome: "failed", reason: "Checked the downstream system: no record of the key." };
    assert.equal((await service.reconcile(executionId, { ...base, reviewerId: request.actorId, reviewerRole: "security-lead" })).code, "self_reconcile");
    assert.equal((await service.reconcile(executionId, { ...base, reviewerId: "viewer-vic", reviewerRole: "viewer" })).code, "insufficient_role");
    assert.equal((await service.reconcile(executionId, { ...base, reviewerId: "owner-aria", reviewerRole: "resource-owner" })).code, "insufficient_role");
    assert.equal((await service.reconcile(executionId, { ...base, reviewerId: "lead-morgan", reviewerRole: "security-lead", reason: "short" })).code, "invalid_reconciliation");

    // The lab downstream can be asked what a real operator would look up.
    const done = await service.reconcile(executionId, { ...base, reviewerId: "lead-morgan", reviewerRole: "security-lead" });
    assert.equal(done.ok, true);
    assert.equal(done.execution.state, "failed");
    assert.equal(done.execution.reconciled.by, "lead-morgan");
    assert.equal(done.request.status, "failed");
    assert.equal((await service.reconcile(executionId, { ...base, reviewerId: "lead-morgan", reviewerRole: "security-lead" })).code, "invalid_state");
    const event = service.audit(request.id, 100).find((e) => e.eventType === "action.reconciled");
    assert.equal(event.actor, "security-lead:lead-morgan");
    assert.equal(event.payload.outcome, "failed");
    assert.equal(downstream.stats().effects, 0);
    assert.equal((await service.verifyAudit()).valid, true);
  });

  test(`${label}: reconcile can also record that the tool did run`, async (t) => {
    const { downstream, service, time } = await setup(makeHarness, t);
    const request = await autoApproved(service);
    downstream.injectFault("timeout_after_effect");
    const run = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    time.advanceMinutes(EXECUTION_TIMEOUT_MINUTES + 1);
    const done = await service.reconcile(run.execution.executionId, {
      reviewerId: "analyst-dev", reviewerRole: "security-analyst", outcome: "executed", reason: "The downstream log shows the key was accepted.",
    });
    assert.equal(done.ok, true, done.message);
    assert.equal(done.execution.state, "executed");
    assert.equal(done.execution.resultDigest, null, "no digest exists for an outcome learned by hand");
    assert.equal(downstream.stats().effects, 1);
  });

  test(`${label}: two-phase API, confirm needs the dispatch key and is idempotent`, async (t) => {
    const { downstream, service, time } = await setup(makeHarness, t);
    const request = await autoApproved(service);
    const reserved = await service.reserve(request.id, as(request, { idempotencyKey: KEY }));
    assert.equal(reserved.ok, true);
    assert.equal(reserved.execution.state, "executing");
    assert.match(reserved.dispatchKey, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(reserved.request).includes(reserved.dispatchKey), "the key is not in the request record");
    assert.ok(!JSON.stringify(await service.getExecution(reserved.execution.executionId)).includes(reserved.dispatchKey));
    assert.ok(!JSON.stringify(service.audit(request.id, 100)).includes(reserved.dispatchKey), "or the audit log");

    const id = reserved.execution.executionId;
    const forged = await service.confirm(id, { dispatchKey: "f".repeat(64), outcome: "executed" });
    assert.equal(forged.code, "confirm_rejected");
    assert.equal((await service.getExecution(id)).execution.state, "executing");

    const run = await service.dispatch(request.id, { executionId: id });
    assert.equal(run.ok, true);
    assert.equal((await service.dispatch(request.id, { executionId: "nope" })).code, "not_executing");
    const digest = "a".repeat(64);
    const first = await service.confirm(id, { dispatchKey: reserved.dispatchKey, outcome: "executed", resultDigest: digest, resultSummary: run.result.summary });
    assert.equal(first.ok, true);
    assert.equal(first.execution.resultDigest, digest);
    const again = await service.confirm(id, { dispatchKey: reserved.dispatchKey, outcome: "executed", resultDigest: digest });
    assert.equal(again.replayed, true);
    const flip = await service.confirm(id, { dispatchKey: reserved.dispatchKey, outcome: "failed" });
    assert.equal(flip.code, "invalid_state", "an outcome cannot be rewritten");
    assert.equal(downstream.stats().effects, 1);
    void time;
  });

  test(`${label}: a confirm that arrives after the timeout is refused`, async (t) => {
    const { service, time } = await setup(makeHarness, t);
    const request = await autoApproved(service);
    const reserved = await service.reserve(request.id, as(request, { idempotencyKey: KEY }));
    time.advanceMinutes(EXECUTION_TIMEOUT_MINUTES + 1);
    const late = await service.confirm(reserved.execution.executionId, {
      dispatchKey: reserved.dispatchKey, outcome: "executed", resultDigest: "b".repeat(64),
    });
    assert.equal(late.code, "needs_reconciliation");
    assert.equal((await service.getExecution(reserved.execution.executionId)).execution.state, "unknown_outcome");
  });

  test(`${label}: sweep settles every stuck reservation`, async (t) => {
    const { service, time } = await setup(makeHarness, t);
    const a = await autoApproved(service);
    const b = await autoApproved(service);
    await service.reserve(a.id, as(a, { idempotencyKey: "client-key-000a" }));
    await service.reserve(b.id, as(b, { idempotencyKey: "client-key-000b" }));
    assert.equal(await service.sweep(), 0);
    time.advanceMinutes(EXECUTION_TIMEOUT_MINUTES + 1);
    assert.equal(await service.sweep(), 2);
    assert.equal(service.get(a.id).status, "unknown_outcome");
  });

  test(`${label}: the audit chain covers the whole execution lifecycle`, async (t) => {
    const { service } = await setup(makeHarness, t);
    const request = await autoApproved(service);
    await service.execute(request.id, as(request, { idempotencyKey: KEY }));
    const types = service.audit(request.id, 100).map((e) => e.eventType).reverse();
    assert.deepEqual(types.slice(-2), ["action.reserved", "action.confirmed"]);
    const reserved = service.audit(request.id, 100).find((e) => e.eventType === "action.reserved");
    assert.equal(reserved.payload.idempotencyKey, KEY);
    assert.match(reserved.payload.dispatchKeyDigest, /^[0-9a-f]{64}$/);
    assert.equal((await service.verifyAudit()).valid, true);
  });
}

test("server: editing the stored request after reserve is detected on retry", async (t) => {
  const { h, downstream, service } = await setup(serverHarness, t);
  const request = await autoApproved(service);
  await service.execute(request.id, as(request, { idempotencyKey: KEY }));
  h.store.db.prepare("UPDATE requests SET resource = ? WHERE id = ?").run("public://something-else", request.id);
  const retry = await service.execute(request.id, as(request, { idempotencyKey: KEY }));
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "integrity_failed");
  assert.equal(downstream.stats().effects, 1);
});

test("the fake downstream deduplicates by key and needs a key", () => {
  const downstream = createFakeDownstream();
  const call = { toolId: "docs.search", action: "read", resource: "public://x", idempotencyKey: "abcdefgh" };
  const first = downstream.dispatch(call);
  const second = downstream.dispatch(call);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.deepEqual(downstream.stats(), { attempts: 2, effects: 1, keys: 1 });
  assert.throws(() => downstream.dispatch({ ...call, idempotencyKey: undefined }), /idempotency key/);
});
