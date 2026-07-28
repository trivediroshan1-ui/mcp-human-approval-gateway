import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayService } from "./service.js";
import { createHttpHandler } from "./http.js";
import { SCENARIOS, TOOL_REGISTRY } from "./scenarios.js";
import { createStore } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const databasePath = resolve(
  projectRoot,
  process.env.DATABASE_PATH ?? "./data/gateway.db",
);
const clientDir = resolve(projectRoot, "dist/client");
const port = Number(process.env.PORT ?? 4174);

const store = createStore(databasePath);
const service = createGatewayService({ store });
if (store.listAudit(null, 1).length === 0) service.reset("gateway-startup");

const server = createServer(
  createHttpHandler({
    service,
    scenarios: SCENARIOS,
    toolRegistry: TOOL_REGISTRY,
    clientDir,
  }),
);

server.listen(port, "0.0.0.0", () => {
  console.log(`MCP Human Approval Gateway listening on http://0.0.0.0:${port}`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
