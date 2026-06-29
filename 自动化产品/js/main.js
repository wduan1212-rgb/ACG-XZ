/* 应用入口：装载数据 → 迁移 → 恢复任务 → 外壳 → 路由 */

import { $, $$, esc, gradFor, uid } from "./core/util.js";
import { icon, brandGlyph } from "./ui/icons.js";
import { db } from "./core/db.js";
import { state, save, saveMembers, on, loadAll, persistNow, pullRemote, activeAccount, ROLE_LABEL, productById } from "./core/store.js";
import * as remote from "./core/remote.js";
import { pruneEmptySessions } from "./agent/orchestrator.js";
import { migrateFromV4 } from "./core/migrate.js";
import { preloadBlobUrls } from "./domain/assets.js";
import { createAccount, deleteAccount, groupOf, platChip, appearanceAnchorFor } from "./domain/accounts.js";
import { productTagLabel } from "./domain/delivery.js";
import { XHS_ACCOUNT_SEED } from "./data/xhsAccountsSeed.js";
import { ACCOUNT_PROFILE_SEED, ACCOUNT_PROFILE_VERSION } from "./data/accountProfilesSeed.js";
import { applyKeyOverrides, enableServerProxyIfConfigured } from "./api/llm.js";
import { refreshProviderStatus } from "./api/providers.js";
import { applyLocalDevKeys } from "./local/devKeys.js";
import { resumeJobs } from "./api/jobs.js";
import { resumeActiveBatches } from "./agent/orchestrator.js";
import { registerView, initRouter, render, go, parseHash, allowStudioFromAgent } from "./core/router.js";
import { toast, confirmModal, openPalette, toggleNotifyPanel, updateNotifyBadge } from "./ui/components.js";
import { overviewView } from "./views/overview.js";
import { agentView } from "./agent/view.js";
import { studioView } from "./views/studio.js";
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
    { name: "AI 办公口播号", platform: "视频号", mode: "视频", subType: "数字人", position: "数字人出镜讲职场效率，前段真人引入、后段产品演示，定位真实办公痛点", qtags: ["职场效率"] },
    { name: "ACG 探场官", platform: "小红书", mode: "视频", subType: "无数字人", position: "探场体验官人设，现场探店 + 产品功能演示结合，活动现场素材二次创作", qtags: ["创作者", "测评中立"] }
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
    position: s.position,
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
    position: profile.position || "（待补充定位）",
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
  if (state.ui.accountProfileVersion === ACCOUNT_PROFILE_VERSION) return 0;
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
      position: profile.position,
      styleProfile: profile.styleProfile,
      tone: profile.tone || acc.tone || "教程感",
      qtags: profile.qtags || acc.qtags || [],
      imagePromptTemplate: profile.imagePromptTemplate || acc.imagePromptTemplate || "",
      voiceId: profile.voiceId || acc.voiceId || "",
      voiceName: profile.voiceName || acc.voiceName || ""
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
    if (!quiet) setTimeout(() => toast(`已同步账号定位/风格：更新 ${Math.max(0, changed - created - removed)} 个，新增 ${created} 个，清理旧账号 ${removed} 个`), 900);
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

/* ---------- 登录（成员账号制：用户名 + 口令） ---------- */
function showGate() {
  document.documentElement.classList.remove("auth-booting");
  document.documentElement.classList.remove("has-auth-token");
  const gate = $("#loginGate");
  gate.hidden = false;
  document.body.classList.add("gated");
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
  const nameField = $("#lgNameField"), roleField = $("#lgRoleField"), loginBtn = $("#lgLogin"), applyBtn = $("#lgApply"), hint = $("#lgHint");
  if (nameField) nameField.hidden = !apply;
  if (roleField) roleField.hidden = !apply;
  if (loginBtn) loginBtn.textContent = apply ? "提交申请 →" : "登录 →";
  if (applyBtn) applyBtn.textContent = apply ? "返回登录" : "申请账号";
  if (hint) hint.textContent = apply
    ? "提交后等待管理员在后台审批，通过后即可登录"
    : "忘记密码请联系管理员 · 新成员可提交账号申请";
}
function applyRoleClasses() {
  document.body.classList.toggle("role-supplier", state.role === "supplier");
  document.body.classList.toggle("role-editor", state.role === "editor");
  document.body.classList.toggle("role-admin", state.role === "admin");
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
  $("#loginGate").hidden = true;
  document.body.classList.remove("gated");
  applyRoleClasses();
  go(member.role === "supplier" ? "delivery" : "overview");
  render();
  toast(`欢迎回来 · ${esc(member.name)}（${ROLE_LABEL[member.role] || ""}）`);
}
/* 共享后端登录：先拉服务端全量快照覆盖本地，再复用本地 enter 逻辑 */
async function enterRemote(member) {
  await pullRemote();
  await applyAccountProfileSeed({ createMissing: true });
  normalizeDeliveredProductTags();
  enterMember(member);
  resumeJobs(); resumeActiveBatches();
}
function shakeCard() {
  const card = $(".lg-card");
  card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
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
      const member = state.members.find(m => m.username === username && m.pin === pin);
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
  document.body.classList.remove("role-supplier", "role-editor", "role-admin");
  showGate();
}

