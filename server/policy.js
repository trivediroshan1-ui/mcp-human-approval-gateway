import { TOOL_REGISTRY } from "./scenarios.js";

// Bump this whenever scoring, thresholds or checks change. It is part of the
// request hash, so an approval given under one policy version is not valid
// evidence for a request evaluated under another.
export const POLICY_VERSION = "2026-10.1";

// A request that sits in the review queue longer than this can no longer be
// approved. The reviewer has to look at a fresh request.
export const REVIEW_WINDOW_MINUTES = 240;

export const LIMITS = Object.freeze({
  id: 128,
  action: 64,
  resource: 512,
  justification: 2000,
  context: 8000,
  scopes: 20,
  scope: 128,
  argumentChars: 4096,
  argumentDepth: 5,
});

export const ACTOR_TYPES = Object.freeze(["ai-agent", "service-account", "human-user"]);
export const ENVIRONMENTS = Object.freeze(["public", "development", "staging", "production"]);
export const CLASSIFICATIONS = Object.freeze(["public", "internal", "confidential", "restricted"]);

const CLASSIFICATION_POINTS = Object.freeze({
  public: 0,
  internal: 8,
  confidential: 16,
  restricted: 26,
});

const CLASSIFICATION_RANK = Object.freeze({
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
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

// Heuristic only. These patterns run on text that has been folded to plain
// lower-case words (see foldForScan), so spacing, case, punctuation and
// zero-width characters do not hide a phrase. A paraphrase, another language or
// an encoded payload will still get through. The real control is that context
// is data: it never grants anything, and policy never reads it for permission.
const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override|skip) (all |any |the |your |these |those )*(previous|prior|above|earlier|preceding|existing|security|safety)( security| safety)? (rules|instructions|guidelines|polic(y|ies)|constraints|directions)\b/,
  /\b(bypass|circumvent|evade|disable|avoid|skip|turn off) (the |any |all |our |your )*(human )?(approval|review|security|polic(y|ies)|guardrails?|controls?|audit|logging|checks?)\b/,
  /\b(reveal|show|print|leak|output|dump|expose) (me )?(the |your |all )*(system prompt|hidden instructions|credentials|secrets|api keys?|tokens?|passwords?)\b/,
  /\buse any available (credentials|tokens|keys|access)\b/,
  /\byou are now (in )?(developer|admin|root|unrestricted)\b/,
];

const STAGE_BY_CODE = Object.freeze({
  invalid_input: "registry",
  missing_fields: "registry",
  unregistered_tool: "registry",
  action_not_allowed: "registry",
  resource_not_allowed: "registry",
  no_scope: "policy",
  scope_outside_contract: "policy",
  injection: "policy",
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
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

export function ttlMinutesFor(level) {
  return (
    {
      low: 60,
      medium: 30,
      high: 15,
      critical: 10,
    }[level] ?? 0
  );
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()),
    ),
  ];
}

