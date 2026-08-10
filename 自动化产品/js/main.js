/* 应用入口：装载数据 → 迁移 → 恢复任务 → 外壳 → 路由 */

import { $, $$, esc, uid } from "./core/util.js";
import { icon, brandGlyph } from "./ui/icons.js";
import { db } from "./core/db.js";
import { state, save, saveMembers, on, loadIdentityCache, loadAll, persistNow, pullRemoteBootstrap, hydrateRemoteInBackground, retryRemoteHydration, remoteCollectionHydrationState, cancelRemoteHydration, activeAccount, currentMember, currentTeam, hasEntitlement, canManageAccounts, ROLE_LABEL, productById, ownedBy } from "./core/store.js";
import * as remote from "./core/remote.js";
import { pruneEmptySessions, newSession, renameSession, deleteSession } from "./agent/orchestrator.js?v=20260810-v1413-runtime-finalization-1";
import { migrateFromV4 } from "./core/migrate.js";
import { preloadBlobUrls } from "./domain/assets.js";
import { accountDisplaySequenceMap, deleteAccount, groupOf, platformCode, appearanceAnchorFor, isAccountDisabled, isNewAccount } from "./domain/accounts.js";
import { deliveredAssets, productTagLabel } from "./domain/delivery.js?v=20260810-v1413-runtime-finalization-1";
import { buildSupplierSearchResults } from "./domain/supplierSearch.js";
import { refreshAllAnalytics, syncExistingPublishedAssets } from "./domain/analytics.js?v=20260727-v118-7";
import { ACCOUNT_PROFILE_SEED, ACCOUNT_PROFILE_VERSION } from "./data/accountProfilesSeed.js";
import { applyKeyOverrides, enableServerProxyIfConfigured } from "./api/llm.js?v=20260727-v118-7";
import { refreshProviderStatus } from "./api/providers.js";
import { resumeJobs } from "./api/jobs.js";
import { resumeActiveBatches } from "./agent/orchestrator.js?v=20260810-v1413-runtime-finalization-1";
import { registerView, initRouter, render, go, parseHash, allowStudioFromAgent } from "./core/router.js";
import { toast, confirmModal, promptModal, openModal, openPalette, toggleNotifyPanel, updateNotifyBadge } from "./ui/components.js?v=20260810-v1413-runtime-finalization-1";
import { installSelectEnhancer } from "./ui/selectEnhancer.js?v=20260723-v117-8";
import { initLoginBeams } from "./ui/loginBeams.js?v=20260810-v1413-runtime-finalization-1";
import { installUIEnhancements } from "./ui/uiEnhancements.js";
import { initClientDistribution } from "./ui/clientDistribution.js?v=20260728-v120-shell-13";
import { overviewView } from "./views/overview.js?v=20260810-v1413-runtime-finalization-1";
import { homeView } from "./views/home.js?v=20260810-v1413-runtime-finalization-1";
import { subscriptionView } from "./views/subscription.js?v=20260810-v1413-runtime-finalization-1";
import { voiceLabView } from "./views/voiceLab.js?v=20260810-v1413-runtime-finalization-1";
import { customCreationView } from "./views/customCreation.js?v=20260810-v1413-runtime-finalization-1";
import { agentView, openAgentSession } from "./agent/view.js?v=20260810-v1413-runtime-finalization-1";
import { studioView } from "./views/studio.js?v=20260810-v1413-runtime-finalization-1";
import { assetsView } from "./views/assetsView.js?v=20260810-v1413-runtime-finalization-1";
import { deliveryView } from "./views/deliveryView.js?v=20260810-v1413-runtime-finalization-1";
import { analyticsView } from "./views/analyticsView.js?v=20260727-v118-7";
import { draftsView } from "./views/draftsView.js?v=20260810-v1413-runtime-finalization-1";
import { settingsView } from "./views/settings.js?v=20260810-v1413-runtime-finalization-1";
import "./views/accountDialog.js";
import { stagePage, openProductionDrawer } from "./views/prodDrawer.js?v=20260810-v1413-runtime-finalization-1";
import { productionsOf } from "./domain/productions.js?v=20260810-v1413-runtime-finalization-1";
import { installAccountPublishQuotaAutoRefresh } from "./domain/productionQuota.js?v=20260810-v1413-runtime-finalization-1";

const APP_BUILD_ID = "20260810-v1413-runtime-finalization-1";
const GUEST_MEMBER_ID = "guest-local-preview";
const GUEST_MEMBER = Object.freeze({
  id: GUEST_MEMBER_ID,
  name: "游客",
  username: "guest",
  role: "guest",
  plan: "guest",
  team: null,
  teamId: null,
  teamRole: null,
  dailyPoints: 70,
  points: 70,
  entitlements: ["home", "video_workshop", "canvas", "voice", "assets", "subscription"]
});
let announcedBuildId = "";
const WORKSPACE_HIDDEN_VIDEO_PROJECTS_KEY = "xingzhen.workspaceHiddenVideoProjects";
const WORKSPACE_VIDEO_META_KEY = "xingzhen.workspaceVideoMeta";
let workspaceSwitcherGlobalWired = false;
let workspaceContextFrame = 0;
let workspaceUtilityDockWired = false;
let workspaceProjectOpenRequest = 0;
let workspaceSupplierChildren = [];
let workspaceSupplierBindings = [];
let workspaceProjectOwnerKey = "";
let workspaceProjectGeneration = 0;
const workspaceProjectLists = {
  video: { items: [], loading: false, loadedAt: 0, error: "", pending: null, forcedPending: null },
  canvas: { items: [], loading: false, loadedAt: 0, error: "", pending: null, forcedPending: null },
};

function activeWorkspaceProjectOwnerKey() {
  return String(currentMember()?.id || state.ui.currentMemberId || state.role || "anonymous").trim() || "anonymous";
}

function resetWorkspaceProjectLists(ownerKey = activeWorkspaceProjectOwnerKey()) {
  workspaceProjectOwnerKey = String(ownerKey || "anonymous");
  workspaceProjectGeneration += 1;
  workspaceProjectOpenRequest += 1;
  Object.values(workspaceProjectLists).forEach(target => {
    target.items = [];
    target.loading = false;
    target.loadedAt = 0;
    target.error = "";
    target.pending = null;
    target.forcedPending = null;
  });
}

function ensureWorkspaceProjectOwner() {
  const ownerKey = activeWorkspaceProjectOwnerKey();
  if (workspaceProjectOwnerKey !== ownerKey) resetWorkspaceProjectLists(ownerKey);
  return { ownerKey, generation: workspaceProjectGeneration };
}

function workspaceProjectRequestIsCurrent(ownerKey, generation) {
  return workspaceProjectOwnerKey === ownerKey && workspaceProjectGeneration === generation;
}

function workspaceShellEnabled() {
  return true;
}

function applyWorkspaceShellMode() {
  const enabled = workspaceShellEnabled();
  document.body.classList.toggle("workspace-shell-v2", enabled);
  if (!enabled) document.body.classList.remove("workspace-context-open");
}

applyWorkspaceShellMode();

function showUpdateNotice(nextBuildId) {
  if (!nextBuildId || nextBuildId === APP_BUILD_ID || announcedBuildId === nextBuildId) return;
  announcedBuildId = nextBuildId;
  document.querySelector("#appUpdateNotice")?.remove();
  const node = document.createElement("aside");
  node.id = "appUpdateNotice";
  node.className = "app-update-notice";
  node.innerHTML = `<div><b>发现新版本</b><span>刷新后即可使用最新功能</span></div><button data-update-refresh>刷新</button><button class="icon-btn ghost" data-update-close aria-label="关闭">${icon("x", 14)}</button>`;
  document.body.appendChild(node);
  requestAnimationFrame(() => node.classList.add("is-visible"));
  const close = () => {
    node.classList.remove("is-visible");
    setTimeout(() => node.remove(), 220);
  };
  node.querySelector("[data-update-refresh]").addEventListener("click", () => location.reload());
  node.querySelector("[data-update-close]").addEventListener("click", close);
  setTimeout(close, 15000);
}

