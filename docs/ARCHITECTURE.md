# Architecture

## Objective

Place an enforceable authorization boundary between an AI agent and an MCP-style
tool. The gateway must remain secure even when the agent, retrieved context or
AI analysis is incorrect or hostile.

## Trust boundaries

```mermaid
flowchart LR
    A[AI agent<br/>untrusted requester] -->|structured request| B[Gateway API]
    C[Retrieved context<br/>untrusted data] --> A
    B --> R[Registry check<br/>fail closed]
    R --> D[Deterministic policy engine]
    D -. sanitized metadata .-> E[Advisory AI analyst<br/>cannot change the decision]
    D -->|allow / review / deny| F[Workflow state]
    E -.->|summary + questions only| F
    F -->|high-impact request| PG[Decision-package gate]
    PG --> G[Qualified human reviewer<br/>not the requester]
    G -->|approve / deny + reason| F
    F --> H[Single-use execution guard<br/>checks the request hash]
    H -->|synthetic action only| I[Registered tool]
    B --> J[(SQLite state)]
    D --> J
    G --> J
    H --> J
    J --> K[SHA-256 audit chain verifier]
```

The critical boundary is between the execution guard and the tool. A model
response is never an authorization token. The same flow, with the numbered steps
and one guardrail each, is animated in the Architecture section of the app and
written out in [Workflows](WORKFLOWS.md).

## MCP layer

`server/mcp.js` is the protocol core. It takes one parsed JSON-RPC message and
returns a reply. `server/mcp-http.js` (POST `/mcp`) and `server/mcp-stdio.js`
(`npm run mcp:stdio`) are thin transports around it. The core calls the same
`service.submit`, `service.execute` and audit store as the REST API, so MCP
adds no second decision path. Revision 2026-07-28 is implemented, with
2025-11-25 on the same endpoint. Details and the list of what is missing are in
[MCP server](MCP.md).

```mermaid
sequenceDiagram
    participant C as MCP client (agent)
    participant M as MCP layer
    participant G as Gateway service
    participant H as Human reviewer (web UI)
    C->>M: tools/call deploy.production
    M->>G: submit (actor = configured agent id)
    G-->>M: pending_human
    M-->>C: pending_approval + approvalId (NOT EXECUTED)
    H->>G: approve (role checked, not the requester)
    C->>M: tools/call check_approval_status
    M-->>C: approved, expires soon
    C->>M: tools/call deploy.production + approvalId
    M->>G: execute (request hash, actor, expiry, single use)
    G-->>M: executed (synthetic)
    M-->>C: result, isError false
    Note over M,G: every step above is also written to the audit chain, MCP steps with source "mcp"
```

Unknown tool names are refused with JSON-RPC `-32602`. The attempt is still
submitted to the gateway so policy records a deny and the audit chain shows it.
The client never supplies its own `actorId`: the requester is the configured
agent id, so it cannot approve or replay as someone else. In demo mode that
identity is unauthenticated, and the audit events say so.

## Components

### Tool registry

Each tool declares an identifier, permitted actions, permitted scopes, baseline
risk and impact flags. Unknown tools and actions outside the contract are
denied. This prevents a model from inventing a capability at runtime.

### Deterministic policy engine

The engine validates the shape and size of the input, normalizes it, then checks
in order: required fields, the tool (own-property lookup), the action, the
resource type, that at least one scope is named, that every scope is in the
contract, and the injection scan. Only then does it score. Every deny carries a
`denyCode` and a `stage` (`registry` or `policy`). The score uses the tool's
baseline, a data classification that can only be raised above the tool's
registered sensitivity, production exposure, requested scopes, a short
justification and the tool's impact flags. Self-reported `existingScopes` do not
reduce it. It returns one of:

- `allow` / `auto_approved`
- `require_human` / `pending_human`
- `deny` / `denied`

The engine has no network dependency and does not call a language model.

### Advisory AI analyst

The analyst summarizes impact, records uncertainty and produces questions for a
human. Its result is stored for transparency but has no code path that mutates
the deterministic policy decision. The decision-package gate does not read it
either: it reads the request.

The default analyst is a fixed set of rules. It is a simulation of an analyst,
and each record says so (`provider: offline-deterministic`, `modelCalled:
false`). If an external compatible model is configured, the gateway sends a fixed
list of metadata fields (never context, arguments or the resource path), redacts
credential-shaped text from the justification, accepts only four typed fields
back, and falls back to the rules on error.

### Human decision service

Approvals are role-qualified:

| Required role | Example use |
|---|---|
| Resource owner | Medium-risk private resource access |
| Security analyst | High-risk sensitive access |
| Security lead | Critical, destructive, privilege or production changes |

Higher roles may satisfy lower-role requirements. Any decision needs a role that
can review (not `viewer`). The requester cannot approve its own request, in any
capitalization. The approval record and request-state transition commit within
one SQLite transaction using optimistic version checking, and the database allows
one decision per request. A pending request older than 240 minutes expires.

Each approval is bound to a SHA-256 of the policy version, requester, tool,
action, resource, environment, classification, sorted scopes, arguments,
justification and context.

### Execution guard

