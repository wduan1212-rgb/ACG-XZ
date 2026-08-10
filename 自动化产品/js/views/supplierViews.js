import { $, $$, copyText, esc, timeAgo } from "../core/util.js";
import { icon, agentAvatar } from "../ui/icons.js";
import { state, save, refreshRemoteCollections, refreshDeliveryMetrics } from "../core/store.js";
import { emptyState, openModal, confirmModal, promptModal, toast } from "../ui/components.js?v=20260810-v1420-generation-resilience-1";
import * as remote from "../core/remote.js";
import { urlFor } from "../domain/assets.js";
import { deliveryViewsSummary } from "../domain/delivery.js?v=20260810-v1420-generation-resilience-1";
import { accountDisplaySequenceMap, isAccountDisabled, isNewAccount } from "../domain/accounts.js";
import { openAccountDialog } from "./accountDialog.js";

const accountAvatar = acc => {
  const avatar = acc?.avatarUrl || (acc?.avatarAssetId ? urlFor(acc.avatarAssetId) : "");
  return avatar
    ? `<img src="${esc(avatar)}" alt=""/>`
    : `<span class="supplier-avatar-fallback">${icon("user", 18)}</span>`;
};
let supplierPlatform = "all";
let supplierActivityType = "all";
let supplierActivityDays = "all";
let supplierActivityCarouselPage = 0;
let supplierActivityCarouselTimer = 0;
let supplierViewsPlatform = "all";
let supplierTrendWindow = { kind: "days", days: 7, start: "", end: "" };
let supplierAssistantPending = false;
let supplierAccountFilterQuery = "";
let activeSupplierAccountController = null;
let activeSupplierOverviewController = null;
let activeSupplierSettingsController = null;
let supplierAuthorityRefreshPromise = null;
let supplierAuthorityRefreshedAt = 0;
const SUPPLIER_ACTIVITY_PAGE_SIZE = 4;
const SUPPLIER_AUTHORITY_POLL_MS = 15000;
const SUPPLIER_ASSISTANT_HISTORY_PREFIX = "xingzhen:supplier-data-assistant:";
const onSupplierRoute = zone => document.body.dataset.zone === zone;
const SUPPLIER_AUTHORITY_ROLES = new Set(["supplier", "supplier_parent", "supplier_child"]);

async function refreshSupplierAuthorityState({ force = false, showError = false } = {}) {
  if (!SUPPLIER_AUTHORITY_ROLES.has(state.role) || !remote.isOn() || !remote.hasToken()) return false;
  if (supplierAuthorityRefreshPromise) return supplierAuthorityRefreshPromise;
  if (!force && Date.now() - supplierAuthorityRefreshedAt < 5000) return false;
  supplierAuthorityRefreshPromise = refreshRemoteCollections(["assets", "accounts"])
    .then(async collectionRefreshed => {
      // 资产快照可能比专用指标投影更早生成。始终最后应用服务端权威指标，
      // 避免并发请求完成顺序不同导致父/子账号短暂看到旧播放量或曝光量。
      const metricRefreshed = await refreshDeliveryMetrics({ force: true });
      if (!collectionRefreshed && !metricRefreshed?.refreshed) return false;
      supplierAuthorityRefreshedAt = Date.now();
      activeSupplierOverviewController?.syncAuthority?.();
      activeSupplierAccountController?.syncAuthority?.();
      if (typeof window.CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("xingzhen:supplier-authority-refreshed"));
      }
      return true;
    })
    .catch(error => {
      if (showError) toast(`播放与曝光数据刷新失败：${error?.message || error}`, "error");
      throw error;
    })
    .finally(() => { supplierAuthorityRefreshPromise = null; });
  return supplierAuthorityRefreshPromise;
}

function emitSupplierChildren(children = [], bindings = []) {
  if (typeof window === "undefined" || typeof window.CustomEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("xingzhen:supplier-children", {
    detail: { children, bindings },
  }));
}

if (typeof document !== "undefined") {
  document.addEventListener("xingzhen:supplier-account-query", event => {
    supplierAccountFilterQuery = String(event.detail?.query || "").trim().toLowerCase();
    if (event.detail?.resetPlatform) supplierPlatform = "all";
    activeSupplierAccountController?.applyFilters?.();
    activeSupplierAccountController?.focusAccount?.(event.detail?.accountId);
  });
  document.addEventListener("xingzhen:supplier-create-children", () => {
    const controller = onSupplierRoute("settings")
      ? activeSupplierSettingsController
      : activeSupplierOverviewController;
    createChildrenDialog(() => controller?.refresh?.());
  });
  window.addEventListener("focus", () => {
    if (!SUPPLIER_AUTHORITY_ROLES.has(state.role)) return;
    if (!["overview", "assets", "settings"].includes(document.body.dataset.zone)) return;
    void refreshSupplierAuthorityState({ showError: true }).catch(() => null);
  });
  window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!SUPPLIER_AUTHORITY_ROLES.has(state.role)) return;
    if (!["overview", "assets", "settings"].includes(document.body.dataset.zone)) return;
    void refreshSupplierAuthorityState().catch(() => null);
  }, SUPPLIER_AUTHORITY_POLL_MS);
}

function clearSupplierActivityCarousel() {
  if (supplierActivityCarouselTimer) window.clearTimeout(supplierActivityCarouselTimer);
  supplierActivityCarouselTimer = 0;
}

function supplierActivityItemsHtml(items = []) {
  return items.length
    ? items.map((item, index) => `<article class="supplier-log" style="--supplier-activity-index:${index}"><i></i><span><b>${esc(item.memberName || "成员")}</b><em>${esc(item.detail || item.action || "更新了发布内容")}</em></span><time>${timeAgo(item.createdAt)}</time></article>`).join("")
    : `<p class="supplier-activity-empty">当前筛选下暂无操作</p>`;
}

function updateSupplierActivityCarousel(root, activity, pageCount, { animate = false } = {}) {
  const carousel = $("#supplierActivityCarousel", root);
  if (!carousel) return;
  const replace = () => {
    const page = $("#supplierActivityPage", root);
    if (!carousel.isConnected || !page) return;
    const start = supplierActivityCarouselPage * SUPPLIER_ACTIVITY_PAGE_SIZE;
    carousel.innerHTML = supplierActivityItemsHtml(activity.slice(start, start + SUPPLIER_ACTIVITY_PAGE_SIZE));
    page.textContent = activity.length ? `${supplierActivityCarouselPage + 1} / ${pageCount}` : "0 / 0";
    $$('[data-supplier-activity-page]', root).forEach(button => { button.disabled = pageCount <= 1; });
    carousel.classList.remove("is-leaving");
    if (!animate || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    carousel.classList.add("is-entering");
    window.setTimeout(() => carousel.classList.remove("is-entering"), 310);
  };
  if (!animate || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    replace();
    return;
  }
  carousel.classList.remove("is-entering");
  carousel.classList.add("is-leaving");
  window.setTimeout(replace, 230);
}

function scheduleSupplierActivityCarousel(root, activity, pageCount) {
  clearSupplierActivityCarousel();
  if (pageCount <= 1) return;
  supplierActivityCarouselTimer = window.setTimeout(() => {
    if (!onSupplierRoute("overview") || !root.isConnected) return;
    supplierActivityCarouselPage = (supplierActivityCarouselPage + 1) % pageCount;
    updateSupplierActivityCarousel(root, activity, pageCount, { animate: true });
    scheduleSupplierActivityCarousel(root, activity, pageCount);
  }, 3000);
}

function supplierActivityKind(item = {}) {
  const text = `${item.action || ""} ${item.detail || ""}`;
  if (/观看量|播放量|浏览量|曝光量|观看|播放|曝光/.test(text)) return "views";
  if (/回传|发布链接|链接/.test(text)) return "link";
  if (/下载|领取素材|领取内容/.test(text)) return "download";
  return "other";
}

function supplierActivityTimestamp(item = {}) {
  if (typeof item.createdAt === "number") return item.createdAt;
  return Date.parse(item.createdAt || "") || 0;
}

function supplierLinkHtml(value = "") {
  const source = String(value || "");
  const urlPattern = /https?:\/\/[^\s<>“”"']+/gi;
  let cursor = 0;
  let html = "";
  for (const match of source.matchAll(urlPattern)) {
    const start = match.index || 0;
    html += esc(source.slice(cursor, start)).replace(/\n/g, "<br/>");
    let url = match[0];
    const trailing = url.match(/[，。！？；：,!?;:)”》」]+$/)?.[0] || "";
    if (trailing) url = url.slice(0, -trailing.length);
    html += `<span class="supplier-data-link-wrap"><a class="supplier-data-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a><button class="supplier-data-copy" type="button" data-copy-supplier-link="${esc(url)}" title="复制链接">${icon("copy", 12)}<span>复制</span></button></span>${esc(trailing)}`;
    cursor = start + match[0].length;
  }
  return html + esc(source.slice(cursor)).replace(/\n/g, "<br/>");
}

function supplierAssistantHistoryKey() {
  return `${SUPPLIER_ASSISTANT_HISTORY_PREFIX}${String(state.ui.currentMemberId || "anonymous")}`;
}

function loadSupplierAssistantHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(supplierAssistantHistoryKey()) || "[]");
    return Array.isArray(saved)
      ? saved.filter(item => item && ["user", "agent"].includes(item.role) && typeof item.content === "string").slice(-40)
      : [];
  } catch (_) {
    return [];
  }
}

