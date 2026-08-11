/* Agent 工作台：独立沉浸式三栏工作区
   会话列表 | 对话流（结构化卡片） | 任务看板（流水线可视化） */

import { $, $$, esc, wireDropZone, timeAgo } from "../core/util.js";
import { icon, agentAvatar } from "../ui/icons.js";
import { state, save, on, productionById, ownedBy } from "../core/store.js";
import { toast, confirmModal, promptModal, publishModal, openModal, removeWithMotion } from "../ui/components.js?v=20260811-v1424-creative-reference-1";
import {
  ensureSession, mySessions, newSession, renameSession, deleteSession, addMsg, handleUserText,
  batchById, batchProds, activeBatches, currentSessionBatches, deleteBatch, setBatchPaused, removeProductionFromBatch,
  selectAccountsForPlan, matchAccounts, startBatch, startGeneration, deliverAll, retryFailedIn,
  templatePlan, defaultPlan, regenerateBatchImage, regenerateBatchVideoCover, regenerateBatchVideo,
  resetPlanReferences, prunePlanReferences, agentSay, hydratedBatchThinkingState
} from "./orchestrator.js?v=20260811-v1424-creative-reference-1";
import { renderMessage, boardRow, accountDisplayName } from "./cards.js?v=20260811-v1424-creative-reference-1";
import { boardStructureKey, patchBoardRow } from "./boardRuntime.js?v=20260727-v118-7";
import { openProductionDrawer } from "../views/prodDrawer.js?v=20260811-v1424-creative-reference-1";
import { deliver } from "../domain/delivery.js?v=20260811-v1424-creative-reference-1";
import { go } from "../core/router.js";
import { urlFor, addAssetFromFile, removeAsset, canDeleteReferenceAsset } from "../domain/assets.js";
import { groupOf, isAvatarAsset } from "../domain/accounts.js";
import { accountPublishAvailable, refreshAccountPublishQuotas } from "../domain/productionQuota.js?v=20260811-v1424-creative-reference-1";
import { qianfanTopicIdeas } from "../core/remote.js";
import { validatePublishText } from "../domain/publishRules.js?v=20260811-v1424-creative-reference-1";

let mounted = false;
let rootEl = null;
const thinkingBySession = new Map(); // sessionId -> { active, steps }
let scrollTopOnce = false;
const PLAN_KIND_GROUP = { image: "图文组", static: "静态视频", material: "视频号", real: "视频号" };

function normalizePlanKind(kind = "", group = "") {
  if (["image", "static", "material", "real"].includes(kind)) return kind;
  if (group === "静态视频") return "static";
  if (group === "素材") return "material";
  if (group === "真人") return "real";
  return "image";
}

function planGroupForKind(kind = "image") {
  return PLAN_KIND_GROUP[normalizePlanKind(kind)] || "图文组";
}

function accountIdsForKind(kind, ids = [], fallbackCount = 0) {
  const group = planGroupForKind(kind);
  const pool = matchAccounts({ group, tags: [], sort: "" });
  const allowed = new Set(pool.map(a => a.id));
  const kept = (ids || []).filter(id => allowed.has(id));
  if (kept.length || !fallbackCount) return kept;
  return pool.slice(0, Math.min(10, Math.max(1, fallbackCount))).map(a => a.id);
}

function applyPlanMode(payload) {
  payload.creativeMode = "custom";
  payload.content = "";
  payload.topic = "";
  payload.topicMode = "fixed";
  payload.perAccountCount = 1;
  payload.accountCounts = {};
  payload.accountCustomCopyModes = {};
  (payload.accountIds || []).forEach(id => {
    payload.accountCustomCopyModes[id] = true;
  });
}

function applyPlanKind(payload, kind) {
  const nextKind = normalizePlanKind(kind, payload.group);
  const previousKind = normalizePlanKind(payload.contentKind, payload.group);
  const oldCount = (payload.accountIds || []).length || Number(payload.accountCount || 0) || 2;
  if (previousKind !== nextKind) {
    resetPlanReferences(payload);
  }
  payload.contentKind = nextKind;
  payload.creativeMode = "custom";
  payload.group = planGroupForKind(nextKind);
  payload.tags = [];
  payload.accountIds = accountIdsForKind(nextKind, payload.accountIds || [], oldCount);
  payload.accountCount = payload.accountIds.length;
  payload.manualAccountSelection = true;
  if (nextKind === "static" && !String(payload.staticVideoStyle || "").trim()) {
    payload.staticVideoStyle = "现代漫画分镜风";
  }
  if (nextKind === "material" && !String(payload.creativeVideoStyle || "").trim()) {
    payload.creativeVideoStyle = "电影级超写实怪诞广告";
  }
  applyPlanMode(payload);
}

function ensurePlanBoard(session = ensureSession()) {
  if ((session.messages || []).length) return session;
  session.title = "新量产计划";
  addMsg(session, { role: "agent", type: "plan", payload: defaultPlan() });
  return session;
}

function findMessageInSessions(messageId) {
  for (const session of mySessions()) {
    const msg = (session.messages || []).find(m => m.id === messageId);
    if (msg) return { session, msg };
  }
  const session = ensureSession();
  return { session, msg: (session.messages || []).find(m => m.id === messageId) || null };
}

function planHasLiveBatch(session, msg) {
  if (!session || !msg) return false;
  const isLive = b => b
    && ownedBy(b)
    && b.sessionId === session.id
    && b.planMessageId === msg.id
    && (b.productionIds || []).length > 0;
  if ((state.batches || []).some(isLive)) return true;
  const messages = session.messages || [];
  const idx = messages.indexOf(msg);
  const later = idx >= 0 ? messages.slice(idx + 1) : messages;
  return later.some(m => m.type === "progress" && isLive(batchById(m.payload?.batchId)));
}

function repairPlanStates(session) {
  let changed = false;
  const now = Date.now();
  (session.messages || []).forEach(m => {
    if (m.type !== "plan" || !m.payload) return;
    if (m.payload.status === "confirmed" && !planHasLiveBatch(session, m)) {
      m.payload.status = "pending";
      delete m.payload.batchId;
      delete m.payload.startedAt;
      changed = true;
    }
    if (m.payload.status === "starting" && now - Number(m.payload.startedAt || 0) > 45000 && !planHasLiveBatch(session, m)) {
      m.payload.status = "pending";
      delete m.payload.startedAt;
      changed = true;
    }
  });
  if (changed) save("sessions");
  return changed;
}

function scrollMsgsTopSoon() {
  requestAnimationFrame(() => {
    const el = $("#agwMsgs");
    if (el) el.scrollTop = 0;
    setTimeout(() => {
      const next = $("#agwMsgs");
      if (next) next.scrollTop = 0;
      scrollTopOnce = false;
    }, 80);
  });
}

export const agentView = {
  render(root) {
    rootEl = root;
    const s = ensurePlanBoard(ensureSession());
    root.innerHTML = `
      <div class="agent-shell">
        <div class="agw-bg"><i></i><i></i><i></i></div>

        <header class="agw-top">
          <button class="agw-back" data-agw="exit">${icon("arrowLeft", 15)} 退出工作台</button>
          <div class="agw-brand"><span class="agw-ava">${agentAvatar(26)}</span><b>批量创作</b><span class="agw-tag">量产任务板</span></div>
          <div class="agw-phase" id="agwPhase"></div>
          <div class="agw-top-right">
            <button class="agw-board-toggle" data-agw="board">${icon("kanban", 15)} 看板</button>
          </div>
        </header>

        <div class="agw-body">
          <aside class="agw-sessions" id="agwSessions"></aside>

          <main class="agw-conv">
            <div class="agw-msgs" id="agwMsgs"></div>
            <div class="agw-composer" id="agwComposer">
              <button class="agw-new-board-button" id="agwNewPanel" type="button">${icon("plus", 16)} 新建任务板</button>
              <textarea id="agwInput" hidden></textarea>
              <button id="agwSend" type="button" hidden></button>
            </div>
          </main>

          <aside class="agw-board" id="agwBoard"></aside>
        </div>
      </div>`;

    renderSessions();
    renderMsgs(true);
    renderBoard();
    renderPhase();
    wire(root);
    void refreshAccountPublishQuotas(state.accounts.map(account => account.id), { force: true }).then(changed => {
      if (changed && isLive()) schedule({ cards: true, structural: true });
    });

    if (!mounted) {
      mounted = true;
      on("agent:msg", () => isLive() && (renderMsgs(true), renderSessions()));
      on("agent:session", () => isLive() && (renderSessions(), renderMsgs(true), renderBoard(), renderPhase()));
      on("agent:thinking", payload => {
        const sessionId = typeof payload === "object" && payload ? payload.sessionId : state.ui.activeSessionId;
        const value = typeof payload === "object" && payload ? !!payload.value : !!payload;
        if (!sessionId) return;
        const cur = thinkingBySession.get(sessionId) || { active: false, steps: [] };
        cur.active = value;
        cur.steps = value ? [] : cur.steps;
        thinkingBySession.set(sessionId, cur);
        if (!value) setTimeout(() => {
          const latest = thinkingBySession.get(sessionId);
          if (latest && !latest.active) { latest.steps = []; thinkingBySession.set(sessionId, latest); isLive() && renderThinking(); }
        }, 400);
        isLive() && renderThinking();
      });
      on("agent:think", payload => {
        const sessionId = typeof payload === "object" && payload ? payload.sessionId : state.ui.activeSessionId;
        const step = typeof payload === "object" && payload ? payload.step : payload;
        if (!sessionId || !step) return;
        const cur = thinkingBySession.get(sessionId) || { active: false, steps: [] };
        cur.steps.push(step);
        thinkingBySession.set(sessionId, cur);
        isLive() && renderThinking();
      });
      on("batch:update", () => schedule({ cards: true, structural: true }));
      on("job:update", job => schedule({ productionId: job?.productionId || "" }));
      on("production:update", production => schedule({ cards: true, productionId: production?.id || "" }));
      on("change", () => schedule());
      window.addEventListener("xingzhen:account-publish-quotas", () => {
        if (isLive()) schedule({ cards: true, structural: true });
      });
    }
  }
};

const isLive = () => document.body.dataset.zone === "agent" && rootEl && rootEl.isConnected;

/**
 * 统一工作区左侧上下文栏使用的会话打开适配器。
 * 只允许切换到当前用户可见的真实会话，避免外部调用直接写入任意 session id。
 */
export function openAgentSession(id) {
  const sessionId = String(id || "").trim();
  if (!sessionId) return false;
  const session = mySessions().find(item => item.id === sessionId);
  if (!session) return false;
  if (state.ui.activeSessionId === sessionId) return true;
  state.ui.activeSessionId = sessionId;
  save("meta");
  if (isLive()) {
    renderSessions();
    renderMsgs(true);
    renderBoard();
    renderPhase();
  }
  return true;
}

if (typeof window !== "undefined") {
  window.openAgentSession = openAgentSession;
}

