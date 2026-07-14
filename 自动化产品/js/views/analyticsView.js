/* 数据分析看板：小红书 / 视频号发布回链与真实指标同步 */

import { $, $$, esc, timeAgo } from "../core/util.js";
import { icon, agentAvatar } from "../ui/icons.js";
import { toast, withLoading, emptyState } from "../ui/components.js";
import { state } from "../core/store.js";
import {
  analyticsRows, analyticsSummary,
  syncExistingPublishedAssets, refreshAllAnalytics, refreshAnalyticsLink, justOneAnalyticsStatus
} from "../domain/analytics.js";
import { deliveryViewsSummary } from "../domain/delivery.js";

let filter = "all";
let platformFilter = "all";
let timeFilter = "all";
let productFilter = "all";
let justOneStatus = null;
let qaLog = [];

const fmt = n => Number(n || 0).toLocaleString("zh-CN");
const pct = n => ((Number(n || 0) * 100).toFixed(1) + "%");

function rowTimestamp(row) {
  const value = row.latest?.capturedAt || row.link.lastSyncedAt || row.link.publishedAt || row.link.createdAt || 0;
  if (typeof value === "number") return value;
  return Date.parse(value) || 0;
}

function inTimeWindow(row) {
  if (timeFilter === "all") return true;
  const timestamp = rowTimestamp(row);
  return timestamp > 0 && timestamp >= Date.now() - Number(timeFilter) * 86400000;
}

function productTagOf(row) {
  return String(row?.asset?.productTag || row?.prod?.delivery?.productTag || "").trim();
}

function statCard(label, value, sub = "", cls = "") {
  return `<div class="ov-stat ${cls} card"><b>${esc(value)}</b><span>${esc(label)}</span>${sub ? `<em>${esc(sub)}</em>` : ""}</div>`;
}

function justOneCard() {
  const s = justOneStatus;
  const label = !s
    ? "未检测"
    : s.configured
      ? (s.reachable === false ? "已配置 · 网络待确认" : "已配置")
      : "待配置";
  const detail = !s
    ? "服务端已预留 JustOneAPI 代理，令牌只从服务器环境变量读取。"
    : s.configured
      ? "可用于小红书笔记与视频号内容指标同步。"
      : "等待服务器环境配置 JustOneAPI 令牌后启用。";
  const canRefresh = state.role === "admin";
  return `<section class="card da-justone">
    <div class="da-justone-main">
      <span>${icon("pulse", 14)}</span>
      <div><b>JustOneAPI 数据接口</b><em>${esc(detail)}</em></div>
    </div>
    <div class="da-justone-side">
      <span class="status-pill ${s?.configured ? "approved" : "input"}">${esc(label)}</span>
      ${canRefresh ? `<button class="btn ghost sm" id="daCheckJustOne">${icon("refresh", 12)} 检测接口</button>` : ""}
    </div>
  </section>`;
}

function statusPill(link) {
  const map = {
    pending: ["仅回链", "input"],
    syncing: ["仅回链", "input"],
    synced: ["已同步", "approved"],
    failed: ["待处理", "input"],
    unsupported: ["仅回链", "input"]
  };
  const [label, cls] = map[link.status] || ["仅回链", "input"];
  return `<span class="status-pill ${cls}">${esc(label)}</span>`;
}

function providerLabel(provider) {
  if (!provider) return "";
  if (/mock/.test(provider)) return "";
  return provider;
}

function rowHtml(r) {
  const canRefresh = state.role === "admin";
  const m = r.latest?.metrics;
  const title = r.link.title || r.asset?.title || r.asset?.name || "未命名内容";
  const err = ["failed", "unsupported"].includes(r.link.status) && r.link.error ? `<em class="da-error">${esc(r.link.error)}</em>` : "";
  const provider = providerLabel(r.link.provider);
  return `<tr data-link="${r.link.id}">
    <td class="da-title"><b>${esc(title)}</b><em>${esc(r.acc?.name || "未归属账号")} · ${esc(r.link.platform || "")}${provider ? ` · ${esc(provider)}` : ""}</em>${err}</td>
    <td>${statusPill(r.link)}</td>
    <td class="num">${m ? fmt(m.likes) : "-"}</td>
    <td class="num">${m ? fmt(m.collects) : "-"}</td>
    <td class="num">${m ? fmt(m.comments) : "-"}</td>
    <td class="da-time">${r.link.lastSyncedAt ? timeAgo(r.link.lastSyncedAt) : "未同步"}</td>
    <td class="da-actions">
      ${canRefresh ? `<button class="icon-btn sm" data-refresh-link="${esc(r.link.id)}" title="刷新这条数据">${icon("refresh", 12)}</button>` : ""}
      <a class="icon-btn sm" href="${esc(r.link.url)}" target="_blank" rel="noopener noreferrer" title="打开发布链接">${icon("external", 12)}</a>
    </td>
  </tr>`;
}