async function checkForAppUpdate() {
  try {
    const html = await fetch(`./index.html?update-check=${Date.now()}`, { cache: "no-store" }).then(r => r.ok ? r.text() : "");
    const match = html.match(/js\/main\.js\?v=([^"']+)/);
    if (match?.[1]) showUpdateNotice(match[1]);
  } catch (e) {}
}

function installUpdateChecker() {
  setTimeout(checkForAppUpdate, 30000);
  setInterval(checkForAppUpdate, 180000);
}

function accountFromProfile(profile) {
  const account = {
    id: uid(),
    name: profile.name,
    platform: profile.platform === "视频号" ? "视频号" : "小红书",
    mode: profile.mode === "图文" ? "图文" : "视频",
    subType: profile.mode === "图文" ? "" : (profile.subType === "无数字人" ? "无数字人" : "数字人"),
    position: "",
    styleProfile: profile.styleProfile || "",
    tone: profile.tone || "教程感",
    monthlyDone: 0,
    exportSeq: 0,
    charBoardAssetId: null,
    voiceRefAssetId: null,
    voiceId: profile.voiceId || "",
    voiceName: profile.voiceName || "",
    avatarAssetId: null,
    imageStyleAssetId: null,
    imagePromptTemplate: profile.imagePromptTemplate || "",
    appearanceAnchor: "",
    lockedStyle: null,
    customStyleChips: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  if (account.mode === "视频" && account.subType !== "无数字人") account.appearanceAnchor = appearanceAnchorFor(account);
  return account;
}

async function syncAccountsInChunks() {
  const snap = JSON.parse(JSON.stringify(state.accounts || []));
  await db.replaceAll("accounts", snap).catch(() => null);
  if (!remote.isOn() || !remote.hasToken()) return;
  for (let i = 0; i < snap.length; i += 6) {
    await remote.putCollection("accounts", snap.slice(i, i + 6));
  }
}

async function bootstrapAccountProfilesIfEmpty({ quiet = false } = {}) {
  if ((state.accounts || []).length || state.ui.accountProfileVersion) return 0;
  const rows = ACCOUNT_PROFILE_SEED.map(accountFromProfile);
  state.accounts.push(...rows);
  state.ui.accountProfileVersion = ACCOUNT_PROFILE_VERSION;
  state.ui.activeAccountId = rows[0]?.id || null;
  if (remote.isOn() && remote.hasToken()) {
    await syncAccountsInChunks();
    save("meta");
  } else {
    save("accounts", "meta");
  }
  if (!quiet && rows.length) setTimeout(() => toast(`已初始化账号库：${rows.length} 个账号`), 800);
  return rows.length;
}

function normalizeDeliveredProductTags() {
  let changed = 0;
  state.assets.forEach(asset => {
    if (!asset.delivered) return;
    const tag = asset.productTag || productTagLabel(productById(asset.productId || "dumate"));
    if (!tag) return;
    if (asset.productTag !== tag) { asset.productTag = tag; changed++; }
    asset.tags = Array.isArray(asset.tags) ? asset.tags : [];
    if (!asset.tags.includes(tag)) { asset.tags.push(tag); changed++; }
    const name = String(asset.name || "");
    if (name && !name.includes(`-${tag}-`) && /-(20\d{6})$/.test(name)) {
      asset.name = name.replace(/-(20\d{6})$/, `-${tag}-$1`);
      changed++;
    }
  });
  if (changed) save("assets");
  return changed;
}

function normalizeDeliveredSharedAssets() {
  let changed = 0;
  state.assets.forEach(asset => {
    if (!asset.delivered || asset.type !== "图集") return;
    const tag = asset.productTag || productTagLabel(productById(asset.productId || "dumate"));
    (asset.packAssetIds || []).forEach((id, index) => {
      const img = state.assets.find(x => x.id === id);
      if (!img || img.type !== "图片") return;
      const tags = new Set([...(img.tags || []), "已发布生成图", "共享素材"]);
      if (tag) tags.add(tag);
      if (!img.shared) { img.shared = true; changed++; }
      if (img.sharedSource !== "delivered-production") { img.sharedSource = "delivered-production"; changed++; }
      if (!img.sharedAt) { img.sharedAt = asset.deliveredAt || asset.createdAt || Date.now(); changed++; }
      if (!img.productionId && asset.productionId) { img.productionId = asset.productionId; changed++; }
      if (!img.productId && asset.productId) { img.productId = asset.productId; changed++; }
      if (!img.productTag && tag) { img.productTag = tag; changed++; }
      if (!img.title && asset.title) { img.title = asset.title; changed++; }
      if (!img.name) { img.name = `已发布生成图${String(index + 1).padStart(2, "0")}`; changed++; }
      const nextTags = [...tags];
      if ((img.tags || []).join("|") !== nextTags.join("|")) { img.tags = nextTags; changed++; }
    });
  });
  if (changed) save("assets");
  return changed;
}

/* ---------- 登录（成员账号制：用户名 + 口令） ---------- */
function showGate({ modal = true } = {}) {
  document.documentElement.classList.remove("auth-booting");
  document.documentElement.classList.remove("has-auth-token");
  const gate = $("#loginGate");
  gate.classList.toggle("is-modal", !!modal);
  gate.hidden = false;
  document.body.classList.add("gated");
  document.body.classList.toggle("auth-modal-open", !!modal);
  playLoginBackground();
  setGateBusy(false);
  setGateError("");
  setGateMode("login");
  const u = $("#lgUser"), p = $("#lgPin"), n = $("#lgName"), forgotName = $("#lgForgotName");
  if (u) u.value = ""; if (p) p.value = ""; if (n) n.value = ""; if (forgotName) forgotName.value = "";
  setTimeout(() => u && u.focus(), 80);
}
let gateMode = "login";
let gateTransitionTimer = 0;
let gateTitleTransitionTimer = 0;
let gateBusy = false;
const GATE_PHASES = {
  validating: {
    title: "正在验证账号权限…",
    button: "请稍候"
  },
  syncing: {
    title: "正在进入星阵…",
    button: "即将进入"
  },
  applying: {
    title: "正在创建账号…",
    button: "创建中"
  },
  resetting: {
    title: "正在通知管理员…",
    button: "发送中"
  }
};
function setGateError(message = "") {
  const error = $("#lgGateError");
  if (!error) return;
  error.textContent = String(message || "");
  error.hidden = !message;
}
function setGatePhase(phase = "validating") {
  const config = GATE_PHASES[phase] || GATE_PHASES.validating;
  const card = $(".lg-card"), title = $("#lgModeTitle"), label = $("#lgLogin .lg-login-label");
  if (card) card.dataset.phase = phase;
  if (title) {
    window.clearTimeout(gateTitleTransitionTimer);
    title.classList.remove("is-phase-entering");
    title.textContent = config.title;
    void title.offsetWidth;
    title.classList.add("is-phase-entering");
    gateTitleTransitionTimer = window.setTimeout(() => title.classList.remove("is-phase-entering"), 460);
  }
  if (label) label.textContent = config.button;
}
function setGateBusy(busy, phase = "validating") {
  gateBusy = !!busy;
  const gate = $("#loginGate"), card = $(".lg-card"), loginBtn = $("#lgLogin"), applyBtn = $("#lgApply");
  card?.classList.toggle("is-authenticating", gateBusy);
  card?.setAttribute("aria-busy", gateBusy ? "true" : "false");
  if (loginBtn) loginBtn.disabled = gateBusy;
  if (applyBtn) applyBtn.disabled = gateBusy;
  ["#lgForgot", "#lgGoogle", "#lgPhone"].forEach(selector => {
    const control = $(selector, gate);
    if (control) control.disabled = gateBusy;
  });
  gate?.querySelectorAll(".lg-field input, .lg-field select").forEach(control => { control.disabled = gateBusy; });
  if (gateBusy) setGatePhase(phase);
  else applyGateModeContent(gateMode);
}
function gateRequestError(error, phase = "validating") {
  const raw = String(error?.message || error || "").replace(/^HTTP\s+\d+\s+/, "").trim();
  if (phase === "syncing") return `账号已验证，但工作区同步失败：${raw || "请检查网络后重试"}`;
  if (error?.status === 401 || error?.status === 403) return "用户名或密码不对，再试一次";
  if (/超时|timeout|abort/i.test(raw)) return "登录请求超时，请检查网络后重试";
  return raw ? `登录服务暂时不可用：${raw}` : "登录服务暂时不可用，请稍后重试";
}
async function clearPendingRemoteIdentity() {
  cancelRemoteHydration();
  remote.logout();
  state.role = null;
  state.ui.currentMemberId = null;
  resetWorkspaceProjectLists("anonymous");
  document.documentElement.classList.remove("has-auth-token");
  await Promise.allSettled([
    db.metaSet("role", null),
    db.metaSet("ui", JSON.parse(JSON.stringify(state.ui)))
  ]);
}
function applyGateModeContent(mode) {
  const apply = mode === "apply";
  const forgot = mode === "forgot";
  const card = $(".lg-card");
  if (card) card.dataset.mode = mode;
  const nameField = $("#lgNameField"), roleField = $("#lgRoleField"), forgotNameField = $("#lgForgotNameField");
  const userField = $("#lgUserField"), pinField = $("#lgPinField"), formHelper = $("#lgFormHelper");
  const loginBtn = $("#lgLogin"), applyBtn = $("#lgApply"), applyLead = $("#lgApplyLead"), hint = $("#lgHint"), title = $("#lgModeTitle");
  if (nameField) nameField.hidden = !apply;
  if (roleField) roleField.hidden = true;
  if (forgotNameField) forgotNameField.hidden = !forgot;
  if (userField) userField.hidden = forgot;
  if (pinField) pinField.hidden = forgot;
  if (formHelper) formHelper.hidden = mode !== "login";
  if (title) {
    window.clearTimeout(gateTitleTransitionTimer);
    title.classList.remove("is-phase-entering");
    title.textContent = apply ? "注册账号" : forgot ? "找回密码" : "登录";
  }
  if (loginBtn) {
    const label = apply ? "提交注册" : forgot ? "通知管理员" : "登录";
    const labelNode = loginBtn.querySelector("span");
    if (labelNode) labelNode.textContent = label;
    else loginBtn.textContent = label;
  }
  if (applyBtn) {
    const label = apply || forgot ? "返回登录" : "注册账号";
    const labelNode = applyBtn.querySelector("span");
    if (labelNode) labelNode.textContent = label;
    else applyBtn.textContent = label;
    applyBtn.setAttribute("aria-pressed", mode !== "login" ? "true" : "false");
    applyBtn.title = mode !== "login" ? "返回登录" : "注册账号";
  }
  if (applyLead) applyLead.textContent = mode === "login" ? "还没有账号？" : "";
  if (hint) hint.textContent = apply
    ? "创建个人账号后即可开始使用；用户名不可重复"
    : forgot
      ? "填写你的姓名，管理员会在通知中心收到申请"
      : "登录后继续你的工作区";
}
function setGateMode(mode) {
  const nextMode = ["apply", "forgot"].includes(mode) ? mode : "login";
  const card = $(".lg-card");
  const modeLabel = $("#lgApply span");
  const currentMode = card?.dataset.mode;
  gateMode = nextMode;
  window.clearTimeout(gateTransitionTimer);
  if (!card || !currentMode || currentMode === nextMode || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    card?.classList.remove("is-switching-out", "is-switching-in");
    modeLabel?.classList.remove("is-dissolving", "is-gathering");
    applyGateModeContent(nextMode);
    return;
  }
  card.classList.remove("is-switching-in");
  card.classList.add("is-switching-out");
  modeLabel?.classList.remove("is-gathering");
  modeLabel?.classList.add("is-dissolving");
  gateTransitionTimer = window.setTimeout(() => {
    applyGateModeContent(nextMode);
    card.classList.remove("is-switching-out");
    card.classList.add("is-switching-in");
    modeLabel?.classList.remove("is-dissolving");
    modeLabel?.classList.add("is-gathering");
    gateTransitionTimer = window.setTimeout(() => {
      card.classList.remove("is-switching-in");
      modeLabel?.classList.remove("is-gathering");
    }, 440);
  }, 230);
}
function playLoginBackground() {
  const video = $("#loginBgVideo");
  if (!video) return;
  const tryPlay = () => {
    if ($("#loginGate")?.hidden) return;
    const p = video.play?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  };
  tryPlay();
  if (video.dataset.playWired === "1") return;
  video.dataset.playWired = "1";
  ["pointerdown", "keydown"].forEach(ev => window.addEventListener(ev, tryPlay, { once: true, passive: true }));
}
function pauseLoginBackground() {
  const video = $("#loginBgVideo");
  if (video && !video.paused) video.pause();
}
function applyRoleClasses() {
  applyWorkspaceShellMode();
  document.body.classList.toggle("role-supplier", state.role === "supplier" || state.role === "supplier_parent" || state.role === "supplier_child");
  document.body.classList.toggle("role-supplier-parent", state.role === "supplier" || state.role === "supplier_parent");
  document.body.classList.toggle("role-supplier-child", state.role === "supplier_child");
  document.body.classList.toggle("role-editor", state.role === "editor");
  document.body.classList.toggle("role-user", state.role === "user");
  document.body.classList.toggle("role-guest", state.role === "guest");
  document.body.classList.toggle("role-admin", state.role === "admin");
  const parent = state.role === "supplier" || state.role === "supplier_parent";
  const labels = {
    overview: parent ? "首页" : "数据看板",
    assets: parent ? "全部账号" : "整体资产",
    delivery: "发布清单",
    settings: workspaceShellEnabled() ? "我的" : (state.role === "editor" ? "我的" : "设置")
  };
  Object.entries(labels).forEach(([zone, label]) => {
    const item = document.querySelector(`[data-nav="${zone}"]`);
    if (!item) return;
    item.title = label;
    const span = item.querySelector("span");
    if (span) span.textContent = label;
  });
  const logoutButton = $("#navLogout");
  if (logoutButton) {
    const label = state.role === "guest" ? "登录" : "退出登录";
    logoutButton.title = label;
    logoutButton.setAttribute("aria-label", label);
    const span = logoutButton.querySelector("span");
    if (span) span.textContent = label;
  }
}

function enterGuest({ routeHome = true } = {}) {
  cancelRemoteHydration();
  state.role = "guest";
  state.ui.currentMemberId = GUEST_MEMBER_ID;
  state.members = state.members.filter(member => member.id !== GUEST_MEMBER_ID);
  state.members.unshift({ ...GUEST_MEMBER, entitlements: [...GUEST_MEMBER.entitlements] });
  resetWorkspaceProjectLists(GUEST_MEMBER_ID);
  document.documentElement.classList.remove("has-auth-token");
  pauseLoginBackground();
  const gate = $("#loginGate");
  if (gate) {
    gate.hidden = true;
    gate.classList.remove("is-modal");
  }
  document.body.classList.remove("gated", "auth-modal-open");
  applyRoleClasses();
  if (routeHome) go("home");
  render();
  document.documentElement.classList.remove("auth-booting");
}

function ensureViewRendered(reason = "startup") {
  const root = $("#viewRoot");
  const gate = $("#loginGate");
  if (!root || (gate && !gate.hidden)) return;
  if (root.innerHTML.trim()) return;
  console.warn(`[boot] empty viewRoot after ${reason}; retrying route render`);
  try { render(); } catch (e) { console.error("[boot-render-retry]", e); }
  setTimeout(() => {
    if (!root.innerHTML.trim()) {
      const fallbackRoute = ["supplier", "supplier_parent", "supplier_child"].includes(state.role) ? "overview" : "home";
      console.warn(`[boot] render retry still empty; falling back to ${fallbackRoute}`);
      if ((location.hash || "") !== `#/${fallbackRoute}`) location.hash = `#/${fallbackRoute}`;
      try { render(); } catch (e) { console.error("[boot-render-fallback]", e); }
    }
    if (!root.innerHTML.trim()) {
      root.innerHTML = `<div class="view-error" style="margin:32px;padding:18px 20px;border:1px solid #ffd8a8;background:#fff4e6;border-radius:14px;color:#7c2d12"><b>页面没有渲染出来</b><p>已检测到页面外壳加载成功，但内容区为空。请刷新重试；如果仍出现，点击下方按钮清理本机旧缓存后重新登录。</p><button class="btn ghost sm" id="emptyViewReload">刷新重试</button> <button class="btn ghost sm" id="emptyViewClear">清理本机缓存</button></div>`;
      $("#emptyViewReload")?.addEventListener("click", () => location.reload());
      $("#emptyViewClear")?.addEventListener("click", () => {
        indexedDB.deleteDatabase("dumateStudioV5");
        localStorage.removeItem("dumate.token");
        location.reload();
      });
    }
  }, 350);
}

async function syncAdminPasswordResetNotifications() {
  const member = currentMember();
  const canReviewPlatformAccounts = member?.team?.kind === "internal"
    && ["owner", "admin"].includes(member?.teamRole || "");
  if (!remote.isOn() || !remote.hasToken() || !canReviewPlatformAccounts) return false;
  try {
    const rows = await remote.passwordReset.list();
    const known = new Map(state.notifications.map(item => [item.passwordResetRequestId, item]));
    let changed = false;
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const requestId = String(row.id || "");
      if (!requestId) return;
      const existing = known.get(requestId);
      const next = {
        id: existing?.id || `password-reset-${requestId}`,
        ts: Number(row.createdAt || Date.now()),
        kind: "account",
        title: "收到密码重置申请",
        body: `${String(row.name || "未署名用户")} 请求管理员协助重置密码`,
        read: existing?.read === true,
        passwordResetRequestId: requestId
      };
      if (existing) {
        Object.assign(existing, next);
      } else {
        state.notifications.push(next);
        changed = true;
      }
    });
    if (changed) {
      state.notifications.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
      if (state.notifications.length > 60) state.notifications.length = 60;
      save("notifications");
      updateNotifyBadge();
    }
    return true;
  } catch (error) {
    console.warn("[password-reset-notifications]", error);
    return false;
  }
}

async function syncTeamJoinNotifications() {
  const member = currentMember();
  if (!remote.isOn() || !remote.hasToken() || !["owner", "admin"].includes(member?.teamRole || "")) return false;
  try {
    const result = await remote.teams.requests("pending");
    const rows = Array.isArray(result) ? result : (result?.items || []);
    const known = new Map(state.notifications.map(item => [item.teamJoinRequestId, item]));
    const pendingIds = new Set(rows.map(row => String(row.id || "")).filter(Boolean));
    let changed = false;
    rows.forEach(row => {
      const requestId = String(row.id || "");
      if (!requestId) return;
      const existing = known.get(requestId);
      const next = {
        id: existing?.id || `team-join-${requestId}`,
        ts: Number(row.createdAt || Date.now()),
        kind: "team",
        title: "收到加入团队申请",
        body: `${String(row.memberName || row.name || "用户")} 申请加入 ${String(row.teamName || member.team?.name || "团队")}`,
        read: existing?.read === true,
        priority: "urgent",
        teamJoinRequestId: requestId,
      };
      if (existing) {
        if (Object.entries(next).some(([key, value]) => existing[key] !== value)) changed = true;
        Object.assign(existing, next);
      }
      else {
        state.notifications.push(next);
        changed = true;
      }
    });
    state.notifications.forEach(item => {
      if (!item.teamJoinRequestId || pendingIds.has(String(item.teamJoinRequestId))) return;
      if (item.priority === "urgent") {
        item.priority = "";
        changed = true;
      }
    });
    if (changed) {
      state.notifications.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
      if (state.notifications.length > 60) state.notifications.length = 60;
      save("notifications");
      updateNotifyBadge();
    }
    return true;
  } catch (error) {
    console.warn("[team-join-notifications]", error);
    return false;
  }
}

async function syncAccountNotifications() {
  await Promise.all([
    syncAdminPasswordResetNotifications(),
    syncTeamJoinNotifications(),
  ]);
}

function enterMember(member) {
  state.role = member.role;
  state.ui.currentMemberId = member.id;
  resetWorkspaceProjectLists(member.id);
  save("meta");
  document.documentElement.classList.add("has-auth-token");
  pauseLoginBackground();
  $("#loginGate").hidden = true;
  $("#loginGate").classList.remove("is-modal");
  document.body.classList.remove("gated", "auth-modal-open");
  applyRoleClasses();
  const supplierRole = ["supplier", "supplier_parent", "supplier_child"].includes(member.role);
  go(member.role === "supplier_child" ? "delivery" : supplierRole ? "overview" : "home");
  render();
  // 新工作区外壳、角色样式和首屏内容都已经就位后再解除开屏遮罩，
  // 避免刷新瞬间暴露 index.html 中保留的旧版静态骨架。
  document.documentElement.classList.remove("auth-booting");
  void syncAccountNotifications();
  toast(`欢迎回来 · ${esc(member.name)}（${ROLE_LABEL[member.role] || ""}）`);
}

let hydrationRenderQueued = false;
function renderHydrationProgress() {
  if (hydrationRenderQueued) return;
  hydrationRenderQueued = true;
  requestAnimationFrame(() => {
    hydrationRenderQueued = false;
    const zone = parseHash().zone;
    // 不在后台同步时重挂编辑器、批量台或子应用，避免打断输入与生成任务。
    if (["overview", "assets", "drafts", "delivery", "analytics"].includes(zone)
      || document.querySelector("[data-remote-hydration-gate]")) render();
  });
}

function hydrationCollectionsForView(zone) {
  const supplier = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  if (zone === "overview") return supplier ? ["assets"] : ["productions", "assets"];
  if (zone === "assets" || zone === "delivery") return ["assets"];
  if (zone === "drafts") return ["productions"];
  if (zone === "analytics") return ["assets", "analyticsLinks", "metricSnapshots", "insightReports", "creativeMemory"];
  // 批量工作台只用生产、会话、批次和任务恢复当前上下文。
  // 资产只服务参考图和预览，继续在后台水合，不应阻塞刷新后打开会话。
  // job 轮询在 production 到达后继续后台水合，不再阻塞批量工作台首屏。
  if (zone === "agent") return ["productions", "sessions", "batches"];
  if (zone === "studio") return ["productions", "jobs", "assets"];
  return [];
}

function hydrationAwareView(zone, view) {
  return {
    ...view,
    render(root, params) {
      const required = hydrationCollectionsForView(zone);
      const status = remoteCollectionHydrationState(required);
      if (!remote.isOn() || !remote.hasToken() || (!status.pending.length && !status.failed.length)) {
        view.render(root, params);
        return;
      }
      const failed = status.failed.length > 0;
      root.innerHTML = `<section class="remote-hydration-gate" data-remote-hydration-gate aria-live="polite">
        <div class="remote-hydration-orbit" aria-hidden="true"><i></i><i></i><i></i></div>
        <div><span>${failed ? "工作区同步中断" : "正在同步工作区"}</span>
        <h2>${failed ? "没有把未加载的数据伪装成空内容" : "历史内容正在安全恢复"}</h2>
        <p>${failed ? "服务器数据没有被本地空状态覆盖。请重试同步后再查看本页。" : "页面将在所需数据到达后自动显示，不会先闪现 0 条或空列表。"}</p>
        ${failed ? `<button class="btn primary" type="button" data-remote-hydration-retry>${icon("refresh", 14)} 重新同步</button>` : `<em>正在加载 ${status.pending.length} 组必要数据…</em>`}
        </div>
      </section>`;
      root.querySelector("[data-remote-hydration-retry]")?.addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = "正在重试…";
        const run = retryRemoteHydration({ onProgress: renderHydrationProgress });
        renderHydrationProgress();
        const ok = await run;
        renderHydrationProgress();
        if (!ok) toast("工作区同步仍未完成，请检查网络后重试。服务器数据未被修改。", "error");
      });
    }
  };
}

function recordFirstRender(startedAt, source) {
  requestAnimationFrame(() => remote.recordPerformance("first-render", {
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    source,
    ok: true
  }));
}

function continueRemoteHydration(member, alreadyComplete = false) {
  let batchCollectionsRecovered = false;
  const batchCollectionsReady = new Set();
  const run = alreadyComplete
    ? Promise.resolve(true)
    : hydrateRemoteInBackground({
        memberId: member.id,
        onProgress: progress => {
          if (progress?.error) {
            toast("部分工作区数据同步失败，已自动重试。请刷新页面再试，本地空态不会回写服务器。", "error");
            return;
          }
          const collections = new Set(progress?.collections || []);
          collections.forEach(name => batchCollectionsReady.add(name));
          if (
            !batchCollectionsRecovered
            && ["productions", "sessions", "batches", "jobs"].every(name => batchCollectionsReady.has(name))
          ) {
            batchCollectionsRecovered = true;
            resumeJobs();
            resumeActiveBatches();
          }
          renderHydrationProgress();
        }
      });
  void run.then(synced => {
    if (!synced || state.ui.currentMemberId !== member.id || !remote.hasToken()) return;
    if (!["supplier", "supplier_parent", "supplier_child"].includes(member.role)) {
      normalizeDeliveredProductTags();
      normalizeDeliveredSharedAssets();
    }
    renderHydrationProgress();
    refreshProviderStatus().then(() => {
      renderTopbar();
      if (document.body.dataset.zone === "settings") render();
    }).catch(e => console.warn("[providers]", e));
    resumeJobs();
    resumeActiveBatches();
  });
}

