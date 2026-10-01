import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as rawRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpHandler } from "../server/http.js";
import { createGatewayService } from "../server/service.js";
import { SCENARIOS, TOOL_REGISTRY } from "../server/scenarios.js";
import { createStore } from "../server/store.js";

async function start({ allowReset = true, service: override } = {}) {
  const store = createStore();
  const service = override ?? createGatewayService({ store });
  service.reset?.("test-startup");
  const clientDir = await mkdtemp(join(tmpdir(), "mcp-gateway-client-"));
  await writeFile(join(clientDir, "index.html"), "<!doctype html><title>Gateway</title>");
  const logged = [];
  const server = createServer(
    createHttpHandler({
      service, scenarios: SCENARIOS, toolRegistry: TOOL_REGISTRY, clientDir, allowReset,
      log: (message) => logged.push(message),
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port, logged, base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
      await rm(clientDir, { recursive: true, force: true });
    },
  };
}

const postJson = (app, path, body, headers = {}) =>
  fetch(`${app.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// fetch() will not let a script set Origin or a raw path, so this goes through node:http.
function raw(app, { method = "GET", path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = rawRequest({ host: "127.0.0.1", port: app.port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("a text/plain request that hides application/json in a parameter is refused", async (t) => {
  const app = await start();
  t.after(() => app.close());
  const response = await raw(app, {
    method: "POST", path: "/api/reset",
    headers: { "content-type": "text/plain; x=application/json", "content-length": "2" }, body: "{}",
  });
  assert.equal(response.status, 415);
  const ok = await raw(app, {
    method: "POST", path: "/api/reset",
    headers: { "content-type": "Application/JSON; charset=utf-8", "content-length": "2" }, body: "{}",
  });
  assert.equal(ok.status, 200);
});

test("writes that carry a foreign Origin header are refused, same-origin and header-less ones are not", async (t) => {
  const app = await start();
  t.after(() => app.close());
  const headers = { "content-type": "application/json", "content-length": "2" };
  const foreign = await raw(app, { method: "POST", path: "/api/reset", headers: { ...headers, origin: "https://evil.example" }, body: "{}" });
  assert.equal(foreign.status, 403);
  const same = await raw(app, { method: "POST", path: "/api/reset", headers: { ...headers, origin: app.base }, body: "{}" });
  assert.equal(same.status, 200);
  const none = await raw(app, { method: "POST", path: "/api/reset", headers, body: "{}" });
  assert.equal(none.status, 200);
});

test("bodies that are not JSON objects are a 400, never a 500", async (t) => {
  const app = await start();
  t.after(() => app.close());
  for (const body of ["null", "[]", "42", '"text"', "{broken"]) {
    const response = await postJson(app, "/api/requests", body);
    assert.equal(response.status, 400, body);
  }
  const decision = await postJson(app, "/api/requests/anything/decision", "null");
  assert.equal(decision.status, 400);
});

test("a malformed percent sequence in the path is a 400", async (t) => {
  const app = await start();
  t.after(() => app.close());
  const response = await raw(app, { method: "GET", path: "/api/requests/%E0%A4%A" });
  assert.equal(response.status, 400);
});

test("a submission with hostile field types is a policy deny over HTTP, not an error", async (t) => {
  const app = await start();
  t.after(() => app.close());
  const response = await postJson(app, "/api/requests", { toolId: "constructor", actorId: { a: 1 } });
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.request.status, "denied");
});

test("internal errors are logged but not shown to the caller", async (t) => {
  const broken = {
    list() { throw new Error("SECRET-INTERNAL-DETAIL /var/lib/db"); },
    reset() {},
  };
  const app = await start({ service: broken });
  t.after(() => app.close());
  const response = await fetch(`${app.base}/api/requests`);
  const payload = await response.json();
  assert.equal(response.status, 500);
  assert.equal(payload.error, "internal_error");
  assert.equal(JSON.stringify(payload).includes("SECRET-INTERNAL-DETAIL"), false);
  assert.match(app.logged.join("\n"), /SECRET-INTERNAL-DETAIL/);
});

test("responses carry object-src none, isolation headers and no-store on JSON", async (t) => {
  const app = await start();
  t.after(() => app.close());
  const response = await fetch(`${app.base}/api/health`);
  assert.match(response.headers.get("content-security-policy"), /object-src 'none'/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(response.headers.get("access-control-allow-origin"), null, "no CORS is granted");
});

test("the reset route can be switched off", async (t) => {
  const app = await start({ allowReset: false });
  t.after(() => app.close());
  const response = await postJson(app, "/api/reset", {});
  assert.equal(response.status, 403);
});

test("execute over HTTP honours the presented request hash and the audit anchor check", async (t) => {
  const app = await start();
  t.after(() => app.close());
  const submitted = await (await postJson(app, "/api/requests", { scenarioId: "public-research" })).json();
  const id = submitted.request.id;

  const wrong = await postJson(app, `/api/requests/${id}/execute`, { requestHash: "0".repeat(64) });
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).code, "binding_mismatch");

  const good = await postJson(app, `/api/requests/${id}/execute`, { requestHash: submitted.request.requestHash });
  assert.equal(good.status, 200);

  const verification = await (await fetch(`${app.base}/api/audit/verify`)).json();
  assert.equal(verification.valid, true);
  const anchored = await (
    await fetch(`${app.base}/api/audit/verify?anchorSequence=${verification.headSequence}&anchorHash=${verification.headHash}`)
  ).json();
  assert.equal(anchored.valid, true);
  assert.equal(anchored.anchorChecked, true);
  const wrongAnchor = await (
    await fetch(`${app.base}/api/audit/verify?anchorSequence=${verification.headSequence}&anchorHash=${"0".repeat(64)}`)
  ).json();
  assert.equal(wrongAnchor.valid, false);
});

test("the write rate limit answers 429 after the allowed burst", async (t) => {
  const app = await start();
  t.after(() => app.close());
  let limited = 0;
  for (let i = 0; i < 130; i += 1) {
    const response = await postJson(app, "/api/requests", { scenarioId: "public-research" });
    if (response.status === 429) limited += 1;
  }
  assert.ok(limited >= 9, `expected the limiter to engage, saw ${limited}`);
});
