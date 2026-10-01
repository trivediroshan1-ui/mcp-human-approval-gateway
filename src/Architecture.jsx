import { useEffect, useMemo, useRef, useState } from "react";
import { EDGES, NODES, STEPS, planRequest, planScenario } from "./architecture-model.js";

// Two separate layouts. The wide one is a two-row snake with the audit chain
// between the rows. The narrow one is a single tall column, so the text stays
// readable at 390px instead of shrinking a 1190px drawing.

const WIDE = {
  w: 1190,
  h: 420,
  nodes: {
    analyst: { x: 620, y: 6, w: 146, h: 60 },
    agent: { x: 8, y: 110, w: 146, h: 76 },
    gateway: { x: 212, y: 110, w: 146, h: 76 },
    registry: { x: 416, y: 110, w: 146, h: 76 },
    policy: { x: 620, y: 110, w: 146, h: 76 },
    decision: { x: 824, y: 110, w: 146, h: 76 },
    denied: { x: 1028, y: 110, w: 146, h: 76 },
    gate: { x: 1028, y: 322, w: 146, h: 76 },
    reviewer: { x: 620, y: 322, w: 146, h: 76 },
    authz: { x: 416, y: 322, w: 146, h: 76 },
    guard: { x: 212, y: 322, w: 146, h: 76 },
    tool: { x: 8, y: 322, w: 146, h: 76 },
  },
  edges: {
    e1: { pts: [[154, 148], [212, 148]], badge: [183, 148], label: [183, 133] },
    e2: { pts: [[358, 148], [416, 148]], badge: [387, 148], label: [387, 133] },
    e3: { pts: [[562, 148], [620, 148]], badge: [591, 148], label: [591, 133] },
    e4: { pts: [[693, 110], [693, 66]], badge: [693, 88], label: [705, 92], anchor: "start" },
    e5: { pts: [[766, 148], [824, 148]], badge: [795, 148], label: [795, 133] },
    e6c: { pts: [[970, 148], [1028, 148]], badge: [999, 148], label: [999, 133] },
    e6b: { pts: [[950, 186], [950, 205], [1101, 205], [1101, 322]], badge: [1101, 262], label: [1113, 266], anchor: "start" },
    e6a: { pts: [[910, 186], [910, 205], [489, 205], [489, 322]], badge: [700, 205], label: [700, 196] },
    e7: { pts: [[1028, 360], [766, 360]], badge: [897, 360], label: [897, 345] },
    e8: { pts: [[620, 360], [562, 360]], badge: [591, 360], label: [591, 345] },
    e9: { pts: [[416, 360], [358, 360]], badge: [387, 360], label: [387, 345] },
    e10: { pts: [[212, 360], [154, 360]], badge: [183, 360], label: [183, 345] },
  },
  band: {
    label: { x: 8, y: 228, w: 124, h: 48 },
    cells: [
      { x: 140, y: 228, w: 161, h: 48 },
      { x: 309, y: 228, w: 161, h: 48 },
      { x: 510, y: 228, w: 148, h: 48 },
      { x: 667, y: 228, w: 148, h: 48 },
      { x: 824, y: 228, w: 148, h: 48 },
    ],
    links: [[301, 252, 309, 252], [470, 252, 510, 252], [658, 252, 667, 252], [815, 252, 824, 252]],
  },
  taps: [
    { node: "gateway", pts: [[242, 186], [242, 228]] },
    { node: "policy", pts: [[650, 186], [650, 228]] },
    { node: "reviewer", pts: [[650, 322], [650, 276]] },
    { node: "guard", pts: [[242, 322], [242, 276]] },
  ],
};

