#!/usr/bin/env node
// Approval-binding conformance checks that do not depend on one gateway.
//
//   node scripts/run-conformance.mjs [--root <gateway folder>] [--label <name>]
//
// The checks only use five adapter functions (see scripts/conformance/adapter-humangate.mjs).
// Each check asks: after a person approved ONE exact request, does anything else run?
// Pass = nothing but the exact approved request executes, and only once.
// Synthetic data. Output: conformance-<label>.md and .json in the current folder.
// It checks approval binding only. It says nothing about the rest of a gateway.

import { writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeAdapter } from "./conformance/adapter-humangate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const root = resolve(arg("--root", join(here, "..")));
const label = arg("--label", "gateway");

const TOOL = "deploy.production";
const BASE = { action: "deploy", resource: "service://payment-api", environment: "production", requestedScopes: ["deploy:production"], dataClassification: "confidential", existingScopes: [], justification: "Conformance run", arguments: { release: "v1" } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const edit = (fn) => { const o = clone(BASE); fn(o); return o; };

// [id, title, build the changed request or null]
const CHANGES = [
  ["B03", "Different resource", edit((o) => { o.resource = "service://billing-api"; })],
  ["B04", "Different environment", edit((o) => { o.environment = "staging"; })],
  ["B05", "Different scope list", edit((o) => { o.requestedScopes = []; })],
  ["B06", "Different justification text", edit((o) => { o.justification = "Something else entirely"; })],
  ["B07", "Different argument value", edit((o) => { o.arguments.release = "v2"; })],
  ["B08", "Extra argument added", edit((o) => { o.arguments.extra = "x"; })],
  ["B09", "Argument removed", edit((o) => { delete o.arguments.release; })],
  ["B10", "Different data classification", edit((o) => { o.dataClassification = "public"; })],
];

const rows = [];
const add = (id, title, pass, seen) => { rows.push({ id, title, result: pass ? "pass" : "FAIL", seen }); console.log(id.padEnd(5), pass ? "pass" : "FAIL", title); };

async function fresh(a) { await a.start(); }
const a = makeAdapter(root);

try {
  await a.start();
  const asked = await a.ask(TOOL, BASE);
  add("B01", "Nothing runs before a person decides", asked.outcome !== "executed", asked.outcome);
  await a.decide(asked.id, "approve");
  const ok = await a.run(TOOL, BASE, asked.id);
  add("B02", "The exact approved request runs", ok.outcome === "executed", ok.outcome);
  const again = await a.run(TOOL, BASE, asked.id);
  add("B02b", "The same approval cannot run twice", again.outcome !== "executed", again.outcome);

  for (const [id, title, changed] of CHANGES) {
    const r = await a.ask(TOOL, BASE); await a.decide(r.id, "approve");
    const out = await a.run(TOOL, changed, r.id);
    add(id, `${title} after approval`, out.outcome !== "executed", out.outcome);
  }

  const d = await a.ask(TOOL, edit((o) => { o.justification = "Conformance deny"; })); await a.decide(d.id, "deny");
  const denied = await a.run(TOOL, edit((o) => { o.justification = "Conformance deny"; }), d.id);
  add("B11", "A denied request does not run", denied.outcome !== "executed", denied.outcome);

  const p = await a.ask(TOOL, edit((o) => { o.justification = "Conformance pending"; }));
  const pend = await a.run(TOOL, edit((o) => { o.justification = "Conformance pending"; }), p.id);
  add("B12", "A request nobody decided does not run", pend.outcome !== "executed", pend.outcome);

  const unk = await a.run(TOOL, BASE, "00000000-0000-4000-8000-000000000000");
  add("B13", "An approval id that never existed does not run", unk.outcome !== "executed", unk.outcome);

  const x = await a.ask(TOOL, edit((o) => { o.justification = "Conformance cross tool"; })); await a.decide(x.id, "approve");
  const cross = await a.run("storage.delete", { action: "delete", resource: "storage://reports", environment: "production", requestedScopes: ["storage:delete"], dataClassification: "confidential", existingScopes: [], justification: "Conformance cross tool", arguments: {} }, x.id);
  add("B14", "An approval for one tool does not run another tool", cross.outcome !== "executed", cross.outcome);
} finally { await a.stop(); }

const fails = rows.filter((r) => r.result === "FAIL").length;
const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
let md = `# Approval-binding conformance: ${label} (${new Date().toISOString()})\n\nAdapter: ${a.name}. Synthetic data, one run. Checks approval binding only. A script run, not hand-run evidence.\n\n**${rows.length - fails} of ${rows.length} pass.**\n\n| ID | Check | Result | What came back |\n|---|---|---|---|\n`;
for (const r of rows) md += `| ${r.id} | ${esc(r.title)} | ${r.result} | ${esc(r.seen)} |\n`;
writeFileSync(`conformance-${label}.md`, md); writeFileSync(`conformance-${label}.json`, JSON.stringify(rows, null, 2));
console.log(`Wrote conformance-${label}.md (${rows.length - fails}/${rows.length} pass)`);