/* 共享后端登录：只等首屏关键集合就进入平台，资产、任务与分析在后台分组同步。 */
async function enterRemote(member) {
  const entryStartedAt = performance.now();
  state.role = member.role;
  state.ui.currentMemberId = member.id;
  const bootstrap = await pullRemoteBootstrap();
  if (!bootstrap.ok) throw new Error("请检查网络后重试");
  const existingMemberIndex = state.members.findIndex(item => item.id === member.id);
  if (existingMemberIndex >= 0) state.members.splice(existingMemberIndex, 1, member);
  else state.members.unshift(member);
  if (!["supplier", "supplier_parent", "supplier_child"].includes(member.role)) {
    await bootstrapAccountProfilesIfEmpty();
  }
  enterMember(member);
  recordFirstRender(entryStartedAt, "login");
  continueRemoteHydration(member, bootstrap.complete);
}
function shakeCard() {
  const card = $(".lg-card");
  card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
async function verifyPbkdf2Pin(pin, stored) {
  const [algo, iterText, saltHex, hashHex] = String(stored || "").split("$");
  const iters = Number(iterText);
  if (algo !== "pbkdf2" || !iters || !saltHex || !hashHex || !window.crypto?.subtle) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: iters }, key, hashHex.length * 4);
    return bytesToHex(bits) === hashHex;
  } catch {
    return false;
  }
}
async function verifyLocalMemberPin(member, pin) {
  if (!member) return false;
  if (member.pinHash) return verifyPbkdf2Pin(pin, member.pinHash);
  return member.pin === pin;
}
function wireGate() {
  const gate = $("#loginGate");
  const submitForgot = async () => {
    if (gateBusy) return;
    if (!remote.isOn()) { toast("当前是本地离线模式，找回密码需要连接共享后端服务"); shakeCard(); return; }
    const name = ($("#lgForgotName").value || "").trim();
    if (!name) { toast("请填写你的姓名"); shakeCard(); return; }
    setGateError("");
    setGateBusy(true, "resetting");
    try {
      await remote.passwordReset.request(name);
      toast("申请已发送，管理员会在通知中心收到消息");
      $("#lgForgotName").value = "";
      setGateMode("login");
    } catch (e) {
      const message = (e.message || "申请发送失败").replace(/^HTTP\s+\d+\s+/, "");
      shakeCard();
      setGateError(message);
      toast(message, "error");
    } finally {
      setGateBusy(false);
    }
  };
  const submitApply = async () => {
    if (gateBusy) return;
    if (!remote.isOn()) { toast("当前是本地离线模式，申请账号需要共享后端服务"); shakeCard(); return; }
    const name = ($("#lgName").value || "").trim();
    const username = ($("#lgUser").value || "").trim();
    const pin = ($("#lgPin").value || "").trim();
    if (!name || !username || !pin) { toast("请填写姓名、用户名和密码"); shakeCard(); return; }
    setGateError("");
    setGateBusy(true, "applying");
    let registered = false;
    try {
      const member = await remote.register({ name, username, pin });
      registered = true;
      setGatePhase("syncing");
      await enterRemote(member);
      toast("注册成功，今天的 70 点体验积分已到账");
    } catch (e) {
      if (registered) await clearPendingRemoteIdentity();
      const message = (e.message || "申请提交失败").replace(/^HTTP\s+\d+\s+/, "");
      shakeCard();
      setGateError(message);
      toast(message, "error");
    } finally {
      setGateBusy(false);
    }
  };
  const submit = async () => {
    if (gateBusy) return;
    if (gateMode === "apply") return submitApply();
    if (gateMode === "forgot") return submitForgot();
    const username = ($("#lgUser").value || "").trim();
    const pin = ($("#lgPin").value || "").trim();
    if (!username || !pin) { toast("请填写用户名和密码"); shakeCard(); return; }
    let phase = "validating";
    setGateError("");
    setGateBusy(true, phase);
    try {
      if (remote.isOn()) {
        const member = await remote.login(username, pin);
        phase = "syncing";
        setGatePhase(phase);
        await enterRemote(member);
      } else {
        let member = null;
        for (const m of state.members) {
          if (m.username === username && await verifyLocalMemberPin(m, pin)) { member = m; break; }
        }
        if (!member) {
          const error = new Error("用户名或密码不对，再试一次");
          error.status = 401;
          throw error;
        }
        phase = "syncing";
        setGatePhase(phase);
        enterMember(member);
      }
    } catch (e) {
      if (phase === "syncing" && remote.isOn()) await clearPendingRemoteIdentity();
      const message = gateRequestError(e, phase);
      $("#lgPin").value = "";
      shakeCard();
      setGateError(message);
      toast(message, "error");
    } finally {
      setGateBusy(false);
    }
  };
  $("#lgLogin", gate).addEventListener("click", submit);
  $("#lgApply", gate).addEventListener("click", () => {
    if (gateBusy) return;
    setGateError("");
    setGateMode(gateMode === "login" ? "apply" : "login");
    setTimeout(() => (gateMode === "apply" ? $("#lgName") : $("#lgUser"))?.focus(), 480);
  });
  $("#lgForgot", gate).addEventListener("click", () => {
    if (gateBusy) return;
    setGateError("");
    setGateMode("forgot");
    setTimeout(() => $("#lgForgotName")?.focus(), 480);
  });
  [$("#lgGoogle", gate), $("#lgPhone", gate)].forEach(button => {
    button?.addEventListener("click", () => toast("暂不支持，等待功能上线"));
  });
  $("#lgModalClose", gate)?.addEventListener("click", () => {
    if (gateBusy) return;
    enterGuest();
  });
  gate.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    submit();
  });
}
function logout() {
  cancelRemoteHydration();
  remote.logout();
  document.body.classList.remove("role-supplier", "role-supplier-parent", "role-supplier-child", "role-editor", "role-admin", "role-user");
  enterGuest();
  showGate({ modal: true });
}

/* ---------- 上下文面板（创作空间 = 账号列表） ---------- */
const collapsedGroups = new Set(state.ui.collapsedGroups || []);

function shortRelativeTime(time) {
  const n = Number(time || 0);
  if (!n) return "刚刚";
  const diff = Date.now() - n;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
  return `${Math.max(1, Math.round(diff / 86_400_000))} 天前`;
}

function workspaceNavItems() {
  const supplierChild = state.role === "supplier_child";
  const supplierParent = state.role === "supplier" || state.role === "supplier_parent";
  if (supplierChild) {
    return [
      { key: "delivery", label: "发布清单", zone: "delivery", iconName: "package" }
    ];
  }
  if (supplierParent) {
    return [
      { key: "overview", label: "首页", zone: "overview", iconName: "grid" },
      { key: "assets", label: "全部账号", zone: "assets", iconName: "users" },
      { key: "delivery", label: "发布清单", zone: "delivery", iconName: "package" }
    ];
  }
  const item = (config, entitlement = "") => ({
    ...config,
    entitlement,
    locked: !!entitlement && !hasEntitlement(entitlement),
  });
  const items = [
    item({ key: "home", label: "首页", zone: "home", iconName: "grid" }, "home"),
    item({ key: "custom-video", label: "视频工坊", zone: "custom", page: "video", iconName: "film" }, "video_workshop"),
    item({ key: "custom-canvas", label: "无限画布", zone: "custom", page: "canvas", iconName: "layers" }, "canvas"),
    item({ key: "custom-voice", label: "语音生成", zone: "custom", page: "voice", iconName: "mic" }, "voice"),
    item({ key: "studio", label: "单号创作", zone: "studio", iconName: "film" }, "studio"),
    item({ key: "agent", label: "批量生产", zone: "agent", iconName: "spark" }, "batch"),
    item({ key: "assets", label: "整体资产", zone: "assets", iconName: "folder" }, "assets"),
    item({ key: "delivery", label: "发布清单", zone: "delivery", iconName: "package" }, "delivery"),
    item({ key: "overview", label: "数据看板", zone: "overview", iconName: "analytics" }, "dashboard")
  ];
  if (currentTeam()) return items;
  const personalOrder = [
    "home", "custom-video", "custom-canvas", "custom-voice", "assets",
    "studio", "agent", "delivery", "overview",
  ];
  const order = new Map(personalOrder.map((key, index) => [key, index]));
  return items.slice().sort((left, right) => (
    (order.get(left.key) ?? Number.MAX_SAFE_INTEGER)
    - (order.get(right.key) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function workspaceCurrentItem() {
  const { zone, page, resourceId } = parseHash();
  const items = workspaceNavItems();
  if (zone === "settings") {
    const member = currentMember();
    const canManageTeam = ["owner", "admin"].includes(member?.teamRole || "");
    const personalPage = page === "profile" || page === "team" || (!canManageTeam && ["editor", "user"].includes(state.role));
    return {
      key: personalPage ? "profile" : "settings",
      label: page === "team" ? "加入团队" : personalPage ? "我的资料" : "管理设置",
      zone: "settings",
      page,
      iconName: personalPage ? "user" : "gear"
    };
  }
  if (zone === "subscription") {
    return { key: "subscription", label: "订阅管理", zone: "subscription", iconName: "spark" };
  }
  if (zone === "custom") return items.find(item => item.zone === "custom" && item.page === (page || "video")) || items.find(item => item.zone === "custom");
  return items.find(item => item.zone === zone) || items[0];
}

function closeWorkspaceSwitcher() {
  const wrap = $("#workspaceSwitcher");
  const button = $("#workspaceSwitchButton");
  if (!wrap || !button) return;
  wrap.classList.remove("is-open");
  button.setAttribute("aria-expanded", "false");
}

function closeWorkspaceAccountMenu({ restoreFocus = false } = {}) {
  const wrap = $("#workspaceAccount");
  const button = $("#workspaceAccountButton");
  if (!wrap || !button) return;
  wrap.classList.remove("is-open");
  button.setAttribute("aria-expanded", "false");
  if (restoreFocus) button.focus();
}

function setWorkspaceContextOpen(open) {
  document.body.classList.toggle("workspace-context-open", !!open);
  $("#workspaceContextToggle")?.setAttribute("aria-expanded", open ? "true" : "false");
}

function openWorkspaceItem(item) {
  if (!item) return;
  if (state.role === "guest" && !["home", "subscription", "assets"].includes(item.zone)) {
    closeWorkspaceSwitcher();
    window.dispatchEvent(new CustomEvent("xingzhen:auth-required", {
      detail: { reason: "create", target: item }
    }));
    return;
  }
  if (item.locked) {
    closeWorkspaceSwitcher();
    toast(`${item.label} 是团队功能。加入团队后即可解锁。`);
    go("settings", "team");
    return;
  }
  const openRequest = ++workspaceProjectOpenRequest;
  closeWorkspaceSwitcher();
  setWorkspaceContextOpen(false);
  if (item.zone === "studio") allowStudioFromAgent();
  if (item.zone === "custom" && ["video", "canvas"].includes(item.page)) {
    const latestProject = workspaceProjectLists[item.page]?.items?.[0];
    if (latestProject) {
      go(item.zone, item.page, latestProject.id);
      return;
    }
    const routeAtRequest = location.hash;
    void loadWorkspaceProjects(item.page, { force: true }).then(items => {
      if (openRequest !== workspaceProjectOpenRequest || location.hash !== routeAtRequest) return;
      const project = items?.[0] || workspaceProjectLists[item.page]?.items?.[0];
      go(item.zone, item.page, project?.id || null);
    });
    return;
  }
  go(item.zone, item.page || null);
}

function renderWorkspaceSwitcher() {
  $("#workspaceShellRestore")?.remove();
  const topbar = document.querySelector(".topbar");
  const crumb = $("#topCrumb");
  const host = $("#workspaceSwitcherHost");
  if (!topbar || !crumb || !host) return;
  if (!workspaceSwitcherGlobalWired) {
    workspaceSwitcherGlobalWired = true;
    document.addEventListener("click", event => {
      if (!event.target.closest?.("#workspaceSwitcher")) closeWorkspaceSwitcher();
      if (!event.target.closest?.("#workspaceAccount")) closeWorkspaceAccountMenu();
      if (!event.target.closest?.("#workspaceUtilityDock")) {
        $("#workspaceUtilityDock")?.classList.remove("is-open");
        $("#topActionsToggle")?.setAttribute("aria-expanded", "false");
      }
      if (document.body.classList.contains("workspace-context-open")
        && !event.target.closest?.("#ctxPanel")
        && !event.target.closest?.("#workspaceContextToggle")) {
        setWorkspaceContextOpen(false);
      }
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        closeWorkspaceSwitcher();
        closeWorkspaceAccountMenu({ restoreFocus: true });
        $("#workspaceUtilityDock")?.classList.remove("is-open");
        $("#topActionsToggle")?.setAttribute("aria-expanded", "false");
        setWorkspaceContextOpen(false);
      }
    });
  }
  const items = workspaceNavItems();
  const current = workspaceCurrentItem() || items[0];
  const homeWorkspace = parseHash().zone === "home";
  const supplierWorkspace = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  const menuItems = supplierWorkspace ? items : items.filter(item => !item.locked);
  let wrap = $("#workspaceSwitcher");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "workspaceSwitcher";
    wrap.className = "workspace-switcher";
    host.appendChild(wrap);
  } else if (wrap.parentElement !== host) {
    host.appendChild(wrap);
  }
  let contextToggle = $("#workspaceContextToggle");
  if (!contextToggle) {
    contextToggle = document.createElement("button");
    contextToggle.id = "workspaceContextToggle";
    contextToggle.className = "workspace-context-toggle";
    contextToggle.type = "button";
    contextToggle.title = "打开当前工作区列表";
    contextToggle.setAttribute("aria-controls", "ctxPanel");
    contextToggle.setAttribute("aria-expanded", "false");
    contextToggle.innerHTML = icon("list", 17);
    contextToggle.addEventListener("click", event => {
      event.stopPropagation();
      setWorkspaceContextOpen(!document.body.classList.contains("workspace-context-open"));
    });
    topbar.insertBefore(contextToggle, topbar.firstChild);
  }
  wrap.classList.toggle("is-static", homeWorkspace);
  const brandMarkup = `
    <span class="workspace-brand-lockup"><img src="./assets/brand/starmatrix-wordmark-blue-transparent.png" alt="星阵" draggable="false" /></span>
    <span class="workspace-switch-copy"><em>${esc(current?.label || "工作区")}</em></span>`;
  wrap.innerHTML = homeWorkspace
    ? `<div class="workspace-switch-button workspace-switch-static" id="workspaceSwitchButton" aria-label="星阵首页">${brandMarkup}</div>`
    : `
      <button class="workspace-switch-button" id="workspaceSwitchButton" type="button" aria-haspopup="menu" aria-expanded="false">
        ${brandMarkup}
        ${icon("chevronDown", 13)}
      </button>
      <div class="workspace-menu" id="workspaceSwitchMenu" role="menu" aria-label="切换工作区">
        ${menuItems.map(item => `
          <button type="button" role="menuitem" class="${item.key === current?.key ? "is-active" : ""}${item.locked ? " is-locked" : ""}" data-ws-switch="${esc(item.key)}">
            ${icon(item.iconName || "grid", 15)}
            <span><b>${esc(item.label)}</b></span>
            ${item.locked ? icon("lock", 13) : item.key === current?.key ? icon("check", 14) : ""}
          </button>
        `).join("")}
      </div>`;
  const button = $("#workspaceSwitchButton", wrap);
  const menu = $("#workspaceSwitchMenu", wrap);
  if (!homeWorkspace) button?.addEventListener("click", event => {
    event.stopPropagation();
    const open = wrap.classList.toggle("is-open");
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) setTimeout(() => menu?.querySelector("[role='menuitem']")?.focus(), 0);
  });
  menu?.addEventListener("click", event => event.stopPropagation());
  menu?.addEventListener("keydown", event => {
    const options = [...menu.querySelectorAll("[role='menuitem']")];
    const index = options.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown"
        ? (index + 1 + options.length) % options.length
        : (index - 1 + options.length) % options.length;
      options[next]?.focus();
    }
  });
  menu?.querySelectorAll("[data-ws-switch]").forEach(itemButton => {
    itemButton.addEventListener("click", () => {
      const item = items.find(candidate => candidate.key === itemButton.dataset.wsSwitch);
      openWorkspaceItem(item);
    });
  });
}

function normalizeWorkspaceProject(kind, raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const project = source.project && typeof source.project === "object" ? source.project : {};
  const projectState = source.projectState && typeof source.projectState === "object" ? source.projectState : {};
  const nestedProject = projectState.project && typeof projectState.project === "object"
    ? projectState.project
    : {};
  const id = kind === "canvas"
    ? String(source.sourceProjectId || source.sourceId || source.id || project.id || "").trim()
    : String(
        source.sourceProjectId
        || projectState.workshopProjectId
        || projectState.sourceProjectId
        || nestedProject.id
        || source.workshopProjectId
        || source.id
        || ""
      ).trim();
  if (!id) return null;
  const title = String(
    source.name
    || source.title
    || project.name
    || project.title
    || nestedProject.name
    || nestedProject.title
    || (kind === "canvas" ? "未命名画布" : "新视频会话")
  ).trim();
  const rawUpdatedAt = (
    source.serverUpdatedAt
    || source.updatedAt
    || source.clientUpdatedAt
    || project.updatedAt
    || nestedProject.updatedAt
    || source.createdAt
    || project.createdAt
    || nestedProject.createdAt
    || 0
  );
  const numericUpdatedAt = Number(rawUpdatedAt || 0);
  const updatedAt = Number.isFinite(numericUpdatedAt) && numericUpdatedAt > 0
    ? numericUpdatedAt
    : (Date.parse(String(rawUpdatedAt || "")) || 0);
  return {
    id: id.slice(0, 180),
    title: title.slice(0, 180) || (kind === "canvas" ? "未命名画布" : "新视频会话"),
    updatedAt,
    status: String(source.status || nestedProject.status || "draft").trim().slice(0, 40),
    publishedCount: Math.max(0, Math.floor(Number(source.publishedCount || 0) || 0)),
  };
}

function workspaceVideoMemberKey() {
  return String(currentMember()?.id || state.ui.currentMemberId || state.role || "local").trim();
}

function readWorkspaceVideoMeta() {
  try {
    const payload = JSON.parse(localStorage.getItem(WORKSPACE_VIDEO_META_KEY) || "{}");
    const member = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload[workspaceVideoMemberKey()]
      : null;
    return {
      groups: Array.isArray(member?.groups)
        ? [...new Set(member.groups.map(group => String(group || "").trim()).filter(Boolean))].slice(0, 40)
        : [],
      projects: member?.projects && typeof member.projects === "object" && !Array.isArray(member.projects)
        ? member.projects
        : {},
    };
  } catch (_) {
    return { groups: [], projects: {} };
  }
}

