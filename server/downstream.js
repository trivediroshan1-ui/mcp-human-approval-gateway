// A fake downstream system for the synthetic tools. It stands in for whatever
// real service a tool would call, and it does the one thing that makes a retry
// safe: it remembers the idempotency key of every call it has accepted. A
// second call with a key it has already seen returns the stored result and does
// no new work. Tests read `stats()` to prove how many times work really ran.
//
// Nothing here touches a real system. Results are deterministic so they can be
// hashed and compared across the server and the browser copy.
//
// Fault injection is for the lab and the tests. `injectFault` arms one fault for
// the next call:
//   "fail"                  the tool reports an error and did no work
//   "timeout_after_effect"  the work was done, then the reply was lost
//   "timeout_before_effect" the reply was lost and no work was done
// After a timeout the caller cannot tell which of the last two happened. That is
// the situation the unknown_outcome state exists for.

const EFFECTS = {
  "docs.search": "Pretended to search public documentation and found 3 synthetic documents.",
  "repo.read": "Pretended to read a synthetic repository and list 12 synthetic files.",
  "secrets.read": "Pretended to list metadata for 4 synthetic credentials. No secret values exist here.",
  "iam.roles.update": "Pretended to change a synthetic role assignment.",
  "deploy.production": "Pretended to deploy a synthetic build.",
  "storage.delete": "Pretended to delete a synthetic storage object.",
  "ticket.create": "Pretended to open a synthetic security ticket.",
};

function dispatchError(code, message, outcomeKnown) {
  const error = new Error(message);
  error.code = code;
  error.outcomeKnown = outcomeKnown;
  return error;
}

export function createFakeDownstream() {
  const accepted = new Map();
  let attempts = 0;
  let effects = 0;
  let armed = null;

  return {
    injectFault(kind) {
      if (kind !== null && !["fail", "timeout_after_effect", "timeout_before_effect"].includes(kind)) {
        throw new Error("Unknown fault kind.");
      }
      armed = kind;
    },

    dispatch(call) {
      attempts += 1;
      const key = call?.idempotencyKey;
      if (typeof key !== "string" || key.length < 8) {
        throw dispatchError("missing_idempotency_key", "The downstream system requires an idempotency key.", true);
      }
      if (accepted.has(key)) {
        // Same key, same stored answer, no new work. Faults do not apply.
        return { ...accepted.get(key), deduplicated: true };
      }
      const fault = armed;
      armed = null;
      if (fault === "fail") throw dispatchError("downstream_error", "The synthetic tool reported an error.", true);
      if (fault === "timeout_before_effect") {
        throw dispatchError("downstream_timeout", "The call timed out and the result is unknown.", false);
      }
      const result = {
        simulated: true,
        tool: call.toolId,
        action: call.action,
        resource: call.resource,
        summary: EFFECTS[call.toolId] ?? "Pretended to run a synthetic action.",
      };
      accepted.set(key, result);
      effects += 1;
      if (fault === "timeout_after_effect") {
        throw dispatchError("downstream_timeout", "The call timed out and the result is unknown.", false);
      }
      return { ...result, deduplicated: false };
    },

    // What a reconciler would ask a real downstream: did you accept this key?
    lookup(key) {
      return accepted.has(key) ? { ...accepted.get(key) } : null;
    },

    stats() {
      return { attempts, effects, keys: accepted.size };
    },

    effectsFor(key) {
      return accepted.has(key) ? 1 : 0;
    },
  };
}
