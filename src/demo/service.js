// Browser-compatible gateway service — mirrors server/service.js.
// Uses crypto.randomUUID() (available in all modern browsers and Node 24).
// All store methods that involve hashing are async; awaited throughout.

import { analyzeRequest } from "./ai-analyzer.js";
import { evaluatePolicy, reviewerCanApprove } from "./policy.js";
import { scenarioById } from "./scenarios.js";

function plusMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
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

  return {
    async submit(rawInput, actor = "gateway-demo") {
      const scenario = rawInput?.scenarioId ? scenarioById(rawInput.scenarioId) : null;
      if (rawInput?.scenarioId && !scenario) {
        return { ok: false, code: "unknown_scenario", message: "Scenario not found." };
      }

      const source = scenario ? scenario.request : rawInput;
      const policy = evaluatePolicy(source);
      const now = clock().toISOString();
      const authorizationExpiresAt =
        policy.decision === "allow" ? plusMinutes(now, policy.ttlMinutes) : null;

      const aiAnalysis = analyzer(source, policy); // synchronous in browser mode

      const requestInput = {
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...policy.input,
        riskScore: policy.score,
        riskLevel: policy.level,
        status: policy.status,
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
          },
        },
        {
          eventType: `policy.${requestInput.policyDecision}`,
          actor: "deterministic-policy",
          createdAt: now,
          payload: {
            riskScore: requestInput.riskScore,
            riskLevel: requestInput.riskLevel,
            requiredRole: requestInput.approvalRole,
            reasons: requestInput.policyReasons,
          },
        },
        {
          eventType: "ai.analysis_recorded",
          actor: requestInput.aiAnalysis.provider,
          createdAt: now,
          payload: {
            summary: requestInput.aiAnalysis.summary,
            advisoryOnly: true,
          },
        },
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

      const reviewerId = String(input.reviewerId ?? "").trim();
      const reviewerRole = String(input.reviewerRole ?? "").trim();
      const decision = String(input.decision ?? "").trim().toLowerCase();
      const reason = String(input.reason ?? "").trim();

      if (!reviewerId || !["approve", "deny"].includes(decision) || reason.length < 12) {
        return {
          ok: false,
          code: "invalid_decision",
          message: "Reviewer, approve/deny decision and a meaningful reason are required.",
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
      const ttlMinutes =
        request.riskLevel === "critical" ? 10 : request.riskLevel === "high" ? 15 : 30;
      const authorizationExpiresAt =
        decision === "approve" ? plusMinutes(now, ttlMinutes) : null;

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

    async execute(id, actor = "mcp-execution-guard") {
      const request = store.getRequest(id);
      if (!request) return { ok: false, code: "not_found", message: "Request not found." };
      if (request.executionId) {
        return {
          ok: false,
          code: "replay_blocked",
          message: "This authorization has already been consumed.",
        };
      }
      if (!["approved", "auto_approved"].includes(request.status)) {
        return {
          ok: false,
          code: "not_authorized",
          message: `Execution is blocked while the request is ${request.status}.`,
        };
      }

      const now = clock().toISOString();
      if (
        !request.authorizationExpiresAt ||
        new Date(request.authorizationExpiresAt).getTime() <= new Date(now).getTime()
      ) {
        const expired = await store.transitionWithAudit(
          request.id,
          request.version,
          { status: "expired", updatedAt: now },
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
          },
        },
      );

      if (!updated.ok) {
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

    verifyAudit() {
      return store.verifyAuditChain();
    },

    async reset(actor = "demo-operator") {
      const now = clock().toISOString();
      await store.resetWithAudit({
        eventType: "demo.reset",
        actor,
        createdAt: now,
        payload: { syntheticDataOnly: true },
      });
      return store.verifyAuditChain();
    },
  };
}
