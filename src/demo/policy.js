// Browser-compatible port of server/policy.js — pure ES module, no Node.js dependencies.

import { TOOL_REGISTRY } from "./scenarios.js";

const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior) (rules|instructions)/i,
  /bypass (approval|security|policy)/i,
  /reveal (the )?(system prompt|credentials|secrets)/i,
  /disable (logging|audit|guardrails)/i,
  /use any available credentials/i,
];

const CLASSIFICATION_POINTS = Object.freeze({
  public: 0,
  internal: 8,
  confidential: 16,
  restricted: 26,
});

const ROLE_LEVEL = Object.freeze({
  viewer: 0,
  "resource-owner": 1,
  "security-analyst": 2,
  "security-lead": 3,
});

const REQUIRED_ROLE_LEVEL = Object.freeze({
  "resource-owner": 1,
  "security-analyst": 2,
  "security-lead": 3,
});

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function levelForScore(score) {
  if (score >= 85) return "critical";
  if (score >= 65) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function approvalRoleFor(level, tool) {
  if (level === "critical" || tool?.destructive || tool?.privilegeChange || tool?.productionChange) {
    return "security-lead";
  }
  if (level === "high" || tool?.credentialAccess) return "security-analyst";
  if (level === "medium") return "resource-owner";
  return null;
}

function ttlMinutesFor(level) {
  return {
    low: 60,
    medium: 30,
    high: 15,
    critical: 10,
  }[level];
}

export function normalizeRequest(input = {}) {
  return {
    actorId: String(input.actorId ?? "").trim(),
    actorType: String(input.actorType ?? "ai-agent").trim(),
    toolId: String(input.toolId ?? "").trim(),
    action: String(input.action ?? "").trim(),
    resource: String(input.resource ?? "").trim(),
    environment: String(input.environment ?? "development").trim().toLowerCase(),
    dataClassification: String(input.dataClassification ?? "internal").trim().toLowerCase(),
    requestedScopes: uniqueStrings(input.requestedScopes),
    existingScopes: uniqueStrings(input.existingScopes),
    justification: String(input.justification ?? "").trim(),
    context: String(input.context ?? "").trim(),
    parentRequestId: input.parentRequestId ? String(input.parentRequestId) : null,
    skipAnalysis: Boolean(input.skipAnalysis),
  };
}

export function evaluatePolicy(rawInput) {
  const input = normalizeRequest(rawInput);
  const tool = TOOL_REGISTRY[input.toolId];
  const reasons = [];
  const controls = [];

  if (!input.actorId || !input.toolId || !input.action || !input.resource) {
    return {
      decision: "deny",
      status: "denied",
      score: 100,
      level: "critical",
      approvalRole: null,
      ttlMinutes: 0,
      reasons: ["Required identity, tool, action or resource information is missing."],
      controls: ["Fail closed on incomplete requests."],
      input,
    };
  }

  if (!tool) {
    return {
      decision: "deny",
      status: "denied",
      score: 100,
      level: "critical",
      approvalRole: null,
      ttlMinutes: 0,
      reasons: ["The requested MCP tool is not registered in the allowlist."],
      controls: ["Unknown tools are denied by default."],
      input,
    };
  }

  let score = tool.baseRisk;
  reasons.push(`Tool baseline contributes ${tool.baseRisk} risk points.`);

  if (!tool.allowedActions.includes(input.action)) {
    return {
      decision: "deny",
      status: "denied",
      score: 100,
      level: "critical",
      approvalRole: null,
      ttlMinutes: 0,
      reasons: [`Action "${input.action}" is outside the registered tool contract.`],
      controls: ["Tool actions must match the registered contract."],
      input,
    };
  }

  const unauthorizedScopes = input.requestedScopes.filter(
    (scope) => !tool.allowedScopes.includes(scope),
  );
  if (unauthorizedScopes.length > 0) {
    return {
      decision: "deny",
      status: "denied",
      score: 100,
      level: "critical",
      approvalRole: null,
      ttlMinutes: 0,
      reasons: [
        `Requested scope is outside the registered contract: ${unauthorizedScopes.join(", ")}.`,
        "Scope expansion must be submitted as a new request and cannot occur during execution.",
      ],
      controls: ["Deny scope creep.", "Require a new policy evaluation for expanded access."],
      input,
    };
  }

  const injectionMatches = INJECTION_PATTERNS.filter((pattern) => pattern.test(input.context));
  if (injectionMatches.length > 0) {
    return {
      decision: "deny",
      status: "denied",
      score: 100,
      level: "critical",
      approvalRole: null,
      ttlMinutes: 0,
      reasons: ["Untrusted context contains an instruction attempting to bypass security controls."],
      controls: [
        "Treat retrieved context as data, not authority.",
        "Sanitize the context and submit a new request.",
      ],
      input,
    };
  }

  const classificationPoints = CLASSIFICATION_POINTS[input.dataClassification] ?? 20;
  score += classificationPoints;
  if (classificationPoints) {
    reasons.push(`Data classification contributes ${classificationPoints} risk points.`);
  }

  if (input.environment === "production") {
    score += 18;
    reasons.push("Production execution contributes 18 risk points.");
  }

  const newScopes = input.requestedScopes.filter((scope) => !input.existingScopes.includes(scope));
  if (newScopes.length > 0) {
    const scopePoints = Math.min(18, newScopes.length * 6);
    score += scopePoints;
    reasons.push(`New permission scope contributes ${scopePoints} risk points.`);
  }

  if (input.justification.length < 20) {
    score += 15;
    reasons.push("Insufficient business justification contributes 15 risk points.");
  }

  if (tool.credentialAccess) {
    score += 12;
    controls.push("Expose metadata only; never return secret values to the AI analyst.");
  }
  if (tool.privilegeChange) {
    score += 12;
    controls.push("Require explicit, time-bound human authorization for privilege changes.");
  }
  if (tool.productionChange) {
    score += 10;
    controls.push("Require a security-lead decision before production execution.");
  }
  if (tool.destructive) {
    score += 14;
    controls.push("Require explicit approval and prevent replay of destructive actions.");
  }

  score = clamp(score, 0, 100);
  const level = levelForScore(score);
  const mustReview =
    score >= 35 ||
    tool.credentialAccess ||
    tool.privilegeChange ||
    tool.productionChange ||
    tool.destructive;

  if (mustReview) {
    controls.push("Human approval is a mandatory workflow state, not an AI recommendation.");
    return {
      decision: "require_human",
      status: "pending_human",
      score,
      level,
      approvalRole: approvalRoleFor(level, tool),
      ttlMinutes: ttlMinutesFor(level),
      reasons,
      controls,
      input,
    };
  }

  controls.push("Auto-approval is limited to registered, low-risk, non-sensitive actions.");
  return {
    decision: "allow",
    status: "auto_approved",
    score,
    level,
    approvalRole: null,
    ttlMinutes: ttlMinutesFor(level),
    reasons,
    controls,
    input,
  };
}

export function reviewerCanApprove(reviewerRole, requiredRole) {
  if (!requiredRole) return true;
  return (ROLE_LEVEL[reviewerRole] ?? -1) >= (REQUIRED_ROLE_LEVEL[requiredRole] ?? 99);
}

export function availableReviewerRoles() {
  return Object.keys(ROLE_LEVEL);
}
