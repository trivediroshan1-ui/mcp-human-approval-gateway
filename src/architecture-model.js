// The data behind the architecture view: the eleven numbered steps, the edges of
// the diagram, and a function that works out which path one request takes and
// where it stops. It is plain JavaScript so the node test runner can check it.
//
// The route is derived from the real policy result (src/demo/policy.js is the
// same code as server/policy.js), never typed in by hand per scenario.

import { evaluatePolicy } from "./demo/policy.js";

export const NODES = {
  agent: { title: "AI agent", sub: "untrusted requester" },
  gateway: { title: "MCP gateway", sub: "validate and hash" },
  registry: { title: "Registry check", sub: "fail closed" },
  policy: { title: "Policy engine", sub: "deterministic rules" },
  analyst: { title: "AI analyst", sub: "advisory only" },
  decision: { title: "Decision", sub: "auto, review or deny" },
  denied: { title: "Denied", sub: "stop and log" },
  gate: { title: "Package gate", sub: "handoff complete?" },
  reviewer: { title: "Human reviewer", sub: "role-qualified" },
  authz: { title: "Authorization", sub: "time-bound, single-use" },
  guard: { title: "Execution guard", sub: "hash, expiry, consume" },
  tool: { title: "Tool (simulated)", sub: "runs at most once" },
};

// from/to are node ids; step is the number shown on the arrow and in the list.
export const EDGES = {
  e1: { from: "agent", to: "gateway", step: 1, label: "request" },
  e2: { from: "gateway", to: "registry", step: 2, label: "validate" },
  e3: { from: "registry", to: "policy", step: 3, label: "listed" },
  e4: { from: "policy", to: "analyst", step: 4, label: "advice", dashed: true },
  e5: { from: "policy", to: "decision", step: 5, label: "scored" },
  e6a: { from: "decision", to: "authz", step: 6, label: "auto" },
  e6b: { from: "decision", to: "gate", step: 6, label: "review" },
  e6c: { from: "decision", to: "denied", step: 6, label: "deny", danger: true },
  e7: { from: "gate", to: "reviewer", step: 7, label: "package" },
  e8: { from: "reviewer", to: "authz", step: 8, label: "approve" },
  e9: { from: "authz", to: "guard", step: 9, label: "token" },
  e10: { from: "guard", to: "tool", step: 10, label: "consume" },
};

export const STEPS = [
  {
    n: 1,
    title: "The agent asks",
    text: "The agent names a tool, an action, its arguments and the scopes it wants.",
    guardrail:
      "Everything in the request, including the justification and context, is untrusted data. Type, size and length are checked first and a bad shape is denied.",
  },
  {
    n: 2,
    title: "The gateway validates and hashes",
    text: "The gateway normalizes the request and takes a SHA-256 of the exact tool, action, arguments, scopes, requester and environment.",
    guardrail: "The approval will be tied to this hash, so changing the request later breaks it.",
  },
  {
    n: 3,
    title: "Registry check",
    text: "The tool, the action and the resource type are looked up in a fixed registry.",
    guardrail:
      "An unknown tool, action or resource type is denied. Nothing is guessed, and names like constructor are not tools.",
  },
  {
    n: 4,
    title: "The AI analyst advises",
    text: "An analyst writes a summary and questions for the reviewer. In this lab it is a rule-based simulation unless a model is configured.",
    guardrail:
      "It sees sanitized metadata only, never secrets, context or arguments, and nothing it says can change the decision or pass the gate.",
  },
  {
    n: 5,
    title: "Policy scores the request",
    text: "Scopes are checked against the contract, context is scanned, and a risk score is computed from fixed rules.",
    guardrail:
      "Same input, same answer. No model is involved. Requester-supplied classification can only raise the score, never lower it.",
  },
  {
    n: 6,
    title: "Route: auto, review or deny",
    text: "Low-risk registered actions are approved automatically. Anything sensitive goes to review. Violations are denied.",
    guardrail: "Auto-approval is limited to low-risk, non-sensitive, registered actions.",
  },
  {
    n: 7,
    title: "Decision-package gate",
    text: "Before a person sees it, the handoff must state the options considered, a recommendation and a confidence.",
    guardrail: "An incomplete handoff is bounced back to the agent. The gate reads the request, not the analyst output.",
  },
  {
    n: 8,
    title: "A qualified human decides",
    text: "A reviewer approves or denies with a written reason.",
    guardrail:
      "The role must meet the requirement, the requester cannot approve itself, and the decision is recorded with the request hash.",
  },
  {
    n: 9,
    title: "Authorization is issued",
    text: "An approval becomes a short-lived, single-use authorization: 10, 15, 30 or 60 minutes depending on risk.",
    guardrail: "It is bound to the request hash and is not a model output or a bearer password.",
  },
  {
    n: 10,
    title: "The execution guard consumes it",
    text: "The guard rechecks state, expiry and the hash, then consumes the authorization in one atomic step.",
    guardrail:
      "A second attempt is a replay and is blocked. An unreadable expiry counts as expired. A changed request revokes the approval.",
  },
  {
    n: 11,
    title: "Every stage is recorded",
    text: "Each stage appends an event to a hash chain: submitted, policy, analysis, gate or human decision, execution or block.",
    guardrail:
      "Each event hash covers the one before it, so edits, gaps and reordering are detected. Without a key or an outside anchor the chain does not stop a writer who rebuilds it.",
  },
];