const NARROW = {
  w: 360,
  h: 1094,
  nodes: {
    agent: { x: 34, y: 10, w: 190, h: 52 },
    gateway: { x: 34, y: 96, w: 190, h: 52 },
    registry: { x: 34, y: 182, w: 190, h: 52 },
    policy: { x: 34, y: 268, w: 190, h: 52 },
    analyst: { x: 268, y: 268, w: 82, h: 40 },
    decision: { x: 34, y: 354, w: 190, h: 64 },
    denied: { x: 268, y: 360, w: 82, h: 40 },
    gate: { x: 34, y: 452, w: 190, h: 52 },
    reviewer: { x: 34, y: 538, w: 190, h: 52 },
    authz: { x: 34, y: 624, w: 190, h: 52 },
    guard: { x: 34, y: 710, w: 190, h: 52 },
    tool: { x: 34, y: 796, w: 190, h: 52 },
  },
  edges: {
    e1: { pts: [[129, 62], [129, 96]], badge: [129, 79], label: [145, 83], anchor: "start" },
    e2: { pts: [[129, 148], [129, 182]], badge: [129, 165], label: [145, 169], anchor: "start" },
    e3: { pts: [[129, 234], [129, 268]], badge: [129, 251], label: [145, 255], anchor: "start" },
    e4: { pts: [[224, 288], [268, 288]], badge: [246, 288], label: [246, 316] },
    e5: { pts: [[129, 320], [129, 354]], badge: [129, 337], label: [145, 341], anchor: "start" },
    e6c: { pts: [[224, 380], [268, 380]], badge: [246, 380], label: [246, 408] },
    e6b: { pts: [[129, 418], [129, 452]], badge: [129, 435], label: [145, 439], anchor: "start" },
    e6a: { pts: [[34, 386], [14, 386], [14, 650], [34, 650]], badge: [14, 470], label: [28, 570], rotate: true },
    e7: { pts: [[129, 504], [129, 538]], badge: [129, 521], label: [145, 525], anchor: "start" },
    e8: { pts: [[129, 590], [129, 624]], badge: [129, 607], label: [145, 611], anchor: "start" },
    e9: { pts: [[129, 676], [129, 710]], badge: [129, 693], label: [145, 697], anchor: "start" },
    e10: { pts: [[129, 762], [129, 796]], badge: [129, 779], label: [145, 783], anchor: "start" },
  },
  band: {
    label: { x: 34, y: 868, w: 300, h: 0 },
    cells: [886, 924, 962, 1000, 1038].map((y) => ({ x: 34, y, w: 300, h: 30 })),
    links: [],
  },
  taps: [
    { node: "gateway", pts: [[224, 142], [352, 142]] },
    { node: "policy", pts: [[224, 314], [352, 314]] },
    { node: "reviewer", pts: [[224, 584], [352, 584]] },
    { node: "guard", pts: [[224, 756], [352, 756]] },
  ],
  spine: [[352, 142], [352, 900], [334, 900]],
};

const SLOT_LABELS = ["request.submitted", "policy.*", "ai.analysis", "human / gate", "executed"];

function pathData(pts) {
  return pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
}

