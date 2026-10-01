// Browser-only in-memory store. It stands in for server/store.js (SQLite and
// node:crypto). Hashing uses Web Crypto SHA-256 and ids use crypto.randomUUID(),
// both of which need a secure context (https or localhost).
//
// State lives in memory and is mirrored to localStorage so a visitor keeps their
// synthetic session between page loads. Reset clears both. This store has no
// signing key: anyone who can edit localStorage can edit the chain, and the
// verifier will say so when they do not also recompute every hash.

const LS_KEY = "mcp_gateway_demo_v2";

// Stable serialization, same rules as server/store.js: sorted keys, no
// whitespace, undefined properties left out.
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export async function hashEvent(event) {
  const data = new TextEncoder().encode(canonicalJson(event));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function persist(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode, quota). The demo still works.
  }
}

function hydrate() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const pairs = (value) => Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2);
    if (
      !saved ||
      !pairs(saved.requests) ||
      !pairs(saved.decisions) ||
      !pairs(saved.decisionsByRequest) ||
      !Array.isArray(saved.auditEvents) ||
      !Number.isInteger(saved.nextSequence)
    ) {
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}

export function createStore() {
  const saved = hydrate();
  let requests = new Map(saved?.requests ?? []);
  let decisions = new Map(saved?.decisions ?? []);
  let decisionsByRequest = new Map(saved?.decisionsByRequest ?? []);
  let auditEvents = saved?.auditEvents ?? [];
  let nextSequence = saved?.nextSequence ?? 1;
  let insertionCounter = requests.size;
  const insertionOrder = new Map([...requests.keys()].map((id, index) => [id, index]));

  function save() {
    persist({
      requests: [...requests.entries()],
      decisions: [...decisions.entries()],
      decisionsByRequest: [...decisionsByRequest.entries()],
      auditEvents,
      nextSequence,
    });
  }

  // Hashing is asynchronous, so two appends could both read the same previous
  // hash and fork the chain. Every append waits for the one before it.
  let appendQueue = Promise.resolve();

  function appendAudit(input) {
    const run = appendQueue.then(() => appendAuditNow(input));
    appendQueue = run.catch(() => {});
    return run;
  }

  async function appendAuditNow({ requestId = null, eventType, actor, payload = {}, createdAt }) {
    const last = auditEvents[auditEvents.length - 1];
    const previousHash = last ? last.eventHash : "GENESIS";
    const sequence = last ? last.sequence + 1 : 1;
    const eventId = crypto.randomUUID();
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
    const eventHash = await hashEvent(content);
    const event = {
      sequence,
      eventId,
      requestId,
      eventType,
      actor,
      payload: storedPayload,
      previousHash,
      eventHash,
      signature: null,
      createdAt,
    };
    auditEvents.push(event);
    nextSequence = sequence + 1;
    save();
    return { ...event };
  }

  return {
    createRequest(request) {
      requests.set(request.id, { ...request, version: 1 });
      insertionOrder.set(request.id, insertionCounter++);
      save();
      return this.getRequest(request.id);
    },

    async createRequestWithAudit(request, auditEventInputs) {
      const record = this.createRequest(request);
      const events = [];
      for (const evt of auditEventInputs) {
        events.push(await appendAudit({ ...evt, requestId: request.id }));
      }
      return { request: record, events };
    },

    getRequest(id) {
      const r = requests.get(id);
      return r ? structuredClone(r) : null;
    },

    findByExecutionId(executionId) {
      if (typeof executionId !== "string" || !executionId) return null;
      for (const request of requests.values()) {
        if (request.executionId === executionId) return structuredClone(request);
      }
      return null;
    },

    listRequests(limit = 100) {
      const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
      return [...requests.values()]
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) ||
            (insertionOrder.get(b.id) ?? 0) - (insertionOrder.get(a.id) ?? 0),
        )
        .slice(0, safeLimit)
        .map((r) => structuredClone(r));
    },

    updateRequest(id, expectedVersion, changes) {
      const current = requests.get(id);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.version !== expectedVersion) return { ok: false, reason: "version_conflict" };

      const allowed = ["status", "authorizationExpiresAt", "executionId", "executedAt", "execution", "updatedAt"];
      const patch = {};
      for (const key of allowed) {
        if (Object.hasOwn(changes, key)) patch[key] = changes[key];
      }
      const updated = { ...current, ...patch, version: current.version + 1 };
      requests.set(id, updated);
      save();
      return { ok: true, request: structuredClone(updated) };
    },

    createDecision(decision) {
      decisions.set(decision.id, { ...decision });
      const list = decisionsByRequest.get(decision.requestId) ?? [];
      list.push(decision.id);
      decisionsByRequest.set(decision.requestId, list);
      save();
      return { ...decision };
    },

    async recordDecisionAndTransition(decision, expectedVersion, changes, auditEvent = null) {
      const current = requests.get(decision.requestId);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.version !== expectedVersion) return { ok: false, reason: "version_conflict" };

      // Check and transition first (synchronously), then write the decision, so
      // a lost race never leaves an orphan decision behind.
      const updated = this.updateRequest(decision.requestId, expectedVersion, changes);
      if (!updated.ok) return updated;
      const record = this.createDecision(decision);

      const audit = auditEvent
        ? await appendAudit({ ...auditEvent, requestId: decision.requestId })
        : null;

      return { ok: true, decision: record, request: updated.request, audit };
    },

    async transitionWithAudit(id, expectedVersion, changes, auditEvent) {
      const updated = this.updateRequest(id, expectedVersion, changes);
      if (!updated.ok) return updated;

      const audit = await appendAudit({ ...auditEvent, requestId: id });
      return { ok: true, request: updated.request, audit };
    },

    async recordAudit(auditEvent) {
      return appendAudit(auditEvent);
    },

    latestDecision(requestId) {
      return this.listDecisions(requestId)[0] ?? null;
    },

    listDecisions(requestId) {
      const ids = decisionsByRequest.get(requestId) ?? [];
      return ids
        .map((id) => decisions.get(id))
        .filter(Boolean)
        .map((d) => ({ ...d }))
        .reverse();
    },

    appendAudit,

    listAudit(requestId = null, limit = 250) {
      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 250));
      const events = requestId
        ? auditEvents.filter((e) => e.requestId === requestId)
        : [...auditEvents];
      return events.slice().reverse().slice(0, safeLimit).map((e) => structuredClone(e));
    },

    // Same checks and result shape as server/store.js, minus signatures.
    async verifyAuditChain({ anchor = null } = {}) {
      let previousHash = "GENESIS";
      let previousSequence = null;
      const fail = (event, reason) => ({
        valid: false,
        checkedEvents: auditEvents.length,
        failedSequence: event.sequence,
        reason,
        signed: false,
      });
      for (const event of auditEvents) {
        if (previousSequence !== null && event.sequence !== previousSequence + 1) {
          return fail(event, "sequence_gap");
        }
        const content = {
          sequence: event.sequence,
          eventId: event.eventId,
          requestId: event.requestId,
          eventType: event.eventType,
          actor: event.actor,
          payload: event.payload,
          previousHash: event.previousHash,
          createdAt: event.createdAt,
        };
        if (event.previousHash !== previousHash) return fail(event, "link_broken");
        if (event.eventHash !== (await hashEvent(content))) return fail(event, "hash_mismatch");
        previousHash = event.eventHash;
        previousSequence = event.sequence;
      }
      if (anchor) {
        const anchored = auditEvents.find((event) => event.sequence === Number(anchor.sequence));
        if (!anchored || anchored.eventHash !== anchor.hash) {
          return {
            valid: false,
            checkedEvents: auditEvents.length,
            failedSequence: Number(anchor.sequence),
            reason: "anchor_mismatch",
            signed: false,
          };
        }
      }
      return {
        valid: true,
        checkedEvents: auditEvents.length,
        headSequence: previousSequence,
        headHash: previousHash,
        signed: false,
        anchorChecked: Boolean(anchor),
      };
    },

    // Lab-only. Edits a stored audit event without recomputing any hash, which
    // is what an attacker with write access but no recomputation would do.
    tamperAuditEvent(sequence, patch = { tampered: true }) {
      const event = auditEvents.find((entry) => entry.sequence === Number(sequence));
      if (!event) return false;
      event.payload = { ...event.payload, ...patch };
      save();
      return true;
    },

    clear() {
      requests = new Map();
      decisions = new Map();
      decisionsByRequest = new Map();
      auditEvents = [];
      nextSequence = 1;
      insertionCounter = 0;
      insertionOrder.clear();
      try {
        localStorage.removeItem(LS_KEY);
      } catch {
        // ignore
      }
    },

    async resetWithAudit(auditEvent) {
      this.clear();
      return appendAudit(auditEvent);
    },

    close() {},
  };
}
