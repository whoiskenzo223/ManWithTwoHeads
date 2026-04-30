// api/status.js
export const config = { runtime: "edge" };

// Read once at cold start
const TARGET = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const TEST_TIMEOUT = 5000; // 5 seconds

function sanitizeHeaders(headers) {
  const excluded = new Set([
    "host", "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding",
    "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto",
    "x-forwarded-port"
  ]);
  const clean = new Headers();
  for (const [key, value] of headers) {
    if (excluded.has(key)) continue;
    if (key.startsWith("x-vercel-")) continue;
    if (key === "x-real-ip" || key === "x-forwarded-for") continue;
    clean.set(key, value);
  }
  return clean;
}

export default async function handler(request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // Return HTML dashboard when requested
  if (!action || action !== "check") {
    const html = await fetch(new URL("../index.html", import.meta.url)).then(r => r.text());
    return new Response(html, {
      headers: { "content-type": "text/html" }
    });
  }

  // Run diagnostics (no traffic forwarding)
  if (!TARGET) {
    return new Response(JSON.stringify({
      status: "error",
      message: "TARGET_DOMAIN environment variable is not set",
      timestamp: new Date().toISOString()
    }), { headers: { "content-type": "application/json" } });
  }

  try {
    // 1. Ping simple health check (if your backend has one)
    const healthUrl = `${TARGET}/health`;
    const pingController = new AbortController();
    const pingTimeout = setTimeout(() => pingController.abort(), TEST_TIMEOUT);

    const pingRes = await fetch(healthUrl, {
      method: "HEAD",
      headers: sanitizeHeaders(request.headers),
      signal: pingController.signal
    }).catch(() => null);
    clearTimeout(pingTimeout);

    // 2. Test TLS handshake (without sending data)
    const tlsUrl = new URL(TARGET);
    const tlsController = new AbortController();
    const tlsTimeout = setTimeout(() => tlsController.abort(), TEST_TIMEOUT);

    const tlsRes = await fetch(`${tlsUrl.origin}/`, {
      method: "HEAD",
      signal: tlsController.signal
    }).catch(() => null);
    clearTimeout(tlsTimeout);

    const diagnostics = {
      status: "ok",
      target: TARGET,
      connectivity: {
        healthCheck: pingRes ? "reachable" : "unreachable",
        tlsHandshake: tlsRes ? "successful" : "failed",
        lastChecked: new Date().toISOString()
      },
      config: {
        hasTarget: !!TARGET,
        targetUrl: TARGET,
        nodeEnv: process.env.NODE_ENV || "not set"
      },
      timestamp: new Date().toISOString()
    };

    return new Response(JSON.stringify(diagnostics), {
      headers: { "content-type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      status: "error",
      message: err.message,
      timestamp: new Date().toISOString()
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
}