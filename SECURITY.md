# Security and production-use notice

## Supported use

This repository is a synthetic research and demonstration environment. It is
appropriate for learning, threat-model discussions, portfolio demonstrations
and controlled experimentation.

Do not connect this prototype directly to production MCP servers, credential
stores, cloud control planes, source repositories or IAM administration APIs.

## Deliberate prototype limitations

- Actor and reviewer identities are user-supplied strings.
- The reset endpoint is intentionally unauthenticated.
- The executor is simulated.
- The rate limiter is in memory and single-node.
- SQLite uses Node's experimental built-in API.
- The audit chain detects local modification but is not immutable or signed.
- Injection-pattern matching is illustrative, not a complete content-security
  control.
- External AI configuration uses a generic compatible endpoint and has not been
  certified for confidential data.

## Minimum production adaptations

1. Authenticate workloads and humans with verifiable, audience-bound identities.
2. Source reviewer roles from a governed authorization system, not request data.
3. Bind approvals cryptographically to the exact normalized request, policy
   version, tool schema and expiry.
4. Use a durable transactional store and distributed concurrency control.
5. Put the enforcement point immediately before the real tool invocation.
6. Validate connector inputs and outputs against versioned schemas.
7. Retrieve secret values only within the target workload boundary; do not send
   them to the model or approval UI.
8. Sign and externally anchor audit events in an append-only security account.
9. Add identity-aware rate limiting, queue protection and operational monitoring.
10. Subject the complete deployment to threat modeling, code review,
    penetration testing and incident-response exercises.

## Reporting an issue

Do not include real secrets, private source, employer data or personal
information in a report. Provide a synthetic reproduction, expected result,
observed result and environment details.