/* 高频事件用 rAF 合并。普通轮询只更新对应任务行，不能重建整个任务板。 */
let _raf = 0, _needCards = false, _needStructure = false;
const _needRows = new Set();
function schedule({ cards = false, structural = false, productionId = "" } = {}) {
  if (!isLive()) return;
  if (cards) _needCards = true;
  if (structural) _needStructure = true;
  if (productionId) _needRows.add(productionId);
  if (_raf) return;
  _raf = requestAnimationFrame(() => {
    _raf = 0;
    if (!isLive()) return;
    if (_needCards) refreshLiveCards();
    if (_needStructure) renderBoard();
    else {
      let missing = false;
      _needRows.forEach(id => { if (!updateBoardRow(id)) missing = true; });
      updateBoardGroups();
      if (missing) renderBoard();
    }
    renderPhase();
    renderThinking();
    _needCards = _needStructure = false;
    _needRows.clear();
  });
}

/* ---------- 子区渲染 ---------- */
function renderSessions() {
  const el = $("#agwSessions"); if (!el) return;
  const sessions = mySessions();
  el.innerHTML = `
    <button class="agw-new" data-agw="new-session">${icon("plus", 14)} 新建量产</button>
    <div class="agw-slist">${sessions.map(s => {
      const last = s.messages[s.messages.length - 1];
      const hasActive = state.batches.some(b => ownedBy(b) && b.sessionId === s.id && b.phase !== "done");
      const isActive = s.id === state.ui.activeSessionId;
      const hint = last ? textOf(last) : "新会话";
      const menuId = `agw-session-menu-${s.id}`;
      return `<div class="agw-sitem ${isActive ? "is-active" : ""}" data-session-shell="${s.id}">
        <button class="agw-session-open" type="button" data-session="${s.id}" title="${esc(hint)}" ${isActive ? 'aria-current="page"' : ""}>
          <span class="agw-session-title"><b>${esc(s.title)}</b></span>
          <span class="agw-stime"><i class="agw-run-dot ${hasActive ? "is-running" : ""}" title="${hasActive ? "运行中" : "未运行"}"></i>${timeAgo(s.createdAt)}</span>
        </button>
        <button class="agw-session-more" type="button" data-session-menu-toggle="${s.id}" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" aria-label="${esc(s.title)}的更多操作" title="更多操作">${icon("more", 15)}</button>
        <div class="agw-session-menu" id="${menuId}" role="menu" aria-label="${esc(s.title)}的会话操作">
          <button type="button" role="menuitem" data-srename="${s.id}">${icon("edit", 13)}<span>重命名</span></button>
          <button type="button" role="menuitem" class="is-danger" data-sdel="${s.id}">${icon("trash", 13)}<span>删除会话</span></button>
        </div>
      </div>`;
    }).join("")}</div>`;
}

function closeSessionMenus(except = null) {
  $$("[data-session-shell].is-menu-open", rootEl || document).forEach(item => {
    if (item === except) return;
    item.classList.remove("is-menu-open");
    item.querySelector("[data-session-menu-toggle]")?.setAttribute("aria-expanded", "false");
  });
}

function textOf(m) {
  if (m.type === "text") return m.payload.text || "";
  return { plan: "量产任务板", progress: "批次进度", approval: "待发布", results: "批次完成", error: "失败报告" }[m.type] || "";
}

