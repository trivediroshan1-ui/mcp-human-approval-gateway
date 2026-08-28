// Browser demo API client — exposes the same interface as the /api routes.
// Parses the path+method that App.jsx passes to api() and dispatches to the
// in-memory gateway service. No network requests, no credentials.

import { SCENARIOS, TOOL_REGISTRY } from "./scenarios.js";
import { createStore } from "./store.js";
import { createGatewayService } from "./service.js";

// ─── Singleton service (persists across React renders) ────────────────────────
const store = createStore();
const service = createGatewayService({ store });

// Seed the audit chain with a genesis reset on first load.
let _initialized = false;
async function ensureInitialized() {
  if (_initialized) return;
  _initialized = true;
  // Only reset if there's no existing state (fresh tab).
  if (store.listRequests(1).length === 0 && (await store.verifyAuditChain()).checkedEvents === 0) {
    await service.reset("demo-startup");
  }
}

// ─── Route dispatcher ─────────────────────────────────────────────────────────
// Mirrors the HTTP API contract defined in server/http.js and docs/openapi.yaml.

/**
 * Drop-in replacement for the api(path, options) helper in App.jsx.
 * Returns the same JSON payload shapes the server would return.
 */
export async function demoApiAdapter(path, options = {}) {
  await ensureInitialized();

  const method = (options.method ?? "GET").toUpperCase();
  const body = options.body ? JSON.parse(options.body) : null;

  // GET /api/scenarios
  if (path === "/api/scenarios" && method === "GET") {
    return {
      scenarios: SCENARIOS,
      tools: Object.values(TOOL_REGISTRY),
      syntheticDataOnly: true,
    };
  }

  // GET /api/requests
  if (path === "/api/requests" && method === "GET") {
    return { requests: service.list(100) };
  }

  // POST /api/requests
  if (path === "/api/requests" && method === "POST") {
    const result = await service.submit(body);
    if (!result.ok) {
      const error = new Error(result.message ?? "Submission failed.");
      error.payload = result;
      throw error;
    }
    return result;
  }

  // POST /api/requests/:id/decision
  const decisionMatch = path.match(/^\/api\/requests\/([^/]+)\/decision$/);
  if (decisionMatch && method === "POST") {
    const id = decisionMatch[1];
    const result = await service.decide(id, body);
    if (!result.ok) {
      const error = new Error(result.message ?? "Decision failed.");
      error.payload = result;
      throw error;
    }
    return result;
  }

  // POST /api/requests/:id/execute
  const executeMatch = path.match(/^\/api\/requests\/([^/]+)\/execute$/);
  if (executeMatch && method === "POST") {
    const id = executeMatch[1];
    const result = await service.execute(id);
    if (!result.ok) {
      const error = new Error(result.message ?? "Execution failed.");
      error.payload = result;
      throw error;
    }
    return result;
  }

  // GET /api/audit
  if (path.startsWith("/api/audit") && !path.includes("/verify") && method === "GET") {
    const url = new URL(path, "http://x");
    const limit = Number(url.searchParams.get("limit") || 100);
    const requestId = url.searchParams.get("requestId") || null;
    return { events: service.audit(requestId, limit) };
  }

  // GET /api/audit/verify
  if (path === "/api/audit/verify" && method === "GET") {
    return await service.verifyAudit();
  }

  // POST /api/reset
  if (path === "/api/reset" && method === "POST") {
    const result = await service.reset();
    return result;
  }

  // GET /api/health
  if (path === "/api/health" && method === "GET") {
    return { status: "ok", syntheticDataOnly: true, mode: "browser-demo" };
  }

  const error = new Error(`Demo adapter: unknown route ${method} ${path}`);
  error.payload = { error: "not_found" };
  throw error;
}