function saveSupplierAssistantHistory(history) {
  try {
    localStorage.setItem(supplierAssistantHistoryKey(), JSON.stringify(history.slice(-40)));
  } catch (_) {
    // 私密模式或存储空间不足时，问答仍可在本次页面中正常使用。
  }
}

function supplierAssistantMessagesHtml(history = []) {
  const messages = history.length ? history : [{ role: "agent", content: "你好，我是数据助手。可以查询交付、回传链接、下载记录、账号排行和播放量。" }];
  return messages.map(message => `<div class="supplier-data-bubble ${message.role}">${message.role === "agent" ? supplierLinkHtml(message.content) : esc(message.content)}</div>`).join("");
}

function supplierDeliveryTime(asset = {}) {
  return Number(asset.publishedUpdatedAt || asset.publishedAt || asset.returnedAt || asset.deliveredAt || asset.createdAt || 0);
}

function supplierDateKey(timestamp) {
  const date = new Date(Number(timestamp || 0));
  if (!Number.isFinite(date.getTime())) return "";
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function supplierOverviewRows() {
  return state.assets.filter(asset => asset?.delivered).map(asset => ({
    asset,
    account: state.accounts.find(item => item.id === asset.accountId) || {},
    timestamp: supplierDeliveryTime(asset),
  })).sort((a, b) => b.timestamp - a.timestamp || String(b.asset.id || "").localeCompare(String(a.asset.id || "")));
}

function supplierTodayLinkLines(rows) {
  const today = supplierDateKey(Date.now());
  const accountNumbers = accountDisplaySequenceMap(state.accounts);
  return rows.filter(item => item.asset.publishedUrl && supplierDateKey(item.timestamp) === today)
    .map((item, index) => {
      const accountNumber = accountNumbers.get(item.account.id);
      const marker = accountNumber ? `#${String(accountNumber).padStart(2, "0")}` : `#${String(index + 1).padStart(2, "0")}`;
      return `${marker} ${item.account.name || item.asset.title || "未命名账号"}：${item.asset.publishedUrl}`;
    });
}

function supplierTodayLinksAnswer(rows) {
  const lines = supplierTodayLinkLines(rows);
  return lines.length ? `今日已回传链接 ${lines.length} 条：\n${lines.join("\n")}` : "今天还没有供应商账号回传链接。";
}

function smoothTrendPath(points = []) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const midX = (previous.x + point.x) / 2;
    return `${path} C ${midX} ${previous.y}, ${midX} ${point.y}, ${point.x} ${point.y}`;
  }, `M ${points[0].x} ${points[0].y}`);
}

function supplierTrendModel(rows = []) {
  // “已发布”在供应商端只有一个口径：供应商已经回传有效链接。
  // 不能把仅完成交付、仍待回传的内容混入折线。
  const publishedRows = rows.filter(item => Boolean(item?.asset?.publishedUrl));
  const trendEnd = new Date();
  trendEnd.setHours(0, 0, 0, 0);
  const customTrendStart = supplierTrendWindow.start ? new Date(`${supplierTrendWindow.start}T00:00:00`) : null;
  const customTrendEnd = supplierTrendWindow.end ? new Date(`${supplierTrendWindow.end}T00:00:00`) : null;
  const trendStart = supplierTrendWindow.kind === "custom" && customTrendStart && customTrendEnd && customTrendStart <= customTrendEnd
    ? customTrendStart
    : new Date(trendEnd.getTime() - ((supplierTrendWindow.days || 7) - 1) * 864e5);
  const trendDayCount = Math.max(1, Math.round((trendEnd - trendStart) / 864e5) + 1);
  const days = Array.from({ length: trendDayCount }, (_, offset) => {
    const date = new Date(trendStart.getTime() + offset * 864e5);
    const key = supplierDateKey(date.getTime());
    const items = publishedRows.filter(item => supplierDateKey(item.timestamp) === key);
    return { key, label: `${date.getMonth() + 1}/${date.getDate()}`, count: items.length, items };
  });
  const maxDaily = Math.max(1, ...days.map(item => item.count));
  const points = days.map((item, index) => ({
    x: 8 + index * (84 / Math.max(1, days.length - 1)),
    y: 88 - item.count / maxDaily * 68,
  }));
  const path = smoothTrendPath(points);
  return { days, points, path, areaPath: `${path} L ${points.at(-1).x} 88 L ${points[0].x} 88 Z` };
}

function supplierTrendCardContent(model) {
  const { days, points, path, areaPath } = model;
  const title = supplierTrendWindow.kind === "custom" ? "自定义时间已发布" : `近 ${supplierTrendWindow.days} 日已发布`;
  return `<header><span class="supplier-chart-title">${title}</span><span class="supplier-trend-actions"><button type="button" data-supplier-trend-window="7">7日</button><button type="button" data-supplier-trend-window="30">30日</button><button type="button" data-supplier-trend-window="custom">自定义</button></span></header><div class="supplier-trend-scroll"><div class="supplier-trend-canvas" style="--supplier-trend-points:${days.length}"><div class="supplier-trend-plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="供应商回传链接趋势"><defs><linearGradient id="supplierTrendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ef476f" stop-opacity=".34"/><stop offset="1" stop-color="#ef476f" stop-opacity="0"/></linearGradient></defs><path d="${areaPath}" fill="url(#supplierTrendFill)"/><path d="${path}" fill="none" stroke="#e83e62" stroke-width="2.2" vector-effect="non-scaling-stroke"/></svg>${points.map((point, index) => `<span class="supplier-trend-node" style="--x:${point.x}%;--y:${point.y}%" data-supplier-trend-date="${esc(days[index].key)}" tabindex="0" role="button" aria-label="${esc(`${days[index].label} 共 ${days[index].count} 条已回传链接，查看明细`)}"><i>${days[index].count} 条已发布</i></span>`).join("")}</div><span class="supplier-trend-labels">${days.map((item, index) => `<i style="--x:${points[index].x}%"><b>${item.count}</b><em>${item.label}</em></i>`).join("")}</span></div></div>`;
}

async function supplierData(includeMembers = false, includeActivity = true) {
  // 子账号和绑定关系是供应商首页/账号页的核心读模型；活动日志只是
  // 首页的增强信息。不要让一个旧服务端暂时缺少 activity 路由时把
  // “全部账号”也一起拖在读取态。remote 层仍会在 9 秒内确定超时收尾。
  const activityPromise = includeActivity
    ? remote.supplier.activity().catch(error => {
        console.warn("[supplier-activity] optional feed unavailable", error);
        return [];
      })
    : Promise.resolve([]);
  const [members, children, bindings, activity] = await Promise.all([
    includeMembers ? remote.supplier.members() : Promise.resolve([]),
    remote.supplier.children(),
    remote.supplier.bindings(),
    activityPromise,
  ]);
  return { members: members || [], children: children || [], bindings: bindings || [], activity: activity || [] };
}

