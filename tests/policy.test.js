import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy, reviewerCanApprove } from "../server/policy.js";
import { scenarioById } from "../server/scenarios.js";

function evaluateScenario(id) {
  return evaluatePolicy(scenarioById(id).request);
}

test("public documentation research is the only auto-approved sample", () => {
  const result = evaluateScenario("public-research");

  assert.equal(result.decision, "allow");
  assert.equal(result.status, "auto_approved");
  assert.equal(result.level, "low");
  assert.equal(result.approvalRole, null);
});

test("private source review requires a resource owner", () => {
  const result = evaluateScenario("private-repo-review");

  assert.equal(result.decision, "require_human");
  assert.equal(result.status, "pending_human");
  assert.equal(result.approvalRole, "resource-owner");
  assert.equal(result.level, "medium");
});

test("secret metadata is never exposed through auto-approval", () => {
  const result = evaluateScenario("secret-metadata");

  assert.equal(result.decision, "require_human");
  assert.equal(result.level, "critical");
  assert.equal(result.approvalRole, "security-lead");
  assert.match(result.controls.join(" "), /never return secret values/i);
});

test("production privilege changes require the security lead", () => {
  const result = evaluateScenario("iam-privilege-change");

  assert.equal(result.decision, "require_human");
  assert.equal(result.level, "critical");
  assert.equal(result.approvalRole, "security-lead");
});

test("prompt injection in retrieved context is denied", () => {
  const result = evaluateScenario("prompt-injection");

  assert.equal(result.decision, "deny");
  assert.equal(result.status, "denied");
  assert.match(result.reasons.join(" "), /bypass security controls/i);
});

test("scope creep and unregistered tools are denied by default", () => {
  const scopeCreep = evaluateScenario("scope-creep");
  const unknownTool = evaluateScenario("unknown-tool");

  assert.equal(scopeCreep.decision, "deny");
  assert.match(scopeCreep.controls.join(" "), /scope creep/i);
  assert.equal(unknownTool.decision, "deny");
  assert.match(unknownTool.reasons.join(" "), /not registered/i);
});

test("reviewer role hierarchy is enforced", () => {
  assert.equal(reviewerCanApprove("resource-owner", "security-lead"), false);
  assert.equal(reviewerCanApprove("security-analyst", "security-lead"), false);
  assert.equal(reviewerCanApprove("security-lead", "security-lead"), true);
  assert.equal(reviewerCanApprove("security-lead", "resource-owner"), true);
  assert.equal(reviewerCanApprove("invented-role", "resource-owner"), false);
});
