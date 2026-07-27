/* v120 前端隔离预览：
   - 本工作树只提供前端静态文件；
   - 业务 API、下载与未覆盖路径透明转发到已运行的 v119；
   - 只监听 127.0.0.1，绝不启动第二套数据库服务。 */

import http from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { normalize as normalizeUrlPath } from "node:path/posix";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SCRIPT_PATH));
const PORT = Number(process.env.PREVIEW_PORT || 8788);
const HOST = "127.0.0.1";
const UPSTREAM = new URL(process.env.PREVIEW_UPSTREAM || "http://127.0.0.1:8787");
const LOCAL_PREFIXES = ["/js/", "/styles/", "/assets/", "/vendor/", "/XZ-Design/"];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav"
};

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function shouldServeLocal(pathname) {
  return pathname === "/" || pathname === "/index.html" || LOCAL_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function safeLocalPath(pathname, root = ROOT) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(String(pathname || "/"));
  } catch {
    return "";
  }

  // Backslashes are separators on Windows and ambiguous on POSIX. NUL bytes
  // are never valid static paths. Reject both before canonicalisation.
  if (decoded.includes("\0") || decoded.includes("\\")) return "";

  const canonical = normalizeUrlPath(`/${decoded.replace(/^\/+/, "")}`);
  if (!shouldServeLocal(canonical)) return "";

  const requested = canonical === "/" ? "/index.html" : canonical;
  const local = resolve(root, `.${requested}`);
  return isInside(resolve(root), local) ? local : "";
}

async function resolveLocalFile(pathname, root = ROOT) {
  const lexicalTarget = safeLocalPath(pathname, root);
  if (!lexicalTarget) return "";
  try {
    const [realRoot, realTarget] = await Promise.all([
      realpath(root),
      realpath(lexicalTarget)
    ]);
    return isInside(realRoot, realTarget) ? realTarget : "";
  } catch {
    return "";
  }
}

async function serveLocal(req, res, pathname, root = ROOT) {
  const target = await resolveLocalFile(pathname, root);
  if (!target) return false;
  try {
    const info = await stat(target);
    if (!info.isFile()) return false;
    const headers = {
      "Content-Type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff"
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD") res.end();
    else {
      const stream = createReadStream(target);
      stream.on("error", error => res.destroy(error));
      stream.pipe(res);
    }
    return true;
  } catch {
    return false;
  }
}

function proxyToV119(req, res, upstream = UPSTREAM) {
  // Ignore an absolute-form request target's origin. This prevents the local
  // preview server from becoming an open proxy while preserving path/query.
  let incoming;
  try {
    incoming = new URL(req.url || "/", "http://preview.invalid");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, detail: "无效的预览请求地址" }));
    return;
  }

  const headers = { ...req.headers, host: upstream.host };
  delete headers["accept-encoding"];
  const proxy = http.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    path: `${incoming.pathname}${incoming.search}`,
    method: req.method,
    headers
  }, upstreamRes => {
    const responseHeaders = { ...upstreamRes.headers, "cache-control": "no-store, max-age=0" };
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });
  proxy.on("error", error => {
    if (res.headersSent) return res.destroy(error);
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, detail: `v119 预览上游不可用：${error.message}` }));
  });
  req.pipe(proxy);
}

function createPreviewServer({ root = ROOT, upstream = UPSTREAM } = {}) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://preview.invalid");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, detail: "无效的预览请求地址" }));
      return;
    }

    if (["GET", "HEAD"].includes(req.method || "GET")) {
      if (await serveLocal(req, res, url.pathname, root)) return;
    }
    proxyToV119(req, res, upstream);
  });
}

if (resolve(process.argv[1] || "") === SCRIPT_PATH) {
  const server = createPreviewServer();
  server.listen(PORT, HOST, () => {
    console.log(`[v120-preview] http://${HOST}:${PORT}`);
    console.log(`[v120-preview] static=${ROOT}`);
    console.log(`[v120-preview] upstream=${UPSTREAM.origin}`);
  });
}

export {
  ROOT,
  createPreviewServer,
  resolveLocalFile,
  safeLocalPath,
  shouldServeLocal
};