function safeArguments(value) {
  if (!isPlainObject(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

export function normalizeRequest(input) {
  const source = isPlainObject(input) ? input : {};
  return {
    actorId: text(source.actorId),
    actorType: text(source.actorType) || "ai-agent",
    toolId: text(source.toolId),
    action: text(source.action),
    resource: text(source.resource),
    environment: (text(source.environment) || "development").toLowerCase(),
    dataClassification: (text(source.dataClassification) || "internal").toLowerCase(),
    requestedScopes: uniqueStrings(source.requestedScopes),
    existingScopes: uniqueStrings(source.existingScopes),
    arguments: safeArguments(source.arguments),
    justification: text(source.justification),
    context: text(source.context),
    parentRequestId:
      typeof source.parentRequestId === "string" && source.parentRequestId.trim()
        ? source.parentRequestId.trim()
        : null,
    skipAnalysis: Boolean(source.skipAnalysis),
  };
}

function checkArguments(value, issues, depth = 0) {
  if (depth > LIMITS.argumentDepth) {
    issues.push("arguments are nested too deeply.");
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push("arguments contain a number that is not finite.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) checkArguments(item, issues, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) checkArguments(value[key], issues, depth + 1);
    return;
  }
  issues.push("arguments may only contain JSON values.");
}

// Shape and size checks on the raw input, before anything is trusted. Anything
// listed here makes the request a fail-closed deny.
export function validateRawRequest(raw) {
  if (!isPlainObject(raw)) return ["The request must be a JSON object."];
  const issues = [];

  const stringFields = [
    ["actorId", LIMITS.id],
    ["actorType", LIMITS.id],
    ["toolId", LIMITS.id],
    ["action", LIMITS.action],
    ["resource", LIMITS.resource],
    ["environment", LIMITS.id],
    ["dataClassification", LIMITS.id],
    ["justification", LIMITS.justification],
    ["context", LIMITS.context],
    ["parentRequestId", LIMITS.id],
  ];
  for (const [field, max] of stringFields) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      issues.push(`${field} must be a string.`);
    } else if (value.length > max) {
      issues.push(`${field} is longer than ${max} characters.`);
    } else if (!["justification", "context"].includes(field) && hasControlCharacters(value)) {
      issues.push(`${field} contains control characters.`);
    }
  }

  if (raw.environment === undefined || raw.environment === null || text(raw.environment) === "") {
    issues.push("environment is required.");
  } else if (
    typeof raw.environment === "string" &&
    !ENVIRONMENTS.includes(raw.environment.trim().toLowerCase())
  ) {
    issues.push(`environment must be one of ${ENVIRONMENTS.join(", ")}.`);
  }
  if (
    typeof raw.dataClassification === "string" &&
    raw.dataClassification.trim() &&
    !CLASSIFICATIONS.includes(raw.dataClassification.trim().toLowerCase())
  ) {
    issues.push(`dataClassification must be one of ${CLASSIFICATIONS.join(", ")}.`);
  }
  if (
    typeof raw.actorType === "string" &&
    raw.actorType.trim() &&
    !ACTOR_TYPES.includes(raw.actorType.trim())
  ) {
    issues.push(`actorType must be one of ${ACTOR_TYPES.join(", ")}.`);
  }

  for (const field of ["requestedScopes", "existingScopes"]) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      issues.push(`${field} must be an array of strings.`);
      continue;
    }
    if (value.length > LIMITS.scopes) issues.push(`${field} has more than ${LIMITS.scopes} entries.`);
    for (const scope of value) {
      if (typeof scope !== "string") {
        issues.push(`${field} may only contain strings.`);
        break;
      }
      if (scope.length > LIMITS.scope || hasControlCharacters(scope)) {
        issues.push(`${field} contains an invalid scope string.`);
        break;
      }
    }
  }

  if (raw.arguments !== undefined && raw.arguments !== null) {
    if (!isPlainObject(raw.arguments)) {
      issues.push("arguments must be a JSON object.");
    } else {
      checkArguments(raw.arguments, issues);
      try {
        if (JSON.stringify(raw.arguments).length > LIMITS.argumentChars) {
          issues.push(`arguments are larger than ${LIMITS.argumentChars} characters.`);
        }
      } catch {
        issues.push("arguments could not be serialized.");
      }
    }
  }
  return issues;
}

// Fold text so that simple evasions do not hide a phrase: compatibility forms
// (full-width letters and the like), zero-width and other format characters,
// case, punctuation and runs of whitespace.
export function foldForScan(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function collectStrings(value, out, depth = 0) {
  if (depth > LIMITS.argumentDepth + 1) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out, depth + 1));
  else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      out.push(key);
      collectStrings(value[key], out, depth + 1);
    }
  }
  return out;
}

export function detectInjection(input) {
  const texts = [input.context, input.justification, ...collectStrings(input.arguments, [])];
  return texts.some((item) => {
    const folded = foldForScan(item);
    return INJECTION_PATTERNS.some((pattern) => pattern.test(folded));
  });
}

// The exact fields an approval is bound to. Its hash goes into the request
// record, the human decision and the audit trail, and the execution guard
// recomputes it before it consumes the authorization.
export function bindingPayload(input) {
  return {
    policyVersion: POLICY_VERSION,
    actorId: input.actorId,
    actorType: input.actorType,
    toolId: input.toolId,
    action: input.action,
    resource: input.resource,
    environment: input.environment,
    dataClassification: input.dataClassification,
    requestedScopes: [...input.requestedScopes].sort(),
    arguments: input.arguments ?? {},
    justification: input.justification,
    context: input.context,
  };
}

function denial(input, code, reasons, controls) {
  return {
    decision: "deny",
    status: "denied",
    score: 100,
    level: "critical",
    approvalRole: null,
    ttlMinutes: 0,
    denyCode: code,
    stage: STAGE_BY_CODE[code] ?? "policy",
    policyVersion: POLICY_VERSION,
    reasons,
    controls,
    input,
  };
}

