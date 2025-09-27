// api/dropbox.js
// Vercel Edge Function（无需 Node 依赖）
// 入口：
//   1) /api/dropbox?u=<dropbox-url>
//   2) （配合 vercel.json 的 rewrites）/s... 或 /scl/... 直挂

export const config = { runtime: "edge" };

const ALLOWED_HOSTS = [
  "dl.dropboxusercontent.com",
  "www.dropbox.com",
  "dropbox.com",
];

export default async function handler(request) {
  try {
    const url = new URL(request.url);

    // ---- CORS 预检 ----
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request.headers) });
    }

    // 入口 1：?u=...
    const qpTarget = url.searchParams.get("u");
    if (qpTarget) {
      return await proxyDropbox(request, qpTarget);
    }

    // 入口 2：路径直挂式（由 vercel.json 把 /s... 或 /scl... rewrite 到 /api/dropbox?__p=...）
    const passthroughPath = url.searchParams.get("__p");
    if (passthroughPath && (passthroughPath.startsWith("/s/") || passthroughPath.startsWith("/scl/"))) {
      // 把 rewrite 时附带的其余查询串也拼上（除了 __p 自身）
      const q = new URLSearchParams(url.searchParams);
      q.delete("__p");
      const qs = q.toString();
      const shareLike = "https://www.dropbox.com" + passthroughPath + (qs ? "?" + qs : "");
      return await proxyDropbox(request, shareLike);
    }

    // 其他路径：给出使用说明
    return new Response(
      "Usage:\n1) /api/dropbox?u=<dropbox-share-url>\n2) /s... or /scl... (enabled via vercel.json rewrites)",
      { status: 200, headers: corsHeaders(request.headers) }
    );
  } catch (err) {
    return new Response("Internal Error: " + (err?.message || String(err)), { status: 500 });
  }
}

async function proxyDropbox(incomingRequest, inputUrl) {
  const upstreamUrl = toDirectDropbox(inputUrl); // 仅改域名+dl=1，保留所有原始 query
  const u = new URL(upstreamUrl);

  // 安全白名单
  const ok = ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith("." + h));
  if (!ok) return new Response("Host not allowed", { status: 403, headers: corsHeaders(incomingRequest.headers) });

  // 透传 Range / 条件请求头；补充 UA / Referer
  const fwdHeaders = new Headers();
  copyInIfPresent(incomingRequest.headers, fwdHeaders, "range");
  copyInIfPresent(incomingRequest.headers, fwdHeaders, "if-modified-since");
  copyInIfPresent(incomingRequest.headers, fwdHeaders, "if-none-match");
  if (!incomingRequest.headers.get("user-agent")) {
    fwdHeaders.set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36");
  }
  if (!incomingRequest.headers.get("referer")) {
    fwdHeaders.set("referer", "https://www.dropbox.com/");
  }
  fwdHeaders.set("accept", "*/*");

  // 跟随跳转，流式转发
  const upstreamResp = await fetch(u.toString(), {
    method: "GET",
    headers: fwdHeaders,
    redirect: "follow",
  });

  // 构造响应头
  const out = new Headers();
  // CORS
  for (const [k, v] of corsHeaders(incomingRequest.headers).entries()) out.set(k, v);
  // 关键头
  copyHeader(upstreamResp.headers, out, "content-type");
  copyHeader(upstreamResp.headers, out, "content-length");
  copyHeader(upstreamResp.headers, out, "content-range");
  copyHeader(upstreamResp.headers, out, "accept-ranges");
  copyHeader(upstreamResp.headers, out, "etag");
  copyHeader(upstreamResp.headers, out, "last-modified");
  copyHeader(upstreamResp.headers, out, "cache-control");

  // 必要时修正 MIME，避免浏览器直接下载
  const ct = (out.get("content-type") || "").toLowerCase();
  if (!ct || ct === "application/octet-stream") {
    if (/\.(mp4|m4v|mov)(\?|#|$)/i.test(u.pathname)) {
      out.set("content-type", "video/mp4");
    }
  }
  out.set("content-disposition", "inline");

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: out,
  });
}

function toDirectDropbox(input) {
  const url = new URL(input);
  // 关键点：保留所有原始 query（rlkey / st 等），只把域名换成直链并强制 dl=1
  if (url.hostname.endsWith("dropbox.com")) {
    url.hostname = "dl.dropboxusercontent.com";
    url.searchParams.set("dl", "1");
    return url.toString();
  }
  if (url.hostname.endsWith("dropboxusercontent.com")) {
    url.searchParams.set("dl", "1");
    return url.toString();
  }
  return url.toString();
}

// ---- 小工具 ----
function copyInIfPresent(src, dst, name) {
  const v = src.get(name);
  if (v) dst.set(name, v);
}
function copyHeader(src, dst, name) {
  const v = src.get(name);
  if (v) dst.set(name, v);
}
function corsHeaders(reqHeaders) {
  const origin = (reqHeaders && (reqHeaders.get("origin") || reqHeaders.get("Origin"))) || "*";
  const acrh = (reqHeaders && (reqHeaders.get("access-control-request-headers") || reqHeaders.get("Access-Control-Request-Headers"))) || "Range, If-Modified-Since, If-None-Match, Content-Type";
  const h = new Headers();
  h.set("access-control-allow-origin", origin);
  h.set("access-control-allow-credentials", "true");
  h.set("access-control-allow-methods", "GET,HEAD,OPTIONS");
  h.set("access-control-allow-headers", acrh);
  h.set("cross-origin-resource-policy", "cross-origin");
  h.set("timing-allow-origin", origin);
  return h;
}
