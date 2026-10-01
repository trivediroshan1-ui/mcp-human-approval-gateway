// Browser demo API client. It answers the same /api routes as server/http.js by
// calling the in-browser gateway service. No network requests, no credentials.

import { SCENARIOS, TOOL_REGISTRY } from "./scenarios.js";
import { createStore } from "./store.js";
import { createGatewayService } from "./service.js";

const CLOCK_KEY = "mcp_gateway_demo_clock_v1";

function readOffset() {
  try {
    const value = Number(localStorage.getItem(CLOCK_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeOffset(value) {
  try {
    if (value === 0) localStorage.removeItem(CLOCK_KEY);
    else localStorage.setItem(CLOCK_KEY, String(value));
  } catch {
    // ignore
  }
}

// The lab clock is the real clock plus an offset the visitor can move forward
// to watch an authorization expire. It never moves backwards.
let clockOffsetMs = readOffset();
const labNow = () => new Date(Date.now() + clockOffsetMs);

const store = createStore();
const service = createGatewayService({ store, clock: labNow });

// One shared promise, so parallel first calls wait for the same start-up reset.
let initialization = null;
function ensureInitialized() {
  initialization ??= (async () => {
    if (store.listRequests(1).length === 0 && (await store.verifyAuditChain()).checkedEvents === 0) {
      await service.reset("demo-startup");
    }
  })();
  return initialization;
}

function fail(message, payload) {
  const error = new Error(message);
  error.payload = payload;
  return error;
}

async function unwrap(promise, fallbackMessage) {
  const result = await promise;
  if (!result.ok) throw fail(result.message ?? fallbackMessage, result);
  return result;
}

/**
 * Drop-in replacement for the api(path, options) helper in App.jsx.
 * Returns the same JSON payload shapes the server would return.
 */
export async function demoApiAdapter(path, options = {}) {
  await ensureInitialized();

  const method = (options.method ?? "GET").toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const url = new URL(path, "http://demo.local");
  const route = url.pathname;

  if (route === "/api/scenarios" && method === "GET") {
    return { scenarios: SCENARIOS, tools: Object.values(TOOL_REGISTRY), syntheticDataOnly: true };
  }
  if (route === "/api/requests" && method === "GET") {
    return { requests: service.list(100) };
  }
  if (route === "/api/requests" && method === "POST") {
    return unwrap(service.submit(body), "Submission failed.");
  }

  const decisionMatch = route.match(/^\/api\/requests\/([^/]+)\/decision$/);
  if (decisionMatch && method === "POST") {
    return unwrap(service.decide(decisionMatch[1], body), "Decision failed.");
  }

  const executeMatch = route.match(/^\/api\/requests\/([^/]+)\/execute$/);
  if (executeMatch && method === "POST") {
    return unwrap(
      service.execute(executeMatch[1], { requestHash: body.requestHash, actorId: body.actorId }),
      "Execution failed.",
    );
  }

  if (route === "/api/audit" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") || 100);
    return { events: service.audit(url.searchParams.get("requestId") || null, limit) };
  }
  if (route === "/api/audit/verify" && method === "GET") {
    const sequence = url.searchParams.get("anchorSequence");
    const hash = url.searchParams.get("anchorHash");
    return service.verifyAudit(sequence && hash ? { anchor: { sequence, hash } } : {});
  }
  if (route === "/api/reset" && method === "POST") {
    clockOffsetMs = 0;
    writeOffset(0);
    return service.reset();
  }
  if (route === "/api/health" && method === "GET") {
    return { status: "ok", syntheticDataOnly: true, mode: "browser-demo" };
  }

  // Lab-only controls. The server has no equivalent routes.
  if (route === "/api/lab" && method === "GET") {
    return { clockOffsetMs, now: labNow().toISOString() };
  }
  if (route === "/api/lab/advance-clock" && method === "POST") {
    const minutes = Number(body.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
      throw fail("Minutes must be between 1 and 1440.", { code: "invalid_minutes" });
    }
    clockOffsetMs += minutes * 60_000;
    writeOffset(clockOffsetMs);
    return { clockOffsetMs, now: labNow().toISOString() };
  }
  if (route === "/api/lab/tamper" && method === "POST") {
    // Edit a stored audit event in place and leave every hash alone. Verification
    // should then fail at exactly that event.
    const events = store.listAudit(null, 1000);
    const target =
      body.sequence !== undefined
        ? events.find((event) => event.sequence === Number(body.sequence))
        : events.find((event) => event.eventType.startsWith("policy.")) ?? events[events.length - 1];
    if (!target || !store.tamperAuditEvent(target.sequence, { tampered: true })) {
      throw fail("There is no audit event to tamper with yet. Run a scenario first.", {
        code: "nothing_to_tamper",
      });
    }
    return { ok: true, sequence: target.sequence };
  }

  throw fail(`Demo adapter: unknown route ${method} ${path}`, { error: "not_found" });
}
