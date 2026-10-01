// stdio transport test: a real child process, newline-delimited JSON-RPC on
// stdin and stdout, and a reviewer approving through a second connection to
// the same SQLite file, which is how the stdio server is meant to be used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayService } from "../server/service.js";
import { createStore } from "../server/store.js";
import { LEGACY_VERSION, MODERN_VERSION, SCENARIOS, modernMessage, scenarioArguments } from "./helpers/mcp-fixture.js";

function startChild(databasePath) {
  const child = spawn(process.execPath, ["--no-warnings", "server/mcp-stdio.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_PATH: databasePath, MCP_AGENT_ID: "stdio-agent-test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const lines = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      lines.push(line);
      waiters.shift()?.();
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  async function nextLine() {
    if (lines.length === 0) {
      await new Promise((resolve, reject) => {
        waiters.push(resolve);
        setTimeout(() => reject(new Error(`no output from child. stderr: ${stderr}`)), 8000).unref();
      });
    }
    return lines.shift();
  }

  return {
    lines,
    get stderr() {
      return stderr;
    },
    send(message) {
      child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    },
    async request(message) {
      this.send(message);
      const line = await nextLine();
      assert.ok(!line.includes("\n"));
      return JSON.parse(line);
    },
    async close() {
      child.stdin.end();
      return exited;
    },
  };
}

test("stdio: lifecycle, tool calls, approval through a second connection, clean exit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-stdio-"));
  const databasePath = join(dir, "gateway.db");
  const child = startChild(databasePath);
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 2026-07-28: no handshake needed, per-request _meta.
  const discover = await child.request(modernMessage(1, "server/discover"));
  assert.equal(discover.result.resultType, "complete");
  assert.deepEqual(discover.result.supportedVersions, [MODERN_VERSION, LEGACY_VERSION]);
  assert.deepEqual(discover.result.capabilities, { tools: { listChanged: false } });

  const list = await child.request(modernMessage(2, "tools/list"));
  assert.ok(list.result.tools.some((tool) => tool.name === "check_approval_status"));

  // A notification produces no output at all.
  child.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } });

  const auto = await child.request(modernMessage(3, "tools/call", { name: "docs.search", arguments: scenarioArguments(SCENARIOS[0]) }));
  assert.equal(auto.id, 3, "the notification above produced no line, so this is the next reply");
  assert.equal(auto.result.structuredContent.outcome, "executed");

  const unknown = await child.request(modernMessage(4, "tools/call", { name: "shell.root", arguments: {} }));
  assert.equal(unknown.error.code, -32602);

  const args = scenarioArguments(SCENARIOS.find((s) => s.id === "production-deployment"));
  const pending = await child.request(modernMessage(5, "tools/call", { name: "deploy.production", arguments: args }));
  assert.equal(pending.result.structuredContent.outcome, "pending_approval");
  const approvalId = pending.result.structuredContent.approvalId;

  // The human side: another process, same database.
  const store = createStore(databasePath);
  const service = createGatewayService({ store });
  const decision = await service.decide(approvalId, {
    reviewerId: "lead-morgan",
    reviewerRole: "security-lead",
    decision: "approve",
    reason: "Scope and duration are the minimum needed for this test.",
  });
  assert.equal(decision.ok, true);

  const ran = await child.request(modernMessage(6, "tools/call", { name: "deploy.production", arguments: { ...args, approvalId } }));
  assert.equal(ran.result.structuredContent.outcome, "executed");
  const replay = await child.request(modernMessage(7, "tools/call", { name: "deploy.production", arguments: { ...args, approvalId } }));
  assert.equal(replay.result.structuredContent.outcome, "replay_blocked");

  // Errors on the wire.
  const garbage = await child.request("{not json");
  assert.equal(garbage.error.code, -32700);
  const batch = await child.request([modernMessage(8, "tools/list")]);
  assert.equal(batch.error.code, -32600);
  const badVersion = await child.request({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01", "io.modelcontextprotocol/clientCapabilities": {} } },
  });
  assert.equal(badVersion.error.code, -32022);
  assert.deepEqual(badVersion.error.data.supported, [MODERN_VERSION, LEGACY_VERSION]);

  // The audit chain written by the child verifies and carries MCP events.
  const events = service.audit(null, 200);
  assert.ok(events.some((event) => event.eventType === "mcp.tools_call" && event.payload.transport === "stdio"));
  assert.equal((await service.verifyAudit()).valid, true);
  store.close();

  const exit = await child.close();
  assert.equal(exit.code, 0, "the server exits when stdin closes");
  assert.deepEqual(child.lines, [], "nothing else was written to stdout");
  assert.match(child.stderr, /unauthenticated demo mode/i);
});

test("stdio: the initialize era works and is enforced per process", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-stdio-legacy-"));
  const child = startChild(join(dir, "gateway.db"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const early = await child.request({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(early.error.code, -32600, "legacy requests need initialize first");

  const init = await child.request({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: "legacy-stdio", version: "1" } },
  });
  assert.equal(init.result.protocolVersion, LEGACY_VERSION);
  child.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const ping = await child.request({ jsonrpc: "2.0", id: 3, method: "ping" });
  assert.deepEqual(ping.result, {});
  const list = await child.request({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  assert.ok(list.result.tools.length > 0);
  const call = await child.request({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "docs.search", arguments: scenarioArguments(SCENARIOS[0]) },
  });
  assert.equal(call.result.structuredContent.outcome, "executed");
  assert.equal(call.result.resultType, undefined);

  const exit = await child.close();
  assert.equal(exit.code, 0);
});
