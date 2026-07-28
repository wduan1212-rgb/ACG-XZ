import assert from "node:assert/strict";
import test from "node:test";

import { buildSupplierSearchResults } from "../js/domain/supplierSearch.js";

const accounts = [
  { id: "acc-xd", name: "小钉喵喵", username: "xiaoding", platform: "小红书", mode: "图文" },
  { id: "acc-lt", name: "老刘来测测", username: "laoliu", platform: "视频号", mode: "视频" },
];

const delivered = [
  { asset: { id: "asset-1", name: "办公素材.zip", title: "效率工具清单" }, acc: accounts[0] },
  { asset: { id: "asset-2", name: "教程视频.mp4", title: "三步完成自动化" }, acc: accounts[0] },
  { asset: { id: "asset-3", name: "测评视频.mp4", title: "工具实测" }, acc: accounts[1] },
];

test("账号名同时命中账号和该账号的相关素材", () => {
  const result = buildSupplierSearchResults({ accounts, delivered, query: "小钉" });
  assert.deepEqual(result.accounts.map(item => item.account.id), ["acc-xd"]);
  assert.deepEqual(result.assets.map(item => item.asset.id), ["asset-1", "asset-2"]);
});
test("素材标题可独立命中并保留所属账号", () => {
  const result = buildSupplierSearchResults({ accounts, delivered, query: "自动化" });
  assert.equal(result.accounts.length, 0);
  assert.deepEqual(result.assets.map(item => [item.asset.id, item.acc.id]), [["asset-2", "acc-xd"]]);
});
