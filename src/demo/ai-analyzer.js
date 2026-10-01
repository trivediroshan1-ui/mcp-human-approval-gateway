// Browser-only analyst. There is no model here and no network call. The code
// between the markers is the same text as the offline analyst in
// server/ai-analyzer.js, and tests/parity.test.js checks that it stays that way.

// --- offline analyst: kept identical in src/demo/ai-analyzer.js (tests/parity.test.js checks) ---

// Nothing in this file calls a model unless the server is configured with
// AI_BASE_URL, AI_API_KEY and AI_MODEL. The offline analyst is a fixed set of
// rules that turns the policy result into reviewer-facing text. It is a
// simulation of an analyst, and every record it produces says so.

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
// that work. The gate in service.js reads this function directly, never the
// analyst output, so a model cannot pass or fail the gate.
export function decisionPackageFor(request, policy) {
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

// Strip things that look like credentials before any free text leaves the
// gateway. This is a best-effort filter for the optional external analyst, not
// a guarantee. The stronger control is that the prompt is built from a fixed
// list of fields and never includes context, arguments or the resource path.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

export function redactSecrets(value) {
  let out = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

export function offlineAnalysis(request, policy) {
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
    simulated: true,
    modelCalled: false,
    summary:
      policy.decision === "allow"
        ? "Registered low-risk action. Policy allows execution, subject to audit logging."
        : policy.decision === "require_human"
          ? `The action carries ${policy.level} risk and requires ${policy.approvalRole} review.`
          : "The request is blocked because it violates a registered policy boundary.",
    hypotheses,
    uncertainty: [
      "This is a rule-based simulation of an analyst. No language model was called.",
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

// --- end shared ---

export function analyzeRequest(request, policy) {
  return offlineAnalysis(request, policy);
}
