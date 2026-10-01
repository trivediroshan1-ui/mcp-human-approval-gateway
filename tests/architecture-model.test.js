import assert from "node:assert/strict";
import test from "node:test";
import { EDGES, NODES, STEPS, planRequest, planScenario } from "../src/architecture-model.js";
import { SCENARIOS } from "../server/scenarios.js";

const stops = {
  "public-research": ["tool", "ok"],
  "private-repo-review": ["tool", "ok"],
  "secret-metadata": ["tool", "ok"],
  "iam-privilege-change": ["tool", "ok"],
  "prompt-injection": ["denied", "blocked"],
  "scope-creep": ["denied", "blocked"],
  "production-deployment": ["tool", "ok"],
  "unknown-tool": ["registry", "blocked"],
  "ungated-handoff": ["gate", "blocked"],
};

test("every scenario's animated path ends where the policy says it ends", () => {
  for (const scenario of SCENARIOS) {
    const route = planScenario(scenario);
    const [stop, tone] = stops[scenario.id];
    assert.equal(route.stop, stop, scenario.id);
    assert.equal(route.tone, tone, scenario.id);
    assert.equal(route.ticks.at(-1).audit, true, "the last tick is the audit write");
  }
});

test("paths only use edges that connect the nodes in order", () => {
  for (const scenario of SCENARIOS) {
    const route = planScenario(scenario);
    let at = "agent";
    for (const tick of route.ticks.filter((t) => t.edge)) {
      const edge = EDGES[tick.edge];
      const [from, to] = tick.reverse ? [edge.to, edge.from] : [edge.from, edge.to];
      assert.equal(from, at, `${scenario.id}: ${tick.edge} starts at ${at}`);
      at = to;
    }
    assert.equal(at, route.stop, scenario.id);
  }
});

test("injected context stops at the policy decision, an unknown tool stops at the registry", () => {
  const injection = planScenario(SCENARIOS.find((s) => s.id === "prompt-injection"));
  assert.deepEqual(injection.edges.slice(-1), ["e6c"]);
  assert.match(injection.summary, /bypass controls/);
  assert.ok(injection.events.some((e) => e.label === "policy.deny"));
  const unknown = planScenario(SCENARIOS.find((s) => s.id === "unknown-tool"));
  assert.equal(unknown.edges.includes("e3"), false, "never reaches the policy engine");
});

test("auto-approval skips the human, review passes through the gate and reviewer", () => {
  const auto = planScenario(SCENARIOS.find((s) => s.id === "public-research"));
  assert.equal(auto.edges.includes("e7"), false);
  assert.equal(auto.edges.includes("e6a"), true);
  const review = planScenario(SCENARIOS.find((s) => s.id === "iam-privilege-change"));
  assert.deepEqual(review.edges.slice(-5), ["e6b", "e7", "e8", "e9", "e10"]);
  assert.equal(review.edges.includes("e6a"), false);
});

test("a stored request follows its real state", () => {
  const base = { ...SCENARIOS.find((s) => s.id === "private-repo-review").request, decisions: [] };
  assert.equal(planRequest({ ...base, status: "pending_human" }).stop, "reviewer");
  assert.equal(planRequest({ ...base, status: "pending_human" }).tone, "waiting");
  assert.equal(planRequest({ ...base, status: "approved" }).stop, "authz");
  assert.equal(planRequest({ ...base, status: "executed" }).stop, "tool");
  assert.equal(planRequest({ ...base, status: "expired" }).stop, "guard");
  const denied = planRequest({ ...base, status: "denied", decisions: [{ decision: "deny" }] });
  assert.equal(denied.stop, "reviewer");
  assert.equal(denied.tone, "blocked");
  assert.equal(planRequest({ ...base, status: "gate_rejected" }).stop, "gate");
});

test("steps are numbered 1 to 11 and every edge step has an entry", () => {
  assert.deepEqual(STEPS.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  for (const edge of Object.values(EDGES)) assert.ok(STEPS.some((s) => s.n === edge.step));
  for (const edge of Object.values(EDGES)) assert.ok(NODES[edge.from] && NODES[edge.to]);
  for (const step of STEPS) assert.ok(step.guardrail.length > 20);
});
