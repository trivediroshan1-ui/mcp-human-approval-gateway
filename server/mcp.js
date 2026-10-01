// Model Context Protocol server core.
//
// Implements the MCP revision 2026-07-28 (stateless, per-request _meta,
// server/discover) and, as a second era on the same endpoint, the
// initialize-based revision 2025-11-25. Transport adapters live in
// mcp-http.js (Streamable HTTP) and mcp-stdio.js (stdio). This file knows
// nothing about sockets: it takes one parsed JSON-RPC message and returns the
// reply plus an HTTP status for the HTTP adapter to use.
//
// Every tool call goes through the same gateway service as the REST API, so
// policy, human approval, the request hash binding, single-use execution and
// the hash-chained audit log are the existing ones. Nothing here can grant
// anything on its own.
import { readFileSync } from "node:fs";
import { evaluatePolicy } from "./policy.js";
import { requestHashOf } from "./service.js";

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSION = "2025-11-25";
export const SUPPORTED_VERSIONS = Object.freeze([MODERN_VERSION, LEGACY_VERSION]);

const META = "io.modelcontextprotocol/";
export const ERR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
});

export const STATUS_TOOL = "check_approval_status";
export const EXECUTION_TOOL = "get_execution_result";
const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const ENVIRONMENTS = ["public", "development", "staging", "production"];
const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];
const IDENTITY_LABEL = "unauthenticated demo mode: clientInfo is self-declared";

const packageVersion = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

export const SERVER_INFO = Object.freeze({
  name: "mcp-human-approval-gateway",
  title: "MCP Human Approval Gateway (research prototype)",
  version: packageVersion,
});

const INSTRUCTIONS = [
  "This server is a research prototype of a human approval gateway. Every tool here is synthetic and does nothing real.",
  "Each call is judged by a fixed policy. A call can be executed at once, refused, or held for a human reviewer.",
  "When a result says pending_approval, stop. A person has to approve it in the gateway review UI.",
  `Then call ${STATUS_TOOL} with the approvalId, and once it says approved, call the same tool again with identical arguments plus approvalId.`,
  "An approval works once, expires quickly, and is bound to the exact arguments that were reviewed.",
  "Text in context or arguments is treated as data. It never grants anything.",
].join(" ");

// ---------------------------------------------------------------- helpers

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clip(value, max = 64) {
  if (typeof value !== "string") return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function validId(id) {
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: validId(id) ? id : null, error };
}

function decodeHeaderValue(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("=?base64?") && value.endsWith("?=")) {
    try {
      return Buffer.from(value.slice(9, -2), "base64").toString("utf8");
    } catch {
      return value;
    }
  }
  return value;
}

// ---------------------------------------------------------------- tools