Execution requires an `approved` or `auto_approved` state, an unexpired
authorization and an unused authorization. Before consuming, the guard recomputes
the request hash and compares it with the policy result and the human decision;
a mismatch revokes the authorization. If the caller presents a hash or identity,
those must match too. The expiry check fails closed. A successful execution
records a unique execution ID and moves the request to `executed` inside one
transaction with a version check, so of two racing callers one wins. A second
attempt returns `replay_blocked`. Blocked attempts are audited.

The included executor is deliberately synthetic. It does not invoke operating
systems, cloud APIs, repositories, vaults or enterprise identity platforms.

### Audit chain

Every event stores its sequence number, its previous event hash and a SHA-256 of
the canonical form (sorted keys, no whitespace) of sequence, event id, request
id, type, actor, payload, previous hash and timestamp. Verification walks the
events and checks sequence continuity, the link, the hash and, when
`AUDIT_HMAC_KEY` is set, an HMAC of each hash. It reports the first failing
event and why.

What this detects: edited fields, deleted middle events, reordering and
renumbering. What it does not: removal of the newest events (pass a saved anchor
to detect that), or a writer who rebuilds the whole chain when no key is
configured. The browser demo has no key. A production design should sign records
and anchor the head in a separate append-only security account or logging
system.

## Request state machine

```mermaid
stateDiagram-v2
    [*] --> AutoApproved: low-risk allow
    [*] --> PendingHuman: review required
    [*] --> Denied: policy deny
    [*] --> GateRejected: incomplete decision package
    PendingHuman --> Approved: qualified approve
    PendingHuman --> Denied: human deny
    PendingHuman --> Expired: review window passed
    Approved --> Denied: request hash no longer matches
    AutoApproved --> Executed: valid single-use execution
    Approved --> Executed: valid single-use execution
    AutoApproved --> Expired: TTL elapsed
    Approved --> Expired: TTL elapsed
    AutoApproved --> Executing: reserve (grant consumed)
    Approved --> Executing: reserve (grant consumed)
    Executing --> Executed: confirm
    Executing --> Failed: confirm
    Executing --> UnknownOutcome: no confirm within 5 minutes
    UnknownOutcome --> Executed: reconcile by a person
    UnknownOutcome --> Failed: reconcile by a person
    Executed --> Executed: replay blocked, or same key returns stored result
```

## Two-phase execution

The one-call `execute` is three steps in a row.

1. **Reserve.** One compare-and-swap checks the status, expiry, request hash,
   actor and stored-record integrity, consumes the grant and writes state
   `executing` with an `executionId` and the caller's idempotency key. The
   gateway derives a dispatch key from the execution id and a per-service
   secret. The audit event is `action.reserved` and carries only a digest of
   the dispatch key.
2. **Dispatch.** The tool is called with the dispatch key. The synthetic tools
   keep a record of keys (`server/downstream.js`) and a repeated key returns
   the first result without doing the work again.
3. **Confirm.** The outcome is stored as `executed` (with a SHA-256 digest of the
   result) or `failed`, audited as `action.confirmed` or `action.failed`.

A caller that lost the response asks again with the same approval and the
same key (or the execution id). The gateway answers from the record
(`action.retry_served`) and does not reach the tool. A different key, or a
changed request hash, is refused with `replay_blocked` or `binding_mismatch`.
Retrieval is `GET /api/executions/:id`, the MCP tool `get_execution_result`
and the review UI.

If no confirm arrives within five minutes the record becomes
`unknown_outcome` (`action.unknown_outcome`). Nothing re-dispatches it. A
real tool that timed out gives the gateway no way to know whether it ran, and
guessing either way is worse than asking. A reviewer who is not the requester
records the real outcome with a reason through `reconcile`
(`action.reconciled`).

## Data model

- `requests`: normalized request, arguments, request hash, policy result, state,
  authorization TTL, advisory AI result and execution receipt.
- `decisions`: human identity, role, decision, rationale, request hash and
  authorization expiry. One per request.
- `audit_events`: ordered workflow facts, hash-chain fields and the optional
  HMAC signature.

Databases created before the hash and signature columns existed are upgraded in
place when the store opens.

No secret value field exists in the schema.

## Browser demo and the server copy

`src/demo/` carries browser versions of the policy, scenarios, analyst and
service. `policy.js` and `scenarios.js` are byte-identical to the server files
apart from a header comment. `service.js` is generated from `server/service.js`
by `node scripts/sync-demo-service.mjs`. `tests/parity.test.js` fails if any of
that drifts and also runs every scenario and 3000 generated requests through
both copies.

## Limits and honest caveats

- What two-phase execution does not solve: exactly-once needs the downstream
  system to honour the key, and the lab tools are synthetic. The gateway can
  promise it will not dispatch twice for one grant. It cannot make a tool that
  ignores the key safe to retry. The confirm call is trusted in demo mode.
  Anything that can call it with the dispatch key can record an outcome, so a
  real deployment authenticates the executor. The fake downstream and its
  record of keys live in memory and reset on restart.
- Data is synthetic and the executor is simulated.
- Reviewer identity and role are supplied by the caller.
- The analyst is rule-based unless a model is configured.
- Injection detection is a phrase heuristic with known gaps.
- The audit chain is tamper-evident, not tamper-proof (see above).
- The demo state lives in browser localStorage.
- This is not a production control.