export async function renderSupplierOverview(root) {
  clearSupplierActivityCarousel();
  root.innerHTML = `<div class="supplier-shell"><div class="supplier-loading">正在读取...</div></div>`;
  try {
    const [{ children, bindings, activity }] = await Promise.all([
      supplierData(),
      refreshSupplierAuthorityState({ force: true, showError: true }),
    ]);
    if (!onSupplierRoute("overview")) return;
    emitSupplierChildren(children, bindings);
    const rows = supplierOverviewRows();
    const delivered = rows.map(item => item.asset);
    const publishedRows = rows.filter(item => item.asset.publishedUrl);
    const published = publishedRows.map(item => item.asset);
    const views = deliveryViewsSummary(supplierViewsPlatform);
    const platformCounts = new Map();
    publishedRows.forEach(item => {
      const platform = item.account.platform || "其他";
      platformCounts.set(platform, (platformCounts.get(platform) || 0) + 1);
    });
    const xhsCount = platformCounts.get("小红书") || 0;
    const sphCount = platformCounts.get("视频号") || 0;
    const platformTotal = Math.max(1, xhsCount + sphCount);
    let trendModel = supplierTrendModel(publishedRows);
    const activityCutoff = supplierActivityDays === "all" ? 0 : Date.now() - Number(supplierActivityDays) * 86400000;
    const visibleActivity = activity.filter(item => (
      (supplierActivityType === "all" || supplierActivityKind(item) === supplierActivityType)
      && (!activityCutoff || supplierActivityTimestamp(item) >= activityCutoff)
    ));
    const activityPages = Math.max(1, Math.ceil(visibleActivity.length / SUPPLIER_ACTIVITY_PAGE_SIZE));
    supplierActivityCarouselPage = Math.min(Math.max(0, supplierActivityCarouselPage), activityPages - 1);
    const carouselActivity = visibleActivity.slice(
      supplierActivityCarouselPage * SUPPLIER_ACTIVITY_PAGE_SIZE,
      supplierActivityCarouselPage * SUPPLIER_ACTIVITY_PAGE_SIZE + SUPPLIER_ACTIVITY_PAGE_SIZE
    );
    const assistantHistory = loadSupplierAssistantHistory();
    root.innerHTML = `<div class="supplier-shell">
      <div class="supplier-dashboard-grid">
        <div class="supplier-dashboard-main">
          <div class="supplier-dashboard-stats">
            <button class="is-accent" data-supplier-detail="published"><span>已发布</span><b>${published.length}</b><em>以回传链接为准</em></button>
            <button data-supplier-detail="delivery"><span>全部交付</span><b>${delivered.length}</b><em>${Math.max(0, delivered.length - published.length)} 条待回传</em></button>
            <button data-supplier-detail="views"><span>总播放量</span><b id="supplierViewsTotal">${Number(views.totalViews || 0).toLocaleString("zh-CN")}</b><em>${esc(supplierViewsPlatform === "all" ? "全平台" : supplierViewsPlatform)}</em></button>
          </div>
          <div class="supplier-dashboard-visuals">
            <section class="card supplier-platform-chart" aria-label="平台发布构成，可分别查看小红书与视频号"><span class="supplier-chart-title">平台发布构成</span><span class="supplier-donut"><svg viewBox="0 0 160 160" aria-hidden="true"><circle class="supplier-donut-track" cx="80" cy="80" r="58" pathLength="100"/><circle class="supplier-donut-segment is-xhs" cx="80" cy="80" r="58" pathLength="100" style="--segment:${xhsCount / platformTotal * 100};--offset:0" data-supplier-platform="小红书" tabindex="0" role="button" aria-label="小红书已发布 ${xhsCount} 条，查看明细"><title>小红书 ${xhsCount} 条，点击查看明细</title></circle><circle class="supplier-donut-segment is-video" cx="80" cy="80" r="58" pathLength="100" style="--segment:${sphCount / platformTotal * 100};--offset:${-xhsCount / platformTotal * 100}" data-supplier-platform="视频号" tabindex="0" role="button" aria-label="视频号已发布 ${sphCount} 条，查看明细"><title>视频号 ${sphCount} 条，点击查看明细</title></circle></svg><i data-supplier-donut-total="${published.length}"><b>${published.length}</b><em>已发布</em></i></span><span class="supplier-platform-legend"><button type="button" data-supplier-platform="小红书"><i class="xhs"></i>小红书 ${xhsCount}</button><button type="button" data-supplier-platform="视频号"><i class="sph"></i>视频号 ${sphCount}</button></span></section>
            <section class="card supplier-trend-chart" data-supplier-detail="trend" role="button" tabindex="0">${supplierTrendCardContent(trendModel)}</section>
          </div>
          <section class="card supplier-activity"><div class="card-head supplier-activity-head"><b>最近操作</b>
            ${activity.length ? `<div class="supplier-activity-filters"><label class="select-shell">${icon("filter", 12)}<select id="supplierActivityType"><option value="all">全部操作</option><option value="views" ${supplierActivityType === "views" ? "selected" : ""}>观看 / 曝光</option><option value="link" ${supplierActivityType === "link" ? "selected" : ""}>回传链接</option><option value="download" ${supplierActivityType === "download" ? "selected" : ""}>下载素材</option><option value="other" ${supplierActivityType === "other" ? "selected" : ""}>其他操作</option></select>${icon("chevronDown", 11)}</label><label class="select-shell">${icon("clock", 12)}<select id="supplierActivityDays"><option value="all">全部时间</option><option value="7" ${supplierActivityDays === "7" ? "selected" : ""}>近 7 天</option><option value="30" ${supplierActivityDays === "30" ? "selected" : ""}>近 30 天</option></select>${icon("chevronDown", 11)}</label><button class="btn ghost sm" type="button" id="supplierActivityAll">查看全部</button></div>` : ""}</div>
            ${activity.length ? `<div class="supplier-activity-carousel" id="supplierActivityCarousel">${supplierActivityItemsHtml(carouselActivity)}</div><div class="supplier-activity-pagination"><button class="icon-btn sm" type="button" data-supplier-activity-page="prev" ${activityPages <= 1 ? "disabled" : ""}>${icon("chevronLeft", 13)}</button><span id="supplierActivityPage">${visibleActivity.length ? `${supplierActivityCarouselPage + 1} / ${activityPages}` : "0 / 0"}</span><button class="icon-btn sm" type="button" data-supplier-activity-page="next" ${activityPages <= 1 ? "disabled" : ""}>${icon("chevronRight", 13)}</button></div>` : emptyState("pulse", "暂无操作记录", "子账号下载、回传链接或更新观看量后会显示在这里")}
          </section>
        </div>
        <aside class="card supplier-data-assistant"><header><span class="supplier-data-assistant-icon">${agentAvatar(28)}</span><div><b>数据助手</b></div><span class="supplier-today-link-actions"><button class="btn ghost sm supplier-today-links" id="supplierTodayLinks" type="button">${icon("link", 13)} 今日回传</button><button class="icon-btn sm" id="supplierTodayLinksCopyAll" type="button" title="复制今日全部回传链接" aria-label="复制今日全部回传链接">${icon("copy", 13)}</button></span></header><div class="supplier-data-messages" id="supplierDataMessages" aria-live="polite">${supplierAssistantMessagesHtml(assistantHistory)}</div><div class="supplier-data-suggestions"><button type="button">今天交付多少？</button><button type="button">谁下载过？</button><button type="button">给我回传链接</button></div><form id="supplierDataForm"><input id="supplierDataInput" name="supplierDataQuestion" autocomplete="off" aria-label="向数据助手提问" placeholder="问问数据…"/><button class="icon-btn primary" type="submit" title="发送" aria-label="发送数据问题">${icon("send", 14)}</button></form></aside>
      </div>
    </div>`;
    const openSupplierRows = (title, selectedRows) => {
      const body = selectedRows.map(({ asset, account, timestamp }) => `<div class="supplier-dashboard-detail-row"><span><b>${esc(asset.title || asset.name || "未命名内容")}</b><em>${esc(account.name || "未命名账号")} · ${esc(account.platform || "")}</em></span><time>${timestamp ? new Date(timestamp).toLocaleString("zh-CN", { hour12: false }) : "暂无时间"}</time>${asset.publishedUrl ? `<a href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">打开链接</a>` : `<i>未回传</i>`}</div>`).join("");
      openModal(`<div class="mp-head"><b>${esc(title)} · ${selectedRows.length} 条</b><button class="icon-btn ghost" data-close>${icon("x", 15)}</button></div><div class="supplier-dashboard-detail-list">${body || `<p class="supplier-activity-empty">暂无数据</p>`}</div>`, { wide: true });
    };
    let refreshSupplierTrend = () => renderSupplierOverview(root);
    const openSupplierTrendDetail = (initialStart = trendModel.days[0]?.key || "", initialEnd = trendModel.days.at(-1)?.key || "") => {
      let start = initialStart;
      let end = initialEnd;
      openModal(`<div class="supplier-trend-detail-modal" id="supplierTrendDetailModal"></div>`, { wide: true, onMount(panel, close) {
        const draw = () => {
          const scoped = publishedRows.filter(item => {
            const date = supplierDateKey(item.timestamp);
            return (!start || date >= start) && (!end || date <= end);
          });
          panel.innerHTML = `<div class="mp-head"><b>已发布趋势明细 · ${scoped.length} 条</b><button class="icon-btn ghost" data-close aria-label="关闭">${icon("x", 15)}</button></div><div class="supplier-trend-detail-tools"><label>开始<input type="date" id="supplierTrendStart" value="${esc(start)}"/></label><label>结束<input type="date" id="supplierTrendEnd" value="${esc(end)}"/></label><button class="btn primary sm" type="button" id="supplierTrendApply">应用到图表</button></div><div class="supplier-dashboard-detail-list">${scoped.map(({ asset, account, timestamp }) => `<div class="supplier-dashboard-detail-row"><span><b>${esc(asset.title || asset.name || "未命名内容")}</b><em>${esc(account.name || "未命名账号")} · ${esc(account.platform || "")}</em></span><time>${timestamp ? new Date(timestamp).toLocaleString("zh-CN", { hour12: false }) : "暂无时间"}</time><a href="${esc(asset.publishedUrl)}" target="_blank" rel="noopener noreferrer">打开链接</a></div>`).join("") || `<p class="supplier-activity-empty">该时间范围暂无回传链接</p>`}</div>`;
          $("#supplierTrendStart", panel)?.addEventListener("change", event => { start = event.currentTarget.value; draw(); });
          $("#supplierTrendEnd", panel)?.addEventListener("change", event => { end = event.currentTarget.value; draw(); });
          $("#supplierTrendApply", panel)?.addEventListener("click", () => {
            if (start && end && start > end) { toast("结束日期不能早于开始日期"); return; }
            supplierTrendWindow = { kind: "custom", days: 0, start, end };
            close();
            refreshSupplierTrend();
          });
        };
        draw();
      }});
    };
    const openActivityModal = () => {
      let kind = supplierActivityType;
      let days = supplierActivityDays;
      const filtered = () => {
        const cutoff = days === "all" ? 0 : Date.now() - Number(days) * 86400000;
        return activity.filter(item => (
          (kind === "all" || supplierActivityKind(item) === kind)
          && (!cutoff || supplierActivityTimestamp(item) >= cutoff)
        ));
      };
      openModal(`<div class="supplier-activity-modal" id="supplierActivityModal"></div>`, { wide: true, onMount(panel) {
        const drawModal = () => {
          const rows = filtered();
          panel.innerHTML = `<div class="mp-head"><b>全部最近操作 · ${rows.length} 条</b><button class="icon-btn ghost" data-close>${icon("x", 15)}</button></div><div class="supplier-activity-modal-tools"><label class="select-shell">${icon("filter", 12)}<select id="supplierModalActivityType"><option value="all" ${kind === "all" ? "selected" : ""}>全部操作</option><option value="views" ${kind === "views" ? "selected" : ""}>观看 / 曝光</option><option value="link" ${kind === "link" ? "selected" : ""}>回传链接</option><option value="download" ${kind === "download" ? "selected" : ""}>下载素材</option><option value="other" ${kind === "other" ? "selected" : ""}>其他操作</option></select>${icon("chevronDown", 11)}</label><label class="select-shell">${icon("clock", 12)}<select id="supplierModalActivityDays"><option value="all" ${days === "all" ? "selected" : ""}>全部时间</option><option value="7" ${days === "7" ? "selected" : ""}>近 7 天</option><option value="30" ${days === "30" ? "selected" : ""}>近 30 天</option></select>${icon("chevronDown", 11)}</label></div><div class="supplier-dashboard-detail-list">${rows.map(item => `<article class="supplier-log"><i></i><span><b>${esc(item.memberName || "成员")}</b><em>${esc(item.detail || item.action || "更新了发布内容")}</em></span><time>${supplierActivityTimestamp(item) ? new Date(supplierActivityTimestamp(item)).toLocaleString("zh-CN", { hour12: false }) : "暂无时间"}</time></article>`).join("") || `<p class="supplier-activity-empty">当前筛选下暂无操作</p>`}</div>`;
          $("#supplierModalActivityType", panel)?.addEventListener("change", event => { kind = event.currentTarget.value; drawModal(); });
          $("#supplierModalActivityDays", panel)?.addEventListener("change", event => { days = event.currentTarget.value; drawModal(); });
        };
        drawModal();
      }});
    };
    const wireSupplierTrend = () => {
      const chart = $(".supplier-trend-chart", root);
      if (!chart) return;
      const openChart = event => {
        if (event.target.closest("button, [data-supplier-trend-date]")) return;
        event.preventDefault();
        openSupplierTrendDetail();
      };
      chart.addEventListener("click", openChart);
      chart.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") openChart(event); });
      $$('[data-supplier-trend-window]', chart).forEach(button => button.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        const next = button.dataset.supplierTrendWindow;
        if (next === "custom") return openSupplierTrendDetail(supplierTrendWindow.start || trendModel.days[0]?.key || "", supplierTrendWindow.end || trendModel.days.at(-1)?.key || "");
        supplierTrendWindow = { kind: "days", days: Number(next), start: "", end: "" };
        refreshSupplierTrend();
      }));
      $$('[data-supplier-trend-date]', chart).forEach(target => {
        const open = event => { event.preventDefault(); event.stopPropagation(); openSupplierTrendDetail(target.dataset.supplierTrendDate, target.dataset.supplierTrendDate); };
        target.addEventListener("click", open);
        target.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") open(event); });
      });
    };
    refreshSupplierTrend = () => {
      const chart = $(".supplier-trend-chart", root);
      if (!chart) return;
      trendModel = supplierTrendModel(publishedRows);
      chart.innerHTML = supplierTrendCardContent(trendModel);
      chart.classList.remove("is-trend-switching");
      void chart.offsetWidth;
      chart.classList.add("is-trend-switching");
      wireSupplierTrend();
    };
    $$('[data-supplier-detail]', root).forEach(button => button.addEventListener("click", () => {
      const key = button.dataset.supplierDetail;
      if (key === "published") return openSupplierRows("已回传链接", publishedRows);
      if (key === "delivery") return openSupplierRows("全部交付", rows);
      if (key === "platform") return openSupplierRows("平台发布构成", publishedRows);
      if (key === "trend") return;
      if (key === "views") return openSupplierRows("播放数据内容", rows);
    }));
    const openSupplierPlatform = platform => openSupplierRows(`${platform}已发布`, publishedRows.filter(item => item.account.platform === platform));
    $$('[data-supplier-platform]', root).forEach(target => {
      const open = event => { event.preventDefault(); event.stopPropagation(); openSupplierPlatform(target.dataset.supplierPlatform); };
      target.addEventListener("click", open);
      target.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") open(event); });
      target.addEventListener("pointerenter", () => {
        const count = target.dataset.supplierPlatform === "小红书" ? xhsCount : sphCount;
        const center = $("[data-supplier-donut-total]", root);
        if (center) center.innerHTML = `<b>${count}</b><em>${esc(target.dataset.supplierPlatform)}</em>`;
      });
      target.addEventListener("pointerleave", () => {
        const center = $("[data-supplier-donut-total]", root);
        if (center) center.innerHTML = `<b>${published.length}</b><em>已发布</em>`;
      });
    });
    wireSupplierTrend();
    const sendSupplierQuestion = async question => {
      const q = String(question || "").trim();
      if (!q || supplierAssistantPending) return;
      supplierAssistantPending = true;
      const messages = $("#supplierDataMessages", root);
      const nextHistory = [...assistantHistory, { role: "user", content: q }, { role: "agent", content: "正在读取数据…" }].slice(-40);
      assistantHistory.splice(0, assistantHistory.length, ...nextHistory);
      saveSupplierAssistantHistory(assistantHistory);
      messages.innerHTML = supplierAssistantMessagesHtml(assistantHistory);
      wireSupplierLinkCopies(messages);
      messages.scrollTop = messages.scrollHeight;
      const input = $("#supplierDataInput", root); if (input) input.value = "";
      const submit = $("#supplierDataForm button", root); if (submit) submit.disabled = true;
      try {
        if (!remote.isOn()) throw new Error("数据助手需要连接星阵服务端");
        const response = await remote.supplier.ask(q);
        if (response?.source !== "llm") throw new Error("数据助手没有返回语言模型回答");
        const answer = String(response.answer || "").trim();
        if (!answer) throw new Error("数据助手没有返回语言模型回答");
        assistantHistory[assistantHistory.length - 1].content = answer;
      } catch (_) {
        // 不再用浏览器里的规则统计冒充模型答复；用户应能清楚分辨
        // “M3 的真实回答”与“服务暂时不可用”。
        assistantHistory[assistantHistory.length - 1].content = remote.isOn()
          ? "数据助手暂时无法连接语言模型，请稍后重试。"
          : "当前页面没有连接星阵服务端，暂时无法使用语言模型问答。";
        toast("语言模型暂时不可用，本次未使用本地规则回答", "error");
      } finally {
        supplierAssistantPending = false;
        saveSupplierAssistantHistory(assistantHistory);
        if (messages?.isConnected) {
          messages.innerHTML = supplierAssistantMessagesHtml(assistantHistory);
          wireSupplierLinkCopies(messages);
          messages.scrollTop = messages.scrollHeight;
        }
        if (submit?.isConnected) submit.disabled = false;
      }
    };
    const wireSupplierLinkCopies = scope => $$('[data-copy-supplier-link]', scope).forEach(button => button.addEventListener("click", () => {
      copyText(button.dataset.copySupplierLink || "", "已复制回传链接");
    }));
    wireSupplierLinkCopies(root);
    $("#supplierDataForm", root)?.addEventListener("submit", event => { event.preventDefault(); sendSupplierQuestion($("#supplierDataInput", root)?.value); });
    $("#supplierDataInput", root)?.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      sendSupplierQuestion(event.currentTarget.value);
    });
    $$(".supplier-data-suggestions button", root).forEach(button => button.addEventListener("click", () => sendSupplierQuestion(button.textContent)));
    $("#supplierTodayLinks", root)?.addEventListener("click", () => sendSupplierQuestion("今日回传链接"));
    $("#supplierTodayLinksCopyAll", root)?.addEventListener("click", () => {
      const lines = supplierTodayLinkLines(rows);
      if (!lines.length) { toast("今天还没有可复制的回传链接"); return; }
      copyText(`今日回传链接 ${lines.length} 条：\n${lines.join("\n")}`, "已复制今日全部回传链接");
    });
    $("#supplierActivityType", root)?.addEventListener("change", event => {
      supplierActivityType = event.currentTarget.value;
      supplierActivityCarouselPage = 0;
      renderSupplierOverview(root);
    });
    $("#supplierActivityDays", root)?.addEventListener("change", event => {
      supplierActivityDays = event.currentTarget.value;
      supplierActivityCarouselPage = 0;
      renderSupplierOverview(root);
    });
    $$('[data-supplier-activity-page]', root).forEach(button => button.addEventListener("click", () => {
      if (activityPages <= 1) return;
      const delta = button.dataset.supplierActivityPage === "next" ? 1 : -1;
      supplierActivityCarouselPage = (supplierActivityCarouselPage + delta + activityPages) % activityPages;
      updateSupplierActivityCarousel(root, visibleActivity, activityPages, { animate: true });
      scheduleSupplierActivityCarousel(root, visibleActivity, activityPages);
    }));
    $("#supplierActivityAll", root)?.addEventListener("click", openActivityModal);
    $$('[data-views-platform]', root).forEach(button => button.addEventListener("click", () => {
      const next = button.dataset.viewsPlatform || "all";
      if (next === supplierViewsPlatform) return;
      supplierViewsPlatform = next;
      const nextSummary = deliveryViewsSummary(next);
      const total = $("#supplierViewsTotal", root);
      if (total) total.textContent = Number(nextSummary.totalViews || 0).toLocaleString("zh-CN");
      $$('[data-views-platform]', root).forEach(item => item.classList.toggle("on", item.dataset.viewsPlatform === next));
      const label = total?.nextElementSibling;
      if (label) label.textContent = `总播放量 · ${next === "all" ? "全平台" : next}`;
      total?.animate?.([{ opacity: .35, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
    }));
    activeSupplierOverviewController = {
      root,
      refresh: () => renderSupplierOverview(root),
      syncAuthority: () => {
        const nextSummary = deliveryViewsSummary(supplierViewsPlatform);
        const total = $("#supplierViewsTotal", root);
        if (total) total.textContent = Number(nextSummary.totalViews || 0).toLocaleString("zh-CN");
      },
    };
    scheduleSupplierActivityCarousel(root, visibleActivity, activityPages);
  } catch (e) {
    if (!onSupplierRoute("overview")) return;
    root.innerHTML = `<div class="supplier-shell">${emptyState("x", "供应商数据读取失败", esc(e.message || e))}</div>`;
  }
}

export async function renderSupplierAccounts(root) {
  root.innerHTML = `<div class="supplier-shell"><div class="page-head"><div><div class="eyebrow">全部账号</div><h2>自媒体账号分配看板</h2></div></div><div class="supplier-loading">正在读取...</div></div>`;
  try {
    const [{ children, bindings }] = await Promise.all([
      supplierData(false, false),
      refreshSupplierAuthorityState({ force: true, showError: true }),
    ]);
    if (!onSupplierRoute("assets")) return;
    emitSupplierChildren(children, bindings);
    const childMap = new Map(children.map(x => [x.id, x]));
    const accountSequence = accountDisplaySequenceMap(state.accounts);
    const canEditHomepage = ["supplier", "supplier_parent"].includes(state.role);
    const deliveredAssets = state.assets.filter(asset => asset && (asset.delivered || asset.shared));
    const accountPlatformCounts = state.accounts.reduce((counts, account) => {
      const platform = account.platform || "其他";
      counts.set(platform, (counts.get(platform) || 0) + 1);
      return counts;
    }, new Map());
    const accountPlatformTabs = [
      ["all", "全部账号", state.accounts.length],
      ["小红书", "小红书", accountPlatformCounts.get("小红书") || 0],
      ["视频号", "视频号", accountPlatformCounts.get("视频号") || 0],
    ];
    const accountViewSummary = account => {
      const derived = deliveredAssets
        .filter(asset => asset.accountId === account.id)
        .reduce((sum, asset) => sum + Math.max(0, Number(asset.viewCount || 0)), 0);
      return { derived, total: derived };
    };
    root.innerHTML = `<div class="supplier-shell"><div class="page-head"><div><div class="eyebrow">全部账号</div><h2>自媒体账号分配看板</h2></div>${canEditHomepage ? `<button class="btn primary sm" type="button" data-supplier-create-children>${icon("plus", 13)} 新建子账号</button>` : ""}</div>
      <nav class="supplier-account-platform-tabs" aria-label="按平台筛选账号">${accountPlatformTabs.map(([value, label, count]) => `<button type="button" data-supplier-platform-filter="${esc(value)}" class="${supplierPlatform === value ? "is-active" : ""}" aria-pressed="${supplierPlatform === value ? "true" : "false"}"><span>${esc(label)}</span><em>${count}</em></button>`).join("")}</nav>
      <div class="supplier-account-grid">${state.accounts.map(acc => {
        const binding = bindings.find(x => x.accountId === acc.id);
        const child = binding ? childMap.get(binding.childId) : null;
        const searchable = `${acc.name} ${acc.platform} ${acc.mode}`.toLowerCase();
        const hidden = (
          (supplierPlatform !== "all" && acc.platform !== supplierPlatform)
          || (supplierAccountFilterQuery && !searchable.includes(supplierAccountFilterQuery))
        );
        const sequence = accountSequence.get(acc.id) || 0;
        const disabled = isAccountDisabled(acc);
        const fresh = isNewAccount(acc);
        const viewSummary = accountViewSummary(acc);
        return `<article class="supplier-account${disabled ? " is-disabled" : ""}${fresh ? " is-new-account" : ""}" data-account-id="${esc(acc.id)}" data-account-search="${esc(searchable)}" data-account-platform="${esc(acc.platform || "")}" ${hidden ? "hidden" : ""}><span class="supplier-account-sequence">#${String(sequence).padStart(2, "0")}</span><div class="supplier-account-avatar">${accountAvatar(acc)}</div><div class="supplier-account-copy"><b>${esc(acc.name)} ${fresh ? `<i class="supplier-new-account-badge">新</i>` : ""}</b>${disabled ? `<em class="supplier-account-status"><strong>已停用</strong></em>` : ""}</div><div class="supplier-account-controls">${acc.homepageUrl ? `<a class="supplier-homepage-link" href="${esc(acc.homepageUrl)}" target="_blank" rel="noopener noreferrer">${icon("link", 12)} 主页链接</a>` : ""}<div class="supplier-account-control-row"><div class="supplier-content-account-actions"><span class="supplier-account-total-views" data-supplier-account-views="${esc(acc.id)}" title="由该账号全部交付内容的观看量自动汇总">${icon("pulse", 12)} ${Number(viewSummary.total).toLocaleString("zh-CN")}</span>${canEditHomepage ? `<button class="icon-btn sm" type="button" data-content-account-edit="${esc(acc.id)}" title="编辑账号（含主页链接）">${icon("edit", 13)}</button><button class="icon-btn sm${disabled ? " restore" : " danger"}" type="button" data-content-account-status="${esc(acc.id)}" title="${disabled ? "恢复账号" : "停用账号"}">${icon(disabled ? "unlock" : "lock", 13)}</button>` : ""}</div><label class="supplier-inline-assign"><span>分配给</span><select data-account-assign="${esc(acc.id)}" ${canEditHomepage && !disabled ? "" : "disabled"}><option value="">未分配</option>${children.map(c => `<option value="${esc(c.id)}" ${c.id === child?.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label></div></div></article>`;
      }).join("")}</div><p class="supplier-account-filter-empty" hidden>没有匹配的账号</p></div>`;
    $$('[data-content-account-edit]', root).forEach(button => button.addEventListener("click", () => openAccountDialog(button.dataset.contentAccountEdit)));
    $("[data-supplier-create-children]", root)?.addEventListener("click", () => {
      createChildrenDialog(() => renderSupplierAccounts(root));
    });
    $$('[data-content-account-status]', root).forEach(button => button.addEventListener("click", async () => {
      const account = state.accounts.find(item => item.id === button.dataset.contentAccountStatus);
      if (!account || !canEditHomepage) return;
      const disabled = isAccountDisabled(account);
      if (!disabled && !await confirmModal({
        title: `停用账号「${esc(account.name)}」？`,
        body: "历史素材、任务和发布数据都会保留；批量创作不再显示该账号，之后可随时恢复。",
        okText: "确认停用",
        danger: true,
      })) return;
      const snapshot = JSON.parse(JSON.stringify(account));
      const releaseCollectionSync = remote.isOn()
        ? remote.holdCollectionSync(["accounts"])
        : null;
      const nextStatus = disabled ? "active" : "disabled";
      const idleMarkup = button.innerHTML;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.innerHTML = `<span class="spin-dot" aria-label="${disabled ? "正在恢复" : "正在停用"}"></span>`;
      try {
        const payload = { ...account, status: nextStatus };
        if (nextStatus === "active") delete payload.disabledAt;
        else payload.disabledAt = Date.now();
        const result = await remote.supplier.updateAccount(account.id, payload, []);
        Object.assign(account, result.account || payload);
        account.status = nextStatus;
        if (nextStatus === "active") delete account.disabledAt;
        else account.disabledAt = Number(account.disabledAt || payload.disabledAt || Date.now());
        if (nextStatus === "disabled" && state.ui.activeAccountId === account.id) {
          state.ui.activeAccountId = state.accounts.find(item => item.id !== account.id && !isAccountDisabled(item))?.id || null;
          state.ui.activeProductionId = null;
          save("meta");
        }
        save("accounts");
        releaseCollectionSync?.({ flush: false });
        toast(disabled ? "账号已恢复" : "账号已停用");
        await renderSupplierAccounts(root);
      } catch (error) {
        releaseCollectionSync?.({ flush: false });
        Object.keys(account).forEach(key => delete account[key]);
        Object.assign(account, snapshot);
        save("accounts");
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.innerHTML = idleMarkup;
        toast(error?.message || "账号状态更新失败", "error");
      }
    }));
    const applyAccountFilters = ({ animate = false } = {}) => {
      const cards = $$(".supplier-account", root);
      const list = $(".supplier-account-grid", root);
      const before = new Map(cards.filter(card => !card.hidden).map(card => [card, card.getBoundingClientRect()]));
      cards.forEach(card => {
        card.hidden = (
          (supplierPlatform !== "all" && card.dataset.accountPlatform !== supplierPlatform)
          || (supplierAccountFilterQuery && !card.dataset.accountSearch.includes(supplierAccountFilterQuery))
        );
      });
      const empty = $(".supplier-account-filter-empty", root);
      if (empty) empty.hidden = cards.some(card => !card.hidden);
      $$('[data-top-supplier-platform]').forEach(button => button.classList.toggle("is-active", button.dataset.topSupplierPlatform === supplierPlatform));
      $$('[data-supplier-platform-filter]', root).forEach(button => {
        const active = button.dataset.supplierPlatformFilter === supplierPlatform;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
      if (animate && list && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
        list.classList.remove("is-switching");
        void list.offsetWidth;
        list.classList.add("is-switching");
        window.setTimeout(() => list.classList.remove("is-switching"), 320);
      }
      requestAnimationFrame(() => cards.filter(card => !card.hidden).forEach(card => {
        const oldRect = before.get(card);
        if (!oldRect) return card.animate(
          [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
          { duration: 240, easing: "cubic-bezier(.16,.84,.34,1)" },
        );
        const nextRect = card.getBoundingClientRect();
        const dx = oldRect.left - nextRect.left;
        const dy = oldRect.top - nextRect.top;
        if (dx || dy) card.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
          { duration: 260, easing: "cubic-bezier(.16,.84,.34,1)" },
        );
      }));
    };
    const focusAccount = accountId => {
      const id = String(accountId || "");
      if (!id) return;
      requestAnimationFrame(() => {
        const card = root.querySelector(`[data-account-id="${CSS.escape(id)}"]`);
        if (!card || card.hidden) return;
        card.scrollIntoView({ block: "center", behavior: "smooth" });
        card.classList.add("is-search-focus");
        window.setTimeout(() => card.classList.remove("is-search-focus"), 1800);
      });
    };
    const selectAccountPlatform = next => {
      const value = next || "all";
      if (value === supplierPlatform) return;
      supplierPlatform = value;
      applyAccountFilters({ animate: true });
    };
    $$('[data-top-supplier-platform]').forEach(button => { button.onclick = () => selectAccountPlatform(button.dataset.topSupplierPlatform); });
    $$('[data-supplier-platform-filter]', root).forEach(button => {
      button.addEventListener("click", () => selectAccountPlatform(button.dataset.supplierPlatformFilter));
    });
    applyAccountFilters();
    focusAccount(state.ui.supplierSelectedAccountId);
    activeSupplierAccountController = {
      root,
      applyFilters: applyAccountFilters,
      focusAccount,
      refresh: () => renderSupplierAccounts(root),
      syncAuthority: () => {
        const delivered = state.assets.filter(asset => asset && (asset.delivered || asset.shared));
        $$('[data-supplier-account-views]', root).forEach(target => {
          const total = delivered
            .filter(asset => asset.accountId === target.dataset.supplierAccountViews)
            .reduce((sum, asset) => sum + Math.max(0, Number(asset.viewCount || 0)), 0);
          target.innerHTML = `${icon("pulse", 12)} ${Number(total).toLocaleString("zh-CN")}`;
        });
      },
    };
    root.__viewCleanup = () => {
      if (activeSupplierAccountController?.root === root) activeSupplierAccountController = null;
    };
    $$("[data-account-assign]", root).forEach(sel => sel.addEventListener("change", async () => {
      const accountId = sel.dataset.accountAssign;
      const childId = sel.value;
      const previousBinding = bindings.find(x => x.accountId === accountId);
      const previousValue = previousBinding?.childId || "";
      sel.disabled = true;
      try {
        if (childId) {
          const current = bindings.filter(x => x.childId === childId).map(x => x.accountId).filter(x => x !== accountId);
          await remote.supplier.bindAccounts(childId, [...current, accountId]);
        } else if (previousBinding?.childId) {
          await remote.supplier.bindAccounts(previousBinding.childId, bindings.filter(x => x.childId === previousBinding.childId && x.accountId !== accountId).map(x => x.accountId));
        }
        const oldIndex = bindings.findIndex(x => x.accountId === accountId);
        if (oldIndex >= 0) bindings.splice(oldIndex, 1);
        if (childId) bindings.push({ accountId, childId });
        toast("分配已更新");
      } catch (e) {
        sel.value = previousValue;
        toast(e.message || String(e), "error");
      } finally {
        sel.disabled = false;
      }
    }));
  } catch (e) {
    if (!onSupplierRoute("assets")) return;
    root.innerHTML = `<div class="supplier-shell">${emptyState("x", "账号看板读取失败", esc(e.message || e))}</div>`;
  }
}

function createChildrenDialog(onDone) {
  openModal(`<div class="mp-head"><b>批量建立子账号</b><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
    <div class="mp-body supplier-child-modal-body"><div class="supplier-child-editor" id="supplierChildRows">${[0, 1].map(i => `<div class="supplier-child-edit-row"><input class="input" data-child-name placeholder="姓名"/><input class="input" data-child-user placeholder="用户名"/><input class="input" data-child-pin type="password" placeholder="初始密码"/><button class="icon-btn danger" type="button" data-child-row-remove title="删除此行">${icon("trash", 14)}</button></div>`).join("")}</div><button class="btn ghost sm supplier-child-add-row" type="button" id="supplierChildRowAdd">${icon("plus", 13)} 添加一行</button></div>
    <div class="mp-foot"><span class="supplier-child-submit-status" id="supplierChildSubmitStatus" role="status" aria-live="polite"></span><button class="btn ghost" data-close>取消</button><button class="btn primary" id="supplierChildCreate">创建账号</button></div>`, { onMount(panel, close) {
      panel.classList.add("supplier-child-modal");
      const addRow = () => { const row = document.createElement("div"); row.className = "supplier-child-edit-row is-entering"; row.innerHTML = `<input class="input" data-child-name placeholder="姓名"/><input class="input" data-child-user placeholder="用户名"/><input class="input" data-child-pin type="password" placeholder="初始密码"/><button class="icon-btn danger" type="button" data-child-row-remove title="删除此行">${icon("trash", 14)}</button>`; const rows = $("#supplierChildRows", panel); rows.appendChild(row); requestAnimationFrame(() => row.classList.remove("is-entering")); rows.scrollTo({ top: rows.scrollHeight, behavior: "smooth" }); };
      $("#supplierChildRowAdd", panel).addEventListener("click", addRow);
      panel.addEventListener("click", e => { const b = e.target.closest("[data-child-row-remove]"); if (b && $$(".supplier-child-edit-row", panel).length > 1) { const row = b.closest(".supplier-child-edit-row"); row.classList.add("is-leaving"); row.addEventListener("transitionend", () => row.remove(), { once: true }); setTimeout(() => row.remove(), 220); } });
      $("#supplierChildCreate", panel).addEventListener("click", async () => {
        const submit = $("#supplierChildCreate", panel);
        const status = $("#supplierChildSubmitStatus", panel);
        const showStatus = (message = "", kind = "") => {
          status.textContent = message;
          status.className = `supplier-child-submit-status${kind ? ` is-${kind}` : ""}`;
        };
        const items = $$(".supplier-child-edit-row", panel).map(row => ({ name: $("[data-child-name]", row).value.trim(), username: $("[data-child-user]", row).value.trim(), pin: $("[data-child-pin]", row).value.trim(), role: "supplier_child" })).filter(x => x.name || x.username || x.pin);
        if (items.some(x => !x.name || !x.username || !x.pin)) { showStatus("每一行都要填写完整", "error"); toast("每一行都要填写姓名、用户名和初始密码", "error"); return; }
        if (!items.length) { showStatus("请至少填写一个子账号", "error"); toast("请按示例填写至少一个子账号", "error"); return; }
        const usernames = items.map(x => x.username.toLowerCase());
        if (new Set(usernames).size !== usernames.length) { showStatus("用户名不能重复", "error"); toast("本批次存在重复用户名，请修改后再创建", "error"); return; }
        submit.disabled = true;
        submit.innerHTML = `<span class="spin-dot"></span> 创建中…`;
        showStatus(`正在创建 ${items.length} 个账号…`, "loading");
        try {
          const created = await remote.supplier.addChildren(items);
          showStatus(`已创建 ${created?.length || items.length} 个账号`, "success");
          toast(`已创建 ${created?.length || items.length} 个子账号`);
          await Promise.resolve(onDone?.());
          close();
        } catch (e) {
          const message = (e.message || String(e)).replace(/^HTTP\s+\d+\s+/, "").replace(/^\{\s*"detail"\s*:\s*"([^"]+)"\s*\}$/, "$1");
          showStatus(message || "创建失败，请重试", "error");
          toast(message || "创建失败，请重试", "error");
          submit.disabled = false;
          submit.textContent = "创建账号";
        }
      });
    }});
}

function assignDialog(child, bindings, onDone) {
  const selected = new Set(bindings.filter(x => x.childId === child.id).map(x => x.accountId));
  const assignableAccounts = state.accounts.filter(acc => !isAccountDisabled(acc));
  const platforms = [...new Set(assignableAccounts.map(acc => acc.platform).filter(Boolean))];
  openModal(`<div class="mp-head"><b>分配账号 · ${esc(child.name)}</b><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
    <div class="mp-body"><div class="supplier-assign-tools"><label>${icon("search", 13)}<input id="supplierAssignSearch" placeholder="搜索账号" /></label><div class="supplier-filter-chips"><button class="on" type="button" data-assign-platform="all">全部</button>${platforms.map(platform => `<button type="button" data-assign-platform="${esc(platform)}">${esc(platform)}</button>`).join("")}</div></div><div class="supplier-assign-list">${assignableAccounts.map(acc => `<label data-assign-row data-search="${esc(`${acc.name} ${acc.platform} ${acc.mode}`.toLowerCase())}" data-platform="${esc(acc.platform || "")}"><input type="checkbox" value="${esc(acc.id)}" ${selected.has(acc.id) ? "checked" : ""}/><span class="supplier-account-avatar small">${accountAvatar(acc)}</span><b>${esc(acc.name)}</b><em>${esc(acc.platform || "平台")}</em></label>`).join("")}</div><p class="supplier-assign-empty" hidden>当前筛选下没有可分配账号</p></div>
    <div class="mp-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="supplierAssignSave">保存分配</button></div>`, { onMount(panel, close) {
      let query = "";
      let platform = "all";
      const apply = () => {
        let visible = 0;
        $$('[data-assign-row]', panel).forEach(row => {
          const show = (!query || row.dataset.search.includes(query)) && (platform === "all" || row.dataset.platform === platform);
          row.hidden = !show;
          if (show) visible++;
        });
        const empty = $(".supplier-assign-empty", panel);
        if (empty) empty.hidden = visible > 0;
      };
      $("#supplierAssignSearch", panel)?.addEventListener("input", event => { query = event.currentTarget.value.trim().toLowerCase(); apply(); });
      $$('[data-assign-platform]', panel).forEach(button => button.addEventListener("click", () => {
        platform = button.dataset.assignPlatform || "all";
        $$('[data-assign-platform]', panel).forEach(item => item.classList.toggle("on", item === button));
        apply();
      }));
      $("#supplierAssignSave", panel).addEventListener("click", async () => {
        const ids = $$('input[type="checkbox"]:checked', panel).map(x => x.value);
        try { await remote.supplier.bindAccounts(child.id, ids); close(); toast("账号分配已更新"); onDone(); } catch (e) { toast(e.message || String(e), "error"); }
      });
    }});
}

