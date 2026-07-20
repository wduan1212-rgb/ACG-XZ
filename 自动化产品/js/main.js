/* 应用入口：装载数据 → 迁移 → 恢复任务 → 外壳 → 路由 */

import { $, $$, esc, uid } from "./core/util.js";
import { icon, brandGlyph } from "./ui/icons.js";
import { db } from "./core/db.js";
import { state, save, saveMembers, on, loadIdentityCache, loadAll, persistNow, pullRemoteBootstrap, hydrateRemoteInBackground, retryRemoteHydration, remoteCollectionHydrationState, cancelRemoteHydration, activeAccount, ROLE_LABEL, productById, ownedBy } from "./core/store.js";
import * as remote from "./core/remote.js";
import { pruneEmptySessions } from "./agent/orchestrator.js?v=20260718-v94-1";
import { migrateFromV4 } from "./core/migrate.js";
import { preloadBlobUrls } from "./domain/assets.js";
import { accountDisplaySequenceMap, deleteAccount, groupOf, platformCode, appearanceAnchorFor } from "./domain/accounts.js";
import { productTagLabel } from "./domain/delivery.js";
import { refreshAllAnalytics, syncExistingPublishedAssets } from "./domain/analytics.js";
import { ACCOUNT_PROFILE_SEED, ACCOUNT_PROFILE_VERSION } from "./data/accountProfilesSeed.js";
import { applyKeyOverrides, enableServerProxyIfConfigured } from "./api/llm.js?v=20260720-v103-2";
import { refreshProviderStatus } from "./api/providers.js";
import { resumeJobs } from "./api/jobs.js";
import { resumeActiveBatches } from "./agent/orchestrator.js?v=20260718-v94-1";
import { registerView, initRouter, render, go, parseHash, allowStudioFromAgent } from "./core/router.js";
import { toast, confirmModal, openPalette, toggleNotifyPanel, updateNotifyBadge } from "./ui/components.js";
import { installSelectEnhancer } from "./ui/selectEnhancer.js?v=20260718-v94-1";
import { initLoginBeams } from "./ui/loginBeams.js";
import { installUIEnhancements } from "./ui/uiEnhancements.js";
import { overviewView } from "./views/overview.js?v=20260720-v102-1";
import { voiceLabView } from "./views/voiceLab.js?v=20260718-v94-1";
import { customCreationView } from "./views/customCreation.js?v=20260720-v103-1";
import { agentView } from "./agent/view.js?v=20260718-v94-1";
import { studioView } from "./views/studio.js?v=20260718-v94-1";
import { assetsView } from "./views/assetsView.js?v=20260718-v94-1";
import { deliveryView } from "./views/deliveryView.js?v=20260720-v102-1";
import { analyticsView } from "./views/analyticsView.js?v=20260718-v94-1";
import { draftsView } from "./views/draftsView.js";
import { settingsView } from "./views/settings.js?v=20260718-v94-1";
import "./views/accountDialog.js";
import { stagePage, openProductionDrawer } from "./views/prodDrawer.js?v=20260718-v94-1";
import { productionsOf } from "./domain/productions.js";

