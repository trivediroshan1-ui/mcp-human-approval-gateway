# MCP server

The gateway speaks the Model Context Protocol. An MCP client sees the gateway's
registered tools plus one helper, and every call it makes goes through the same
policy, human approval, request-hash binding, single-use execution guard and
audit chain as the REST API. The tools are synthetic. Executing one prints a
message and touches nothing.

**Revision implemented: MCP 2026-07-28.** The same endpoint also answers the
initialize-based revision 2025-11-25 so older clients still work. The specification
pages were read on 2026-10-01:

- [Key changes in 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [Versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Base protocol and error codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)
- [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) and [transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Two things differ from what you may remember of older MCP. In 2026-07-28 there
is no `initialize` handshake and no session id: every request carries its
protocol version and client capabilities in `params._meta`, and `ping` was
removed. This server follows that, and keeps `initialize` and `ping` only for
clients that open with the 2025-11-25 handshake.

## Run it

```bash
npm start                # web UI, REST API and POST /mcp on 127.0.0.1:4174
npm run mcp:stdio        # the same server over stdin and stdout
```

Both use the SQLite file at `DATABASE_PATH` (default `./data/gateway.db`), so a
reviewer can approve in the web UI while an agent talks over stdio.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. The Dockerfile sets `0.0.0.0`. |
| `PORT` | `4174` | HTTP port. |
| `MCP_AGENT_ID` | `mcp-agent-demo` | The identity every MCP caller is recorded under. |
| `MCP_HTTP` | `true` on loopback, `false` elsewhere | Turns `POST /mcp` on or off. |
| `MCP_ALLOWED_HOSTS` | none | Extra Host names to accept, comma separated, for use behind a proxy. |
| `MCP_ALLOWED_ORIGINS` | none | Extra full origins to accept, comma separated. |
| `AUDIT_HMAC_KEY` | none | Signs audit events. Never returned over MCP. |

## Connect a client

Field names differ between clients, so check yours. The shapes below are the common
`mcpServers` convention. Only the Claude Code snippets were checked against that
product's [documentation](https://code.claude.com/docs/en/mcp).

### stdio, generic

```json
{
  "mcpServers": {
    "human-approval-gateway": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-human-approval-gateway/server/mcp-stdio.js"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/mcp-human-approval-gateway/data/gateway.db",
        "MCP_AGENT_ID": "my-agent"
      }
    }
  }
}
```

The server needs Node 24 (22 also runs it with an SQLite warning). It writes only
JSON-RPC to stdout and logs to stderr.

### Streamable HTTP, generic

Start `npm start`, then point the client at:

```
POST http://127.0.0.1:4174/mcp
```

Every request needs `Content-Type: application/json` and, for 2026-07-28,
`MCP-Protocol-Version: 2026-07-28` and `Mcp-Method: <method>` headers (plus
`Mcp-Name: <tool>` on `tools/call`). Replies are always a single JSON object.

### Claude Code

Checked against the Claude Code documentation on 2026-10-01:

```bash
claude mcp add --transport http human-approval-gateway http://127.0.0.1:4174/mcp
claude mcp add --env MCP_AGENT_ID=claude-code human-approval-gateway-stdio \
  -- node /absolute/path/to/mcp-human-approval-gateway/server/mcp-stdio.js
```

or in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "human-approval-gateway": { "type": "http", "url": "http://127.0.0.1:4174/mcp" }
  }
}
```

I did not run Claude Code against this server. Which protocol revision it picks
depends on its runtime, so treat it as untested.

### curl

```bash
META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"curl","version":"1"}}'
curl -s http://127.0.0.1:4174/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/list' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{$META}}"
```

## Tools

`tools/list` returns the seven registered tools in registry order, then
`check_approval_status`. The order is stable. The list carries `ttlMs` and
`cacheScope` as the revision requires.

| Tool | Actions | Annotations |
| --- | --- | --- |
| `docs.search` | read | read only |
| `repo.read` | read | read only |
| `secrets.read` | read-metadata | read only |
| `iam.roles.update` | grant, revoke | destructive hint |
| `deploy.production` | deploy | destructive hint |
| `storage.delete` | delete | destructive hint |
| `ticket.create` | create | not destructive |
| `check_approval_status` | none | read only |

Every gateway tool takes the same arguments: `action`, `resource`, `environment`,
`requestedScopes`, `justification` (all required), and optionally
`dataClassification`, `existingScopes`, `context`, `arguments`, `skipAnalysis` and
`approvalId`. Each tool also publishes an `outputSchema`, and its results carry
`structuredContent` that matches it, plus the same JSON as a text block.

The annotations are hints for clients and the gateway never relies on them.
`destructiveHint` is set for tools the registry marks as destructive,
privilege-changing or production-changing, which is the cautious reading.

The client cannot send an `actorId`. The requester is always the configured
`MCP_AGENT_ID`, so a client cannot approve, replay or look up requests as
someone else.

## How a call flows

1. `tools/call` arrives. Unknown tool names get a JSON-RPC `-32602` error.
2. Valid calls go to the gateway. Policy decides: execute, hold for a human, or deny.
3. Auto-approved calls run at once and return `outcome: "executed"`.
4. Calls that need review return `outcome: "pending_approval"`, `isError: false` and
   the text `NOT EXECUTED`, with an `approvalId`.
5. A person approves or denies in the review UI (or `POST /api/requests/:id/decision`).
   The requesting agent cannot approve its own request.
6. The agent polls `check_approval_status`, and once it says `approved`, calls the same
   tool again with identical arguments plus `approvalId`.
7. The execution guard checks the request hash, the requester, the expiry and that the
   approval is unused, then consumes it and runs the synthetic action.

I used polling and not the 2026-07-28 `input_required` result. That result asks the
client for more input, such as an elicitation. Here the missing input comes from a
different person on a different channel, so there is nothing for the client to fill in.

| `outcome` | `isError` | Meaning |
| --- | --- | --- |
| `executed` | false | Ran (synthetically). The approval is now used up. |
| `pending_approval` | false | Not executed. A human has to decide. |
| `denied` | true | Policy or a reviewer said no. `denyCode` and `reasons` explain. |
| `rejected_by_gate` | true | The handoff was incomplete, so no human was asked. |
| `expired` | true | The approval ran out. |
| `replay_blocked` | true | The approval was already used. |
| `binding_mismatch` | true | The arguments differ from the ones reviewed. |
| `approval_not_found` | true | Unknown id, or not this agent's. Same answer for both. |
| `invalid_arguments` | true | Wrong shape. Nothing was sent to policy. |

`check_approval_status` shows status, risk, required role, expiry and a decision
summary. It does not return reviewer comments, which would be free text from a
person going straight into an agent's context.

## Errors on the wire

| Situation | HTTP | JSON-RPC |
| --- | --- | --- |
| Body is not JSON | 400 | `-32700` |
| Batch array, missing `jsonrpc`, `id: null`, unsolicited response | 400 | `-32600` |
| Missing `_meta` fields | 400 | `-32602` |
| `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` missing or not matching the body | 400 | `-32020` |
| Unsupported protocol version (`data.supported` lists `2026-07-28`, `2025-11-25`) | 400 | `-32022` |
| Unknown method | 404 | `-32601` |
| Unknown tool | 200 | `-32602` |
| Bad Origin or Host | 403 | `-32600`, `id: null` |
| Not POST | 405 | `-32600` |
| Not `application/json` | 415 | `-32600` |
| Body over 64 KiB | 413 | `-32600` |
| Too many requests from one address | 429 | `-32600` |
| Unexpected failure | 500 | `-32603`, no details |

Notifications get `202` with no body. Errors with no readable id carry `"id": null`.
The specification says only that such an error has no id; `null` is what JSON-RPC 2.0
asks for.

## Security behaviour

- **Origin and Host.** A request with an `Origin` header must come from the same
  origin it was sent to, on a Host this server expects (`localhost`, `127.0.0.1`,
  `[::1]` plus `MCP_ALLOWED_HOSTS`), or be in `MCP_ALLOWED_ORIGINS`. Anything else
  is `403`. Requests with no `Origin` are not browser requests and pass this check.
  The Host check is what stops DNS rebinding, because a rebinding page sends
  matching Origin and Host values for a name we do not expect.
- **Bind and exposure.** The server binds to `127.0.0.1` by default. When it binds
  anywhere else, `POST /mcp` stays off until `MCP_HTTP=true`.
- **No CORS.** No `Access-Control-*` headers are sent, so another site cannot read a
  reply or pass a preflight.
- **Limits.** 64 KiB bodies, `application/json` only, 240 requests a minute per address,
  no batching, no streaming.
- **Audit.** Every outcome is written to the hash chain: initialize, discover, list,
  each tool call, notifications and protocol-level refusals such as a bad Origin or
  malformed JSON. Events carry `source: "mcp"` (the web UI shows an `mcp` label), the
  transport, the method, the tool, the outcome, the client's declared name and version,
  and the configured agent id. A tool call also links to its gateway request id.
- **Identity is unauthenticated.** The audit record says so on every event:
  `unauthenticated demo mode: clientInfo is self-declared`. Both `clientInfo` and the
  agent id are labels, not proof. The specification itself says `clientInfo` should
  not be used for security decisions.
- **Secrets.** The audit key, request internals and stack traces are never put in a
  reply. Internal failures return `-32603 Internal error` and nothing else.

A real deployment needs the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
(OAuth) in front of the HTTP endpoint, with the requester identity taken from the
token and not from configuration. stdio servers are expected to take credentials
from the environment instead.

## What is and is not implemented

Implemented:

- Streamable HTTP, POST only, at `/mcp`, with JSON replies.
- stdio, newline-delimited, exits when stdin closes.
- `server/discover`, `tools/list`, `tools/call` for 2026-07-28, with per-request
  `_meta`, `resultType`, `serverInfo` in `_meta`, header validation, and the `-32020`
  (header mismatch) and `-32022` (unsupported version) errors.
- `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call` for
  2025-11-25. On stdio a legacy client must send `initialize` first. On HTTP the
  server keeps no state, so it does not enforce that order.
- Capability `tools` with `listChanged: false`. Nothing else is advertised.
- Tool `inputSchema`, `outputSchema`, `structuredContent`, `annotations`, `isError`.

Not implemented:

- Authorization. There is no OAuth, no token check and no per-user identity.
- SSE responses, `subscriptions/listen`, list-changed notifications, progress and
  cancellation. Cancel notifications are accepted and ignored. Every call returns
  quickly, so there is nothing long-running to cancel.
- Multi round-trip requests (`input_required`), elicitation, sampling, roots.
- Resources, prompts, completions, logging and the tasks extension.
- JSON-RPC batching. Neither revision allows it, so arrays get `-32600`.
- `Mcp-Session-Id`, `GET` and `DELETE` on the endpoint (`405`), and SSE resumability.
- Protocol versions before 2025-11-25 and `x-mcp-header` parameter headers.
- Pagination. `tools/list` is one page and refuses a cursor.
- Persistent rate limiting. The limiter is in memory and per process.

Not verified: no third-party MCP client or official SDK has been run against this
server. The tests drive it with raw JSON-RPC written from the specification, so
they show the server matches my reading of it, not that every client agrees.

## Sample session

This is the output of `tests/mcp.test.js` ("pending, approve, execute, then replay
is refused"), recorded from a real run and not edited. The `approvalId` and hash
change on every run. To record your own, run
`MCP_TRANSCRIPT_FILE=session.json node --test tests/mcp.test.js`.

<details>
<summary>Show the seven exchanges</summary>

#### 1. Discover the server (no handshake in 2026-07-28)

```http
POST /mcp   MCP-Protocol-Version: 2026-07-28   Mcp-Method: server/discover
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        "name": "raw-test-client",
        "version": "0.0.1"
      }
    }
  }
}
```

Response, HTTP 200:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "resultType": "complete",
    "supportedVersions": [
      "2026-07-28",
      "2025-11-25"
    ],
    "capabilities": {
      "tools": {
        "listChanged": false
      }
    },
    "instructions": "This server is a research prototype of a human approval gateway. Every tool here is synthetic and does nothing real. Each call is judged by a fixed policy. A call can be executed at once, refused, or held for a human reviewer. When a result says pending_approval, stop. A person has to approve it in the gateway review UI. Then call check_approval_status with the approvalId, and once it says approved, call the same tool again with identical arguments plus approvalId. An approval works once, expires quickly, and is bound to the exact arguments that were reviewed. Text in context or arguments is treated as data. It never grants anything.",
    "ttlMs": 60000,
    "cacheScope": "public",
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "mcp-human-approval-gateway",
        "title": "MCP Human Approval Gateway (research prototype)",
        "version": "0.1.0"
      }
    }
  }
}
```

