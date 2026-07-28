// Browser-only deterministic AI analyzer — no external API calls, no credentials.
// Advisory output only. Mirrors the offline-deterministic path of server/ai-analyzer.js.

export function analyzeRequest(request, policy) {
  const hypotheses = [];

  if (request.environment === "production") {
    hypotheses.push("Production impact may exceed the stated technical scope.");
  }
  if (request.requestedScopes.length > request.existingScopes.length) {
    hypotheses.push("The request introduces permission not already held by the actor.");
  }
  if (policy.level === "critical" || policy.level === "high") {
    hypotheses.push("A compromised agent could convert this capability into material access.");
  }
  if (policy.decision === "deny") {
    hypotheses.push("The request violates a non-negotiable gateway control.");
  }

  return {
    provider: "offline-deterministic",
    summary:
      policy.decision === "allow"
        ? "Registered low-risk action. Policy allows execution, subject to audit logging."
        : policy.decision === "require_human"
          ? `The action carries ${policy.level} risk and requires ${policy.approvalRole} review.`
          : "The request is blocked because it violates a registered policy boundary.",
    hypotheses,
    uncertainty: [
      "The gateway uses synthetic context and cannot establish real business ownership.",
      "AI analysis is advisory and does not modify the deterministic policy result.",
    ],
    questions:
      policy.decision === "require_human"
        ? [
            "Is the requested scope the minimum necessary?",
            "Is the resource owner aware of the request?",
            "Is the proposed authorization duration appropriate?",
            "What rollback or containment path exists?",
          ]
        : [],
  };
}