function editSupplierMemberDialog(member, onDone) {
  if (!member) return;
  const isChild = member.role === "supplier_child";
  openModal(`<div class="mp-head"><b>编辑${isChild ? "子账号" : "供应商管理员"}</b><button class="icon-btn" data-close>${icon("x", 16)}</button></div>
    <div class="mp-body supplier-member-form">
      <label>姓名<input class="input" id="supplierMemberName" value="${esc(member.name || "")}" /></label>
      <label>用户名<input class="input" id="supplierMemberUsername" value="${esc(member.username || "")}" /></label>
      <label>新密码<input class="input" id="supplierMemberPin" type="password" placeholder="留空则不修改密码" autocomplete="new-password" /></label>
      <p>${isChild ? "供应商管理员可修改子账号资料、重置密码或删除账号。" : "所有供应商管理员共享管理员账号维护权限；留空密码不会覆盖原密码。"}</p>
    </div>
    <div class="mp-foot"><span id="supplierMemberStatus" class="supplier-child-submit-status"></span><button class="btn ghost" data-close>取消</button><button class="btn primary" id="supplierMemberSave">保存修改</button></div>`, { onMount(panel, close) {
      $("#supplierMemberSave", panel)?.addEventListener("click", async () => {
        const button = $("#supplierMemberSave", panel);
        const status = $("#supplierMemberStatus", panel);
        const name = $("#supplierMemberName", panel)?.value.trim() || "";
        const username = $("#supplierMemberUsername", panel)?.value.trim() || "";
        const pin = $("#supplierMemberPin", panel)?.value || "";
        if (!name || !username) {
          status.textContent = "姓名和用户名必填";
          status.className = "supplier-child-submit-status is-error";
          return;
        }
        button.disabled = true;
        status.textContent = "正在保存…";
        status.className = "supplier-child-submit-status is-loading";
        try {
          await remote.supplier.updateMember(member.id, { name, username, pin });
          toast("供应商账号已更新");
          close();
          await Promise.resolve(onDone?.());
        } catch (error) {
          status.textContent = error?.message || "保存失败";
          status.className = "supplier-child-submit-status is-error";
          button.disabled = false;
        }
      });
    }});
}

