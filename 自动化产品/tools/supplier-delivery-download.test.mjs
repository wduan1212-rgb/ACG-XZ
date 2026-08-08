import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.get(key) || ""; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};
globalThis.sessionStorage = {
  getItem() { return ""; },
  setItem() {},
};
globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
globalThis.window = {
  addEventListener() {},
  dispatchEvent() {},
  __toast() {},
};

const requests = [];
let failAsset = "";
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input), globalThis.location.origin);
  if (url.pathname === "/api/health") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  requests.push({
    path: url.pathname,
    deliveryId: url.searchParams.get("deliveryId"),
    authorization: options.headers?.Authorization || "",
  });
  if (failAsset && url.pathname.includes(failAsset)) {
    return new Response(JSON.stringify({ detail: "媒体不存在或无权访问" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname.startsWith("/api/files/")) {
    const marker = url.pathname.includes("pack-1") ? [1, 2, 3] : [4, 5, 6, 7];
    return new Response(new Uint8Array(marker), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  }
  if (url.pathname === "/api/video/composed/final.mp4") {
    return new Response(new Uint8Array([9, 8, 7, 6]), {
      status: 200,
      headers: { "Content-Type": "video/mp4" },
    });
  }
  return new Response("not found", { status: 404 });
};

const remote = await import("../js/core/remote.js");
const { state } = await import("../js/core/store.js");
const { buildZipBlob } = await import("../js/core/util.js");
const { deliveryEntries, deliveryScopedMediaUrl } = await import("../js/domain/delivery.js");

remote.setToken("supplier-test-token");
await remote.init();
state.role = "supplier_child";
state.ui.currentMemberId = "supplier-child";
state.accounts = [];
state.productions = [];
state.jobs = [];
state.assets = [
  {
    id: "pack-1",
    name: "Pack 1",
    type: "图片",
    storage: "server",
    serverFileName: "owner--pack-1.png",
    fileUrl: "/api/files/owner--pack-1.png",
  },
  {
    id: "pack-2",
    name: "Pack 2",
    type: "图片",
    storage: "server",
    serverFileName: "owner--pack-2.png",
    fileUrl: "/api/files/owner--pack-2.png",
  },
];

function zipEntries(bytes) {
  const names = [];
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 30 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const size = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    names.push(decoder.decode(bytes.slice(nameStart, nameStart + nameLength)));
    offset = nameStart + nameLength + extraLength + size;
  }
  return names;
}

test("supplier image and video downloads build real complete zip entries", async () => {
  const imageDelivery = {
    id: "delivery-images",
    delivered: true,
    type: "图集",
    name: "Image delivery",
    title: "Image title",
    copy: "Image copy",
    coverAssetId: "pack-1",
    packAssetIds: ["pack-1", "pack-2"],
  };
  const imageRows = await deliveryEntries(imageDelivery);
  const imageZip = new Uint8Array(await buildZipBlob(imageRows).arrayBuffer());
  assert.deepEqual(zipEntries(imageZip), [
    "标题文案.txt",
    "封面图.png",
    "图片/01.png",
    "图片/02.png",
  ]);

  const videoDelivery = {
    id: "delivery-video",
    delivered: true,
    type: "视频",
    name: "Video delivery",
    videoUrl: "/api/video/composed/final.mp4",
  };
  const videoRows = await deliveryEntries(videoDelivery);
  const videoZip = new Uint8Array(await buildZipBlob(videoRows).arrayBuffer());
  assert.deepEqual(zipEntries(videoZip), [
    "标题文案.txt",
    "视频/01.mp4",
    "视频下载链接.txt",
  ]);

  assert.ok(requests.length >= 4);
  assert.ok(requests.every(request => request.deliveryId));
  assert.ok(requests.every(request => request.authorization === "Bearer supplier-test-token"));
  assert.ok(requests.some(request => request.deliveryId === "delivery-images"));
  assert.ok(requests.some(request => request.deliveryId === "delivery-video"));
});

test("supplier thumbnails and previews use the exact delivery-linked media grant", () => {
  assert.equal(
    deliveryScopedMediaUrl("/api/files/owner--pack-1.png?asset_rev=abc", "delivery-images"),
    "/api/files/owner--pack-1.png?asset_rev=abc&deliveryId=delivery-images",
  );
  assert.equal(
    deliveryScopedMediaUrl("/api/video/composed/final.mp4", "delivery-video"),
    "/api/video/composed/final.mp4?deliveryId=delivery-video",
  );
  assert.equal(
    deliveryScopedMediaUrl("https://cdn.example.test/public.png", "delivery-images"),
    "https://cdn.example.test/public.png",
  );
  assert.equal(
    deliveryScopedMediaUrl("//attacker.example/api/files/owner--pack-1.png", "delivery-images"),
    "//attacker.example/api/files/owner--pack-1.png",
  );
  assert.equal(
    deliveryScopedMediaUrl("/api/files/owner--pack-1.png", "delivery-images", "editor"),
    "/api/files/owner--pack-1.png",
  );
});

test("one denied dependency aborts instead of producing a text-only zip", async () => {
  failAsset = "pack-2";
  await assert.rejects(
    deliveryEntries({
      id: "delivery-incomplete",
      delivered: true,
      type: "图集",
      name: "Incomplete delivery",
      packAssetIds: ["pack-1", "pack-2"],
    }),
    /第 2 张图片下载失败：媒体不存在或无权访问/,
  );
  failAsset = "";
  await assert.rejects(
    deliveryEntries({
      id: "delivery-video-empty",
      delivered: true,
      type: "视频",
      name: "Incomplete video",
      videoUrl: "",
    }),
    /已停止生成不完整 ZIP/,
  );
});
