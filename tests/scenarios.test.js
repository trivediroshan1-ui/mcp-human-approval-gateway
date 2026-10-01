// The nine scenarios in the lab, with the outcome each one must produce. The
// same table is checked against the Node service and the browser service.
import assert from "node:assert/strict";
import test from "node:test";
import { SCENARIOS } from "../server/scenarios.js";
import { demoHarness, runScenario, serverHarness } from "./helpers/harness.js";

// scenario -> what the lab must show, step by step
const EXPECTED = {
  "public-research": {
    status: "auto_approved", decision: "allow", level: "low", score: 14, role: null,
    after: "executed", replay: "replay_blocked",
  },
  "private-repo-review": {
    status: "pending_human", decision: "require_human", level: "medium", score: 54, role: "resource-owner",
    after: "executed", replay: "replay_blocked",
  },
  "secret-metadata": {
    status: "pending_human", decision: "require_human", level: "critical", score: 100, role: "security-lead",
    after: "executed", replay: "replay_blocked",
  },
  "iam-privilege-change": {
    status: "pending_human", decision: "require_human", level: "critical", score: 100, role: "security-lead",
    after: "executed", replay: "replay_blocked",
  },
  "prompt-injection": {
    status: "denied", decision: "deny", level: "critical", score: 100, role: null,
    after: "denied", blocked: "not_authorized", denyCode: "injection",
  },
  "scope-creep": {
    status: "denied", decision: "deny", level: "critical", score: 100, role: null,
    after: "denied", blocked: "not_authorized", denyCode: "scope_outside_contract",
  },
  "production-deployment": {
    status: "pending_human", decision: "require_human", level: "critical", score: 100, role: "security-lead",
    after: "executed", replay: "replay_blocked",
  },
  "unknown-tool": {
    status: "denied", decision: "deny", level: "critical", score: 100, role: null,
    after: "denied", blocked: "not_authorized", denyCode: "unregistered_tool",
  },
  "ungated-handoff": {
    status: "gate_rejected", decision: "require_human", level: "critical", score: 100, role: "security-lead",
    after: "gate_rejected", blocked: "not_authorized",
  },
};

test("every catalog scenario has an expectation in this file and in the catalog", () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), SCENARIOS.map((s) => s.id).sort());
  for (const scenario of SCENARIOS) {
    const want = EXPECTED[scenario.id];
    assert.equal(scenario.expect.status, want.status, scenario.id);
    assert.equal(scenario.expect.policyDecision, want.decision, scenario.id);
    assert.equal(scenario.expect.riskLevel, want.level, scenario.id);
    assert.equal(scenario.expect.approvalRole, want.role, scenario.id);
    assert.equal(scenario.expect.denyCode, want.denyCode ?? null, scenario.id);
  }
});

for (const makeHarness of [serverHarness, demoHarness]) {
  for (const scenario of SCENARIOS) {
    const want = EXPECTED[scenario.id];
    test(`${makeHarness === serverHarness ? "server" : "demo"}: ${scenario.id} -> ${scenario.expected}`, async (t) => {
      const harness = makeHarness();
      t.after(() => harness.close());
      const steps = new Map(await runScenario(harness, scenario.id));

      const submit = steps.get("submit");
      assert.equal(submit.status, want.status);
      assert.equal(submit.policyDecision, want.decision);
      assert.equal(submit.riskLevel, want.level);
      assert.equal(submit.riskScore, want.score);
      assert.equal(submit.approvalRole, want.role);
      assert.equal(steps.get("final").status, want.after);
      assert.equal(steps.get("audit").valid, true);

      if (want.denyCode) {
        const stored = harness.service.list()[0];
        const policyEvent = harness.service
          .audit(stored.id, 50)
          .find((event) => event.eventType === "policy.deny");
        assert.equal(policyEvent.payload.denyCode, want.denyCode);
      }

      if (want.blocked) {
        const attempt = steps.get("execute without authorization") ?? steps.get("execute before approval");
        assert.equal(attempt.ok, false);
        assert.equal(attempt.code, want.blocked);
        assert.equal(steps.has("execute"), false);
      }

      if (want.after === "executed") {
        assert.equal(steps.get("execute").ok, true);
        assert.equal(steps.get("execute").simulated, true);
        assert.equal(steps.get("replay").code, want.replay);
        assert.equal(steps.get("execute wrong hash").code, "binding_mismatch");
        assert.equal(steps.get("execute wrong actor").code, "actor_mismatch");
      }

      if (want.status === "pending_human") {
        assert.equal(steps.get("execute before approval").code, "not_authorized");
        assert.equal(steps.get("viewer approve").code, "insufficient_role");
        assert.equal(steps.get("self approve").code, "self_approval");
        if (want.role !== "resource-owner") {
          assert.equal(steps.get("under-qualified approve").code, "insufficient_role");
        }
        const ttl = { medium: 30, high: 15, critical: 10 }[want.level];
        assert.equal(steps.get("approve").expiresInMinutes, ttl);
      }

      // Records the expected-outcome label shown in the UI.
      assert.ok(scenario.expected.length > 0);
    });
  }
}

test("auto-approved authorization lasts 60 minutes and then expires at the guard", async (t) => {
  for (const makeHarness of [serverHarness, demoHarness]) {
    const h = makeHarness();
    t.after(() => h.close());
    const submitted = await h.service.submit({ scenarioId: "public-research" });
    assert.equal(
      Date.parse(submitted.request.authorizationExpiresAt) - Date.parse(submitted.request.createdAt),
      60 * 60_000,
    );
    h.time.advanceMinutes(60);
    const late = await h.service.execute(submitted.request.id);
    assert.equal(late.code, "authorization_expired", `${h.name}: expiry is inclusive`);
    assert.equal(h.service.get(submitted.request.id).status, "expired");
    const again = await h.service.execute(submitted.request.id);
    assert.equal(again.code, "not_authorized");
  }
});

test("a human-approved authorization expires on its own clock, not the review clock", async (t) => {
  for (const makeHarness of [serverHarness, demoHarness]) {
    const h = makeHarness();
    t.after(() => h.close());
    const submitted = await h.service.submit({ scenarioId: "iam-privilege-change" });
    h.time.advanceMinutes(45); // sitting in the queue is allowed
    const approved = await h.service.decide(submitted.request.id, {
      reviewerId: "lead-morgan",
      reviewerRole: "security-lead",
      decision: "approve",
      reason: "Approved for the synthetic exercise, ten minute window.",
    });
    assert.equal(approved.ok, true, h.name);
    h.time.advanceMinutes(9);
    const probe = await h.service.get(submitted.request.id);
    assert.equal(probe.status, "approved");
    h.time.advanceMinutes(1);
    const late = await h.service.execute(submitted.request.id);
    assert.equal(late.code, "authorization_expired", h.name);
  }
});

test("a request cannot be approved after the review window", async (t) => {
  for (const makeHarness of [serverHarness, demoHarness]) {
    const h = makeHarness();
    t.after(() => h.close());
    const submitted = await h.service.submit({ scenarioId: "private-repo-review" });
    h.time.advanceMinutes(241);
    const late = await h.service.decide(submitted.request.id, {
      reviewerId: "owner-aria",
      reviewerRole: "resource-owner",
      decision: "approve",
      reason: "Looks fine to me after a long wait in the queue.",
    });
    assert.equal(late.code, "review_window_elapsed", h.name);
    assert.equal(h.service.get(submitted.request.id).status, "expired");
  }
});