const STAGE_COPY = {
  invalid_input: "The input was malformed or too large.",
  missing_fields: "Identity, tool, action or resource was missing.",
  unregistered_tool: "The tool is not in the registry.",
  action_not_allowed: "The action is not part of the tool's contract.",
  resource_not_allowed: "The resource type does not belong to this tool.",
  no_scope: "The request named no scope.",
  scope_outside_contract: "A requested scope is outside the tool's contract (scope creep).",
  injection: "The context contained an instruction to bypass controls.",
};

/**
 * Work out the path one request takes.
 *
 * policy      result of evaluatePolicy()
 * skipAnalysis true when the agent handed off without options or a recommendation
 * progress    how far a request that needs a person has got:
 *             complete | waiting_review | human_denied | awaiting_execution | expired
 */
export function planRoute({ policy, skipAnalysis = false, progress = "complete" }) {
  const ticks = [];
  const add = (edge, reverse = false) => ticks.push({ edge, reverse });
  const events = [];
  const lit = (slot, label) => events.push({ slot, label, afterTick: ticks.length });
  let stop = "tool";
  let tone = "ok";
  let summary = "";

  add("e1");
  add("e2");

  if (policy.decision === "deny" && policy.stage === "registry") {
    lit(0, "request.submitted");
    lit(1, "policy.deny");
    lit(2, "ai.analysis");
    return finish("registry", "blocked", `Stops at the registry check. ${STAGE_COPY[policy.denyCode] ?? "The request failed a registry check."} Denied and logged.`);
  }

  add("e3");
  add("e4");
  add("e4", true);
  add("e5");

  lit(0, "request.submitted");
  lit(1, `policy.${policy.decision}`);
  lit(2, "ai.analysis");

  if (policy.decision === "deny") {
    add("e6c");
    return finish("denied", "blocked", `Stops at the policy decision. ${STAGE_COPY[policy.denyCode] ?? "A policy rule was violated."} Denied and logged, and the analyst cannot override it.`);
  }

  if (policy.decision === "allow") {
    add("e6a");
    if (progress === "awaiting_execution") {
      return finish("authz", "waiting", "Auto-approved. A 60 minute single-use authorization is waiting to be used.");
    }
    add("e9");
    if (progress === "expired") {
      lit(4, "authorization.expired");
      return finish("guard", "blocked", "The authorization ran out before it was used, so the guard refused it.");
    }
    add("e10");
    lit(4, "action.executed");
    return finish("tool", "ok", "Auto-approved, executed once by the guard and logged. No human was needed because the action is low-risk and registered.");
  }

  // require_human
  add("e6b");
  if (skipAnalysis) {
    lit(3, "decision_package.rejected");
    return finish("gate", "blocked", "Stops at the decision-package gate. The agent gave no options, recommendation or confidence, so a person never sees it.");
  }
  add("e7");
  if (progress === "waiting_review") {
    return finish("reviewer", "waiting", `Waiting for a ${policy.approvalRole}. Nothing can run until a qualified person decides.`);
  }
  if (progress === "human_denied") {
    lit(3, "human.deny");
    return finish("reviewer", "blocked", "A reviewer denied the request. It cannot be executed.");
  }
  add("e8");
  lit(3, "human.approve");
  if (progress === "awaiting_execution") {
    return finish("authz", "waiting", "Approved. A short-lived single-use authorization is waiting to be used.");
  }
  add("e9");
  if (progress === "expired") {
    lit(4, "authorization.expired");
    return finish("guard", "blocked", "The authorization ran out before it was used, so the guard refused it.");
  }
  add("e10");
  lit(4, "action.executed");
  return finish(
    "tool",
    "ok",
    `Reviewed by a ${policy.approvalRole}, authorized for ${policy.ttlMinutes} minutes, executed once by the guard and logged.`,
  );

  function finish(stopNode, toneValue, text) {
    stop = stopNode;
    tone = toneValue;
    summary = text;
    ticks.push({ audit: true });
    return { ticks, events, stop, tone, summary, edges: [...new Set(ticks.filter((t) => t.edge).map((t) => t.edge))] };
  }
}

/** Route for a scenario from the catalog, assuming a qualified reviewer approves. */
export function planScenario(scenario) {
  const policy = evaluatePolicy(scenario.request);
  return planRoute({ policy, skipAnalysis: Boolean(scenario.request.skipAnalysis) });
}

/** Route for a request that is already in the queue, from its stored state. */
export function planRequest(request) {
  const policy = evaluatePolicy(request);
  let progress = "complete";
  if (policy.decision !== "deny") {
    const lastDecision = request.decisions?.[0];
    if (request.status === "pending_human") progress = "waiting_review";
    else if (request.status === "denied" && lastDecision?.decision === "deny") progress = "human_denied";
    else if (["approved", "auto_approved"].includes(request.status)) progress = "awaiting_execution";
    else if (request.status === "expired") progress = "expired";
  }
  return planRoute({
    policy,
    skipAnalysis: request.status === "gate_rejected" || Boolean(request.skipAnalysis),
    progress,
  });
}

export const EVENT_SLOTS = ["request.submitted", "policy", "ai.analysis", "human or gate", "executed"];
