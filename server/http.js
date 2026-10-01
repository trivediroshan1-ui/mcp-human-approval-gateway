import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const MAX_BODY_BYTES = 64 * 1024;
const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function securityHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "content-type": contentType,
    "cache-control": contentType.startsWith("application/json") || contentType.startsWith("text/html")
      ? "no-store"
      : "no-cache",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, securityHeaders());
  response.end(JSON.stringify(payload));
}

function statusFor(result) {
  if (result.ok) return 200;
  if (result.code === "not_found") return 404;
  if (String(result.code).startsWith("invalid_")) return 400;
  return 409;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Browsers can send a cross-site POST without a preflight when the media type
// is text/plain, even with "application/json" hidden in a parameter. Only an
// exact application/json media type is accepted, which forces a preflight that
// this server never grants.
function isJsonMediaType(header) {
  return (
    String(header ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase() === "application/json"
  );
}

// A write from a page on another origin carries an Origin header that does not
// match Host. Requests without Origin (curl, server to server) are unaffected.
function isCrossOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.host;
  } catch {
    return true;
  }
}

async function readJson(request, { object = true } = {}) {
  const contentType = request.headers["content-type"] ?? "";
  if (!isJsonMediaType(contentType)) {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must contain valid JSON.");
  }
  if (object && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
    throw httpError(400, "Request body must be a JSON object.");
  }
  return parsed;
}

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return match.slice(1).map(decodeURIComponent);
  } catch {
    throw httpError(400, "Malformed path.");
  }
}

