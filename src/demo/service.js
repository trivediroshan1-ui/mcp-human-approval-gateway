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
import { scenarioById } from "./scenarios.js";
import { hashEvent } from "./store.js";

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
  return hashEvent(bindingPayload(request));
}

function publicRequest(request, store) {
  if (!request) return null;
  return {
    ...request,
    decisions: store.listDecisions(request.id),
  };
}

export function createGatewayService({
  store,
  clock = () => new Date(),
  analyzer = analyzeRequest,
} = {}) {
  if (!store) throw new Error("A store is required");

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

    // options.requestHash and options.actorId are what the caller says it is
    // about to run and who it is. When given, they must match the approval.
    async execute(id, options = {}) {
      const settings = typeof options === "string" ? { actor: options } : (options ?? {});
      const actor = typeof settings.actor === "string" ? settings.actor : "mcp-execution-guard";
      const presentedHash = typeof settings.requestHash === "string" ? settings.requestHash : null;
      const presentedActor = typeof settings.actorId === "string" ? settings.actorId : null;

      const request = store.getRequest(id);
      if (!request) return { ok: false, code: "not_found", message: "Request not found." };
      if (request.executionId) {
        return blockExecution(
          request,
          actor,
          "replay_blocked",
          "This authorization has already been consumed.",
        );
      }
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

      // Fail closed: a missing or unreadable expiry counts as expired.
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
      const updated = await store.transitionWithAudit(
        request.id,
        request.version,
        {
          status: "executed",
          executionId,
          executedAt: now,
          updatedAt: now,
        },
        {
          eventType: "action.executed",
          actor,
          createdAt: now,
          payload: {
            executionId,
            simulated: true,
            toolId: request.toolId,
            action: request.action,
            resource: request.resource,
            requestHash: request.requestHash,
          },
        },
      );
      if (!updated.ok) {
        const current = store.getRequest(id);
        if (current?.executionId) {
          return blockExecution(
            current,
            actor,
            "replay_blocked",
            "This authorization has already been consumed.",
          );
        }
        return {
          ok: false,
          code: updated.reason,
          message: "The request changed before execution.",
        };
      }
      return {
        ok: true,
        execution: {
          id: executionId,
          simulated: true,
          message: "Synthetic MCP action executed through the policy guard.",
        },
        request: publicRequest(store.getRequest(id), store),
      };
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
