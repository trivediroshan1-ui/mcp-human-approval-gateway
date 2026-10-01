import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayService } from "./service.js";
import { createHttpHandler } from "./http.js";
import { SCENARIOS, TOOL_REGISTRY } from "./scenarios.js";
import { createStore } from "./store.js";
import { createMcpServer } from "./mcp.js";
import { createMcpHttpHandler, parseList } from "./mcp-http.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const databasePath = resolve(
  projectRoot,
  process.env.DATABASE_PATH ?? "./data/gateway.db",
);
const clientDir = resolve(projectRoot, "dist/client");
const port = Number(process.env.PORT ?? 4174);
// Loopback by default. Container and hosted setups set HOST=0.0.0.0.
const host = process.env.HOST ?? "127.0.0.1";
const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(host);

// AUDIT_HMAC_KEY (optional): signs every audit event so a database writer
// without the key cannot rebuild the chain. ALLOW_RESET=false removes the
// unauthenticated reset route.
const store = createStore(databasePath, { auditKey: process.env.AUDIT_HMAC_KEY || null });
const service = createGatewayService({ store });
if (store.listAudit(null, 1).length === 0) service.reset("gateway-startup");

// The MCP endpoint (POST /mcp) is on by default only when the server is bound
// to loopback. Anywhere else it needs MCP_HTTP=true and, behind a proxy,
// MCP_ALLOWED_HOSTS. It is unauthenticated demo mode either way.
const mcpEnabled = (process.env.MCP_HTTP ?? (isLoopback ? "true" : "false")) === "true";
const mcpHandler = mcpEnabled
  ? createMcpHttpHandler({
      mcp: createMcpServer({
        service,
        store,
        toolRegistry: TOOL_REGISTRY,
        agentId: process.env.MCP_AGENT_ID || "mcp-agent-demo",
      }),
      allowedHosts: parseList(process.env.MCP_ALLOWED_HOSTS),
      allowedOrigins: parseList(process.env.MCP_ALLOWED_ORIGINS),
    })
  : null;

const server = createServer(
  createHttpHandler({
    service,
    scenarios: SCENARIOS,
    toolRegistry: TOOL_REGISTRY,
    clientDir,
    allowReset: process.env.ALLOW_RESET !== "false",
    mcpHandler,
  }),
);

server.listen(port, host, () => {
  console.log(`MCP Human Approval Gateway listening on http://${host}:${port}`);
  console.log(
    mcpEnabled
      ? `MCP endpoint: POST http://${host}:${port}/mcp (unauthenticated demo mode)`
      : "MCP endpoint is off. Set MCP_HTTP=true to turn it on.",
  );
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
