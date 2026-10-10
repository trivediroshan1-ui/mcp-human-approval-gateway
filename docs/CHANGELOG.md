# Changelog

## Open findings closed

- `check_approval_status` now settles time before answering: a reservation past
  its 5 minute timeout reads as `unknown_outcome`, and a request that waited
  past the 240 minute queue window reads as `expired`. Both agree with the
  result tool and with what a reviewer would be told. (`service.getFresh`.)
- An `approvalId` longer than 128 characters returns `invalid_arguments`
  instead of looking like an unknown id.
- Binding rules are written down in `docs/THREAT_MODEL.md` and pinned by a
  test: top-level text is trimmed, `environment` and `dataClassification` are
  lowercased, scopes are sorted, `arguments` are compared exactly, and
  `existingScopes` are not bound.
- Optional `REVIEWER_ALLOWLIST="name:role,name:role"`. When set, a decision or
  reconciliation from a name that is not listed with that role is refused. Names
  are still typed, not proven. Without it the server logs a warning at start.
- Audit verification returns a `warning` when the chain is unsigned, and the
  server logs one at start when `AUDIT_HMAC_KEY` is missing.
- Tests: 210 (6 new in `tests/open-findings.test.js`). Runner: 76 cases, one
  still different from prediction (T31: with no allowlist, a made-up reviewer
  name is accepted).

## Approval must have a human decision behind it

- Execution now refuses a request whose status says `approved` but has no stored
  human approval (`integrity_failed`, authorization revoked). Found by editing the
  status directly in the database: before this change the call executed and the
  audit chain still verified, because no event had been removed. Test:
  `tests/forged-status.test.js`.
- New runner `scripts/run-use-cases.mjs` runs every use case against its own
  gateway copies and writes a results file. It now includes database-tamper cases
  (D1 to D3) and an approval-fatigue case (F1).
- Known at the time (all but reviewer identity are closed in the entry above): the status tool can show `executing` or
  `pending_human` after the result tool or an expiry has moved on; text rules
  (trimming and lowercasing of top-level fields, exact comparison inside
  `arguments`) are not written down or versioned; reviewer identity is asserted,
  not authenticated; a missing `AUDIT_HMAC_KEY` verifies as valid but unsigned.

## Lost-response handling

- The architecture view now shows reserve, dispatch and confirm (steps 10 to 12), with a
  dispatch counter on the tool node. Two extra paths can be picked: "Lost response, then
  retry (same key)" and "No confirm in 5 minutes". The workflow list has 15 steps, each
  with a guardrail. The model is checked against the real service in
  `tests/architecture-model.test.js`.

- Execution is now reserve, dispatch, confirm. The one-call `execute` composes
  them. The same approval with the same idempotency key returns the stored
  result and never dispatches twice. A different key or changed hash is refused.
- New states `executing`, `failed` and `unknown_outcome`. A stuck execution
  becomes `unknown_outcome` after five minutes and is settled only by a person
  through `reconcile`. No automatic retry.
- `GET /api/executions/:id`, `confirm`, `reconcile`, the MCP tool
  `get_execution_result` and `_meta.replayed` on repeated MCP calls.
- A fake downstream with key records and fault injection backs the tests and the
  demo. Review UI has retry buttons and a reconcile panel.

## MCP server and site integration

- Added a Model Context Protocol server (revision 2026-07-28, plus 2025-11-25)
  over Streamable HTTP (`POST /mcp`) and stdio (`npm run mcp:stdio`). It goes
  through the same policy, approval, single-use execution and audit path as the
  REST API. See [MCP server](MCP.md).
- The server now binds to `127.0.0.1` unless `HOST` says otherwise. The Docker
  image sets `HOST=0.0.0.0`.
- The UI links back to the site, lists what the demo does not prove, has a five
  step walkthrough, can download the audit chain as JSON, and labels MCP events.
- Added page metadata, a favicon and a social image.

## Review of October 2026

Found by reading the code and probing it, each with a regression test.

### Fixed in policy

- High: a private tool could be auto-approved by claiming `public` data
  classification (`repo.read` scored 32, under the review threshold). The tool's
  registered sensitivity is now a floor.
- High: a tool could be pointed at any resource (`docs.search` on a `vault://`
  path was auto-approved). Tools now declare allowed resource types.
- Medium: `constructor` and `__proto__` passed the registry lookup and crashed
  the evaluator. Lookups use own properties.
- Medium: a request with no scope was auto-approved. It is now denied.
- Medium: claimed `existingScopes` lowered the risk score. They are now ignored
  for scoring.
- Medium: malformed input (wrong types, huge strings, missing environment, `null`
  body) was coerced, ignored or threw. It is now a fail-closed deny with a
  `denyCode`.
- Low: injection scan missed extra spaces, newlines, case tricks, full-width
  letters and zero-width characters, and only looked at `context`. It now folds
  text and also scans the justification and arguments. It remains a heuristic.

### Fixed in service and store

- High: nothing bound an approval to the request. The request hash now covers
  tool, action, arguments, scopes, requester, environment, classification,
  justification, context and policy version, and the guard recomputes it.
- High: requester could approve its own request; viewers and unknown roles could
  deny. Both are refused.
- Medium: an unreadable expiry (`NaN`) was treated as not expired. It now fails
  closed.
- Medium: the decision-package gate read the analyst output, and an external
  model could set its own `provider` and extra fields. The gate reads the
  request, and only four typed fields are taken from a model.
- Medium: blocked execution attempts left no audit trail. They are now recorded.
- Medium: audit hash did not cover the sequence number. It does, verification
  reports the reason, and there is an optional HMAC and an anchor check.
- Low: pending requests never expired (review window of 240 minutes added);
  list ordering was not deterministic for equal timestamps; one decision per
  request is enforced by an index; older databases are upgraded in place.

### Fixed in HTTP

- Medium: a cross-site `text/plain; x=application/json` POST passed the content
  type check (CSRF on decide, execute and reset). Exact media type and an Origin
  check now apply.
- Medium: `null` or array bodies and bad percent escapes returned 500; internal
  error text was returned to callers. Now 400 and a generic 500.
- Low: added `object-src 'none'`, COOP and CORP headers, `no-store` on JSON, a
  pruned rate-limit map and `ALLOW_RESET=false`.

### Fixed in the browser demo

- Medium: concurrent audit appends could fork the chain (asynchronous hashing).
  Appends are serialized.
- Medium: corrupted saved state could stop the app from starting.
- Low: the demo passed the raw request, not the normalized one, to the analyst.
  The demo service is now generated from the server service.

### Added

- Animated architecture and workflow view with a path per scenario.
- Expected-outcome check per scenario in the UI and in tests.
- Browser-copy parity tests (source, nine scenarios, 3000 generated requests).
- Lab controls in the browser demo: replay attempt, lab clock, tamper test.
- Untrusted context, arguments and request hash shown to the reviewer.
- Labels that say the analyst is a simulation, and a limits section.
- `AUDIT_HMAC_KEY`, `ALLOW_RESET`, audit anchor parameters, `arguments` field.

### Not changed

- Reviewer identity and roles are still caller-supplied.
- Parent request links are stored but have no semantics.
- Approval cannot narrow scope; the reviewer can only approve or deny.
