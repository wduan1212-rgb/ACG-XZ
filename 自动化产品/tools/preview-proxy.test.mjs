import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPreviewServer,
  resolveLocalFile,
  safeLocalPath
} from "./preview-proxy.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

function request({ port, path = "/", method = "GET" }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.once("error", reject);
    req.end();
  });
}

test("safeLocalPath canonicalises before applying the local allowlist", async t => {
  const root = await mkdtemp(join(tmpdir(), "preview-proxy-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(safeLocalPath("/assets/app.js", root), join(root, "assets", "app.js"));
  assert.equal(safeLocalPath("/", root), join(root, "index.html"));

  for (const unsafe of [
    "/assets/%2e%2e%2fsecret.txt",
    "/assets/%2E%2E%2Fserver%2Fmain.py",
    "/assets/%5c..%5csecret.txt",
    "/assets/%E0%A4%A"
  ]) {
    assert.equal(safeLocalPath(unsafe, root), "", unsafe);
  }
});

test("resolveLocalFile rejects a symlink that escapes the static root", async t => {
  const root = await mkdtemp(join(tmpdir(), "preview-proxy-root-"));
  const outside = await mkdtemp(join(tmpdir(), "preview-proxy-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  await mkdir(join(root, "assets"));
  await writeFile(join(outside, "secret.txt"), "private");
  await symlink(join(outside, "secret.txt"), join(root, "assets", "escape.txt"));

  assert.equal(await resolveLocalFile("/assets/escape.txt", root), "");
});

test("preview serves allowed files, proxies encoded traversal, and pins absolute requests to upstream", async t => {
  const root = await mkdtemp(join(tmpdir(), "preview-proxy-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<h1>v120</h1>");
  await writeFile(join(root, "secret.txt"), "must-not-be-served");

  const seen = [];
  const upstreamServer = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`upstream:${req.url}`);
  });
  const upstreamPort = await listen(upstreamServer);
  t.after(() => close(upstreamServer));

  const previewServer = createPreviewServer({
    root,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`)
  });
  const previewPort = await listen(previewServer);
  t.after(() => close(previewServer));

  const local = await request({ port: previewPort, path: "/" });
  assert.equal(local.status, 200);
  assert.equal(local.body, "<h1>v120</h1>");
  assert.equal(local.headers["cache-control"], "no-store, max-age=0");

  const traversal = await request({
    port: previewPort,
    path: "/assets/%2e%2e%2fsecret.txt"
  });
  assert.equal(traversal.body, "upstream:/assets/%2e%2e%2fsecret.txt");
  assert.equal(seen.at(-1).url, "/assets/%2e%2e%2fsecret.txt");

  const absolute = await request({
    port: previewPort,
    path: "http://example.invalid/api/health?probe=1"
  });
  assert.equal(absolute.body, "upstream:/api/health?probe=1");
  assert.equal(seen.at(-1).url, "/api/health?probe=1");
  assert.equal(seen.at(-1).host, `127.0.0.1:${upstreamPort}`);
});

test("preview serves the v120 canvas build locally without falling back to v119", async t => {
  const root = await mkdtemp(join(tmpdir(), "preview-proxy-canvas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canvasChunks = join(root, "vendor", "infinite-canvas", "_next", "static", "chunks");
  await mkdir(canvasChunks, { recursive: true });
  await writeFile(
    join(root, "vendor", "infinite-canvas", "index.html"),
    '<!doctype html><script src="/XZ-Design/_next/static/chunks/app.js"></script><main>v120 canvas</main>'
  );
  await writeFile(join(canvasChunks, "app.js"), "window.__canvasBuild = 'v120';");

  const seen = [];
  const upstreamServer = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`v119:${req.url}`);
  });
  const upstreamPort = await listen(upstreamServer);
  t.after(() => close(upstreamServer));

  const previewServer = createPreviewServer({
    root,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`)
  });
  const previewPort = await listen(previewServer);
  t.after(() => close(previewServer));

  const shell = await request({ port: previewPort, path: "/XZ-Design/" });
  assert.equal(shell.status, 200);
  assert.match(shell.body, /v120 canvas/);

  const asset = await request({
    port: previewPort,
    path: "/XZ-Design/_next/static/chunks/app.js"
  });
  assert.equal(asset.status, 200);
  assert.equal(asset.body, "window.__canvasBuild = 'v120';");

  const missing = await request({
    port: previewPort,
    path: "/XZ-Design/_next/static/chunks/missing.js"
  });
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).detail, "v120 画布静态资源不存在");
  assert.deepEqual(seen, []);
});

test("preview uses the v120 video shell and assets without replacing the v119 API", async t => {
  const root = await mkdtemp(join(tmpdir(), "preview-proxy-video-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const videoAssets = join(root, "apps", "video-workshop", "web", "assets");
  await mkdir(videoAssets, { recursive: true });
  await writeFile(
    join(root, "apps", "video-workshop", "web", "index.html"),
    `<!doctype html><html><head>
      <script>(() => {
        const embedded = new URLSearchParams(window.location.search).get("embed") === "1";
        if (embedded) document.documentElement.dataset.platformWorkspace = "true";
      })();</script>
      <style>.workspace-v120-video { background: #fff; }</style>
    </head><body><main class="workspace-v120-video">v120 video</main>
      <script src="/assets/app.js?v=20260727-v120-shell-6"></script>
    </body></html>`
  );
  await writeFile(join(videoAssets, "app.js"), "window.__videoBuild = 'v120';");

  const seen = [];
  const upstreamServer = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith("/custom-video/api/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true,"source":"v119"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body><main>v119 video</main>
      <script>(() => {
        const APP_SRC = "/custom-video/assets/app.js?v=old";
        const TOKEN_KEY = "dumate.token";
        window.__boot = { APP_SRC, TOKEN_KEY };
      })();</script>
    </body></html>`);
  });
  const upstreamPort = await listen(upstreamServer);
  t.after(() => close(upstreamServer));

  const previewServer = createPreviewServer({
    root,
    upstream: new URL(`http://127.0.0.1:${upstreamPort}`)
  });
  const previewPort = await listen(previewServer);
  t.after(() => close(previewServer));

  const shell = await request({
    port: previewPort,
    path: "/custom-video/?embed=1&start=home"
  });
  assert.equal(shell.status, 200);
  assert.match(shell.body, /data-platform-embedded="true"/);
  assert.match(shell.body, /workspace-v120-video/);
  assert.match(shell.body, /platformWorkspace/);
  assert.match(shell.body, /20260727-v120-shell-6/);
  assert.doesNotMatch(shell.body, />v119 video</);
  assert.equal(seen.at(-1), "/custom-video/?embed=1&start=home");

  const asset = await request({
    port: previewPort,
    path: "/custom-video/assets/app.js?v=20260727-v120-shell-6"
  });
  assert.equal(asset.status, 200);
  assert.equal(asset.body, "window.__videoBuild = 'v120';");

  const api = await request({
    port: previewPort,
    path: "/custom-video/api/health"
  });
  assert.equal(api.status, 200);
  assert.equal(JSON.parse(api.body).source, "v119");
  assert.equal(seen.at(-1), "/custom-video/api/health");
});
