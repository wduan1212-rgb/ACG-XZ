import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = async path => readFile(new URL(path, root), "utf8");

test("registration creates a personal account and keeps the role selector hidden", async () => {
  const [indexHtml, mainJs] = await Promise.all([
    read("index.html"),
    read("js/main.js"),
  ]);
  assert.match(indexHtml, /注册账号/);
  assert.match(mainJs, /roleField\.hidden = true/);
  assert.match(mainJs, /requestMember\(\{ name, username, pin, role: "user" \}\)/);
  assert.match(mainJs, /等待 ACG 市场部管理员审批/);
});

test("personal entry routes to the new home while suppliers retain their current home", async () => {
  const [mainJs, routerJs] = await Promise.all([
    read("js/main.js"),
    read("js/core/router.js"),
  ]);
  assert.match(routerJs, /location\.hash \|\| "#\/home"/);
  assert.match(mainJs, /supplierRole \? "overview" : "home"/);
  assert.match(mainJs, /parent \? "首页" : "数据看板"/);
  assert.match(mainJs, /zone === "home" && !supplier/);
});

test("home exposes the three personal tools and treats batch production as a team skill", async () => {
  const homeJs = await read("js/views/home.js");
  assert.match(homeJs, /无限画布/);
  assert.match(homeJs, /视频工坊/);
  assert.match(homeJs, /语音生成/);
  assert.match(homeJs, /title: "批量内容生产"/);
  assert.match(homeJs, /entitlement: "batch"/);
  assert.match(homeJs, /加入技能库/);
});

test("locked team routes redirect to the join-team page", async () => {
  const [mainJs, routerJs, settingsJs] = await Promise.all([
    read("js/main.js"),
    read("js/core/router.js"),
    read("js/views/settings.js"),
  ]);
  assert.match(mainJs, /go\("settings", "team"\)/);
  assert.match(routerJs, /entitlementByRoute/);
  assert.match(routerJs, /!hasEntitlement\(entitlementByRoute\[zone\]\)/);
  assert.match(settingsJs, /申请会发送给该团队的所有者和管理员/);
  assert.match(settingsJs, /requestJoin/);
});

test("internal team settings keep products and usage while profile remains a separate account action", async () => {
  const [mainJs, settingsJs] = await Promise.all([
    read("js/main.js"),
    read("js/views/settings.js"),
  ]);
  assert.match(mainJs, /contextRow\(\{ title: "产品库"[^}]*page: "products"/);
  assert.match(mainJs, /contextRow\(\{ title: "模型用量"[^}]*page: "usage"/);
  assert.match(mainJs, /data-account-action="profile"/);
  const managementStart = mainJs.indexOf('key: "management"');
  const managementEnd = mainJs.indexOf("const supplierSettingsPage", managementStart);
  assert.ok(managementStart >= 0 && managementEnd > managementStart);
  assert.doesNotMatch(mainJs.slice(managementStart, managementEnd), /title: "个人资料"/);
  assert.match(settingsJs, /managementPages = new Set\(\["members", "products", "usage", "requests"\]\)/);
});

test("all runtime modules share the v122 cache identity", async () => {
  const [indexHtml, mainJs] = await Promise.all([
    read("index.html"),
    read("js/main.js"),
  ]);
  assert.match(indexHtml, /20260729-v122-static-1/);
  assert.match(mainJs, /APP_BUILD_ID = "20260729-v122-static-1"/);
  assert.doesNotMatch(indexHtml + mainJs, /20260729-v121-shell-22|20260729-v122-shell-1/);
});
