// Browser-only in-memory store — replaces server/store.js (SQLite + node:crypto).
// Uses Web Crypto SHA-256 for the audit chain and crypto.randomUUID() for IDs.
// All state is in browser memory; persisted to localStorage for synthetic demo continuity.
// Reset clears both memory and localStorage.

const LS_KEY = "mcp_gateway_demo_v1";

// ─── Canonical JSON (identical to server/store.js) ───────────────────────────

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

// ─── Web Crypto SHA-256 (async) ───────────────────────────────────────────────

export async function hashEvent(event) {
  const json = canonicalJson(event);
  const data = new TextEncoder().encode(json);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Persistence helpers ──────────────────────────────────────────────────────

function persist(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (private browsing, quota exceeded) — ignore.
  }
}

function hydrate() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Store factory ────────────────────────────────────────────────────────────

export function createStore() {
  // Load persisted state if available; otherwise start fresh.
  const saved = hydrate();
  let requests = new Map(saved?.requests ?? []);
  let decisions = new Map(saved?.decisions ?? []);  // id → decision
  let decisionsByRequest = new Map(saved?.decisionsByRequest ?? []); // requestId → [id, ...]
  let auditEvents = saved?.auditEvents ?? [];
  let nextSequence = saved?.nextSequence ?? 1;

  function save() {
    persist({
      requests: [...requests.entries()],
      decisions: [...decisions.entries()],
      decisionsByRequest: [...decisionsByRequest.entries()],
      auditEvents,
      nextSequence,
    });
  }

  async function appendAudit({ requestId = null, eventType, actor, payload = {}, createdAt }) {
    const previousHash =
      auditEvents.length > 0
        ? auditEvents[auditEvents.length - 1].eventHash
        : "GENESIS";

    const eventId = crypto.randomUUID();
    const content = {
      eventId,
      requestId,
      eventType,
      actor,
      payload,
      previousHash,
      createdAt,
    };
    const eventHash = await hashEvent(content);

    const event = {
      sequence: nextSequence++,
      eventId,
      requestId,
      eventType,
      actor,
      payload,
      previousHash,
      eventHash,
      createdAt,
    };
    auditEvents.push(event);
    save();
    return event;
  }

  return {
    // ── Requests ──────────────────────────────────────────────────────────────

    createRequest(request) {
      requests.set(request.id, { ...request, version: 1 });
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
      return r ? { ...r } : null;
    },

    listRequests(limit = 100) {
      const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
      return [...requests.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, safeLimit)
        .map((r) => ({ ...r }));
    },

    updateRequest(id, expectedVersion, changes) {
      const current = requests.get(id);
      if (!current) return { ok: false, reason: "not_found" };
      if (current.version !== expectedVersion) return { ok: false, reason: "version_conflict" };

      const allowed = [
        "status",
        "authorizationExpiresAt",
        "executionId",
        "executedAt",
        "updatedAt",
      ];
      const patch = {};
      for (const key of allowed) {
        if (Object.hasOwn(changes, key)) patch[key] = changes[key];
      }
      const updated = { ...current, ...patch, version: current.version + 1 };
      requests.set(id, updated);
      save();
      return { ok: true, request: { ...updated } };
    },

    // ── Decisions ─────────────────────────────────────────────────────────────

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

      const record = this.createDecision(decision);
      const updated = this.updateRequest(decision.requestId, expectedVersion, changes);
      if (!updated.ok) return updated;

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

    listDecisions(requestId) {
      const ids = decisionsByRequest.get(requestId) ?? [];
      return ids
        .map((id) => decisions.get(id))
        .filter(Boolean)
        .map((d) => ({ ...d }))
        .reverse(); // newest first
    },

    // ── Audit ─────────────────────────────────────────────────────────────────

    appendAudit,

    listAudit(requestId = null, limit = 250) {
      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 250));
      const events = requestId
        ? auditEvents.filter((e) => e.requestId === requestId)
        : [...auditEvents];
      return events.slice().reverse().slice(0, safeLimit).map((e) => ({ ...e }));
    },

    async verifyAuditChain() {
      let previousHash = "GENESIS";
      for (const event of auditEvents) {
        const content = {
          eventId: event.eventId,
          requestId: event.requestId,
          eventType: event.eventType,
          actor: event.actor,
          payload: event.payload,
          previousHash: event.previousHash,
          createdAt: event.createdAt,
        };
        const expectedHash = await hashEvent(content);
        if (event.previousHash !== previousHash || event.eventHash !== expectedHash) {
          return {
            valid: false,
            checkedEvents: auditEvents.length,
            failedSequence: event.sequence,
          };
        }
        previousHash = event.eventHash;
      }
      return {
        valid: true,
        checkedEvents: auditEvents.length,
        headHash: previousHash,
      };
    },

    clear() {
      requests = new Map();
      decisions = new Map();
      decisionsByRequest = new Map();
      auditEvents = [];
      nextSequence = 1;
      try {
        localStorage.removeItem(LS_KEY);
      } catch {
        // ignore
      }
    },

    async resetWithAudit(auditEvent) {
      this.clear();
      const audit = await appendAudit(auditEvent);
      return audit;
    },

    close() {
      // No-op in browser (no database connection to close).
    },
  };
}
