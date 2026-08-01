const STEPS = [
  {
    number: "01",
    title: "Choose a scenario",
    description:
      "Select a synthetic request representing public research, private access, a privileged change or a hostile instruction.",
  },
  {
    number: "02",
    title: "Simulate the request",
    description:
      "Submit the request to the deterministic policy gateway. No real tool, server or company system is contacted.",
  },
  {
    number: "03",
    title: "Review the decision",
    description:
      "Examine the actor, action, resource, environment, data classification, requested scope and calculated risk.",
  },
  {
    number: "04",
    title: "Make a human decision",
    description:
      "When authorization is required, select the qualified reviewer and record an approval or denial with a reason.",
  },
  {
    number: "05",
    title: "Observe the guard",
    description:
      "See whether the request is executed, denied, expired or blocked from replay based on policy and authorization state.",
  },
  {
    number: "06",
    title: "Verify the evidence",
    description:
      "Review the local decision record, then use Reset Lab to remove the synthetic browser state and start again.",
  },
];

export default function PublicGuide() {
  return (
    <section className="public-guide" aria-labelledby="public-guide-title">
      <div className="public-guide-intro">
        <p className="section-label">Start here</p>
        <h2 id="public-guide-title">How to use this lab</h2>
        <p>
          Follow a tool request from initial policy evaluation through human
          authorization, guarded execution and audit evidence.
        </p>
      </div>

      <details className="guide-details">
        <summary>Open the 60-second walkthrough</summary>

        <ol className="guide-steps">
          {STEPS.map((step) => (
            <li key={step.number}>
              <span>{step.number}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.description}</p>
              </div>
            </li>
          ))}
        </ol>

        <p className="guide-disclosure">
          <strong>Simulation boundary:</strong> This browser-only reference
          simulation does not connect to a live MCP server, AI agent, repository,
          credential store or production system. All scenarios and data are
          synthetic.
        </p>
      </details>
    </section>
  );
}