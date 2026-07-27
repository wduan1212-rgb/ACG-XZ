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
