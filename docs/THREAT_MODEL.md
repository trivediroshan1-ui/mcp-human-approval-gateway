# Threat model

## Scope

The protected operation is a tool action requested by an AI agent. Assets
include authorization integrity, reviewer identity, tool scope, sensitive
metadata, execution receipts and audit evidence.

Potentially hostile inputs include the agent, retrieved content, request
justification and external AI output. The deterministic policy engine and
execution guard are trusted components for this prototype.

## Security goals

1. No unregistered tool, action or scope reaches execution.
2. High-impact actions cannot execute without a qualified human decision.
3. AI output cannot grant access or alter policy state.
4. Approvals are narrowly scoped, short-lived and single-use.
5. Secret values are never provided to the AI analyst.
6. Material workflow changes are attributable and tamper-evident.
7. The public prototype contains synthetic data only.

## STRIDE analysis

| Threat | Example | Implemented control | Residual risk |
|---|---|---|---|
| Spoofing | Agent or reviewer claims another identity | Explicit actor and reviewer fields, role check, requester cannot approve itself, execution can require the requester's identity | Identities and roles are caller-supplied strings. There is no authentication |
| Tampering | Request or audit event is modified, or an approved request is changed before it runs | Transactional state changes, optimistic versioning, approval bound to a request hash that the guard recomputes, SHA-256 audit chain with optional HMAC | Without a key, a database writer can rebuild the chain. Removed tail events need an external anchor. The browser demo has no key |
| Repudiation | Reviewer denies approving an action | Decision identity, role, rationale and timestamp are recorded | No digital signatures or non-repudiation service |
| Information disclosure | AI receives a secret or excessive context | Metadata-only secret tool, sanitized external-AI prompt, restrictive schema | A real connector could still return excessive data unless separately enforced |
| Denial of service | Approval queue or API is flooded | 64 KB body limit, field length limits, write-rate limit with pruned buckets, review window | Limiter is in memory, single-node and keyed by address. Reset is unauthenticated unless `ALLOW_RESET=false` |
| Cross-site request | A web page posts to a locally running gateway | Exact `application/json` media type (forces a preflight that is never granted) and an Origin check on writes | None for browsers. Non-browser clients are not affected by either |
| Elevation of privilege | Agent adds wildcard or production scope | Registered tool contract, scope-creep denial, role-qualified approval | Registry governance and reviewer-role assignment are not implemented |

## Agentic and MCP risk alignment

| Risk pattern | Design response |
|---|---|
| Goal or context hijacking | Retrieved context has no authority; a folded phrase scan denies obvious bypass attempts in context, justification and arguments. The scan is a heuristic and misses paraphrase |
| Tool misuse | Tool, action, resource-type and scope allowlists are checked before workflow creation. Tool sensitivity is a floor the requester cannot lower |
| Identity and privilege abuse | Privilege changes are critical and require a security lead |
| Privilege escalation through scope creep | Out-of-contract scopes fail closed and require a new request |
| Context injection and over-sharing | External AI receives a fixed list of fields without context, arguments or resource path, with credential-shaped text redacted from the justification. Secret values have no schema field. Redaction is best effort |
| Excessive autonomy | Human approval is mandatory for medium and higher risk or impact flags |
| Unsafe recovery or retry | Execution authorizations are single-use and replay is blocked |

These are engineering alignments, not claims of OWASP or NIST certification.

## Abuse cases

### Compromised agent asks for `*:admin`

Expected result: deny. The wildcard scope is absent from the registered tool
contract.

### Malicious ticket says to bypass approval

Expected result: deny. Context is treated as untrusted data. The AI analyst
cannot change the outcome.

### Resource owner approves a production IAM grant

Expected result: reject the decision. A security lead is required.

### Approved action is retried

Expected result: `replay_blocked`. The execution receipt proves the
authorization has been consumed.

### Response is lost after the tool ran

Expected result: the retry with the same approval and key returns the stored
outcome and the tool is not called again. A retry with a new key is refused.
Tests prove one downstream effect under duplicate, concurrent and
lost-response calls.

### Duplicate dispatch from concurrent callers

Expected result: one compare-and-swap reserves the grant. Every other caller
gets the recorded state or `replay_blocked`.

### Forged confirm

An attacker who can reach `confirm` could record a false outcome. The dispatch
key is derived with a per-service secret, never appears in the public record or
audit payloads, and is required by `confirm`. The lab trusts the caller that
holds it. A real deployment needs authentication on that call.

### Execution is stuck in `executing`

Expected result: after five minutes the state becomes `unknown_outcome`. A late
confirm is refused. Only a reviewer other than the requester can reconcile, with
a reason, and the event is audited. There is no automatic retry because a
side-effecting tool gives no way to learn whether it ran.

### Database audit payload is edited

Expected result: hash-chain verification returns `valid: false` and the first
failing sequence.

### Audit events are removed from the end of the log

Expected result with no anchor: the chain still verifies, because nothing after
the cut refers back. With a saved anchor: `valid: false`, reason
`anchor_mismatch`.

### Attacker with database write access rebuilds the chain

Expected result without `AUDIT_HMAC_KEY`: it verifies. That is a limit, not a
bug. With the key: `signature_invalid`.

### Approved request is edited in the database

Expected result: the guard recomputes the request hash, sees the difference and
revokes the authorization (`integrity_failed`).

### Request is flipped to approved in the database with no human decision

Expected result: execution is refused (`integrity_failed`) because no stored
human approval matches the request. Before this was checked, the call executed
and the audit chain still verified, since nothing had been removed from it. A
writer who can also insert a matching decision row and rebuild an unkeyed chain
is still a limit (see the previous cases).

### Reviewer name that does not exist

Expected result today: accepted. Reviewer identity is asserted, not proven, so a
made-up name with the right role can approve and the audit log records that name.
Authenticating reviewers is out of scope here and is the biggest open limit.

### Many approvals in a row

Expected result: nothing slows or questions the reviewer. 40 production deploys
approved back to back with the same reason were all accepted in under a second.
Only the request rate limit applies. A gateway alone does not address approval
fatigue.

### Agent claims a public classification for a private tool

Expected result: ignored. The registry sensitivity is the floor.

## Out of scope

- Authenticating humans or agents
- Real MCP transport negotiation
- Real tool execution
- Credential material
- Multi-party or quorum approval
- Distributed locking
- Hardware-backed signing
- SIEM ingestion and retention
- Complete prompt-injection detection
- Formal policy verification

These gaps are deliberate and are listed so the prototype is not mistaken for a
production security product.

## Binding rules (what counts as "the same request")

The request hash covers: policy version, actor, tool, action, resource,
environment, data classification, requested scopes, arguments, justification and
context. Before hashing: top-level text is trimmed; `environment` and
`dataClassification` are lowercased; `requestedScopes` are de-duplicated and
sorted; `arguments` are compared exactly (case, spacing and key values count; key
order does not); `existingScopes` are self-reported and not part of the hash.
A trailing space on `justification` therefore does not change the hash, while a
changed value inside `arguments` does. Pinned by `tests/open-findings.test.js`.

## Reviewer identity

Reviewer names are typed in, not proven. `REVIEWER_ALLOWLIST` limits which typed
names and roles count, which stops casual misuse but is not authentication.
Put a real identity check in front of the review route for anything beyond a lab.