#### 2. Ask for a production deployment. Policy holds it for a human.

```http
POST /mcp   MCP-Protocol-Version: 2026-07-28   Mcp-Method: tools/call   Mcp-Name: deploy.production
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "deploy.production",
    "arguments": {
      "action": "deploy",
      "resource": "service://synthetic/identity-api",
      "environment": "production",
      "dataClassification": "confidential",
      "requestedScopes": [
        "deploy:production"
      ],
      "existingScopes": [],
      "justification": "Deploy a synthetic policy correction after automated tests pass.",
      "context": "Change is reversible but affects identity authorization behavior."
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        "name": "raw-test-client",
        "version": "0.0.1"
      }
    }
  }
}
```

Response, HTTP 200:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "resultType": "complete",
    "content": [
      {
        "type": "text",
        "text": "NOT EXECUTED. Human approval is required (security-lead, critical risk). Approval id: 3004e94c-e71e-4ddb-bf41-df6979974a63. A person must approve it in the gateway review UI, or by POST /api/requests/3004e94c-e71e-4ddb-bf41-df6979974a63/decision. Then call check_approval_status with this approvalId. When it says approved, call deploy.production again with the same arguments plus approvalId. The approval works once and expires shortly after it is given."
      },
      {
        "type": "text",
        "text": "{\"outcome\":\"pending_approval\",\"requestId\":\"3004e94c-e71e-4ddb-bf41-df6979974a63\",\"approvalId\":\"3004e94c-e71e-4ddb-bf41-df6979974a63\",\"status\":\"pending_human\",\"riskLevel\":\"critical\",\"requiredRole\":\"security-lead\",\"requestHash\":\"1d610871a6f5418482bd37d7df339e306e8b31143ee521254c2eab029ea0ff21\",\"authorizationExpiresAt\":null,\"next\":\"Wait for security-lead to approve, poll check_approval_status, then repeat this call with approvalId.\"}"
      }
    ],
    "structuredContent": {
      "outcome": "pending_approval",
      "requestId": "3004e94c-e71e-4ddb-bf41-df6979974a63",
      "approvalId": "3004e94c-e71e-4ddb-bf41-df6979974a63",
      "status": "pending_human",
      "riskLevel": "critical",
      "requiredRole": "security-lead",
      "requestHash": "1d610871a6f5418482bd37d7df339e306e8b31143ee521254c2eab029ea0ff21",
      "authorizationExpiresAt": null,
      "next": "Wait for security-lead to approve, poll check_approval_status, then repeat this call with approvalId."
    },
    "isError": false,
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "mcp-human-approval-gateway",
        "title": "MCP Human Approval Gateway (research prototype)",
        "version": "0.1.0"
      }
    }
  }
}
```

#### 3. Poll the status while nobody has reviewed it

```http
POST /mcp   MCP-Protocol-Version: 2026-07-28   Mcp-Method: tools/call   Mcp-Name: check_approval_status
```

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "check_approval_status",
    "arguments": {
      "approvalId": "3004e94c-e71e-4ddb-bf41-df6979974a63"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        "name": "raw-test-client",
        "version": "0.0.1"
      }
    }
  }
}
```

