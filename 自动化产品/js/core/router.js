/* hash 路由：#/zone 或 #/studio/<page>
   zones: home | subscription | overview | custom | voice(兼容入口) | agent | studio | assets | drafts | delivery | analytics | settings */

import { $, $$ } from "./util.js";
import { state, hasEntitlement } from "./store.js";

const routes = new Map();   // zone -> { render(root, params), title }
let current = { zone: null, page: null, resourceId: null };
let allowStudioFromAgentUntil = 0;

export function registerView(zone, view) { routes.set(zone, view); }

export function parseHash() {
  const h = (location.hash || "#/home").replace(/^#\/?/, "");
  const [zone, page, encodedResourceId] = h.split("/");
  let resourceId = null;
  if (encodedResourceId) {
    try {
      resourceId = decodeURIComponent(encodedResourceId);
    } catch (_) {
      resourceId = encodedResourceId;
    }
  }
  return {
    zone: zone || "home",
    page: page || null,
    resourceId: resourceId || null,
  };
}

export function go(zone, page = null, resourceId = null) {
  if (zone === "studio" && current.zone === "agent" && Date.now() > allowStudioFromAgentUntil) {
    console.warn("[agent-route-lock] blocked automatic studio navigation from batch workspace");
    if ((location.hash || "") !== "#/agent") location.hash = "#/agent";
    else render();
    return;
  }
  const target = "#/" + zone
    + (page ? "/" + page : "")
    + (page && resourceId ? "/" + encodeURIComponent(String(resourceId)) : "");
  if (location.hash === target) render();
  else location.hash = target;
}

export function allowStudioFromAgent(ms = 3000) {
  allowStudioFromAgentUntil = Date.now() + ms;
}

export function currentRoute() { return { ...current }; }

export function supplierRouteForRole(role, zone) {
  if (role === "supplier_child") return "delivery";
  if (["supplier", "supplier_parent"].includes(role)) {
    return ["overview", "assets", "delivery", "settings"].includes(zone) ? zone : "overview";
  }
  return zone;
}

export function render() {
  const previous = { ...current };
  let { zone, page, resourceId } = parseHash();
  // 旧语音直链继续可用，但统一收口到“定制创作”外壳。
  if (zone === "voice") {
    zone = "custom";
    page = "voice";
    resourceId = null;
  }
  if (zone === "custom") {
    if (!["video", "canvas", "voice"].includes(page)) {
      page = "video";
      resourceId = null;
    }
    if (page === "voice") resourceId = null;
    const canonical = `#/custom/${page}${resourceId ? `/${encodeURIComponent(resourceId)}` : ""}`;
    if (location.hash !== canonical) {
      // 只规范 URL，不触发第二次 hashchange/render，避免子应用重复挂载和页面闪烁。
      history.replaceState(null, "", canonical);
    }
  }
  if (zone === "studio" && current.zone === "agent" && Date.now() > allowStudioFromAgentUntil) {
    console.warn("[agent-route-lock] blocked hash studio navigation from batch workspace");
    zone = "agent"; page = null; resourceId = null; location.hash = "#/agent";
  }
  if (zone === "studio") allowStudioFromAgentUntil = 0;
  // 游客可以浏览首页、订阅和空资产空间，但任何创作入口都先回到首页并
  // 打开登录弹窗。直接输入 hash 也不能绕过这一层。
  if (state.role === "guest" && !["home", "subscription", "assets"].includes(zone)) {
    window.dispatchEvent(new CustomEvent("xingzhen:auth-required", {
      detail: { reason: "create", target: { zone, page, resourceId } }
    }));
    zone = "home"; page = null; resourceId = null;
    history.replaceState(null, "", "#/home");
  }
  // 供应商使用独立工作区。这里必须先固定角色可访问的落点，并在下方跳过
  // 创作端 entitlement 检查；供应商只拥有 supplier entitlement，若继续套用
  // dashboard/assets/delivery 会再次被错误改回 #/home。
  const supplierRole = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  const supplierZone = supplierRouteForRole(state.role, zone);
  if (supplierZone !== zone) {
    zone = supplierZone; page = null; resourceId = null;
    history.replaceState(null, "", `#/${zone}`);
  }
  const entitlementByRoute = {
    overview: "dashboard",
    studio: "studio",
    agent: "batch",
    assets: "assets",
    drafts: "studio",
    delivery: "delivery",
    analytics: "analytics",
  };
  if (!supplierRole && entitlementByRoute[zone] && !hasEntitlement(entitlementByRoute[zone])) {
    zone = "home"; page = null; resourceId = null; location.hash = "#/home";
  }
  const customEntitlement = zone === "custom"
    ? { video: "video_workshop", canvas: "canvas", voice: "voice" }[page || "video"]
    : "";
  if (!supplierRole && customEntitlement && !hasEntitlement(customEntitlement)) {
    zone = "home"; page = null; resourceId = null; location.hash = "#/home";
  }
  if (!routes.has(zone)) { zone = "home"; page = null; resourceId = null; }
  current = { zone, page, resourceId };

  document.body.dataset.zone = zone;
  const workspaceShell = document.body.classList.contains("workspace-shell-v2");
  document.body.classList.toggle("immersive", !workspaceShell && (zone === "agent" || zone === "custom"));

  // 导航高亮
  $$("[data-nav]").forEach(b => b.classList.toggle("is-active", b.dataset.nav === zone));

  const view = routes.get(zone);
  const root = $("#viewRoot");
  if (!root) {
    console.error("[router] missing #viewRoot");
    return;
  }
  const preserveCustomShell = previous.zone === "custom"
    && zone === "custom"
    && root.querySelector(".custom-creation-shell");
  if (!preserveCustomShell) {
    try {
      root.__viewCleanup?.();
    } catch (e) {
      console.warn("[router-cleanup]", e);
    }
    root.__viewCleanup = null;
    root.__assetDropController?.abort();
    root.__assetDropController = null;
    root.classList.remove("drag-over");
    delete root.dataset.dropHint;
    root.scrollTop = 0;
  }
  try {
    view.render(root, { page, resourceId });
  } catch (e) {
    console.error("[router]", e);
    root.innerHTML = `<div class="view-error" style="margin:32px;padding:18px 20px;border:1px solid #ffd8a8;background:#fff4e6;border-radius:14px;color:#7c2d12"><b>页面渲染出错</b><p>${(e && e.message) || e}</p><button class="btn ghost sm" onclick="location.reload()">刷新重试</button></div>`;
  }
  window.dispatchEvent(new CustomEvent("view:rendered", { detail: current }));
}

export function initRouter() {
  window.addEventListener("hashchange", render);
}