export function evaluatePolicy(rawInput) {
  const input = normalizeRequest(rawInput);

  const issues = validateRawRequest(rawInput);
  if (issues.length > 0) {
    return denial(
      input,
      "invalid_input",
      issues.map((issue) => `Invalid request: ${issue}`),
      ["Malformed or oversized input is denied before any lookup."],
    );
  }

  const reasons = [];
  const controls = [];

  if (!input.actorId || !input.toolId || !input.action || !input.resource) {
    return denial(
      input,
      "missing_fields",
      ["Required identity, tool, action or resource information is missing."],
      ["Fail closed on incomplete requests."],
    );
  }

  // Own-property lookup: "constructor" and "__proto__" are not tools.
  const tool = Object.hasOwn(TOOL_REGISTRY, input.toolId) ? TOOL_REGISTRY[input.toolId] : null;
  if (!tool) {
    return denial(
      input,
      "unregistered_tool",
      ["The requested MCP tool is not registered in the allowlist."],
      ["Unknown tools are denied by default."],
    );
  }

  if (!tool.allowedActions.includes(input.action)) {
    return denial(
      input,
      "action_not_allowed",
      [`Action "${input.action}" is outside the registered tool contract.`],
      ["Tool actions must match the registered contract."],
    );
  }

  const scheme = input.resource.includes("://") ? input.resource.split("://")[0] : "";
  if (!tool.allowedResourceSchemes.includes(scheme)) {
    return denial(
      input,
      "resource_not_allowed",
      [
        `Resource type "${scheme || "none"}" is outside the registered tool contract (${tool.allowedResourceSchemes.join(", ")}).`,
      ],
      ["A tool may only touch the resource types it is registered for."],
    );
  }

  if (input.requestedScopes.length === 0) {
    return denial(
      input,
      "no_scope",
      ["The request does not name any scope."],
      ["Every request must state the exact scope it needs."],
    );
  }

  const unauthorizedScopes = input.requestedScopes.filter(
    (scope) => !tool.allowedScopes.includes(scope),
  );
  if (unauthorizedScopes.length > 0) {
    return denial(
      input,
      "scope_outside_contract",
      [
        `Requested scope is outside the registered contract: ${unauthorizedScopes.join(", ")}.`,
        "Scope expansion must be submitted as a new request and cannot occur during execution.",
      ],
      ["Deny scope creep.", "Require a new policy evaluation for expanded access."],
    );
  }

  if (detectInjection(input)) {
    return denial(
      input,
      "injection",
      ["Untrusted context contains an instruction attempting to bypass security controls."],
      [
        "Treat retrieved context as data, not authority.",
        "Sanitize the context and submit a new request.",
      ],
    );
  }

  let score = tool.baseRisk;
  reasons.push(`Tool baseline contributes ${tool.baseRisk} risk points.`);

  // The requester states a classification, but it can only raise the score.
  // The registry knows how sensitive the tool is, and that is the floor.
  const requestedClass = CLASSIFICATIONS.includes(input.dataClassification)
    ? input.dataClassification
    : "restricted";
  const effectiveClass =
    CLASSIFICATION_RANK[tool.sensitivity] > CLASSIFICATION_RANK[requestedClass]
      ? tool.sensitivity
      : requestedClass;
  const classificationPoints = CLASSIFICATION_POINTS[effectiveClass];
  score += classificationPoints;
  if (effectiveClass !== requestedClass) {
    reasons.push(
      `Data classification was raised from ${requestedClass} to ${effectiveClass} by the tool registry.`,
    );
  }
  if (classificationPoints) {
    reasons.push(`Data classification contributes ${classificationPoints} risk points.`);
  }

  if (input.environment === "production" || tool.productionChange) {
    score += 18;
    reasons.push("Production execution contributes 18 risk points.");
  }

  // existingScopes is whatever the requester says it already holds. Nothing
  // here can verify that, so it never lowers the score: every requested scope
  // counts as new.
  const scopePoints = Math.min(18, input.requestedScopes.length * 6);
  score += scopePoints;
  reasons.push(
    `Requested scope contributes ${scopePoints} risk points (self-reported existing scopes are not verified).`,
  );

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
      denyCode: null,
      stage: "policy",
      policyVersion: POLICY_VERSION,
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
    denyCode: null,
    stage: "policy",
    policyVersion: POLICY_VERSION,
    reasons,
    controls,
    input,
  };
}

export function reviewerCanApprove(reviewerRole, requiredRole) {
  if (!requiredRole) return true;
  const reviewerLevel = Object.hasOwn(ROLE_LEVEL, reviewerRole) ? ROLE_LEVEL[reviewerRole] : -1;
  const requiredLevel = Object.hasOwn(REQUIRED_ROLE_LEVEL, requiredRole)
    ? REQUIRED_ROLE_LEVEL[requiredRole]
    : 99;
  return reviewerLevel >= requiredLevel;
}

// Any decision, including a denial, needs a role that can review something.
export function reviewerCanDecide(reviewerRole) {
  return Object.hasOwn(ROLE_LEVEL, reviewerRole) && ROLE_LEVEL[reviewerRole] >= 1;
}

export function availableReviewerRoles() {
  return Object.keys(ROLE_LEVEL);
}