Response, HTTP 200:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "resultType": "complete",
    "content": [
      {
        "type": "text",
        "text": "Request 3004e94c-e71e-4ddb-bf41-df6979974a63 is pending_human. Still waiting for a reviewer. Check again later."
      },
      {
        "type": "text",
        "text": "{\"outcome\":\"approval_status\",\"approvalId\":\"3004e94c-e71e-4ddb-bf41-df6979974a63\",\"toolId\":\"deploy.production\",\"status\":\"pending_human\",\"riskLevel\":\"critical\",\"requiredRole\":\"security-lead\",\"authorizationExpiresAt\":null,\"consumed\":false,\"decision\":null,\"next\":\"Still waiting for a reviewer. Check again later.\"}"
      }
    ],
    "structuredContent": {
      "outcome": "approval_status",
      "approvalId": "3004e94c-e71e-4ddb-bf41-df6979974a63",
      "toolId": "deploy.production",
      "status": "pending_human",
      "riskLevel": "critical",
      "requiredRole": "security-lead",
      "authorizationExpiresAt": null,
      "consumed": false,
      "decision": null,
      "next": "Still waiting for a reviewer. Check again later."
    },
    "isError": false,
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "mcp-human-approval-gateway",
        "title": "MCP Human Approval Gateway (research prototype)",
        "version": "0.1.0"
      }
    }
  }
}
```

#### 4. A person approves in the review UI (REST API, not MCP)

```http
POST /api/requests/3004e94c-e71e-4ddb-bf41-df6979974a63/decision  (the reviewer UI does this)
```

```json
{
  "reviewerId": "lead-morgan",
  "reviewerRole": "security-lead",
  "decision": "approve",
  "reason": "Scope and duration are the minimum needed for this test."
}
```

Response, HTTP 200:

```json
{
  "ok": true,
  "status": "approved",
  "authorizationExpiresAt": "2026-10-01T11:32:00.784Z"
}
```

#### 5. Poll again

```http
POST /mcp   MCP-Protocol-Version: 2026-07-28   Mcp-Method: tools/call   Mcp-Name: check_approval_status
```

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "check_approval_status",
    "arguments": {
      "approvalId": "3004e94c-e71e-4ddb-bf41-df6979974a63"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        "name": "raw-test-client",
        "version": "0.0.1"
      }
    }
  }
}
```

