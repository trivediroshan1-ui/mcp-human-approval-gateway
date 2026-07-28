# Workflows

## 1. Registered low-risk action

1. The agent submits a structured request.
2. The gateway validates the registered tool, action and scope.
3. Risk remains below the mandatory-review threshold.
4. Policy records `allow`; the request becomes `auto_approved`.
5. The execution guard checks TTL and replay state.
6. A synthetic execution receipt is generated and the authorization is consumed.

Human involvement is intentionally absent only for registered public,
non-sensitive, non-destructive activity.

## 2. Risk-based human approval

1. The agent requests access to a sensitive or high-impact tool.
2. Policy produces a score, reasons, controls and required reviewer role.
3. The AI analyst produces an advisory summary, uncertainty statements and
   reviewer questions.
4. A human independently reviews the original request, deterministic reasons and
   AI analysis.
5. The human records `approve` or `deny` plus a meaningful rationale.
6. On approval, the gateway creates a short-lived authorization.
7. The guard executes the synthetic action at most once.

The human decision is not a button layered on top of autonomous execution. It is
a mandatory workflow state that the execution path checks.

## 3. Prompt-injected context

1. An external ticket or retrieved document contains instructions such as
   “ignore previous rules” or “bypass approval.”
2. The request context is evaluated as untrusted data.
3. The policy engine detects the security-bypass pattern.
4. The request is denied before human approval or execution.
5. The analyst may explain the denial but cannot override it.
6. A clean, sanitized request must be submitted separately.

Production systems should supplement pattern checks with content provenance,
structured tool schemas, contextual isolation and policy applied at execution
time. Regex detection alone is not a complete prompt-injection defense.

## 4. Scope creep

1. The agent requests a scope not present in the tool’s registered contract.
2. Policy denies the request regardless of the stated justification.
3. The expanded access must be represented as a new registered contract and a
   new request.
4. That request receives its own risk evaluation and approval.

This keeps authorization tied to the exact action and prevents a valid approval
from becoming a wildcard capability.

## 5. Expiry and replay

1. Approval produces an expiration timestamp based on risk:
   - medium: 30 minutes
   - high: 15 minutes
   - critical: 10 minutes
2. Execution after the timestamp changes state to `expired`.
3. Successful execution stores a unique receipt and changes state to `executed`.
4. Any second attempt detects the stored receipt and returns `replay_blocked`.

## 6. Audit verification

1. Each workflow action appends an event with the previous event hash.
2. The verifier reads events in sequence.
3. It recomputes each canonical event hash.
4. A changed payload, actor, timestamp, link or hash identifies the first broken
   sequence.

The chain is tamper-evident within this prototype. Production assurance requires
external anchoring, signatures and protected retention.
