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
    "cache-control": contentType.startsWith("text/html") ? "no-store" : "no-cache",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, securityHeaders());
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must contain valid JSON.");
    error.status = 400;
    throw error;
  }
}

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

function createRateLimiter({ windowMs = 60_000, maxWrites = 120 } = {}) {
  const buckets = new Map();
  return function allow(key) {
    const now = Date.now();
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

export function createHttpHandler({ service, scenarios, toolRegistry, clientDir }) {
  const allowWrite = createRateLimiter({});

  return async function handler(request, response) {
    const url = new URL(request.url, "http://gateway.local");
    const method = request.method ?? "GET";
    try {
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
        /^\/api\/requests\/([^/]+)\/execute$/,
      );
      if (method === "POST" && executionMatch) {
        const result = service.execute(executionMatch[0]);
        sendJson(response, result.ok ? 200 : result.code === "not_found" ? 404 : 409, result);
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
        sendJson(response, 200, service.verifyAudit());
        return;
      }
      if (method === "POST" && url.pathname === "/api/reset") {
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
      sendJson(response, error.status ?? 500, {
        error: error.status ? "invalid_request" : "internal_error",
        message: error instanceof Error ? error.message : "Unexpected error.",
      });
    }
  };
}