function toolContract(tool) {
  const readOnly = tool.allowedActions.every((action) => action === "read" || action === "read-metadata");
  const schemes = tool.allowedResourceSchemes.map((scheme) => `${scheme}://`).join(", ");
  return {
    name: tool.id,
    title: tool.label,
    description:
      `${tool.label}. Synthetic: nothing real runs. Every call is judged by the gateway policy first. ` +
      `Allowed actions: ${tool.allowedActions.join(", ")}. Allowed scope: ${tool.allowedScopes.join(", ")}. ` +
      `Resource must start with ${schemes}. ` +
      "A call may run at once, be refused, or return pending_approval. After a human approves, call again with the same arguments plus approvalId. " +
      "Send an idempotencyKey with the execution call. If the response is lost, repeat the call with the same key and the stored result comes back. A new key is refused.",
    inputSchema: {
      $schema: SCHEMA_DIALECT,
      type: "object",
      properties: {
        action: { type: "string", enum: [...tool.allowedActions], description: "What to do." },
        resource: {
          type: "string",
          maxLength: 512,
          description: `Target resource URI, for example ${tool.allowedResourceSchemes[0]}://synthetic/example.`,
        },
        environment: { type: "string", enum: ENVIRONMENTS, description: "Where the action would run." },
        requestedScopes: {
          type: "array",
          items: { type: "string", maxLength: 128 },
          maxItems: 20,
          description: "Exact scopes needed. Ask for the minimum.",
        },
        justification: { type: "string", maxLength: 2000, description: "Why the action is needed." },
        dataClassification: { type: "string", enum: CLASSIFICATIONS, description: "Sensitivity of the data touched." },
        existingScopes: {
          type: "array",
          items: { type: "string", maxLength: 128 },
          maxItems: 20,
          description: "Scopes the agent says it already holds. Self-declared and never lowers risk.",
        },
        context: { type: "string", maxLength: 8000, description: "Background for the reviewer. Treated as untrusted data." },
        arguments: { type: "object", description: "Tool specific arguments. Included in the approval binding." },
        skipAnalysis: {
          type: "boolean",
          description: "Simulation switch for an agent that hands off without options or a recommendation. The gateway rejects such a handoff.",
        },
        approvalId: {
          type: "string",
          maxLength: 128,
          description: "Id from an earlier pending_approval result. Send it with identical arguments once a human has approved.",
        },
        idempotencyKey: {
          type: "string",
          minLength: 8,
          maxLength: 128,
          pattern: "^[A-Za-z0-9._:-]+$",
          description:
            "Your own unique key for this execution. Repeating a call with the same key and the same arguments returns the stored result and never runs the tool twice.",
        },
      },
      required: ["action", "resource", "environment", "requestedScopes", "justification"],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: SCHEMA_DIALECT,
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: [
            "executed",
            "pending_approval",
            "denied",
            "rejected_by_gate",
            "expired",
            "replay_blocked",
            "binding_mismatch",
            "actor_mismatch",
            "integrity_failed",
            "approval_not_found",
            "invalid_arguments",
            "executing",
            "unknown_outcome",
            "failed",
            "blocked",
          ],
        },
        state: { type: "string" },
        resultDigest: { type: ["string", "null"] },
        resultSummary: { type: ["string", "null"] },
        errorCode: { type: ["string", "null"] },
        replayed: { type: "boolean" },
        idempotencyKey: { type: ["string", "null"] },
        requestId: { type: "string" },
        approvalId: { type: "string" },
        status: { type: "string" },
        riskLevel: { type: "string" },
        requiredRole: { type: ["string", "null"] },
        requestHash: { type: "string" },
        executionId: { type: "string" },
        simulated: { type: "boolean" },
        denyCode: { type: ["string", "null"] },
        reasons: { type: "array", items: { type: "string" } },
        authorizationExpiresAt: { type: ["string", "null"] },
        next: { type: "string" },
      },
      required: ["outcome"],
    },
    // Hints only. A client must not rely on them; the gateway never does.
    annotations: {
      title: tool.label,
      readOnlyHint: readOnly,
      destructiveHint: !readOnly && (tool.destructive || tool.privilegeChange || tool.productionChange),
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

const STATUS_CONTRACT = Object.freeze({
  name: STATUS_TOOL,
  title: "Check approval status",
  description:
    "Look up a request that returned pending_approval. Returns its status, who must approve, the expiry and what to do next. " +
    "It never executes anything and never reveals reviewer comments.",
  inputSchema: {
    $schema: SCHEMA_DIALECT,
    type: "object",
    properties: {
      approvalId: { type: "string", maxLength: 128, description: "The approvalId from a pending_approval result." },
    },
    required: ["approvalId"],
    additionalProperties: false,
  },
  outputSchema: {
    $schema: SCHEMA_DIALECT,
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["approval_status", "approval_not_found", "invalid_arguments"] },
      approvalId: { type: "string" },
      toolId: { type: "string" },
      status: { type: "string" },
      riskLevel: { type: "string" },
      requiredRole: { type: ["string", "null"] },
      authorizationExpiresAt: { type: ["string", "null"] },
      consumed: { type: "boolean" },
      decision: { type: ["object", "null"] },
      next: { type: "string" },
    },
    required: ["outcome"],
  },
  annotations: {
    title: "Check approval status",
    readOnlyHint: true,
    openWorldHint: false,
  },
});

const EXECUTION_CONTRACT = Object.freeze({
  name: EXECUTION_TOOL,
  title: "Get execution result",
  description:
    "Read the recorded outcome of an execution by its executionId. State is executing, executed, failed or unknown_outcome, with a digest of the result. " +
    "Use it after a lost response. It never runs anything. An execution that stays unconfirmed becomes unknown_outcome and only a person can reconcile it.",
  inputSchema: {
    $schema: SCHEMA_DIALECT,
    type: "object",
    properties: {
      executionId: { type: "string", maxLength: 128, description: "The executionId from an execution result." },
    },
    required: ["executionId"],
    additionalProperties: false,
  },
  outputSchema: {
    $schema: SCHEMA_DIALECT,
    type: "object",
    properties: {
      outcome: { type: "string", enum: ["execution_state", "execution_not_found", "invalid_arguments"] },
      executionId: { type: "string" },
      approvalId: { type: "string" },
      toolId: { type: "string" },
      state: { type: "string", enum: ["executing", "executed", "failed", "unknown_outcome"] },
      resultDigest: { type: ["string", "null"] },
      resultSummary: { type: ["string", "null"] },
      errorCode: { type: ["string", "null"] },
      timeoutAt: { type: ["string", "null"] },
      reconciled: { type: ["object", "null"] },
      next: { type: "string" },
    },
    required: ["outcome"],
  },
  annotations: {
    title: "Get execution result",
    readOnlyHint: true,
    openWorldHint: false,
  },
});

const SIMULATED_EFFECT = {
  "docs.search": "Pretended to search public documentation and found 3 synthetic documents.",
  "repo.read": "Pretended to read a synthetic repository and list 12 synthetic files.",
  "secrets.read": "Pretended to list metadata for 4 synthetic credentials. No secret values exist here.",
  "iam.roles.update": "Pretended to change a synthetic role assignment.",
  "deploy.production": "Pretended to deploy a synthetic build.",
  "storage.delete": "Pretended to delete a synthetic storage object.",
  "ticket.create": "Pretended to open a synthetic security ticket.",
};