Response, HTTP 200:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "resultType": "complete",
    "content": [
      {
        "type": "text",
        "text": "Request 3004e94c-e71e-4ddb-bf41-df6979974a63 is approved. Approved. Call deploy.production again with identical arguments plus approvalId. It works once and expires at 2026-10-01T11:32:00.784Z."
      },
      {
        "type": "text",
        "text": "{\"outcome\":\"approval_status\",\"approvalId\":\"3004e94c-e71e-4ddb-bf41-df6979974a63\",\"toolId\":\"deploy.production\",\"status\":\"approved\",\"riskLevel\":\"critical\",\"requiredRole\":\"security-lead\",\"authorizationExpiresAt\":\"2026-10-01T11:32:00.784Z\",\"consumed\":false,\"decision\":{\"decision\":\"approve\",\"reviewerRole\":\"security-lead\",\"decidedAt\":\"2026-10-01T11:22:00.784Z\"},\"next\":\"Approved. Call deploy.production again with identical arguments plus approvalId. It works once and expires at 2026-10-01T11:32:00.784Z.\"}"
      }
    ],
    "structuredContent": {
      "outcome": "approval_status",
      "approvalId": "3004e94c-e71e-4ddb-bf41-df6979974a63",
      "toolId": "deploy.production",
      "status": "approved",
      "riskLevel": "critical",
      "requiredRole": "security-lead",
      "authorizationExpiresAt": "2026-10-01T11:32:00.784Z",
      "consumed": false,
      "decision": {
        "decision": "approve",
        "reviewerRole": "security-lead",
        "decidedAt": "2026-10-01T11:22:00.784Z"
      },
      "next": "Approved. Call deploy.production again with identical arguments plus approvalId. It works once and expires at 2026-10-01T11:32:00.784Z."
    },
    "isError": false,
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "mcp-human-approval-gateway",
        "title": "MCP Human Approval Gateway (research prototype)",
        "version": "0.1.0"
      }
    }
  }
}
```

#### 6. Call the tool again with identical arguments plus approvalId

```http
POST /mcp   MCP-Protocol-Version: 2026-07-28   Mcp-Method: tools/call   Mcp-Name: deploy.production
```

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "deploy.production",
    "arguments": {
      "action": "deploy",
      "resource": "service://synthetic/identity-api",
      "environment": "production",
      "dataClassification": "confidential",
      "requestedScopes": [
        "deploy:production"
      ],
      "existingScopes": [],
      "justification": "Deploy a synthetic policy correction after automated tests pass.",
      "context": "Change is reversible but affects identity authorization behavior.",
      "approvalId": "3004e94c-e71e-4ddb-bf41-df6979974a63"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        "name": "raw-test-client",
        "version": "0.0.1"
      }
    }
  }
}
```

