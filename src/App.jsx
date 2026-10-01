import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── Demo mode ────────────────────────────────────────────────────────────────
// When VITE_STATIC_DEMO=true (GitHub Pages build), all /api calls are handled
// by the in-browser demo service — no server, no credentials, no real data.
import { demoApiAdapter } from "./demo/client.js";
import Architecture from "./Architecture.jsx";
const IS_DEMO = import.meta.env.VITE_STATIC_DEMO === "true";

const REVIEWERS = [
  { id: "owner-aria", role: "resource-owner", label: "Aria · Resource owner" },
  { id: "analyst-dev", role: "security-analyst", label: "Dev · Security analyst" },
  { id: "lead-morgan", role: "security-lead", label: "Morgan · Security lead" },
  { id: "viewer-sam", role: "viewer", label: "Sam · Viewer (cannot decide)" },
  { id: "__requester__", role: "security-lead", label: "The requesting agent (self-approval test)" },
];

function newKey() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `ui-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const STATUS_COPY = {
  auto_approved: "Auto-approved",
  pending_human: "Human review",
  approved: "Approved",
  denied: "Denied",
  executing: "Executing",
  executed: "Executed",
  failed: "Failed",
  unknown_outcome: "Unknown outcome",
  expired: "Expired",
  gate_rejected: "Gate rejected",
};

async function api(path, options) {
  // In demo mode, bypass the network entirely and use the browser service.
  if (IS_DEMO) {
    return demoApiAdapter(path, options);
  }

  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.message ?? `Request failed with ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function errorText(error) {
  const code = error?.payload?.code;
  return code ? `${error.message} (${code})` : error.message;
}

