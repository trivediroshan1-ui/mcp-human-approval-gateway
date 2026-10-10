# MCP Human Approval Gateway

A public-safe research prototype for controlling AI-agent tool actions with
deterministic policy, risk-based human approval, time-bound authorization and a
tamper-evident audit chain.

It speaks the Model Context Protocol (revision 2026-07-28, with 2025-11-25 for
older clients) over Streamable HTTP and stdio, so a real MCP client can call its
tools and hit the same policy and approval gate. See [MCP server](docs/MCP.md).
The MCP server runs in the Node server only. The browser demo does not speak MCP.

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

The catalog has nine scenarios. Each one states its expected outcome, the app
checks the result against it after every run, and `tests/scenarios.test.js`
asserts the same table on both the server and the browser copy.

1. Public research is auto-approved (low risk, 60 minute authorization).
2. A private repository read goes to a resource owner.
3. Restricted credential metadata needs a security lead, and secret values never
   reach the AI analyst.
4. A production privilege change needs a security lead.
5. Prompt-injected context is treated as untrusted data and denied.
6. Runtime scope expansion is denied and must be submitted as a new request.
7. A production deployment needs a security lead.
8. An unregistered tool fails closed.
9. An agent that hands off without options, a recommendation or a confidence is
   stopped by the decision-package gate before a person sees it.

Three more behaviours can be tried from the app: replaying a consumed
authorization is blocked, an authorization expires (the browser demo has a lab
clock you can move forward), and editing a stored audit event makes verification
fail at that event.

The Architecture section animates the path each scenario takes and where it
stops.

## Run locally

Prerequisite: Node.js 24 or newer. The prototype uses the built-in
`node:sqlite` API. The tests also pass on Node 22 (SQLite prints an
experimental warning there).

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

The suite (210 tests under Node 22) covers policy outcomes, reviewer authorization, request-hash binding,
atomic decision commits, expiry, single-use execution, audit tamper detection,
HTTP hardening, server and browser-copy parity, the animated paths, and the MCP
server (raw JSON-RPC over HTTP and a stdio child process).

To run every use case in one go against real copies of the gateway, with a
results file at the end (about ten seconds, Node 22 or newer):

```bash
node scripts/run-use-cases.mjs              # add --real-wait for the real 11-minute expiry
```

It covers changed requests after approval, text and encoding variants, time,
people and abuse, lost replies, restarts, every tool tier, protocol hygiene,
database tampering and approval fatigue. Each case records what was expected and
what happened. Results go to `results/` (not committed). Everything is synthetic.

## MCP server

```bash
npm start            # web UI, REST API and POST /mcp on 127.0.0.1:4174
npm run mcp:stdio    # the same server over stdin and stdout
```

An MCP client sees the seven registered tools and `check_approval_status`. A
low-risk call runs at once. A risky one returns `pending_approval` with an id,
a person approves it in the web UI, and the agent calls again with the same
arguments plus `approvalId` so the guard can consume the single-use approval.
Denied calls return `isError: true`, and unknown tools return a JSON-RPC
`-32602` error. Every call, including refusals, lands in the audit chain with
source `mcp`.

It is unauthenticated demo mode: the caller is a configured agent id plus a
self-declared `clientInfo`. A real deployment needs the MCP authorization flow
(OAuth) in front. The connection snippets, a recorded session and the list of
what is not implemented are in [docs/MCP.md](docs/MCP.md).

## Optional AI analyst

The lab works fully offline with a deterministic analyst. An
OpenAI-compatible chat-completions endpoint can be configured through
environment variables:

```bash
cp .env.example .env
```

The offline analyst is a rule-based simulation and the app labels it that way.
The external analyst receives a fixed list of metadata fields, never context,
arguments or the resource path, and credential-shaped text is redacted from the
justification. Provider failure falls back to the offline analyst. In every mode
the output is advisory: it cannot change a decision or pass the gate.

Three other settings: `AUDIT_HMAC_KEY` signs audit events, `REVIEWER_ALLOWLIST="name:role,..."` limits which typed reviewer names count (it is not authentication), and `ALLOW_RESET=false`
removes the unauthenticated reset route.

## Limits and honest caveats

Data is synthetic, reviewers are simulated (no authentication), the analyst is
rule-based unless you configure a model, injection detection is a phrase
heuristic, reviewer names are typed in and not proven, the hash chain is tamper-evident but not tamper-proof without a key or
an outside anchor, and none of this is a production control. Details are in
[Workflows](docs/WORKFLOWS.md) and [SECURITY.md](SECURITY.md). What changed in
the latest review is in the [changelog](docs/CHANGELOG.md).

## Design documents

- [MCP server](docs/MCP.md)
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