function createRateLimiter({ windowMs = 60_000, maxWrites = 120 } = {}) {
  const buckets = new Map();
  return function allow(key) {
    const now = Date.now();
    // Drop expired buckets so the map cannot grow without bound.
    if (buckets.size > 1000) {
      for (const [bucketKey, entry] of buckets) {
        if (entry.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= maxWrites;
  };
}

function serveStatic(request, response, clientDir, pathname) {
  const root = resolve(clientDir);
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(root, requested);
  const isInsideRoot = candidate === root || candidate.startsWith(`${root}${sep}`);
  if (!isInsideRoot) {
    sendJson(response, 400, {
      error: "invalid_path",
      message: "Static path is outside the application root.",
    });
    return;
  }
  let filePath = candidate;
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = resolve(root, "index.html");
  }
  if (!existsSync(filePath)) {
    sendJson(response, 503, {
      error: "client_not_built",
      message: "Run npm run build before starting the production server.",
    });
    return;
  }
  const contentType = MIME[extname(filePath)] ?? "application/octet-stream";
  response.writeHead(200, securityHeaders(contentType));
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

export function createHttpHandler({
  service,
  scenarios,
  toolRegistry,
  clientDir,
  allowReset = true,
  mcpHandler = null,
  log = (message) => console.error(message),
}) {
  const allowWrite = createRateLimiter({});

  return async function handler(request, response) {
    const url = new URL(request.url, "http://gateway.local");
    const method = request.method ?? "GET";
    try {
      // The MCP endpoint does its own Origin, Host, size and type checks.
      if (mcpHandler && url.pathname === "/mcp") {
        await mcpHandler(request, response);
        return;
      }
      if (url.pathname.startsWith("/api/") && method !== "GET" && isCrossOrigin(request)) {
        sendJson(response, 403, {
          error: "cross_origin_blocked",
          message: "Cross-origin writes are not accepted.",
        });
        return;
      }
      if (url.pathname.startsWith("/api/") && method !== "GET") {
        const key = request.socket.remoteAddress ?? "unknown";
        if (!allowWrite(key)) {
          sendJson(response, 429, { error: "rate_limited", message: "Too many writes." });
          return;
        }
      }

      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, {
          status: "ok",
          project: "MCP Human Approval Gateway",
          syntheticDataOnly: true,
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/scenarios") {
        sendJson(response, 200, { scenarios, tools: Object.values(toolRegistry) });
        return;
      }
      if (method === "GET" && url.pathname === "/api/requests") {
        service.sweep?.();
        sendJson(response, 200, {
          requests: service.list(url.searchParams.get("limit")),
        });
        return;
      }
      if (method === "POST" && url.pathname === "/api/requests") {
        const result = await service.submit(await readJson(request));
        sendJson(response, result.ok ? 201 : 400, result);
        return;
      }
      const requestMatch = routeMatch(url.pathname, /^\/api\/requests\/([^/]+)$/);
      if (method === "GET" && requestMatch) {
        const record = service.get(requestMatch[0]);
        sendJson(
          response,
          record ? 200 : 404,
          record ? { request: record } : { error: "not_found" },
        );
        return;
      }
      const decisionMatch = routeMatch(
        url.pathname,
        /^\/api\/requests\/([^/]+)\/decision$/,
      );
      if (method === "POST" && decisionMatch) {
        const result = service.decide(decisionMatch[0], await readJson(request));
        sendJson(response, result.ok ? 200 : result.code === "not_found" ? 404 : 409, result);
        return;
      }
      const executionMatch = routeMatch(
        url.pathname,
        /^\/api\/requests\/([^/]+)\/(execute|reserve)$/,
      );
      if (method === "POST" && executionMatch) {
        const body = await readJson(request);
        const options = {
          requestHash: body.requestHash,
          actorId: body.actorId,
          idempotencyKey: body.idempotencyKey,
          executionId: body.executionId,
        };
        const result =
          executionMatch[1] === "reserve"
            ? service.reserve(executionMatch[0], options)
            : service.execute(executionMatch[0], options);
        sendJson(response, statusFor(result), result);
        return;
      }
      const executionRead = routeMatch(url.pathname, /^\/api\/executions\/([^/]+)$/);
      if (method === "GET" && executionRead) {
        const result = service.getExecution(executionRead[0]);
        sendJson(response, statusFor(result), result);
        return;
      }
      const executionAction = routeMatch(url.pathname, /^\/api\/executions\/([^/]+)\/(confirm|reconcile)$/);
      if (method === "POST" && executionAction) {
        const body = await readJson(request);
        // Demo mode: the confirm call is trusted once it shows the dispatch key,
        // and reconcile trusts the reviewer fields as the REST decision route does.
        const result =
          executionAction[1] === "confirm"
            ? service.confirm(executionAction[0], { ...body, actor: "http-dispatcher" })
            : service.reconcile(executionAction[0], body);
        sendJson(response, statusFor(result), result);
        return;
      }
      if (method === "GET" && url.pathname === "/api/audit") {
        sendJson(response, 200, {
          events: service.audit(
            url.searchParams.get("requestId"),
            url.searchParams.get("limit"),
          ),
        });
        return;
      }
      if (method === "GET" && url.pathname === "/api/audit/verify") {
        const anchorSequence = url.searchParams.get("anchorSequence");
        const anchorHash = url.searchParams.get("anchorHash");
        sendJson(
          response,
          200,
          service.verifyAudit(
            anchorSequence && anchorHash ? { anchor: { sequence: anchorSequence, hash: anchorHash } } : {},
          ),
        );
        return;
      }
      if (method === "POST" && url.pathname === "/api/reset") {
        if (!allowReset) {
          sendJson(response, 403, { error: "reset_disabled", message: "Reset is disabled." });
          return;
        }
        await readJson(request);
        sendJson(response, 200, service.reset());
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "not_found", message: "API route not found." });
        return;
      }
      if (!["GET", "HEAD"].includes(method)) {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      serveStatic(request, response, clientDir, url.pathname);
    } catch (error) {
      if (!error?.status) log(`Unhandled error: ${error instanceof Error ? error.stack : error}`);
      sendJson(response, error?.status ?? 500, {
        error: error?.status ? "invalid_request" : "internal_error",
        message: error?.status ? error.message : "Unexpected error.",
      });
    }
  };
}
