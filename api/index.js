export const config = {
  runtime: "edge",
};

// Environment variables
const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const RELAY_PATH = normalizeRelayPath(process.env.RELAY_PATH || "/xhttp-relay");
const RELAY_KEY = (process.env.RELAY_KEY || "").trim();
const UPSTREAM_TIMEOUT_MS = parsePositiveInt(process.env.UPSTREAM_TIMEOUT_MS, 60000, 1000);
const MAX_INFLIGHT = parsePositiveInt(process.env.MAX_INFLIGHT, 12, 1);

// Method allowlist - only essential methods for XHTTP
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

// Headers to strip from incoming requests (hop-by-hop + platform identifiers)
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-for",
  "x-real-ip",
  "x-vercel-ip",
  "x-vercel-proxy-signature",
  "x-vercel-id",
  "x-vercel-proxied",
  "x-vercel-deployment-url",
  "x-vercel-country",
  "x-forwarded-for-vercel",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "true-client-ip",
  "cdn-loop",
  "via",
  "proxy-connection",
]);

// Headers to strip from upstream responses
const STRIP_RESPONSE_HEADERS = new Set([
  "server",
  "x-powered-by",
  "x-vercel-cache",
  "x-vercel-id",
  "x-vercel-deployment-url",
  "cf-cache-status",
  "cf-ray",
  "report-to",
  "nel",
  "access-control-allow-origin",
  "access-control-allow-credentials",
]);

// Whitelist for request headers to forward (instead of blacklist approach)
const FORWARD_HEADER_PREFIXES = [
  "accept",
  "content-",
  "user-agent",
  "cache-control",
  "pragma",
  "sec-ch-",
  "sec-fetch-",
  "sec-websocket-",
  "x-",
  "range",
  "if-",
  "referer",
  "origin",
  "cookie",
  "dnt",
  "authorization",
];

// Concurrency control
let inFlight = 0;

export default async function handler(req) {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  let slotAcquired = false;

  // --- Validation Checks (Fail Early to Avoid Fingerprinting) ---
  
  // Check required configuration
  if (!TARGET_BASE) {
    return new Response("Not Found", { status: 404 }); // Generic error to avoid leaking info
  }

  // Path validation - only serve requests on the designated relay path
  const url = new URL(req.url);
  if (!isAllowedRelayPath(url.pathname)) {
    return new Response("Not Found", { status: 404 });
  }

  // Method validation
  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Authentication check (if relay key is configured)
  if (RELAY_KEY) {
    const authToken = req.headers.get("x-relay-key") || "";
    if (authToken !== RELAY_KEY) {
      // Return 404 (not 403) to avoid revealing that authentication is required
      return new Response("Not Found", { status: 404 });
    }
  }

  // Concurrency limiting
  if (!tryAcquireSlot()) {
    return new Response("Service Unavailable", { 
      status: 503,
      headers: { "retry-after": "1" }
    });
  }
  slotAcquired = true;

  try {
    // --- Request Processing ---
    
    // Build target URL
    const targetUrl = `${TARGET_BASE}${url.pathname}${url.search}`;
    
    // Filter and build headers for upstream request
    const headers = new Headers();
    let clientIp = null;
    
    for (const [key, value] of req.headers) {
      const lowerKey = key.toLowerCase();
      
      // Skip stripped headers
      if (STRIP_REQUEST_HEADERS.has(lowerKey)) continue;
      
      // Skip Vercel-specific headers (dynamic prefix check)
      if (lowerKey.startsWith("x-vercel-")) continue;
      
      // Skip Cloudflare headers
      if (lowerKey.startsWith("cf-")) continue;
      
      // Skip relay authentication header
      if (lowerKey === "x-relay-key") continue;
      
      // Collect client IP from specific headers
      if (lowerKey === "x-real-ip" || lowerKey === "true-client-ip") {
        if (!clientIp && value) clientIp = value;
        continue;
      }
      
      // Whitelist check - only forward expected headers
      if (!shouldForwardHeader(lowerKey)) continue;
      
      headers.set(key, value);
    }
    
    // Set forwarded for header with original client IP
    if (clientIp) {
      headers.set("x-forwarded-for", clientIp);
    }
    
    // Add a randomized user-agent if none present (mimics browser behavior)
    if (!headers.has("user-agent")) {
      headers.set("user-agent", getRandomUserAgent());
    }
    
    // --- Upstream Request ---
    
    const method = req.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);
    
    const fetchOptions = {
      method,
      headers,
      redirect: "manual",
      signal: abortController.signal,
    };
    
    if (hasBody) {
      fetchOptions.body = req.body;
      fetchOptions.duplex = "half";
    }
    
    let upstream;
    try {
      upstream = await fetch(targetUrl, fetchOptions);
    } finally {
      clearTimeout(timeoutId);
    }
    
    // --- Response Processing ---
    
    // Build response headers, stripping identifiable ones
    const responseHeaders = new Headers();
    
    for (const [key, value] of upstream.headers) {
      const lowerKey = key.toLowerCase();
      
      // Strip hop-by-hop and platform-identifying headers
      if (lowerKey === "transfer-encoding" || lowerKey === "connection") continue;
      if (STRIP_RESPONSE_HEADERS.has(lowerKey)) continue;
      if (lowerKey.startsWith("x-vercel-")) continue;
      if (lowerKey.startsWith("cf-")) continue;
      
      responseHeaders.set(key, value);
    }
    
    // Add generic server header to avoid fingerprinting
    responseHeaders.set("server", "nginx");
    
    // Add security headers (makes it look like a regular web server)
    responseHeaders.set("x-content-type-options", "nosniff");
    responseHeaders.set("x-frame-options", "SAMEORIGIN");
    
    // --- Logging (Optional, can be disabled via environment variable) ---
    if (process.env.ENABLE_LOGGING !== "0") {
      const durationMs = Date.now() - startedAt;
      console.log(`[relay] ${requestId} ${method} ${url.pathname} → ${upstream.status} (${durationMs}ms)`);
    }
    
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
    
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    
    // Handle abort/timeout errors
    if (error.name === "AbortError") {
      if (process.env.ENABLE_LOGGING !== "0") {
        console.error(`[relay] ${requestId} timeout after ${durationMs}ms`);
      }
      return new Response("Gateway Timeout", { status: 504 });
    }
    
    // Generic error handling
    if (process.env.ENABLE_LOGGING !== "0") {
      console.error(`[relay] ${requestId} error: ${error.message}`);
    }
    return new Response("Bad Gateway", { status: 502 });
    
  } finally {
    if (slotAcquired) releaseSlot();
  }
}

// --- Helper Functions ---

function shouldForwardHeader(headerName) {
  for (const prefix of FORWARD_HEADER_PREFIXES) {
    if (headerName.startsWith(prefix)) return true;
  }
  return false;
}

function isAllowedRelayPath(pathname) {
  return pathname === RELAY_PATH || pathname.startsWith(`${RELAY_PATH}/`);
}

function normalizeRelayPath(rawPath) {
  if (!rawPath) return "/xhttp-relay";
  let path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}

function parsePositiveInt(rawValue, fallbackValue, minValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return fallbackValue;
  if (value < minValue) return fallbackValue;
  return Math.trunc(value);
}

function tryAcquireSlot() {
  if (inFlight >= MAX_INFLIGHT) return false;
  inFlight++;
  return true;
}

function releaseSlot() {
  inFlight = Math.max(0, inFlight - 1);
}

function getRandomUserAgent() {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}