export async function renderSupplierSettings(root, { page } = {}) {
  const activePage = page === "accounts" ? "accounts" : "requests";
  const pageTitle = activePage === "accounts" ? "全部供应商账号" : "子账号申请";
  root.innerHTML = `<div class="supplier-shell"><div class="page-head"><div><div class="eyebrow">设置</div><h2>${pageTitle}</h2></div></div><div class="supplier-loading">正在读取...</div></div>`;
  const draw = async () => {
    try {
      const [{ members, children, bindings }, allRequests] = await Promise.all([supplierData(true, false), remote.memberRequests.list("pending")]);
      const requests = (allRequests || []).filter(request => request.role === "supplier_child");
      if (!onSupplierRoute("settings")) return;
      emitSupplierChildren(children, bindings);
      root.innerHTML = `<div class="supplier-shell">
        <div class="page-head"><div><div class="eyebrow">设置</div><h2>${pageTitle}</h2></div><button class="btn primary sm" type="button" data-supplier-create-children>${icon("plus", 13)} 新建子账号</button></div>
        ${activePage === "requests" ? `<section class="card supplier-requests supplier-settings-panel"><div class="card-head"><span><b>${icon("inbox", 14)} 子账号申请</b><em>${requests.length} 条待处理 · 与创作端申请看板实时一致</em></span><button class="btn ghost sm" id="supplierRequestRefresh">${icon("refresh", 13)} 刷新</button></div>
          ${requests.length ? requests.map(r => `<div class="supplier-child-row"><span class="mem-ava supplier-member-fallback">${icon("user", 15)}</span><span><b>${esc(r.name)}</b><em>@${esc(r.username)} · ${r.createdAt ? timeAgo(r.createdAt) : "刚刚"}</em></span><button class="btn primary sm" data-supplier-approve="${r.id}">通过</button><button class="btn ghost sm danger" data-supplier-reject="${r.id}">拒绝</button></div>`).join("") : `<p class="supplier-empty">暂无待处理申请</p>`}
        </section>` : `<section class="card supplier-children supplier-settings-panel"><div class="card-head"><span><b>全部供应商账号</b><em>管理员可维护所有管理员与子账号；子账号可单独分配自媒体账号</em></span></div>
          ${members.length ? `<div class="supplier-member-grid">${members.map(member => { const isChild = member.role === "supplier_child"; const n = isChild ? bindings.filter(x => x.childId === member.id).length : 0; return `<div class="supplier-child-row supplier-member-row"><span class="mem-ava supplier-member-fallback">${icon(isChild ? "user" : "shield", 15)}</span><span><b>${esc(member.name)}</b><em>@${esc(member.username)} · ${isChild ? `子账号 · 已分配 ${n} 个账号` : "供应商管理员"}</em></span><button class="btn ghost sm" data-supplier-edit="${member.id}">${icon("edit", 13)} 编辑账号</button>${isChild ? `<button class="btn ghost sm" data-supplier-assign="${member.id}">${icon("grid", 13)} 分配账号</button><button class="icon-btn sm danger" data-supplier-delete="${member.id}" title="删除">${icon("trash", 13)}</button>` : ""}</div>`; }).join("")}</div>` : emptyState("users", "还没有供应商账号", "可批量建立，或审批子账号申请")}
        </section>`}
      </div>`;
      $("#supplierRequestRefresh", root)?.addEventListener("click", event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.innerHTML = `${icon("refresh", 13)} 读取中…`;
        draw();
      });
      $("[data-supplier-create-children]", root)?.addEventListener("click", () => {
        createChildrenDialog(draw);
      });
      $$('[data-supplier-edit]', root).forEach(b => b.addEventListener("click", () => editSupplierMemberDialog(members.find(x => x.id === b.dataset.supplierEdit), draw)));
      $$('[data-supplier-assign]', root).forEach(b => b.addEventListener("click", () => assignDialog(children.find(x => x.id === b.dataset.supplierAssign), bindings, draw)));
      $$('[data-supplier-approve]', root).forEach(b => b.addEventListener("click", async () => { await remote.memberRequests.approve(b.dataset.supplierApprove); toast("申请已通过"); draw(); }));
      $$('[data-supplier-reject]', root).forEach(b => b.addEventListener("click", async () => { await remote.memberRequests.reject(b.dataset.supplierReject); toast("申请已拒绝"); draw(); }));
      $$('[data-supplier-delete]', root).forEach(b => b.addEventListener("click", async () => {
        const c = children.find(x => x.id === b.dataset.supplierDelete);
        if (await confirmModal({ title: `删除子账号「${esc(c?.name || "") }」？`, danger: true, okText: "删除" })) { await remote.supplier.removeChild(b.dataset.supplierDelete); toast("子账号已删除"); draw(); }
      }));
      activeSupplierSettingsController = { root, refresh: draw };
      root.__viewCleanup = () => {
        if (activeSupplierSettingsController?.root === root) activeSupplierSettingsController = null;
      };
    } catch (e) {
      if (!onSupplierRoute("settings")) return;
      root.innerHTML = `<div class="supplier-shell">${emptyState("x", "供应商设置读取失败", esc(e.message || e))}</div>`;
    }
  };
  draw();
}
