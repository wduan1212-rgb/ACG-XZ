/* 应用入口：装载数据 → 迁移 → 恢复任务 → 外壳 → 路由 */

import { $, $$, esc, uid } from "./core/util.js";
import { icon, brandGlyph } from "./ui/icons.js";
import { db } from "./core/db.js";
import { state, save, saveMembers, on, loadAll, persistNow, pullRemote, activeAccount, ROLE_LABEL, productById, ownedBy } from "./core/store.js";
import * as remote from "./core/remote.js";
import { pruneEmptySessions } from "./agent/orchestrator.js";
import { migrateFromV4 } from "./core/migrate.js";
import { preloadBlobUrls } from "./domain/assets.js";
import { createAccount, deleteAccount, groupOf, platformCode, appearanceAnchorFor } from "./domain/accounts.js";
import { productTagLabel } from "./domain/delivery.js";
import { XHS_ACCOUNT_SEED } from "./data/xhsAccountsSeed.js";
import { ACCOUNT_PROFILE_SEED, ACCOUNT_PROFILE_VERSION } from "./data/accountProfilesSeed.js";
import { applyKeyOverrides, enableServerProxyIfConfigured } from "./api/llm.js";
import { refreshProviderStatus } from "./api/providers.js";
import { resumeJobs } from "./api/jobs.js";
import { resumeActiveBatches } from "./agent/orchestrator.js";
import { registerView, initRouter, render, go, parseHash, allowStudioFromAgent } from "./core/router.js";
import { toast, confirmModal, openPalette, toggleNotifyPanel, updateNotifyBadge } from "./ui/components.js";
import { installSelectEnhancer } from "./ui/selectEnhancer.js";
import { initLoginBeams } from "./ui/loginBeams.js";
import { installUIEnhancements } from "./ui/uiEnhancements.js";
import { overviewView } from "./views/overview.js";
import { voiceLabView } from "./views/voiceLab.js";
import { agentView } from "./agent/view.js";
import { studioView } from "./views/studio.js?v=20260714-v76-1";
import { assetsView } from "./views/assetsView.js";
import { deliveryView } from "./views/deliveryView.js";
import { analyticsView } from "./views/analyticsView.js";
import { draftsView } from "./views/draftsView.js";
import { settingsView } from "./views/settings.js";
import "./views/accountDialog.js";
import { stagePage, openProductionDrawer } from "./views/prodDrawer.js";
import { productionsOf } from "./domain/productions.js";

/* ---------- 种子数据（首次使用且无迁移数据时） ---------- */
function seedIfEmpty() {
  if (remote.isOn() && remote.hasToken()) return;
  if (state.accounts.length) return;
  const seeds = [
    { name: "百度搭子图文教程 01", platform: "小红书", mode: "图文", position: "办公效率教程，围绕百度搭子文件整理 / 数据分析等功能，少广告腔、强操作演示", qtags: ["职场效率", "产品功能"] },
    { name: "AI 办公口播号", platform: "视频号", mode: "视频", subType: "数字人", styleProfile: "数字人出镜讲职场效率，前段真人引入、后段产品演示，聚焦真实办公痛点", qtags: ["职场效率"] },
    { name: "ACG 探场官", platform: "小红书", mode: "视频", subType: "无数字人", styleProfile: "探场体验官语气，现场探店 + 产品功能演示结合，活动现场素材二次创作", qtags: ["创作者", "测评中立"] }
  ];
  seeds.forEach(s => createAccount(s));
  state.ui.activeAccountId = state.accounts[0].id;
  save("accounts", "meta");
}