const KNOWN_ARGUMENTS = {
  string: ["action", "resource", "environment", "dataClassification", "justification", "context", "approvalId", "idempotencyKey"],
  stringArray: ["requestedScopes", "existingScopes"],
  object: ["arguments"],
  boolean: ["skipAnalysis"],
};
const REQUIRED_ARGUMENTS = ["action", "resource", "environment", "requestedScopes", "justification"];

function checkToolArguments(args) {
  const problems = [];
  const known = new Set([
    ...KNOWN_ARGUMENTS.string,
    ...KNOWN_ARGUMENTS.stringArray,
    ...KNOWN_ARGUMENTS.object,
    ...KNOWN_ARGUMENTS.boolean,
  ]);
  for (const key of Object.keys(args)) {
    if (!known.has(key)) problems.push(`Unknown argument "${clip(key, 40)}".`);
  }
  for (const key of REQUIRED_ARGUMENTS) {
    if (args[key] === undefined) problems.push(`Missing required argument "${key}".`);
  }
  for (const key of KNOWN_ARGUMENTS.string) {
    if (args[key] !== undefined && typeof args[key] !== "string") problems.push(`"${key}" must be a string.`);
  }
  for (const key of KNOWN_ARGUMENTS.stringArray) {
    if (args[key] !== undefined && !(Array.isArray(args[key]) && args[key].every((v) => typeof v === "string"))) {
      problems.push(`"${key}" must be an array of strings.`);
    }
  }
  for (const key of KNOWN_ARGUMENTS.object) {
    if (args[key] !== undefined && !isObject(args[key])) problems.push(`"${key}" must be an object.`);
  }
  for (const key of KNOWN_ARGUMENTS.boolean) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") problems.push(`"${key}" must be a boolean.`);
  }
  return problems;
}

