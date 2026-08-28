import { useCallback, useEffect, useMemo, useState } from "react";

// ─── Demo mode ────────────────────────────────────────────────────────────────
// When VITE_STATIC_DEMO=true (GitHub Pages build), all /api calls are handled
// by the in-browser demo service — no server, no credentials, no real data.
import { demoApiAdapter } from "./demo/client.js";
const IS_DEMO = import.meta.env.VITE_STATIC_DEMO === "true";

const REVIEWERS = [
  { id: "owner-aria", role: "resource-owner", label: "Aria · Resource owner" },
  { id: "analyst-dev", role: "security-analyst", label: "Dev · Security analyst" },
  { id: "lead-morgan", role: "security-lead", label: "Morgan · Security lead" },
];

const STATUS_COPY = {
  auto_approved: "Auto-approved",
  pending_human: "Human review",
  approved: "Approved",
  denied: "Denied",
  executed: "Executed",
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

function Header({ auditValid, onReset }) {
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
      <div className="header-actions">
        <span className={`chain-state ${auditValid ? "valid" : "invalid"}`}>
          Audit chain {auditValid ? "verified" : "failed"}
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

function ScenarioCatalog({ scenarios, busy, onLaunch }) {
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
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

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
    ? formatCountdown(request.authorizationExpiresAt, now)
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
      </div>

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

      {request.status === "executed" && (
        <div className="executed-callout">
          <strong>Execution consumed</strong>
          <span>
            Replay protection active · execution {shortId(request.executionId)}
          </span>
        </div>
      )}

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

function AuditTrail({ events, verification }) {
  return (
    <section className="panel audit-panel" aria-labelledby="audit-title">
      <div className="panel-heading">
        <div>
          <p className="section-label">Hash-chained evidence</p>
          <h2 id="audit-title">Decision record</h2>
        </div>
        <span>{verification.checkedEvents ?? 0} events verified</span>
      </div>
      <div className="audit-list">
        {events.length === 0 ? (
          <p>No audit events.</p>
        ) : (
          events.slice(0, 18).map((event) => (
            <article key={event.eventId}>
              <span className="audit-sequence">{String(event.sequence).padStart(3, "0")}</span>
              <div>
                <strong>{event.eventType}</strong>
                <p>{event.actor}</p>
              </div>
              <time>{formatTime(event.createdAt)}</time>
              <code>{event.eventHash.slice(0, 12)}</code>
            </article>
          ))
        )}
      </div>
      <p className="audit-note">
        The SHA-256 chain makes accidental or unsophisticated modification detectable. It
        is not a substitute for externally anchored, append-only production logging.
      </p>
    </section>
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
      setNotice({ type: "success", message: successMessage });
    } catch (error) {
      setNotice({ type: "error", message: error.message });
    } finally {
      setBusy(false);
    }
  }

  function launchScenario(scenarioId) {
    return perform(
      () =>
        api("/api/requests", {
          method: "POST",
          body: JSON.stringify({ scenarioId }),
        }),
      "Scenario evaluated. Policy and AI evidence are ready.",
    );
  }

  function decide(decision) {
    return perform(
      () =>
        api(`/api/requests/${selectedId}/decision`, {
          method: "POST",
          body: JSON.stringify({
            reviewerId: reviewer.id,
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
    return perform(
      () =>
        api(`/api/requests/${selectedId}/execute`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
      "Synthetic action executed through the guard.",
    );
  }

  function reset() {
    return perform(
      () =>
        api("/api/reset", {
          method: "POST",
          body: JSON.stringify({}),
        }),
      "Synthetic lab reset.",
    );
  }

  return (
    <>
      <DemoBanner />
      <Header auditValid={verification.valid} onReset={reset} />
      <main id="main-content">
        <Hero metrics={metrics} />
        {notice && (
          <div className={`notice notice-${notice.type}`} role="status">
            {notice.message}
          </div>
        )}
        <div className="workspace" id="decision-desk">
          <ScenarioCatalog scenarios={scenarios} busy={busy} onLaunch={launchScenario} />
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
          />
          <AuditTrail events={events} verification={verification} />
        </div>
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