Response, HTTP 200:

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "resultType": "complete",
    "content": [
      {
        "type": "text",
        "text": "EXECUTED (simulated). Pretended to deploy a synthetic build. No real system was touched. Execution id bd944084-0bf2-4733-a220-60d70eb725f2. The approval is now used up; presenting it again is refused."
      },
      {
        "type": "text",
        "text": "{\"outcome\":\"executed\",\"requestId\":\"3004e94c-e71e-4ddb-bf41-df6979974a63\",\"approvalId\":\"3004e94c-e71e-4ddb-bf41-df6979974a63\",\"status\":\"executed\",\"riskLevel\":\"critical\",\"requiredRole\":\"security-lead\",\"requestHash\":\"1d610871a6f5418482bd37d7df339e306e8b31143ee521254c2eab029ea0ff21\",\"authorizationExpiresAt\":\"2026-10-01T11:32:00.784Z\",\"executionId\":\"bd944084-0bf2-4733-a220-60d70eb725f2\",\"simulated\":true}"
      }
    ],
    "structuredContent": {
      "outcome": "executed",
      "requestId": "3004e94c-e71e-4ddb-bf41-df6979974a63",
      "approvalId": "3004e94c-e71e-4ddb-bf41-df6979974a63",
      "status": "executed",
      "riskLevel": "critical",
      "requiredRole": "security-lead",
      "requestHash": "1d610871a6f5418482bd37d7df339e306e8b31143ee521254c2eab029ea0ff21",
      "authorizationExpiresAt": "2026-10-01T11:32:00.784Z",
      "executionId": "bd944084-0bf2-4733-a220-60d70eb725f2",
      "simulated": true
    },
    "isError": false,
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "mcp-human-approval-gateway",
        "title": "MCP Human Approval Gateway (research prototype)",
        "version": "0.1.0"
      }
    }
  }
}
```

#### 7. Try to use the same approval a second time

```http
POST /mcp   MCP-Protocol-Version: 2026-07-28   Mcp-Method: tools/call   Mcp-Name: deploy.production
```

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "deploy.production",
    "arguments": {
      "action": "deploy",
      "resource": "service://synthetic/identity-api",
      "environment": "production",
      "dataClassification": "confidential",
      "requestedScopes": [
        "deploy:production"
      ],
      "existingScopes": [],
      "justification": "Deploy a synthetic policy correction after automated tests pass.",
      "context": "Change is reversible but affects identity authorization behavior.",
      "approvalId": "3004e94c-e71e-4ddb-bf41-df6979974a63"
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        "name": "raw-test-client",
        "version": "0.0.1"
      }
    }
  }
}
```

