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

Run the evidence:

```bash
npm test
```

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
