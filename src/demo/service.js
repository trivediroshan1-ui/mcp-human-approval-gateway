// Browser-compatible gateway service. Generated from server/service.js by
// scripts/sync-demo-service.mjs. Do not edit by hand: change the server copy and
// run the script. The only differences are `await` on store calls (Web Crypto
// hashing is async) and crypto.randomUUID() in place of the node:crypto import.
// tests/parity.test.js fails if this file is stale.

import { analyzeRequest, decisionPackageFor, offlineAnalysis } from "./ai-analyzer.js";
import {
  bindingPayload,
  evaluatePolicy,
  REVIEW_WINDOW_MINUTES,
  reviewerCanApprove,
  reviewerCanDecide,
  ttlMinutesFor,
} from "./policy.js";
import { createFakeDownstream } from "./downstream.js";
import { scenarioById } from "./scenarios.js";
import { hashEvent } from "./store.js";

// How long a reserved execution may stay "executing" before the guard stops
// trusting it. The tool might have run or might not, and only a person can say
// which, so the state becomes unknown_outcome and waits for reconciliation.
export const EXECUTION_TIMEOUT_MINUTES = 5;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
export function validIdempotencyKey(value) {
  return typeof value === "string" && IDEMPOTENCY_KEY.test(value);
}

function clipText(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : null;
}

function plusMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameIdentity(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// The hash an approval is bound to. It is recomputed from the stored request
// every time it matters, so a row edited after approval no longer matches.
export async function requestHashOf(request) {
  return await hashEvent(bindingPayload(request));
}

// The dispatch key is what lets a dispatcher confirm an execution, so it never
// leaves the service inside a request record.
function publicRequest(request, store) {
  if (!request) return null;
  const { dispatchKey: _hidden, ...execution } = request.execution ?? {};
  return {
    ...request,
    execution: request.execution ? execution : null,
    decisions: store.listDecisions(request.id),
  };
}

export function createGatewayService({
  store,
  clock = () => new Date(),
  analyzer = analyzeRequest,
  downstream = createFakeDownstream(),
  dispatchSecret = crypto.randomUUID(),
} = {}) {
  if (!store) throw new Error("A store is required");

  function executionView(request) {
    if (!request?.executionId) return null;
    const e = request.execution ?? {};
    const state = ["executing", "executed", "failed", "unknown_outcome"].includes(request.status)
      ? request.status
      : null;
    return {
      executionId: request.executionId,
      requestId: request.id,
      approvalId: request.id,
      toolId: request.toolId,
      state,
      requestHash: request.requestHash,
      idempotencyKey: e.idempotencyKey ?? null,
      reservedAt: e.reservedAt ?? request.executedAt ?? null,
      timeoutAt: e.timeoutAt ?? null,
      confirmedAt: e.confirmedAt ?? null,
      resultDigest: e.resultDigest ?? null,
      resultSummary: e.resultSummary ?? null,
      errorCode: e.errorCode ?? null,
      reconciled: e.reconciled ?? null,
      simulated: true,
      // Lab only: a real downstream cannot be asked this without its own API.
      downstreamEffects: e.dispatchKey ? downstream.effectsFor(e.dispatchKey) : null,
    };
  }

  async function blockExecution(request, actor, code, message, extra = {}) {
    const now = clock().toISOString();
    await store.recordAudit({
      requestId: request.id,
      eventType: "execution.blocked",
      actor,
      createdAt: now,
      payload: { code, status: request.status, ...extra },
    });
    return { ok: false, code, message };
  }

  // A request that already has an execution id. Same idempotency key or same
  // execution id: answer from the stored record. Anything else: replay_blocked.
  async function serveRetry(request, retry) {
    const stored = request.execution ?? {};
    const byKey = retry.presentedKey !== null && stored.idempotencyKey === retry.presentedKey;
    const byExecution = retry.presentedExecutionId !== null && retry.presentedExecutionId === request.executionId;
    if (!byKey && !byExecution) {
      return blockExecution(
        request,
        retry.actor,
        "replay_blocked",
        "This authorization has already been consumed.",
      );
    }
    if (retry.presentedActor !== null && !sameIdentity(retry.presentedActor, request.actorId)) {
      return blockExecution(
        request,
        retry.actor,
        "actor_mismatch",
        "The authorization was issued to a different requester.",
      );
    }
    const currentHash = await requestHashOf(request);
    if (currentHash !== request.requestHash) {
      return blockExecution(
        request,
        retry.actor,
        "integrity_failed",
        "The stored request no longer matches the approved hash.",
      );
    }
    if (retry.presentedHash !== null && retry.presentedHash !== request.requestHash) {
      return blockExecution(
        request,
        retry.actor,
        "binding_mismatch",
        "The action presented for execution is not the action that was approved.",
        { presentedHash: retry.presentedHash },
      );
    }
    await store.recordAudit({
      requestId: request.id,
      eventType: "action.retry_served",
      actor: retry.actor,
      createdAt: clock().toISOString(),
      payload: {
        executionId: request.executionId,
        state: request.status,
        matchedBy: byKey ? "idempotency_key" : "execution_id",
      },
    });
    return {
      ok: true,
      replayed: true,
      execution: executionView(request),
      request: publicRequest(request, store),
    };
  }

  return {
    async submit(rawInput, actor = "gateway-api") {
      const scenario = rawInput?.scenarioId ? scenarioById(rawInput.scenarioId) : null;
      if (rawInput?.scenarioId && !scenario) {
        return { ok: false, code: "unknown_scenario", message: "Scenario not found." };
      }
      const source = scenario ? scenario.request : rawInput;
      const policy = evaluatePolicy(source);
      const now = clock().toISOString();
      const authorizationExpiresAt =
        policy.decision === "allow" ? plusMinutes(now, policy.ttlMinutes) : null;
      const requestHash = await requestHashOf(policy.input);

      // The analysis is stored for the reviewer and has no path back into the
      // decision. If the analyst fails, the offline rules stand in.
      let aiAnalysis;
      try {
        aiAnalysis = await analyzer(policy.input, policy);
      } catch {
        aiAnalysis = { ...offlineAnalysis(policy.input, policy), provider: "offline-fallback" };
      }

      // Decision-package gate: if policy requires a human but the agent's own
      // handoff is incomplete (no options considered, no recommendation, no
      // confidence), reject it before a human sees it. The gate reads the
      // request through decisionPackageFor, never the analyst output.
      const handoff = decisionPackageFor(policy.input, policy);
      const gateRejected = policy.decision === "require_human" && handoff.complete === false;

      const requestInput = {
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...policy.input,
        requestHash,
        riskScore: policy.score,
        riskLevel: policy.level,
        status: gateRejected ? "gate_rejected" : policy.status,
        policyDecision: policy.decision,
        policyReasons: policy.reasons,
        policyControls: policy.controls,
        approvalRole: policy.approvalRole,
        authorizationExpiresAt,
        aiAnalysis,
      };
      const committed = await store.createRequestWithAudit(requestInput, [
        {
          eventType: "request.submitted",
          actor,
          createdAt: now,
          payload: {
            actorId: requestInput.actorId,
            toolId: requestInput.toolId,
            action: requestInput.action,
            environment: requestInput.environment,
            requestHash,
          },
        },
        {
          eventType: `policy.${requestInput.policyDecision}`,
          actor: "deterministic-policy",
          createdAt: now,
          payload: {
            policyVersion: policy.policyVersion,
            riskScore: requestInput.riskScore,
            riskLevel: requestInput.riskLevel,
            requiredRole: requestInput.approvalRole,
            denyCode: policy.denyCode,
            reasons: requestInput.policyReasons,
          },
        },
        {
          eventType: "ai.analysis_recorded",
          actor: requestInput.aiAnalysis.provider,
          createdAt: now,
          payload: {
            summary: requestInput.aiAnalysis.summary,
            modelCalled: requestInput.aiAnalysis.modelCalled === true,
            advisoryOnly: true,
          },
        },
        ...(gateRejected
          ? [
              {
                eventType: "decision_package.rejected",
                actor: "decision-package-gate",
                createdAt: now,
                payload: {
                  gap: handoff.gap,
                  wouldHaveRequired: requestInput.approvalRole,
                },
              },
            ]
          : []),
      ]);
      const request = committed.request;
      return { ok: true, request: publicRequest(store.getRequest(request.id), store) };
    },

    get(id) {
      return publicRequest(store.getRequest(id), store);
    },

    list(limit) {
      return store.listRequests(limit).map((request) => publicRequest(request, store));
    },

    async decide(id, input = {}) {
      const request = store.getRequest(id);
      if (!request) return { ok: false, code: "not_found", message: "Request not found." };
      if (request.status !== "pending_human") {
        return {
          ok: false,
          code: "invalid_state",
          message: `A decision cannot be recorded while the request is ${request.status}.`,
        };
      }
      if (!isObject(input)) {
        return {
          ok: false,
          code: "invalid_decision",
          message: "The decision must be a JSON object.",
        };
      }

      const reviewerId = typeof input.reviewerId === "string" ? input.reviewerId.trim() : "";
      const reviewerRole = typeof input.reviewerRole === "string" ? input.reviewerRole.trim() : "";
      const decision = typeof input.decision === "string" ? input.decision.trim().toLowerCase() : "";
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (
        !reviewerId ||
        reviewerId.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(reviewerId) ||
        !["approve", "deny"].includes(decision) ||
        reason.length < 12 ||
        reason.length > 1000
      ) {
        return {
          ok: false,
          code: "invalid_decision",
          message:
            "Reviewer, approve/deny decision and a reason of 12 to 1000 characters are required.",
        };
      }
      if (!reviewerCanDecide(reviewerRole)) {
        return {
          ok: false,
          code: "insufficient_role",
          message: "The reviewer role cannot decide on requests.",
        };
      }
      if (decision === "approve" && sameIdentity(reviewerId, request.actorId)) {
        return {
          ok: false,
          code: "self_approval",
          message: "A requester cannot approve its own request.",
        };
      }
      if (decision === "approve" && !reviewerCanApprove(reviewerRole, request.approvalRole)) {
        return {
          ok: false,
          code: "insufficient_role",
          message: `${request.approvalRole} approval is required.`,
        };
      }

      const now = clock().toISOString();

      // A request that waited too long is no longer the thing the agent asked
      // for. It expires and has to be submitted again.
      const queuedUntil = Date.parse(request.createdAt) + REVIEW_WINDOW_MINUTES * 60_000;
      if (!(Date.parse(now) <= queuedUntil)) {
        const expired = await store.transitionWithAudit(
          request.id,
          request.version,
          { status: "expired", updatedAt: now },
          {
            eventType: "review.expired",
            actor: "mcp-execution-guard",
            createdAt: now,
            payload: { reviewWindowMinutes: REVIEW_WINDOW_MINUTES },
          },
        );
        return {
          ok: false,
          code: expired.ok ? "review_window_elapsed" : expired.reason,
          message: "The review window has passed. Submit the request again.",
        };
      }

      // The stored request must still be the one the policy evaluated.
      if ((await requestHashOf(request)) !== request.requestHash) {
        await store.transitionWithAudit(
          request.id,
          request.version,
          { status: "denied", updatedAt: now },
          {
            eventType: "request.integrity_failed",
            actor: "mcp-execution-guard",
            createdAt: now,
            payload: { expectedHash: request.requestHash, stage: "decision" },
          },
        );
        return {
          ok: false,
          code: "integrity_failed",
          message: "The stored request no longer matches its hash. It was denied.",
        };
      }

      const authorizationExpiresAt =
        decision === "approve" ? plusMinutes(now, ttlMinutesFor(request.riskLevel)) : null;
      const committed = await store.recordDecisionAndTransition(
        {
          id: crypto.randomUUID(),
          requestId: id,
          reviewerId,
          reviewerRole,
          decision,
          reason,
          createdAt: now,
          authorizationExpiresAt,
          requestHash: request.requestHash,
        },
        request.version,
        {
          status: decision === "approve" ? "approved" : "denied",
          authorizationExpiresAt,
          updatedAt: now,
        },
        {
          eventType: `human.${decision}`,
          actor: `${reviewerRole}:${reviewerId}`,
          createdAt: now,
          payload: {
            reason,
            authorizationExpiresAt,
            requiredRole: request.approvalRole,
            requestHash: request.requestHash,
          },
        },
      );
      if (!committed.ok) {
        return {
          ok: false,
          code: committed.reason,
          message: "The request changed before the decision was committed.",
        };
      }

      return {
        ok: true,
        decision: committed.decision,
        request: publicRequest(store.getRequest(id), store),
      };
    },

    // Phase one of execution. Consumes the single-use grant atomically, moves
    // the request to "executing", and issues an execution id plus a dispatch
    // key for the tool. The dispatch key is derived from the request id, the
    // execution id and a secret this service holds, so only the holder of the
    // reservation can confirm the result.
    //
    // A retry carrying the same idempotency key (or the same execution id) is
    // answered from the stored record and never reserves or dispatches again.
    // Anything else after the grant is spent is replay_blocked.
    //
    // options.requestHash and options.actorId are what the caller says it is
    // about to run and who it is. When given, they must match the approval.
    async reserve(id, options = {}) {
      const settings = typeof options === "string" ? { actor: options } : (options ?? {});
      const actor = typeof settings.actor === "string" ? settings.actor : "mcp-execution-guard";
      const presentedHash = typeof settings.requestHash === "string" ? settings.requestHash : null;
      const presentedActor = typeof settings.actorId === "string" ? settings.actorId : null;
      const presentedKey = settings.idempotencyKey ?? null;
      const presentedExecutionId =
        typeof settings.executionId === "string" && settings.executionId ? settings.executionId : null;
      const retry = { presentedKey, presentedExecutionId, presentedHash, presentedActor, actor };

      if (presentedKey !== null && !validIdempotencyKey(presentedKey)) {
        return {
          ok: false,
          code: "invalid_idempotency_key",
          message: "The idempotency key must be 8 to 128 characters from A-Z a-z 0-9 . _ : -",
        };
      }

      let request = store.getRequest(id);
      if (!request) return { ok: false, code: "not_found", message: "Request not found." };
      request = await this.settleStuck(request);
      if (request.executionId) return serveRetry(request, retry);

      if (!["approved", "auto_approved"].includes(request.status)) {
        return blockExecution(
          request,
          actor,
          "not_authorized",
          `Execution is blocked while the request is ${request.status}.`,
        );
      }
      if (presentedActor !== null && !sameIdentity(presentedActor, request.actorId)) {
        return blockExecution(
          request,
          actor,
          "actor_mismatch",
          "The authorization was issued to a different requester.",
        );
      }

      const now = clock().toISOString();

      // Integrity first: the stored request must hash to the value policy
      // evaluated, and a human approval must carry that same hash. Any
      // difference revokes the authorization.
      const approval = request.status === "approved" ? store.latestDecision(request.id) : null;
      const recomputed = await requestHashOf(request);
      const approvedHash = approval ? approval.requestHash : request.requestHash;
      if (recomputed !== request.requestHash || recomputed !== approvedHash) {
        await store.transitionWithAudit(
          request.id,
          request.version,
          { status: "denied", updatedAt: now },
          {
            eventType: "request.integrity_failed",
            actor,
            createdAt: now,
            payload: { expectedHash: request.requestHash, stage: "execution" },
          },
        );
        return {
          ok: false,
          code: "integrity_failed",
          message: "The stored request no longer matches the approved hash. Authorization revoked.",
        };
      }
      if (presentedHash !== null && presentedHash !== request.requestHash) {
        return blockExecution(
          request,
          actor,
          "binding_mismatch",
          "The action presented for execution is not the action that was approved.",
          { presentedHash },
        );
      }

      // Fail closed: a missing or unreadable expiry counts as expired. The
      // expiry is judged once, here. A grant that was reserved in time stays
      // valid for confirmation and for retries even if the clock passes it.
      const expiresAt = Date.parse(request.authorizationExpiresAt ?? "");
      if (!(expiresAt > Date.parse(now))) {
        const expired = await store.transitionWithAudit(
          request.id,
          request.version,
          {
            status: "expired",
            updatedAt: now,
          },
          {
            eventType: "authorization.expired",
            actor,
            createdAt: now,
            payload: { expiredAt: request.authorizationExpiresAt },
          },
        );
        return {
          ok: false,
          code: expired.ok ? "authorization_expired" : expired.reason,
          message: expired.ok
            ? "The time-bound authorization has expired."
            : "The request changed before expiry was recorded.",
        };
      }

      // Consume. The version check inside the transaction is what makes this
      // single-use: of two callers holding the same version, one wins.
      const executionId = crypto.randomUUID();
      const dispatchKey = await hashEvent({
        purpose: "dispatch-key",
        requestId: request.id,
        executionId,
        secret: dispatchSecret,
      });
      const dispatchKeyDigest = await hashEvent({ purpose: "dispatch-key-digest", dispatchKey });
      const timeoutAt = plusMinutes(now, EXECUTION_TIMEOUT_MINUTES);
      const execution = {
        executionId,
        idempotencyKey: presentedKey,
        dispatchKey,
        state: "executing",
        reservedAt: now,
        timeoutAt,
        confirmedAt: null,
        resultDigest: null,
        resultSummary: null,
        errorCode: null,
        reconciled: null,
      };
      const updated = await store.transitionWithAudit(
        request.id,
        request.version,
        { status: "executing", executionId, execution, updatedAt: now },
        {
          eventType: "action.reserved",
          actor,
          createdAt: now,
          payload: {
            executionId,
            dispatchKeyDigest,
            idempotencyKey: presentedKey,
            simulated: true,
            toolId: request.toolId,
            action: request.action,
            resource: request.resource,
            requestHash: request.requestHash,
            timeoutAt,
          },
        },
      );
      if (!updated.ok) {
        const current = store.getRequest(id);
        if (current?.executionId) return serveRetry(current, retry);
        return {
          ok: false,
          code: updated.reason,
          message: "The request changed before execution.",
        };
      }
      return {
        ok: true,
        replayed: false,
        execution: executionView(updated.request),
        dispatchKey,
        request: publicRequest(store.getRequest(id), store),
      };
    },

    // Phase two: hand the reserved action to the tool with its dispatch key as
    // the idempotency key. This changes no state. A tool error that says it did
    // no work is "failed". A timeout or any unrecognised error means the
    // outcome is unknown, and the caller must not guess.
    async dispatch(id, options = {}) {
      const request = store.getRequest(id);
      if (!request) return { ok: false, code: "not_found", message: "Request not found." };
      if (request.status !== "executing" || request.executionId !== options.executionId) {
        return { ok: false, code: "not_executing", message: "There is no open reservation to dispatch." };
      }
      try {
        const result = downstream.dispatch({
          idempotencyKey: request.execution?.dispatchKey,
          toolId: request.toolId,
          action: request.action,
          resource: request.resource,
          arguments: request.arguments,
        });
        return { ok: true, result };
      } catch (error) {
        return {
          ok: false,
          code: typeof error?.code === "string" ? error.code : "dispatch_error",
          message: "The tool did not return a result.",
          outcomeKnown: error?.outcomeKnown === true,
        };
      }
    },

    // Phase three: record what happened. Only the holder of the dispatch key can
    // do this. Confirming twice with the same outcome is a no-op. After the
    // timeout has moved the request to unknown_outcome a late confirm is
    // refused, because from then on the record is only changed by reconcile.
    async confirm(executionId, options = {}) {
      const actor = typeof options.actor === "string" ? options.actor : "mcp-dispatcher";
      const outcome = options.outcome;
      let request = store.findByExecutionId(executionId);
      if (!request) return { ok: false, code: "not_found", message: "Execution not found." };
      request = await this.settleStuck(request);
      const stored = request.execution ?? {};
      if (typeof options.dispatchKey !== "string" || options.dispatchKey !== stored.dispatchKey) {
        return blockExecution(request, actor, "confirm_rejected", "The dispatch key does not match this execution.");
      }
      if (!["executed", "failed"].includes(outcome)) {
        return { ok: false, code: "invalid_outcome", message: "The outcome must be executed or failed." };
      }
      if (request.status === outcome) {
        return { ok: true, replayed: true, execution: executionView(request), request: publicRequest(request, store) };
      }
      if (request.status === "unknown_outcome") {
        return blockExecution(
          request,
          actor,
          "needs_reconciliation",
          "The timeout has passed. Only a reconciliation can record this outcome now.",
        );
      }
      if (request.status !== "executing") {
        return blockExecution(
          request,
          actor,
          "invalid_state",
          `An outcome cannot be recorded while the request is ${request.status}.`,
        );
      }
      const resultDigest =
        typeof options.resultDigest === "string" && /^[0-9a-f]{64}$/.test(options.resultDigest)
          ? options.resultDigest
          : null;
      const now = clock().toISOString();
      const moved = await store.transitionWithAudit(
        request.id,
        request.version,
        {
          status: outcome,
          ...(outcome === "executed" ? { executedAt: now } : {}),
          execution: {
            ...stored,
            state: outcome,
            confirmedAt: now,
            resultDigest: outcome === "executed" ? resultDigest : null,
            resultSummary: outcome === "executed" ? clipText(options.resultSummary, 200) : null,
            errorCode: outcome === "failed" ? (clipText(options.errorCode, 64) ?? "unspecified") : null,
          },
          updatedAt: now,
        },
        {
          eventType: outcome === "executed" ? "action.confirmed" : "action.failed",
          actor,
          createdAt: now,
          payload: {
            executionId,
            simulated: true,
            resultDigest: outcome === "executed" ? resultDigest : null,
            errorCode: outcome === "failed" ? (clipText(options.errorCode, 64) ?? "unspecified") : null,
          },
        },
      );
      if (!moved.ok) {
        const current = store.getRequest(request.id);
        if (current?.status === outcome) {
          return { ok: true, replayed: true, execution: executionView(current), request: publicRequest(current, store) };
        }
        return { ok: false, code: moved.reason, message: "The request changed before the outcome was recorded." };
      }
      return {
        ok: true,
        replayed: false,
        execution: executionView(moved.request),
        request: publicRequest(moved.request, store),
      };
    },

    // The one-call path used by the scenarios, the API and the UI: reserve,
    // dispatch and confirm in order. Retries with the same idempotency key get
    // the stored record back. If the tool times out the request stays
    // "executing" and this returns that state instead of guessing.
    async execute(id, options = {}) {
      const settings = typeof options === "string" ? { actor: options } : (options ?? {});
      const actor = typeof settings.actor === "string" ? settings.actor : "mcp-execution-guard";
      const reserved = await this.reserve(id, options);
      if (!reserved.ok || reserved.replayed) return reserved;
      const executionId = reserved.execution.executionId;
      const run = await this.dispatch(id, { executionId });
      let confirmed;
      if (run.ok) {
        const resultDigest = await hashEvent(run.result);
        confirmed = await this.confirm(executionId, {
          dispatchKey: reserved.dispatchKey,
          outcome: "executed",
          resultDigest,
          resultSummary: run.result.summary,
          actor,
        });
      } else if (run.outcomeKnown) {
        confirmed = await this.confirm(executionId, {
          dispatchKey: reserved.dispatchKey,
          outcome: "failed",
          errorCode: run.code,
          actor,
        });
      } else {
        return {
          ok: true,
          replayed: false,
          execution: {
            ...reserved.execution,
            id: executionId,
            message: "The tool did not answer. The outcome is not known yet. Retry with the same idempotency key to check.",
          },
          request: reserved.request,
        };
      }
      if (!confirmed.ok) return confirmed;
      return {
        ...confirmed,
        execution: {
          ...confirmed.execution,
          id: executionId,
          message:
            confirmed.execution.state === "executed"
              ? "Synthetic MCP action executed through the policy guard."
              : "The synthetic tool reported a failure. Nothing was changed.",
        },
      };
    },

    // Move a reservation that never got a confirmation to unknown_outcome. It
    // is never retried and never dispatched again from here.
    async settleStuck(request) {
      if (request.status !== "executing") return request;
      const timeoutAt = Date.parse(request.execution?.timeoutAt ?? "");
      const nowDate = clock();
      // An unreadable timeout counts as already passed.
      if (Number.isFinite(timeoutAt) && nowDate.getTime() < timeoutAt) return request;
      const now = nowDate.toISOString();
      const moved = await store.transitionWithAudit(
        request.id,
        request.version,
        {
          status: "unknown_outcome",
          execution: { ...(request.execution ?? {}), state: "unknown_outcome" },
          updatedAt: now,
        },
        {
          eventType: "action.unknown_outcome",
          actor: "mcp-execution-guard",
          createdAt: now,
          payload: {
            executionId: request.executionId,
            reservedAt: request.execution?.reservedAt ?? null,
            timeoutAt: request.execution?.timeoutAt ?? null,
            reason: "No confirmation arrived before the timeout. The tool may or may not have run.",
          },
        },
      );
      return moved.ok ? moved.request : (store.getRequest(request.id) ?? request);
    },

    // Read an execution by its id (or by the request id). Reading can move a
    // stuck reservation to unknown_outcome, which is the only write it does.
    async getExecution(idOrExecutionId) {
      let request = store.findByExecutionId(idOrExecutionId) ?? store.getRequest(idOrExecutionId);
      if (!request?.executionId) return { ok: false, code: "not_found", message: "Execution not found." };
      request = await this.settleStuck(request);
      return { ok: true, execution: executionView(request), request: publicRequest(request, store) };
    },

    // Settle every reservation that has passed its timeout.
    async sweep() {
      let moved = 0;
      for (const request of store.listRequests(250)) {
        if (request.status === "executing") {
          const settled = await this.settleStuck(request);
          if (settled.status !== "executing") moved += 1;
        }
      }
      return moved;
    },

    // A person records what really happened to an execution whose outcome is
    // unknown, after checking the downstream system. The requester cannot do
    // this for its own action.
    async reconcile(executionId, input = {}) {
      let request = store.findByExecutionId(executionId);
      if (!request) return { ok: false, code: "not_found", message: "Execution not found." };
      request = await this.settleStuck(request);
      if (!isObject(input)) {
        return { ok: false, code: "invalid_reconciliation", message: "The reconciliation must be a JSON object." };
      }
      const reviewerId = typeof input.reviewerId === "string" ? input.reviewerId.trim() : "";
      const reviewerRole = typeof input.reviewerRole === "string" ? input.reviewerRole.trim() : "";
      const outcome = typeof input.outcome === "string" ? input.outcome.trim().toLowerCase() : "";
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (
        !reviewerId ||
        reviewerId.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(reviewerId) ||
        !["executed", "failed"].includes(outcome) ||
        reason.length < 12 ||
        reason.length > 1000
      ) {
        return {
          ok: false,
          code: "invalid_reconciliation",
          message: "Reviewer, an executed/failed outcome and a reason of 12 to 1000 characters are required.",
        };
      }
      if (request.status !== "unknown_outcome") {
        return {
          ok: false,
          code: "invalid_state",
          message: `Only an unknown_outcome execution can be reconciled. This one is ${request.status}.`,
        };
      }
      if (!reviewerCanDecide(reviewerRole) || !reviewerCanApprove(reviewerRole, request.approvalRole ?? "resource-owner")) {
        return {
          ok: false,
          code: "insufficient_role",
          message: `${request.approvalRole ?? "resource-owner"} authority is required to reconcile this.`,
        };
      }
      if (sameIdentity(reviewerId, request.actorId)) {
        return {
          ok: false,
          code: "self_reconcile",
          message: "A requester cannot report the outcome of its own action.",
        };
      }
      const now = clock().toISOString();
      const reconciled = { by: reviewerId, role: reviewerRole, outcome, reason, at: now };
      const moved = await store.transitionWithAudit(
        request.id,
        request.version,
        {
          status: outcome,
          ...(outcome === "executed" ? { executedAt: now } : {}),
          execution: {
            ...(request.execution ?? {}),
            state: outcome,
            confirmedAt: now,
            errorCode: outcome === "failed" ? "reconciled_failed" : null,
            reconciled,
          },
          updatedAt: now,
        },
        {
          eventType: "action.reconciled",
          actor: `${reviewerRole}:${reviewerId}`,
          createdAt: now,
          payload: {
            executionId,
            previousState: "unknown_outcome",
            outcome,
            reason,
            simulated: true,
          },
        },
      );
      if (!moved.ok) {
        return { ok: false, code: moved.reason, message: "The request changed before the reconciliation was recorded." };
      }
      return { ok: true, execution: executionView(moved.request), request: publicRequest(moved.request, store) };
    },

    // The most recent request from this actor that reserved with this key. It
    // lets a caller whose first response was lost find its earlier attempt
    // without knowing the approval id. Looks at the latest 250 requests only.
    findByIdempotencyKey(actorId, key) {
      if (!validIdempotencyKey(key)) return null;
      const match = store
        .listRequests(250)
        .find((request) => request.execution?.idempotencyKey === key && sameIdentity(request.actorId, actorId));
      return match ? publicRequest(match, store) : null;
    },

    audit(requestId, limit) {
      return store.listAudit(requestId, limit);
    },

    async verifyAudit(options) {
      return await store.verifyAuditChain(options);
    },

    async reset(actor = "demo-operator") {
      const now = clock().toISOString();
      await store.resetWithAudit({
        eventType: "demo.reset",
        actor,
        createdAt: now,
        payload: { syntheticDataOnly: true },
      });
      return await store.verifyAuditChain();
    },
  };
}
