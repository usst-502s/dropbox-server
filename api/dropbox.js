// api/dropbox.js
// Vercel Edge Function（高兼容版）
// 用法：
//   1) 参数式：/api/dropbox?u=<URL 编码后的 Dropbox 分享/直链>
//   2) 路径直挂式：/s... 或 /scl/...（依赖 vercel.json 的 rewrites，把原始路径放到 ?__p= 中）
//
// 亮点：Range 支持、CORS、MIME 修正、403/429/5xx 自动回退一次（直链 -> 分享域名）、
//      仅强制 dl=1 且保留全部原始 query（rlkey/st），域名白名单，流式转发。

export const config = {
  runtime: "edge",
  // 可按需声明首选执行区域（国内用户推荐 hkg1 优先，其次 sin1）
  regions: ["hkg1", "sin1"]
};

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

    // 入口 2：路径直挂式（由 vercel.json rewrite 到 /api/dropbox?__p=...）
    const passthroughPath = url.searchParams.get("__p");
    if (passthroughPath && (passthroughPath.startsWith("/s/") || passthroughPath.startsWith("/scl/"))) {
      // 把 rewrite 时附带的其余查询串也拼上（除了 __p 自身）
      const q = new URLSearchParams(url.searchParams);
      q.delete("__p");
      const qs = q.toString();
      const shareLike = "https://www.dropbox.com" + passthroughPath + (qs ? "?" + qs : "");
      return await proxyDropbox(request, shareLike);
    }

    // 其它路径：简单用法提示
    return new Response(
      "Usage:\n1) /api/dropbox?u=<dropbox-share-url>\n2) /s... or /scl... (enabled via vercel.json rewrites)",
      { status: 200, headers: corsHeaders(request.headers) }
    );
  } catch (err) {
    return new Response("Internal Error: " + (err?.message || String(err)), {
      status: 500,
      headers: corsHeaders()
    });
  }
}

async function proxyDropbox(incomingRequest, inputUrl) {
  const upstreamUrl = toDirectDropbox(inputUrl); // 仅改域名+dl=1，保留其余 query
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

  // 带回退的请求（直链失败 → 回退到分享域名再试）
  const upstreamResp = await fetchWithFallback(u, fwdHeaders);

  // 构造响应头（CORS + 关键头 + MIME 修正）
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
  // 必要时修正 MIME，避免直接下载
  const ct = (out.get("content-type") || "").toLowerCase();
  if (!ct || ct === "application/octet-stream") {
    if (/\.(mp4|m4v|mov)(\?|#|$)/i.test(u.pathname)) {
      out.set("content-type", "video/mp4");
    }
  }
  // 允许内联播放 & 暴露 Range 等头部给浏览器可见
  out.set("content-disposition", "inline");
  out.set("access-control-expose-headers", "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified");

  // 流式转发（不会占用内存）
  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: out,
  });
}

/** 直链优先；若 403/429/5xx 则回退到分享域名再试一遍（含轻微退避） */
async function fetchWithFallback(u, headers) {
  let r = await fetch(u.toString(), { method: "GET", headers, redirect: "follow" });

  if ([403, 429, 500, 502, 503, 504].includes(r.status)) {
    const shareURL = new URL(u.toString());
    shareURL.hostname = "www.dropbox.com";
    // 仍确保 dl=1（并保留所有原始 query：rlkey/st 等）
    shareURL.searchParams.set("dl", "1");
    // 简单指数退避（300ms）
    await new Promise(res => setTimeout(res, 300));
    r = await fetch(shareURL.toString(), { method: "GET", headers, redirect: "follow" });
  }
  return r;
}

/** 仅把 *.dropbox.com → dl.dropboxusercontent.com，并 set dl=1；其它 query 原样保留 */
function toDirectDropbox(input) {
  const url = new URL(input);
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

// ---------- 小工具 ----------
function copyInIfPresent(src, dst, name) {
  const v = src.get(name);
  if (v) dst.set(name, v);
}
function copyHeader(src, dst, name) {
  const v = src.get(name);
  if (v) dst.set(name, v);
}
function corsHeaders(reqHeaders) {
  const origin =
    (reqHeaders && (reqHeaders.get("origin") || reqHeaders.get("Origin"))) || "*";
  const acrh =
    (reqHeaders &&
      (reqHeaders.get("access-control-request-headers") ||
       reqHeaders.get("Access-Control-Request-Headers"))) ||
    "Range, If-Modified-Since, If-None-Match, Content-Type";
  const h = new Headers();
  h.set("access-control-allow-origin", origin);
  h.set("access-control-allow-credentials", "true");
  h.set("access-control-allow-methods", "GET,HEAD,OPTIONS");
  h.set("access-control-allow-headers", acrh);
  h.set("cross-origin-resource-policy", "cross-origin");
  h.set("timing-allow-origin", origin);
  return h;
}
