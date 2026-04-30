export const config = { runtime: "edge" };

const TARGET = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const EXCLUDED_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto",
]);

export default async function handler(request) {
  const url = new URL(request.url);

  // اگه درخواست از طرف HTML اومده (با پارامتر action=check)
  if (url.searchParams.get("action") === "check") {
    if (!TARGET) {
      return new Response(JSON.stringify({ status: "error", message: "TARGET_DOMAIN not set" }), {
        headers: { "content-type": "application/json" }
      });
    }
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${TARGET}/health`, { method: "HEAD", signal: controller.signal });
      return new Response(JSON.stringify({ status: "ok", reachable: !!res }), {
        headers: { "content-type": "application/json" }
      });
    } catch {
      return new Response(JSON.stringify({ status: "error", reachable: false }), {
        headers: { "content-type": "application/json" }
      });
    }
  }

  // در غیر این صورت: کار پراکسی اصلی رو انجام بده
  if (!TARGET) {
    return new Response("TARGET_DOMAIN missing", { status: 500 });
  }

  try {
    const destination = TARGET + url.pathname + url.search;
    const headers = new Headers();
    for (const [key, value] of request.headers) {
      if (EXCLUDED_HEADERS.has(key)) continue;
      if (key.startsWith("x-vercel-")) continue;
      headers.set(key, value);
    }
    const isBodyAllowed = !["GET", "HEAD"].includes(request.method);
    return await fetch(destination, {
      method: request.method,
      headers,
      body: isBodyAllowed ? request.body : undefined,
      duplex: "half",
      redirect: "manual",
    });
  } catch (err) {
    return new Response("Proxy Error", { status: 500 });
  }
}
