// Shared fixture for the MCP tests: a real HTTP server on a random loopback
// port, a real store and service, and a small JSON-RPC client that sends the
// per-request _meta and the headers the 2026-07-28 revision requires.
import { createServer } from "node:http";
import { createHttpHandler } from "../../server/http.js";
import { createGatewayService } from "../../server/service.js";
import { SCENARIOS, TOOL_REGISTRY } from "../../server/scenarios.js";
import { createStore } from "../../server/store.js";
import { createMcpServer, MODERN_VERSION, LEGACY_VERSION } from "../../server/mcp.js";
import { createMcpHttpHandler } from "../../server/mcp-http.js";

export { SCENARIOS, MODERN_VERSION, LEGACY_VERSION };
export const AGENT_ID = "mcp-agent-test";
export const AUDIT_KEY = "test-audit-key-must-never-leak-0123456789";

export function modernMeta(extra = {}) {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "raw-test-client", version: "0.0.1" },
    ...extra,
  };
}

export function modernMessage(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: modernMeta() } };
}

export function modernHeaders(method, params = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MODERN_VERSION,
    "mcp-method": method,
  };
  if (method === "tools/call") headers["mcp-name"] = params.name;
  return headers;
}

export async function startMcpFixture({
  maxBodyBytes,
  allowedHosts,
  allowedOrigins,
  clock,
  agentId = AGENT_ID,
  maxRequestsPerMinute = 100000,
} = {}) {
  const store = createStore(":memory:", { auditKey: AUDIT_KEY });
  const service = createGatewayService({ store, ...(clock ? { clock } : {}) });
  service.reset("test-startup");
  const mcp = createMcpServer({
    service,
    store,
    toolRegistry: TOOL_REGISTRY,
    agentId,
    ...(clock ? { clock } : {}),
    log: () => {},
  });
  const server = createServer(
    createHttpHandler({
      service,
      scenarios: SCENARIOS,
      toolRegistry: TOOL_REGISTRY,
      clientDir: "/nonexistent",
      mcpHandler: createMcpHttpHandler({ mcp, maxBodyBytes, allowedHosts, allowedOrigins, maxRequestsPerMinute }),
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const transcript = [];
  let nextId = 1;

  async function post(body, headers, { raw = false, record = false } = {}) {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: raw ? body : JSON.stringify(body),
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (record) transcript.push({ request: body, status: response.status, response: json });
    return { status: response.status, headers: response.headers, json, text };
  }

  // A well formed 2026-07-28 request. Returns the HTTP status and parsed body.
  async function call(method, params = {}, options = {}) {
    const message = modernMessage(options.id ?? nextId++, method, params);
    return post(message, modernHeaders(method, params), options);
  }

  function tool(name, args, options = {}) {
    return call("tools/call", { name, arguments: args }, options);
  }

  async function api(path, init) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json" },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
    return { status: response.status, json: await response.json() };
  }

  function review(requestId, { reviewerId, reviewerRole, decision = "approve", reason = "Scope and duration are the minimum needed for this test." }) {
    return api(`/api/requests/${requestId}/decision`, {
      method: "POST",
      body: { reviewerId, reviewerRole, decision, reason },
    });
  }

  return {
    baseUrl,
    store,
    service,
    mcp,
    transcript,
    post,
    call,
    tool,
    api,
    review,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

export function scenarioArguments(scenario) {
  const r = scenario.request;
  const args = {
    action: r.action,
    resource: r.resource,
    environment: r.environment,
    dataClassification: r.dataClassification,
    requestedScopes: r.requestedScopes,
    existingScopes: r.existingScopes,
    justification: r.justification,
    context: r.context,
  };
  if (r.skipAnalysis) args.skipAnalysis = true;
  return args;
}

// A deliberately small JSON Schema checker for the subset the gateway's own
// outputSchema uses: type (single or list), enum, required, items, properties.
export function validateSubset(schema, value, path = "$") {
  const problems = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (types && !types.includes(actual)) problems.push(`${path}: expected ${types.join("|")}, got ${actual}`);
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (actual === "object" && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) problems.push(...validateSubset(sub, value[key], `${path}.${key}`));
    }
  }
  if (actual === "array" && schema.items) {
    value.forEach((item, index) => problems.push(...validateSubset(schema.items, item, `${path}[${index}]`)));
  }
  return problems;
}
