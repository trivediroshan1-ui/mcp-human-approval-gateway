import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Stable serialization: object keys sorted, no whitespace, and properties whose
// value is undefined are left out, exactly as JSON.stringify would. That keeps
// the hash the same after a round trip through the database.
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function hashEvent(event) {
  return createHash("sha256").update(canonicalJson(event)).digest("hex");
}

function signHash(key, eventHash) {
  return createHmac("sha256", key).update(eventHash).digest("hex");
}

function signaturesMatch(expected, actual) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function mapRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    actorId: row.actor_id,
    actorType: row.actor_type,
    toolId: row.tool_id,
    action: row.action,
    resource: row.resource,
    environment: row.environment,
    dataClassification: row.data_classification,
    justification: row.justification,
    context: row.context,
    requestedScopes: parseJson(row.requested_scopes, []),
    existingScopes: parseJson(row.existing_scopes, []),
    parentRequestId: row.parent_request_id,
    riskScore: row.risk_score,
    riskLevel: row.risk_level,
    status: row.status,
    policyDecision: row.policy_decision,
    policyReasons: parseJson(row.policy_reasons, []),
    policyControls: parseJson(row.policy_controls, []),
    approvalRole: row.approval_role,
    authorizationExpiresAt: row.authorization_expires_at,
    aiAnalysis: parseJson(row.ai_analysis, null),
    arguments: parseJson(row.arguments, {}),
    requestHash: row.request_hash,
    executionId: row.execution_id,
    executedAt: row.executed_at,
    version: row.version,
  };
}

function mapDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    reviewerId: row.reviewer_id,
    reviewerRole: row.reviewer_role,
    decision: row.decision,
    reason: row.reason,
    createdAt: row.created_at,
    authorizationExpiresAt: row.authorization_expires_at,
    requestHash: row.request_hash,
  };
}

