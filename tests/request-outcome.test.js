import test from "node:test";
import assert from "node:assert/strict";
import { metricsOf, outcomeOf } from "../src/request-outcome.js";

const policyBlocked = { status: "denied", policyDecision: "deny", decisions: [] };
const humanDenied = { status: "denied", policyDecision: "require_human", decisions: [{ decision: "deny" }] };
const integrity = { status: "denied", policyDecision: "require_human", decisions: [{ decision: "approve" }] };

test("the three kinds of denied are told apart", () => {
  assert.equal(outcomeOf(policyBlocked).key, "policy_blocked");
  assert.equal(outcomeOf(humanDenied).key, "human_denied");
  assert.equal(outcomeOf(integrity).key, "integrity_denied");
});

test("waiting and approved requests say who acts next", () => {
  assert.equal(outcomeOf({ status: "pending_human" }).label, "Awaiting human");
  assert.equal(outcomeOf({ status: "approved" }).label, "Human approved");
  assert.equal(outcomeOf({ status: "auto_approved" }).label, "Auto-approved");
});

test("policy blocks and human denials are counted separately", () => {
  const m = metricsOf([policyBlocked, humanDenied, humanDenied, integrity, { status: "pending_human" }, { status: "executed" }]);
  assert.deepEqual(m, { total: 6, pending: 1, policyBlocked: 1, humanDenied: 2, executed: 1 });
});