function qaAnswer(q, rows) {
  const s = analyticsSummary(rows);
  const synced = rows.filter(r => r.latest);
  const top = s.top;
  if (/仅回链|未同步|待补|待刷新|没数据/.test(q)) {
    const pending = rows.filter(r => !r.latest);
    return pending.length
      ? `还有 ${pending.length} 条只有回链没有快照：${pending.slice(0, 3).map(r => r.link.title || r.asset?.name || "未命名").join("、")}。可以逐条点右侧刷新，也可以点顶部刷新数据。`
      : "当前所有回链都有快照。";
  }
  if (/账号|谁|哪个|排行|最好|最高/.test(q)) {
    return s.accounts.length
      ? `账号表现前三：${s.accounts.slice(0, 3).map(a => `${a.name}（${a.count}条，互动${fmt(a.engagement)}）`).join("、")}。`
      : "当前还没有可按账号统计的快照。";
  }
  if (/互动|点赞|收藏|评论|赞|藏/.test(q)) {
    return `总互动 ${fmt(s.totalEngagement)} 次；当前互动较好的内容是「${top?.link.title || top?.asset?.name || "暂无"}」。`;
  }
  if (/视频号|小红书/.test(q)) {
    const platform = /视频号/.test(q) ? "视频号" : "小红书";
    const picked = rows.filter(r => r.link.platform === platform);
    const ps = analyticsSummary(picked);
    return `${platform} 共 ${picked.length} 条回链，${ps.synced} 条有快照，总互动 ${fmt(ps.totalEngagement)}。`;
  }
  if (/阅读|浏览|曝光|质量|平均|分/.test(q)) return "当前接口不稳定返回阅读和质量分，面板只展示回链、快照和赞藏评。可以问：哪个账号互动最好？还有哪些仅回链？";
  return `当前有 ${s.total} 条回链，${s.synced} 条有快照，总互动 ${fmt(s.totalEngagement)}。你可以问：哪个账号互动最好？还有哪些仅回链？小红书数据怎么样？`;
}

