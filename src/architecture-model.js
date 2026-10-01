// The data behind the architecture view: the fifteen numbered steps, the edges of
// the diagram, and a function that works out which path one request takes and
// where it stops. It is plain JavaScript so the node test runner can check it.
//
// The route is derived from the real policy result (src/demo/policy.js is the
// same code as server/policy.js), never typed in by hand per scenario.

import { evaluatePolicy } from "./demo/policy.js";
import { EXECUTION_TIMEOUT_MINUTES } from "./demo/service.js";

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
  guard: { title: "Execution guard", sub: "reserve and confirm" },
  tool: { title: "Tool (simulated)", sub: "one dispatch per key" },
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
  e10: { from: "guard", to: "tool", step: 11, label: "dispatch" },
  e11: { from: "tool", to: "guard", step: 12, label: "confirm" },
  e12: { from: "tool", to: "reviewer", step: 14, label: "reconcile" },
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
    title: "Reserve: the guard consumes the grant",
    text: "The guard rechecks state, expiry, the hash and the stored record, then in one atomic step consumes the authorization, sets the state to executing and issues the idempotency key.",
    guardrail:
      "Only one caller can win the reserve. A second attempt is a replay and is blocked. An unreadable expiry counts as expired. A changed request revokes the approval.",
  },
  {
    n: 11,
    title: "Dispatch to the tool with the key",
    text: "The gateway calls the tool and passes the key. A tool that honours the key does the work once for that key.",
    guardrail:
      "The key is derived from the execution id and a secret held by the gateway, and only a digest of it is written to the audit log.",
  },
  {
    n: 12,
    title: "Confirm: executed and a result digest",
    text: "The outcome is stored as executed with a SHA-256 digest of the result, or as failed.",
    guardrail:
      "The confirm call needs the dispatch key and cannot rewrite an outcome that is already stored. In this lab the confirm is trusted, a real deployment authenticates it.",
  },
  {
    n: 13,
    title: "Lost response: retry returns the stored result",
    text: "If the reply never reached the agent, it asks again with the same approval id and the same key. The gateway answers from its record, marked replayed.",
    guardrail:
      "Same key and same hash return the stored result and never a second dispatch. A different key is refused as replay_blocked and a changed hash as binding_mismatch.",
  },
  {
    n: 14,
    title: `No confirm within ${EXECUTION_TIMEOUT_MINUTES} minutes: unknown outcome`,
    text: "If the tool never confirms, the record becomes unknown_outcome and waits for a person to check the downstream system and reconcile it with a reason.",
    guardrail:
      "It is never retried automatically, because a real tool gives no way to know whether it ran. The reviewer cannot be the requester, and a late confirm is refused.",
  },
  {
    n: 15,
    title: "Every stage is recorded",
    text: "Each stage appends an event to a hash chain: submitted, policy, analysis, gate or human decision, reserved, confirmed, retry served, unknown outcome or reconciled.",
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
 *             | executing | unknown_outcome | failed
 * variant     "lost_response" (reply dropped, agent retries with the same key)
 *             or "no_confirm" (the tool never confirms)
 *
 * A tick is one beat of the animation. It has an edge (the token moves along it)
 * or it is a hold (the token stays and something happens at a node). The route
 * also reports `dispatches`, the number of times the tool was called, which is
 * what the counter on the tool node shows.
 */
export function planRoute({ policy, skipAnalysis = false, progress = "complete", variant = null }) {
  const ticks = [];
  const add = (edge, reverse = false) => ticks.push({ edge, reverse });
  const events = [];
  const lit = (slot, label) => events.push({ slot, label, afterTick: ticks.length });
  const hold = (node, step, note, pill) => ticks.push({ hold: true, node, step, note, pill });

  // Everything after the authorization token reaches the guard.
  function runExecution() {
    hold("guard", 10, "Reserve: the grant is consumed, the state is executing and an idempotency key is issued.");
    lit(4, "action.reserved");
    add("e10");
    if (progress === "executing") {
      return finish("tool", "waiting", "Reserved and dispatched, but no confirm has arrived yet. A retry with the same key returns this state, not a second dispatch.");
    }
    if (progress === "unknown_outcome" || variant === "no_confirm") {
      hold("tool", 14, `No confirm within ${EXECUTION_TIMEOUT_MINUTES} minutes, so the state becomes unknown_outcome. Nothing retries it.`, "no confirm");
      lit(4, "action.unknown_outcome");
      add("e12");
      return finish(
        "reviewer",
        "waiting",
        `No confirm within ${EXECUTION_TIMEOUT_MINUTES} minutes, so the outcome is unknown. It is never retried automatically. It waits for a reviewer, who is not the requester, to check the downstream system and reconcile it with a reason.`,
        "Unknown outcome",
      );
    }
    add("e11");
    if (progress === "failed") {
      lit(4, "action.failed");
      return finish("tool", "blocked", "The tool reported a failure. The failure is recorded and nothing is retried on its own.");
    }
    lit(4, "action.confirmed");
    if (variant === "lost_response") {
      hold("guard", 13, "The reply to the agent is dropped. The tool has already run once and the result is stored.", "reply lost");
      ticks.push({ edge: "e1", jump: true, step: 13, note: "The agent retries with the same approval id and the same idempotency key.", pill: "same key" });
      ticks.push({ edge: "e1", reverse: true, step: 13, note: "The gateway returns the stored result, marked replayed. The tool is not called again.", pill: "replayed" });
      lit(4, "action.retry_served");
      return finish(
        "agent",
        "ok",
        "The reply was lost after the tool ran. The agent retried with the same approval id and key and got the stored result marked replayed. The tool shows one dispatch.",
        "Retry served from the record",
      );
    }
    return null;
  }
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
    const early = runExecution();
    if (early) return early;
    return finish("tool", "ok", "Auto-approved, reserved, dispatched once, confirmed and logged. No human was needed because the action is low-risk and registered.");
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
  const early = runExecution();
  if (early) return early;
  return finish(
    "tool",
    "ok",
    `Reviewed by a ${policy.approvalRole}, authorized for ${policy.ttlMinutes} minutes, reserved, dispatched once, confirmed and logged.`,
  );

  function finish(stopNode, toneValue, text, headline = null) {
    stop = stopNode;
    tone = toneValue;
    summary = text;
    ticks.push({ audit: true });
    return {
      ticks,
      events,
      stop,
      tone,
      summary,
      headline,
      dispatches: ticks.filter((t) => t.edge === "e10").length,
      edges: [...new Set(ticks.filter((t) => t.edge).map((t) => t.edge))],
    };
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
    else if (["executing", "unknown_outcome", "failed"].includes(request.status)) progress = request.status;
  }
  return planRoute({
    policy,
    skipAnalysis: request.status === "gate_rejected" || Boolean(request.skipAnalysis),
    progress,
  });
}

/** Extra paths in the selector that are not catalog scenarios. */
export const EXTRA_PATHS = [
  { id: "path:lost-response", title: "Lost response, then retry (same key)", variant: "lost_response" },
  { id: "path:no-confirm", title: `No confirm in ${EXECUTION_TIMEOUT_MINUTES} minutes (unknown outcome)`, variant: "no_confirm" },
];

/** Route for one of the extra paths, built on a low-risk auto-approved request. */
export function planExtra(id, scenarios) {
  const path = EXTRA_PATHS.find((item) => item.id === id);
  const base = scenarios.find((item) => item.id === "public-research") ?? scenarios.find((item) => evaluatePolicy(item.request).decision === "allow");
  if (!path || !base) return null;
  return planRoute({ policy: evaluatePolicy(base.request), variant: path.variant });
}

export const EVENT_SLOTS = ["request.submitted", "policy", "ai.analysis", "human or gate", "action.*"];
