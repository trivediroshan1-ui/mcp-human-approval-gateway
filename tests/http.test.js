import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpHandler } from "../server/http.js";
import { createGatewayService } from "../server/service.js";
import { SCENARIOS, TOOL_REGISTRY } from "../server/scenarios.js";
import { createStore } from "../server/store.js";

async function startFixture() {
  const store = createStore();
  const service = createGatewayService({ store });
  service.reset("test-startup");
  const clientDir = await mkdtemp(join(tmpdir(), "mcp-gateway-client-"));
  await writeFile(join(clientDir, "index.html"), "<!doctype html><title>Gateway</title>");
  const server = createServer(
    createHttpHandler({
      service,
      scenarios: SCENARIOS,
      toolRegistry: TOOL_REGISTRY,
      clientDir,
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      await rm(clientDir, { recursive: true, force: true });
    },
  };
}

test("health and scenario endpoints expose synthetic lab metadata", async (t) => {
  const app = await startFixture();
  t.after(() => app.close());

  const health = await fetch(`${app.baseUrl}/api/health`).then((response) =>
    response.json(),
  );
  const catalog = await fetch(`${app.baseUrl}/api/scenarios`).then((response) =>
    response.json(),
  );

  assert.equal(health.status, "ok");
  assert.equal(health.syntheticDataOnly, true);
  assert.equal(catalog.scenarios.length, SCENARIOS.length);
  assert.equal(catalog.tools.length, Object.keys(TOOL_REGISTRY).length);
});

test("HTTP workflow preserves deterministic policy and human approval", async (t) => {
  const app = await startFixture();
  t.after(() => app.close());

  const submissionResponse = await fetch(`${app.baseUrl}/api/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "production-deployment" }),
  });
  const submission = await submissionResponse.json();
  assert.equal(submissionResponse.status, 201);
  assert.equal(submission.request.status, "pending_human");

  const decisionResponse = await fetch(
    `${app.baseUrl}/api/requests/${submission.request.id}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewerId: "security-lead-01",
        reviewerRole: "security-lead",
        decision: "approve",
        reason: "Synthetic deployment has a documented rollback and bounded scope.",
      }),
    },
  );
  const decision = await decisionResponse.json();
  assert.equal(decisionResponse.status, 200);
  assert.equal(decision.request.status, "approved");

  const executionResponse = await fetch(
    `${app.baseUrl}/api/requests/${submission.request.id}/execute`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  const execution = await executionResponse.json();
  assert.equal(executionResponse.status, 200);
  assert.equal(execution.execution.simulated, true);
});

test("write routes reject missing JSON content type", async (t) => {
  const app = await startFixture();
  t.after(() => app.close());

  const response = await fetch(`${app.baseUrl}/api/requests`, {
    method: "POST",
    body: JSON.stringify({ scenarioId: "public-research" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 415);
  assert.equal(payload.error, "invalid_request");
});

test("static responses include browser hardening headers and support HEAD", async (t) => {
  const app = await startFixture();
  t.after(() => app.close());

  const response = await fetch(`${app.baseUrl}/`, { method: "HEAD" });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(body, "");
});

test("submitting the ungated-handoff scenario over HTTP is gate-rejected", async (t) => {
  const app = await startFixture();
  t.after(() => app.close());

  const submissionResponse = await fetch(`${app.baseUrl}/api/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "ungated-handoff" }),
  });
  const submission = await submissionResponse.json();
  assert.equal(submissionResponse.status, 201);
  assert.equal(submission.request.status, "gate_rejected");
});
