// stdio transport for the MCP server core. Run it with `npm run mcp:stdio`.
//
// One JSON-RPC message per line on stdin, one reply per line on stdout. Only
// valid MCP messages go to stdout; logs go to stderr. When stdin closes the
// process exits. The database is the same SQLite file the HTTP server uses,
// so a reviewer can approve in the UI while an agent talks over stdio.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMcpServer, ERR } from "./mcp.js";

const MAX_LINE_BYTES = 64 * 1024;

export function runStdio({ mcp, input = process.stdin, output = process.stdout, log = (m) => console.error(m) }) {
  const session = { initialized: false };
  let buffer = "";
  let discarding = false;
  let chain = Promise.resolve();

  function write(body) {
    // JSON.stringify never emits a raw newline, so one message is one line.
    output.write(`${JSON.stringify(body)}\n`);
  }

  function processLine(line) {
    chain = chain.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write(mcp.reject(400, ERR.PARSE, "Parse error: the line is not valid JSON.", "parse_error", { transport: "stdio" }));
        return;
      }
      const { body } = await mcp.handle(message, { transport: "stdio", headers: null, session });
      if (body !== null) write(body);
    });
  }

  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (discarding) {
        discarding = false;
        continue;
      }
      if (line) processLine(line);
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      buffer = "";
      discarding = true;
      chain = chain.then(() =>
        write(mcp.reject(400, ERR.INVALID_REQUEST, `A message is larger than ${MAX_LINE_BYTES} bytes.`, "body_too_large", { transport: "stdio" })),
      );
    }
  });
  const done = new Promise((resolveDone) => {
    input.on("end", () => {
      const rest = buffer.trim();
      if (rest && !discarding) processLine(rest);
      chain.then(resolveDone);
    });
  });
  input.on("error", (error) => log(`mcp-stdio: input error: ${error.message}`));
  return done;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const { createStore } = await import("./store.js");
  const { createGatewayService } = await import("./service.js");
  const { TOOL_REGISTRY } = await import("./scenarios.js");
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const databasePath = resolve(projectRoot, process.env.DATABASE_PATH ?? "./data/gateway.db");
  const store = createStore(databasePath, { auditKey: process.env.AUDIT_HMAC_KEY || null });
  const service = createGatewayService({ store });
  if (store.listAudit(null, 1).length === 0) service.reset("gateway-startup");
  const mcp = createMcpServer({
    service,
    store,
    toolRegistry: TOOL_REGISTRY,
    agentId: process.env.MCP_AGENT_ID || "mcp-agent-demo",
  });
  console.error(`mcp-stdio: ready (agent id ${mcp.agentId}, database ${databasePath}). Unauthenticated demo mode.`);
  await runStdio({ mcp });
  store.close();
}
