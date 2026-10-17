// Puts the screen-check cases into a RUNNING gateway so you can look at them in the lab.
//   node scripts/seed-lab-cases.mjs [http://127.0.0.1:4174] [count]
// Creates pending requests for G5 (long text), G6 (hidden direction marks), G7 (markup),
// and a pile of ordinary pending requests for G22. Synthetic data only.
const base = process.argv[2] || "http://127.0.0.1:4174";
const count = Number(process.argv[3] || 40);
const M = "2026-07-28";
const meta = { "io.modelcontextprotocol/protocolVersion": M, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "seed", version: "1" } };
let id = 1;
async function call(just, release) {
  const args = { action: "deploy", resource: "service://payment-api", environment: "production", requestedScopes: ["deploy:production"], dataClassification: "confidential", existingScopes: [], justification: just, arguments: { release } };
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": M, "mcp-method": "tools/call", "mcp-name": "deploy.production" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "deploy.production", arguments: args, _meta: meta } }) });
  const j = await r.json().catch(() => null);
  return j?.result?.structuredContent ?? j?.error ?? j;
}
const out = [];
out.push(["G5 long text, marker at the very end: TAIL-MARKER-ZZZ", await call("G5 start. " + "A".repeat(1900) + " TAIL-MARKER-ZZZ", "g5")]);
out.push(["G6 hidden direction marks: Release evil ok", await call("G6 Release \u202eevil\u202c ok \u200f", "g6")]);
out.push(["G7 markup and a misleading link", await call("G7 <img src=x onerror=alert(1)> [safe](https://evil.example)", "g7")]);
for (const [label, r] of out) console.log(String(r.outcome ?? r.code ?? r.message).padEnd(18), label);
let made = 0, refused = 0;
for (let i = 1; i <= count; i++) { const r = await call("G22 queue filler number " + i, "g22-" + i); if (r.outcome === "pending_approval") made++; else refused++; }
console.log("G22 filler: " + made + " pending, " + refused + " refused (rate limit)");
console.log("Now open " + base + " and look at the queue.");
