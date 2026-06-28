/* hash 路由：#/zone 或 #/studio/<page>
   zones: overview | agent | studio | assets | delivery | settings */

import { $, $$ } from "./util.js";
import { state } from "./store.js";

const routes = new Map();   // zone -> { render(root, params), title }
let current = { zone: null, page: null };

export function registerView(zone, view) { routes.set(zone, view); }

export function parseHash() {
  const h = (location.hash || "#/overview").replace(/^#\/?/, "");
  const [zone, page] = h.split("/");
  return { zone: zone || "overview", page: page || null };
}

export function go(zone, page = null) {
  const target = "#/" + zone + (page ? "/" + page : "");
  if (location.hash === target) render();
  else location.hash = target;
}

export function currentRoute() { return { ...current }; }

export function render() {
  let { zone, page } = parseHash();
  // 权限路由：供应商只进发布清单；设置仅管理员
  if (state.role === "supplier" && zone !== "delivery") { zone = "delivery"; page = null; location.hash = "#/delivery"; }
  if (state.role === "editor" && zone === "settings") { zone = "overview"; page = null; location.hash = "#/overview"; }
  if (!routes.has(zone)) { zone = "overview"; page = null; }
  current = { zone, page };

  document.body.dataset.zone = zone;
  document.body.classList.toggle("immersive", zone === "agent");

  // 导航高亮
  $$("[data-nav]").forEach(b => b.classList.toggle("is-active", b.dataset.nav === zone));

  const view = routes.get(zone);
  const root = $("#viewRoot");
  if (!root) {
    console.error("[router] missing #viewRoot");
    return;
  }
  root.scrollTop = 0;
  try {
    view.render(root, { page });
  } catch (e) {
    console.error("[router]", e);
    root.innerHTML = `<div class="view-error" style="margin:32px;padding:18px 20px;border:1px solid #ffd8a8;background:#fff4e6;border-radius:14px;color:#7c2d12"><b>页面渲染出错</b><p>${(e && e.message) || e}</p><button class="btn ghost sm" onclick="location.reload()">刷新重试</button></div>`;
  }
  window.dispatchEvent(new CustomEvent("view:rendered", { detail: current }));
}

export function initRouter() {
  window.addEventListener("hashchange", render);
}