function writeWorkspaceVideoMeta(nextMember) {
  try {
    const payload = JSON.parse(localStorage.getItem(WORKSPACE_VIDEO_META_KEY) || "{}");
    const next = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    next[workspaceVideoMemberKey()] = {
      groups: [...new Set((nextMember.groups || []).map(group => String(group || "").trim()).filter(Boolean))].slice(0, 40),
      projects: nextMember.projects && typeof nextMember.projects === "object" ? nextMember.projects : {},
    };
    localStorage.setItem(WORKSPACE_VIDEO_META_KEY, JSON.stringify(next));
  } catch (_) {}
}

function workspaceVideoProjectMeta(projectId) {
  const id = String(projectId || "").trim();
  const raw = readWorkspaceVideoMeta().projects[id];
  return raw && typeof raw === "object"
    ? {
        favorite: Boolean(raw.favorite),
        group: String(raw.group || "").trim().slice(0, 48),
        title: String(raw.title || "").trim().slice(0, 180),
      }
    : { favorite: false, group: "", title: "" };
}

function updateWorkspaceVideoProjectMeta(projectId, patch = {}) {
  const id = String(projectId || "").trim();
  if (!id) return;
  const member = readWorkspaceVideoMeta();
  member.projects[id] = {
    ...(member.projects[id] || {}),
    ...patch,
  };
  writeWorkspaceVideoMeta(member);
}

function workspaceSessionGroups(kind) {
  if (kind === "video") return readWorkspaceVideoMeta().groups;
  return Array.isArray(state.ui.batchSessionGroups)
    ? [...new Set(state.ui.batchSessionGroups.map(group => String(group || "").trim()).filter(Boolean))].slice(0, 40)
    : [];
}

function addWorkspaceSessionGroup(kind, name) {
  const group = String(name || "").trim().slice(0, 48);
  if (!group) return "";
  const groups = workspaceSessionGroups(kind);
  if (!groups.includes(group)) groups.push(group);
  if (kind === "video") {
    const member = readWorkspaceVideoMeta();
    member.groups = groups;
    writeWorkspaceVideoMeta(member);
  } else {
    state.ui.batchSessionGroups = groups;
    save("meta");
  }
  return group;
}

function renameWorkspaceSessionGroup(kind, currentName, nextName) {
  const current = String(currentName || "").trim().slice(0, 48);
  const next = String(nextName || "").trim().slice(0, 48);
  if (!current || !next || current === next) return false;
  const groups = workspaceSessionGroups(kind);
  if (groups.includes(next)) {
    toast(`分组「${next}」已存在`);
    return false;
  }
  if (kind === "video") {
    const member = readWorkspaceVideoMeta();
    member.groups = groups.map(group => group === current ? next : group);
    Object.values(member.projects).forEach(project => {
      if (String(project?.group || "").trim() === current) project.group = next;
    });
    writeWorkspaceVideoMeta(member);
  } else {
    state.ui.batchSessionGroups = groups.map(group => group === current ? next : group);
    state.sessions
      .filter(session => ownedBy(session) && String(session.group || "").trim() === current)
      .forEach(session => {
        session.group = next;
        session.updatedAt = Date.now();
      });
    save("sessions", "meta");
  }
  return true;
}

function deleteWorkspaceSessionGroup(kind, groupName) {
  const target = String(groupName || "").trim().slice(0, 48);
  if (!target) return false;
  const groups = workspaceSessionGroups(kind).filter(group => group !== target);
  if (kind === "video") {
    const member = readWorkspaceVideoMeta();
    member.groups = groups;
    Object.values(member.projects).forEach(project => {
      if (String(project?.group || "").trim() === target) project.group = "";
    });
    writeWorkspaceVideoMeta(member);
  } else {
    state.ui.batchSessionGroups = groups;
    state.sessions
      .filter(session => ownedBy(session) && String(session.group || "").trim() === target)
      .forEach(session => {
        session.group = "";
        session.updatedAt = Date.now();
      });
    save("sessions", "meta");
  }
  return true;
}

function postVideoWorkspaceAction(type, payload = {}) {
  const frame = document.querySelector('iframe[title="星阵视频工坊"]');
  if (!frame?.contentWindow) return false;
  frame.contentWindow.postMessage({
    type,
    scope: "video",
    ...payload,
  }, window.location.origin);
  return true;
}

function postCanvasWorkspaceAction(type, payload = {}) {
  const frame = document.querySelector('iframe[title="星阵无限画布"]');
  if (!frame?.contentWindow) return false;
  frame.contentWindow.postMessage({
    type,
    scope: "canvas",
    ...payload,
  }, window.location.origin);
  return true;
}

async function renameWorkspaceCanvasProject(projectId, nextTitle) {
  const id = String(projectId || "").trim();
  const title = String(nextTitle || "").trim().slice(0, 160);
  if (!id || !title) throw new Error("画布名称不能为空");
  const snapshot = await remote.customCanvasProjects.get(id);
  const project = snapshot?.project && typeof snapshot.project === "object"
    ? snapshot.project
    : {};
  const projectState = snapshot?.state && typeof snapshot.state === "object"
    ? snapshot.state
    : {};
  const updatedAt = Math.max(
    Date.now(),
    Number(project.clientUpdatedAt || 0) + 1,
    Number(project.updatedAt || 0) + 1
  );
  const result = await remote.customCanvasProjects.update(id, {
    project: {
      ...project,
      id,
      name: title,
      title,
      updatedAt,
    },
    items: Array.isArray(projectState.items) ? projectState.items : [],
    messages: Array.isArray(projectState.messages) ? projectState.messages : [],
    viewport: projectState.viewport && typeof projectState.viewport === "object"
      ? projectState.viewport
      : undefined,
    clientUpdatedAt: updatedAt,
    baseRevision: Number(project.revision || 0),
  });
  const item = workspaceProjectLists.canvas.items.find(candidate => candidate.id === id);
  if (item) {
    item.title = title;
    item.updatedAt = Number(result?.project?.updatedAt || updatedAt);
  }
  postCanvasWorkspaceAction("custom-canvas:workspace-index-changed", {
    action: "rename",
    projectId: id,
  });
  return result;
}

function workspaceHiddenVideoProjectIds() {
  try {
    const payload = JSON.parse(localStorage.getItem(WORKSPACE_HIDDEN_VIDEO_PROJECTS_KEY) || "{}");
    const items = payload && typeof payload === "object"
      ? payload[workspaceVideoMemberKey()]
      : [];
    return new Set(Array.isArray(items) ? items.map(String) : []);
  } catch (_) {
    return new Set();
  }
}

function hideWorkspaceVideoProject(projectId) {
  const id = String(projectId || "").trim();
  if (!id) return;
  try {
    const payload = JSON.parse(localStorage.getItem(WORKSPACE_HIDDEN_VIDEO_PROJECTS_KEY) || "{}");
    const next = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const key = workspaceVideoMemberKey();
    const items = new Set(Array.isArray(next[key]) ? next[key].map(String) : []);
    items.add(id);
    next[key] = [...items].slice(-240);
    localStorage.setItem(WORKSPACE_HIDDEN_VIDEO_PROJECTS_KEY, JSON.stringify(next));
  } catch (_) {}
  const target = workspaceProjectLists.video;
  target.items = target.items.filter(item => item.id !== id);
  target.loadedAt = Date.now();
}

function setWorkspaceProjects(kind, items = []) {
  ensureWorkspaceProjectOwner();
  const target = workspaceProjectLists[kind];
  if (!target) return;
  const hiddenVideoIds = kind === "video" ? workspaceHiddenVideoProjectIds() : null;
  const normalized = (Array.isArray(items) ? items : [])
    .map(item => normalizeWorkspaceProject(kind, item))
    .filter(Boolean)
    .filter(item => !hiddenVideoIds?.has(item.id));
  const unique = [];
  const seen = new Set();
  normalized.forEach(item => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    unique.push(item);
  });
  if (!target.items.length) {
    target.items = unique;
  } else {
    const previousIds = new Set(target.items.map(item => item.id));
    const incomingById = new Map(unique.map(item => [item.id, item]));
    const newItems = unique.filter(item => !previousIds.has(item.id));
    const retainedItems = target.items
      .filter(item => incomingById.has(item.id))
      .map(item => incomingById.get(item.id));
    target.items = [...newItems, ...retainedItems];
  }
  target.loading = false;
  target.loadedAt = Date.now();
  target.error = "";
  scheduleWorkspaceContextRender();
  const route = parseHash();
  if (
    workspaceShellEnabled()
    && route.zone === "custom"
    && route.page === kind
    && !route.resourceId
    && unique[0]?.id
  ) {
    queueMicrotask(() => {
      const latestRoute = parseHash();
      if (
        latestRoute.zone === "custom"
        && latestRoute.page === kind
        && !latestRoute.resourceId
      ) {
        go("custom", kind, unique[0].id);
      }
    });
  }
}

async function loadWorkspaceProjects(kind, { force = false } = {}) {
  const requestIdentity = ensureWorkspaceProjectOwner();
  const target = workspaceProjectLists[kind];
  if (!target) return [];
  if (target.pending) {
    if (!force) return target.pending;
    if (target.forcedPending) return target.forcedPending;
    const activePending = target.pending;
    const forcedPending = (async () => {
      await activePending;
      if (!workspaceProjectRequestIsCurrent(requestIdentity.ownerKey, requestIdentity.generation)) return [];
      if (target.pending === activePending) target.pending = null;
      return loadWorkspaceProjects(kind, { force: true });
    })();
    target.forcedPending = forcedPending;
    try {
      return await forcedPending;
    } finally {
      if (target.forcedPending === forcedPending) target.forcedPending = null;
    }
  }
  if (!force && target.loadedAt && Date.now() - target.loadedAt < 12_000) return target.items;
  if (!remote.isOn() || !remote.hasToken()) {
    target.loadedAt = Date.now();
    return target.items;
  }
  target.loading = true;
  target.error = "";
  scheduleWorkspaceContextRender();
  const pending = (async () => {
    try {
      if (kind === "canvas") {
        const result = await remote.customCanvasProjects.list();
        if (!workspaceProjectRequestIsCurrent(requestIdentity.ownerKey, requestIdentity.generation)) return [];
        setWorkspaceProjects("canvas", result?.items);
        return target.items;
      }
      // 视频工坊的 iframe 会在挂载后回传完整项目索引。这里先用主服务中
      // 已保存的轻量映射作首屏兜底，不能再误用批量生产的 state.sessions。
      const result = await remote.customProjects.list("video");
      if (!workspaceProjectRequestIsCurrent(requestIdentity.ownerKey, requestIdentity.generation)) return [];
      setWorkspaceProjects("video", result?.items);
      return target.items;
    } catch (error) {
      if (!workspaceProjectRequestIsCurrent(requestIdentity.ownerKey, requestIdentity.generation)) return [];
      target.loading = false;
      target.loadedAt = Date.now();
      target.error = String(error?.message || "项目读取失败");
      scheduleWorkspaceContextRender();
      return target.items;
    }
  })();
  target.pending = pending;
  const items = await pending;
  if (target.pending === pending) target.pending = null;
  return items;
}

if (typeof window !== "undefined") {
  window.addEventListener("xingzhen:video-projects", event => {
    setWorkspaceProjects("video", event.detail?.projects);
  });
  window.addEventListener("xingzhen:video-published", event => {
    const projectId = String(event.detail?.projectId || "").trim();
    const publishedCount = Math.max(
      0,
      Math.floor(Number(event.detail?.publishedCount || 0) || 0)
    );
    if (!projectId || !publishedCount) return;
    const target = workspaceProjectLists.video;
    const project = target.items.find(item => item.id === projectId);
    if (!project) return;
    project.publishedCount = Math.max(project.publishedCount || 0, publishedCount);
    scheduleWorkspaceContextRender();
  });
  document.addEventListener("custom-canvas:project-created", () => {
    void loadWorkspaceProjects("canvas", { force: true });
  });
  window.addEventListener("xingzhen:asset-library-model", () => {
    if (parseHash().zone === "assets") scheduleWorkspaceContextRender();
  });
  window.addEventListener("xingzhen:delivery-filter-model", () => {
    if (parseHash().zone === "delivery") scheduleWorkspaceContextRender();
  });
  window.addEventListener("xingzhen:supplier-children", event => {
    workspaceSupplierChildren = Array.isArray(event.detail?.children) ? event.detail.children : [];
    workspaceSupplierBindings = Array.isArray(event.detail?.bindings) ? event.detail.bindings : [];
    if (["overview", "settings"].includes(parseHash().zone)) scheduleWorkspaceContextRender();
  });
}

function contextRow({ title, meta = "", tag = "", action = "", zone = "", page = "", id = "", active = false, attrs = "", className = "", iconName = "" } = {}) {
  return `
    <button class="wsctx-row${className ? ` ${esc(className)}` : ""}${iconName ? " has-leading-icon" : ""}${active ? " is-active" : ""}" type="button" ${active ? `aria-current="page"` : ""} ${zone ? `data-ws-go="${esc(zone)}"` : ""} ${page ? `data-ws-page="${esc(page)}"` : ""} ${id ? `data-ws-id="${esc(id)}"` : ""} ${attrs}>
      ${iconName ? `<span class="wsctx-leading-icon">${icon(iconName, 15)}</span>` : ""}
      <span class="wsctx-row-copy">
        <b>${esc(title || "未命名")}</b>
        ${meta ? `<em>${esc(meta)}</em>` : ""}
      </span>
      ${tag ? `<i>${esc(tag)}</i>` : ""}
      ${action ? `<strong>${esc(action)}</strong>` : ""}
    </button>
  `;
}

const supplierAccountCollator = new Intl.Collator("zh-CN-u-co-pinyin", {
  numeric: true,
  sensitivity: "base",
});

// 发布清单搜索只用于当前页面定位。不写入 meta，避免刷新后把上次的
// 账号/素材搜索词误当成服务器默认 ID 恢复到侧边栏。
let transientSupplierDeliveryQuery = "";

function supplierWorkspaceQuery(scope) {
  if (scope === "delivery") return transientSupplierDeliveryQuery;
  const queries = state.ui.supplierWorkspaceQueries || {};
  return String(queries[scope] || "");
}

function setSupplierWorkspaceQuery(scope, value) {
  if (scope === "delivery") {
    transientSupplierDeliveryQuery = String(value || "");
    return;
  }
  state.ui.supplierWorkspaceQueries = {
    ...(state.ui.supplierWorkspaceQueries || {}),
    [scope]: String(value || ""),
  };
}

function supplierContextSearch(scope, placeholder) {
  return `
    <label class="wsctx-search wsctx-supplier-search">
      ${icon("search", 13)}
      <input type="search" data-ws-supplier-search="${esc(scope)}" value="${esc(supplierWorkspaceQuery(scope))}" placeholder="${esc(placeholder)}" autocomplete="off" />
    </label>
  `;
}

function supplierFavoriteAccountIds() {
  return new Set((state.ui.supplierFavoriteAccountIds || []).map(String));
}

function supplierAccountContextRow(account, index) {
  const favorites = supplierFavoriteAccountIds();
  const favorite = favorites.has(String(account.id));
  const query = supplierWorkspaceQuery("accounts").trim().toLowerCase();
  const searchValue = `${account.name || ""} ${account.platform || ""} ${account.mode || ""}`.toLowerCase();
  const selected = String(state.ui.supplierSelectedAccountId || "") === String(account.id);
  return `
    <div class="wsctx-supplier-account-shell${selected ? " is-active" : ""}"
      data-supplier-search-target="accounts"
      data-supplier-search-value="${esc(searchValue)}"
      ${query && !searchValue.includes(query) ? "hidden" : ""}>
      ${contextRow({
        title: account.name || `账号 ${index + 1}`,
        meta: "",
        zone: "assets",
        id: account.id,
        active: selected,
        attrs: `data-ws-supplier-account="${esc(account.id)}"`,
        className: "wsctx-supplier-account-row",
      })}
      <button class="wsctx-supplier-favorite${favorite ? " is-active" : ""}" type="button"
        data-ws-supplier-favorite="${esc(account.id)}"
        aria-pressed="${favorite ? "true" : "false"}"
        aria-label="${favorite ? "取消收藏" : "收藏"}${esc(account.name || "账号")}"
        title="${favorite ? "取消收藏" : "收藏账号"}">${icon("star", 13)}</button>
    </div>
  `;
}

function supplierChildContextRow(child, index) {
  const query = supplierWorkspaceQuery("children").trim().toLowerCase();
  const searchValue = `${child.name || ""} ${child.username || ""}`.toLowerCase();
  const assigned = workspaceSupplierBindings.filter(binding => binding.childId === child.id).length;
  return contextRow({
    title: child.name || child.username || `子账号 ${index + 1}`,
    meta: child.username ? `@${child.username}` : "",
    tag: `${assigned} 个账号`,
    zone: "settings",
    page: "accounts",
    attrs: `data-supplier-search-target="children" data-supplier-search-value="${esc(searchValue)}" ${query && !searchValue.includes(query) ? "hidden" : ""}`,
    className: "wsctx-supplier-child-row",
  });
}

function videoProjectContextRow(project, resourceId) {
  const meta = workspaceVideoProjectMeta(project.id);
  const title = meta.title || project.title;
  const active = project.id === resourceId;
  const working = ["running", "thinking"].includes(String(project.status || "").toLowerCase());
  return `
    <div class="wsctx-row-shell wsctx-video-project-shell${active ? " is-active" : ""}${working ? " is-working" : ""}" data-session-shell="video" data-session-id="${esc(project.id)}">
      ${contextRow({
        title,
        tag: `已发布 ${project.publishedCount || 0}`,
        zone: "custom",
        page: "video",
        id: project.id,
        active,
        className: `wsctx-video-project${meta.favorite ? " is-favorite" : ""}`,
        attrs: meta.favorite ? `data-session-favorite="true"` : ""
      })}
      ${workspaceSessionMenu({
        kind: "video",
        id: project.id,
        title,
        favorite: meta.favorite,
        currentGroup: meta.group,
        groups: workspaceSessionGroups("video"),
      })}
    </div>
  `;
}

