// Regenerates src/demo/service.js from server/service.js.
// The browser demo must make the same decisions as the server, so the demo
// service is derived from the server one instead of being edited by hand.
// Run: node scripts/sync-demo-service.mjs   (tests/parity.test.js fails if the
// generated file is out of date)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function generateDemoService(serverSource) {
  let s = serverSource;
  s = s.replace('import { randomUUID } from "node:crypto";\n', "");
  s = s.replaceAll("randomUUID()", "crypto.randomUUID()");
  s = s.replace(
    /store\.(createRequestWithAudit|transitionWithAudit|recordDecisionAndTransition|recordAudit|resetWithAudit|verifyAuditChain)\(/g,
    "await store.$1(",
  );
  s = s.replace(
    "export function requestHashOf(request) {",
    "export async function requestHashOf(request) {",
  );
  s = s.replace("const requestHash = requestHashOf(", "const requestHash = await requestHashOf(");
  s = s.replace(
    "if (requestHashOf(request) !== request.requestHash)",
    "if ((await requestHashOf(request)) !== request.requestHash)",
  );
  s = s.replace("const recomputed = requestHashOf(request);", "const recomputed = await requestHashOf(request);");
  s = s.replace("  function blockExecution(", "  async function blockExecution(");
  s = s.replace("  function serveRetry(", "  async function serveRetry(");
  s = s.replace("const currentHash = requestHashOf(request);", "const currentHash = await requestHashOf(request);");
  // Two-phase execution. Every service method that touches the store becomes
  // async, and calls between them are awaited. hashEvent is async in the browser.
  for (const name of ["reserve", "dispatch", "confirm", "settleStuck", "getExecution", "getFresh", "sweep", "reconcile"]) {
    s = s.replace(`    ${name}(`, `    async ${name}(`);
  }
  s = s.replace(/this\.(reserve|dispatch|confirm|settleStuck|getExecution|getFresh|reconcile)\(/g, "await this.$1(");
  s = s.replace(/(?<![A-Za-z.])hashEvent\(/g, "await hashEvent(");
  s = s.replace("    decide(id, input = {}) {", "    async decide(id, input = {}) {");
  s = s.replace("    execute(id, options = {}) {", "    async execute(id, options = {}) {");
  s = s.replace("    verifyAudit(options) {", "    async verifyAudit(options) {");
  s = s.replace('    reset(actor = "demo-operator") {', '    async reset(actor = "demo-operator") {');
  const header = `// Browser-compatible gateway service. Generated from server/service.js by
// scripts/sync-demo-service.mjs. Do not edit by hand: change the server copy and
// run the script. The only differences are \`await\` on store calls (Web Crypto
// hashing is async) and crypto.randomUUID() in place of the node:crypto import.
// tests/parity.test.js fails if this file is stale.

`;
  return header + s;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = generateDemoService(readFileSync(resolve(root, "server/service.js"), "utf8"));
  writeFileSync(resolve(root, "src/demo/service.js"), out);
  console.log("src/demo/service.js regenerated");
}
