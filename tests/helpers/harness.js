// Test helpers shared by the parity and scenario tests. A "harness" wraps one
// gateway implementation (the Node and SQLite one, or the browser one) behind
// the same async interface so a single script can drive both.
import { createGatewayService as createServerService } from "../../server/service.js";
import { createStore as createServerStore } from "../../server/store.js";
import { createGatewayService as createDemoService } from "../../src/demo/service.js";
import { createStore as createDemoStore } from "../../src/demo/store.js";

export const START = "2026-07-28T08:00:00.000Z";

function clockFixture(initial = START) {
  let now = new Date(initial);
  return {
    clock: () => new Date(now),
    set(value) {
      now = new Date(value);
    },
    advanceMinutes(minutes) {
      now = new Date(now.getTime() + minutes * 60_000);
    },
  };
}

export function serverHarness(options = {}) {
  const time = clockFixture();
  const store = createServerStore(options.path ?? ":memory:", options.storeOptions);
  const service = createServerService({ store, clock: time.clock, analyzer: options.analyzer });
  return { name: "server", store, service, time, close: () => store.close() };
}

export function demoHarness(options = {}) {
  const time = clockFixture();
  const store = createDemoStore();
  const service = createDemoService({ store, clock: time.clock, analyzer: options.analyzer });
  return { name: "demo", store, service, time, close: () => store.close() };
}

const REVIEWER_BY_ROLE = {
  "resource-owner": "owner-aria",
  "security-analyst": "analyst-dev",
  "security-lead": "lead-morgan",
};

// Drives one scenario through every guard and returns a transcript of the
// outcomes. Both implementations must produce the same transcript.
export async function runScenario(harness, scenarioId) {
  const { service, time } = harness;
  const steps = [];
  const note = (label, value) => steps.push([label, value]);

  const submitted = await service.submit({ scenarioId });
  const request = submitted.request;
  note("submit", {
    ok: submitted.ok,
    status: request.status,
    policyDecision: request.policyDecision,
    riskScore: request.riskScore,
    riskLevel: request.riskLevel,
    approvalRole: request.approvalRole,
    requestHash: request.requestHash,
    policyReasons: request.policyReasons,
    policyControls: request.policyControls,
    authorizationExpiresAt: request.authorizationExpiresAt,
    provider: request.aiAnalysis.provider,
    analysisSummary: request.aiAnalysis.summary,
    decisionPackageComplete: request.aiAnalysis.decisionPackage?.complete,
  });

  const execBlocked =
    request.status === "auto_approved" ? null : await service.execute(request.id);
  if (request.status === "pending_human") {
    note("execute before approval", { ok: execBlocked.ok, code: execBlocked.code });

    const viewer = await service.decide(request.id, {
      reviewerId: "viewer-vic",
      reviewerRole: "viewer",
      decision: "approve",
      reason: "A viewer should never be able to approve this.",
    });
    note("viewer approve", { ok: viewer.ok, code: viewer.code });

    const self = await service.decide(request.id, {
      reviewerId: request.actorId,
      reviewerRole: "security-lead",
      decision: "approve",
      reason: "The requester approving itself must be refused.",
    });
    note("self approve", { ok: self.ok, code: self.code });

    if (request.approvalRole !== "resource-owner") {
      const low = await service.decide(request.id, {
        reviewerId: REVIEWER_BY_ROLE["resource-owner"],
        reviewerRole: "resource-owner",
        decision: "approve",
        reason: "A resource owner is below the required role here.",
      });
      note("under-qualified approve", { ok: low.ok, code: low.code });
    }

    const approved = await service.decide(request.id, {
      reviewerId: REVIEWER_BY_ROLE[request.approvalRole],
      reviewerRole: request.approvalRole,
      decision: "approve",
      reason: "Scope and duration are the minimum needed for this synthetic exercise.",
    });
    note("approve", {
      ok: approved.ok,
      status: approved.request?.status,
      expiresInMinutes:
        (Date.parse(approved.request.authorizationExpiresAt) - Date.parse(approved.request.updatedAt)) / 60_000,
    });
  } else if (execBlocked) {
    note("execute without authorization", { ok: execBlocked.ok, code: execBlocked.code });
  }

  const current = service.get(request.id);
  if (["approved", "auto_approved"].includes(current.status)) {
    const wrongHash = await service.execute(request.id, { requestHash: "0".repeat(64) });
    note("execute wrong hash", { ok: wrongHash.ok, code: wrongHash.code });
    const wrongActor = await service.execute(request.id, { actorId: "someone-else" });
    note("execute wrong actor", { ok: wrongActor.ok, code: wrongActor.code });
    const run = await service.execute(request.id, {
      requestHash: current.requestHash,
      actorId: current.actorId,
    });
    note("execute", { ok: run.ok, status: run.request?.status, simulated: run.execution?.simulated });
    const replay = await service.execute(request.id);
    note("replay", { ok: replay.ok, code: replay.code });
  }
  note("final", { status: service.get(request.id).status });
  const verification = await service.verifyAudit();
  delete verification.headHash; // depends on random event ids
  note("audit", verification);
  void time;
  return steps;
}

// Removes values that are random per run so transcripts can be compared.
export function auditShape(events, extraStrip = []) {
  return events
    .slice()
    .reverse()
    .map((event) => {
      const payload = { ...event.payload };
      delete payload.executionId;
      for (const key of extraStrip) delete payload[key];
      return { sequence: event.sequence, eventType: event.eventType, actor: event.actor, payload };
    });
}
