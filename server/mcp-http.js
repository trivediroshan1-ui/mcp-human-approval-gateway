// Streamable HTTP adapter for the MCP server core (server/mcp.js).
//
// One endpoint, POST only. Every reply is a single JSON object, never an SSE
// stream, which both supported revisions allow. GET and DELETE answer 405.
// Browser protections: the Origin header is validated (DNS rebinding), the
// Host header must be a name this server expects, and the body is capped.
// There is no CORS: a page on another origin can neither read nor preflight.

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function hostnameOf(hostHeader) {
  const value = String(hostHeader ?? "").trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  return value.split(":")[0];
}

function isJsonMediaType(header) {
  return String(header ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

function acceptsJson(header) {
  if (header === undefined) return true;
  return String(header)
    .split(",")
    .map((part) => part.split(";")[0].trim().toLowerCase())
    .some((type) => type === "application/json" || type === "application/*" || type === "*/*");
}

function createLimiter({ windowMs = 60_000, max = 240 } = {}) {
  const buckets = new Map();
  return function allow(key) {
    const now = Date.now();
    if (buckets.size > 1000) {
      for (const [bucketKey, entry] of buckets) if (entry.resetAt <= now) buckets.delete(bucketKey);
    }
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= max;
  };
}

export function createMcpHttpHandler({
  mcp,
  allowedHosts = [],
  allowedOrigins = [],
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxRequestsPerMinute = 240,
} = {}) {
  const hosts = new Set([...LOOPBACK_HOSTS, ...allowedHosts.map((host) => host.toLowerCase())]);
  const origins = new Set(allowedOrigins.map((origin) => origin.toLowerCase()));
  const allow = createLimiter({ max: maxRequestsPerMinute });

  function send(response, status, body, extraHeaders = {}) {
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    };
    if (body === null) {
      response.writeHead(status, headers);
      response.end();
      return;
    }
    response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  function originAllowed(request) {
    const origin = request.headers.origin;
    if (origin === undefined) return true; // not a browser request
    const normalized = String(origin).toLowerCase();
    if (origins.has(normalized)) return true;
    try {
      const parsed = new URL(normalized);
      if (!["http:", "https:"].includes(parsed.protocol)) return false;
      // Same origin as the Host this server was reached on, and that Host is
      // one the operator expects. A rebinding page fails the second test.
      return (
        parsed.host === String(request.headers.host ?? "").toLowerCase() &&
        hosts.has(hostnameOf(request.headers.host))
      );
    } catch {
      return false;
    }
  }

  async function readBody(request) {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > maxBodyBytes) return { tooLarge: true };
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > maxBodyBytes) return { tooLarge: true };
      chunks.push(chunk);
    }
    return { text: Buffer.concat(chunks).toString("utf8") };
  }

  return async function handleMcp(request, response) {
    const ctx = { transport: "http", headers: request.headers, session: null };
    const remote = request.socket.remoteAddress ?? "unknown";
    const audited = (status, code, message, outcome, extra = {}) =>
      send(response, status, mcp.reject(status, code, message, outcome, ctx, extra));

    if (!originAllowed(request)) {
      // Spec: invalid Origin gets 403. The attacker-supplied value is clipped before it is stored.
      audited(403, -32600, "Origin not allowed.", "origin_rejected", {
        origin: String(request.headers.origin ?? "").slice(0, 120),
      });
      return;
    }
    if (!hosts.has(hostnameOf(request.headers.host))) {
      audited(403, -32600, "Host not allowed.", "host_rejected", {
        host: String(request.headers.host ?? "").slice(0, 120),
      });
      return;
    }
    if (request.method !== "POST") {
      audited(405, -32600, "This endpoint accepts POST only.", "method_not_allowed", { httpMethod: request.method });
      return;
    }
    if (!allow(remote)) {
      send(response, 429, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Too many requests." } }, { "retry-after": "60" });
      return;
    }
    if (!isJsonMediaType(request.headers["content-type"])) {
      audited(415, -32600, "Content-Type must be application/json.", "unsupported_media_type");
      return;
    }
    if (!acceptsJson(request.headers.accept)) {
      audited(406, -32600, "The client must accept application/json.", "not_acceptable");
      return;
    }

    let body;
    try {
      body = await readBody(request);
    } catch {
      audited(400, -32700, "The request body could not be read.", "unreadable_body");
      return;
    }
    if (body.tooLarge) {
      audited(413, -32600, `The request body is larger than ${maxBodyBytes} bytes.`, "body_too_large");
      return;
    }
    let message;
    try {
      message = JSON.parse(body.text);
    } catch {
      audited(400, -32700, "Parse error: the body is not valid JSON.", "parse_error");
      return;
    }

    const result = await mcp.handle(message, ctx);
    send(response, result.status, result.body);
  };
}

export function parseList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