function canvasProjectContextRow(project, resourceId) {
  const active = project.id === resourceId;
  return `
    <div class="wsctx-row-shell wsctx-canvas-project-shell${active ? " is-active" : ""}" data-session-shell="canvas" data-session-id="${esc(project.id)}">
      ${contextRow({
        title: project.title,
        zone: "custom",
        page: "canvas",
        id: project.id,
        active,
        className: "wsctx-canvas-project"
      })}
      ${workspaceCanvasProjectMenu({
        id: project.id,
        title: project.title,
      })}
    </div>
  `;
}

function batchSessionContextRow(session) {
  const active = session.id === state.ui.activeSessionId;
  return `
    <div class="wsctx-row-shell wsctx-batch-session-shell${active ? " is-active" : ""}" data-session-shell="batch" data-session-id="${esc(session.id)}">
      ${contextRow({
        title: session.title || "新量产计划",
        zone: "agent",
        id: session.id,
        active,
        className: `wsctx-batch-session${session.favorite ? " is-favorite" : ""}`,
        attrs: session.favorite ? `data-session-favorite="true"` : ""
      })}
      ${workspaceSessionMenu({
        kind: "batch",
        id: session.id,
        title: session.title || "新量产计划",
        favorite: Boolean(session.favorite),
        currentGroup: String(session.group || ""),
        groups: workspaceSessionGroups("batch"),
      })}
    </div>
  `;
}

function workspaceCanvasProjectMenu({ id, title } = {}) {
  return `
    <button class="wsctx-row-more" type="button" data-session-menu-toggle aria-haspopup="menu" aria-expanded="false" aria-label="${esc(title)}的更多操作" title="更多操作">${icon("more", 15)}</button>
    <div class="wsctx-row-menu" role="menu" aria-label="画布项目操作">
      <button type="button" role="menuitem" data-session-action="rename" data-session-kind="canvas" data-session-id="${esc(id)}" data-session-title="${esc(title)}">${icon("edit", 13)}<span>重命名</span></button>
      <button type="button" role="menuitem" class="is-danger" data-session-action="delete" data-session-kind="canvas" data-session-id="${esc(id)}" data-session-title="${esc(title)}">${icon("trash", 13)}<span>删除</span></button>
    </div>
  `;
}

function workspaceSessionMenu({ kind, id, title, favorite, currentGroup = "", groups = [] } = {}) {
  const label = kind === "video" ? "视频会话" : "批量会话";
  const groupChoices = [
    `<button type="button" role="menuitem" class="${!currentGroup ? "is-current" : ""}" data-session-action="move" data-session-kind="${esc(kind)}" data-session-id="${esc(id)}" data-session-group="">未分组</button>`,
    ...groups.map(group => `<button type="button" role="menuitem" class="${group === currentGroup ? "is-current" : ""}" data-session-action="move" data-session-kind="${esc(kind)}" data-session-id="${esc(id)}" data-session-group="${esc(group)}">${esc(group)}</button>`),
  ].join("");
  return `
    <button class="wsctx-row-more" type="button" data-session-menu-toggle aria-haspopup="menu" aria-expanded="false" aria-label="${esc(title)}的更多操作" title="更多操作">${icon("more", 15)}</button>
    <div class="wsctx-row-menu" role="menu" aria-label="${esc(label)}操作">
      <button type="button" role="menuitem" data-session-action="rename" data-session-kind="${esc(kind)}" data-session-id="${esc(id)}" data-session-title="${esc(title)}">${icon("edit", 13)}<span>重命名</span></button>
      <button type="button" role="menuitem" data-session-action="favorite" data-session-kind="${esc(kind)}" data-session-id="${esc(id)}">${icon("star", 13)}<span>${favorite ? "取消收藏" : "收藏"}</span></button>
      <div class="wsctx-menu-label">${icon("folder", 12)}<span>移动到分组</span></div>
      <div class="wsctx-menu-groups">${groupChoices}</div>
      <div class="wsctx-menu-divider"></div>
      <button type="button" role="menuitem" class="is-danger" data-session-action="delete" data-session-kind="${esc(kind)}" data-session-id="${esc(id)}" data-session-title="${esc(title)}">${icon("trash", 13)}<span>删除</span></button>
    </div>
  `;
}

function groupedWorkspaceRows(items, groups, getGroup, rowFor, kind) {
  const sorted = [...items].sort((a, b) => {
    return Number(Boolean(b.favorite)) - Number(Boolean(a.favorite));
  });
  const rows = [];
  const append = (label, list, { keepEmpty = false } = {}) => {
    if (!list.length && !keepEmpty) return;
    if (label) rows.push(`
      <div class="wsctx-subgroup">
        <span>${icon("folder", 11)} ${esc(label)}</span>
        <span class="wsctx-subgroup-actions">
          <em>${list.length}</em>
          <button type="button" data-session-group-action="rename" data-session-kind="${esc(kind)}" data-session-group="${esc(label)}" aria-label="重命名分组「${esc(label)}」" title="重命名分组">${icon("edit", 11)}</button>
          <button type="button" data-session-group-action="delete" data-session-kind="${esc(kind)}" data-session-group="${esc(label)}" aria-label="删除分组「${esc(label)}」" title="删除分组">${icon("trash", 11)}</button>
        </span>
      </div>`);
    rows.push(...list.map(rowFor));
  };
  append("", sorted.filter(item => !getGroup(item)));
  groups.forEach(group => append(group, sorted.filter(item => getGroup(item) === group), { keepEmpty: true }));
  const known = new Set(groups);
  const orphanGroups = [...new Set(sorted.map(getGroup).filter(group => group && !known.has(group)))];
  orphanGroups.forEach(group => append(group, sorted.filter(item => getGroup(item) === group)));
  return rows;
}

function accountContextRow(account, accountIndex) {
  const disabled = isAccountDisabled(account);
  const platformClass = platformCode(account.platform).toLowerCase();
  const number = `#${String(accountIndex.get(account.id) || 0).padStart(2, "0")}`;
  return `
    <button class="wsctx-row wsctx-account-row${account.id === state.ui.activeAccountId ? " is-active" : ""}${disabled ? " is-disabled" : ""}"
      type="button"
      ${account.id === state.ui.activeAccountId ? `aria-current="page"` : ""}
      aria-disabled="${disabled ? "true" : "false"}"
      data-ws-go="studio"
      data-ws-id="${esc(account.id)}"
      ${disabled ? `data-ws-disabled="true"` : ""}>
      <span class="wsctx-account-number ${esc(platformClass)}" title="${esc(account.platform || "")}">${esc(number)}</span>
      <span class="wsctx-account-copy">
        <b title="${esc(account.name || "")}">${esc(account.name || "未命名账号")}</b>
      </span>
      <strong>${Number(account.monthlyDone || 0)}</strong>
    </button>
  `;
}

function deliveryFilterControls(model = {}) {
  const fields = Array.isArray(model.fields) ? model.fields : [];
  const ranges = Array.isArray(model.ranges) ? model.ranges : [];
  const active = fields.some(field => String(field.value || "all") !== "all")
    || ranges.some(range => range.start || range.end);
  return `
    <div class="wsctx-filter-stack">
      ${ranges.map(range => `
        <fieldset class="wsctx-filter-range">
          <legend>${esc(range.label || "")}</legend>
          <div>
            <input type="date"
              value="${esc(range.start || "")}"
              max="${esc(range.end || "")}"
              data-ws-delivery-date="${esc(range.startKey || "")}"
              aria-label="${esc(range.label || "")}开始日期" />
            <i aria-hidden="true">—</i>
            <input type="date"
              value="${esc(range.end || "")}"
              min="${esc(range.start || "")}"
              data-ws-delivery-date="${esc(range.endKey || "")}"
              aria-label="${esc(range.label || "")}结束日期" />
          </div>
        </fieldset>
      `).join("")}
      ${fields.map(field => {
        const key = esc(field.key || "");
        const label = esc(field.label || "");
        const options = Array.isArray(field.options) ? field.options : [];
        if (field.type === "select") {
          return `
            <label class="wsctx-filter-select">
              <span>${label}</span>
              <select data-ws-delivery-select="${key}" aria-label="${label}">
                ${options.map(option => `<option value="${esc(option.value)}" ${String(option.value) === String(field.value) ? "selected" : ""}>${esc(option.label)}</option>`).join("")}
              </select>
              ${icon("chevronDown", 11)}
            </label>
          `;
        }
        return `
          <div class="wsctx-filter-choice" role="group" aria-label="${label}">
            <span>${label}</span>
            <div>
              ${options.map(option => `
                <button type="button"
                  class="${String(option.value) === String(field.value) ? "is-active" : ""}"
                  data-ws-delivery-choice="${key}"
                  data-ws-delivery-value="${esc(option.value)}">${esc(option.label)}</button>
              `).join("")}
            </div>
          </div>
        `;
      }).join("")}
      ${active ? `<button class="wsctx-filter-reset" type="button" data-ws-delivery-reset>${icon("undo", 12)} 清除筛选</button>` : ""}
    </div>
  `;
}

