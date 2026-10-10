// A request whose status was changed to "approved" straight in the database,
// with no stored human decision behind it, must not execute.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createFakeDownstream } from "../server/downstream.js";
import { serverHarness } from "./helpers/harness.js";

test("server: status flipped to approved in the database does not execute", async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), "humangate-forged-")), "g.db");
  const downstream = createFakeDownstream();
  const h = serverHarness({ path, downstream });
  t.after(() => h.close());
  const { request } = await h.service.submit({ scenarioId: "production-deployment" });
  const db = new DatabaseSync(path);
  const exp = new Date(h.time.clock().getTime() + 600000).toISOString();
  db.prepare("UPDATE requests SET status='approved', authorization_expires_at=? WHERE id=?").run(exp, request.id);
  db.close();
  const result = await h.service.execute(request.id, { requestHash: request.requestHash, actorId: request.actorId, idempotencyKey: "forged-key-0001" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "integrity_failed");
  assert.equal(downstream.calls?.length ?? downstream.count?.() ?? 0, 0);
});
