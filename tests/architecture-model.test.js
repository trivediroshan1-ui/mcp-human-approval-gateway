import assert from "node:assert/strict";
import test from "node:test";
import { EDGES, EXTRA_PATHS, NODES, STEPS, planExtra, planRequest, planScenario } from "../src/architecture-model.js";
import { createFakeDownstream } from "../server/downstream.js";
import { EXECUTION_TIMEOUT_MINUTES } from "../server/service.js";
import { demoHarness } from "./helpers/harness.js";
import { SCENARIOS } from "../server/scenarios.js";

// Walks the edge ticks and checks each one starts where the token is. A tick
// marked jump starts a new request from the agent (a retry), so it resets. The
// confirm edge returns the token to the guard while the tool node stays lit.
function walk(route, label) {
  let at = "agent";
  for (const tick of route.ticks.filter((t) => t.edge)) {
    const edge = EDGES[tick.edge];
    const [from, to] = tick.reverse ? [edge.to, edge.from] : [edge.from, edge.to];
    if (tick.jump) at = from;
    assert.equal(from, at, `${label}: ${tick.edge} starts at ${at}`);
    at = to;
  }
  return route.ticks.filter((t) => t.edge).at(-1)?.edge === "e11" ? "tool" : at;
}

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
    const at = walk(route, scenario.id);
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
  assert.deepEqual(review.edges.slice(-6), ["e6b", "e7", "e8", "e9", "e10", "e11"]);
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

test("steps are numbered 1 to 15 and every edge step has an entry", () => {
  assert.deepEqual(STEPS.map((s) => s.n), Array.from({ length: 15 }, (_, i) => i + 1));
  for (const edge of Object.values(EDGES)) assert.ok(STEPS.some((s) => s.n === edge.step));
  for (const edge of Object.values(EDGES)) assert.ok(NODES[edge.from] && NODES[edge.to]);
  for (const step of STEPS) assert.ok(step.guardrail.length > 20);
});

test("normal path is reserve, dispatch, confirm, audit with one dispatch", () => {
  const route = planScenario(SCENARIOS.find((s) => s.id === "public-research"));
  const beats = route.ticks.map((t) => (t.hold ? `hold:${t.step}` : t.audit ? "audit" : t.edge));
  assert.deepEqual(beats.slice(-5), ["e9", "hold:10", "e10", "e11", "audit"]);
  assert.equal(route.dispatches, 1);
  assert.deepEqual(route.events.filter((e) => e.slot === 4).map((e) => e.label), ["action.reserved", "action.confirmed"]);
});

test("lost response: retry with the same key is served from the record and the tool is dispatched once", () => {
  const route = planExtra("path:lost-response", SCENARIOS);
  assert.equal(route.dispatches, 1);
  assert.equal(route.tone, "ok");
  assert.equal(route.stop, "agent");
  assert.equal(walk(route, "lost"), "agent");
  const tail = route.ticks.slice(-4);
  assert.equal(tail[0].pill, "reply lost");
  assert.equal(tail[1].jump, true);
  assert.equal(tail[2].reverse, true);
  assert.equal(tail[2].pill, "replayed");
  assert.deepEqual(route.events.filter((e) => e.slot === 4).map((e) => e.label), ["action.reserved", "action.confirmed", "action.retry_served"]);
});

test("no confirm: unknown outcome, never re-dispatched, waits for a reviewer", () => {
  const route = planExtra("path:no-confirm", SCENARIOS);
  assert.equal(route.dispatches, 1);
  assert.equal(route.tone, "waiting");
  assert.equal(route.stop, "reviewer");
  assert.equal(walk(route, "no-confirm"), "reviewer");
  assert.equal(route.edges.includes("e11"), false, "no confirm edge");
  assert.match(route.summary, /not the requester/);
  assert.match(route.summary, new RegExp(`${EXECUTION_TIMEOUT_MINUTES} minutes`));
  assert.ok(route.events.some((e) => e.label === "action.unknown_outcome"));
  assert.equal(EXTRA_PATHS.length, 2);
});

test("stored execution states map to the right stop", () => {
  const base = { ...SCENARIOS.find((s) => s.id === "public-research").request, decisions: [] };
  assert.equal(planRequest({ ...base, status: "executing" }).stop, "tool");
  assert.equal(planRequest({ ...base, status: "executing" }).tone, "waiting");
  assert.equal(planRequest({ ...base, status: "unknown_outcome" }).stop, "reviewer");
  const failed = planRequest({ ...base, status: "failed" });
  assert.equal(failed.tone, "blocked");
  assert.equal(failed.dispatches, 1);
});

// The model is checked against what the service really does, not only against
// itself: same audit event names, same dispatch count.
test("the model matches the real service for a lost response and for no confirm", async (t) => {
  const downstream = createFakeDownstream();
  const h = demoHarness({ downstream });
  t.after(() => h.close());
  const { service, time } = h;
  const { request } = await service.submit({ scenarioId: "public-research" });
  const body = { requestHash: request.requestHash, actorId: request.actorId, idempotencyKey: "model-key-001" };
  await service.execute(request.id, body);
  await service.execute(request.id, body);
  const real = new Set(service.audit(request.id, 100).map((e) => e.eventType));
  const lost = planExtra("path:lost-response", SCENARIOS);
  for (const e of lost.events.filter((x) => x.slot === 4)) assert.ok(real.has(e.label), `${e.label} is a real audit event`);
  assert.equal(downstream.stats().effects, lost.dispatches);

  const second = createFakeDownstream();
  const h2 = demoHarness({ downstream: second });
  t.after(() => h2.close());
  const r2 = (await h2.service.submit({ scenarioId: "public-research" })).request;
  second.injectFault("timeout_after_effect");
  await h2.service.execute(r2.id, { requestHash: r2.requestHash, actorId: r2.actorId, idempotencyKey: "model-key-002" });
  h2.time.advanceMinutes(EXECUTION_TIMEOUT_MINUTES + 1);
  await h2.service.sweep();
  const stuck = planExtra("path:no-confirm", SCENARIOS);
  const real2 = new Set(h2.service.audit(r2.id, 100).map((e) => e.eventType));
  for (const e of stuck.events.filter((x) => x.slot === 4)) assert.ok(real2.has(e.label), `${e.label} is a real audit event`);
  assert.equal(second.stats().effects, stuck.dispatches);
  assert.equal(h2.service.get(r2.id).status, "unknown_outcome");
  void time;
});
