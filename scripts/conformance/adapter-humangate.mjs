// Adapter for the HumanGate gateway. Another gateway needs only these five functions:
//   start() -> void           bring the gateway up with an empty store
//   ask(toolId, input) -> { id, outcome }       first call, no approval yet
//   decide(id, "approve"|"deny") -> void        a person decides
//   run(toolId, input, id) -> { outcome }       execute with an approval id
//   stop() -> void
// "outcome" is a plain word: "executed" only when the real action went ahead.
import { spawn } from "node:child_process";
import { createServer as netServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODERN = "2026-07-28";
export function makeAdapter(root) {
  let child, base, nid = 1, tmp;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const call = async (name, args) => {
    const meta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "conformance", version: "1" } };
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": name }, body: JSON.stringify({ jsonrpc: "2.0", id: nid++, method: "tools/call", params: { name, arguments: args, _meta: meta } }) });
    const j = await r.json().catch(() => null);
    const o = j?.result?.structuredContent ?? j?.error ?? j ?? {};
    return { id: o.approvalId, outcome: o.outcome ?? o.code ?? o.message ?? "error" };
  };
  return {
    name: "HumanGate",
    async start() {
      tmp = mkdtempSync(join(tmpdir(), "conf-"));
      const port = await new Promise((res) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
      base = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, ["server/index.js"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: join(tmp, "c.db"), MCP_AGENT_ID: "mcp-agent-demo", AUDIT_HMAC_KEY: "conformance-key-0123456789" } });
      let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
      for (let i = 0; i < 100 && !log.includes("listening"); i++) await sleep(100);
    },
    ask: (toolId, input) => call(toolId, input),
    async decide(id, decision) {
      await fetch(`${base}/api/requests/${id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewerId: "lead-morgan", reviewerRole: "security-lead", decision, reason: "Human Review" }) });
    },
    run: (toolId, input, id) => call(toolId, { ...input, approvalId: id }),
    async stop() { child.kill("SIGINT"); await sleep(300); child.kill("SIGKILL"); rmSync(tmp, { recursive: true, force: true }); },
  };
}
