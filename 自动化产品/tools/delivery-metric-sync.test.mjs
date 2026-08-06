import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.get(key) || ""; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};
globalThis.sessionStorage = { getItem() { return ""; }, setItem() {} };
globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
globalThis.window = { addEventListener() {}, dispatchEvent() {}, __toast() {} };

const { applyDeliveryMetricProjection } = await import("../js/core/store.js");

test("newer server metric triplets replace stale browser values", () => {
  const asset = {
    id: "delivery-1",
    viewCount: 1,
    viewsUpdatedAt: 100,
    viewsUpdatedBy: "old",
    exposureCount: 2,
    exposureUpdatedAt: 100,
    exposureUpdatedBy: "old",
  };
  const changed = applyDeliveryMetricProjection(asset, {
    id: "delivery-1",
    viewCount: 321,
    viewsUpdatedAt: 200,
    viewsUpdatedBy: "supplier-child",
    exposureCount: 654,
    exposureUpdatedAt: 201,
    exposureUpdatedBy: "supplier-child",
  });
  assert.equal(changed, true);
  assert.deepEqual(asset, {
    id: "delivery-1",
    viewCount: 321,
    viewsUpdatedAt: 200,
    viewsUpdatedBy: "supplier-child",
    exposureCount: 654,
    exposureUpdatedAt: 201,
    exposureUpdatedBy: "supplier-child",
  });
});

test("an older in-flight projection cannot overwrite a just-saved metric", () => {
  const asset = {
    id: "delivery-1",
    viewCount: 777,
    viewsUpdatedAt: 300,
    viewsUpdatedBy: "supplier-parent",
    exposureCount: 888,
    exposureUpdatedAt: 300,
    exposureUpdatedBy: "supplier-parent",
  };
  const changed = applyDeliveryMetricProjection(asset, {
    id: "delivery-1",
    viewCount: 3,
    viewsUpdatedAt: 200,
    viewsUpdatedBy: "stale-tab",
    exposureCount: 4,
    exposureUpdatedAt: 200,
    exposureUpdatedBy: "stale-tab",
  });
  assert.equal(changed, false);
  assert.equal(asset.viewCount, 777);
  assert.equal(asset.exposureCount, 888);
});

test("view and exposure triplets merge independently", () => {
  const asset = {
    id: "delivery-1",
    viewCount: 10,
    viewsUpdatedAt: 500,
    viewsUpdatedBy: "new-view",
    exposureCount: 20,
    exposureUpdatedAt: 100,
    exposureUpdatedBy: "old-exposure",
  };
  const changed = applyDeliveryMetricProjection(asset, {
    id: "delivery-1",
    viewCount: 1,
    viewsUpdatedAt: 400,
    viewsUpdatedBy: "old-view",
    exposureCount: 900,
    exposureUpdatedAt: 600,
    exposureUpdatedBy: "new-exposure",
  });
  assert.equal(changed, true);
  assert.equal(asset.viewCount, 10);
  assert.equal(asset.viewsUpdatedBy, "new-view");
  assert.equal(asset.exposureCount, 900);
  assert.equal(asset.exposureUpdatedBy, "new-exposure");
});

test("server delivery authority clears stale links and synchronizes download state", () => {
  const asset = {
    id: "delivery-1",
    status: "已发布",
    publishedUrl: "https://stale.example/old",
    publishedTitle: "旧标题",
    supplierNote: "旧备注",
    supplierDownloadedAt: 1,
    supplierDownloadedBy: "old-tab",
  };
  const changed = applyDeliveryMetricProjection(asset, {
    id: "delivery-1",
    status: "已下载",
    publishedUrl: "",
    publishedTitle: "",
    supplierNote: "",
    publishedRawText: "",
    publishedAt: 0,
    publishedUpdatedAt: 500,
    publishedUpdatedBy: "supplier-child",
    publishedClearedAt: 500,
    supplierDownloadedAt: 400,
    supplierDownloadedBy: "supplier-parent",
  });
  assert.equal(changed, true);
  assert.equal(asset.status, "已下载");
  assert.equal(asset.publishedUrl, "");
  assert.equal(asset.publishedTitle, "");
  assert.equal(asset.supplierDownloadedAt, 400);
  assert.equal(asset.supplierDownloadedBy, "supplier-parent");
});