function useMedia(query) {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

function stepOfTick(tick) {
  return tick.audit ? 11 : EDGES[tick.edge].step;
}

export default function Architecture({ scenarios, selectedRequest }) {
  const narrow = useMedia("(max-width: 1000px)");
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const layout = narrow ? NARROW : WIDE;

  const [choice, setChoice] = useState("follow");
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(true);

  const followable = Boolean(selectedRequest);
  const effective = choice === "follow" && !followable ? scenarios[0]?.id ?? "" : choice;
  const scenario = scenarios.find((item) => item.id === effective) ?? null;

  const route = useMemo(() => {
    if (effective === "follow" && selectedRequest) return planRequest(selectedRequest);
    if (scenario) return planScenario(scenario);
    return null;
  }, [effective, selectedRequest, scenario]);

  const routeKey = route ? `${effective}|${route.stop}|${route.tone}|${route.ticks.length}|${route.edges.join(",")}` : "none";
  useEffect(() => {
    setTick(0);
  }, [routeKey]);

  const total = route ? route.ticks.length : 0;
  const autoplay = playing && !reduced;

  useEffect(() => {
    if (!route || !autoplay) return undefined;
    const atEnd = tick >= total;
    const timer = setTimeout(() => setTick(atEnd ? 0 : tick + 1), atEnd ? 3600 : tick === 0 ? 1200 : 1700);
    return () => clearTimeout(timer);
  }, [autoplay, route, tick, total]);

  // Move the token along the edge that was just traversed.
  const motionRef = useRef(null);
  useEffect(() => {
    const motion = motionRef.current;
    if (!motion || !route) return;
    const moving = route.ticks[tick - 1];
    let pts;
    let duration = "0.001s";
    if (tick === 0) {
      pts = [layout.edges.e1.pts[0]];
    } else if (moving?.edge) {
      pts = layout.edges[moving.edge].pts.slice();
      if (moving.reverse) pts.reverse();
      if (!reduced) duration = "1.05s";
    } else {
      const last = route.ticks.slice(0, tick).filter((t) => t.edge).at(-1);
      const edgePts = last ? layout.edges[last.edge].pts.slice() : [layout.edges.e1.pts[0]];
      if (last?.reverse) edgePts.reverse();
      pts = [edgePts.at(-1)];
    }
    if (pts.length === 1) pts = [pts[0], pts[0]];
    motion.setAttribute("path", pathData(pts));
    motion.setAttribute("dur", duration);
    try {
      motion.beginElement();
    } catch {
      // SMIL is unavailable: the token is simply not animated.
    }
  }, [tick, route, layout, reduced]);

  if (!route) return null;

  const traversed = route.ticks.slice(0, tick).filter((t) => t.edge);
  const reachedNodes = new Set(["agent"]);
  for (const t of traversed) {
    const edge = EDGES[t.edge];
    reachedNodes.add(edge.from);
    reachedNodes.add(edge.to);
  }
  const usedEdges = new Set(route.edges);
  const usedNodes = new Set(["agent"]);
  for (const id of route.edges) {
    usedNodes.add(EDGES[id].from);
    usedNodes.add(EDGES[id].to);
  }
  const currentTick = tick > 0 ? route.ticks[tick - 1] : null;
  const currentEdge = currentTick?.edge ?? null;
  const currentNode = currentTick?.edge
    ? currentTick.reverse
      ? EDGES[currentTick.edge].from
      : EDGES[currentTick.edge].to
    : tick > 0
      ? route.stop
      : "agent";
  const finished = tick >= total;
  const activeStep = currentTick ? stepOfTick(currentTick) : 1;
  const stepsOnRoute = new Set(route.ticks.map(stepOfTick));
  const stopStep = stepOfTick(route.ticks.filter((t) => t.edge).at(-1) ?? { audit: true });
  const litEvents = new Map(route.events.filter((e) => e.afterTick <= tick).map((e) => [e.slot, e.label]));
  const futureEvents = new Map(route.events.map((e) => [e.slot, e.label]));

  function nodeClass(id) {
    const classes = ["arch-node"];
    if (!usedNodes.has(id)) classes.push("off");
    if (reachedNodes.has(id)) classes.push("reached");
    if (currentNode === id && tick > 0) classes.push("current");
    if (finished && route.stop === id) classes.push(`stop-${route.tone}`);
    if (id === "analyst") classes.push("advisory");
    if (id === "denied") classes.push("terminal");
    return classes.join(" ");
  }

  function edgeClass(id) {
    const edge = EDGES[id];
    const classes = ["arch-edge"];
    if (edge.dashed) classes.push("dashed");
    if (edge.danger) classes.push("danger");
    if (usedEdges.has(id)) classes.push("planned");
    if (traversed.some((t) => t.edge === id)) classes.push("done");
    if (currentEdge === id && !finished && !reduced) classes.push("flow");
    return classes.join(" ");
  }

  const scenarioLabel = effective === "follow" ? "the selected request" : scenario?.title;
  const toneWord = { ok: "Reaches the tool", blocked: "Stops", waiting: "Waiting" }[route.tone];
  const stopLabel = NODES[route.stop].title;

  return (
    <section className="panel arch-panel" id="architecture" aria-labelledby="arch-title">
      <div className="panel-heading">
        <div>
          <p className="section-label">How a request is controlled</p>
          <h2 id="arch-title">Architecture and workflow</h2>
        </div>
        <span>{total ? `Step ${Math.max(1, activeStep)} of 11` : ""}</span>
      </div>

      <div className="arch-body">
        <p className="arch-intro">
          Follow one request from the agent to the tool. The token shows where it is. Dashed means advisory:
          the analyst can write advice but cannot change the outcome. Pick a scenario to see where it stops.
        </p>

        <div className="arch-controls">
          <label className="arch-select">
            <span>Path to show</span>
            <select value={effective} onChange={(event) => setChoice(event.target.value)}>
              {followable && (
                <option value="follow">
                  Selected request ({selectedRequest.toolId}, {selectedRequest.status.replace("_", " ")})
                </option>
              )}
              {scenarios.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <div className="arch-buttons">
            <button
              type="button"
              onClick={() => setPlaying((value) => !value)}
              aria-pressed={!autoplay}
              disabled={reduced}
              title={reduced ? "Motion is reduced on this device. Use Next step." : undefined}
            >
              {autoplay ? "Pause" : "Play"}
            </button>
            <button type="button" onClick={() => { setPlaying(false); setTick((value) => Math.max(0, value - 1)); }} disabled={tick === 0}>
              Back
            </button>
            <button type="button" onClick={() => { setPlaying(false); setTick((value) => Math.min(total, value + 1)); }} disabled={finished}>
              Next step
            </button>
            <button type="button" onClick={() => setTick(0)}>
              Restart
            </button>
          </div>
        </div>

        <div className={`arch-outcome tone-${route.tone}`} role="status">
          <strong>
            {toneWord}
            {route.tone !== "ok" ? ` at ${stopLabel.toLowerCase()}` : ""}
          </strong>
          <span>
            {scenarioLabel}: {route.summary}
            {effective !== "follow" && route.tone === "ok" && route.edges.includes("e7")
              ? " (assuming a qualified reviewer approves)"
              : ""}
          </span>
        </div>

        <div className={`arch-canvas ${narrow ? "is-narrow" : "is-wide"}`}>
          <svg
            viewBox={`0 0 ${layout.w} ${layout.h}`}
            role="img"
            aria-label="Diagram of the gateway: agent, gateway, registry check, policy engine, AI analyst, decision, human review, authorization, execution guard, tool and audit hash chain."
            preserveAspectRatio="xMidYMin meet"
          >
            <defs>
              <marker id="arch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,1 L9,5 L0,9 z" className="arch-arrowhead" />
              </marker>
              <marker id="arch-arrow-on" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,1 L9,5 L0,9 z" className="arch-arrowhead on" />
              </marker>
              <marker id="arch-arrow-danger" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,1 L9,5 L0,9 z" className="arch-arrowhead danger" />
              </marker>
            </defs>

            {/* audit chain */}
            <g className={`arch-band ${finished ? "written" : ""}`}>
              {narrow ? (
                <text className="arch-band-title" x={layout.band.label.x} y={layout.band.label.y + 8}>
                  Audit hash chain
                </text>
              ) : (
                <g>
                  <rect className="arch-band-label" {...layout.band.label} rx="10" />
                  <text className="arch-band-title" x={layout.band.label.x + 62} y={layout.band.label.y + 21} textAnchor="middle">
                    Audit
                  </text>
                  <text className="arch-band-sub" x={layout.band.label.x + 62} y={layout.band.label.y + 37} textAnchor="middle">
                    hash chain
                  </text>
                </g>
              )}
              {layout.band.links.map((link, index) => (
                <line key={index} className="arch-chain-link" x1={link[0]} y1={link[1]} x2={link[2]} y2={link[3]} />
              ))}
              {layout.band.cells.map((cell, index) => {
                const on = litEvents.get(index);
                const planned = futureEvents.get(index);
                return (
                  <g key={index} className={`arch-cell ${on ? "lit" : planned ? "planned" : ""}`}>
                    <rect x={cell.x} y={cell.y} width={cell.w} height={cell.h} rx="8" />
                    <text x={cell.x + cell.w / 2} y={cell.y + cell.h / 2 + 4} textAnchor="middle">
                      {on ?? planned ?? SLOT_LABELS[index]}
                    </text>
                  </g>
                );
              })}
              {layout.spine && <path className="arch-tap" d={pathData(layout.spine)} />}
            </g>

            {layout.taps.map((tap) => (
              <path
                key={tap.node}
                className={`arch-tap ${reachedNodes.has(tap.node) ? "on" : ""}`}
                d={pathData(tap.pts)}
              />
            ))}

            {/* edges */}
            {Object.entries(layout.edges).map(([id, geo]) => {
              const edge = EDGES[id];
              const cls = edgeClass(id);
              const marker = edge.danger
                ? "url(#arch-arrow-danger)"
                : cls.includes("done") || cls.includes("planned")
                  ? "url(#arch-arrow-on)"
                  : "url(#arch-arrow)";
              return (
                <g key={id} className={cls}>
                  <path d={pathData(geo.pts)} markerEnd={marker} />
                </g>
              );
            })}

            {/* nodes */}
            {Object.entries(layout.nodes).map(([id, box]) => (
              <g key={id} className={nodeClass(id)}>
                <rect x={box.x} y={box.y} width={box.w} height={box.h} rx="12" />
                <text className="arch-node-title" x={box.x + box.w / 2} y={box.y + box.h / 2 - 2} textAnchor="middle">
                  {NODES[id].title}
                </text>
                <text className="arch-node-sub" x={box.x + box.w / 2} y={box.y + box.h / 2 + 14} textAnchor="middle">
                  {NODES[id].sub}
                </text>
              </g>
            ))}

            {/* numbered, labelled arrows */}
            {Object.entries(layout.edges).map(([id, geo]) => {
              const edge = EDGES[id];
              const cls = `arch-badge ${usedEdges.has(id) ? "planned" : ""} ${currentEdge === id && !finished ? "current" : ""} ${edge.danger ? "danger" : ""}`;
              return (
                <g key={`b-${id}`} className={cls}>
                  <circle cx={geo.badge[0]} cy={geo.badge[1]} r="10" />
                  <text className="arch-badge-n" x={geo.badge[0]} y={geo.badge[1] + 4} textAnchor="middle">
                    {edge.step}
                  </text>
                  <text
                    className="arch-edge-label"
                    x={geo.label[0]}
                    y={geo.label[1]}
                    textAnchor={geo.anchor ?? "middle"}
                    transform={geo.rotate ? `rotate(-90 ${geo.label[0]} ${geo.label[1]})` : undefined}
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}

            {/* the token */}
            <g className="arch-token" aria-hidden="true">
              <circle className="arch-token-halo" r="15" />
              <circle className="arch-token-dot" r="7" />
              <animateMotion
                ref={motionRef}
                dur="0.001s"
                begin="indefinite"
                fill="freeze"
                calcMode="spline"
                keyTimes="0;1"
                keySplines="0.45 0 0.2 1"
                path="M0,0 L0,0"
              />
            </g>
          </svg>
        </div>

        <div className="arch-caption" aria-live={autoplay ? "off" : "polite"}>
          <strong>
            Step {Math.max(1, activeStep)}: {STEPS[Math.max(1, activeStep) - 1].title}
          </strong>
          <p>{STEPS[Math.max(1, activeStep) - 1].text}</p>
          <p className="guardrail">
            <span>Guardrail</span> {STEPS[Math.max(1, activeStep) - 1].guardrail}
          </p>
        </div>

        <ol className="arch-steps" aria-label="Workflow steps">
          {STEPS.map((step) => {
            const onRoute = stepsOnRoute.has(step.n);
            const classes = [
              onRoute ? "on-route" : "skipped",
              step.n === activeStep && tick > 0 ? "is-current" : "",
              onRoute && step.n === stopStep && finished && route.tone !== "ok" ? `is-stop stop-${route.tone}` : "",
            ];
            return (
              <li key={step.n} className={classes.filter(Boolean).join(" ")} aria-current={step.n === activeStep && tick > 0 ? "step" : undefined}>
                <span className="arch-step-n">{step.n}</span>
                <div>
                  <h3>
                    {step.title}
                    {!onRoute && <em className="arch-tag">not reached in this path</em>}
                    {onRoute && step.n === stopStep && route.tone !== "ok" && (
                      <em className={`arch-tag tag-${route.tone}`}>{route.tone === "waiting" ? "waits here" : "stops here"}</em>
                    )}
                  </h3>
                  <p>{step.text}</p>
                  <p className="guardrail">
                    <span>Guardrail</span> {step.guardrail}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