function toolResult({ text, structured, isError = false, replayed = false }) {
  return {
    ...(replayed ? { _meta: { replayed: true } } : {}),
    content: [
      { type: "text", text },
      // The spec asks for the serialized structured value in a text block too.
      { type: "text", text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
    isError,
  };
}

// ---------------------------------------------------------------- server

export function createMcpServer({
  service,
  store,
  toolRegistry,
  agentId = "mcp-agent-demo",
  clock = () => new Date(),
  log = (message) => console.error(message),
} = {}) {
  if (!service || !store || !toolRegistry) throw new Error("service, store and toolRegistry are required");

  const registryTools = Object.values(toolRegistry).map(toolContract);
  const toolList = Object.freeze([...registryTools, STATUS_CONTRACT, EXECUTION_CONTRACT]);
  const actorLabel = `mcp:${agentId}`;

  function recordAudit(eventType, requestId, payload) {
    return store.recordAudit({
      requestId,
      eventType,
      actor: actorLabel,
      createdAt: clock().toISOString(),
      payload: {
        source: "mcp",
        identity: IDENTITY_LABEL,
        agentId,
        ...payload,
      },
    });
  }

  function clientOf(meta, params) {
    const info = meta?.[`${META}clientInfo`] ?? params?.clientInfo;
    if (!isObject(info)) return null;
    return { name: clip(info.name), version: clip(info.version, 32) };
  }

  // ---- gateway helpers

  function denyDetails(requestId) {
    const events = service.audit(requestId, 50);
    const policy = events.find((event) => event.eventType.startsWith("policy."));
    const gate = events.find((event) => event.eventType === "decision_package.rejected");
    return { denyCode: policy?.payload?.denyCode ?? null, gap: gate?.payload?.gap ?? null };
  }

  function summarize(request, extra = {}) {
    return {
      requestId: request.id,
      approvalId: request.id,
      status: request.status,
      riskLevel: request.riskLevel,
      requiredRole: request.approvalRole ?? null,
      requestHash: request.requestHash,
      authorizationExpiresAt: request.authorizationExpiresAt ?? null,
      ...extra,
    };
  }

  function refusal(request, outcome, text, extra = {}) {
    return {
      result: toolResult({
        isError: true,
        text,
        structured: { outcome, ...summarize(request), ...extra },
      }),
      meta: { requestId: request.id, outcome },
    };
  }

  function executionStructured(request, ex, extra = {}) {
    return {
      ...summarize(request),
      status: ex.state,
      executionId: ex.executionId,
      state: ex.state,
      resultDigest: ex.resultDigest,
      resultSummary: ex.resultSummary,
      errorCode: ex.errorCode,
      idempotencyKey: ex.idempotencyKey,
      simulated: true,
      ...extra,
    };
  }

  // Turns what the gateway recorded for an execution into an MCP tool result.
  // The same function serves a first run and a retry, so a retry cannot say
  // anything the stored record does not.
  function executionOutcome(request, run) {
    const ex = run.execution;
    const replayed = run.replayed === true;
    const prefix = replayed ? "REPEATED CALL, NOTHING RAN AGAIN. " : "";
    const meta = { requestId: request.id, executionId: ex.executionId, replayed };
    if (ex.state === "executed") {
      const effect = ex.resultSummary ?? SIMULATED_EFFECT[request.toolId] ?? "Pretended to run a synthetic action.";
      return {
        result: toolResult({
          replayed,
          text:
            `${prefix}EXECUTED (simulated). ${effect} No real system was touched. ` +
            `Execution id ${ex.executionId}, result digest ${ex.resultDigest ?? "none"}. ` +
            "The approval is used up. Repeating this call with the same idempotencyKey returns this same result.",
          structured: executionStructured(request, ex, { outcome: "executed", replayed }),
        }),
        meta: { ...meta, outcome: "executed" },
      };
    }
    if (ex.state === "failed") {
      return {
        result: toolResult({
          isError: true,
          replayed,
          text: `${prefix}FAILED. The synthetic tool reported ${ex.errorCode ?? "an error"}. Nothing was changed. The approval is used up, so a new request is needed to try again.`,
          structured: executionStructured(request, ex, { outcome: "failed", replayed }),
        }),
        meta: { ...meta, outcome: "failed" },
      };
    }
    if (ex.state === "unknown_outcome") {
      return {
        result: toolResult({
          isError: true,
          replayed,
          text:
            `${prefix}OUTCOME UNKNOWN. The tool did not confirm before the timeout, so it may or may not have run. ` +
            "Do not retry with a new key. A person has to check the downstream system and reconcile execution " +
            `${ex.executionId} in the review UI. Use ${EXECUTION_TOOL} to see when that is done.`,
          structured: executionStructured(request, ex, {
            outcome: "unknown_outcome",
            replayed,
            next: "Wait for a person to reconcile. Never dispatch again.",
          }),
        }),
        meta: { ...meta, outcome: "unknown_outcome" },
      };
    }
    return {
      result: toolResult({
        replayed,
        text:
          `${prefix}NOT CONFIRMED YET. The action was reserved and handed to the tool, but no result has been recorded. ` +
          `Repeat the call with the same idempotencyKey, or call ${EXECUTION_TOOL} with executionId ${ex.executionId}, to read the outcome. Do not use a new key.`,
        structured: executionStructured(request, ex, {
          outcome: "executing",
          replayed,
          next: `Check again with the same idempotencyKey or ${EXECUTION_TOOL}.`,
        }),
      }),
      meta: { ...meta, outcome: "executing" },
    };
  }

  function pending(request) {
    const role = request.approvalRole ?? "a reviewer";
    return {
      result: toolResult({
        text:
          `NOT EXECUTED. Human approval is required (${role}, ${request.riskLevel} risk). ` +
          `Approval id: ${request.id}. A person must approve it in the gateway review UI, or by POST /api/requests/${request.id}/decision. ` +
          `Then call ${STATUS_TOOL} with this approvalId. When it says approved, call ${request.toolId} again with the same arguments plus approvalId. ` +
          "The approval works once and expires shortly after it is given.",
        structured: {
          outcome: "pending_approval",
          ...summarize(request),
          next: `Wait for ${role} to approve, poll ${STATUS_TOOL}, then repeat this call with approvalId.`,
        },
      }),
      meta: { requestId: request.id, outcome: "pending_approval" },
    };
  }

  function denied(request) {
    const { denyCode } = denyDetails(request.id);
    return refusal(
      request,
      "denied",
      `DENIED by policy${denyCode ? ` (${denyCode})` : ""}. ${request.policyReasons.join(" ")} ` +
        "Nothing was executed. Do not repeat the same request. Fix the cause above and submit a new one.",
      { denyCode, reasons: request.policyReasons },
    );
  }

  function gateRejected(request) {
    const { gap } = denyDetails(request.id);
    return refusal(
      request,
      "rejected_by_gate",
      `NOT SENT TO A HUMAN. ${gap ?? "The handoff was incomplete."} Nothing was executed. Prepare options, a recommendation and a confidence level, then submit again.`,
      { reasons: gap ? [gap] : [] },
    );
  }

  function runApproved(request, idempotencyKey) {
    const run = service.execute(request.id, {
      requestHash: request.requestHash,
      actorId: agentId,
      actor: actorLabel,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (run.ok) return executionOutcome(request, run);
    const outcomeByCode = {
      replay_blocked: "replay_blocked",
      authorization_expired: "expired",
      binding_mismatch: "binding_mismatch",
      actor_mismatch: "actor_mismatch",
      integrity_failed: "integrity_failed",
    };
    return refusal(
      request,
      outcomeByCode[run.code] ?? "blocked",
      `REFUSED (${run.code}). ${run.message} Nothing was executed.`,
    );
  }

  function ownedRequest(approvalId) {
    if (typeof approvalId !== "string" || approvalId.length === 0 || approvalId.length > 128) return null;
    const record = service.get(approvalId);
    // Same answer for "no such id" and "someone else's id" so ids cannot be probed.
    if (!record || record.actorId !== agentId) return null;
    return record;
  }

  function notFound(approvalId) {
    return {
      result: toolResult({
        isError: true,
        text: "No approval with that id exists for this agent.",
        structured: { outcome: "approval_not_found" },
      }),
      meta: { requestId: null, outcome: "approval_not_found", approvalId: clip(String(approvalId ?? ""), 40) },
    };
  }

  function statusTool(args) {
    const problems = [];
    if (typeof args.approvalId !== "string") problems.push('Missing required argument "approvalId".');
    for (const key of Object.keys(args)) if (key !== "approvalId") problems.push(`Unknown argument "${clip(key, 40)}".`);
    if (problems.length) return invalid(problems);
    const record = ownedRequest(args.approvalId);
    if (!record) return notFound(args.approvalId);
    const last =
      [...(record.decisions ?? [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
    const decision = last
      ? { decision: last.decision, reviewerRole: last.reviewerRole, decidedAt: last.createdAt }
      : null;
    const nextByStatus = {
      pending_human: "Still waiting for a reviewer. Check again later.",
      approved: `Approved. Call ${record.toolId} again with identical arguments plus approvalId. It works once and expires at ${record.authorizationExpiresAt}.`,
      denied: "Denied. Do not retry the same request.",
      executed: "Already used. A new request is needed to do it again.",
      executing: `Reserved and handed to the tool, not confirmed yet. Use ${EXECUTION_TOOL}.`,
      failed: "The tool reported a failure. A new request is needed to try again.",
      unknown_outcome: "The outcome is unknown. A person has to reconcile it. Never dispatch again.",
      expired: "Expired. Submit a new request.",
      gate_rejected: "Rejected before review because the handoff was incomplete. Submit a new request.",
      auto_approved: "Auto-approved by policy. Call the tool again with approvalId to execute.",
    };
    return {
      result: toolResult({
        text: `Request ${record.id} is ${record.status}. ${nextByStatus[record.status] ?? ""}`.trim(),
        structured: {
          outcome: "approval_status",
          approvalId: record.id,
          toolId: record.toolId,
          status: record.status,
          riskLevel: record.riskLevel,
          requiredRole: record.approvalRole ?? null,
          authorizationExpiresAt: record.authorizationExpiresAt ?? null,
          consumed: Boolean(record.executionId),
          decision,
          next: nextByStatus[record.status] ?? "",
        },
      }),
      meta: { requestId: record.id, outcome: `status_${record.status}` },
    };
  }

  function executionTool(args) {
    const problems = [];
    if (typeof args.executionId !== "string") problems.push('Missing required argument "executionId".');
    for (const key of Object.keys(args)) if (key !== "executionId") problems.push(`Unknown argument "${clip(key, 40)}".`);
    if (problems.length) return invalid(problems);
    const found = args.executionId.length <= 128 ? service.getExecution(args.executionId) : { ok: false };
    // Same answer for "no such execution" and "someone else's execution".
    if (!found.ok || found.request.actorId !== agentId) {
      return {
        result: toolResult({
          isError: true,
          text: "No execution with that id exists for this agent.",
          structured: { outcome: "execution_not_found" },
        }),
        meta: { requestId: null, outcome: "execution_not_found" },
      };
    }
    const ex = found.execution;
    const nextByState = {
      executing: `Reserved, no result recorded yet. After ${ex.timeoutAt} it becomes unknown_outcome. Check again.`,
      executed: "Done. The result digest is the recorded outcome.",
      failed: "The tool reported a failure. A new request is needed to try again.",
      unknown_outcome: "A person has to reconcile this. Never dispatch again.",
    };
    return {
      result: toolResult({
        text: `Execution ${ex.executionId} is ${ex.state}. ${nextByState[ex.state] ?? ""}`.trim(),
        structured: {
          outcome: "execution_state",
          executionId: ex.executionId,
          approvalId: ex.approvalId,
          toolId: ex.toolId,
          state: ex.state,
          resultDigest: ex.resultDigest,
          resultSummary: ex.resultSummary,
          errorCode: ex.errorCode,
          timeoutAt: ex.timeoutAt,
          reconciled: ex.reconciled ? { outcome: ex.reconciled.outcome, role: ex.reconciled.role, at: ex.reconciled.at } : null,
          next: nextByState[ex.state] ?? "",
        },
      }),
      meta: { requestId: ex.requestId, outcome: `execution_${ex.state}`, executionId: ex.executionId },
    };
  }

  function invalid(problems) {
    return {
      result: toolResult({
        isError: true,
        text: `Invalid arguments. ${problems.join(" ")}`,
        structured: { outcome: "invalid_arguments", reasons: problems },
      }),
      meta: { requestId: null, outcome: "invalid_arguments" },
    };
  }

  async function callGatewayTool(name, args) {
    const problems = checkToolArguments(args);
    if (problems.length) return invalid(problems);

    // actorId always comes from server configuration. A client cannot choose
    // who it is, so it cannot approve or replay as someone else.
    const source = {
      actorId: agentId,
      actorType: "ai-agent",
      toolId: name,
      action: args.action,
      resource: args.resource,
      environment: args.environment,
      dataClassification: args.dataClassification,
      requestedScopes: args.requestedScopes,
      existingScopes: args.existingScopes,
      arguments: args.arguments,
      justification: args.justification,
      context: args.context,
      skipAnalysis: args.skipAnalysis,
    };

    // A retry whose first response was lost may not know the approval id. If
    // this agent already used the same idempotencyKey, find that request.
    let approvalId = args.approvalId;
    if (approvalId === undefined && args.idempotencyKey !== undefined) {
      const earlier = service.findByIdempotencyKey(agentId, args.idempotencyKey);
      if (earlier) {
        if (earlier.toolId !== name) return invalid(["That idempotencyKey was used with a different tool."]);
        approvalId = earlier.id;
      }
    }

    if (approvalId !== undefined) {
      const record = ownedRequest(approvalId);
      if (!record || record.toolId !== name) return notFound(approvalId);
      const requestHash = await requestHashOf(evaluatePolicy(source).input);
      if (requestHash !== record.requestHash) {
        return refusal(
          record,
          "binding_mismatch",
          "REFUSED (binding_mismatch). These arguments are not the ones that were reviewed. Nothing was executed.",
        );
      }
      if (record.status === "pending_human") return pending(record);
      if (record.status === "denied") return denied(record);
      if (record.status === "gate_rejected") return gateRejected(record);
      return runApproved(record, args.idempotencyKey);
    }

    const submitted = await service.submit(source, actorLabel);
    if (!submitted.ok) {
      return {
        result: toolResult({
          isError: true,
          text: `REFUSED. ${submitted.message ?? "The gateway could not take this request."}`,
          structured: { outcome: "blocked", reasons: [submitted.message ?? submitted.code ?? "blocked"] },
        }),
        meta: { requestId: null, outcome: "blocked" },
      };
    }
    const request = submitted.request;
    switch (request.status) {
      case "auto_approved":
        return runApproved(request, args.idempotencyKey);
      case "pending_human":
        return pending(request);
      case "gate_rejected":
        return gateRejected(request);
      default:
        return denied(request);
    }
  }

  async function callTool(params) {
    const name = params.name;
    const rawArgs = params.arguments === undefined ? {} : params.arguments;
    if (typeof name !== "string" || name.length === 0) {
      return { error: { code: ERR.INVALID_PARAMS, message: "tools/call needs a tool name." }, meta: { outcome: "invalid_params" } };
    }
    if (!isObject(rawArgs)) {
      return { error: { code: ERR.INVALID_PARAMS, message: "arguments must be an object." }, meta: { outcome: "invalid_params", tool: clip(name, 128) } };
    }
    if (name === STATUS_TOOL) return statusTool(rawArgs);
    if (name === EXECUTION_TOOL) return executionTool(rawArgs);
    if (Object.hasOwn(toolRegistry, name)) return callGatewayTool(name, rawArgs);

    // Unknown tool: a protocol error, never a bypass. The attempt is still
    // pushed through the gateway so policy records a deny and the audit chain
    // shows what was asked for.
    const probe = await service.submit(
      {
        actorId: agentId,
        actorType: "ai-agent",
        toolId: name,
        action: typeof rawArgs.action === "string" ? rawArgs.action : "unknown",
        resource: typeof rawArgs.resource === "string" ? rawArgs.resource : "unknown://none",
        environment: typeof rawArgs.environment === "string" ? rawArgs.environment : "development",
        requestedScopes: Array.isArray(rawArgs.requestedScopes) ? rawArgs.requestedScopes : [],
        justification: typeof rawArgs.justification === "string" ? rawArgs.justification : "Call to an unregistered tool.",
      },
      actorLabel,
    );
    const requestId = probe.ok ? probe.request.id : null;
    return {
      error: {
        code: ERR.INVALID_PARAMS,
        message: `Unknown tool: ${clip(name, 80)}`,
        data: { requestId, denyCode: probe.ok ? denyDetails(requestId).denyCode : null },
      },
      meta: { requestId, outcome: "unknown_tool", tool: clip(name, 128) },
    };
  }

  // ---- routing

  function reply(id, body, status, meta) {
    return { status, body, meta };
  }

  function fail(id, status, code, message, meta, data) {
    return reply(id, rpcError(id, code, message, data), status, { outcome: meta.outcome, rpcErrorCode: code, ...meta });
  }

  function ok(id, result, era, meta) {
    const payload =
      era === "modern"
        ? { resultType: "complete", ...result, _meta: { ...(result._meta ?? {}), [`${META}serverInfo`]: SERVER_INFO } }
        : result;
    return reply(id, { jsonrpc: "2.0", id, result: payload }, 200, meta);
  }

  function capabilities() {
    return { tools: { listChanged: false } };
  }

  function listResult(era) {
    const result = { tools: toolList.map((tool) => structuredClone(tool)) };
    if (era === "modern") {
      result.ttlMs = 60_000;
      result.cacheScope = "public";
    }
    return result;
  }

  async function dispatch(id, method, params, era, ctx, client) {
    const base = { method, era, client };
    if (method === "tools/list") {
      if (params.cursor !== undefined) {
        return fail(id, 200, ERR.INVALID_PARAMS, "This server never issues cursors.", { ...base, eventType: "mcp.rejected", outcome: "invalid_params" });
      }
      return ok(id, listResult(era), era, { ...base, eventType: "mcp.request", outcome: "ok", toolCount: toolList.length });
    }
    if (method === "tools/call") {
      const called = await callTool(params);
      if (called.error) {
        return fail(id, 200, called.error.code, called.error.message, { ...base, eventType: "mcp.tools_call", ...called.meta }, called.error.data);
      }
      return ok(id, called.result, era, {
        ...base,
        eventType: "mcp.tools_call",
        tool: clip(params.name, 128),
        ...called.meta,
      });
    }
    if (era === "modern" && method === "server/discover") {
      return ok(
        id,
        {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: capabilities(),
          instructions: INSTRUCTIONS,
          ttlMs: 60_000,
          cacheScope: "public",
        },
        era,
        { ...base, eventType: "mcp.request", outcome: "ok" },
      );
    }
    if (era === "legacy" && method === "ping") {
      return ok(id, {}, era, { ...base, eventType: "mcp.request", outcome: "ok" });
    }
    // 2026-07-28 asks for HTTP 404 with -32601 when a method is not implemented.
    return fail(id, era === "modern" ? 404 : 200, ERR.METHOD_NOT_FOUND, `Method not found: ${clip(method, 80)}`, {
      ...base,
      eventType: "mcp.rejected",
      outcome: "method_not_found",
    });
  }

  function checkModernEnvelope(id, method, params, meta, ctx) {
    const version = meta[`${META}protocolVersion`];
    if (typeof version !== "string") {
      return fail(id, 400, ERR.INVALID_PARAMS, `_meta.${META}protocolVersion must be a string.`, {
        eventType: "mcp.rejected",
        outcome: "bad_meta",
        method,
      });
    }
    if (ctx.transport === "http") {
      const h = ctx.headers ?? {};
      const headerVersion = h["mcp-protocol-version"];
      const headerMethod = h["mcp-method"];
      const headerName = decodeHeaderValue(h["mcp-name"]);
      let mismatch = null;
      if (!headerVersion) mismatch = "The MCP-Protocol-Version header is missing.";
      else if (headerVersion !== version) mismatch = "MCP-Protocol-Version does not match _meta protocolVersion.";
      else if (!headerMethod) mismatch = "The Mcp-Method header is missing.";
      else if (headerMethod !== method) mismatch = "Mcp-Method does not match the request method.";
      else if (method === "tools/call") {
        if (!headerName) mismatch = "The Mcp-Name header is missing.";
        else if (headerName !== params.name) mismatch = "Mcp-Name does not match params.name.";
      }
      if (mismatch) {
        return fail(id, 400, ERR.HEADER_MISMATCH, `Header mismatch: ${mismatch}`, {
          eventType: "mcp.rejected",
          outcome: "header_mismatch",
          method,
        });
      }
    }
    if (version !== MODERN_VERSION) {
      return fail(
        id,
        400,
        ERR.UNSUPPORTED_VERSION,
        "Unsupported protocol version",
        { eventType: "mcp.rejected", outcome: "unsupported_version", method, requestedVersion: clip(version, 32) },
        { supported: [...SUPPORTED_VERSIONS], requested: version },
      );
    }
    if (!isObject(meta[`${META}clientCapabilities`])) {
      return fail(id, 400, ERR.INVALID_PARAMS, `_meta.${META}clientCapabilities is required.`, {
        eventType: "mcp.rejected",
        outcome: "bad_meta",
        method,
      });
    }
    return null;
  }

  async function route(message, ctx) {
    if (Array.isArray(message)) {
      return fail(null, 400, ERR.INVALID_REQUEST, "Batch messages are not supported. Send one JSON-RPC message per request.", {
        eventType: "mcp.rejected",
        outcome: "batch_not_supported",
      });
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      return fail(null, 400, ERR.INVALID_REQUEST, "Not a JSON-RPC 2.0 message.", {
        eventType: "mcp.rejected",
        outcome: "invalid_request",
      });
    }
    const hasId = Object.hasOwn(message, "id");
    if (typeof message.method !== "string" || message.method.length === 0) {
      const unsolicited = hasId && ("result" in message || "error" in message);
      return fail(message.id, 400, ERR.INVALID_REQUEST, unsolicited ? "This server sends no requests, so it accepts no responses." : "Missing method.", {
        eventType: "mcp.rejected",
        outcome: unsolicited ? "unsolicited_response" : "invalid_request",
      });
    }
    const method = message.method;

    if (!hasId) {
      // Notifications get no reply. On HTTP the adapter sends 202 with no body.
      if (method === "notifications/initialized" && ctx.session) ctx.session.initialized = true;
      return reply(null, null, 202, { eventType: "mcp.notification", outcome: "accepted", method: clip(method, 80) });
    }
    const id = message.id;
    if (!validId(id)) {
      return fail(null, 400, ERR.INVALID_REQUEST, "id must be a string or a number.", {
        eventType: "mcp.rejected",
        outcome: "invalid_request",
        method: clip(method, 80),
      });
    }
    if (message.params !== undefined && !isObject(message.params)) {
      return fail(id, 400, ERR.INVALID_PARAMS, "params must be an object.", {
        eventType: "mcp.rejected",
        outcome: "bad_params",
        method: clip(method, 80),
      });
    }
    const params = message.params ?? {};
    const meta = isObject(params._meta) ? params._meta : null;
    const modern = method !== "initialize" && meta !== null && Object.hasOwn(meta, `${META}protocolVersion`);

    if (modern) {
      const bad = checkModernEnvelope(id, method, params, meta, ctx);
      if (bad) return bad;
      return dispatch(id, method, params, "modern", ctx, clientOf(meta, params));
    }

    // Everything below is the initialize-based era (2025-11-25).
    if (method === "initialize") {
      const clientInfo = params.clientInfo;
      if (typeof params.protocolVersion !== "string" || !isObject(params.capabilities) || !isObject(clientInfo) || typeof clientInfo.name !== "string" || typeof clientInfo.version !== "string") {
        return fail(id, 200, ERR.INVALID_PARAMS, "initialize needs protocolVersion, capabilities and clientInfo (name, version).", {
          eventType: "mcp.rejected",
          outcome: "bad_params",
          method,
        });
      }
      if (ctx.session) ctx.session.initialized = true;
      return ok(
        id,
        {
          // The client asks for a version; the server answers with the one it
          // will speak. This server speaks 2025-11-25 in the legacy era.
          protocolVersion: LEGACY_VERSION,
          capabilities: capabilities(),
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
        "legacy",
        { eventType: "mcp.request", outcome: "ok", method, era: "legacy", client: clientOf(null, params), requestedVersion: clip(params.protocolVersion, 32) },
      );
    }

    if (ctx.transport === "http") {
      const headerVersion = (ctx.headers ?? {})["mcp-protocol-version"];
      if (headerVersion === MODERN_VERSION) {
        return fail(id, 400, ERR.INVALID_PARAMS, `A ${MODERN_VERSION} request must carry _meta.${META}protocolVersion and clientCapabilities.`, {
          eventType: "mcp.rejected",
          outcome: "bad_meta",
          method: clip(method, 80),
        });
      }
      if (!headerVersion) {
        return fail(id, 400, ERR.HEADER_MISMATCH, "The MCP-Protocol-Version header is required.", {
          eventType: "mcp.rejected",
          outcome: "header_mismatch",
          method: clip(method, 80),
        });
      }
      if (headerVersion !== LEGACY_VERSION) {
        return fail(
          id,
          400,
          ERR.UNSUPPORTED_VERSION,
          "Unsupported protocol version",
          { eventType: "mcp.rejected", outcome: "unsupported_version", method: clip(method, 80), requestedVersion: clip(headerVersion, 32) },
          { supported: [...SUPPORTED_VERSIONS], requested: headerVersion },
        );
      }
    } else if (ctx.session && !ctx.session.initialized && method !== "server/discover") {
      return fail(id, 200, ERR.INVALID_REQUEST, "Send initialize first, or include the per-request _meta fields of 2026-07-28.", {
        eventType: "mcp.rejected",
        outcome: "not_initialized",
        method: clip(method, 80),
      });
    }
    if (method === "server/discover") {
      return fail(id, 400, ERR.INVALID_PARAMS, `server/discover needs _meta.${META}protocolVersion and clientCapabilities.`, {
        eventType: "mcp.rejected",
        outcome: "bad_meta",
        method,
      });
    }
    return dispatch(id, method, params, "legacy", ctx, clientOf(null, params));
  }

  function auditPayload(meta, ctx) {
    const { eventType = "mcp.rejected", requestId, ...rest } = meta;
    return {
      eventType,
      requestId: requestId ?? null,
      payload: {
        transport: ctx.transport,
        ...rest,
      },
    };
  }

  return {
    agentId,
    tools: toolList,

    // One parsed JSON-RPC message in, { status, body } out. body is null for
    // notifications. Every outcome is written to the audit chain.
    async handle(message, ctx = { transport: "stdio", headers: null, session: null }) {
      let routed;
      try {
        routed = await route(message, ctx);
      } catch (error) {
        log(`mcp: unhandled error: ${error instanceof Error ? error.stack : error}`);
        const id = isObject(message) && validId(message.id) ? message.id : null;
        routed = fail(id, 500, ERR.INTERNAL, "Internal error", { eventType: "mcp.rejected", outcome: "internal_error" });
      }
      try {
        const entry = auditPayload(routed.meta, ctx);
        recordAudit(entry.eventType, entry.requestId, entry.payload);
      } catch (error) {
        log(`mcp: audit write failed: ${error instanceof Error ? error.message : error}`);
        const isRequest = isObject(message) && Object.hasOwn(message, "id");
        return { status: 500, body: isRequest ? rpcError(message.id, ERR.INTERNAL, "Internal error") : null };
      }
      return { status: routed.status, body: routed.body };
    },

    // For rejections that happen before a message exists (bad Origin, bad
    // JSON, wrong method, oversize body). Returns the JSON-RPC error body.
    reject(status, code, message, outcome, ctx = { transport: "http" }, extra = {}) {
      try {
        const entry = auditPayload({ eventType: "mcp.rejected", outcome, httpStatus: status, rpcErrorCode: code, ...extra }, ctx);
        recordAudit(entry.eventType, null, entry.payload);
      } catch (error) {
        log(`mcp: audit write failed: ${error instanceof Error ? error.message : error}`);
      }
      return rpcError(null, code, message);
    },
  };
}