Response, HTTP 200:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "resultType": "complete",
    "content": [
      {
        "type": "text",
        "text": "REFUSED (replay_blocked). This authorization has already been consumed. Nothing was executed."
      },
      {
        "type": "text",
        "text": "{\"outcome\":\"replay_blocked\",\"requestId\":\"3004e94c-e71e-4ddb-bf41-df6979974a63\",\"approvalId\":\"3004e94c-e71e-4ddb-bf41-df6979974a63\",\"status\":\"executed\",\"riskLevel\":\"critical\",\"requiredRole\":\"security-lead\",\"requestHash\":\"1d610871a6f5418482bd37d7df339e306e8b31143ee521254c2eab029ea0ff21\",\"authorizationExpiresAt\":\"2026-10-01T11:32:00.784Z\"}"
      }
    ],
    "structuredContent": {
      "outcome": "replay_blocked",
      "requestId": "3004e94c-e71e-4ddb-bf41-df6979974a63",
      "approvalId": "3004e94c-e71e-4ddb-bf41-df6979974a63",
      "status": "executed",
      "riskLevel": "critical",
      "requiredRole": "security-lead",
      "requestHash": "1d610871a6f5418482bd37d7df339e306e8b31143ee521254c2eab029ea0ff21",
      "authorizationExpiresAt": "2026-10-01T11:32:00.784Z"
    },
    "isError": true,
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "mcp-human-approval-gateway",
        "title": "MCP Human Approval Gateway (research prototype)",
        "version": "0.1.0"
      }
    }
  }
}
```

</details>