const APP_BUILD_ID = "20260720-v103-2";
let announcedBuildId = "";

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
function showGate() {
  document.documentElement.classList.remove("auth-booting");
  document.documentElement.classList.remove("has-auth-token");
  const gate = $("#loginGate");
  gate.hidden = false;
  document.body.classList.add("gated");
  playLoginBackground();
  setGateBusy(false);
  setGateError("");
  setGateMode("login");
  const u = $("#lgUser"), p = $("#lgPin"), n = $("#lgName");
  if (u) u.value = ""; if (p) p.value = ""; if (n) n.value = "";
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
    title: "正在提交申请…",
    button: "提交中"
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
  document.documentElement.classList.remove("has-auth-token");
  await Promise.allSettled([
    db.metaSet("role", null),
    db.metaSet("ui", JSON.parse(JSON.stringify(state.ui)))
  ]);
}
function applyGateModeContent(mode) {
  const apply = mode === "apply";
  const card = $(".lg-card");
  if (card) card.dataset.mode = mode;
  const nameField = $("#lgNameField"), roleField = $("#lgRoleField"), loginBtn = $("#lgLogin"), applyBtn = $("#lgApply"), hint = $("#lgHint"), title = $("#lgModeTitle");
  if (nameField) nameField.hidden = !apply;
  if (roleField) roleField.hidden = !apply;
  if (title) {
    window.clearTimeout(gateTitleTransitionTimer);
    title.classList.remove("is-phase-entering");
    title.textContent = apply ? "申请" : "登录";
  }
  if (loginBtn) {
    const label = apply ? "申请" : "登录";
    const labelNode = loginBtn.querySelector("span");
    if (labelNode) labelNode.textContent = label;
    else loginBtn.textContent = label;
  }
  if (applyBtn) {
    const label = apply ? "返回登录" : "申请账号";
    const labelNode = applyBtn.querySelector("span");
    if (labelNode) labelNode.textContent = label;
    else applyBtn.textContent = label;
    applyBtn.setAttribute("aria-pressed", apply ? "true" : "false");
    applyBtn.title = apply ? "返回登录" : "申请账号";
  }
  if (hint) hint.textContent = apply
    ? "填写资料，提交后等待管理员审批"
    : "使用星阵账号继续";
}
function setGateMode(mode) {
  const nextMode = mode === "apply" ? "apply" : "login";
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
  document.body.classList.toggle("role-supplier", state.role === "supplier" || state.role === "supplier_parent" || state.role === "supplier_child");
  document.body.classList.toggle("role-supplier-parent", state.role === "supplier" || state.role === "supplier_parent");
  document.body.classList.toggle("role-supplier-child", state.role === "supplier_child");
  document.body.classList.toggle("role-editor", state.role === "editor");
  document.body.classList.toggle("role-admin", state.role === "admin");
  const parent = state.role === "supplier" || state.role === "supplier_parent";
  const labels = {
    overview: parent ? "首页" : "首页",
    assets: parent ? "全部账号" : "整体资产",
    delivery: "发布清单",
    settings: "设置"
  };
  Object.entries(labels).forEach(([zone, label]) => {
    const item = document.querySelector(`[data-nav="${zone}"]`);
    if (!item) return;
    item.title = label;
    const span = item.querySelector("span");
    if (span) span.textContent = label;
  });
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
      console.warn("[boot] render retry still empty; falling back to overview");
      if ((location.hash || "") !== "#/overview") location.hash = "#/overview";
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

function enterMember(member) {
  document.documentElement.classList.remove("auth-booting");
  state.role = member.role;
  state.ui.currentMemberId = member.id;
  save("meta");
  document.documentElement.classList.add("has-auth-token");
  pauseLoginBackground();
  $("#loginGate").hidden = true;
  document.body.classList.remove("gated");
  applyRoleClasses();
  go(member.role === "supplier_child" ? "delivery" : "overview");
  render();
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
  if (zone === "agent") return ["productions", "sessions", "batches", "jobs", "assets"];
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
  const run = alreadyComplete
    ? Promise.resolve(true)
    : hydrateRemoteInBackground({
        memberId: member.id,
        onProgress: progress => {
          if (progress?.error) {
            toast("部分工作区数据同步失败，已自动重试。请刷新页面再试，本地空态不会回写服务器。", "error");
            return;
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
  if (!state.members.some(item => item.id === member.id)) state.members.unshift(member);
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
  const submitApply = async () => {
    if (gateBusy) return;
    if (!remote.isOn()) { toast("当前是本地离线模式，申请账号需要共享后端服务"); shakeCard(); return; }
    const name = ($("#lgName").value || "").trim();
    const username = ($("#lgUser").value || "").trim();
    const pin = ($("#lgPin").value || "").trim();
    const role = ($("#lgRole").value || "editor").trim();
    if (!name || !username || !pin) { toast("请填写姓名、用户名和密码"); shakeCard(); return; }
    setGateError("");
    setGateBusy(true, "applying");
    try {
      await remote.requestMember({ name, username, pin, role });
      toast("申请已提交，等待管理员审批");
      setGateMode("login");
      $("#lgPin").value = "";
      $("#lgName").value = "";
    } catch (e) {
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
    setGateMode(gateMode === "apply" ? "login" : "apply");
    setTimeout(() => (gateMode === "apply" ? $("#lgName") : $("#lgUser"))?.focus(), 480);
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
  state.role = null;
  state.ui.currentMemberId = null;
  save("meta");
  document.body.classList.remove("role-supplier", "role-supplier-parent", "role-supplier-child", "role-editor", "role-admin");
  showGate();
}

/* ---------- 上下文面板（创作空间 = 账号列表） ---------- */
const collapsedGroups = new Set(state.ui.collapsedGroups || []);
function renderContextPanel() {
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
  const groups = [
    { key: "图文组", list: state.accounts.filter(a => a.mode === "图文" && f(a)) },
    { key: "真人 · 数字人", list: state.accounts.filter(a => a.mode === "视频" && a.subType === "数字人" && f(a)) },
    { key: "素材 · 无数字人", list: state.accounts.filter(a => a.mode === "视频" && a.subType !== "数字人" && f(a)) }
  ];
  panel.innerHTML = `
    <div class="ctx-head">
      <b>账号矩阵</b>
      ${state.role === "admin" ? `<button class="icon-btn sm" id="ctxNew" title="创建账号">${icon("plus", 14)}</button>` : ""}
    </div>
    <div class="ctx-search">${icon("search", 13)}<input id="ctxSearch" placeholder="搜索账号" value="${esc(panel.dataset.q || "")}" /></div>
    <div class="ctx-groups">
      ${groups.map(g => {
        const collapsed = collapsedGroups.has(g.key) && !q;
        return `<div class="ctx-group">
          <button class="ctx-gtitle" data-g="${esc(g.key)}"><span class="chev ${collapsed ? "closed" : ""}">${icon("chevronDown", 12)}</span>${esc(g.key)}<em>${g.list.length}</em></button>
          ${collapsed ? "" : g.list.map(a => `
            <div class="ctx-acc ${a.id === state.ui.activeAccountId ? "is-active" : ""}" data-acc="${a.id}" role="button" tabindex="0">
              <span class="ctx-idx ${platformCode(a.platform).toLowerCase()}" title="${esc(a.platform || "")}">#${String(accountIndex.get(a.id) || 0).padStart(2, "0")}</span>
              <span class="ctx-name" title="${esc(a.name)}">${esc(a.name)}</span>
              <em>${a.monthlyDone || 0}</em>
              ${state.role === "admin" ? `<button class="ctx-del" data-acc-del="${a.id}" title="删除账号">${icon("trash", 12)}</button>` : ""}
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
const ZONE_TITLE = { overview: "首页", custom: "定制创作", voice: "语音生成", agent: "批量创作", studio: "单号创作", assets: "整体资产", drafts: "草稿箱", delivery: "发布清单", analytics: "数据分析", settings: "设置" };

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
  const actions = $(".top-actions");
  const topbar = document.querySelector(".topbar");
  const voiceDock = $("#voiceTopDock");
  const assetsDock = $("#assetsTopDock");
  topbar?.classList.toggle("voice-topbar-active", zone === "voice");
  if (voiceDock && zone !== "voice") voiceDock.remove();
  if (assetsDock && zone !== "assets") assetsDock.remove();
  const acc = activeAccount();
  const { page } = parseHash();
  let crumb = ZONE_TITLE[zone] || "";
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
  const oldStudioStepper = topbar?.querySelector(".chain-stepper");
  const studioStepper = zone === "studio" ? document.querySelector(".view-root .chain-stepper") : null;
  if (oldStudioStepper && oldStudioStepper !== studioStepper) oldStudioStepper.remove();
  if (studioStepper && topbar && actions) {
    topbar.classList.add("studio-topbar-active");
    topbar.insertBefore(studioStepper, actions);
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
    actions.insertBefore(newAccBtn, $("#topSearch"));
  }
  let syncDataBtn = $("#topSyncAnalytics");
  if (!syncDataBtn && actions && newAccBtn) {
    syncDataBtn = document.createElement("button");
    syncDataBtn.id = "topSyncAnalytics";
    syncDataBtn.className = "top-btn";
    syncDataBtn.title = "手动从 JustOne 同步已回传内容的数据快照";
    syncDataBtn.innerHTML = `${icon("refresh", 13)} <span>同步数据</span>`;
    syncDataBtn.addEventListener("click", () => syncHomepageAnalytics(syncDataBtn));
    actions.insertBefore(syncDataBtn, newAccBtn);
  }
  if (newAccBtn) newAccBtn.hidden = !(zone === "overview" && state.role === "admin");
  if (syncDataBtn) syncDataBtn.hidden = !(zone === "overview" && state.role === "admin");
}

/* ---------- ⌘K ---------- */
function paletteCommands() {
  const supplierChild = state.role === "supplier_child";
  const supplierParent = state.role === "supplier" || state.role === "supplier_parent";
  const nav = supplierChild ? [
    { label: "发布清单", group: "导航", icon: "package", run: () => go("delivery") }
  ] : supplierParent ? [
    { label: "供应商首页", group: "导航", icon: "grid", run: () => go("overview") },
    { label: "发布清单", group: "导航", icon: "package", run: () => go("delivery") },
    { label: "全部账号", group: "导航", icon: "users", run: () => go("assets") },
    { label: "供应商设置", group: "导航", icon: "settings", run: () => go("settings") }
  ] : [
    { label: "首页", group: "导航", icon: "grid", run: () => go("overview") },
    { label: "批量创作", group: "导航", icon: "spark", run: () => go("agent") },
    { label: "单号创作", group: "导航", icon: "film", run: () => { allowStudioFromAgent(); go("studio"); } },
    { label: "整体资产", group: "导航", icon: "folder", run: () => go("assets") },
    { label: "发布清单", group: "导航", icon: "package", run: () => go("delivery") },
    { label: "定制创作", group: "导航", icon: "layers", run: () => go("custom", "video") },
    ...(state.role === "admin" ? [
      { label: "设置", group: "导航", icon: "gear", run: () => go("settings") },
      { label: "创建账号", group: "操作", icon: "plus", run: () => document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: {} })) }
    ] : [])
  ];
  const cmds = [...nav];
  if (supplierChild || supplierParent) return cmds;
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
    installUpdateChecker();
    initLoginBeams();

    // 外壳
    $("#railBrand").innerHTML = brandGlyph(28);
    $$("[data-nav]").forEach(b => b.addEventListener("click", () => {
      state.ui.returnTo = null;
      if (b.dataset.nav === "studio") allowStudioFromAgent();
      go(b.dataset.nav);
    }));
    $("#navLogout").addEventListener("click", logout);
    $("#topSearch").addEventListener("click", () => openPalette(paletteCommands()));
    document.addEventListener("click", e => {
      if (e.target.closest("[data-open-create-account]")) document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: {} }));
    });
    $("#topBell").addEventListener("click", e => toggleNotifyPanel(e.currentTarget));
    document.addEventListener("keydown", e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(paletteCommands()); }
    });
    window.addEventListener("view:rendered", () => { renderContextPanel(); renderTopbar(); });
    on("change", () => { if (document.body.dataset.zone === "studio") renderContextPanel(); updateNotifyBadge(); });
    updateNotifyBadge();

    // 登录分流（三身份 + 口令）
    wireGate();
    // 进入：远端共享模式凭 token 自动续登；本地模式凭本地 role/member
    let entered = false;
    if (remote.isOn() && remote.hasToken()) {
      const resumeStartedAt = performance.now();
      const m = await remote.me();
      if (m) {
        state.role = m.role; state.ui.currentMemberId = m.id;
        const bootstrap = await pullRemoteBootstrap();
        if (bootstrap.ok) {
          if (!state.members.some(item => item.id === m.id)) state.members.unshift(m);
          if (!["supplier", "supplier_parent", "supplier_child"].includes(m.role)) {
            await bootstrapAccountProfilesIfEmpty();
          }
          save("meta");
          document.documentElement.classList.add("has-auth-token");
          pauseLoginBackground();
          applyRoleClasses(); $("#loginGate").hidden = true; document.body.classList.remove("gated"); render(); entered = true;
          recordFirstRender(resumeStartedAt, "resume");
          continueRemoteHydration(m, bootstrap.complete);
        } else {
          await clearPendingRemoteIdentity();
        }
      } else {
        await clearPendingRemoteIdentity();
      }
    } else if (!remote.isOn() && state.role && state.ui.currentMemberId) {
      document.documentElement.classList.add("has-auth-token");
      pauseLoginBackground();
      applyRoleClasses(); $("#loginGate").hidden = true; document.body.classList.remove("gated"); render(); entered = true;
    }
    if (!entered) { showGate(); render(); }
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
