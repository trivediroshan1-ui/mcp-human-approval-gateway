// The tool's own definition is part of what an approval covers. If the registry
// entry changes (risk, scopes, flags), an approval given for the old entry must
// not carry over. scripts/run-change-cases.mjs (U16a) runs the full end-to-end
// case against edited copies of the repository; this file pins the pieces.
import assert from "node:assert/strict";
import test from "node:test";
import { POLICY_VERSION, bindingPayload, toolDefinitionText } from "../server/policy.js";
import * as demoPolicy from "../src/demo/policy.js";

const input = {
  actorId: "agent-1",
  actorType: "ai-agent",
  toolId: "deploy.production",
  action: "deploy",
  resource: "service://payment-api",
  environment: "production",
  dataClassification: "confidential",
  requestedScopes: ["deploy:production"],
  arguments: { release: "v1" },
  justification: "Release v1",
  context: "",
};

test("the binding payload carries the tool definition", () => {
  const payload = bindingPayload(input);
  assert.equal(payload.toolDefinition, toolDefinitionText("deploy.production"));
  assert.ok(payload.toolDefinition.includes("baseRisk"));
});

test("different tools give different definition text, unknown tools give null", () => {
  assert.notEqual(toolDefinitionText("deploy.production"), toolDefinitionText("secrets.read"));
  assert.equal(toolDefinitionText("no.such.tool"), null);
  assert.equal(toolDefinitionText("__proto__"), null);
});

test("the browser copy of the policy agrees with the server copy", () => {
  assert.equal(demoPolicy.POLICY_VERSION, POLICY_VERSION);
  assert.equal(demoPolicy.toolDefinitionText("deploy.production"), toolDefinitionText("deploy.production"));
  assert.deepEqual(demoPolicy.bindingPayload(input), bindingPayload(input));
});
