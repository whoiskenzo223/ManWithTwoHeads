// XHTTP Relay - با قابلیت پاسخ به وضعیت‌یاب HTML
export const config = { runtime: "edge" };

const TARGET = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
if (!TARGET) throw new Error("Missing TARGET_DOMAIN");

const EXCLUDED_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
]);

export default async function handler(request) {
  const url = new URL(request.url);

  // ---- فقط برای وضعیت‌یاب HTML ----
  if (url.searchParams.get("action") === "check") {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${TARGET}/health`, { method: "HEAD", signal: controller.signal });
      return new Response(JSON.stringify({
        status: "ok",
        reachable: !!res,
        timestamp: new Date().toISOString()
      }), { headers: { "content-type": "application/json" } });
    } catch {
      return new Response(JSON.stringify({ status: "error", reachable: false }), {
        headers: { "content-type": "application/json" }
      });
    }
  }

  // ---- بقیه درخواست‌ها: پراکسی کامل (همون کد اصلی) ----
  const destination = TARGET + url.pathname + url.search;
  const headers = new Headers();
  let clientIp = null;

  for (const [key, value] of request.headers) {
    if (EXCLUDED_HEADERS.has(key)) continue;
    if (key.startsWith("x-vercel-")) continue;
    if (key === "x-real-ip" || key === "x-forwarded-for") {
      clientIp = value;
      continue;
    }
    headers.set(key, value);
  }
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const isBodyAllowed = request.method !== "GET" && request.method !== "HEAD";
  return await fetch(destination, {
    method: request.method,
    headers,
    body: isBodyAllowed ? request.body : undefined,
    duplex: "half",
    redirect: "manual",
  });
}
