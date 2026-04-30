// api/status.js
export const config = { runtime: "edge" };

const TARGET = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const TIMEOUT = 5000;

export default async function handler(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("action") !== "check") {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  }

  if (!TARGET) {
    return new Response(JSON.stringify({
      status: "error",
      message: "TARGET_DOMAIN env missing"
    }), { headers: { "content-type": "application/json" } });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);
    const res = await fetch(`${TARGET}/health`, {
      method: "HEAD",
      signal: controller.signal
    }).catch(() => null);
    clearTimeout(timeout);

    return new Response(JSON.stringify({
      status: "ok",
      target: TARGET,
      reachable: !!res,
      timestamp: new Date().toISOString()
    }), { headers: { "content-type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({
      status: "error",
      message: err.message
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