/* ---------- 上下文面板（创作空间 = 账号列表） ---------- */
const collapsedGroups = new Set(state.ui.collapsedGroups || []);
function renderContextPanel() {
  const panel = $("#ctxPanel");
  const zone = document.body.dataset.zone;
  const show = zone === "studio" && state.role !== "supplier";
  panel.hidden = !show;
  document.body.classList.toggle("has-panel", show);
  if (!show) return;
  const prevScrollTop = panel.querySelector(".ctx-groups")?.scrollTop ?? state.ui.ctxScrollTop ?? 0;
  const q = (panel.dataset.q || "").toLowerCase();
  const f = a => a.name.toLowerCase().includes(q);
  const groups = [
    { key: "图文组", list: state.accounts.filter(a => a.mode === "图文" && f(a)) },
    { key: "真人 · 数字人", list: state.accounts.filter(a => a.mode === "视频" && a.subType === "数字人" && f(a)) },
    { key: "素材 · 无数字人", list: state.accounts.filter(a => a.mode === "视频" && a.subType !== "数字人" && f(a)) }
  ];
  panel.innerHTML = `
    <div class="ctx-head">
      <b>账号矩阵</b>
      <button class="icon-btn sm" id="ctxNew" title="创建账号">${icon("plus", 14)}</button>
    </div>
    <div class="ctx-search">${icon("search", 13)}<input id="ctxSearch" placeholder="搜索账号" value="${esc(panel.dataset.q || "")}" /></div>
    <div class="ctx-groups">
      ${groups.map(g => {
        const collapsed = collapsedGroups.has(g.key) && !q;
        return `<div class="ctx-group">
          <button class="ctx-gtitle" data-g="${esc(g.key)}"><span class="chev ${collapsed ? "closed" : ""}">${icon("chevronDown", 12)}</span>${esc(g.key)}<em>${g.list.length}</em></button>
          ${collapsed ? "" : g.list.map(a => `
            <div class="ctx-acc ${a.id === state.ui.activeAccountId ? "is-active" : ""}" data-acc="${a.id}" role="button" tabindex="0">
              <span class="dot" style="background:${gradFor(a.name)}"></span>
              <span class="ctx-name">${esc(a.name)}</span>
              ${platChip(a.platform, true)}
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
  $("#ctxNew").addEventListener("click", () => document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: {} })));
  $("#ctxSearch").addEventListener("input", e => { panel.dataset.q = e.target.value; renderContextPanel(); setTimeout(() => { const i = $("#ctxSearch"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 0); });
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
const ZONE_TITLE = { overview: "首页", agent: "批量创作", studio: "单号创作", assets: "整体资产", drafts: "草稿箱", delivery: "发布清单", analytics: "数据分析", settings: "设置" };
function renderTopbar() {
  const zone = document.body.dataset.zone;
  const bc = $("#topCrumb");
  const acc = activeAccount();
  const { page } = parseHash();
  let crumb = ZONE_TITLE[zone] || "";
  if (zone === "studio" && acc) crumb = `单号创作 / ${acc.name}${page && page !== "home" ? " / " + ({ script: "脚本", boards: "分镜", images: "图片工坊", prompts: "提示词", workshop: "分镜工坊", render: "生成台", cut: "剪辑", copy: "文案", review: "审核" }[page] || "") : ""}`;
  bc.textContent = crumb;
}

/* ---------- ⌘K ---------- */
function paletteCommands() {
  // 供应商仅「发布清单」，与左侧导航栏的角色门禁(base.css role-supplier)保持一致
  const supplier = state.role === "supplier";
  const nav = supplier ? [
    { label: "发布清单", group: "导航", icon: "package", run: () => go("delivery") }
  ] : [
    { label: "首页", group: "导航", icon: "grid", run: () => go("overview") },
    { label: "批量创作", group: "导航", icon: "spark", run: () => go("agent") },
    { label: "单号创作", group: "导航", icon: "film", run: () => { allowStudioFromAgent(); go("studio"); } },
    { label: "整体资产", group: "导航", icon: "folder", run: () => go("assets") },
    { label: "草稿箱", group: "导航", icon: "inbox", run: () => go("drafts") },
    { label: "发布清单", group: "导航", icon: "package", run: () => go("delivery") },
    { label: "数据分析", group: "导航", icon: "pulse", run: () => go("analytics") },
    ...(state.role === "admin" ? [
      { label: "设置", group: "导航", icon: "gear", run: () => go("settings") },
      { label: "创建账号", group: "操作", icon: "plus", run: () => document.dispatchEvent(new CustomEvent("open-account-dialog", { detail: {} })) }
    ] : [])
  ];
  const cmds = [...nav];
  if (supplier) return cmds;   // 供应商不暴露账号/在制任务快捷跳转
  state.accounts.forEach(a => cmds.push({
    label: a.name, hint: a.position.slice(0, 24), group: "账号", icon: "user",
    run: () => { state.ui.activeAccountId = a.id; save("meta"); allowStudioFromAgent(); go("studio"); render(); }
  }));
  state.productions.filter(p => p.stage !== "delivered").slice(0, 30).forEach(p => cmds.push({
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
    if (applyLocalDevKeys(state)) save("meta");
    await remote.init();              // 探测是否由共享后端托管（决定走远端还是本地模式）
    const mig = await migrateFromV4();
    if (mig.migrated) {
      await persistNow();
      setTimeout(() => toast(`已从旧版迁移：${mig.counts.accounts} 账号 / ${mig.counts.productions} 任务 / ${mig.counts.assets} 资产（旧数据保留可回退）`), 800);
    }
    // 本地历史 Blob 可能很多，不能阻塞首屏。资源预览需要时会优先走服务端 URL，
    // 这里后台预热即可，避免旧 IndexedDB 把登录页/首页拖成白屏。
    preloadBlobUrls().catch(e => console.warn("[blob-preload]", e));
    if (!remote.isOn() || !remote.hasToken()) {
      seedIfEmpty();
      ensureXhsSeedAccounts();
    }
    if (!remote.isOn() || remote.hasToken()) await applyAccountProfileSeed({ createMissing: true });
    normalizeDeliveredProductTags();
    pruneEmptySessions();
    await enableServerProxyIfConfigured();
    applyKeyOverrides(state.apiKeys);

    // 注册路由
    registerView("overview", overviewView);
    registerView("agent", agentView);
    registerView("studio", studioView);
    registerView("assets", assetsView);
    registerView("drafts", draftsView);
    registerView("delivery", deliveryView);
    registerView("analytics", analyticsView);
    registerView("settings", settingsView);
    initRouter();

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
    const lgp = $("#lgParticles");
    for (let i = 0; i < 20; i++) {
      const p = document.createElement("i");
      p.style.setProperty("--x", (Math.random() * 100).toFixed(1) + "%");
      p.style.setProperty("--d", (Math.random() * 9).toFixed(2) + "s");
      p.style.setProperty("--t", (8 + Math.random() * 8).toFixed(2) + "s");
      lgp.appendChild(p);
    }

    // 进入：远端共享模式凭 token 自动续登；本地模式凭本地 role/member
    let entered = false;
    if (remote.isOn() && remote.hasToken()) {
      const m = await remote.me();
      if (m) {
        await pullRemote();
        await applyAccountProfileSeed({ createMissing: true });
        normalizeDeliveredProductTags();
        state.role = m.role; state.ui.currentMemberId = m.id; save("meta");
        document.documentElement.classList.add("has-auth-token");
        applyRoleClasses(); $("#loginGate").hidden = true; document.body.classList.remove("gated"); render(); entered = true;
      } else {
        remote.logout();
      }
    } else if (!remote.isOn() && state.role && state.ui.currentMemberId) {
      document.documentElement.classList.add("has-auth-token");
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
