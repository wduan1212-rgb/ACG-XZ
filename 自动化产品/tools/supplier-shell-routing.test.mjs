import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { supplierRouteForRole } from "../js/core/router.js";

const mainSource = await readFile(new URL("../js/main.js", import.meta.url), "utf8");
const routerSource = await readFile(new URL("../js/core/router.js", import.meta.url), "utf8");

test("supplier parent login and refresh never resolve to the creator home", () => {
  for (const role of ["supplier", "supplier_parent"]) {
    assert.equal(supplierRouteForRole(role, "home"), "overview");
    assert.equal(supplierRouteForRole(role, "custom"), "overview");
    assert.equal(supplierRouteForRole(role, "overview"), "overview");
    assert.equal(supplierRouteForRole(role, "assets"), "assets");
    assert.equal(supplierRouteForRole(role, "delivery"), "delivery");
    assert.equal(supplierRouteForRole(role, "settings"), "settings");
  }
});

test("supplier child is pinned to its delivery workspace", () => {
  for (const zone of ["home", "overview", "assets", "settings", "delivery"]) {
    assert.equal(supplierRouteForRole("supplier_child", zone), "delivery");
  }
});

test("supplier routes bypass creator entitlements without weakening creator checks", () => {
  assert.match(routerSource, /const supplierRole = \["supplier", "supplier_parent", "supplier_child"\]\.includes\(state\.role\)/);
  assert.match(routerSource, /if \(!supplierRole && entitlementByRoute\[zone\] && !hasEntitlement/);
  assert.match(routerSource, /if \(!supplierRole && customEntitlement && !hasEntitlement/);
});

test("login shell still exposes supplier home, all accounts and delivery destinations", () => {
  assert.match(mainSource, /member\.role === "supplier_child" \? "delivery" : supplierRole \? "overview" : "home"/);
  assert.match(mainSource, /\{ key: "overview", label: "首页", zone: "overview"/);
  assert.match(mainSource, /\{ key: "assets", label: "全部账号", zone: "assets"/);
  assert.match(mainSource, /\{ key: "delivery", label: "发布清单", zone: "delivery"/);
});