function renderMsgs(scroll = false) {
  const el = $("#agwMsgs"); if (!el) return;
  const s = ensurePlanBoard(ensureSession());
  repairPlanStates(s);
  if (!s.messages.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = s.messages.map(renderMessage).join("") + `<div id="agwThinking"></div>`;
  renderThinking();
  wireDrops();
  if (scrollTopOnce || scroll === "top") {
    el.scrollTop = 0;
    scrollMsgsTopSoon();
  } else if (scroll) el.scrollTop = el.scrollHeight;
}

function visibleThinkingState() {
  const transient = thinkingBySession.get(state.ui.activeSessionId);
  const hydrated = hydratedBatchThinkingState(state.ui.activeSessionId);
  if (transient?.active) {
    return {
      ...transient,
      done: hydrated.active ? hydrated.done : 0,
      total: hydrated.active ? hydrated.total : 0,
      batchIds: hydrated.active ? hydrated.batchIds : [],
    };
  }
  if (hydrated.active) {
    return {
      active: true,
      steps: hydrated.step ? [hydrated.step] : [],
      done: hydrated.done,
      total: hydrated.total,
      batchIds: hydrated.batchIds,
    };
  }
  return transient || { active: false, steps: [] };
}

function thinkStepsHtml() {
  const steps = (visibleThinkingState().steps || []).slice(-4);
  return steps.map((s, i) => `<div class="think-step ${i === steps.length - 1 ? "cur" : "done"}">${i === steps.length - 1 ? `<span class="ts-dot spin"></span>` : icon("check", 11, "ok")}<span>${esc(s)}</span></div>`).join("")
    || `<div class="think-step cur"><span class="ts-dot spin"></span><span>整理思路…</span></div>`;
}
function thinkProgHtml() {
  const cur = visibleThinkingState();
  const total = Math.max(0, Number(cur?.total || 0));
  if (!cur?.active || !total) return "";
  const done = Math.max(0, Math.min(total, Number(cur.done || 0)));
  const pct = Math.round(done / total * 100);
  return `<div class="think-prog"><span>本轮批次 ${done}/${total}</span><i><b style="width:${pct}%"></b></i></div>`;
}
function renderThinking() {
  const t = $("#agwThinking"); if (!t) return;
  const cur = visibleThinkingState();
  if (!cur?.active) { t.innerHTML = ""; return; }
  // 已存在面板：只就地更新步骤/进度，避免整块重渲染导致动效重启「一跳一跳」
  const panel = t.querySelector(".think-panel");
  if (panel) {
    const stepsEl = panel.querySelector(".think-steps");
    if (stepsEl) stepsEl.innerHTML = thinkStepsHtml();
    let progEl = panel.querySelector(".think-prog");
    const progHtml = thinkProgHtml();
    if (progHtml) { if (progEl) progEl.outerHTML = progHtml; else panel.insertAdjacentHTML("beforeend", progHtml); }
    else if (progEl) progEl.remove();
    return;
  }
  // 首次创建
  t.innerHTML = `<div class="ag-row agent">
    <span class="ag-avatar thinking">${agentAvatar(30)}</span>
    <div class="think-panel">
      <div class="think-head"><span class="think-orb"><i></i><i></i><i></i></span><b>思考中</b></div>
      <div class="think-steps">${thinkStepsHtml()}</div>
      ${thinkProgHtml()}
    </div>
  </div>`;
  const el = $("#agwMsgs"); if (el) el.scrollTop = el.scrollHeight;
}

/* 活卡片就地刷新（不打断滚动/输入） */
const PHASE_LABEL = { drafting: "批量起草中", generating: "生成中", review: "待发布", done: "已完成" };
/* 进度卡就地更新（只改进度条宽度与分段计数），避免整卡换节点导致闪烁跳跃 */
function updateProgressCard(node, b) {
  const prods = batchProds(b);
  const c = { draft: 0, gen: 0, review: 0, done: 0, fail: 0 };
  prods.forEach(p => {
    if (p.stageStatus === "failed") c.fail++;
    else if (p.stage === "delivered") c.done++;
    else if (p.stage === "review") c.review++;
    else if (p.stage === "render" || p.stage === "workshop" || (p.stage === "images" && p.stageStatus === "running")) c.gen++;
    else c.draft++;
  });
  const pct = prods.length ? Math.round(c.done / prods.length * 100) : 0;
  const bar = node.querySelector(".agp-bar i"); if (bar) bar.style.width = pct + "%";
  const st = node.querySelector(".agc-state"); if (st) st.textContent = PHASE_LABEL[b.phase] || b.phase;
  const segs = node.querySelector(".agp-segs");
  if (segs) {
    const seg = (label, n, cls) => n ? `<span class="agp-seg ${cls}"><b>${n}</b>${label}</span>` : "";
  segs.innerHTML = seg("起草", c.draft, "draft") + seg("生成", c.gen, "gen") + seg("待审", c.review, "review") + seg("已交付", c.done, "done") + seg("失败", c.fail, "fail");
  }
}
function refreshLiveCards() {
  $$('#agwMsgs [data-mid]').forEach(node => {
    // 进度卡就地更新，不换节点（避免进度条/动画重启的闪烁）
    if (node.dataset.mtype === "progress") {
      const card = node.querySelector("[data-batch]");
      const b = card && batchById(card.dataset.batch);
      if (b) updateProgressCard(node, b);
      return;
    }
    if (!node.querySelector("[data-live]") && node.dataset.mtype !== "approval") return;
    const { msg: m } = findMessageInSessions(node.dataset.mid);
    if (!m) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = renderMessage(m);
    const fresh = tmp.firstElementChild;
    if (!fresh) return;
    // 内容没变就不替换（忽略 wireDrops 写入的 data-wired），避免拖拽区/动画频繁重建的「一跳一跳」
    const norm = h => h.replace(/ data-wired="1"/g, "");
    if (norm(fresh.outerHTML) === norm(node.outerHTML)) return;
    safeReplaceNode(node, fresh);
  });
  wireDrops();
}

function safeReplaceNode(node, fresh) {
  if (!node || !fresh || !node.parentNode) return;
  node.parentNode.replaceChild(fresh, node);
}

function planScrollSnapshot(row) {
  const listEl = $("#agwMsgs");
  return {
    listTop: listEl ? listEl.scrollTop : 0,
    accTop: row?.querySelector?.(".agc-accs")?.scrollTop || 0
  };
}

function restorePlanScroll(snap, row) {
  const restore = () => {
    const listEl = $("#agwMsgs");
    const accs = row?.querySelector?.(".agc-accs");
    if (listEl) listEl.scrollTop = snap.listTop;
    if (accs) accs.scrollTop = snap.accTop;
  };
  restore();
  requestAnimationFrame(restore);
  setTimeout(restore, 60);
}

function rerenderPlanCard(mid, direction = "") {
  const node = document.querySelector(`#agwMsgs [data-mid="${mid}"]`);
  if (!node) return;
  const { msg: m } = findMessageInSessions(mid);
  if (!m) return;
  const snap = planScrollSnapshot(node);
  const tmp = document.createElement("div");
  tmp.innerHTML = renderMessage(m);
  const fresh = tmp.firstElementChild;
  if (fresh) {
    fresh.classList.add("no-enter");
    if (direction) fresh.classList.add(`image-mode-${direction}`);
    safeReplaceNode(node, fresh);
  }
  wireDrops();
  restorePlanScroll(snap, fresh);
}

function freshBoardRow(production) {
  const host = document.createElement("div");
  host.innerHTML = boardRow(production);
  return host.firstElementChild;
}

function selectorValue(value) {
  const text = String(value || "");
  return globalThis.CSS?.escape ? CSS.escape(text) : text.replace(/["\\]/g, "\\$&");
}

function updateBoardRow(productionId) {
  const row = document.querySelector(`#agwBoard [data-pid="${selectorValue(productionId)}"]`);
  const production = productionById(productionId);
  if (!row || !production) return false;
  return patchBoardRow(row, freshBoardRow(production));
}

function updateBoardGroups() {
  const board = $("#agwBoard");
  if (!board) return;
  const groups = currentSessionBatches();
  const total = groups.reduce((sum, b) => sum + (b.productionIds || []).length, 0);
  const boardCount = board.querySelector(".agw-board-head em");
  if (boardCount) boardCount.textContent = `${total} 条`;
  const PH = { drafting: "起草", generating: "生成", review: "待审", done: "完成" };
  groups.forEach(b => {
    const group = board.querySelector(`[data-batchid="${selectorValue(b.id)}"]`);
    if (!group) return;
    const prods = batchProds(b);
    const done = prods.filter(p => p.stage === "delivered").length;
    const topic = group.querySelector(".mb-ghead > b");
    const stat = group.querySelector(".mb-gstat");
    if (topic) topic.textContent = b.topic || "";
    if (stat) stat.textContent = `${b.paused ? "已暂停" : (PH[b.phase] || b.phase)} · ${done}/${prods.length}`;
  });
}

function renderBoard() {
  const el = $("#agwBoard"); if (!el) return;
  // 任务看板按当前会话独立
  const groups = currentSessionBatches();
  const structureKey = boardStructureKey(groups);
  if (el.dataset.structureKey === structureKey && el.childElementCount) {
    groups.forEach(b => batchProds(b).forEach(p => updateBoardRow(p.id)));
    updateBoardGroups();
    return;
  }
  el.dataset.structureKey = structureKey;
  const total = groups.reduce((s, b) => s + (b.productionIds || []).length, 0);
  if (!groups.length) {
    el.innerHTML = `<div class="agw-board-head"><b>任务看板</b><em>0 条</em></div>
      <div class="agw-board-empty">${icon("kanban", 22)}<p>发起量产后，每条任务的流水线出现在这里。阶段圆点实时点亮，点任务看详情，拖图直接上传。</p></div>`;
    return;
  }
  el.innerHTML = `<div class="agw-board-head"><b>任务看板</b><em>${total} 条</em></div>` +
    groups.map(b => {
      const prods = batchProds(b);
      const done = prods.filter(p => p.stage === "delivered").length;
      const PH = { drafting: "起草", generating: "生成", review: "待审", done: "完成" };
      return `<div class="mb-group" data-batchid="${b.id}">
        <div class="mb-ghead">
          <b>${esc(b.topic)}</b>
          <span class="mb-gstat">${b.paused ? "已暂停" : (PH[b.phase] || b.phase)} · ${done}/${prods.length}</span>
          <span class="mb-gactions"><button class="mb-gpause" data-batchpause="${b.id}" title="${b.paused ? "继续项目" : "暂停项目"}">${icon(b.paused ? "play" : "pause", 12)}<span>${b.paused ? "继续" : "暂停"}</span></button><button class="mb-gdel" data-batchdel="${b.id}" title="删除整批">${icon("trash", 12)}<span>删除</span></button></span>
        </div>
        ${prods.map(boardRow).join("")}
      </div>`;
    }).join("");
  // 暂停只阻止后续阶段和新 provider 调用；已经在途的单次调用允许安全落盘。
  $$("#agwBoard [data-batchpause]").forEach(button => button.addEventListener("click", async event => {
    event.stopPropagation();
    const batch = batchById(button.dataset.batchpause);
    if (!batch) return;
    if (!batch.paused) {
      const ok = await confirmModal({ title: "暂停这一批任务？", body: "正在执行的单次调用会安全完成并保存；后续账号和阶段不会继续启动，之后可在这里继续。", okText: "确认暂停" });
      if (!ok) return;
    }
    setBatchPaused(batch.id, !batch.paused);
    renderBoard();
    toast(batch.paused ? "项目已暂停" : "项目已继续");
  }));
  // 删除整批任务：两次确认，避免误删右侧看板项目。
  $$("#agwBoard [data-batchdel]").forEach(b => b.addEventListener("click", async e => {
    e.stopPropagation();
    const batch = batchById(b.dataset.batchdel);
    if (!batch) return;
    const ok = await confirmModal({ title: `删除这一批任务？`, body: `「${batch.topic}」共 ${(batch.productionIds || []).length} 条，连同其在制产物一并移除（已交付的保留）。`, danger: true, okText: "删除" });
    if (ok) {
      const confirmed = await confirmModal({ title: "再次确认永久删除？", body: `只会删除「${batch.topic}」的未交付任务及其在制数据；已交付内容仍保留。此操作无法在看板中撤销。`, danger: true, okText: "确认删除" });
      if (!confirmed) return;
      try {
        await removeWithMotion(b.closest(".mb-group"), () => deleteBatch(batch.id));
        renderPhase();
        renderThinking();
      } catch (err) {
        toast("服务器删除失败，请刷新或重新登录后再试", "error");
      }
    }
  }));
  // 删除单条任务
  $$("#agwBoard [data-proddel]").forEach(b => b.addEventListener("click", async e => {
    e.stopPropagation();
    const p = productionById(b.dataset.proddel);
    if (!p) return;
    const ok = await confirmModal({ title: `删除任务「${p.title || p.topic || "未命名"}」？`, danger: true, okText: "删除" });
    if (ok) {
      try {
        await removeWithMotion(b.closest(".mb-row"), () => removeProductionFromBatch(p.id));
        renderPhase(); refreshLiveCards();
      } catch (err) {
        toast("服务器删除失败，请刷新或重新登录后再试", "error");
      }
    }
  }));
  // 看板行拖拽上传
  $$("#agwBoard [data-dropprod]").forEach(row => {
    wireDropZone(row, async files => {
      const p = productionById(row.dataset.dropprod);
      if (!p) return;
      const r = await routeFilesToProduction(p, files);
      if (r) toast(`已上传 ${r} 张到「${p.title || p.topic}」`);
    });
  });
}

async function routeFilesToProduction(p, files) {
  const { fileToDataUrl } = await import("../core/util.js");
  const { addAssetFromDataUrl } = await import("../domain/assets.js");
  const { maybeAdvanceAfterInput } = await import("./orchestrator.js?v=20260811-v1424-creative-reference-1");
  const isImg = p.mode === "图文";
  const items = isImg ? p.artifacts.images.items : p.artifacts.boards.items;
  let n = 0;
  for (const f of Array.from(files).filter(x => x.type.startsWith("image/"))) {
    const i = items.findIndex(x => !x.assetId);
    if (i < 0) break;
    const dataUrl = await fileToDataUrl(f);
    const a = await addAssetFromDataUrl(p.accountId, { name: `${isImg ? "笔记图" : "分镜图"}${String(i + 1).padStart(2, "0")}_${(p.title || "").slice(0, 6)}`, tags: [isImg ? "笔记图" : "分镜图", "Agent上传"], dataUrl });
    items[i].assetId = a.id; items[i].status = "done"; n++;
  }
  if (n) {
    save("productions");
    if (items.every(x => x.assetId)) maybeAdvanceAfterInput(p);
  }
  return n;
}

function renderPhase() {
  const el = $("#agwPhase"); if (!el) return;
  const bs = currentSessionBatches().filter(b => b.phase !== "done");
  if (!bs.length) {
    const html = `<span class="agw-idle">空闲 · 等待新目标</span>`;
    if (el.innerHTML !== html) el.innerHTML = html;
    return;
  }
  const c = { draft: 0, gen: 0, review: 0, done: 0, fail: 0 };
  bs.forEach(b => batchProds(b).forEach(p => {
    if (p.stageStatus === "failed") c.fail++;
    else if (p.stage === "delivered") c.done++;
    else if (p.stage === "review") c.review++;
    else if (p.stage === "render" || p.stage === "workshop" || (p.stage === "images" && p.stageStatus === "running")) c.gen++;
    else c.draft++;
  }));
  const chip = (label, n, cls) => n ? `<span class="phase-chip ${cls}">${label} ${n}</span>` : "";
  const html = chip("起草", c.draft, "draft") + chip("生成", c.gen, "gen") + chip("待审", c.review, "review") + chip("失败", c.fail, "fail") + chip("已交付", c.done, "done");
  if (el.innerHTML !== html) el.innerHTML = html;
}

/* ---------- 事件 ---------- */
function wire(root) {
  // 委托监听挂到每次重建的 .agent-shell 上（而非持久的 #viewRoot），避免多次进入后监听器叠加
  const shell = root.querySelector(".agent-shell") || root;
  const input = $("#agwInput", root);
  const fit = () => { input.style.height = "auto"; input.style.height = Math.min(140, input.scrollHeight) + "px"; };
  input.addEventListener("input", fit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $("#agwSend", root).addEventListener("click", send);
  $("#agwNewPanel", root).addEventListener("click", () => {
    const session = ensureSession();
    addMsg(session, { role: "agent", type: "plan", payload: defaultPlan("新量产计划") });
    renderMsgs(true);
  });
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = ""; fit();
    await handleUserText(text);
  }

  const handlePlanPickClick = e => {
    const tagBtn = e.target.closest("[data-ptag]");
    const accBtn = e.target.closest("[data-pacc]");
    if (!tagBtn && !accBtn) return false;
    e.preventDefault();
    const node = e.target.closest("[data-plan]");
    if (!node) return true;
    const { msg: m } = findMessageInSessions(node.dataset.plan);
    if (!m || m.payload.status !== "pending") return true;
    if (tagBtn) {
      const t = tagBtn.dataset.ptag;
      const i = m.payload.tags.indexOf(t);
      i >= 0 ? m.payload.tags.splice(i, 1) : m.payload.tags.push(t);
      m.payload.manualAccountSelection = false;
      m.payload.accountIds = selectAccountsForPlan(m.payload).map(a => a.id);
    } else {
      const id = accBtn.dataset.pacc;
      const i = m.payload.accountIds.indexOf(id);
      if (i < 0 && !accountPublishAvailable(id)) {
        toast("该账号今日已达 2 条发布上限，无法再选择", "error");
        return true;
      }
      i >= 0 ? m.payload.accountIds.splice(i, 1) : m.payload.accountIds.push(id);
      m.payload.accountCount = m.payload.accountIds.length;
      m.payload.manualAccountSelection = true;
    }
    prunePlanReferences(m.payload);
    save("sessions");
    rerenderPlanCard(m.id);
    return true;
  };

  // 全局委托
  shell.addEventListener("click", async e => {
    const sessionMenuToggle = e.target.closest("[data-session-menu-toggle]");
    if (sessionMenuToggle) {
      e.stopPropagation();
      const sessionShell = sessionMenuToggle.closest("[data-session-shell]");
      const opening = !sessionShell?.classList.contains("is-menu-open");
      closeSessionMenus(opening ? sessionShell : null);
      sessionShell?.classList.toggle("is-menu-open", opening);
      sessionMenuToggle.setAttribute("aria-expanded", opening ? "true" : "false");
      return;
    }
    if (!e.target.closest(".agw-session-menu")) closeSessionMenus();

    const exit = e.target.closest('[data-agw="exit"]');
    if (exit) { go("overview"); return; }
    if (e.target.closest('[data-agw="new-session"]')) { scrollTopOnce = true; newSession(); scrollMsgsTopSoon(); return; }
    if (e.target.closest('[data-agw="board"]')) { root.querySelector(".agent-shell").classList.toggle("board-hidden"); return; }

    // 会话重命名 / 删除（先于会话切换判断）
    const srn = e.target.closest("[data-srename]");
    if (srn) {
      closeSessionMenus();
      const s2 = state.sessions.find(x => x.id === srn.dataset.srename);
      const name = await promptModal({ title: "重命名会话", value: s2?.title || "", placeholder: "会话名称" });
      if (name) { renameSession(srn.dataset.srename, name); renderSessions(); }
      return;
    }
    const sdl = e.target.closest("[data-sdel]");
    if (sdl) {
      closeSessionMenus();
      const ok = await confirmModal({ title: "删除这个会话？", body: "对话记录会被删除；批次与任务数据保留，可在看板/单号创作里继续查看。", danger: true, okText: "删除" });
      if (ok) {
        try {
          await deleteSession(sdl.dataset.sdel);
          renderSessions(); renderMsgs(true);
        } catch (err) {
          toast("服务器删除失败，请刷新或重新登录后再试", "error");
        }
      }
      return;
    }

    if (e.target.closest(".agw-session-menu")) return;

    const sess = e.target.closest("[data-session]");
    if (sess) { openAgentSession(sess.dataset.session); return; }

    // 固定流程模板：一键生成计划卡（每号随机主题）
    const tpl = e.target.closest("[data-tpl]");
    if (tpl) {
      const plan = templatePlan(tpl.dataset.tpl);
      if (!plan) return;
      if (!plan.accountIds.length) { toast("该分组下还没有账号"); return; }
      const s3 = ensureSession();
      const existing = [...s3.messages].reverse().find(m => m.type === "plan" && m.payload?.status === "pending");
      if (existing) { existing.payload = { ...existing.payload, status: "pending", ...plan }; save("sessions"); renderMsgs(true); }
      else addMsg(s3, { role: "agent", type: "plan", payload: { status: "pending", ...plan } });
      return;
    }

    const kindBtn = e.target.closest("[data-pf-kind]");
    if (kindBtn) {
      const node = e.target.closest("[data-plan]");
      const { msg: m } = node ? findMessageInSessions(node.dataset.plan) : {};
      if (!m || m.payload.status !== "pending") return;
      applyPlanKind(m.payload, kindBtn.dataset.pfKind);
      save("sessions");
      rerenderPlanCard(m.id);
      return;
    }

    if (handlePlanPickClick(e)) return;

    const act = e.target.closest("[data-act]");
    if (!act) return;
    const pid = act.dataset.pid;
    const p = pid ? productionById(pid) : null;
    const batch = act.dataset.batch ? batchById(act.dataset.batch) : null;
    const s = ensureSession();

    switch (act.dataset.act) {
      case "plan-apply-image-count": {
        const { msg: m } = findMessageInSessions(act.dataset.mid);
        if (!m || m.payload.status !== "pending") return;
        const count = Math.max(1, Math.min(12, Number(m.payload.imageCount || 4) || 4));
        m.payload.imageCount = count;
        m.payload.accountImageCounts = m.payload.accountImageCounts || {};
        (m.payload.accountIds || []).forEach(accountId => {
          m.payload.accountImageCounts[accountId] = count;
        });
        save("sessions");
        rerenderPlanCard(m.id);
        toast(`已将全部已选图文账号设为每条 ${count} 张图`);
        break;
      }
      case "plan-ai-topic": {
        openAiTopicPicker(act.dataset.mid);
        break;
      }
      case "plan-select-all": {
        const { msg: m } = findMessageInSessions(act.dataset.mid);
        if (!m || m.payload.status !== "pending") return;
        const group = planGroupForKind(m.payload.contentKind || normalizePlanKind("", m.payload.group));
        const pool = matchAccounts({ group, tags: [], sort: "" }).filter(account => accountPublishAvailable(account.id));
        const allSelected = pool.length > 0 && pool.every(account => (m.payload.accountIds || []).includes(account.id));
        m.payload.accountIds = allSelected ? [] : pool.map(account => account.id);
        m.payload.accountCount = m.payload.accountIds.length;
        m.payload.manualAccountSelection = true;
        prunePlanReferences(m.payload);
        save("sessions");
        rerenderPlanCard(m.id);
        toast(allSelected ? "已取消全选" : `已全选 ${pool.length} 个账号`);
        break;
      }
      case "plan-remove-account": {
        const { msg: m } = findMessageInSessions(act.dataset.mid);
        if (!m || m.payload.status !== "pending") return;
        const accountId = act.dataset.account || "";
        m.payload.accountIds = (m.payload.accountIds || []).filter(id => id !== accountId);
        m.payload.accountCount = m.payload.accountIds.length;
        ["accountCopyTitles", "accountCopyBodies", "accountRefAssetIds", "accountImageCounts", "accountImageCreationModes", "accountImagePrompts", "accountSingleImageTitles", "accountCounts", "accountContents", "accountProductIds", "accountCustomCopyModes"].forEach(key => {
          if (m.payload[key]) delete m.payload[key][accountId];
        });
        prunePlanReferences(m.payload);
        save("sessions");
        rerenderPlanCard(m.id);
        toast("已从本次计划取消该账号");
        break;
      }
      case "plan-asset-pick": {
        await openPlanAssetPicker(act.dataset.mid, act.dataset.refKind || "shared", act.dataset.refAccount || "");
        break;
      }
      case "plan-image-mode": {
        const { msg: m } = findMessageInSessions(act.dataset.mid);
        if (!m || m.payload.status !== "pending") return;
        const accountId = act.dataset.account || "";
        if (!accountId) return;
        m.payload.accountImageCreationModes = m.payload.accountImageCreationModes || {};
        m.payload.accountImageCreationModes[accountId] = act.dataset.mode === "single" ? "single" : "copy";
        save("sessions");
        rerenderPlanCard(m.id, act.dataset.mode === "single" ? "forward" : "backward");
        break;
      }
      case "plan-edit-copy": {
        openPlanContentEditor(act.dataset.mid, act.dataset.account || "", "copy");
        break;
      }
      case "plan-edit-single-image": {
        openPlanContentEditor(act.dataset.mid, act.dataset.account || "", "single");
        break;
      }
      case "plan-random-accounts": {
        const { msg: m } = findMessageInSessions(act.dataset.mid);
        if (!m || m.payload.status !== "pending") return;
        m.payload.group = planGroupForKind(m.payload.contentKind || normalizePlanKind("", m.payload.group));
        const pool = matchAccounts({ group: m.payload.group || "all", tags: m.payload.tags || [], sort: m.payload.sort || "" })
          .filter(account => accountPublishAvailable(account.id));
        if (!pool.length) { toast("当前条件下没有可选账号"); break; }
        const picked = pool
          .map(a => ({ a, r: Math.random() }))
          .sort((x, y) => x.r - y.r)
          .slice(0, Math.min(10, pool.length))
          .map(x => x.a.id);
        m.payload.accountIds = picked;
        m.payload.accountCount = picked.length;
        m.payload.manualAccountSelection = true;
        prunePlanReferences(m.payload);
        save("sessions");
        rerenderPlanCard(m.id);
        toast(`已随机选择 ${picked.length} 个账号`);
        break;
      }
      case "plan-confirm": {
        const { session: ownerSession, msg: m } = findMessageInSessions(act.dataset.mid);
        if (!m || m.payload.status !== "pending") return;
        const runSession = ownerSession || s;
        try {
          // 准备、校验、启动必须处于同一个异常边界；任何同步错误都要给用户反馈并解锁按钮。
          m.payload.contentKind = normalizePlanKind(m.payload.contentKind, m.payload.group);
          m.payload.group = planGroupForKind(m.payload.contentKind);
          m.payload.accountIds = accountIdsForKind(m.payload.contentKind, m.payload.accountIds || [], 0);
          m.payload.accountCount = m.payload.accountIds.length;
          applyPlanMode(m.payload);
          prunePlanReferences(m.payload);
          if (!m.payload.accountIds.length) throw new Error("至少选择一个账号");
          const missingCustom = (m.payload.accountIds || []).filter(id => {
            const acc = state.accounts.find(a => a.id === id);
            const imageAccount = acc?.mode === "图文" || groupOf(acc) === "图文组";
            if (imageAccount && (m.payload.accountImageCreationModes || {})[id] === "single") {
              return !String((m.payload.accountSingleImageTitles || {})[id] || "").trim()
                || !String((m.payload.accountImagePrompts || {})[id] || "").trim();
            }
            const title = String((m.payload.accountCopyTitles || {})[id] || "").trim();
            const body = String((m.payload.accountCopyBodies || {})[id] || "").trim();
            return imageAccount ? !title : (!title && !body);
          });
          if (missingCustom.length) {
            const names = missingCustom
              .slice(0, 3)
              .map(id => state.accounts.find(a => a.id === id)?.name || "未命名账号")
              .join("、");
            throw new Error(`图文组图需填写标题；单图需填写标题和提示词：${names}${missingCustom.length > 3 ? "等" : ""}`);
          }
          if (m.payload.contentKind === "real") {
            const missingRole = (m.payload.accountIds || []).filter(id => !state.accounts.find(a => a.id === id)?.charBoardAssetId);
            if (missingRole.length) {
              const names = missingRole.slice(0, 3).map(id => state.accounts.find(a => a.id === id)?.name || "未命名账号").join("、");
              throw new Error(`数字人创作请先上传角色形象：${names}${missingRole.length > 3 ? "等" : ""}`);
            }
          }
          act.disabled = true;
          act.setAttribute("aria-busy", "true");
          act.innerHTML = `${icon("loader", 14)} 正在启动…`;
          state.ui.activeSessionId = runSession.id;
          m.payload.status = "starting";
          m.payload.startedAt = Date.now();
          state.ui.activeProductionId = null;
          state.ui.returnTo = null;
          save("sessions", "meta");
          // 先让浏览器绘制“正在启动”，再创建任务；不要提前整段重绘并销毁刚点击的按钮。
          await new Promise(resolve => requestAnimationFrame(resolve));
          const batch = await startBatch({ ...m.payload, goal: m.payload.goal, planMessageId: m.id }, runSession);
          if (!batch?.productionIds?.length) throw new Error("没有成功创建批量内容任务");
          m.payload.status = "confirmed";
          m.payload.batchId = batch.id;
          delete m.payload.startedAt;
          save("sessions");
          if (document.body.dataset.zone !== "agent") go("agent");
          else { renderMsgs(true); renderSessions(); renderBoard(); renderPhase(); }
        } catch (err) {
          console.error(err);
          m.payload.status = "pending";
          delete m.payload.startedAt;
          save("sessions");
          renderMsgs(true);
          renderBoard();
          toast(err?.message ? `批量任务启动失败：${err.message}` : "批量任务启动失败，请检查本地 API 或稍后重试", "error");
        } finally {
          if (m.payload.status === "pending" && act.isConnected) {
            act.disabled = false;
            act.removeAttribute("aria-busy");
            act.innerHTML = `${icon("spark", 14)} 确认执行`;
          }
        }
        break;
      }
      case "plan-cancel": {
        const { session: ownerSession, msg: m } = findMessageInSessions(act.dataset.mid);
        if (m && ownerSession) {
          ownerSession.messages = (ownerSession.messages || []).filter(x => x.id !== m.id);
          if (!ownerSession.messages.length) ownerSession.title = "新量产计划";
          save("sessions");
          renderSessions();
          renderMsgs("top");
          renderBoard();
          renderPhase();
        }
        break;
      }
      case "plan-refclear": {
        const { msg: m } = findMessageInSessions(act.dataset.mid);
        if (m) {
          m.payload.sharedRefAssetId = null;
          m.payload.sharedRefAssetIds = [];
          prunePlanReferences(m.payload);
          save("sessions");
          rerenderPlanCard(m.id);
        }
        break;
      }
      case "plan-refremove": {
        const { msg: m } = findMessageInSessions(act.dataset.mid);
        if (m) {
          const id = act.dataset.refid;
          m.payload.sharedRefAssetIds = (m.payload.sharedRefAssetIds || []).filter(x => x !== id);
          if (m.payload.sharedRefAssetId === id) m.payload.sharedRefAssetId = m.payload.sharedRefAssetIds[0] || null;
          prunePlanReferences(m.payload);
          save("sessions");
          rerenderPlanCard(m.id);
        }
        break;
      }
      case "plan-cover-refremove": {
        const { msg: m } = findMessageInSessions(act.dataset.mid);
        if (m) {
          const id = act.dataset.refid;
          m.payload.coverRefAssetIds = (m.payload.coverRefAssetIds || []).filter(x => x !== id);
          prunePlanReferences(m.payload);
          save("sessions");
          rerenderPlanCard(m.id);
        }
        break;
      }
      case "plan-cover-refclear": {
        const { msg: m } = findMessageInSessions(act.dataset.mid);
        if (m) {
          m.payload.coverRefAssetIds = [];
          prunePlanReferences(m.payload);
          save("sessions");
          rerenderPlanCard(m.id);
        }
        break;
      }
      case "plan-custom-refremove": {
        const { msg: m } = findMessageInSessions(act.dataset.mid);
        const accountId = act.dataset.refAccount || act.closest("[data-ref-account]")?.dataset.refAccount || act.closest("[data-pacc-ref]")?.dataset.paccRef;
        if (m && accountId) {
          const id = act.dataset.refid;
          m.payload.accountRefAssetIds = m.payload.accountRefAssetIds || {};
          m.payload.accountRefAssetIds[accountId] = (m.payload.accountRefAssetIds[accountId] || []).filter(x => x !== id);
          prunePlanReferences(m.payload);
          save("sessions");
          rerenderPlanCard(m.id);
        }
        break;
      }
      case "batch-image-edit": if (p) openBatchImageEditor(p, act.dataset.imageIndex); break;
      case "batch-cover-edit": if (p) openBatchVideoCoverEditor(p); break;
      case "batch-video-regenerate": {
        if (!p) break;
        if (p.staticVideo) {
          toast("静态视频不支持单独微调，请从批次中重试整条任务", "error");
          break;
        }
        const ok = await confirmModal({ title: `重新生成「${p.artifacts.copy.title || p.title || "视频"}」？`, body: "会保留文案、口播、封面和参考图，只重新派发视频画面任务。", okText: "重新生成" });
        if (!ok) break;
        try {
          const n = await regenerateBatchVideo(p);
          toast(`已重新派发 ${n} 个视频单元`);
          refreshLiveCards();
          renderBoard();
        } catch (err) {
          toast(err?.message || "视频重新生成失败", "error");
        }
        break;
      }
      case "open-prod": if (p) openProductionDrawer(p.id); break;
      case "batch-generate": if (batch) { const n = startGeneration(batch); toast(n ? `已派发 ${n} 个渲染任务` : "没有就绪任务"); } break;
      case "batch-retry": if (batch) {
        const n = retryFailedIn(batch);
        const text = n
          ? `已收到重试指令，正在重新排队 ${n} 个失败任务。任务会原位更新，不会重复提交已成功项。`
          : "已检查当前批次，没有可重试的失败任务。";
        agentSay(text);
        toast(n ? `正在重试 ${n} 个失败任务` : "没有失败任务");
        refreshLiveCards();
        renderBoard();
      } break;
      case "batch-deliver-all": {
        if (!batch) break;
        const cnt = batchProds(batch).filter(x => x.stage === "review").length;
        if (!cnt) { toast("本批没有待发布的内容"); break; }
        const r = await publishModal({ title: `定稿并发布本批 ${cnt} 条内容`, okText: "全部发布" });
        if (r != null) {
          try {
            const n = await deliverAll(batch, r);
            toast(`已发布 ${n} 条入供应商端${r.planDate ? ` · 计划 ${r.planDate}` : ""}`);
          } catch (error) {
            toast(error?.message || "批量发布失败，请重试", "error");
          }
          refreshLiveCards();
        }
        break;
      }
      case "prod-deliver": {
        if (!p) break;
        const r = await publishModal({ title: `定稿并发布「${p.artifacts.copy.title || p.title}」` });
        if (r != null) {
          try {
            const a = await deliver(p, r);
            toast(a ? `已发布 · #${String(a.pubSeq).padStart(3, "0")}${a.planDate ? ` · 计划 ${a.planDate}` : ""}` : "发布失败");
          } catch (error) {
            toast(error?.message || "发布失败，请重试", "error");
          }
          refreshLiveCards();
        }
        break;
      }
    }
  });

  // 计划卡统一参考图上传
  shell.addEventListener("change", async e => {
    const ref = e.target.closest("[data-plan-ref]");
    if (ref && ref.files.length) { await setPlanRefs(ref.dataset.planRef, Array.from(ref.files)); ref.value = ""; }
    const coverRef = e.target.closest("[data-plan-cover-ref]");
    if (coverRef && coverRef.files.length) { await setPlanRefs(coverRef.dataset.planCoverRef, Array.from(coverRef.files), "cover"); coverRef.value = ""; }
    const customRef = e.target.closest("[data-pacc-ref-up]");
    if (customRef && customRef.files.length) {
      await setPlanCustomRefs(customRef.dataset.mid, customRef.dataset.paccRefUp, Array.from(customRef.files));
      customRef.value = "";
    }
  });

  // 计划卡编辑
  const updatePlanField = e => {
    const f = e.target.closest("[data-pf]");
    const ap = e.target.closest("[data-pacc-prod]");
    const ac = e.target.closest("[data-pacc-content]");
    const actitle = e.target.closest("[data-pacc-copy-title]");
    const acbody = e.target.closest("[data-pacc-copy-body]");
    const aiprompt = e.target.closest("[data-pacc-image-prompt]");
    const aisingleTitle = e.target.closest("[data-pacc-single-title]");
    const ar = e.target.closest("[data-pacc-ref]");
    const acount = e.target.closest("[data-pacc-count]");
    const aimg = e.target.closest("[data-pacc-imgcount]");
    if (!f && !ap && !ac && !actitle && !acbody && !aiprompt && !aisingleTitle && !ar && !acount && !aimg) return;
    const node = e.target.closest("[data-plan]");
    if (!node) return;
    const { msg: m } = findMessageInSessions(node.dataset.plan);
    if (!m || m.payload.status !== "pending") return;
    if (f) {
      if (f.type === "checkbox") {
        m.payload[f.dataset.pf] = !!f.checked;
      } else if (f.multiple) {
        m.payload[f.dataset.pf] = Array.from(f.selectedOptions).map(o => o.value).filter(Boolean).slice(0, 5);
        if (f.dataset.pf === "sharedRefAssetIds") m.payload.sharedRefAssetId = m.payload.sharedRefAssetIds[0] || null;
      } else {
        m.payload[f.dataset.pf] = f.dataset.pf === "perAccountCount"
          ? Math.max(1, Math.min(12, Number(f.value || 1) || 1))
          : f.dataset.pf === "imageCount"
            ? Math.max(1, Math.min(12, Number(f.value || 4) || 4))
          : f.value;
      }
    }
    if (ap) {
      m.payload.accountProductIds = m.payload.accountProductIds || {};
      m.payload.accountProductIds[ap.dataset.paccProd] = ap.value;
    }
    if (ac) {
      m.payload.accountContents = m.payload.accountContents || {};
      m.payload.accountContents[ac.dataset.paccContent] = ac.value;
    }
    if (actitle) {
      m.payload.accountCopyTitles = m.payload.accountCopyTitles || {};
      m.payload.accountCopyTitles[actitle.dataset.paccCopyTitle] = actitle.value;
    }
    if (acbody) {
      m.payload.accountCopyBodies = m.payload.accountCopyBodies || {};
      m.payload.accountCopyBodies[acbody.dataset.paccCopyBody] = acbody.value;
    }
    if (aiprompt) {
      m.payload.accountImagePrompts = m.payload.accountImagePrompts || {};
      m.payload.accountImagePrompts[aiprompt.dataset.paccImagePrompt] = aiprompt.value;
    }
    if (aisingleTitle) {
      m.payload.accountSingleImageTitles = m.payload.accountSingleImageTitles || {};
      m.payload.accountSingleImageTitles[aisingleTitle.dataset.paccSingleTitle] = aisingleTitle.value;
    }
    if (ar) {
      m.payload.accountRefAssetIds = m.payload.accountRefAssetIds || {};
      m.payload.accountRefAssetIds[ar.dataset.paccRef] = Array.from(ar.selectedOptions).map(o => o.value).filter(Boolean).slice(0, 3);
    }
    if (acount) {
      m.payload.accountCounts = m.payload.accountCounts || {};
      m.payload.accountCounts[acount.dataset.paccCount] = Math.max(1, Math.min(12, Number(acount.value || m.payload.perAccountCount || 1) || 1));
    }
    if (aimg) {
      m.payload.accountImageCounts = m.payload.accountImageCounts || {};
      m.payload.accountImageCounts[aimg.dataset.paccImgcount] = Math.max(1, Math.min(12, Number(aimg.value || m.payload.imageCount || 4) || 4));
    }
    prunePlanReferences(m.payload);
    save("sessions");
    if (f?.multiple || ar || acount || aimg || ["perAccountCount", "imageCount"].includes(f?.dataset.pf)) rerenderPlanCard(m.id);
  };
  shell.addEventListener("input", updatePlanField);
  shell.addEventListener("change", updatePlanField);

  shell.addEventListener("keydown", e => {
    const openShell = e.target.closest?.("[data-session-shell]");
    if (!openShell) return;
    if (e.key === "Escape" && openShell.classList.contains("is-menu-open")) {
      e.preventDefault();
      const toggle = openShell.querySelector("[data-session-menu-toggle]");
      closeSessionMenus();
      toggle?.focus();
      return;
    }
    const toggle = e.target.closest?.("[data-session-menu-toggle]");
    if (toggle && e.key === "ArrowDown") {
      e.preventDefault();
      closeSessionMenus(openShell);
      openShell.classList.add("is-menu-open");
      toggle.setAttribute("aria-expanded", "true");
      openShell.querySelector(".agw-session-menu [role='menuitem']")?.focus();
      return;
    }
    const menuItem = e.target.closest?.(".agw-session-menu [role='menuitem']");
    if (!menuItem || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const items = [...openShell.querySelectorAll(".agw-session-menu [role='menuitem']")];
    const index = items.indexOf(menuItem);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  });

  wireDrops();
}

async function setPlanRefs(mid, files, kind = "shared") {
  const { msg: m } = findMessageInSessions(mid);
  if (!m || m.payload.status !== "pending") return;
  const isCover = kind === "cover";
  const oldIds = isCover
    ? (Array.isArray(m.payload.coverRefAssetIds) ? m.payload.coverRefAssetIds : [])
    : (Array.isArray(m.payload.sharedRefAssetIds) ? m.payload.sharedRefAssetIds : (m.payload.sharedRefAssetId ? [m.payload.sharedRefAssetId] : []));
  const remaining = Math.max(0, 5 - oldIds.length);
  const imgs = Array.from(files || []).filter(f => f?.type?.startsWith("image/")).slice(0, remaining);
  if (!imgs.length) { toast(`${isCover ? "统一视频参考图" : "统一参考图"}最多 5 张`); return; }
  const { fileToDataUrl } = await import("../core/util.js");
  const { addAssetFromDataUrl } = await import("../domain/assets.js");
  const acc0 = state.accounts.find(a => m.payload.accountIds.includes(a.id) && a.mode === "视频") || state.accounts.find(a => m.payload.accountIds.includes(a.id));
  const newIds = [];
  for (const file of imgs) {
    const dataUrl = await fileToDataUrl(file);
    const a = await addAssetFromDataUrl(acc0?.id, { name: file.name || (isCover ? "批量统一视频参考图" : "批量统一参考图"), tags: ["参考图", isCover ? "视频统一参考" : "统一参考"], dataUrl });
    newIds.push(a.id);
  }
  const nextIds = [...new Set([...oldIds, ...newIds])].slice(0, 5);
  if (isCover) {
    m.payload.coverRefAssetIds = nextIds;
  } else {
    m.payload.sharedRefAssetIds = nextIds;
    m.payload.sharedRefAssetId = m.payload.sharedRefAssetIds[0] || null;
  }
  prunePlanReferences(m.payload);
  save("sessions");
  rerenderPlanCard(m.id);
  toast(`已追加 ${newIds.length} 张${isCover ? "统一视频参考图" : "统一参考图"}`);
}

function planMessage(mid) {
  const { msg } = findMessageInSessions(mid);
  return msg?.type === "plan" ? msg : null;
}

function planRefIds(payload, kind, accountId = "") {
  if (kind === "custom") {
    const raw = payload.accountRefAssetIds?.[accountId];
    return Array.isArray(raw) ? raw.filter(Boolean) : [];
  }
  if (kind === "cover") return Array.isArray(payload.coverRefAssetIds) ? [...new Set(payload.coverRefAssetIds.filter(Boolean))] : [];
  const ids = Array.isArray(payload.sharedRefAssetIds) ? [...payload.sharedRefAssetIds] : [];
  if (payload.sharedRefAssetId && !ids.includes(payload.sharedRefAssetId)) ids.unshift(payload.sharedRefAssetId);
  return [...new Set(ids.filter(Boolean))];
}

function imageAssetList(accountId = "") {
  const score = a => {
    const tags = (a.tags || []).join(" ");
    if (/logo|头像|图文风格参考|主界面|角色版/i.test(`${a.name || ""} ${tags}`)) return 0;
    if (a.shared || /已发布生成图|站内生成|笔记图/.test(tags)) return 1;
    return 2;
  };
  const seen = new Set();
  return state.assets
    .filter(a => a.type === "图片" && !isAvatarAsset(a) && !a.delivered
      && (!a.accountId || (accountId && a.accountId === accountId))
      && (a.shared || ownedBy(a)))
    .sort((a, b) => score(a) - score(b) || (b.sharedAt || b.createdAt || 0) - (a.sharedAt || a.createdAt || 0))
    .filter(a => {
      const key = a.dataUrl || a.url || a.remoteUrl || `${String(a.name || "").toLowerCase()}|${(a.tags || []).join("|")}|${a.accountId || ""}`;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function openPlanAssetPicker(mid, kind = "shared", accountId = "") {
  const m = planMessage(mid);
  if (!m || m.payload.status !== "pending") return;
  if (kind === "custom" && !accountId) return;
  const limit = kind === "custom" ? 3 : 5;
  const title = kind === "custom" ? "选择定制参考图" : kind === "cover" ? "选择统一视频参考图" : "选择统一参考图";
  const assets = imageAssetList(kind === "custom" ? accountId : "");
  const selected = new Set(planRefIds(m.payload, kind, accountId).slice(0, limit));
  const accountName = accountId ? accountDisplayName(state.accounts.find(a => a.id === accountId), "当前账号") : "";
  const sourceLabel = a => {
    const tags = (a.tags || []).join(" ");
    if (!a.accountId) return "公共素材池";
    if (/logo|图文风格参考|主界面|角色版/i.test(`${a.name || ""} ${tags}`)) return "账号固定素材";
    if (a.shared || /已发布生成图|站内生成|笔记图/.test(tags)) return "已发布生成图";
    return "账号素材";
  };
  const assetCardHtml = a => {
    const u = urlFor(a);
    const on = selected.has(a.id);
    const source = sourceLabel(a);
    const deletable = canDeleteReferenceAsset(a);
    return `<div class="asset-pick-card ${on ? "on" : ""}" data-asset-pick="${a.id}" role="button" tabindex="0" title="${esc(a.name || "参考图")}">
      <span class="asset-pick-thumb">${u ? `<img src="${u}" alt="${esc(a.name || "参考图")}" />` : `<i>${esc((a.name || "图").slice(0, 1))}</i>`}</span>
      <b>${esc(a.name || "未命名图片")}</b>
      <em>${esc(source)}</em>
      <span class="asset-pick-check">${icon("check", 13)}</span>
      ${deletable ? `<button class="asset-pick-delete" data-asset-del="${a.id}" title="删除这张参考图">${icon("trash", 12)}</button>` : ""}
    </div>`;
  };
  const html = `
    <div class="mp-head">
      <b>${esc(title)}</b>
      <button class="icon-btn ghost" data-close title="关闭">${icon("x", 15)}</button>
    </div>
    <div class="asset-picker">
      <div class="asset-picker-meta">
        <span>${kind === "custom" ? esc(accountName) + " · " : ""}最多 ${limit} 张</span>
        <em data-ap-count>${selected.size}/${limit}</em>
      </div>
      <label class="asset-picker-upload" data-ap-upload-zone>
        ${icon("upload", 18)}
        <span><b>拖入图片或点击上传</b><em>上传后自动加入本次选择</em></span>
        <input type="file" accept="image/*" multiple hidden data-ap-upload />
      </label>
      <div class="asset-picker-grid" data-ap-grid>
        ${assets.length ? assets.map(assetCardHtml).join("") : `<div class="asset-picker-empty" data-ap-empty>${icon("image", 20)}<b>资产库暂无可选图片</b><p>可以直接拖入或点击上传参考图。</p></div>`}
      </div>
    </div>
    <div class="mp-foot">
      <button class="btn ghost" data-close>取消</button>
      <button class="btn primary" data-ap-confirm>${icon("check", 13)} 确认选择</button>
    </div>`;
  openModal(html, {
    wide: true,
    onMount(panel, close) {
      panel.classList.add("asset-picker-panel");
      const sync = () => {
        const count = panel.querySelector("[data-ap-count]");
        if (count) count.textContent = `${selected.size}/${limit}`;
        panel.querySelectorAll("[data-asset-pick]").forEach(btn => btn.classList.toggle("on", selected.has(btn.dataset.assetPick)));
        const grid = panel.querySelector("[data-ap-grid]");
        if (grid && !grid.querySelector("[data-asset-pick]") && !grid.querySelector("[data-ap-empty]")) {
          grid.innerHTML = `<div class="asset-picker-empty" data-ap-empty>${icon("image", 20)}<b>资产库暂无可选图片</b><p>可以直接拖入或点击上传参考图。</p></div>`;
        }
      };
      const addUploadedImages = async files => {
        const remaining = Math.max(0, limit - selected.size);
        const images = Array.from(files || []).filter(file => file?.type?.startsWith("image/")).slice(0, remaining);
        if (!images.length) {
          toast(remaining ? "请选择图片文件" : `最多选择 ${limit} 张参考图`);
          return;
        }
        const { fileToDataUrl } = await import("../core/util.js");
        const { addAssetFromDataUrl } = await import("../domain/assets.js");
        const grid = panel.querySelector("[data-ap-grid]");
        let added = 0;
        for (const file of images) {
          try {
            const dataUrl = await fileToDataUrl(file);
            const asset = await addAssetFromDataUrl(kind === "custom" ? accountId : null, {
              name: file.name || (kind === "custom" ? "批量定制参考图" : "批量统一参考图"),
              tags: ["参考图", kind === "custom" ? "定制参考" : kind === "cover" ? "视频统一参考" : "统一参考"],
              dataUrl,
              forceNew: kind !== "custom",
            });
            selected.add(asset.id);
            if (grid && !grid.querySelector(`[data-asset-pick="${asset.id}"]`)) {
              grid.querySelector("[data-ap-empty]")?.remove();
              grid.insertAdjacentHTML("afterbegin", assetCardHtml(asset));
            }
            added += 1;
          } catch (error) {
            console.warn("参考图上传失败", error);
          }
        }
        sync();
        toast(added ? `已上传并选中 ${added} 张参考图` : "参考图上传失败，请重试");
      };
      const uploadZone = panel.querySelector("[data-ap-upload-zone]");
      const pickerSurface = panel.querySelector(".asset-picker");
      if (pickerSurface) wireDropZone(pickerSurface, addUploadedImages, { filesOnly: true });
      if (uploadZone) wireDropZone(uploadZone, addUploadedImages, { filesOnly: true });
      panel.querySelector("[data-ap-upload]")?.addEventListener("change", event => {
        addUploadedImages(event.target.files);
        event.target.value = "";
      });
      panel.addEventListener("click", e => {
        const del = e.target.closest("[data-asset-del]");
        if (del) {
          e.stopPropagation();
          const id = del.dataset.assetDel;
          const asset = state.assets.find(x => x.id === id);
          confirmModal({ title: `删除参考图「${asset?.name || "未命名图片"}」？`, body: "会从整体资产库移除；已经选中的引用也会同步摘掉。", danger: true, okText: "删除" }).then(async ok => {
            if (!ok) return;
            selected.delete(id);
            if (kind === "custom") {
              m.payload.accountRefAssetIds = m.payload.accountRefAssetIds || {};
              m.payload.accountRefAssetIds[accountId] = (m.payload.accountRefAssetIds[accountId] || []).filter(x => x !== id);
            } else if (kind === "cover") {
              m.payload.coverRefAssetIds = (m.payload.coverRefAssetIds || []).filter(x => x !== id);
            } else {
              m.payload.sharedRefAssetIds = (m.payload.sharedRefAssetIds || []).filter(x => x !== id);
              if (m.payload.sharedRefAssetId === id) m.payload.sharedRefAssetId = m.payload.sharedRefAssetIds[0] || null;
            }
            await removeAsset(id);
            prunePlanReferences(m.payload);
            save("sessions");
            const card = panel.querySelector(`[data-asset-pick="${id}"]`);
            if (card) card.remove();
            sync();
            toast("已删除参考图");
          });
          return;
        }
        const btn = e.target.closest("[data-asset-pick]");
        if (btn) {
          const id = btn.dataset.assetPick;
          if (selected.has(id)) selected.delete(id);
          else {
            if (selected.size >= limit) { toast(`最多选择 ${limit} 张参考图`); return; }
            selected.add(id);
          }
          sync();
          return;
        }
        if (e.target.closest("[data-ap-confirm]")) {
          const ids = [...selected].slice(0, limit);
          if (kind === "custom") {
            m.payload.accountRefAssetIds = m.payload.accountRefAssetIds || {};
            m.payload.accountRefAssetIds[accountId] = ids;
          } else if (kind === "cover") {
            m.payload.coverRefAssetIds = ids;
          } else {
            m.payload.sharedRefAssetIds = ids;
            m.payload.sharedRefAssetId = ids[0] || null;
          }
          prunePlanReferences(m.payload);
          save("sessions");
          rerenderPlanCard(m.id);
          toast(ids.length ? `已选择 ${ids.length} 张参考图` : "已清空参考图选择");
          close();
        }
      });
      sync();
    }
  });

}

function openAiTopicPicker(mid) {
  const { msg: m } = findMessageInSessions(mid);
  if (!m || m.payload.status !== "pending") return;
  const accounts = (m.payload.accountIds || [])
    .map(id => state.accounts.find(account => account.id === id))
    .filter(Boolean);
  if (!accounts.length) {
    toast("请先选择要填写的账号");
    return;
  }
  const initialQuery = String(m.payload.content || m.payload.topic || "").trim();
  let preview = null;
  openModal(`<div class="mp-head"><div><b>百度搜索 AI 选题</b><em>搜索事实来源，预览后只填所选账号的空白标题和文案</em></div><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
    <div class="mp-body agc-ai-topic-modal">
      <div class="agc-ai-topic-query">
        <label><span>选题方向</span><input class="input" id="agcAiTopicQuery" maxlength="300" value="${esc(initialQuery)}" placeholder="例如：AI 视频生成行业最新动态" /></label>
        <div class="agc-ai-topic-recency" role="group" aria-label="搜索时间范围">
          <button class="is-active" type="button" data-ai-recency="week">近一周</button>
          <button type="button" data-ai-recency="month">近一月</button>
        </div>
        <button class="btn primary" id="agcAiTopicGenerate" type="button">${icon("search", 14)} 搜索并生成预览</button>
      </div>
      <div class="agc-ai-topic-note">已选择 ${accounts.length} 个账号。生成内容会遵守小红书标题 20 字/正文 1000 字，以及视频号标题 16 字且无标点的规则。</div>
      <div class="agc-ai-topic-preview" id="agcAiTopicPreview"><p>输入方向后生成预览；这里不会直接覆盖任务板已有内容。</p></div>
    </div>
    <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="agcAiTopicApply" disabled>填入空白行</button></div>`, {
    wide: true,
    onMount(panel, close) {
      panel.classList.add("agc-ai-topic-panel");
      const queryInput = $("#agcAiTopicQuery", panel);
      const generateButton = $("#agcAiTopicGenerate", panel);
      const applyButton = $("#agcAiTopicApply", panel);
      const previewNode = $("#agcAiTopicPreview", panel);
      let recency = "week";
      const sourceMap = () => new Map((preview?.references || []).map(item => [Number(item.id), item]));
      const renderPreview = () => {
        if (!previewNode || !preview) return;
        const references = sourceMap();
        const items = preview.items || [];
        const previewAccountIds = new Set(items.map(item => String(item.accountId || "")));
        const missingAccounts = accounts.filter(account => !previewAccountIds.has(String(account.id)));
        const invalidItems = items.filter(item => !validatePublishText({ platform: item.platform, title: item.title, copy: item.copy }).ok);
        previewNode.innerHTML = items.map(item => {
          const validation = validatePublishText({ platform: item.platform, title: item.title, copy: item.copy });
          const sources = (item.sourceIds || []).map(id => references.get(Number(id))).filter(Boolean);
          return `<article class="agc-ai-topic-item ${validation.ok ? "" : "is-invalid"}">
            <header><span><b>${esc(item.accountName || "账号")}</b><em>${esc(item.platform || "平台")}</em></span><small>${validation.titleLength}/${item.platform === "视频号" ? 16 : 20} 字</small></header>
            <h4>${esc(item.title || "")}</h4>
            <p>${esc(item.copy || "").replace(/\n/g, "<br>")}</p>
            ${validation.ok ? "" : `<strong>${esc(validation.message)}</strong>`}
            ${sources.length ? `<footer>${sources.map(source => `<a href="${esc(source.url || "#")}" target="_blank" rel="noopener noreferrer">${esc(source.title || "来源")}</a>`).join("")}</footer>` : ""}
          </article>`;
        }).join("") || `<p>本次没有生成可填入的账号内容，请换一个选题方向。</p>`;
        if (missingAccounts.length) {
          previewNode.insertAdjacentHTML("afterbegin", `<p class="is-error">还有 ${missingAccounts.length} 个账号未生成：${esc(missingAccounts.slice(0, 4).map(accountDisplayName).join("、"))}${missingAccounts.length > 4 ? "等" : ""}。请重新生成预览，系统不会只填部分账号。</p>`);
        }
        applyButton.disabled = !items.length || missingAccounts.length > 0 || invalidItems.length > 0;
        applyButton.textContent = missingAccounts.length ? `等待补齐 ${missingAccounts.length} 个账号` : `填入 ${items.length} 个账号的空白行`;
      };
      panel.querySelectorAll("[data-ai-recency]").forEach(button => button.addEventListener("click", () => {
        recency = button.dataset.aiRecency === "month" ? "month" : "week";
        panel.querySelectorAll("[data-ai-recency]").forEach(item => item.classList.toggle("is-active", item === button));
      }));
      generateButton?.addEventListener("click", async () => {
        const query = String(queryInput?.value || "").trim();
        if (query.length < 2) {
          toast("请填写至少 2 个字的选题方向");
          queryInput?.focus();
          return;
        }
        generateButton.disabled = true;
        applyButton.disabled = true;
        generateButton.innerHTML = `${icon("loader", 14)} 正在搜索并生成…`;
        previewNode.innerHTML = `<p class="is-loading">正在读取百度搜索结果，并为全部所选账号生成候选内容…</p>`;
        try {
          const payloadAccounts = accounts.map(account => {
            const productId = (m.payload.accountProductIds || {})[account.id] || m.payload.productId || "";
            const product = state.products.find(item => item.id === productId);
            return {
              id: account.id,
              name: accountDisplayName(account),
              platform: account.platform || (account.mode === "图文" ? "小红书" : "视频号"),
              product: product?.name || "",
            };
          });
          const requestId = `batch-topic-${mid}-${Date.now().toString(36)}`;
          preview = await qianfanTopicIdeas({ query, recency, accounts: payloadAccounts }, requestId);
          renderPreview();
        } catch (error) {
          preview = null;
          previewNode.innerHTML = `<p class="is-error">${esc(error?.message || "AI 选题生成失败，请稍后重试")}</p>`;
          toast(error?.message || "AI 选题生成失败", "error");
        } finally {
          generateButton.disabled = false;
          generateButton.innerHTML = `${icon("search", 14)} 重新生成预览`;
        }
      });
      applyButton?.addEventListener("click", () => {
        if (!preview) return;
        m.payload.accountCopyTitles = m.payload.accountCopyTitles || {};
        m.payload.accountCopyBodies = m.payload.accountCopyBodies || {};
        m.payload.accountSingleImageTitles = m.payload.accountSingleImageTitles || {};
        m.payload.accountCustomCopyModes = m.payload.accountCustomCopyModes || {};
        let filled = 0;
        (preview.items || []).forEach(item => {
          const validation = validatePublishText({ platform: item.platform, title: item.title, copy: item.copy });
          if (!validation.ok || !(m.payload.accountIds || []).includes(item.accountId)) return;
          let changed = false;
          if (!String(m.payload.accountCopyTitles[item.accountId] || "").trim()) {
            m.payload.accountCopyTitles[item.accountId] = item.title;
            changed = true;
          }
          if (!String(m.payload.accountCopyBodies[item.accountId] || "").trim()) {
            m.payload.accountCopyBodies[item.accountId] = item.copy;
            changed = true;
          }
          if ((m.payload.accountImageCreationModes || {})[item.accountId] === "single"
            && !String(m.payload.accountSingleImageTitles[item.accountId] || "").trim()) {
            m.payload.accountSingleImageTitles[item.accountId] = item.title;
            changed = true;
          }
          if (changed) {
            m.payload.accountCustomCopyModes[item.accountId] = true;
            filled += 1;
          }
        });
        save("sessions");
        close();
        rerenderPlanCard(mid);
        toast(filled ? `已填入 ${filled} 个账号的空白内容` : "已有内容均已保留，没有覆盖任何一行");
      });
      requestAnimationFrame(() => queryInput?.focus());
    }
  });
}

function openPlanContentEditor(mid, accountId, kind = "copy") {
  const { msg: m } = findMessageInSessions(mid);
  if (!m || m.payload.status !== "pending" || !accountId) return;
  const accountName = state.accounts.find(account => account.id === accountId)?.name || "当前账号";
  const single = kind === "single";
  const current = single
    ? String((m.payload.accountImagePrompts || {})[accountId] || "")
    : String((m.payload.accountCopyBodies || {})[accountId] || "");
  openModal(`<div class="mp-head"><div><b>${single ? "填写单图提示词" : "填写发布文案"}</b><em>${esc(accountName)}</em></div><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
    <div class="mp-body agc-copy-editor-modal">
      <label><span>${single ? "图片提示词（必填）" : "发布正文（可留空，由标题自动生成）"}</span>
        <textarea class="input" id="agcPlanContent" rows="12" maxlength="6000" placeholder="${single ? "完整描述这一张图片的主体、动作、场景、构图和需要出现的文字；账号风格只控制视觉。" : "直接填写最终发布正文；标签可保留，标签不会进入图片提示词。"}">${esc(current)}</textarea>
      </label>
    </div>
    <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="agcPlanContentSave">保存</button></div>`, {
    onMount(panel, close) {
      const input = $("#agcPlanContent", panel);
      requestAnimationFrame(() => input?.focus());
      $("#agcPlanContentSave", panel)?.addEventListener("click", () => {
        const value = input?.value.trim() || "";
        if (single && !value) {
          toast("单图模式必须填写图片提示词");
          input?.focus();
          return;
        }
        if (single) {
          m.payload.accountImagePrompts = m.payload.accountImagePrompts || {};
          m.payload.accountImagePrompts[accountId] = value;
        } else {
          m.payload.accountCopyBodies = m.payload.accountCopyBodies || {};
          m.payload.accountCopyBodies[accountId] = value;
        }
        save("sessions");
        close();
        rerenderPlanCard(mid);
      });
    }
  });
}

function openBatchImageEditor(p, imageIndex) {
  const index = Number(imageIndex);
  const item = p?.artifacts?.images?.items?.[index];
  if (!item) return;
  const imageUrl = item.assetId ? urlFor(item.assetId) : "";
  openModal(`<div class="mp-head"><b>编辑第 ${index + 1} 张提示词</b><button class="icon-btn" data-close>${icon("x", 15)}</button></div>
    <div class="mp-body batch-image-editor">
      ${imageUrl ? `<img src="${esc(imageUrl)}" alt="第 ${index + 1} 张当前图片"/>` : ""}
      <label class="field"><span>图片提示词</span><textarea class="input" id="batchImagePrompt" rows="9" placeholder="写清楚主体、构图、风格和画面文字">${esc(item.prompt || "")}</textarea></label>
      ${item.error ? `<p class="sc-error">${esc(item.error)}</p>` : ""}
    </div>
    <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="batchImageRegenerate">${icon("refresh", 13)} 保存并重新生成</button></div>`, {
    wide: true,
    onMount(panel, close) {
      panel.querySelector("#batchImageRegenerate")?.addEventListener("click", async e => {
        const prompt = panel.querySelector("#batchImagePrompt")?.value.trim() || "";
        if (!prompt) { toast("请先填写图片提示词", "error"); return; }
        item.prompt = prompt;
        save("productions");
        const button = e.currentTarget;
        button.disabled = true;
        button.textContent = "重新生成中…";
        try {
          await regenerateBatchImage(p, index);
          close();
          toast(`第 ${index + 1} 张已重新生成`);
          refreshLiveCards();
          renderBoard();
        } catch (err) {
          button.disabled = false;
          button.innerHTML = `${icon("refresh", 13)} 重试生成`;
          toast(err?.message || "重新生成失败", "error");
        }
      });
    }
  });
}

function openBatchVideoCoverEditor(p) {
  const cover = p?.artifacts?.boards?.cover;
  if (!cover) { toast("当前任务还没有封面配置", "error"); return; }
  const imageUrl = cover.assetId ? urlFor(cover.assetId) : "";
  let refIds = [...new Set((cover.refAssetIds || []).filter(Boolean))].slice(0, 8);
  openModal(`<div class="mp-head"><b>微调视频封面</b><button class="icon-btn" data-close>${icon("x", 15)}</button></div>
    <div class="mp-body batch-image-editor">
      ${imageUrl ? `<img src="${esc(imageUrl)}" alt="当前视频封面"/>` : ""}
      <div class="batch-image-editor-fields">
        <label class="field"><span>封面提示词</span><textarea class="input" id="batchCoverPrompt" rows="9" placeholder="写清楚封面标题、主体、构图和风格；输出固定为 3:4">${esc(cover.prompt || "")}</textarea></label>
        <section class="batch-image-ref-section">
          <div class="batch-image-ref-head"><span>本次封面参考图</span><label class="btn ghost sm">${icon("plus", 12)} 拖拽 / 增加<input id="batchCoverRefAdd" type="file" accept="image/*" multiple hidden></label></div>
          <p class="muted">可删除旧参考图或拖入新图；修改只作用于这张封面。</p>
          <div class="batch-image-ref-list" id="batchCoverRefList"></div>
        </section>
      </div>
      ${cover.error ? `<p class="sc-error">${esc(cover.error)}</p>` : ""}
    </div>
    <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="batchCoverRegenerate">${icon("refresh", 13)} 保存并重新生成</button></div>`, {
    wide: true,
    onMount(panel, close) {
      const refList = panel.querySelector("#batchCoverRefList");
      const addFiles = async files => {
        const images = Array.from(files || []).filter(file => file?.type?.startsWith("image/")).slice(0, Math.max(0, 8 - refIds.length));
        for (const file of images) {
          const asset = await addAssetFromFile(p.accountId, file, { tags: ["参考图", "视频封面微调"], name: file.name.replace(/\.[^.]+$/, "") });
          refIds.push(asset.id);
        }
        refIds = [...new Set(refIds)].slice(0, 8);
        drawRefs();
      };
      const drawRefs = () => {
        refList.innerHTML = refIds.length ? refIds.map((id, index) => {
          const asset = state.assets.find(item => item.id === id);
          const src = asset ? urlFor(asset) : "";
          return `<article class="batch-image-ref-card">
            ${src ? `<img src="${esc(src)}" alt="${esc(asset?.name || `参考图 ${index + 1}`)}">` : `<span class="muted">参考图不可用</span>`}
            <div><b>${esc(asset?.name || `参考图 ${index + 1}`)}</b><span><button class="link-btn danger" type="button" data-cover-ref-remove="${index}">${icon("trash", 11)} 取消参考</button></span></div>
          </article>`;
        }).join("") : `<div class="batch-image-ref-empty">未使用参考图，可拖入图片后再生成。</div>`;
        panel.querySelectorAll("[data-cover-ref-remove]").forEach(button => button.addEventListener("click", () => {
          refIds.splice(Number(button.dataset.coverRefRemove), 1);
          drawRefs();
        }));
      };
      drawRefs();
      panel.querySelector("#batchCoverRefAdd")?.addEventListener("change", event => addFiles(event.currentTarget.files));
      const dropTarget = panel.querySelector(".batch-image-ref-section");
      ["dragenter", "dragover"].forEach(name => dropTarget?.addEventListener(name, event => {
        event.preventDefault();
        dropTarget.classList.add("drag-over");
      }));
      ["dragleave", "drop"].forEach(name => dropTarget?.addEventListener(name, event => {
        event.preventDefault();
        dropTarget.classList.remove("drag-over");
      }));
      dropTarget?.addEventListener("drop", event => addFiles(event.dataTransfer?.files));
      panel.querySelector("#batchCoverRegenerate")?.addEventListener("click", async event => {
        const prompt = panel.querySelector("#batchCoverPrompt")?.value.trim() || "";
        if (!prompt) { toast("请先填写封面提示词", "error"); return; }
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = "重新生成中…";
        try {
          await regenerateBatchVideoCover(p, prompt, refIds);
          close();
          toast("视频封面已重新生成");
          refreshLiveCards();
          renderBoard();
        } catch (err) {
          button.disabled = false;
          button.innerHTML = `${icon("refresh", 13)} 重试生成`;
          toast(err?.message || "封面重新生成失败", "error");
        }
      });
    }
  });
}

async function setPlanCustomRefs(mid, accountId, files) {
  const { msg: m } = findMessageInSessions(mid);
  if (!m || m.payload.status !== "pending" || !accountId) return;
  const oldMap = m.payload.accountRefAssetIds || {};
  const oldIds = Array.isArray(oldMap[accountId]) ? oldMap[accountId] : [];
  const remaining = Math.max(0, 3 - oldIds.length);
  const imgs = Array.from(files || []).filter(f => f?.type?.startsWith("image/")).slice(0, remaining);
  if (!imgs.length) { toast("该账号定制参考图最多 3 张"); return; }
  const { fileToDataUrl } = await import("../core/util.js");
  const { addAssetFromDataUrl } = await import("../domain/assets.js");
  const newIds = [];
  for (const file of imgs) {
    const dataUrl = await fileToDataUrl(file);
    const a = await addAssetFromDataUrl(accountId, { name: file.name || "批量定制参考图", tags: ["参考图", "定制参考"], dataUrl });
    newIds.push(a.id);
  }
  m.payload.accountRefAssetIds = { ...oldMap, [accountId]: [...new Set([...oldIds, ...newIds])].slice(0, 3) };
  prunePlanReferences(m.payload);
  save("sessions");
  rerenderPlanCard(m.id);
  toast(`已为该账号追加 ${newIds.length} 张定制参考图`);
}

function wireDrops() {
  // 计划卡统一参考图：支持拖入
  $$("#agwMsgs [data-plan-refdrop]").forEach(z => {
    if (z.dataset.wired) return;
    z.dataset.wired = "1";
    wireDropZone(z, files => setPlanRefs(z.dataset.planRefdrop, Array.from(files).filter(f => f.type.startsWith("image/"))), { filesOnly: true });
    z.addEventListener("click", e => {
      if (e.target.closest("button, .ref-chip")) return;
      z.querySelector("[data-plan-ref]")?.click();
    });
  });
  // 计划卡统一视频参考图：供视频封面、信息流 B 面分镜和功能演示共同参考
  $$("#agwMsgs [data-plan-cover-refdrop]").forEach(z => {
    if (z.dataset.wired) return;
    z.dataset.wired = "1";
    wireDropZone(z, files => setPlanRefs(z.dataset.planCoverRefdrop, Array.from(files).filter(f => f.type.startsWith("image/")), "cover"), { filesOnly: true });
    z.addEventListener("click", e => {
      if (e.target.closest("button, .ref-chip")) return;
      z.querySelector("[data-plan-cover-ref]")?.click();
    });
  });
  // 计划卡单账号定制参考图：支持拖入，不影响统一参考图
  $$("#agwMsgs [data-plan-custom-refdrop]").forEach(z => {
    if (z.dataset.wired) return;
    z.dataset.wired = "1";
    wireDropZone(z, files => setPlanCustomRefs(z.dataset.planCustomRefdrop, z.dataset.refAccount, Array.from(files).filter(f => f.type.startsWith("image/"))), { filesOnly: true });
  });
}