function riskTone(level) {
  return ["critical", "high", "medium", "low"].includes(level) ? level : "neutral";
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

const CHAIN_REASON = {
  hash_mismatch: "an event was edited",
  link_broken: "a link between events is broken",
  sequence_gap: "an event is missing or out of order",
  signature_invalid: "a signature does not match",
  anchor_mismatch: "the saved anchor does not match",
};

function formatCountdown(expiresAt, now) {
  if (!expiresAt) return null;
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (remainingMs <= 0) return "Expired";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function shortId(value) {
  return value ? value.slice(0, 8) : "—";
}

function DemoBanner() {
  if (!IS_DEMO) return null;
  return (
    <div
      className="demo-banner"
      role="note"
      aria-label="Demo mode notice"
    >
      <strong>Browser-only synthetic research simulation</strong>
      {" — "}
      no production systems, credentials or company data.
      Synthetic state is stored only in this browser. Use Reset Lab to remove it.
    </div>
  );
}

const SITE_URL = "https://roshantrivedi.co.in/";
const CASE_STUDY_URL = "https://roshantrivedi.co.in/case-studies/agentic-ai-identity-governance/";
const MCP_DOCS_URL = "https://github.com/trivediroshan1-ui/mcp-human-approval-gateway/blob/main/docs/MCP.md";

function SiteBar() {
  return (
    <nav className="site-bar" aria-label="Site links">
      <a href={SITE_URL}>&larr; roshantrivedi.co.in</a>
      <a href={CASE_STUDY_URL}>How this fits agent identity governance</a>
    </nav>
  );
}

const NOT_PROVEN = [
  [
    "Reviewers are simulated",
    "You pick a name from a list. There is no login, so nothing here proves who a reviewer is or that they hold the role they claim.",
  ],
  [
    "Injection detection is a heuristic",
    "It matches known phrases after folding case and spacing. A paraphrase, another language or an encoded payload gets past it. What holds is that context never grants anything and sensitive actions still go to a person.",
  ],
  [
    "The tools are synthetic",
    "Running one prints a message. No real system is touched, so this says nothing about behaviour, latency or failure against real tools.",
  ],
  [
    "Demo mode is unauthenticated",
    "Whoever reaches the page or the MCP endpoint is treated as the agent. A real deployment needs the MCP authorization flow (OAuth) in front, and reviewer identities from a governed source.",
  ],
  [
    "The hash chain has limits",
    "It exposes edits, gaps and reordering. It does not stop someone who can write the store and rebuild every hash, unless events are signed with a key they lack or the head hash is kept somewhere they cannot reach.",
  ],
  [
    "The MCP server is not in this page",
    IS_DEMO
      ? "This page runs the policy in your browser. The MCP endpoint and stdio server only exist in the Node server, so nothing here speaks MCP."
      : "The same policy also runs in the static browser demo, but only this Node server speaks MCP over POST /mcp and stdio.",
  ],
];

function ProofPanel() {
  return (
    <details className="proof-panel">
      <summary>
        <span>What this demo does not prove</span>
        <small>Six caveats, worth reading before you trust any of it</small>
      </summary>
      <ul>
        {NOT_PROVEN.map(([term, text]) => (
          <li key={term}>
            <strong>{term}.</strong> {text}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Header({ verification, onReset }) {
  const auditValid = verification.valid;
  return (
    <header className="topbar">
      <a className="brand" href="#decision-desk" aria-label="MCP Gateway decision desk">
        <span className="brand-mark">HG</span>
        <span>
          <strong>HumanGate</strong>
          <small>MCP approval gateway</small>
        </span>
      </a>
      <div className="mode-chip">
        <span className="live-dot" aria-hidden="true" />
        {IS_DEMO ? "Browser demo" : "Synthetic research mode"}
      </div>
      <nav className="top-nav" aria-label="Sections">
        <a href="#decision-desk">Lab</a>
        <a href="#architecture">Architecture</a>
        <a href="#limits">Limits</a>
      </nav>
      <div className="header-actions">
        <span className={`chain-state ${auditValid ? "valid" : "invalid"}`}>
          {auditValid
            ? "Audit chain verified"
            : `Audit chain failed at event ${verification.failedSequence ?? "?"}`}
        </span>
        <button className="quiet-button" type="button" onClick={onReset}>
          Reset lab
        </button>
      </div>
    </header>
  );
}

function Hero({ metrics }) {
  return (
    <section className="hero" aria-labelledby="page-title">
      <div>
        <p className="eyebrow">AI recommends · Policy decides · Humans authorize</p>
        <h1 id="page-title">
          Stop risky agent actions <span>before execution.</span>
        </h1>
        <p className="hero-copy">
          A public-safe lab for evaluating MCP tool requests against deterministic
          policy, time-bound human approval and a verifiable decision record.
        </p>
        <p className="hero-links">
          <a href="#architecture">Watch the animated workflow</a>
          <a href="#limits">What this lab does not prove</a>
          <a href={MCP_DOCS_URL} rel="noopener noreferrer">Connect a real MCP client</a>
        </p>
      </div>
      <div className="hero-flow" aria-label="Gateway decision path">
        {[
          ["01", "Agent request", "Untrusted input"],
          ["02", "Policy gate", "Deterministic"],
          ["03", "Human decision", "Accountable"],
          ["04", "Execution guard", "Time-bound"],
        ].map(([number, title, note]) => (
          <div key={number}>
            <span>{number}</span>
            <strong>{title}</strong>
            <small>{note}</small>
          </div>
        ))}
      </div>
      <div className="metric-strip" aria-label="Gateway metrics">
        <div>
          <strong>{metrics.total}</strong>
          <span>Total requests</span>
        </div>
        <div>
          <strong>{metrics.pending}</strong>
          <span>Awaiting humans</span>
        </div>
        <div>
          <strong>{metrics.blocked}</strong>
          <span>Policy blocked</span>
        </div>
        <div>
          <strong>{metrics.executed}</strong>
          <span>Guarded executions</span>
        </div>
      </div>
    </section>
  );
}

function ScenarioCatalog({ scenarios, busy, onLaunch, checks }) {
  return (
    <section className="panel scenario-panel" aria-labelledby="scenario-title">
      <div className="panel-heading">
        <div>
          <p className="section-label">Synthetic test bench</p>
          <h2 id="scenario-title">Attack and access scenarios</h2>
        </div>
        <span>{scenarios.length} ready</span>
      </div>
      <div className="scenario-list">
        {scenarios.map((scenario, index) => (
          <article className="scenario-card" key={scenario.id}>
            <div className="scenario-index">{String(index + 1).padStart(2, "0")}</div>
            <div>
              <h3>{scenario.title}</h3>
              <p>{scenario.description}</p>
              <span className="expected">Expected · {scenario.expected}</span>
              {checks[scenario.id] && (
                <span className={`check-line ${checks[scenario.id].ok ? "ok" : "bad"}`}>
                  {checks[scenario.id].ok
                    ? "Last run matched the expected outcome"
                    : `Last run differed: ${checks[scenario.id].detail}`}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => onLaunch(scenario.id)}
              disabled={busy}
              aria-label={`Run ${scenario.title} scenario`}
            >
              Run
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function RequestQueue({ requests, selectedId, onSelect }) {
  return (
    <section className="panel queue-panel" aria-labelledby="queue-title">
      <div className="panel-heading">
        <div>
          <p className="section-label">Decision queue</p>
          <h2 id="queue-title">Policy evaluations</h2>
        </div>
        <span>Newest first</span>
      </div>
      {requests.length === 0 ? (
        <div className="empty-state">
          <strong>No requests yet</strong>
          <p>Run a synthetic scenario to create the first evaluation.</p>
        </div>
      ) : (
        <div className="request-list">
          {requests.map((request) => (
            <button
              className={`request-row ${selectedId === request.id ? "selected" : ""}`}
              key={request.id}
              type="button"
              onClick={() => onSelect(request.id)}
            >
              <span className={`risk-orb ${riskTone(request.riskLevel)}`} aria-hidden="true" />
              <span className="request-main">
                <strong>{request.toolId}</strong>
                <small>
                  {request.actorId} · {request.action}
                </small>
              </span>
              <span className={`status-badge status-${request.status}`}>
                {STATUS_COPY[request.status] ?? request.status}
              </span>
              <span className={`score score-${riskTone(request.riskLevel)}`}>
                {request.riskScore}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function DecisionPanel({
  request,
  reviewer,
  setReviewer,
  reason,
  setReason,
  busy,
  onDecide,
  onExecute,
  onReplay,
  onAdvance,
  onRetry,
  onReconcile,
  fault,
  onFault,
  clockOffset,
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const labNow = now + (clockOffset ?? 0);

  if (!request) {
    return (
      <section className="panel detail-panel empty-detail" aria-live="polite">
        <div className="target-ring" aria-hidden="true">
          <span />
        </div>
        <strong>Select an evaluation</strong>
        <p>Policy evidence, AI analysis and the human decision gate will appear here.</p>
      </section>
    );
  }

  const canDecide = request.status === "pending_human";
  const canExecute = ["approved", "auto_approved"].includes(request.status);
  const countdownLabel = canExecute
    ? formatCountdown(request.authorizationExpiresAt, labNow)
    : null;
  const isExpired = countdownLabel === "Expired";

  return (
    <section className="panel detail-panel" aria-labelledby="decision-title">
      <div className="decision-header">
        <div>
          <p className="section-label">Request {shortId(request.id)}</p>
          <h2 id="decision-title">{request.toolId}</h2>
          <p>{request.justification}</p>
        </div>
        <div className={`risk-gauge ${riskTone(request.riskLevel)}`}>
          <strong>{request.riskScore}</strong>
          <span>{request.riskLevel} risk</span>
        </div>
      </div>

      <div className="facts-grid">
        <div>
          <span>Actor</span>
          <strong>{request.actorId}</strong>
        </div>
        <div>
          <span>Action</span>
          <strong>{request.action}</strong>
        </div>
        <div>
          <span>Environment</span>
          <strong>{request.environment}</strong>
        </div>
        <div>
          <span>Data class</span>
          <strong>{request.dataClassification}</strong>
        </div>
        <div className="fact-wide">
          <span>Resource</span>
          <strong>{request.resource}</strong>
        </div>
        <div className="fact-wide">
          <span>Request hash (the approval is bound to this)</span>
          <strong className="mono" title={request.requestHash}>
            {request.requestHash ? `${request.requestHash.slice(0, 24)}…` : "—"}
          </strong>
        </div>
      </div>

      {(request.context || (request.arguments && Object.keys(request.arguments).length > 0)) && (
        <div className="untrusted-card">
          <div className="card-label">
            Untrusted input from the agent
            <span>Data, never instructions</span>
          </div>
          {request.context && <blockquote>{request.context}</blockquote>}
          {request.arguments && Object.keys(request.arguments).length > 0 && (
            <pre>{JSON.stringify(request.arguments, null, 2)}</pre>
          )}
        </div>
      )}

      <div className="decision-columns">
        <div className="evidence-card">
          <div className="card-label">
            Deterministic policy
            <span className={`status-badge status-${request.status}`}>
              {STATUS_COPY[request.status] ?? request.status}
            </span>
          </div>
          <ul>
            {request.policyReasons.map((reasonItem) => (
              <li key={reasonItem}>{reasonItem}</li>
            ))}
          </ul>
          {request.approvalRole && (
            <p className="required-role">
              Required authority <strong>{request.approvalRole}</strong>
            </p>
          )}
        </div>

        <div className="evidence-card ai-card">
          <div className="card-label">
            AI analysis
            <span>Advisory only</span>
          </div>
          <p className={`analyst-kind ${request.aiAnalysis?.modelCalled ? "model" : "sim"}`}>
            {request.aiAnalysis?.modelCalled
              ? `Model output (${request.aiAnalysis.provider}). It cannot change the decision.`
              : "Simulated analyst: fixed rules wrote this text. No language model was called."}
          </p>
          <p className="ai-summary">{request.aiAnalysis?.summary}</p>
          {request.aiAnalysis?.decisionPackage?.complete === false ? (
            <p className="ai-summary" style={{ color: "var(--red)" }}>
              No decision package supplied - the agent stated no options, no
              recommendation and no confidence level before asking for a human decision.
            </p>
          ) : (
            <>
              {request.aiAnalysis?.optionsConsidered?.length > 0 && (
                <>
                  <h3>Options considered</h3>
                  <ul>
                    {request.aiAnalysis.optionsConsidered.map((option) => (
                      <li key={option}>{option}</li>
                    ))}
                  </ul>
                </>
              )}
              {request.aiAnalysis?.recommendation && (
                <div className="decision-package-line">
                  <span>Recommendation</span>
                  <strong>{request.aiAnalysis.recommendation}</strong>
                  {request.aiAnalysis?.confidence && (
                    <span className={`confidence-chip ${request.aiAnalysis.confidence}`}>
                      {request.aiAnalysis.confidence} confidence
                    </span>
                  )}
                </div>
              )}
            </>
          )}
          {request.aiAnalysis?.questions?.length > 0 && (
            <>
              <h3>Questions for the reviewer</h3>
              <ol>
                {request.aiAnalysis.questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ol>
            </>
          )}
          <small>Provider · {request.aiAnalysis?.provider}</small>
        </div>
      </div>

      {canDecide && (
        <div className="approval-desk">
          <div>
            <p className="section-label">Human decision gate</p>
            <h3>Approve or stop this action</h3>
          </div>
          <label>
            Reviewer
            <select
              value={`${reviewer.id}|${reviewer.role}`}
              onChange={(event) => {
                const [id, role] = event.target.value.split("|");
                setReviewer({ id, role });
              }}
            >
              {REVIEWERS.map((candidate) => (
                <option key={candidate.id} value={`${candidate.id}|${candidate.role}`}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
          <label className="reason-field">
            Decision rationale
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain the evidence, minimum scope and rollback decision."
              rows={3}
            />
          </label>
          <div className="decision-actions">
            <button
              className="deny-button"
              type="button"
              disabled={busy || reason.trim().length < 12}
              onClick={() => onDecide("deny")}
            >
              Deny request
            </button>
            <button
              className="approve-button"
              type="button"
              disabled={busy || reason.trim().length < 12}
              onClick={() => onDecide("approve")}
            >
              Approve time-bound access
            </button>
          </div>
        </div>
      )}

      {canExecute && (
        <div className="execution-gate">
          <div>
            <span className="live-dot" aria-hidden="true" />
            <p>
              {isExpired ? (
                <>
                  Authorization <strong style={{ color: "var(--red)" }}>expired</strong>
                </>
              ) : (
                <>
                  Expires in <strong>{countdownLabel}</strong> · {formatTime(request.authorizationExpiresAt)}
                </>
              )}
            </p>
          </div>
          <button type="button" disabled={busy || isExpired} onClick={onExecute}>
            Execute synthetic action
          </button>
        </div>
      )}

      {IS_DEMO && canExecute && (
        <div className="lab-strip">
          <span>Lab downstream</span>
          <p>Make the fake tool misbehave, to test a lost response.</p>
          <div>
            <select aria-label="Downstream fault" value={fault} onChange={(event) => onFault(event.target.value)}>
              <option value="none">Works normally</option>
              <option value="timeout_after_effect">Runs, but the answer is lost</option>
              <option value="timeout_before_effect">Never runs, answer lost</option>
              <option value="fail">Fails cleanly</option>
            </select>
          </div>
        </div>
      )}

      {IS_DEMO && canExecute && (
        <div className="lab-strip">
          <span>Lab clock</span>
          <p>Authorizations expire on the clock. Move it forward to watch the guard refuse an old one.</p>
          <div>
            {[11, 31, 61].map((minutes) => (
              <button key={minutes} type="button" disabled={busy} onClick={() => onAdvance(minutes)}>
                +{minutes} min
              </button>
            ))}
          </div>
        </div>
      )}

      {request.execution?.executionId || ["executed", "executing", "failed", "unknown_outcome"].includes(request.status) ? (
        <div className={`executed-callout exec-${request.status}`} data-testid="execution-card">
          <strong>
            {request.status === "executed" && "Execution consumed"}
            {request.status === "executing" && "Executing, outcome not confirmed yet"}
            {request.status === "failed" && "Execution failed"}
            {request.status === "unknown_outcome" && "Unknown outcome, needs a human"}
          </strong>
          <span>
            Execution {shortId(request.executionId)} · state {request.status}
          </span>
          {request.execution?.idempotencyKey && <span>Idempotency key {request.execution.idempotencyKey}</span>}
          {request.execution?.resultDigest && <span>Result digest {request.execution.resultDigest.slice(0, 16)}...</span>}
          {request.execution?.reconciled && (
            <span>
              Reconciled by {request.execution.reconciled.by}: {request.execution.reconciled.reason}
            </span>
          )}
          {request.status === "unknown_outcome" && (
            <span>
              The gateway cannot tell whether the tool ran, so it will not run it again. Check the downstream system,
              then record what you found.
            </span>
          )}
          <div className="exec-actions">
            <button type="button" disabled={busy} onClick={() => onRetry(true)}>
              Retry, same key (lost response)
            </button>
            <button type="button" disabled={busy} onClick={() => onRetry(false)}>
              Retry with a new key
            </button>
            <button type="button" disabled={busy} onClick={onReplay}>
              Try to replay it
            </button>
            {IS_DEMO && request.status === "executing" && (
              <button type="button" disabled={busy} onClick={() => onAdvance(6)}>
                Wait 6 min (lab clock)
              </button>
            )}
          </div>
          {request.status === "unknown_outcome" && (
            <div className="exec-actions reconcile-form">
              <label>
                Reviewer
                <select
                  value={`${reviewer.id}|${reviewer.role}`}
                  onChange={(event) => {
                    const [id, role] = event.target.value.split("|");
                    setReviewer({ id, role });
                  }}
                >
                  {REVIEWERS.map((candidate) => (
                    <option key={candidate.id} value={`${candidate.id}|${candidate.role}`}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="reason-field">
                What did you find downstream?
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
              </label>
              <button type="button" disabled={busy || reason.trim().length < 12} onClick={() => onReconcile("executed")}>
                Record: it ran
              </button>
              <button type="button" disabled={busy || reason.trim().length < 12} onClick={() => onReconcile("failed")}>
                Record: it did not run
              </button>
              <small>Needs 12+ characters. The requester cannot reconcile their own call.</small>
            </div>
          )}
        </div>
      ) : null}

      {request.status === "gate_rejected" && (
        <div className="gate-callout">
          <strong>Decision-package gate rejected this handoff</strong>
          <p>{request.aiAnalysis?.decisionPackage?.gap}</p>
          <p>
            Policy would have required <strong>{request.approvalRole}</strong> review -
            but the request was bounced back to the agent before a human ever saw it.
          </p>
        </div>
      )}
    </section>
  );
}

function auditSummary(event) {
  if (event.payload?.source !== "mcp") return event.actor;
  const parts = [event.actor, event.payload.method, event.payload.tool, event.payload.outcome];
  return parts.filter(Boolean).join(" · ");
}

function AuditTrail({ events, verification, onTamper, onDownload, busy }) {
  return (
    <section className="panel audit-panel" aria-labelledby="audit-title">
      <div className="panel-heading">
        <div>
          <p className="section-label">Hash-chained evidence</p>
          <h2 id="audit-title">Decision record</h2>
        </div>
        <div className="panel-tools">
          <span>
            {verification.valid
              ? `${verification.checkedEvents ?? 0} events verified`
              : `Broken at event ${verification.failedSequence}`}
          </span>
          <button className="download-button" type="button" disabled={busy} onClick={onDownload}>
            Download audit log
          </button>
        </div>
      </div>
      <p className={`chain-line ${verification.valid ? "valid" : "invalid"}`} role="status">
        {verification.valid ? (
          <>
            Head <code>{(verification.headHash ?? "").slice(0, 16)}</code> at event{" "}
            {verification.headSequence ?? 0} ·{" "}
            {verification.signed ? "HMAC-signed" : "unsigned (no key configured)"}
          </>
        ) : (
          <>
            Verification failed: {CHAIN_REASON[verification.reason] ?? "the chain does not verify"} at
            event {verification.failedSequence}. Reset the lab to start a clean chain.
          </>
        )}
      </p>
      <div className="audit-list">
        {events.length === 0 ? (
          <p>No audit events.</p>
        ) : (
          events.slice(0, 18).map((event) => (
            <article
              key={event.eventId}
              className={!verification.valid && event.sequence === verification.failedSequence ? "broken" : ""}
            >
              <span className="audit-sequence">{String(event.sequence).padStart(3, "0")}</span>
              <div>
                <strong>
                  {event.eventType}
                  {event.payload?.source === "mcp" && (
                    <span className="source-badge" title="This event came in through the MCP server">
                      mcp
                    </span>
                  )}
                </strong>
                <p>{auditSummary(event)}</p>
              </div>
              <time>{formatTime(event.createdAt)}</time>
              <code>{event.eventHash.slice(0, 12)}</code>
            </article>
          ))
        )}
      </div>
      {IS_DEMO && (
        <div className="lab-strip">
          <span>Tamper test</span>
          <p>
            Edit one stored event without recomputing any hash, the way a careless attacker would.
            Verification should fail at exactly that event.
          </p>
          <div>
            <button type="button" disabled={busy || events.length === 0} onClick={onTamper}>
              Edit a stored event
            </button>
          </div>
        </div>
      )}
      <p className="audit-note">
        Each event hash covers the one before it, so edits, gaps and reordering are detected. A
        plain hash chain does not stop someone who can write the store and rebuild every hash. That
        needs a signing key or a head hash saved somewhere the writer cannot reach. The browser demo
        has neither, so treat it as an illustration.{" "}
        {IS_DEMO
          ? "The MCP server is not part of this page, so no events labelled mcp appear here."
          : "Calls that arrive through the MCP server are labelled mcp."}
      </p>
    </section>
  );
}

function Limits() {
  const items = [
    ["Synthetic data only", "Every tool, resource, identity and action here is made up. Nothing connects to a real system."],
    ["Simulated reviewers", "Reviewers are picked from a list and their role is whatever the list says. There is no login. A real deployment needs authenticated people and roles from a governed source."],
    ["Simulated analyst", "Unless a server is configured with a model, the AI analyst is a fixed set of rules that rewords the policy result. No model runs and nothing is learned from the request."],
    ["Heuristic injection check", "The phrase scan catches obvious attempts and common disguises. A paraphrase, another language or an encoded payload gets past it. The real protection is that context is treated as data, policy never reads it for permission, and anything sensitive still goes to a person."],
    ["Tamper-evident, not tamper-proof", "The hash chain exposes edits, gaps and reordering. A writer who can rebuild every hash is not stopped unless events are signed with a key they lack or the head hash is saved elsewhere. The browser demo has neither."],
    ["MCP is server-only", "The MCP endpoint (POST /mcp) and the stdio server run only in the Node server. The static browser demo does not speak MCP. It runs the same policy code so you can see the decisions."],
    ["Unauthenticated MCP identity", "Over MCP the caller is recorded as a configured agent id plus whatever clientInfo it declares. Nothing verifies either. A real deployment puts the MCP authorization flow (OAuth) in front and takes the identity from the token."],
    ["Not a production control", "State in the browser demo lives in localStorage and anyone can change it. The enforcement point here is code you are reading, not a boundary in front of a real tool."],
  ];
  return (
    <section className="panel limits-panel" id="limits" aria-labelledby="limits-title">
      <div className="panel-heading">
        <div>
          <p className="section-label">Read this before trusting any of it</p>
          <h2 id="limits-title">Limits and honest caveats</h2>
        </div>
      </div>
      <dl className="limits-list">
        {items.map(([term, text]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const TOUR_STEPS = [
  {
    title: "A safe request",
    text: "A low-risk search of public documentation. Policy allows it straight away, so no person is needed.",
    action: "Run it",
  },
  {
    title: "A risky request",
    text: "An agent asks to deploy to production. This needs a security lead, and nothing runs until a person decides.",
    action: "Send the request",
  },
  {
    title: "A person approves",
    text: "Morgan, a security lead, approves with a reason. The approval is tied to this exact request and lasts ten minutes.",
    action: "Approve as Morgan",
  },
  {
    title: "Run it, then replay it",
    text: "The guard runs the approved action once. Showing the same approval a second time is refused.",
    action: "Execute, then replay",
  },
  {
    title: "An injection attempt",
    text: "A ticket tries to talk the agent out of its controls. Policy denies it, because text in context is data and never an instruction.",
    action: "Run the attack",
  },
];

function Walkthrough({ step, busy, onRun, onRestart }) {
  const [open, setOpen] = useState(false);
  const finished = step >= TOUR_STEPS.length;
  return (
    <details className="panel tour-panel" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>
          <strong>Guided walkthrough</strong>
          <small>Five steps, about a minute. Each one runs a real scenario.</small>
        </span>
        <em>{finished ? "Done" : `Step ${step + 1} of ${TOUR_STEPS.length}`}</em>
      </summary>
      <ol className="tour-steps">
        {TOUR_STEPS.map((item, index) => {
          const state = index < step ? "done" : index === step ? "current" : "todo";
          return (
            <li key={item.title} className={`tour-step ${state}`}>
              <span className="tour-index" aria-hidden="true">
                {state === "done" ? "\u2713" : index + 1}
              </span>
              <div>
                <strong>{item.title}</strong>
                <p>{item.text}</p>
              </div>
              {state === "current" && (
                <button type="button" disabled={busy} onClick={onRun}>
                  {item.action}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {finished && (
        <p className="tour-done" role="status">
          That is the whole loop. Try the other scenarios, or read what the demo does not prove.{" "}
          <button type="button" onClick={onRestart}>
            Start over
          </button>
        </p>
      )}
    </details>
  );
}

function App() {
  const [scenarios, setScenarios] = useState([]);
  const [requests, setRequests] = useState([]);
  const [events, setEvents] = useState([]);
  const [verification, setVerification] = useState({ valid: true, checkedEvents: 0 });
  const [selectedId, setSelectedId] = useState(null);
  const [reviewer, setReviewer] = useState({
    id: REVIEWERS[2].id,
    role: REVIEWERS[2].role,
  });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [checks, setChecks] = useState({});
  const [tourStep, setTourStep] = useState(0);
  const [tourRequestId, setTourRequestId] = useState(null);

  const selected = requests.find((request) => request.id === selectedId) ?? null;

  const metrics = useMemo(
    () => ({
      total: requests.length,
      pending: requests.filter((request) => request.status === "pending_human").length,
      blocked: requests.filter((request) => request.status === "denied").length,
      executed: requests.filter((request) => request.status === "executed").length,
    }),
    [requests],
  );

  const refresh = useCallback(async (preferredId = null) => {
    const [requestPayload, auditPayload, verifyPayload] = await Promise.all([
      api("/api/requests"),
      api("/api/audit?limit=100"),
      api("/api/audit/verify"),
    ]);
    setRequests(requestPayload.requests);
    setEvents(auditPayload.events);
    setVerification(verifyPayload);
    if (IS_DEMO) {
      const lab = await api("/api/lab");
      setClockOffset(lab.clockOffsetMs);
    }
    setSelectedId((current) => {
      const desired = preferredId ?? current;
      if (desired && requestPayload.requests.some((request) => request.id === desired)) {
        return desired;
      }
      return requestPayload.requests[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([api("/api/scenarios"), refresh()])
      .then(([payload]) => {
        if (active) setScenarios(payload.scenarios);
      })
      .catch((error) => {
        if (active) setNotice({ type: "error", message: error.message });
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  async function perform(action, successMessage) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      await refresh(result?.request?.id ?? selectedId);
      setReason("");
      const message = typeof successMessage === "function" ? successMessage(result) : successMessage;
      setNotice(
        typeof message === "string" ? { type: "success", message } : message,
      );
    } catch (error) {
      setNotice({ type: "error", message: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  function launchScenario(scenarioId) {
    const scenario = scenarios.find((item) => item.id === scenarioId);
    return perform(
      () =>
        api("/api/requests", {
          method: "POST",
          body: JSON.stringify({ scenarioId }),
        }),
      (result) => {
        const want = scenario?.expect;
        const got = result.request;
        const misses = want
          ? Object.keys(want)
              .filter((key) => key !== "denyCode")
              .filter((key) => got[key] !== want[key])
              .map((key) => `${key} was ${got[key]}, expected ${want[key]}`)
          : [];
        const ok = misses.length === 0;
        setChecks((current) => ({
          ...current,
          [scenarioId]: { ok, detail: misses.join("; ") },
        }));
        return ok
          ? `${scenario?.title ?? "Scenario"}: matches the expected outcome (${scenario?.expected}).`
          : {
              type: "error",
              message: `${scenario?.title ?? "Scenario"} differs from the expected outcome: ${misses.join("; ")}.`,
            };
      },
    );
  }

  function decide(decision) {
    return perform(
      () =>
        api(`/api/requests/${selectedId}/decision`, {
          method: "POST",
          body: JSON.stringify({
            reviewerId: reviewer.id === "__requester__" ? selected.actorId : reviewer.id,
            reviewerRole: reviewer.role,
            decision,
            reason,
          }),
        }),
      decision === "approve"
        ? "Time-bound authorization granted by a human reviewer."
        : "Request denied and recorded.",
    );
  }

  function execute() {
    const key = newKey();
    setFault("none"); // the lab fault is armed for one call only
    return perform(
      () =>
        api(`/api/requests/${selectedId}/execute`, {
          method: "POST",
          body: JSON.stringify({
            requestHash: selected.requestHash,
            actorId: selected.actorId,
            idempotencyKey: key,
          }),
        }),
      (result) =>
        result.execution?.state === "executing"
          ? "Dispatched, but the answer never came back. The state is executing. Retry with the same key."
          : result.execution?.state === "failed"
            ? "The tool failed. The failure is recorded and nothing will be retried on its own."
            : "Synthetic action executed through the guard.",
    );
  }

  async function retry(sameKey) {
    setBusy(true);
    setNotice(null);
    const stored = selected.execution?.idempotencyKey;
    try {
      const result = await api(`/api/requests/${selectedId}/execute`, {
        method: "POST",
        body: JSON.stringify({
          requestHash: selected.requestHash,
          actorId: selected.actorId,
          idempotencyKey: sameKey ? stored : newKey(),
        }),
      });
      setNotice({
        type: sameKey && result.replayed ? "success" : "error",
        message: result.replayed
          ? `Same key: the stored outcome (${result.execution.state}) came back and nothing ran again.`
          : "That call was not recognised as a retry. That would be a bug.",
      });
    } catch (error) {
      const blocked = !sameKey && ["replay_blocked", "binding_mismatch"].includes(error.payload?.code);
      setNotice({
        type: blocked ? "success" : "error",
        message: blocked ? `A new key was refused as expected: ${error.message}` : `Unexpected result: ${errorText(error)}`,
      });
    }
    try {
      await refresh(selectedId);
    } finally {
      setBusy(false);
    }
  }

  function reconcile(outcome) {
    return perform(
      () =>
        api(`/api/executions/${selected.executionId}/reconcile`, {
          method: "POST",
          body: JSON.stringify({
            reviewerId: reviewer.id === "__requester__" ? selected.actorId : reviewer.id,
            reviewerRole: reviewer.role,
            outcome,
            reason,
          }),
        }),
      "Outcome recorded by a named person and added to the audit log.",
    );
  }

  const [fault, setFault] = useState("none");
  function changeFault(value) {
    setFault(value);
    return api("/api/lab/fault", { method: "POST", body: JSON.stringify({ fault: value }) }).catch((error) =>
      setNotice({ type: "error", message: errorText(error) }),
    );
  }

  async function replay() {
    setBusy(true);
    setNotice(null);
    try {
      await api(`/api/requests/${selectedId}/execute`, {
        method: "POST",
        body: JSON.stringify({ requestHash: selected.requestHash, actorId: selected.actorId }),
      });
      setNotice({ type: "error", message: "The replay was not blocked. That would be a bug." });
    } catch (error) {
      const blocked = error.payload?.code === "replay_blocked";
      setNotice({
        type: blocked ? "success" : "error",
        message: blocked
          ? `Replay blocked as expected: ${error.message}`
          : `Unexpected result: ${errorText(error)}`,
      });
    }
    try {
      await refresh(selectedId);
    } finally {
      setBusy(false);
    }
  }

  function advanceClock(minutes) {
    return perform(
      () => api("/api/lab/advance-clock", { method: "POST", body: JSON.stringify({ minutes }) }),
      `Lab clock moved forward ${minutes} minutes. Authorizations older than their window are now expired.`,
    );
  }

  function tamper() {
    return perform(
      () => api("/api/lab/tamper", { method: "POST", body: JSON.stringify({}) }),
      (result) =>
        `Stored event ${result.sequence} was edited without recomputing hashes. Verification should now fail there.`,
    );
  }

  async function downloadAudit() {
    setBusy(true);
    setNotice(null);
    try {
      const [verify, payload] = await Promise.all([api("/api/audit/verify"), api("/api/audit?limit=1000")]);
      const ordered = [...payload.events].sort((a, b) => a.sequence - b.sequence);
      const partial = (verify.checkedEvents ?? ordered.length) > ordered.length;
      const exported = {
        exportedAt: new Date().toISOString(),
        source: IS_DEMO ? "browser demo (state held in this browser only)" : "gateway server",
        verification: verify,
        verificationNote: [
          verify.valid
            ? `The gateway verified the whole chain (${verify.checkedEvents ?? ordered.length} events) at export time and found no break.`
            : `The gateway found a break in the chain at event ${verify.failedSequence} (${verify.reason ?? "unknown reason"}).`,
          "To check it yourself: each eventHash is the SHA-256 of the canonical JSON (keys sorted) of sequence, eventId, requestId, eventType, actor, payload, previousHash and createdAt. Each previousHash must equal the eventHash of the event before it, and the first one uses GENESIS.",
          verify.signed
            ? "Events are signed with an HMAC. Checking the signatures needs the key, which is not in this file."
            : "No signing key was configured, so anyone who can write the store could rebuild the whole chain and it would still verify. Keep the head hash somewhere they cannot reach to catch that.",
          partial ? `This file holds only the latest ${ordered.length} events. The verification above covers the full chain.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        events: ordered,
      };
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `humangate-audit-log-${exported.exportedAt.replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice({ type: "success", message: `Audit log downloaded (${ordered.length} events, chain ${verify.valid ? "verified" : "broken"}).` });
    } catch (error) {
      setNotice({ type: "error", message: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function runTourStep() {
    const submitScenario = (scenarioId) =>
      api("/api/requests", { method: "POST", body: JSON.stringify({ scenarioId }) });
    const tourKey = `tour-${tourRequestId ?? "x"}`;
    const executeBody = (request, key) =>
      JSON.stringify({ requestHash: request.requestHash, actorId: request.actorId, idempotencyKey: key });
    setBusy(true);
    setNotice(null);
    try {
      let result = null;
      let message = "";
      if (tourStep === 0) {
        result = await submitScenario("public-research");
        message = `Policy said "${result.request.policyDecision}" with ${result.request.riskLevel} risk. No human was needed.`;
      } else if (tourStep === 1) {
        result = await submitScenario("production-deployment");
        setTourRequestId(result.request.id);
        message = `Held for ${result.request.approvalRole}. Status is ${result.request.status}, so nothing has run.`;
      } else if (tourStep === 2) {
        result = await api(`/api/requests/${tourRequestId}/decision`, {
          method: "POST",
          body: JSON.stringify({
            reviewerId: "lead-morgan",
            reviewerRole: "security-lead",
            decision: "approve",
            reason: "Walkthrough: scope and duration are the minimum needed for this synthetic change.",
          }),
        });
        message = "Approved. The authorization is bound to this request's hash and expires in minutes.";
      } else if (tourStep === 3) {
        const current = requests.find((item) => item.id === tourRequestId);
        result = await api(`/api/requests/${tourRequestId}/execute`, {
          method: "POST",
          body: executeBody(current, tourKey),
        });
        let replayNote = "The retries were not handled correctly, which would be a bug.";
        let sameKeyOk = false;
        let newKeyBlocked = false;
        try {
          const again = await api(`/api/requests/${tourRequestId}/execute`, { method: "POST", body: executeBody(current, tourKey) });
          sameKeyOk = again.replayed === true;
        } catch {
          sameKeyOk = false;
        }
        try {
          await api(`/api/requests/${tourRequestId}/execute`, { method: "POST", body: executeBody(current, `${tourKey}-other`) });
        } catch (error) {
          newKeyBlocked = error.payload?.code === "replay_blocked";
        }
        if (sameKeyOk && newKeyBlocked) {
          replayNote = "Then the answer was treated as lost: the same key returned the stored result and ran nothing again, and a new key was refused.";
        }
        message = `Executed once (synthetic). ${replayNote}`;
      } else {
        result = await submitScenario("prompt-injection");
        message = `Denied by policy. The injected text was treated as data and gave nothing away.`;
      }
      await refresh(result?.request?.id ?? selectedId);
      setTourStep((value) => value + 1);
      setNotice({ type: "success", message });
    } catch (error) {
      setNotice({ type: "error", message: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    return perform(
      () =>
        api("/api/reset", {
          method: "POST",
          body: JSON.stringify({}),
        }),
      () => {
        setChecks({});
        setTourStep(0);
        setTourRequestId(null);
        return "Synthetic lab reset.";
      },
    );
  }

  return (
    <>
      <DemoBanner />
      <SiteBar />
      <Header verification={verification} onReset={reset} />
      <main id="main-content">
        <ProofPanel />
        <Hero metrics={metrics} />
        {notice && (
          <div className={`notice notice-${notice.type}`} role="status">
            {notice.message}
          </div>
        )}
        <Walkthrough
          step={tourStep}
          busy={busy || scenarios.length === 0}
          onRun={runTourStep}
          onRestart={() => {
            setTourStep(0);
            setTourRequestId(null);
          }}
        />
        <div className="workspace" id="decision-desk">
          <ScenarioCatalog scenarios={scenarios} busy={busy} onLaunch={launchScenario} checks={checks} />
          <RequestQueue
            requests={requests}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setReason("");
            }}
          />
          <DecisionPanel
            request={selected}
            reviewer={reviewer}
            setReviewer={setReviewer}
            reason={reason}
            setReason={setReason}
            busy={busy}
            onDecide={decide}
            onExecute={execute}
            onReplay={replay}
            onAdvance={advanceClock}
            onRetry={retry}
            onReconcile={reconcile}
            fault={fault}
            onFault={changeFault}
            clockOffset={clockOffset}
          />
          <AuditTrail
            events={events}
            verification={verification}
            onTamper={tamper}
            onDownload={downloadAudit}
            busy={busy}
          />
        </div>
        <Architecture scenarios={scenarios} selectedRequest={selected} />
        <Limits />
      </main>
      <footer>
        <div>
          <strong>HumanGate</strong>
          <span>Public-safe MCP security research prototype</span>
        </div>
        <p>
          Synthetic actions only · AI output is advisory · Human decisions are
          accountable
        </p>
      </footer>
    </>
  );
}

export default App;
