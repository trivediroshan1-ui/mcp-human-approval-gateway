# MCP Human Approval Gateway

A public-safe research prototype for controlling AI-agent tool actions with
deterministic policy, risk-based human approval, time-bound authorization and a
tamper-evident audit chain.

The project demonstrates a strict separation of responsibility:

- **AI explains and recommends.** Its analysis is advisory and cannot change a
  policy outcome.
- **Deterministic policy decides.** Registered tools, actions, scopes,
  environments and data classifications produce a reproducible decision.
- **Humans authorize high-impact actions.** Role-qualified reviewers approve or
  deny requests with a recorded rationale.
- **The execution guard enforces the result.** Approvals expire, can be consumed
  once and cannot be replayed.

All included names, resources, identities and actions are synthetic. The
prototype contains no employer architecture, production credentials, customer
data or confidential control implementations.

## What the lab demonstrates

1. Low-risk public research can be auto-approved.
2. Private source access enters a human-review queue.
3. Restricted credential metadata requires elevated review while secret values
   remain unavailable to the AI analyst.
4. Production privilege changes require a security lead.
5. Prompt-injected context is treated as untrusted data and denied.
6. Runtime scope expansion is denied and must be submitted as a new request.
7. Unregistered tools fail closed.
8. Expired or already-consumed approvals cannot execute.
9. Audit-event modification is detected by hash-chain verification.

## Run locally

Prerequisite: Node.js 24 or newer. The prototype uses the built-in
`node:sqlite` API.

```bash
npm install
npm run build
npm start
```

Open `http://localhost:4174`.

For frontend development:

```bash
npm run dev:server
npm run dev:client
```

The Vite client runs on `http://localhost:5174` and proxies API calls to port
4174.

## Verify

```bash
npm run check
```

The automated suite covers policy outcomes, reviewer authorization, atomic
decision commits, approval expiry, single-use execution, audit tamper detection,
HTTP validation and browser security headers.

## Optional AI analyst

The lab works fully offline with a deterministic analyst. An
OpenAI-compatible chat-completions endpoint can be configured through
environment variables:

```bash
cp .env.example .env
```

The external analyst receives sanitized request metadata, never raw credential
values. Provider failure falls back to the offline analyst. In every mode, the
model output remains advisory.

## Design documents

- [Architecture](docs/ARCHITECTURE.md)
- [Workflows](docs/WORKFLOWS.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Evaluation plan and evidence](docs/EVALUATION.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Security assumptions and production gaps](SECURITY.md)
- [API contract](docs/openapi.yaml)

## Standards and research basis

The control design is informed by:

- [NIST AI RMF Generative AI Profile](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence)
- [NIST AI RMF Playbook](https://www.nist.gov/itl/ai-risk-management-framework/nist-ai-rmf-playbook)
- [NIST Cyber AI Profile preliminary draft](https://csrc.nist.gov/news/2025/nist-releases-prelim-draft-cyber-ai-profile)
- [OWASP MCP Top 10: Privilege Escalation via Scope Creep](https://owasp.org/www-project-mcp-top-10/2025/MCP02-2025%E2%80%93Privilege-Escalation-via-Scope-Creep)
- [OWASP MCP Top 10: Context Injection and Over-Sharing](https://owasp.org/www-project-mcp-top-10/2025/MCP10-2025%E2%80%93ContextInjection%26OverSharing)
- [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/)
- [CISA JCDC AI Cybersecurity Collaboration Playbook](https://www.cisa.gov/news-events/alerts/2025/01/14/cisa-releases-jcdc-ai-cybersecurity-collaboration-playbook-and-fact-sheet)
- [NIST SP 800-63-4 Digital Identity Guidelines](https://www.nist.gov/publications/nist-sp-800-63-4-digital-identity-guidelines)

These references inform the design; they do not constitute certification or
formal compliance.

## GitHub Pages browser demonstration

The GitHub Pages edition is a browser-only synthetic simulation. It allows
visitors to explore deterministic policy decisions, human approval,
time-limited authorization, guarded execution, replay blocking and audit-chain
verification without connecting to real systems.

Each visitor has independent demonstration state stored only in their browser.
Use **Reset Lab** to remove that state.

The browser demonstration does not provide enterprise identity proofing,
shared approval queues, server-side policy enforcement, durable audit storage,
multi-user coordination or cross-tab transaction locking. The Node.js and
SQLite implementation remains the reference full-stack research prototype.

No production systems, company information, customer data, credentials or API
keys are used by the demonstration.

## Important scope boundary

This is an educational security prototype, not a production authorization
service. It simulates tool execution and intentionally omits enterprise identity
proofing, durable key management, multi-node transaction coordination and
append-only external audit storage. See [SECURITY.md](SECURITY.md) before
adapting any part of it.