function workspaceAccountMarkup() {
  const member = currentMember() || {};
  const isGuest = state.role === "guest";
  const name = member.name || member.username || "我的";
  const clientLabel = $("#clientRailLabel")?.textContent?.trim() || "客户端";
  const initial = String(name).trim().slice(0, 1) || "我";
  const avatar = member.avatarUrl
    ? `<img src="${esc(member.avatarUrl)}" alt="" />`
    : `<span>${esc(initial)}</span>`;
  const team = currentTeam();
  const accountPlanLabel = team?.name || "个人版";
  const canOpenProfile = ["admin", "editor", "user", "supplier", "supplier_parent"].includes(state.role);
  const canManageTeam = ["owner", "admin"].includes(member.teamRole || "");
  const canOpenManagement = ["admin", "supplier", "supplier_parent"].includes(state.role) || canManageTeam;
  const canSendFeedback = ["admin", "editor", "user"].includes(state.role);
  const managementLabel = ["supplier", "supplier_parent"].includes(state.role) ? "供应商设置" : "团队设置";
  const canOpenSubscription = !["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  return `
    <button class="workspace-account-button" id="workspaceAccountButton" type="button" aria-haspopup="menu" aria-expanded="false">
      <span class="workspace-account-avatar">${avatar}</span>
      <span class="workspace-account-copy"><b>${esc(name)}</b><em>${esc(accountPlanLabel)}</em></span>
      ${icon("more", 16)}
    </button>
    <div class="workspace-account-menu" id="workspaceAccountMenu" role="menu" aria-label="账号与客户端">
      <div class="workspace-account-summary">
        <span class="workspace-account-avatar lg">${avatar}</span>
        <span><b>${esc(name)}</b><em>${esc(member.username ? `@${member.username}` : (ROLE_LABEL[state.role] || "当前账号"))}</em></span>
      </div>
      ${canOpenProfile ? `<button type="button" role="menuitem" data-account-action="profile">${icon("user", 16)}<span>我的资料</span></button>` : ""}
      ${!team && state.role === "user" ? `<button type="button" role="menuitem" data-account-action="join-team">${icon("users", 16)}<span>加入团队</span></button>` : ""}
      ${canOpenSubscription ? `<button type="button" role="menuitem" data-account-action="subscription">${icon("spark", 16)}<span>订阅管理</span></button>` : ""}
      <button type="button" role="menuitem" data-account-action="client">${icon("download", 16)}<span data-client-entry-label>${esc(clientLabel)}</span></button>
      ${canSendFeedback ? `<button type="button" role="menuitem" data-account-action="feedback">${icon("fileText", 16)}<span>意见反馈</span></button>` : ""}
      ${canOpenManagement ? `<button type="button" role="menuitem" data-account-action="settings">${icon("gear", 16)}<span>${esc(managementLabel)}</span></button>` : ""}
      <div class="workspace-account-separator" role="separator"></div>
      ${isGuest
        ? `<button type="button" role="menuitem" data-account-action="login">${icon("user", 16)}<span>登录</span></button>`
        : `<button type="button" role="menuitem" class="is-danger" data-account-action="logout">${icon("logout", 16)}<span>退出登录</span></button>`}
    </div>
  `;
}

function openWorkspaceFeedbackModal() {
  const email = "wduan1212@gmail.com";
  openModal(`
    <section class="workspace-feedback-dialog" aria-labelledby="workspaceFeedbackTitle">
      <button class="workspace-feedback-close" type="button" data-close aria-label="关闭">${icon("x", 18)}</button>
      <span class="workspace-feedback-icon">${icon("fileText", 20)}</span>
      <h2 id="workspaceFeedbackTitle">欢迎反馈意见</h2>
      <p>使用中遇到问题，或有任何功能建议，都欢迎通过下面的邮箱告诉我们。</p>
      <a class="workspace-feedback-email" href="mailto:${email}">${email}</a>
      <div class="workspace-feedback-actions">
        <button class="btn" type="button" data-close>稍后反馈</button>
        <a class="btn primary" href="mailto:${email}">发送邮件</a>
      </div>
    </section>
  `, {
    onMount(panel) {
      panel.classList.add("workspace-feedback-panel");
      panel.querySelector(".workspace-feedback-email")?.focus();
    },
  });
}

function ensureWorkspaceContextShell(panel) {
  if (panel.querySelector(".workspace-context-shell")) return;
  panel.innerHTML = `
    <div class="workspace-context-shell">
      <header class="workspace-context-brand">
        <div id="workspaceSwitcherHost"></div>
        <div class="workspace-context-actions" id="workspaceContextActions"></div>
        <button class="workspace-context-close" id="workspaceContextClose" type="button" aria-label="关闭当前工作区列表">${icon("x", 16)}</button>
      </header>
      <div class="wsctx-groups" id="workspaceContextList"></div>
      <div class="workspace-context-tool-host" id="workspaceContextToolHost" hidden></div>
      <footer class="workspace-account-footer">
        <div class="workspace-account" id="workspaceAccount">${workspaceAccountMarkup()}</div>
        <div class="workspace-account-notify" id="workspaceAccountNotify"></div>
      </footer>
    </div>
  `;
  const contextActions = panel.querySelector("#workspaceContextActions");
  const accountNotify = panel.querySelector("#workspaceAccountNotify");
  const topSearch = $("#topSearch");
  const topBell = $("#topBell");
  if (topSearch && contextActions) contextActions.append(topSearch);
  if (topBell && accountNotify) accountNotify.append(topBell);
  if (panel.dataset.workspaceShellWired === "1") return;
  panel.dataset.workspaceShellWired = "1";
  panel.addEventListener("click", async event => {
    if (event.target.closest("#workspaceContextClose")) {
      setWorkspaceContextOpen(false);
      return;
    }
    const accountButton = event.target.closest("#workspaceAccountButton");
    if (accountButton) {
      event.stopPropagation();
      const account = $("#workspaceAccount", panel);
      const open = account?.classList.toggle("is-open");
      accountButton.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) setTimeout(() => $("#workspaceAccountMenu", panel)?.querySelector("[role='menuitem']")?.focus(), 0);
      return;
    }
    const accountAction = event.target.closest("[data-account-action]")?.dataset.accountAction;
    if (accountAction) {
      event.stopPropagation();
      closeWorkspaceAccountMenu();
      if (accountAction === "profile") go("settings", "profile");
      else if (accountAction === "join-team") go("settings", "team");
      else if (accountAction === "subscription") go("subscription");
      else if (accountAction === "settings") go("settings");
      else if (accountAction === "client") document.dispatchEvent(new CustomEvent("client-distribution:open"));
      else if (accountAction === "feedback") openWorkspaceFeedbackModal();
      else if (accountAction === "login") showGate({ modal: true });
      else if (accountAction === "logout") logout();
      return;
    }
    const sessionMenuToggle = event.target.closest("[data-session-menu-toggle]");
    if (sessionMenuToggle) {
      event.stopPropagation();
      const shell = sessionMenuToggle.closest("[data-session-shell]");
      const opening = !shell?.classList.contains("is-menu-open");
      panel.querySelectorAll("[data-session-shell].is-menu-open").forEach(item => {
        if (item !== shell) {
          item.classList.remove("is-menu-open");
          item.querySelector("[data-session-menu-toggle]")?.setAttribute("aria-expanded", "false");
        }
      });
      shell?.classList.toggle("is-menu-open", opening);
      sessionMenuToggle.setAttribute("aria-expanded", opening ? "true" : "false");
      return;
    }
    const createGroupButton = event.target.closest("[data-session-create-group]");
    if (createGroupButton) {
      event.stopPropagation();
      const kind = createGroupButton.dataset.sessionCreateGroup === "video" ? "video" : "batch";
      const name = await promptModal({
        title: kind === "video" ? "新建视频会话分组" : "新建批量会话分组",
        placeholder: "例如：7 月投放、品牌项目",
        okText: "新建分组"
      });
      if (!name) return;
      const group = addWorkspaceSessionGroup(kind, name);
      if (!group) return;
      renderWorkspaceContextPanel();
      toast(`已新建分组「${group}」`);
      return;
    }
    const groupActionButton = event.target.closest("[data-session-group-action]");
    if (groupActionButton) {
      event.stopPropagation();
      const kind = groupActionButton.dataset.sessionKind === "video" ? "video" : "batch";
      const action = String(groupActionButton.dataset.sessionGroupAction || "");
      const group = String(groupActionButton.dataset.sessionGroup || "").trim().slice(0, 48);
      if (!group) return;
      if (action === "rename") {
        const nextName = await promptModal({
          title: `重命名分组「${group}」`,
          value: group,
          placeholder: "输入新的分组名称",
          okText: "保存"
        });
        if (!nextName || nextName === group) return;
        if (!renameWorkspaceSessionGroup(kind, group, nextName)) return;
        renderWorkspaceContextPanel();
        toast(`分组已重命名为「${String(nextName).trim().slice(0, 48)}」`);
        return;
      }
      if (action === "delete") {
        const ok = await confirmModal({
          title: `删除分组「${group}」？`,
          body: "分组内的会话会移回未分组，不会删除任何会话或已发布内容。",
          danger: true,
          okText: "删除分组"
        });
        if (!ok || !deleteWorkspaceSessionGroup(kind, group)) return;
        renderWorkspaceContextPanel();
        toast(`分组「${group}」已删除`);
      }
      return;
    }
    const batchCreateButton = event.target.closest("[data-batch-session-create]");
    if (batchCreateButton) {
      event.stopPropagation();
      const session = newSession();
      renderWorkspaceContextPanel();
      setWorkspaceContextOpen(false);
      go("agent", null, session?.id || null);
      return;
    }
    const sessionAction = event.target.closest("[data-session-action]");
    if (sessionAction) {
      event.stopPropagation();
      const rawKind = String(sessionAction.dataset.sessionKind || "");
      const kind = rawKind === "video" ? "video" : rawKind === "canvas" ? "canvas" : "batch";
      const action = String(sessionAction.dataset.sessionAction || "");
      const id = String(sessionAction.dataset.sessionId || "").trim();
      const title = String(sessionAction.dataset.sessionTitle || "新会话").trim();
      if (!id) return;
      if (action === "rename") {
        const nextTitle = await promptModal({
          title: kind === "canvas" ? "重命名画布" : "重命名会话",
          value: title,
          placeholder: kind === "canvas" ? "输入画布名称" : "输入会话名称",
          okText: "保存"
        });
        const normalizedTitle = String(nextTitle || "").trim().slice(0, kind === "canvas" ? 160 : 180);
        if (!normalizedTitle || normalizedTitle === title) return;
        try {
          if (kind === "video") {
            updateWorkspaceVideoProjectMeta(id, { title: normalizedTitle });
            const project = workspaceProjectLists.video.items.find(item => item.id === id);
            if (project) project.title = normalizedTitle;
            postVideoWorkspaceAction("workspace:rename", { projectId: id, name: normalizedTitle });
          } else if (kind === "canvas") {
            await renameWorkspaceCanvasProject(id, normalizedTitle);
          } else {
            renameSession(id, normalizedTitle);
          }
        } catch (error) {
          toast(error?.message || "画布重命名失败，请稍后重试", "error");
          return;
        }
        renderWorkspaceContextPanel();
        toast(kind === "canvas" ? "画布已重命名" : "会话已重命名");
        return;
      }
      if (action === "favorite") {
        if (kind === "canvas") return;
        if (kind === "video") {
          const meta = workspaceVideoProjectMeta(id);
          updateWorkspaceVideoProjectMeta(id, { favorite: !meta.favorite });
        } else {
          const session = state.sessions.find(item => item.id === id && ownedBy(item));
          if (session) {
            session.favorite = !session.favorite;
            session.updatedAt = Date.now();
            save("sessions");
          }
        }
        renderWorkspaceContextPanel();
        return;
      }
      if (action === "move") {
        if (kind === "canvas") return;
        const group = String(sessionAction.dataset.sessionGroup || "").trim().slice(0, 48);
        if (group) addWorkspaceSessionGroup(kind, group);
        if (kind === "video") {
          updateWorkspaceVideoProjectMeta(id, { group });
        } else {
          const session = state.sessions.find(item => item.id === id && ownedBy(item));
          if (session) {
            session.group = group;
            session.updatedAt = Date.now();
            save("sessions");
          }
        }
        renderWorkspaceContextPanel();
        toast(group ? `已移动到「${group}」` : "已移出分组");
        return;
      }
      if (action === "delete") {
        const ok = await confirmModal({
          title: kind === "canvas" ? `删除画布「${title}」？` : `删除会话「${title}」？`,
          body: kind === "canvas"
            ? "画布草稿、对话记录和生成节点会从当前账号的画布项目中删除，已发布内容不受影响。"
            : kind === "video"
              ? "会从当前 v120 工作区会话列表移除，不影响已发布内容。"
              : "这个批量会话会被删除，已交付内容不受影响。",
          danger: true,
          okText: kind === "canvas" ? "删除画布" : "删除会话"
        });
        if (!ok) return;
        try {
          if (kind === "video") {
            hideWorkspaceVideoProject(id);
            const route = parseHash();
            const nextProject = workspaceProjectLists.video.items[0];
            if (route.zone === "custom" && route.page === "video" && route.resourceId === id) {
              go("custom", "video", nextProject?.id || "__new__");
            }
          } else if (kind === "canvas") {
            await remote.customCanvasProjects.remove(id);
            workspaceProjectLists.canvas.items = workspaceProjectLists.canvas.items
              .filter(project => project.id !== id);
            workspaceProjectLists.canvas.loadedAt = Date.now();
            postCanvasWorkspaceAction("custom-canvas:workspace-index-changed", {
              action: "delete",
              projectId: id,
            });
            const route = parseHash();
            const nextProject = workspaceProjectLists.canvas.items[0];
            if (route.zone === "custom" && route.page === "canvas" && route.resourceId === id && nextProject?.id) {
              go("custom", "canvas", nextProject.id);
            }
          } else {
            await deleteSession(id);
          }
        } catch (error) {
          toast(error?.message || "画布删除失败，请稍后重试", "error");
          return;
        }
        renderWorkspaceContextPanel();
        toast(kind === "canvas" ? "画布已删除" : "会话已删除");
      }
      return;
    }
    const groupButton = event.target.closest("[data-ws-group]");
    if (groupButton) {
      event.stopPropagation();
      const groupKey = String(groupButton.dataset.wsGroup || "");
      if (!groupKey) return;
      if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
      else collapsedGroups.add(groupKey);
      state.ui.collapsedGroups = [...collapsedGroups];
      save("meta");
      renderWorkspaceContextPanel();
      return;
    }
    const libraryButton = event.target.closest("[data-ws-library]");
    if (libraryButton) {
      event.stopPropagation();
      const library = String(libraryButton.dataset.wsLibrary || "");
      assetsView.setLibraryMode?.(library);
      return;
    }
    const supplierFavorite = event.target.closest("[data-ws-supplier-favorite]");
    if (supplierFavorite) {
      event.stopPropagation();
      const accountId = String(supplierFavorite.dataset.wsSupplierFavorite || "");
      const favorites = supplierFavoriteAccountIds();
      if (favorites.has(accountId)) favorites.delete(accountId);
      else favorites.add(accountId);
      state.ui.supplierFavoriteAccountIds = [...favorites];
      save("meta");
      renderWorkspaceContextPanel();
      return;
    }
    if (event.target.closest("[data-ws-supplier-account-create]")) {
      event.stopPropagation();
      document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: {} }));
      return;
    }
    if (event.target.closest("[data-ws-supplier-child-create]")) {
      event.stopPropagation();
      document.dispatchEvent(new CustomEvent("xingzhen:supplier-create-children"));
      return;
    }
    if (event.target.closest("[data-ws-supplier-batch-download]")) {
      event.stopPropagation();
      deliveryView.batchDownload?.();
      return;
    }
    const deliveryChoice = event.target.closest("[data-ws-delivery-choice]");
    if (deliveryChoice) {
      event.stopPropagation();
      deliveryView.setFilter?.(
        deliveryChoice.dataset.wsDeliveryChoice,
        deliveryChoice.dataset.wsDeliveryValue,
        { toggle: true }
      );
      return;
    }
    if (event.target.closest("[data-ws-delivery-reset]")) {
      event.stopPropagation();
      deliveryView.resetFilters?.();
      return;
    }
    const routeButton = event.target.closest("[data-ws-go]");
    if (!routeButton) return;
    if (routeButton.dataset.wsLocked === "true") {
      toast(`${routeButton.dataset.wsLabel || "这个模块"} 是团队功能。加入团队后即可解锁。`);
      setWorkspaceContextOpen(false);
      go("settings", "team");
      return;
    }
    const targetZone = routeButton.dataset.wsGo || "overview";
    const targetPage = routeButton.dataset.wsPage || null;
    const targetId = routeButton.dataset.wsId || "";
    const supplierAccountId = routeButton.dataset.wsSupplierAccount;
    if (supplierAccountId) {
      const account = state.accounts.find(item => String(item.id) === String(supplierAccountId));
      state.ui.supplierSelectedAccountId = supplierAccountId;
      setSupplierWorkspaceQuery("accounts", account?.name || "");
      document.dispatchEvent(new CustomEvent("xingzhen:supplier-account-query", {
        detail: { query: account?.name || "" },
      }));
    }
    if (targetZone === "studio") {
      if (routeButton.dataset.wsDisabled === "true") {
        toast("该账号已停用，恢复后才能继续创作", "error");
        return;
      }
      if (targetId) {
        state.ui.activeAccountId = targetId;
        state.ui.activeProductionId = null;
        save("meta");
      }
      allowStudioFromAgent();
    }
    if (targetZone === "agent" && targetId) {
      if (!openAgentSession(targetId)) {
        toast("这个量产会话已不可用，请刷新列表后重试", "error");
        return;
      }
    }
    if (routeButton.dataset.wsReturnBatch === "true") {
      state.ui.returnTo = null;
      save("meta");
    }
    setWorkspaceContextOpen(false);
    go(
      targetZone,
      targetPage,
      targetZone === "custom" && targetId ? targetId : null
    );
  });
  panel.addEventListener("keydown", event => {
    if (event.target.closest?.("[data-ws-supplier-search]")) {
      event.stopPropagation();
      return;
    }
    if (!event.target.closest("#workspaceAccountMenu")) return;
    const options = [...$("#workspaceAccountMenu", panel).querySelectorAll("[role='menuitem']")];
    const index = options.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown"
        ? (index + 1 + options.length) % options.length
        : (index - 1 + options.length) % options.length;
      options[next]?.focus();
    }
  });
  panel.addEventListener("change", event => {
    const dateInput = event.target.closest?.("[data-ws-delivery-date]");
    if (dateInput) {
      deliveryView.setFilter?.(dateInput.dataset.wsDeliveryDate, dateInput.value);
      return;
    }
    const select = event.target.closest?.("[data-ws-delivery-select]");
    if (!select) return;
    deliveryView.setFilter?.(select.dataset.wsDeliverySelect, select.value);
  });
  panel.addEventListener("input", event => {
    const input = event.target.closest?.("[data-ws-supplier-search]");
    if (!input) return;
    const scope = String(input.dataset.wsSupplierSearch || "");
    const query = String(input.value || "");
    setSupplierWorkspaceQuery(scope, query);
    const normalized = query.trim().toLowerCase();
    panel.querySelectorAll(`[data-supplier-search-target="${CSS.escape(scope)}"]`).forEach(row => {
      row.hidden = Boolean(normalized) && !String(row.dataset.supplierSearchValue || "").includes(normalized);
    });
    if (scope === "accounts") {
      state.ui.supplierSelectedAccountId = "";
      document.dispatchEvent(new CustomEvent("xingzhen:supplier-account-query", { detail: { query } }));
    } else if (scope === "delivery") {
      deliveryView.setQuery?.(query);
    }
  });
}

function scheduleWorkspaceContextRender() {
  if (!workspaceShellEnabled() || workspaceContextFrame) return;
  workspaceContextFrame = requestAnimationFrame(() => {
    workspaceContextFrame = 0;
    renderWorkspaceContextPanel();
  });
}

function renderWorkspaceContextPanel() {
  const panel = $("#ctxPanel");
  if (!panel) return;
  const { zone, page, resourceId } = parseHash();
  panel.hidden = false;
  document.body.classList.add("has-panel");
  ensureWorkspaceContextShell(panel);
  const contextList = $("#workspaceContextList", panel);
  const contextToolHost = $("#workspaceContextToolHost", panel);
  const contextShell = $(".workspace-context-shell", panel);
  const canvasContextTools = $(".canvas-context-tools", panel);
  const activeContextTool = zone === "custom" && page === "voice"
    ? "voice"
    : zone === "custom" && page === "canvas"
      ? "canvas"
      : "";
  panel.dataset.contextToolOwner = activeContextTool;
  if (contextList) contextList.hidden = activeContextTool === "voice";
  if (contextToolHost) {
    contextToolHost.hidden = activeContextTool !== "voice";
    contextToolHost.dataset.contextToolOwner = activeContextTool === "voice" ? "voice" : "";
  }
  if (canvasContextTools) {
    canvasContextTools.hidden = activeContextTool !== "canvas";
    contextShell?.classList.toggle("has-canvas-context-tools", activeContextTool === "canvas");
  } else if (activeContextTool !== "canvas") {
    contextShell?.classList.remove("has-canvas-context-tools");
  }

  if (zone === "studio" && !state.ui.workspaceDisabledGroupInitialized) {
    collapsedGroups.add("ws:studio:disabled");
    state.ui.workspaceDisabledGroupInitialized = true;
    state.ui.collapsedGroups = [...collapsedGroups];
    save("meta");
  }

  const supplier = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  const myProductions = state.productions.filter(ownedBy);
  const deliveredAssets = state.assets.filter(asset => asset.delivered && (state.role !== "editor" || ownedBy(asset)));
  const activeBatchesList = state.batches
    .filter(batch => ownedBy(batch))
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  const sessions = state.sessions
    .filter(ownedBy)
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  const rowsByZone = () => {
    if (zone === "home" && !supplier) {
      const canUseVideo = hasEntitlement("video_workshop");
      const canUseCanvas = hasEntitlement("canvas");
      if (canUseVideo) void loadWorkspaceProjects("video");
      if (canUseCanvas) void loadWorkspaceProjects("canvas");
      const availableFunctions = workspaceNavItems()
        .filter(item => item.zone !== "home");
      const videoHistory = (canUseVideo ? workspaceProjectLists.video.items : []).map(project => {
        const meta = workspaceVideoProjectMeta(project.id);
        return {
          ...project,
          kind: "video",
          title: meta.title || project.title,
          iconName: "film",
          page: "video",
          tag: "视频",
        };
      });
      const canvasHistory = (canUseCanvas ? workspaceProjectLists.canvas.items : []).map(project => ({
        ...project,
        kind: "canvas",
        iconName: "layers",
        page: "canvas",
        tag: "画布",
      }));
      const history = [...videoHistory, ...canvasHistory]
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
        .slice(0, 80);
      return [
        {
          key: "functions",
          title: "功能",
          collapsible: false,
          rows: availableFunctions.map(item => contextRow({
            title: item.label,
            tag: item.locked && item.key !== "assets" ? "VIP" : "",
            zone: item.zone,
            page: item.page || "",
            iconName: item.iconName || "grid",
            attrs: item.locked ? `data-ws-locked="true" data-ws-label="${esc(item.label)}"` : "",
            className: `wsctx-home-function${item.locked && item.key !== "assets" ? " is-vip" : ""}`,
          })),
        },
        {
          key: "home-history",
          title: workspaceProjectLists.video.loading || workspaceProjectLists.canvas.loading
            ? "正在读取历史会话…"
            : "历史会话",
          collapsible: false,
          headerAction: `
            <span class="wsctx-title-actions">
              <button class="wsctx-title-add" type="button" data-ws-go="custom" data-ws-page="video" data-ws-id="__new__" aria-label="新建视频会话" title="新建视频会话">${icon("film", 12)}${icon("plus", 9)}</button>
              <button class="wsctx-title-add" type="button" data-ws-go="custom" data-ws-page="canvas" data-ws-id="__new__" aria-label="新建画布" title="新建画布">${icon("layers", 12)}${icon("plus", 9)}</button>
            </span>`,
          rows: history.map(project => contextRow({
            title: project.title,
            tag: project.tag,
            zone: "custom",
            page: project.page,
            id: project.id,
            iconName: project.iconName,
            className: "wsctx-home-history",
          })),
        },
      ];
    }
    if (zone === "overview") {
      if (supplier) {
        return [{
          key: "supplier-children",
          title: "子账号",
          collapsible: false,
          headerAction: `
            <button class="wsctx-title-add" type="button" data-ws-supplier-child-create
              aria-label="批量建立子账号" title="批量建立子账号">${icon("plus", 13)}</button>`,
          rows: [
            supplierContextSearch("children", "搜索子账号"),
            ...workspaceSupplierChildren
              .slice()
              .sort((a, b) => supplierAccountCollator.compare(a.name || a.username || "", b.name || b.username || ""))
              .map(supplierChildContextRow),
          ],
        }];
      }
      const pending = myProductions
        .filter(p => p.stage !== "delivered")
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, 8);
      const recent = deliveredAssets
        .sort((a, b) => Number(b.deliveredAt || b.createdAt || 0) - Number(a.deliveredAt || a.createdAt || 0))
        .slice(0, 6);
      return [
        { key: "pending", title: "待处理任务", rows: pending.map(p => contextRow({ title: p.artifacts?.copy?.title || p.title || p.topic || "在制任务", zone: "studio" })) },
        { key: "recent", title: "最近访问", rows: recent.map(a => contextRow({ title: a.title || a.name || "已交付内容", zone: "delivery" })) }
      ];
    }
    if (zone === "studio") {
      const accountIndex = accountDisplaySequenceMap(state.accounts);
      const groups = [
        {
          key: "text",
          title: "图文组",
          rows: state.accounts
            .filter(account => !isAccountDisabled(account) && account.mode === "图文")
            .map(account => accountContextRow(account, accountIndex))
        },
        {
          key: "avatar",
          title: "真人数字人",
          rows: state.accounts
            .filter(account => !isAccountDisabled(account) && account.mode === "视频" && account.subType === "数字人")
            .map(account => accountContextRow(account, accountIndex))
        },
        {
          key: "feed",
          title: "素材无数字人",
          rows: state.accounts
            .filter(account => !isAccountDisabled(account) && account.mode === "视频" && account.subType !== "数字人")
            .map(account => accountContextRow(account, accountIndex))
        },
        {
          key: "disabled",
          title: "已停用账号",
          defaultCollapsed: true,
          rows: state.accounts
            .filter(isAccountDisabled)
            .map(account => accountContextRow(account, accountIndex))
        }
      ];
      const returnTo = state.ui.returnTo;
      if (returnTo?.zone === "agent") {
        groups.unshift({
          key: "batch-return",
          title: "上一步",
          rows: [contextRow({
            title: "返回批量生产",
            action: "返回",
            zone: "agent",
            id: returnTo.resourceId || "",
            attrs: 'data-ws-return-batch="true"',
            className: "wsctx-return-action"
          })]
        });
      }
      return groups;
    }
    if (zone === "agent") {
      const batchGroups = workspaceSessionGroups("batch");
      const sessionRows = groupedWorkspaceRows(
        sessions.slice(0, 80),
        batchGroups,
        session => String(session.group || ""),
        session => batchSessionContextRow(session),
        "batch"
      );
      const fallbackRows = activeBatchesList.slice(0, 48).map(b => contextRow({
        title: b.topic || "未命名批次",
        zone: "agent"
      }));
      return [{
        key: "sessions",
        title: "历史会话",
        collapsible: false,
        headerAction: `
          <span class="wsctx-title-actions">
            <button class="wsctx-title-add" type="button" data-batch-session-create aria-label="新建批量会话" title="新建会话">${icon("plus", 13)}</button>
            <button class="wsctx-title-add" type="button" data-session-create-group="batch" aria-label="新建批量会话分组" title="新建分组">${icon("folder", 13)}</button>
          </span>`,
        rows: sessionRows.length ? sessionRows : fallbackRows
      }];
    }
    if (zone === "custom") {
      if (page === "video") {
        void loadWorkspaceProjects("video");
        const projectList = workspaceProjectLists.video;
        const videoGroups = workspaceSessionGroups("video");
        const decoratedProjects = projectList.items.slice(0, 100).map(project => {
          const meta = workspaceVideoProjectMeta(project.id);
          return {
            ...project,
            favorite: meta.favorite,
            group: meta.group,
            title: meta.title || project.title,
          };
        });
        return [{
          key: "projects",
          title: projectList.loading && !projectList.items.length ? "正在读取历史会话…" : "历史会话",
          collapsible: false,
          headerAction: `
            <span class="wsctx-title-actions">
              <button class="wsctx-title-add" type="button" data-ws-go="custom" data-ws-page="video" data-ws-id="__new__" aria-label="新建视频会话" title="新建视频会话">${icon("plus", 13)}</button>
              <button class="wsctx-title-add" type="button" data-session-create-group="video" aria-label="新建视频会话分组" title="新建分组">${icon("folder", 13)}</button>
            </span>`,
          rows: groupedWorkspaceRows(
            decoratedProjects,
            videoGroups,
            project => project.group,
            project => videoProjectContextRow(project, resourceId),
            "video"
          )
        }];
      }
      if (page === "canvas") {
        void loadWorkspaceProjects("canvas");
        const projectList = workspaceProjectLists.canvas;
        return [{
          key: "projects",
          title: projectList.loading && !projectList.items.length ? "正在读取画布项目…" : "画布项目",
          collapsible: false,
          headerAction: `
            <button class="wsctx-title-add" type="button" data-ws-go="custom" data-ws-page="canvas" data-ws-id="__new__"
              aria-label="新建画布项目" title="新建画布项目">${icon("plus", 13)}</button>`,
          rows: projectList.items.slice(0, 80).map(project => canvasProjectContextRow(project, resourceId))
        }];
      }
      return [];
    }
    if (zone === "assets") {
      if (supplier) {
        const favorites = supplierFavoriteAccountIds();
        const accounts = state.accounts.slice().sort((a, b) => {
          const favoriteDelta = Number(favorites.has(String(b.id))) - Number(favorites.has(String(a.id)));
          return favoriteDelta || supplierAccountCollator.compare(a.name || "", b.name || "");
        });
        return [{
          key: "accounts",
          title: "账号",
          collapsible: false,
          headerAction: `
            <button class="wsctx-title-add" type="button" data-ws-supplier-account-create
              aria-label="新建账号" title="新建账号">${icon("plus", 13)}</button>`,
          rows: [
            supplierContextSearch("accounts", "搜索账号"),
            ...accounts.map(supplierAccountContextRow),
          ],
        }];
      }
      const model = assetsView.getLibraryModel?.() || { value: "drafts", options: [] };
      return [{
        key: "libraries",
        title: "资产分类",
        rows: (model.options || []).map(option => contextRow({
          title: option.shortLabel || option.label,
          active: option.key === model.value,
          attrs: `data-ws-library="${esc(option.key)}"`
        }))
      }];
    }
    if (zone === "delivery") {
      const model = deliveryView.getFilterModel?.() || { fields: [] };
      return [
        ...(supplier ? [{
          key: "delivery-tools",
          title: "发布清单",
          collapsible: false,
          rows: [
            `<div class="wsctx-supplier-delivery-tools">
              ${supplierContextSearch("delivery", "搜索账号或素材")}
              <button class="wsctx-supplier-primary-action" type="button" data-ws-supplier-batch-download>${icon("download", 13)}<span>批量下载未下载</span></button>
            </div>`,
          ],
        }] : []),
        { key: "filters", title: "筛选", rows: [deliveryFilterControls(model)] },
      ];
    }
    if (zone === "settings") {
      const me = currentMember();
      const team = currentTeam();
      const canManageTeam = ["owner", "admin"].includes(me?.teamRole || "");
      const managementPages = new Set(["members", "products", "usage", "requests"]);
      const activeManagementPage = managementPages.has(page) ? page : "members";
      if (page === "team") {
        return [{
          key: "team",
          title: "团队",
          collapsible: false,
          rows: [
            contextRow({ title: team?.name || "加入团队", active: true, zone: "settings", page: "team" }),
          ],
        }];
      }
      if (page === "profile" || (!canManageTeam && ["editor", "user"].includes(state.role))) {
        return [{
          key: "profile",
          title: "个人资料",
          collapsible: false,
          rows: [
            contextRow({
              title: me?.name || "我的资料",
              active: true,
              zone: "settings",
              page: "profile"
            })
          ]
        }];
      }
      if (state.role === "admin" || canManageTeam) {
        return [{
          key: "management",
          title: team?.name || "团队设置",
          collapsible: false,
          rows: [
            contextRow({ title: "成员账号", active: activeManagementPage === "members", zone: "settings", page: "members" }),
            ...(team?.kind === "internal" ? [
              contextRow({ title: "产品库", active: activeManagementPage === "products", zone: "settings", page: "products" }),
              contextRow({ title: "模型用量", active: activeManagementPage === "usage", zone: "settings", page: "usage" }),
            ] : []),
            contextRow({ title: "团队申请", active: activeManagementPage === "requests", zone: "settings", page: "requests" }),
          ]
        }];
      }
      const supplierSettingsPage = page === "accounts" ? "accounts" : "requests";
      return [{
        key: "settings",
        title: "供应商设置",
        collapsible: false,
        headerAction: supplierSettingsPage === "accounts"
          ? `<button class="wsctx-title-add" type="button" data-ws-supplier-child-create aria-label="批量建立子账号" title="批量建立子账号">${icon("plus", 13)}</button>`
          : "",
        rows: [
          contextRow({ title: "账号申请", active: supplierSettingsPage === "requests", zone: "settings", page: "requests" }),
          contextRow({ title: "全部账号", active: supplierSettingsPage === "accounts", zone: "settings", page: "accounts" }),
        ],
      }];
    }
    if (zone === "subscription") {
      return [{
        key: "subscription",
        title: "订阅与积分",
        collapsible: false,
        rows: [
          contextRow({
            title: "订阅方案",
            active: true,
            zone: "subscription",
            page: "plans",
            iconName: "spark",
          }),
        ],
      }];
    }
    return [{ title: "上下文", rows: [] }];
  };

  const groups = rowsByZone();
  const list = $("#workspaceContextList", panel);
  if (list) {
    const previousScrollTop = list.scrollTop;
    list.innerHTML = groups.map((group, index) => {
      const groupKey = `ws:${zone}:${group.key || index}`;
      const collapsible = group.collapsible !== false;
      const collapsed = collapsible && collapsedGroups.has(groupKey);
      return `
      <section class="wsctx-group${collapsed ? " is-collapsed" : ""}">
        ${collapsible ? `
          <button class="wsctx-title" type="button" data-ws-group="${esc(groupKey)}" aria-expanded="${collapsed ? "false" : "true"}">
            <b>${esc(group.title)}</b>
            <span class="wsctx-title-chevron">${icon("chevronDown", 11)}</span>
          </button>
        ` : `
          <div class="wsctx-title wsctx-title-static">
            <b>${esc(group.title)}</b>
            ${group.headerAction || ""}
          </div>
        `}
        ${collapsed ? "" : (group.rows.length ? group.rows.join("") : `<p class="wsctx-empty">暂无匹配内容</p>`)}
      </section>
    `;
    }).join("");
    list.scrollTop = previousScrollTop;
  }
  const account = $("#workspaceAccount", panel);
  if (account && !account.classList.contains("is-open")) account.innerHTML = workspaceAccountMarkup();
}

function renderContextPanel() {
  if (workspaceShellEnabled()) {
    renderWorkspaceContextPanel();
    return;
  }
  const panel = $("#ctxPanel");
  const zone = document.body.dataset.zone;
  const show = zone === "studio" && !["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  panel.hidden = !show;
  document.body.classList.toggle("has-panel", show);
  if (!show) return;
  const prevScrollTop = panel.querySelector(".ctx-groups")?.scrollTop ?? state.ui.ctxScrollTop ?? 0;
  const q = (panel.dataset.q || "").toLowerCase();
  const f = a => a.name.toLowerCase().includes(q);
  const accountIndex = accountDisplaySequenceMap(state.accounts);
  if (isAccountDisabled(state.accounts.find(account => account.id === state.ui.activeAccountId))) {
    state.ui.activeAccountId = state.accounts.find(account => !isAccountDisabled(account))?.id || null;
    state.ui.activeProductionId = null;
    save("meta");
  }
  if (!state.ui.disabledAccountGroupInitialized) {
    collapsedGroups.add("已停用账号");
    state.ui.disabledAccountGroupInitialized = true;
    state.ui.collapsedGroups = [...collapsedGroups];
    save("meta");
  }
  const groups = [
    { key: "图文组", list: state.accounts.filter(a => !isAccountDisabled(a) && a.mode === "图文" && f(a)) },
    { key: "真人 · 数字人", list: state.accounts.filter(a => !isAccountDisabled(a) && a.mode === "视频" && a.subType === "数字人" && f(a)) },
    { key: "素材 · 无数字人", list: state.accounts.filter(a => !isAccountDisabled(a) && a.mode === "视频" && a.subType !== "数字人" && f(a)) },
    { key: "已停用账号", list: state.accounts.filter(a => isAccountDisabled(a) && f(a)), disabled: true }
  ];
  panel.innerHTML = `
    <div class="ctx-head">
      <b>账号矩阵</b>
      ${canManageAccounts() ? `<button class="icon-btn sm" id="ctxNew" title="创建账号">${icon("plus", 14)}</button>` : ""}
    </div>
    <div class="ctx-search">${icon("search", 13)}<input id="ctxSearch" placeholder="搜索账号" value="${esc(panel.dataset.q || "")}" /></div>
    <div class="ctx-groups">
      ${groups.map(g => {
        const collapsed = collapsedGroups.has(g.key) && !q;
        return `<div class="ctx-group">
          <button class="ctx-gtitle" data-g="${esc(g.key)}"><span class="chev ${collapsed ? "closed" : ""}">${icon("chevronDown", 12)}</span>${esc(g.key)}<em>${g.list.length}</em></button>
          ${collapsed ? "" : g.list.map(a => `
            <div class="ctx-acc ${a.id === state.ui.activeAccountId ? "is-active" : ""}${isAccountDisabled(a) ? " is-disabled" : ""}${isNewAccount(a) ? " is-new-account" : ""}" data-acc="${a.id}" role="button" tabindex="${isAccountDisabled(a) ? "-1" : "0"}" aria-disabled="${isAccountDisabled(a) ? "true" : "false"}">
              <span class="ctx-idx ${platformCode(a.platform).toLowerCase()}" title="${esc(a.platform || "")}">#${String(accountIndex.get(a.id) || 0).padStart(2, "0")}</span>
              <span class="ctx-name" title="${esc(a.name)}">${esc(a.name)}${isNewAccount(a) ? `<i class="ctx-new-badge">新</i>` : ""}</span>
              <em>${a.monthlyDone || 0}</em>
              ${canManageAccounts() ? `<button class="ctx-del" data-acc-del="${a.id}" title="删除账号">${icon("trash", 12)}</button>` : ""}
            </div>`).join("")}
        </div>`;
      }).join("")}
    </div>`;
  const groupsEl = $(".ctx-groups", panel);
  if (groupsEl) {
    groupsEl.scrollTop = prevScrollTop;
    groupsEl.addEventListener("scroll", () => { state.ui.ctxScrollTop = groupsEl.scrollTop; }, { passive: true });
  }
  $("#ctxNew")?.addEventListener("click", () => document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: {} })));
  const ctxSearch = $("#ctxSearch");
  if (ctxSearch) {
    let composing = false;
    const applyContextSearch = () => {
      panel.dataset.q = ctxSearch.value;
      renderContextPanel();
      setTimeout(() => {
        const i = $("#ctxSearch");
        if (i) {
          i.focus();
          i.setSelectionRange(i.value.length, i.value.length);
        }
      }, 0);
    };
    ctxSearch.addEventListener("compositionstart", () => { composing = true; });
    ctxSearch.addEventListener("compositionend", () => { composing = false; applyContextSearch(); });
    ctxSearch.addEventListener("input", e => {
      if (composing || e.isComposing) return;
      applyContextSearch();
    });
  }
  $$(".ctx-gtitle", panel).forEach(b => b.addEventListener("click", () => {
    collapsedGroups.has(b.dataset.g) ? collapsedGroups.delete(b.dataset.g) : collapsedGroups.add(b.dataset.g);
    state.ui.collapsedGroups = [...collapsedGroups]; save("meta");
    renderContextPanel();
  }));
  const openAcc = id => {
    const account = state.accounts.find(item => item.id === id);
    if (!account) return;
    if (isAccountDisabled(account)) {
      toast("该账号已停用，恢复后才能继续创作", "error");
      return;
    }
    state.ui.ctxScrollTop = $(".ctx-groups", panel)?.scrollTop || state.ui.ctxScrollTop || 0;
    state.ui.activeAccountId = id;
    state.ui.activeProductionId = null;
    save("meta");
    allowStudioFromAgent();
    go("studio");
  };
  $$(".ctx-acc", panel).forEach(b => {
    b.addEventListener("click", () => openAcc(b.dataset.acc));
    b.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAcc(b.dataset.acc); }
    });
  });
  $$("[data-acc-del]", panel).forEach(b => b.addEventListener("click", async e => {
    e.stopPropagation();
    const acc = state.accounts.find(x => x.id === b.dataset.accDel);
    if (!acc) return;
    const ok = await confirmModal({ title: `删除账号「${acc.name}」？`, body: "这个账号下的在制任务与资产会一起删除。这个操作不会影响其他账号。", danger: true, okText: "删除账号" });
    if (!ok) return;
    deleteAccount(acc.id);
    renderContextPanel();
    render();
    toast("账号已删除");
  }));
}

/* ---------- 顶栏 ---------- */
const ZONE_TITLE = { home: "首页", subscription: "订阅管理", overview: "数据看板", custom: "定制创作", voice: "语音生成", agent: "批量创作", studio: "单号创作", assets: "整体资产", drafts: "草稿箱", delivery: "发布清单", analytics: "数据分析", settings: "设置" };

async function syncHomepageAnalytics(button) {
  if (button.disabled) return;
  const label = button.querySelector("span");
  const originalLabel = label?.textContent || "同步数据";
  button.disabled = true;
  button.classList.add("is-loading");
  if (label) label.textContent = "同步中…";
  try {
    // 与数据分析页保持同一条 JustOne 同步链路：先补齐已回传素材，再逐条拉取快照。
    syncExistingPublishedAssets();
    const result = await refreshAllAnalytics();
    if (!result.total) toast("还没有可刷新的小红书或视频号回链");
    else if (result.failed.length) toast(`已同步 ${result.ok}/${result.total} 条，${result.failed.length} 条待处理`, "error");
    else toast(`已同步 ${result.ok}/${result.total} 条数据快照`);
    if (document.body.dataset.zone === "overview") render();
  } catch (error) {
    toast(`同步数据失败：${error?.message || error || "请稍后重试"}`, "error");
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
    if (label) label.textContent = originalLabel;
  }
}

function renderTopbar() {
  const zone = document.body.dataset.zone;
  const bc = $("#topCrumb");
  const actionDock = $(".top-actions");
  const actions = $("#topActionsPanel") || actionDock;
  const topbar = document.querySelector(".topbar");
  const voiceDock = $("#voiceTopDock");
  const assetsDock = $("#assetsTopDock");
  topbar?.classList.toggle("voice-topbar-active", zone === "voice");
  if (voiceDock && zone !== "voice") voiceDock.remove();
  if (assetsDock && zone !== "assets") assetsDock.remove();
  const acc = activeAccount();
  const { page } = parseHash();
  const teamManager = ["owner", "admin"].includes(currentMember()?.teamRole || "");
  let crumb = zone === "settings" && ["editor", "user"].includes(state.role) && !teamManager ? "我的" : (ZONE_TITLE[zone] || "");
  if (zone === "custom") {
    crumb = `定制创作 / ${{ video: "视频工坊", canvas: "无限画布", voice: "语音生成" }[page || "video"] || "视频工坊"}`;
  }
  if (zone === "assets" && ["supplier", "supplier_parent"].includes(state.role)) crumb = "全部账号";
  const shownPage = acc?.mode === "图文" && ["script", "copy"].includes(page)
    ? "images"
    : acc?.mode === "视频" && ["script", "boards", "prompts", "render", "copy"].includes(page)
      ? "workshop"
      : page;
  if (zone === "studio" && acc) crumb = `单号创作 / ${acc.name}${shownPage && shownPage !== "home" ? " / " + ({ script: "脚本", boards: "分镜", images: "图文创作台", prompts: "提示词", workshop: acc.subType === "数字人" ? "数字人制作" : "信息流制作", render: "生成台", cut: "剪辑", copy: "文案", review: "审核" }[shownPage] || "") : ""}`;
  bc.textContent = crumb;
  renderWorkspaceSwitcher();
  if (!workspaceShellEnabled()) {
    const oldStudioStepper = topbar?.querySelector(".chain-stepper");
    const studioStepper = zone === "studio" ? document.querySelector(".view-root .chain-stepper") : null;
    if (oldStudioStepper && oldStudioStepper !== studioStepper) oldStudioStepper.remove();
    if (studioStepper && topbar && actionDock) {
      topbar.classList.add("studio-topbar-active");
      topbar.insertBefore(studioStepper, actionDock);
    } else {
      topbar?.classList.remove("studio-topbar-active");
    }
  } else {
    topbar?.classList.remove("studio-topbar-active");
  }
  let newAccBtn = $("#topNewAccount");
  if (!newAccBtn && actions) {
    newAccBtn = document.createElement("button");
    newAccBtn.id = "topNewAccount";
    newAccBtn.className = "top-btn top-primary";
    newAccBtn.innerHTML = `${icon("plus", 13)} <span>新建账号</span>`;
    newAccBtn.addEventListener("click", () => document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: {} })));
    actions.appendChild(newAccBtn);
  }
  let syncDataBtn = $("#topSyncAnalytics");
  if (!syncDataBtn && actions) {
    syncDataBtn = document.createElement("button");
    syncDataBtn.id = "topSyncAnalytics";
    syncDataBtn.className = "top-btn";
    syncDataBtn.title = "手动从 JustOne 同步已回传内容的数据快照";
    syncDataBtn.innerHTML = `${icon("refresh", 13)} <span>同步数据</span>`;
    syncDataBtn.addEventListener("click", () => syncHomepageAnalytics(syncDataBtn));
    const syncAnchor = [newAccBtn]
      .find(node => node?.parentElement === actions) || null;
    actions.insertBefore(syncDataBtn, syncAnchor);
  }
  if (newAccBtn) newAccBtn.hidden = !(zone === "overview" && teamManager);
  if (syncDataBtn) syncDataBtn.hidden = !(zone === "overview" && teamManager);
  const supplierParent = ["supplier", "supplier_parent"].includes(state.role);
  // 供应商资产页已经在内容区提供账号/平台筛选；顶栏再渲染一组会
  // 造成两个互不共享状态的重复筛选器。保留内容区这一处即可。
  const supplierToolbarZone = false;
  let supplierTools = $("#topSupplierOverviewTools");
  if (!supplierTools && actions) {
    supplierTools = document.createElement("div");
    supplierTools.id = "topSupplierOverviewTools";
    supplierTools.className = "top-supplier-tools";
    actions.insertBefore(supplierTools, actions.firstElementChild || null);
  }
  if (supplierTools) {
    supplierTools.hidden = !supplierToolbarZone;
    if (supplierTools.dataset.zone !== zone) {
      supplierTools.dataset.zone = zone;
      supplierTools.innerHTML = "";
    }
  }
  if (!workspaceUtilityDockWired) {
    const toggle = $("#topActionsToggle");
    const dock = $("#workspaceUtilityDock");
    if (toggle && dock) {
      workspaceUtilityDockWired = true;
      toggle.addEventListener("click", event => {
        event.stopPropagation();
        const open = dock.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
  }
}

/* ---------- ⌘K ---------- */
function paletteCommands() {
  const rawQuery = arguments[0] || "";
  const supplierChild = state.role === "supplier_child";
  const supplierParent = state.role === "supplier" || state.role === "supplier_parent";
  const query = String(rawQuery || "").trim().toLowerCase();
  const nav = supplierChild ? [
    { label: "发布清单", group: "导航", icon: "package", run: () => go("delivery") }
  ] : supplierParent ? [
    { label: "供应商首页", group: "导航", icon: "grid", run: () => go("overview") },
    { label: "发布清单", group: "导航", icon: "package", run: () => go("delivery") },
    { label: "全部账号", group: "导航", icon: "users", run: () => go("assets") },
    { label: "供应商设置", group: "导航", icon: "settings", run: () => go("settings") }
  ] : [
    { label: "首页", group: "导航", icon: "grid", run: () => go("home") },
    { label: "批量创作", group: "导航", icon: "spark", run: () => go("agent") },
    { label: "语音生成", group: "导航", icon: "mic", run: () => go("custom", "voice") },
    { label: "单号创作", group: "导航", icon: "film", run: () => { allowStudioFromAgent(); go("studio"); } },
    { label: "整体资产", group: "导航", icon: "folder", run: () => go("assets") },
    { label: "发布清单", group: "导航", icon: "package", run: () => go("delivery") },
    { label: "定制创作", group: "导航", icon: "layers", run: () => go("custom", "video") },
    ...(hasEntitlement("dashboard") ? [{ label: "数据看板", group: "导航", icon: "analytics", run: () => go("overview") }] : []),
    ...(state.role === "admin" ? [
      { label: "设置", group: "导航", icon: "gear", run: () => go("settings") },
      { label: "创建账号", group: "操作", icon: "plus", run: () => document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: {} })) }
    ] : state.role === "editor" ? [
      { label: "我的", group: "导航", icon: "user", run: () => go("settings") }
    ] : [])
  ];
  const cmds = [...nav];
  if (supplierChild || supplierParent) {
    const supplierResults = buildSupplierSearchResults({
      accounts: supplierParent ? state.accounts : [],
      delivered: deliveredAssets(),
      query,
      productLabelFor: asset => productTagLabel(productById(asset?.productId || "")),
    });
    if (supplierParent) {
      supplierResults.accounts
        .slice()
        .sort((a, b) => supplierAccountCollator.compare(a.account.name || "", b.account.name || ""))
        .forEach(({ account, searchText }) => {
          cmds.push({
            label: account.name || "未命名账号",
            hint: account.username ? `@${account.username}` : "前往全部账号",
            searchText,
            group: "账号",
            icon: "user",
            run: () => {
              const accountQuery = account.name || "";
              state.ui.supplierSelectedAccountId = account.id;
              setSupplierWorkspaceQuery("accounts", accountQuery);
              go("assets");
              setTimeout(() => document.dispatchEvent(new CustomEvent(
                "xingzhen:supplier-account-query",
                { detail: { query: accountQuery, accountId: account.id, resetPlatform: true } },
              )), 0);
            },
          });
        });
    }
    supplierResults.assets.forEach(({ asset, acc, searchText }) => {
      const assetQuery = asset.title || asset.name || acc.name || "";
      cmds.push({
        label: asset.title || asset.name || "未命名内容",
        hint: `${acc.name || "未命名账号"} · 前往发布清单`,
        searchText,
        group: "相关素材",
        icon: asset.type === "图集" ? "image" : "film",
        run: () => {
          setSupplierWorkspaceQuery("delivery", assetQuery);
          deliveryView.resetFilters?.({ redraw: false });
          deliveryView.setQuery?.(assetQuery, { redraw: false });
          deliveryView.focusAsset?.(asset.id, { redraw: false });
          go("delivery");
        },
      });
    });
    return cmds;
  }
  state.accounts.forEach(a => cmds.push({
    label: a.name, hint: (a.styleProfile || a.voiceName || "").slice(0, 24), group: "账号", icon: "user",
    run: () => { state.ui.activeAccountId = a.id; state.ui.activeProductionId = null; save("meta"); allowStudioFromAgent(); go("studio"); }
  }));
  state.productions.filter(p => ownedBy(p) && p.stage !== "delivered").slice(0, 30).forEach(p => cmds.push({
    label: p.artifacts.copy.title || p.title || p.topic || "未命名任务",
    hint: "在制任务", group: "任务", icon: "film",
    run: () => openProductionDrawer(p.id)
  }));
  return cmds;
}

function openGlobalPalette() {
  const supplier = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  openPalette(paletteCommands, {
    placeholder: supplier ? "搜索账号或已交付素材…" : "搜索账号 / 任务 / 操作…",
  });
}

/* ---------- 启动 ---------- */
async function boot() {
  try {
    await db.open();
    // 服务器模式先只读取很小的身份/UI 元数据。账号、资产、任务等业务集合
    // 由服务端权威快照在登录后分组水合，避免本机旧的 7MB+ IndexedDB
    // 缓存阻塞登录页。纯本地模式仍完整装载并执行历史迁移。
    await loadIdentityCache();
    await remote.init();              // 探测是否由共享后端托管（决定走远端还是本地模式）
    if (!remote.isOn()) await loadAll();
    const mig = remote.isOn() ? { migrated: false } : await migrateFromV4();
    if (mig.migrated) {
      await persistNow();
      setTimeout(() => toast(`已从旧版迁移：${mig.counts.accounts} 账号 / ${mig.counts.productions} 任务 / ${mig.counts.assets} 资产（旧数据保留可回退）`), 800);
    }
    // 本地历史 Blob 可能很多，不能阻塞首屏。资源预览需要时会优先走服务端 URL，
    // 这里后台预热即可，避免旧 IndexedDB 把登录页/首页拖成白屏。
    preloadBlobUrls().catch(e => console.warn("[blob-preload]", e));
    if (!remote.isOn()) {
      await bootstrapAccountProfilesIfEmpty();
      normalizeDeliveredProductTags();
      normalizeDeliveredSharedAssets();
    }
    pruneEmptySessions();
    await enableServerProxyIfConfigured();
    applyKeyOverrides(state.apiKeys);

    // 注册路由
    registerView("home", homeView);
    registerView("subscription", subscriptionView);
    registerView("overview", hydrationAwareView("overview", overviewView));
    registerView("custom", customCreationView);
    registerView("voice", voiceLabView);
    registerView("agent", hydrationAwareView("agent", agentView));
    registerView("studio", hydrationAwareView("studio", studioView));
    registerView("assets", hydrationAwareView("assets", assetsView));
    registerView("drafts", hydrationAwareView("drafts", draftsView));
    registerView("delivery", hydrationAwareView("delivery", deliveryView));
    registerView("analytics", hydrationAwareView("analytics", analyticsView));
    registerView("settings", settingsView);
    initRouter();
    installSelectEnhancer();
    installUIEnhancements();
    installAccountPublishQuotaAutoRefresh();
    initClientDistribution();
    installUpdateChecker();
    initLoginBeams();

    // 外壳
    $("#railBrand").innerHTML = brandGlyph(28);
    $$("[data-nav]").forEach(b => b.addEventListener("click", () => {
      state.ui.returnTo = null;
      if (state.role === "guest" && !["home", "assets"].includes(b.dataset.nav)) {
        window.dispatchEvent(new CustomEvent("xingzhen:auth-required", {
          detail: { reason: "create", target: { zone: b.dataset.nav } }
        }));
        return;
      }
      if (b.dataset.nav === "studio") allowStudioFromAgent();
      go(b.dataset.nav);
    }));
    $("#navLogout").addEventListener("click", logout);
    $("#topSearch").addEventListener("click", openGlobalPalette);
    document.addEventListener("click", e => {
      if (e.target.closest("[data-open-create-account]")) document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: {} }));
    });
    $("#topBell").addEventListener("click", e => {
      const anchor = e.currentTarget;
      toggleNotifyPanel(anchor);
      void syncAccountNotifications().then(() => {
        if ($("#notifyPanel")) {
          toggleNotifyPanel(anchor);
          toggleNotifyPanel(anchor);
        }
      });
    });
    document.addEventListener("keydown", e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openGlobalPalette(); }
    });
    window.addEventListener("view:rendered", () => { renderContextPanel(); renderTopbar(); });
    window.addEventListener("xingzhen:account-publish-quotas", () => {
      const route = parseHash();
      if (route.zone === "studio" && (!route.page || route.page === "home")) render();
    });
    on("change", () => {
      if (workspaceShellEnabled()) scheduleWorkspaceContextRender();
      else if (document.body.dataset.zone === "studio") renderContextPanel();
      updateNotifyBadge();
    });
    updateNotifyBadge();

    // 登录分流（三身份 + 口令）
    wireGate();
    window.addEventListener("xingzhen:auth-required", () => {
      if (state.role !== "guest") return;
      showGate({ modal: true });
    });
    // 进入：远端共享模式凭 token 自动续登；本地模式凭本地 role/member
    let entered = false;
    if (remote.isOn() && remote.hasToken()) {
      const resumeStartedAt = performance.now();
      const m = await remote.me();
      if (m) {
        state.role = m.role; state.ui.currentMemberId = m.id;
        resetWorkspaceProjectLists(m.id);
        const bootstrap = await pullRemoteBootstrap();
        if (bootstrap.ok) {
          state.members = state.members.filter(item => item.id !== m.id);
          state.members.unshift(m);
          if (!["supplier", "supplier_parent", "supplier_child"].includes(m.role)) {
            await bootstrapAccountProfilesIfEmpty();
          }
          save("meta");
          document.documentElement.classList.add("has-auth-token");
          pauseLoginBackground();
          applyRoleClasses(); $("#loginGate").hidden = true; document.body.classList.remove("gated"); render(); entered = true;
          void syncAccountNotifications();
          recordFirstRender(resumeStartedAt, "resume");
          continueRemoteHydration(m, bootstrap.complete);
        } else {
          await clearPendingRemoteIdentity();
        }
      } else {
        await clearPendingRemoteIdentity();
      }
    } else if (!remote.isOn() && state.role && state.role !== "guest" && state.ui.currentMemberId) {
      document.documentElement.classList.add("has-auth-token");
      pauseLoginBackground();
      applyRoleClasses(); $("#loginGate").hidden = true; document.body.classList.remove("gated"); render(); entered = true;
    }
    if (!entered) { enterGuest(); entered = true; }
    else document.documentElement.classList.remove("auth-booting");
    window.__dumateBooting = false;
    setTimeout(() => ensureViewRendered("initial render"), 600);
    setTimeout(() => ensureViewRendered("late startup"), 2200);

    // Provider 状态只影响按钮文案和真实 API 可用性，不应阻塞首屏。
    if (entered) {
      refreshProviderStatus().then(() => {
        renderTopbar();
        if (document.body.dataset.zone === "settings") render();
      }).catch(e => console.warn("[providers]", e));
    }

    // 远端重任务集合由 continueRemoteHydration 在后台同步完成后恢复；
    // 本地模式仍可以立即恢复。
    if (entered && !remote.isOn()) {
      const rj = resumeJobs();
      const rb = resumeActiveBatches();
      if (rj || rb) setTimeout(() => toast(`已恢复中断的工作：${rb ? `${rb} 条起草接续 · ` : ""}${rj ? `${rj} 个渲染任务重新排队` : ""}`.replace(/ · $/, "")), 1200);
    }

    // 兜底保存
    window.addEventListener("beforeunload", persistNow);
    document.addEventListener("visibilitychange", () => { if (document.hidden) persistNow(); });
  } catch (e) {
    window.__dumateBooting = false;
    console.error("[boot]", e);
    document.body.innerHTML = `<div style="padding:40px;font-family:system-ui"><h2>启动失败</h2><p>${esc(e.message || String(e))}</p><p>请用 <code>node tools/serve.mjs 8787</code> 启动后访问（ES Modules 不支持 file:// 直接打开），或回退 _backup_v4/。</p></div>`;
  }
}

document.addEventListener("DOMContentLoaded", boot);