function ensureXhsSeedAccounts() {
  if (remote.isOn() && remote.hasToken()) return;
  const existing = new Set(state.accounts.map(a => `${a.platform}:${a.name}`));
  const missing = XHS_ACCOUNT_SEED.filter(a => !existing.has(`${a.platform}:${a.name}`));
  if (!missing.length) return;
  missing.forEach(s => createAccount({
    name: s.name,
    platform: s.platform,
    mode: s.mode,
    subType: s.subType,
    styleProfile: s.styleProfile,
    tone: s.tone,
    qtags: s.qtags,
    voiceId: s.voiceId,
    voiceName: s.voiceName || s.voiceRefName || ""
  }));
  if (!state.ui.activeAccountId && state.accounts.length) state.ui.activeAccountId = state.accounts[0].id;
  save("accounts", "meta");
  setTimeout(() => toast(`已补齐小红书账号库：新增 ${missing.length} 个账号`), 800);
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
    qtags: profile.qtags || [],
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

const accountSeedKey = a => `${a.platform || ""}:${a.name || ""}`;
const isSeedManagedAccount = a => {
  if (!a) return false;
  if (a.mode === "视频") return true;
  return a.platform === "小红书" && a.mode === "图文";
};

async function cleanupNonSeedAccounts() {
  const seedKeys = new Set(ACCOUNT_PROFILE_SEED.map(accountSeedKey));
  const seen = new Set();
  const removed = [];
  const kept = [];
  (state.accounts || []).forEach(acc => {
    const key = accountSeedKey(acc);
    const managed = isSeedManagedAccount(acc);
    if (managed && (!seedKeys.has(key) || seen.has(key))) {
      removed.push(acc);
      return;
    }
    if (managed) seen.add(key);
    kept.push(acc);
  });
  if (!removed.length) return 0;
  const removedIds = new Set(removed.map(a => a.id));
  state.accounts = kept;
  if (state.ui.activeAccountId && removedIds.has(state.ui.activeAccountId)) {
    state.ui.activeAccountId = state.accounts[0]?.id || null;
  }
  if (remote.isOn() && remote.hasToken()) {
    await Promise.all(removed.map(a => remote.deleteDoc("accounts", a.id)));
  }
  return removed.length;
}

async function applyAccountProfileSeed({ createMissing = true, quiet = false } = {}) {
  const seedKeys = new Set(ACCOUNT_PROFILE_SEED.map(accountSeedKey));
  const hasAllSeedAccounts = ACCOUNT_PROFILE_SEED.every(profile =>
    (state.accounts || []).some(acc => accountSeedKey(acc) === accountSeedKey(profile))
  );
  if (state.ui.accountProfileVersion === ACCOUNT_PROFILE_VERSION && hasAllSeedAccounts) return 0;
  const removed = await cleanupNonSeedAccounts();
  let changed = removed, created = 0;
  ACCOUNT_PROFILE_SEED.forEach(profile => {
    let acc = state.accounts.find(a => a.name === profile.name && a.platform === profile.platform);
    if (!acc && createMissing) {
      if (remote.isOn() && remote.hasToken()) {
        state.accounts.push(accountFromProfile(profile));
      } else {
        createAccount(profile);
      }
      created++; changed++;
      return;
    }
    if (!acc) return;
    const patch = {
      mode: profile.mode,
      subType: profile.mode === "图文" ? "" : profile.subType,
      styleProfile: profile.styleProfile,
      tone: profile.tone || acc.tone || "教程感",
      qtags: profile.qtags || acc.qtags || [],
      imagePromptTemplate: profile.imagePromptTemplate || acc.imagePromptTemplate || "",
      voiceId: acc.voiceId || profile.voiceId || "",
      voiceName: acc.voiceName || profile.voiceName || ""
    };
    const needs = Object.entries(patch).some(([k, v]) => JSON.stringify(acc[k] || (Array.isArray(v) ? [] : "")) !== JSON.stringify(v));
    if (needs) { Object.assign(acc, patch, { updatedAt: Date.now() }); changed++; }
  });
  if (changed || state.ui.accountProfileVersion !== ACCOUNT_PROFILE_VERSION) {
    state.ui.accountProfileVersion = ACCOUNT_PROFILE_VERSION;
    if (remote.isOn() && remote.hasToken()) {
      await syncAccountsInChunks();
      save("meta");
    } else {
      save("accounts", "meta");
    }
    if (!quiet) setTimeout(() => toast(`已同步账号风格：更新 ${Math.max(0, changed - created - removed)} 个，新增 ${created} 个，清理旧账号 ${removed} 个`), 900);
  }
  return changed;
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
  setGateMode("login");
  const u = $("#lgUser"), p = $("#lgPin"), n = $("#lgName");
  if (u) u.value = ""; if (p) p.value = ""; if (n) n.value = "";
  setTimeout(() => u && u.focus(), 80);
}
let gateMode = "login";
function setGateMode(mode) {
  gateMode = mode === "apply" ? "apply" : "login";
  const apply = gateMode === "apply";
  const card = $(".lg-card");
  if (card) card.dataset.mode = gateMode;
  const nameField = $("#lgNameField"), roleField = $("#lgRoleField"), loginBtn = $("#lgLogin"), applyBtn = $("#lgApply"), hint = $("#lgHint"), title = $("#lgModeTitle");
  if (nameField) nameField.hidden = !apply;
  if (roleField) roleField.hidden = !apply;
  if (title) title.textContent = apply ? "申请" : "登录";
  if (loginBtn) {
    const label = apply ? "申请" : "登录";
    const labelNode = loginBtn.querySelector("span");
    if (labelNode) labelNode.textContent = label;
    else loginBtn.textContent = label;
  }
  if (applyBtn) {
    applyBtn.textContent = apply ? "申请中" : "申请账号";
    applyBtn.setAttribute("aria-pressed", apply ? "true" : "false");
    applyBtn.title = apply ? "返回登录" : "申请账号";
  }
  if (hint) hint.textContent = apply
    ? "填写资料，提交后等待管理员审批"
    : "使用星阵账号继续";
  if (card) {
    card.classList.remove("is-switching");
    void card.offsetWidth;
    card.classList.add("is-switching");
  }
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
/* 共享后端登录：先拉服务端全量快照覆盖本地，再复用本地 enter 逻辑 */
async function enterRemote(member) {
  state.role = member.role;
  state.ui.currentMemberId = member.id;
  await pullRemote();
  if (!["supplier", "supplier_parent", "supplier_child"].includes(member.role)) {
    await applyAccountProfileSeed({ createMissing: true });
    normalizeDeliveredProductTags();
    normalizeDeliveredSharedAssets();
  }
  enterMember(member);
  resumeJobs(); resumeActiveBatches();
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
    if (!remote.isOn()) { toast("当前是本地离线模式，申请账号需要共享后端服务"); shakeCard(); return; }
    const name = ($("#lgName").value || "").trim();
    const username = ($("#lgUser").value || "").trim();
    const pin = ($("#lgPin").value || "").trim();
    const role = ($("#lgRole").value || "editor").trim();
    if (!name || !username || !pin) { toast("请填写姓名、用户名和密码"); shakeCard(); return; }
    try {
      await remote.requestMember({ name, username, pin, role });
      toast("申请已提交，等待管理员审批");
      setGateMode("login");
      $("#lgPin").value = "";
      $("#lgName").value = "";
    } catch (e) {
      shakeCard();
      toast((e.message || "申请提交失败").replace(/^HTTP\s+\d+\s+/, ""), "error");
    }
  };
  const submit = async () => {
    if (gateMode === "apply") return submitApply();
    const username = ($("#lgUser").value || "").trim();
    const pin = ($("#lgPin").value || "").trim();
    if (!username || !pin) { toast("请填写用户名和密码"); shakeCard(); return; }
    if (remote.isOn()) {
      let member;
      try { member = await remote.login(username, pin); }
      catch (e) { $("#lgPin").value = ""; shakeCard(); toast("用户名或密码不对，再试一次", "error"); return; }
      await enterRemote(member);
    } else {
      let member = null;
      for (const m of state.members) {
        if (m.username === username && await verifyLocalMemberPin(m, pin)) { member = m; break; }
      }
      if (!member) { $("#lgPin").value = ""; shakeCard(); toast("用户名或密码不对，再试一次", "error"); return; }
      enterMember(member);
    }
  };
  $("#lgLogin", gate).addEventListener("click", submit);
  $("#lgApply", gate).addEventListener("click", () => {
    setGateMode(gateMode === "apply" ? "login" : "apply");
    setTimeout(() => (gateMode === "apply" ? $("#lgName") : $("#lgUser"))?.focus(), 40);
  });
  gate.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
}
function logout() {
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
  const accountIndex = new Map(state.accounts.map((a, i) => [a.id, i + 1]));
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
    render();
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
const ZONE_TITLE = { overview: "首页", voice: "语音生成", agent: "批量创作", studio: "单号创作", assets: "整体资产", drafts: "草稿箱", delivery: "发布清单", analytics: "数据分析", settings: "设置" };
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
  if (zone === "assets" && ["supplier", "supplier_parent"].includes(state.role)) crumb = "全部账号";
  const shownPage = acc?.mode === "图文" && ["script", "copy"].includes(page)
    ? "images"
    : acc?.mode === "视频" && ["script", "boards", "prompts", "render", "copy"].includes(page)
      ? "workshop"
      : page;
  if (zone === "studio" && acc) crumb = `单号创作 / ${acc.name}${shownPage && shownPage !== "home" ? " / " + ({ script: "脚本", boards: "分镜", images: "图文创作台", prompts: "提示词", workshop: "文案分镜", render: "生成台", cut: "剪辑", copy: "文案", review: "审核" }[shownPage] || "") : ""}`;
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
  if (newAccBtn) newAccBtn.hidden = !(zone === "overview" && state.role === "admin");
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
    { label: "草稿箱", group: "导航", icon: "inbox", run: () => go("drafts") },
    { label: "发布清单", group: "导航", icon: "package", run: () => go("delivery") },
    { label: "数据分析", group: "导航", icon: "pulse", run: () => go("analytics") },
    ...(state.role === "admin" ? [
      { label: "语音生成", group: "导航", icon: "mic", run: () => go("voice") },
      { label: "设置", group: "导航", icon: "gear", run: () => go("settings") },
      { label: "创建账号", group: "操作", icon: "plus", run: () => document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: {} })) }
    ] : [])
  ];
  const cmds = [...nav];
  if (supplierChild || supplierParent) return cmds;
  state.accounts.forEach(a => cmds.push({
    label: a.name, hint: (a.styleProfile || a.voiceName || "").slice(0, 24), group: "账号", icon: "user",
    run: () => { state.ui.activeAccountId = a.id; save("meta"); allowStudioFromAgent(); go("studio"); render(); }
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
    await loadAll();
    await remote.init();              // 探测是否由共享后端托管（决定走远端还是本地模式）
    const mig = await migrateFromV4();
    if (mig.migrated) {
      await persistNow();
      setTimeout(() => toast(`已从旧版迁移：${mig.counts.accounts} 账号 / ${mig.counts.productions} 任务 / ${mig.counts.assets} 资产（旧数据保留可回退）`), 800);
    }
    // 本地历史 Blob 可能很多，不能阻塞首屏。资源预览需要时会优先走服务端 URL，
    // 这里后台预热即可，避免旧 IndexedDB 把登录页/首页拖成白屏。
    preloadBlobUrls().catch(e => console.warn("[blob-preload]", e));
    if (!remote.isOn()) {
      seedIfEmpty();
      ensureXhsSeedAccounts();
      await applyAccountProfileSeed({ createMissing: true });
      normalizeDeliveredProductTags();
      normalizeDeliveredSharedAssets();
    }
    pruneEmptySessions();
    await enableServerProxyIfConfigured();
    applyKeyOverrides(state.apiKeys);

    // 注册路由
    registerView("overview", overviewView);
    registerView("voice", voiceLabView);
    registerView("agent", agentView);
    registerView("studio", studioView);
    registerView("assets", assetsView);
    registerView("drafts", draftsView);
    registerView("delivery", deliveryView);
    registerView("analytics", analyticsView);
    registerView("settings", settingsView);
    initRouter();
    installSelectEnhancer();
    installUIEnhancements();
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
      const m = await remote.me();
      if (m) {
        state.role = m.role; state.ui.currentMemberId = m.id;
        await pullRemote();
        if (!["supplier", "supplier_parent", "supplier_child"].includes(m.role)) {
          await applyAccountProfileSeed({ createMissing: true });
          normalizeDeliveredProductTags();
          normalizeDeliveredSharedAssets();
        }
        save("meta");
        document.documentElement.classList.add("has-auth-token");
        pauseLoginBackground();
        applyRoleClasses(); $("#loginGate").hidden = true; document.body.classList.remove("gated"); render(); entered = true;
      } else {
        remote.logout();
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
    refreshProviderStatus().then(() => {
      renderTopbar();
      if (document.body.dataset.zone === "settings") render();
    }).catch(e => console.warn("[providers]", e));

    // 恢复中断任务（state 已就绪后）
    const rj = resumeJobs();
    const rb = resumeActiveBatches();
    if (rj || rb) setTimeout(() => toast(`已恢复中断的工作：${rb ? `${rb} 条起草接续 · ` : ""}${rj ? `${rj} 个渲染任务重新排队` : ""}`.replace(/ · $/, "")), 1200);

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