function qaCard(rows) {
  const suggestions = ["哪个账号表现最好？", "还有哪些仅回链？", "小红书数据怎么样？"];
  return `<div class="da-qa card">
    <div class="da-qa-head"><span class="da-qa-avatar">${agentAvatar(22)}</span><b>数据问答</b><em>只读当前快照</em></div>
    <div class="da-qa-msgs" id="daQaMsgs">
      ${qaLog.length ? qaLog.slice(-4).map(m => `<div class="da-qa-bubble ${m.role}">${esc(m.text)}</div>`).join("") : `<div class="da-qa-sugs">${suggestions.map(q => `<button class="chip" data-da-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`}
    </div>
    <div class="da-qa-input"><input id="daQaInput" placeholder="问数据：哪个账号互动最好？" /><button class="ovc-send" id="daQaSend" title="发送">${icon("send", 14)}</button></div>
  </div>`;
}

export const analyticsView = {
  render(root) {
    syncExistingPublishedAssets();
    const draw = () => {
      const rowsAll = analyticsRows();
      const productTags = [...new Set(rowsAll.map(productTagOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
      const rows = rowsAll.filter(r => {
        const statusMatch = filter === "all"
          || (filter === "todo" && !r.latest)
          || (filter === "synced" && !!r.latest)
          || (filter === "risk" && (r.link.status === "failed" || r.link.status === "unsupported"));
        const platformMatch = platformFilter === "all" || r.link.platform === platformFilter;
        const productMatch = productFilter === "all" || productTagOf(r) === productFilter;
        return statusMatch && platformMatch && productMatch && inTimeWindow(r);
      });
      const s = analyticsSummary(rowsAll);
      const views = deliveryViewsSummary(platformFilter);
      const canRefresh = state.role === "admin";
      root.innerHTML = `
        <div class="analytics-page">
          <section class="ov-stats da-stats">
            ${statCard("回传链接", s.total, `${s.synced} 条有历史快照`)}
            ${statCard("总互动", fmt(s.totalEngagement), "赞、藏、评合计", "review")}
            ${statCard("总播放量", fmt(views.totalViews), `${platformFilter === "all" ? "全平台" : platformFilter} · ${views.deliveryCount} 条交付`, "views")}
            ${qaCard(rowsAll)}
          </section>
          ${justOneCard()}

          <section class="card da-table-card">
            <div class="da-table-head">
              <div class="mode-tabs slim">
                ${[
                  ["all", "全部"], ["todo", "仅回链"], ["synced", "有快照"], ["risk", "待处理"]
                ].map(([k, label]) => `<button class="mode-tab ${filter === k ? "is-active" : ""}" data-f="${k}">${label}<span>${countFor(rowsAll, k)}</span></button>`).join("")}
              </div>
              <div class="da-filter-selects">
                ${canRefresh ? `<button class="btn ghost sm" id="daRefreshMetrics">${icon("refresh", 13)} 刷新数据</button>` : ""}
                <label class="select-shell">${icon("filter", 13)}<select id="daPlatformFilter" aria-label="平台筛选">
                  <option value="all">全部平台</option>
                  <option value="小红书" ${platformFilter === "小红书" ? "selected" : ""}>小红书</option>
                  <option value="视频号" ${platformFilter === "视频号" ? "selected" : ""}>视频号</option>
                </select>${icon("chevronDown", 12)}</label>
                <label class="select-shell">${icon("clock", 13)}<select id="daTimeFilter" aria-label="时间筛选">
                  <option value="all">全部时间</option>
                  <option value="7" ${timeFilter === "7" ? "selected" : ""}>近 7 天</option>
                  <option value="30" ${timeFilter === "30" ? "selected" : ""}>近 30 天</option>
                  <option value="90" ${timeFilter === "90" ? "selected" : ""}>近 90 天</option>
                </select>${icon("chevronDown", 12)}</label>
                <label class="select-shell">${icon("package", 13)}<select id="daProductFilter" aria-label="产品筛选">
                  <option value="all">全部产品</option>
                  ${productTags.map(tag => `<option value="${esc(tag)}" ${productFilter === tag ? "selected" : ""}>${esc(tag)}</option>`).join("")}
                </select>${icon("chevronDown", 12)}</label>
              </div>
            </div>
            ${rows.length ? `<div class="da-table-wrap"><table class="da-table">
              <colgroup>
                <col class="da-col-title">
                <col class="da-col-status">
                <col class="da-col-num">
                <col class="da-col-num">
                <col class="da-col-num">
                <col class="da-col-time">
                <col class="da-col-action">
              </colgroup>
              <thead><tr><th>内容</th><th>状态</th><th>赞</th><th>藏</th><th>评</th><th>快照</th><th></th></tr></thead>
              <tbody>${rows.map(rowHtml).join("")}</tbody>
            </table></div>` : emptyState("pulse", "还没有回链数据", "供应商在发布清单回传链接后，会自动进入这里。")}
          </section>
        </div>`;
      wire(root, draw);
    };
    draw();
  }
};

function countFor(rows, key) {
  if (key === "all") return rows.length;
  if (key === "todo") return rows.filter(r => !r.latest).length;
  if (key === "synced") return rows.filter(r => r.latest).length;
  if (key === "risk") return rows.filter(r => r.link.status === "failed" || r.link.status === "unsupported").length;
  return 0;
}

function wire(root, redraw) {
  $("[data-f=\"" + filter + "\"]", root)?.closest(".mode-tabs")?.setAttribute("data-active", filter);
  $$("[data-f]", root).forEach(b => b.addEventListener("click", () => { filter = b.dataset.f; redraw(); }));
  $("#daPlatformFilter", root)?.addEventListener("change", e => { platformFilter = e.currentTarget.value; redraw(); });
  $("#daTimeFilter", root)?.addEventListener("change", e => { timeFilter = e.currentTarget.value; redraw(); });
  $("#daProductFilter", root)?.addEventListener("change", e => { productFilter = e.currentTarget.value; redraw(); });
  $("#daRefreshMetrics", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
    syncExistingPublishedAssets();
    const res = await refreshAllAnalytics();
    if (!res.total) toast("还没有可刷新的小红书或视频号回链");
    else if (res.failed.length) toast(`已同步 ${res.ok}/${res.total} 条，${res.failed.length} 条待处理`, "error");
    else toast(`已同步 ${res.ok}/${res.total} 条数据快照`);
    redraw();
  }, "刷新中…"));
  $("#daCheckJustOne", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
    justOneStatus = await justOneAnalyticsStatus();
    toast(justOneStatus.configured ? "JustOneAPI 接口已配置" : "JustOneAPI 接口待配置");
    redraw();
  }, "检测中…"));
  $$("[data-refresh-link]", root).forEach(b => b.addEventListener("click", e => withLoading(e.currentTarget, async () => {
    const snap = await refreshAnalyticsLink(b.dataset.refreshLink);
    const row = analyticsRows().find(r => r.link.id === b.dataset.refreshLink);
    toast(snap ? `已刷新：${row?.link.title || "该条数据"}` : `刷新失败：${row?.link.error || "请稍后重试"}`, snap ? undefined : "error");
    redraw();
  }, "")));
  const input = $("#daQaInput", root);
  const sendQa = () => {
    const q = (input?.value || "").trim();
    if (!q) return;
    const rows = analyticsRows();
    qaLog.push({ role: "user", text: q }, { role: "agent", text: qaAnswer(q, rows) });
    if (qaLog.length > 10) qaLog = qaLog.slice(-10);
    input.value = "";
    redraw();
  };
  $("#daQaSend", root)?.addEventListener("click", sendQa);
  input?.addEventListener("keydown", e => { if (e.key === "Enter") sendQa(); });
  $$("[data-da-q]", root).forEach(b => b.addEventListener("click", () => {
    qaLog.push({ role: "user", text: b.dataset.daQ }, { role: "agent", text: qaAnswer(b.dataset.daQ, analyticsRows()) });
    if (qaLog.length > 10) qaLog = qaLog.slice(-10);
    redraw();
  }));
}
