# Evaluation plan and evidence

## Evaluation principle

The prototype is judged by reproducible security invariants, not by whether the
AI explanation sounds convincing.

## Required invariants

| ID | Invariant | Automated evidence |
|---|---|---|
| P-01 | Public, registered, low-risk read can auto-approve | `policy.test.js` |
| P-02 | Private source access requires human review | `policy.test.js` |
| P-03 | Restricted production secret metadata requires a security lead | `policy.test.js` |
| P-04 | Production privilege change requires a security lead | `policy.test.js` |
| P-05 | Prompt-injected context is denied | `policy.test.js` |
| P-06 | Out-of-contract scope is denied | `policy.test.js` |
| P-07 | Unknown tool is denied | `policy.test.js` |
| W-01 | Insufficient reviewer role cannot approve | `workflow.test.js` |
| W-02 | Qualified approval permits one synthetic execution | `workflow.test.js` |
| W-03 | A consumed authorization cannot replay | `workflow.test.js` |
| W-04 | Expired authorization cannot execute | `workflow.test.js` |
| W-05 | Human denial cannot execute | `workflow.test.js` |
| W-06 | Stale decision cannot leave an orphan approval record | `workflow.test.js` |
| A-01 | Untampered audit chain verifies | `workflow.test.js` |
| A-02 | Audit payload tampering is detected | `workflow.test.js` |
| H-01 | JSON content type is required for writes | `http.test.js` |
| H-02 | Security headers are present | `http.test.js` |
| H-03 | HEAD returns headers without a response body | `http.test.js` |
| P-08 | Every catalog scenario ends in its stated outcome, on both the server and the browser copy | `scenarios.test.js` |
| P-09 | Requester cannot lower the tool's classification or reduce risk with claimed scopes | `security.test.js` |
| P-10 | Wrong resource type, no scope, prototype names, malformed or oversized input are denied | `security.test.js` |
| P-11 | Injection phrases are found through spacing, case, width forms and zero-width characters; no scenario text is a false positive; a paraphrase is a documented miss | `security.test.js` |
| W-07 | Requester cannot approve itself; viewers and unknown roles cannot decide | `scenarios.test.js`, `security.test.js` |
| W-08 | Approval is bound to a request hash; a changed request or decision revokes it | `security.test.js` |
| W-09 | Racing executions consume an authorization once, on one connection and across two | `security.test.js` |
| W-10 | Unreadable expiry fails closed; review window expires stale requests | `security.test.js`, `scenarios.test.js` |
| W-11 | Blocked execution attempts are audited | `security.test.js` |
| W-12 | The analyst cannot rename itself, pass or fail the gate, or receive context, arguments, resource paths or credential-shaped text | `security.test.js` |
| A-03 | Edit of any field, middle deletion, reorder and renumber are detected | `security.test.js` |
| A-04 | Tail truncation is detected only with an anchor; a keyed chain resists a full rebuild; an unkeyed one does not | `security.test.js` |
| H-04 | Cross-site text/plain POST, foreign Origin, non-object bodies and bad paths are refused; 500s do not leak | `http-hardening.test.js` |
| D-01 | Browser copy matches the server: identical source where meant to be, identical results on every scenario and on 3000 generated requests | `parity.test.js` |
| D-02 | Concurrent audit appends in the browser store cannot fork the chain; corrupted saved state does not break start-up | `security.test.js` |
| W-13 | A request marked approved with no stored human approval cannot execute | `forged-status.test.js` |
| W-14 | The status tool settles stuck reservations and queue-expired requests before answering | `open-findings.test.js` |
| W-15 | Optional reviewer allowlist refuses unlisted names and wrong roles | `open-findings.test.js` |
| W-16 | Audit verification warns when the chain is unsigned | `open-findings.test.js` |
| W-17 | The binding rules (trim, lowercase, sorted scopes, exact arguments, existingScopes unbound) | `open-findings.test.js` |
| V-01 | The animated path for every scenario ends where policy says it ends | `architecture-model.test.js` |

Run the evidence:

```bash
npm test
```

Run every use case end to end (separate from the unit suite, about ten seconds):

```bash
node scripts/run-use-cases.mjs
```

Each case lists what was expected and what happened, and flags the ones that
differed from the prediction. Those are the useful ones.

Build and test together:

```bash
npm run check
```

## Human evaluation

The console should make the following distinguishable without hidden state:

- deterministic policy outcome;
- risk score and level;
- reason for review or denial;
- AI analysis marked as advisory;
- required reviewer role;
- authorization expiry;
- execution and replay status;
- audit-chain health.

Keyboard navigation, visible focus, responsive layout and reduced-motion
behavior should be checked in a real browser.

## Negative testing backlog

Before production adaptation, add:

- property-based tests over arbitrary scopes and action strings;
- Unicode and normalization attacks against tool identifiers;
- multi-process and multi-node concurrency tests;
- signed audit anchoring and key-rotation tests;
- real identity-token validation and role-claim tests;
- connector output schema enforcement;
- request queue flooding and distributed rate-limit tests;
- policy-regression fixtures reviewed as code;
- red-team corpora beyond explicit injection phrases.

## Accuracy statement

Passing tests establishes that this implementation satisfies the tested
invariants in the stated environment. It does not prove complete security,
formal correctness, compliance or fitness for production.
