// Turns a stored request into the outcome a visitor should see.
// The store keeps one "denied" status for three different reasons, so this
// tells them apart: policy refused it, a person refused it, or the integrity
// check revoked it. Display only: nothing here changes a decision.

const BASE_LABELS = {
  auto_approved: "Auto-approved",
  pending_human: "Awaiting human",
  approved: "Human approved",
  denied: "Denied",
  executing: "Executing",
  executed: "Executed",
  failed: "Failed",
  unknown_outcome: "Unknown outcome",
  expired: "Expired",
  gate_rejected: "Gate rejected",
};

function lastDecision(request) {
  const list = Array.isArray(request?.decisions) ? request.decisions : [];
  return list.length ? list[list.length - 1] : null;
}

export function outcomeOf(request) {
  const status = request?.status;
  if (status === "denied") {
    if (request.policyDecision === "deny") return { key: "policy_blocked", label: "Policy blocked" };
    if (lastDecision(request)?.decision === "deny") return { key: "human_denied", label: "Human denied" };
    return { key: "integrity_denied", label: "Denied: integrity check" };
  }
  return { key: status, label: BASE_LABELS[status] ?? String(status ?? "") };
}

export function metricsOf(requests) {
  const list = Array.isArray(requests) ? requests : [];
  const count = (key) => list.filter((request) => outcomeOf(request).key === key).length;
  return {
    total: list.length,
    pending: count("pending_human"),
    policyBlocked: count("policy_blocked"),
    humanDenied: count("human_denied"),
    executed: count("executed"),
  };
}
