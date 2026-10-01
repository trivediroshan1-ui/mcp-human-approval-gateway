# Changelog

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