function mapAudit(row) {
  if (!row) return null;
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    requestId: row.request_id,
    eventType: row.event_type,
    actor: row.actor,
    payload: parseJson(row.payload, {}),
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    signature: row.signature ?? null,
    createdAt: row.created_at,
  };
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// auditKey is optional. With it, every audit event also carries an HMAC of its
// hash, and verification refuses events that were not signed with the key. A
// database writer who does not hold the key can no longer recompute the chain.
export function createStore(databasePath = ":memory:", { auditKey = null } = {}) {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      environment TEXT NOT NULL,
      data_classification TEXT NOT NULL,
      justification TEXT NOT NULL,
      context TEXT NOT NULL,
      requested_scopes TEXT NOT NULL,
      existing_scopes TEXT NOT NULL,
      parent_request_id TEXT,
      risk_score INTEGER NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      policy_decision TEXT NOT NULL,
      policy_reasons TEXT NOT NULL,
      policy_controls TEXT NOT NULL,
      approval_role TEXT,
      authorization_expires_at TEXT,
      ai_analysis TEXT NOT NULL,
      execution_id TEXT,
      executed_at TEXT,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      reviewer_role TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      authorization_expires_at TEXT,
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      request_id TEXT,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Databases created before these columns existed are upgraded in place.
  ensureColumn(db, "requests", "arguments", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "requests", "request_hash", "TEXT");
  ensureColumn(db, "decisions", "request_hash", "TEXT");
  ensureColumn(db, "audit_events", "signature", "TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_decisions_request ON decisions(request_id);",
  );

  const insertRequest = db.prepare(`
    INSERT INTO requests (
      id, created_at, updated_at, actor_id, actor_type, tool_id, action, resource,
      environment, data_classification, justification, context, requested_scopes,
      existing_scopes, parent_request_id, risk_score, risk_level, status,
      policy_decision, policy_reasons, policy_controls, approval_role,
      authorization_expires_at, ai_analysis, arguments, request_hash, version
    ) VALUES (
      @id, @createdAt, @updatedAt, @actorId, @actorType, @toolId, @action, @resource,
      @environment, @dataClassification, @justification, @context, @requestedScopes,
      @existingScopes, @parentRequestId, @riskScore, @riskLevel, @status,
      @policyDecision, @policyReasons, @policyControls, @approvalRole,
      @authorizationExpiresAt, @aiAnalysis, @arguments, @requestHash, 1
    )
  `);

  function appendAudit({ requestId = null, eventType, actor, payload = {}, createdAt }) {
    const last = db
      .prepare("SELECT sequence, event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1")
      .get();
    const previousHash = last?.event_hash ?? "GENESIS";
    const sequence = (last?.sequence ?? 0) + 1;
    const eventId = randomUUID();
    // Round trip through JSON so the hashed payload is exactly what gets stored.
    const storedPayload = JSON.parse(JSON.stringify(payload));
    const content = {
      sequence,
      eventId,
      requestId,
      eventType,
      actor,
      payload: storedPayload,
      previousHash,
      createdAt,
    };
    const eventHash = hashEvent(content);
    const signature = auditKey ? signHash(auditKey, eventHash) : null;
    db.prepare(`
      INSERT INTO audit_events (
        sequence, event_id, request_id, event_type, actor, payload, previous_hash,
        event_hash, signature, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sequence,
      eventId,
      requestId,
      eventType,
      actor,
      canonicalJson(storedPayload),
      previousHash,
      eventHash,
      signature,
      createdAt,
    );
    return mapAudit(
      db.prepare("SELECT * FROM audit_events WHERE event_id = ?").get(eventId),
    );
  }

  return {
    db,
    createRequest(request) {
      // Bind only the columns this statement declares. `request` may carry
      // extra advisory-only fields (e.g. skipAnalysis) that aren't persisted
      // columns - node:sqlite's named-parameter binding rejects unknown keys,
      // so we whitelist explicitly rather than spreading the whole object.
      insertRequest.run({
        id: request.id,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        actorId: request.actorId,
        actorType: request.actorType,
        toolId: request.toolId,
        action: request.action,
        resource: request.resource,
        environment: request.environment,
        dataClassification: request.dataClassification,
        justification: request.justification,
        context: request.context,
        requestedScopes: canonicalJson(request.requestedScopes),
        existingScopes: canonicalJson(request.existingScopes),
        parentRequestId: request.parentRequestId ?? null,
        riskScore: request.riskScore,
        riskLevel: request.riskLevel,
        status: request.status,
        policyDecision: request.policyDecision,
        policyReasons: canonicalJson(request.policyReasons),
        policyControls: canonicalJson(request.policyControls),
        approvalRole: request.approvalRole,
        authorizationExpiresAt: request.authorizationExpiresAt,
        aiAnalysis: canonicalJson(request.aiAnalysis),
        arguments: canonicalJson(request.arguments ?? {}),
        requestHash: request.requestHash ?? null,
      });
      return this.getRequest(request.id);
    },
    createRequestWithAudit(request, auditEvents) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const record = this.createRequest(request);
        const events = auditEvents.map((event) =>
          appendAudit({ ...event, requestId: request.id }),
        );
        db.exec("COMMIT;");
        return { request: record, events };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Preserve the original transaction error.
        }
        throw error;
      }
    },
    getRequest(id) {
      return mapRequest(db.prepare("SELECT * FROM requests WHERE id = ?").get(id));
    },
    listRequests(limit = 100) {
      const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
      return db
        .prepare("SELECT * FROM requests ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(safeLimit)
        .map(mapRequest);
    },
    updateRequest(id, expectedVersion, changes) {
      const current = this.getRequest(id);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.version !== expectedVersion) return { ok: false, reason: "version_conflict" };
      const allowed = {
        status: "status",
        authorizationExpiresAt: "authorization_expires_at",
        executionId: "execution_id",
        executedAt: "executed_at",
      };
      const assignments = [];
      const values = [];
      for (const [key, column] of Object.entries(allowed)) {
        if (Object.hasOwn(changes, key)) {
          assignments.push(`${column} = ?`);
          values.push(changes[key]);
        }
      }
      if (assignments.length === 0) return { ok: true, request: current };
      assignments.push("updated_at = ?", "version = version + 1");
      values.push(changes.updatedAt, id, expectedVersion);
      const result = db
        .prepare(
          `UPDATE requests SET ${assignments.join(", ")} WHERE id = ? AND version = ?`,
        )
        .run(...values);
      if (result.changes !== 1) return { ok: false, reason: "version_conflict" };
      return { ok: true, request: this.getRequest(id) };
    },
    createDecision(decision) {
      db.prepare(`
        INSERT INTO decisions (
          id, request_id, reviewer_id, reviewer_role, decision, reason,
          created_at, authorization_expires_at, request_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        decision.id,
        decision.requestId,
        decision.reviewerId,
        decision.reviewerRole,
        decision.decision,
        decision.reason,
        decision.createdAt,
        decision.authorizationExpiresAt,
        decision.requestHash ?? null,
      );
      return mapDecision(db.prepare("SELECT * FROM decisions WHERE id = ?").get(decision.id));
    },
    recordDecisionAndTransition(decision, expectedVersion, changes, auditEvent = null) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const current = this.getRequest(decision.requestId);
        if (!current) {
          db.exec("ROLLBACK;");
          return { ok: false, reason: "not_found" };
        }
        if (current.version !== expectedVersion) {
          db.exec("ROLLBACK;");
          return { ok: false, reason: "version_conflict" };
        }

        const record = this.createDecision(decision);
        const updated = this.updateRequest(decision.requestId, expectedVersion, changes);
        if (!updated.ok) {
          db.exec("ROLLBACK;");
          return updated;
        }
        const audit = auditEvent
          ? appendAudit({ ...auditEvent, requestId: decision.requestId })
          : null;
        db.exec("COMMIT;");
        return { ok: true, decision: record, request: updated.request, audit };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Preserve the original transaction error.
        }
        throw error;
      }
    },
    // Append one audit event in its own transaction (for events that are not
    // part of a state change, such as a blocked execution attempt).
    recordAudit(auditEvent) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const audit = appendAudit(auditEvent);
        db.exec("COMMIT;");
        return audit;
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Preserve the original transaction error.
        }
        throw error;
      }
    },
    transitionWithAudit(id, expectedVersion, changes, auditEvent) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const updated = this.updateRequest(id, expectedVersion, changes);
        if (!updated.ok) {
          db.exec("ROLLBACK;");
          return updated;
        }
        const audit = appendAudit({ ...auditEvent, requestId: id });
        db.exec("COMMIT;");
        return { ok: true, request: updated.request, audit };
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Preserve the original transaction error.
        }
        throw error;
      }
    },
    latestDecision(requestId) {
      return mapDecision(
        db
          .prepare(
            "SELECT * FROM decisions WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
          )
          .get(requestId),
      );
    },
    listDecisions(requestId) {
      return db
        .prepare("SELECT * FROM decisions WHERE request_id = ? ORDER BY created_at DESC, rowid DESC")
        .all(requestId)
        .map(mapDecision);
    },
    appendAudit,
    listAudit(requestId = null, limit = 250) {
      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 250));
      const rows = requestId
        ? db
            .prepare(
              "SELECT * FROM audit_events WHERE request_id = ? ORDER BY sequence DESC LIMIT ?",
            )
            .all(requestId, safeLimit)
        : db
            .prepare("SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ?")
            .all(safeLimit);
      return rows.map(mapAudit);
    },
    // Checks, in order, for every event: the sequence number follows the one
    // before it, the previous-hash link matches, the recomputed hash matches and,
    // when a key is configured, the HMAC matches. An anchor (a sequence number
    // and head hash saved somewhere else) additionally detects truncation.
    verifyAuditChain({ anchor = null } = {}) {
      const rows = db.prepare("SELECT * FROM audit_events ORDER BY sequence ASC").all();
      let previousHash = "GENESIS";
      let previousSequence = null;
      const fail = (row, reason) => ({
        valid: false,
        checkedEvents: rows.length,
        failedSequence: row.sequence,
        reason,
        signed: Boolean(auditKey),
      });
      for (const row of rows) {
        if (previousSequence !== null && row.sequence !== previousSequence + 1) {
          return fail(row, "sequence_gap");
        }
        const content = {
          sequence: row.sequence,
          eventId: row.event_id,
          requestId: row.request_id,
          eventType: row.event_type,
          actor: row.actor,
          payload: parseJson(row.payload, {}),
          previousHash: row.previous_hash,
          createdAt: row.created_at,
        };
        if (row.previous_hash !== previousHash) return fail(row, "link_broken");
        if (row.event_hash !== hashEvent(content)) return fail(row, "hash_mismatch");
        if (auditKey && !signaturesMatch(signHash(auditKey, row.event_hash), row.signature)) {
          return fail(row, "signature_invalid");
        }
        previousHash = row.event_hash;
        previousSequence = row.sequence;
      }
      if (anchor) {
        const anchored = rows.find((row) => row.sequence === Number(anchor.sequence));
        if (!anchored || anchored.event_hash !== anchor.hash) {
          return {
            valid: false,
            checkedEvents: rows.length,
            failedSequence: Number(anchor.sequence),
            reason: "anchor_mismatch",
            signed: Boolean(auditKey),
          };
        }
      }
      return {
        valid: true,
        checkedEvents: rows.length,
        headSequence: previousSequence,
        headHash: previousHash,
        signed: Boolean(auditKey),
        anchorChecked: Boolean(anchor),
      };
    },
    clear() {
      db.exec("DELETE FROM decisions; DELETE FROM requests; DELETE FROM audit_events;");
    },
    resetWithAudit(auditEvent) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        this.clear();
        const audit = appendAudit(auditEvent);
        db.exec("COMMIT;");
        return audit;
      } catch (error) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // Preserve the original transaction error.
        }
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}

export { canonicalJson, hashEvent, signHash };
