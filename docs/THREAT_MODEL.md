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
| Spoofing | Agent or reviewer claims another identity | Explicit actor and reviewer fields; role check | Prototype has no enterprise authentication or identity proofing |
| Tampering | Request or audit event is modified | Transactional state changes, optimistic versioning, SHA-256 audit chain | Database administrator can rewrite the database and recompute hashes |
| Repudiation | Reviewer denies approving an action | Decision identity, role, rationale and timestamp are recorded | No digital signatures or non-repudiation service |
| Information disclosure | AI receives a secret or excessive context | Metadata-only secret tool, sanitized external-AI prompt, restrictive schema | A real connector could still return excessive data unless separately enforced |
| Denial of service | Approval queue or API is flooded | Request-size limit and simple write-rate limit | In-memory limiter is single-node and not identity-aware |
| Elevation of privilege | Agent adds wildcard or production scope | Registered tool contract, scope-creep denial, role-qualified approval | Registry governance and reviewer-role assignment are not implemented |

## Agentic and MCP risk alignment

| Risk pattern | Design response |
|---|---|
| Goal or context hijacking | Retrieved context has no authority; explicit bypass phrases are denied |
| Tool misuse | Tool, action and scope allowlists are checked before workflow creation |
| Identity and privilege abuse | Privilege changes are critical and require a security lead |
| Privilege escalation through scope creep | Out-of-contract scopes fail closed and require a new request |
| Context injection and over-sharing | External AI receives sanitized metadata; secret values have no schema field |
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

### Database audit payload is edited

Expected result: hash-chain verification returns `valid: false` and the first
failing sequence.

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
