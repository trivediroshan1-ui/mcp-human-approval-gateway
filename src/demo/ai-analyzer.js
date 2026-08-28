// Browser-only deterministic AI analyzer - no external API calls, no credentials.
// Advisory output only. Mirrors the offline-deterministic path of server/ai-analyzer.js.

function optionsConsideredFor(policy) {
  if (policy.decision === "allow") {
    return ["Proceed under the existing policy allowance.", "Escalate anyway for visibility."];
  }
  if (policy.decision === "deny") {
    return ["Proceed as requested (blocked by policy).", "Resubmit with a corrected scope."];
  }
  return [
    "Approve as requested.",
    "Approve with reduced scope or a shorter authorization window.",
    "Deny and request additional justification.",
  ];
}

function recommendationFor(policy) {
  if (policy.decision === "allow") return "Proceed. No human action is required.";
  if (policy.decision === "deny") {
    return "Do not proceed. Resubmit only once the policy violation is corrected.";
  }
  return `Approve only if ${policy.approvalRole} confirms the requested scope and duration are minimum-necessary.`;
}

function confidenceFor(policy) {
  if (policy.decision === "deny") return "high";
  if (policy.level === "critical") return "low";
  if (policy.level === "high") return "medium";
  return "medium";
}

// The decision package is the fix for the "processing tax": before a request
// reaches a human, the agent must show its own options, recommendation and
// confidence. `skipAnalysis` simulates an agent that handed off without doing
// that work - the gate in service.js rejects it before a human ever sees it.
function decisionPackageFor(request, policy) {
  if (request.skipAnalysis) {
    return {
      optionsConsidered: [],
      recommendation: null,
      confidence: null,
      complete: false,
      gap: "The agent did not state the options it considered, a recommendation, or a confidence level before asking a human to decide.",
    };
  }
  return {
    optionsConsidered: optionsConsideredFor(policy),
    recommendation: recommendationFor(policy),
    confidence: confidenceFor(policy),
    complete: true,
  };
}

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

  const decisionPackage = decisionPackageFor(request, policy);

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
    recommendation: decisionPackage.recommendation,
    confidence: decisionPackage.confidence,
    optionsConsidered: decisionPackage.optionsConsidered,
    decisionPackage,
  };
}
