# Workflows

The animated version of this page is the Architecture section of the app. The
diagram below is the same path in text.

```mermaid
flowchart TD
    A[1. Agent request<br/>untrusted] --> G[2. MCP gateway<br/>validate, normalize, hash]
    G --> R{3. Registry check<br/>tool, action, resource type}
    R -- not listed --> X1[Deny, fail closed]
    R --> P[5. Policy engine<br/>scopes, injection scan, risk score]
    P -. 4. sanitized metadata .-> AI[AI analyst<br/>advisory, cannot change the decision]
    P --> D{6. Decision}
    D -- deny --> X2[Denied and logged]
    D -- auto-approve --> Z[9. Time-bound single-use authorization<br/>bound to request hash]
    D -- review --> PG{7. Decision-package gate}
    PG -- incomplete --> X3[Gate rejected, no human sees it]
    PG --> H[8. Qualified human reviewer<br/>not the requester]
    H -- deny --> X4[Denied and logged]
    H -- approve --> Z
    Z --> E[10. Execution guard<br/>state, expiry, hash, atomic consume]
    E -- expired, replayed, changed --> X5[Blocked and logged]
    E --> T[Simulated tool runs once]
    G -. 11 .-> L[(Audit hash chain)]
    P -. 11 .-> L
    H -. 11 .-> L
    E -. 11 .-> L
```

## 1. Registered low-risk action

1. The agent submits a structured request.
2. The gateway validates shape and size, then hashes the exact request.
3. The registry knows the tool, the action and the resource type.
4. Risk stays below the review threshold and no impact flag is set.
5. Policy records `allow`. The request is `auto_approved` with a 60 minute
   authorization.
6. The guard checks state, expiry and the hash, then consumes the authorization.
7. A synthetic receipt is written. Nothing else can use that authorization.

Auto-approval is intended only for registered, public, non-sensitive,
non-destructive activity. A requester cannot get there by claiming a lower data
classification, because the tool's registered sensitivity is a floor.

## 2. Risk-based human approval

1. The agent asks for a sensitive or high-impact tool.
2. Policy produces a score, reasons, controls and the required reviewer role.
3. The analyst writes a summary and questions. It is advisory.
4. The decision-package gate checks that the agent stated options, a
   recommendation and a confidence. If not, the request becomes `gate_rejected`
   and no human is asked.
5. A reviewer with a qualifying role approves or denies and gives a reason of at
   least 12 characters. The requester cannot approve its own request. Viewers and
   unknown roles cannot decide at all.
6. Approval creates an authorization of 30 minutes (medium), 15 (high) or 10
   (critical), bound to the request hash.
7. The guard executes at most once.

A request that waits in the queue longer than 240 minutes expires and has to be
submitted again.

## 3. Prompt-injected context

1. An external ticket or document contains something like "ignore previous
   rules" or "bypass approval".
2. The context, the justification and every string in the arguments are folded
   to plain lower-case words (Unicode compatibility forms, zero-width characters,
   punctuation and spacing are removed) and matched against a short phrase list.
3. A match is a `deny` before any human or tool is involved.
4. The analyst may explain the denial. It cannot override it.

This is a heuristic. A paraphrase, another language or an encoded payload is not
caught. What still protects the system in that case is that context never grants
anything, policy never reads it for permission, and a sensitive tool still needs
a person. The lab shows the human the context as quoted, untrusted data.

## 4. Scope creep and contract violations

1. A scope, action or resource type outside the tool's registered contract is
   denied, whatever the justification says.
2. A request that names no scope is denied.
3. Expanded access has to be a new request with its own evaluation and approval.
4. Self-reported `existingScopes` are recorded but never lower the risk score.

## 5. Expiry, replay and tampering

1. Execution at or after the expiry time moves the request to `expired`. An
   expiry that is missing or unreadable counts as expired.
2. A successful execution stores a receipt. Of two callers holding the same
   record version, one wins and the other gets `replay_blocked`.
3. Before consuming, the guard recomputes the request hash. If the stored request
   no longer matches the hash the policy evaluated, or the hash on the human
   decision, the authorization is revoked (`integrity_failed`).
4. A caller may present the hash and its identity. A different hash gives
   `binding_mismatch`, a different requester gives `actor_mismatch`.
5. Blocked attempts are written to the audit trail as `execution.blocked`.

## 6. Audit verification

1. Each event stores its sequence number, the previous event hash and a SHA-256
   of a canonical form of all of its fields.
2. The verifier walks the events in order and checks the sequence, the link and
   the hash. With `AUDIT_HMAC_KEY` set it also checks an HMAC of each hash.
3. Edits, middle deletions, reordering and renumbering identify the first broken
   event.
4. Removing events from the end is invisible to the chain itself. Detecting it
   needs an anchor: a sequence number and head hash saved somewhere else, passed
   to the verifier.

## Limits and honest caveats

- All data is synthetic and the executor is simulated.
- Reviewers are picked from a list. There is no authentication, and reviewer
  roles are whatever the caller says they are.
- The analyst is a fixed set of rules unless a server is configured with a model.
  Every record says which it was (`provider`, `modelCalled`).
- Injection detection is a phrase heuristic, as described above.
- The hash chain is tamper-evident, not tamper-proof. Anyone who can write the
  store can rebuild an unsigned chain. The browser demo has no key and no anchor.
- The browser demo keeps its state in localStorage, where a visitor can edit it.
- This is not a production authorization service.
