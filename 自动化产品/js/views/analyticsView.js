/* 数据分析看板：供应商回链后的检测、复盘、创作记忆 */

import { $, $$, esc, timeAgo } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save } from "../core/store.js";
import { toast, withLoading, emptyState } from "../ui/components.js";
import {
  analyticsRows, analyticsSummary, refreshAllAnalytics, refreshAnalyticsLink,
  syncExistingPublishedAssets, buildLocalInsight, saveInsightReport,
  commitReportToMemory, memoryStats
} from "../domain/analytics.js";

let filter = "all";

const fmt = n => Number(n || 0).toLocaleString("zh-CN");
const pct = n => ((Number(n || 0) * 100).toFixed(1) + "%");

function statCard(label, value, sub = "", cls = "") {
  return `<div class="ov-stat ${cls} card"><b>${esc(value)}</b><span>${esc(label)}</span>${sub ? `<em>${esc(sub)}</em>` : ""}</div>`;
}

function statusPill(link) {
  const map = {
    pending: ["待检测", "pending"],
    syncing: ["同步中", "running"],
    synced: ["已同步", "approved"],
    failed: ["检测失败", "failed"],
    unsupported: ["暂不支持", "input"]
  };
  const [label, cls] = map[link.status] || ["待检测", "pending"];
  return `<span class="status-pill ${cls}">${esc(label)}</span>`;
}

function providerLabel(provider) {
  if (!provider) return "";
  if (/mock/.test(provider)) return "模拟数据";
  return provider;
}

function sparkline(rows) {
  const points = rows
    .filter(r => r.latest)
    .slice()
    .reverse()
    .slice(-12)
    .map(r => r.latest.metrics.views || 0);
  if (!points.length) return `<div class="da-empty-line">暂无趋势</div>`;
  const max = Math.max(...points, 1);
  const w = 320, h = 84;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const d = points.map((v, i) => `${i ? "L" : "M"}${Math.round(i * step)},${Math.round(h - (v / max) * (h - 10) - 5)}`).join(" ");
  return `<svg class="da-line" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path class="da-line-fill" d="${d} L${w},${h} L0,${h} Z"></path>
    <path class="da-line-stroke" d="${d}"></path>
  </svg>`;
}

function rankingHtml(items, type = "account") {
  const list = (items || []).slice(0, 5);
  if (!list.length) return `<div class="muted">同步数据后显示排行</div>`;
  const max = Math.max(...list.map(x => x.score || x.views || 1), 1);
  return `<div class="da-rank">${list.map((x, i) => {
    const name = type === "tag" ? x.tag : x.name;
    const val = x.score || 0;
    return `<div class="da-rank-row">
      <span class="da-rank-no">${i + 1}</span>
      <span class="da-rank-main"><b>${esc(name)}</b><i><em style="width:${Math.max(8, val / max * 100)}%"></em></i></span>
      <span class="da-rank-val">${val}</span>
    </div>`;
  }).join("")}</div>`;
}

function reportHtml(report) {
  if (!report) {
    return `<div class="da-bot-empty">
      <span>${icon("bot", 26)}</span>
      <b>等待生成复盘</b>
      <p>同步小红书数据后，检测机器人会把表现规律沉淀成下一批创作建议。</p>
    </div>`;
  }
  return `<div class="da-report">
    <div class="da-report-head">
      <span class="da-bot">${icon("bot", 18)}</span>
      <div><b>${esc(report.title || "数据复盘")}</b><em>${timeAgo(report.createdAt)} · ${esc(report.source || "robot")}</em></div>
    </div>
    <p>${esc(report.summary || "")}</p>
    <div class="da-advice-grid">
      <div><b>下一批选题</b>${(report.nextTopics || []).map(x => `<span>${esc(x)}</span>`).join("")}</div>
      <div><b>脚本优化</b>${(report.scriptAdvice || []).map(x => `<span>${esc(x)}</span>`).join("")}</div>
    </div>
    <div class="da-rules">${(report.rules || []).map(r => `<span class="tag">${esc(r.type)} · ${esc(r.rule)}</span>`).join("")}</div>
  </div>`;
}

function memoryHtml() {
  const items = state.creativeMemory.filter(m => m.status !== "deprecated").slice(0, 8);
  if (!items.length) return `<div class="muted">复盘报告写入后，这里会显示会被创作模型读取的规则。</div>`;
  return `<div class="da-memory-list">${items.map(m => `
    <div class="da-memory" data-mid="${m.id}">
      <span class="tag">${esc(m.type || "general")}</span>
      <b>${esc(m.rule)}</b>
      <em>${esc(m.evidence || "")}</em>
      <button class="icon-btn sm danger" data-mem-off="${m.id}" title="停用这条记忆">${icon("x", 12)}</button>
    </div>`).join("")}</div>`;
}

function rowHtml(r) {
  const m = r.latest?.metrics;
  const title = r.link.title || r.asset?.title || r.asset?.name || "未命名内容";
  const err = r.link.status === "failed" && r.link.error ? `<em class="da-error">${esc(r.link.error)}</em>` : "";
  return `<tr data-link="${r.link.id}">
    <td class="da-title"><b>${esc(title)}</b><em>${esc(r.acc?.name || "未归属账号")} · ${esc(r.link.platform || "")}${r.link.provider ? ` · ${esc(providerLabel(r.link.provider))}` : ""}</em>${err}</td>
    <td>${statusPill(r.link)}</td>
    <td class="num">${m ? fmt(m.views) : "-"}</td>
    <td class="num">${m ? fmt(m.likes) : "-"}</td>
    <td class="num">${m ? fmt(m.collects) : "-"}</td>
    <td class="num">${m ? fmt(m.comments) : "-"}</td>
    <td class="num">${m ? pct(m.engagementRate) : "-"}</td>
    <td class="num">${m ? m.qualityScore : "-"}</td>
    <td class="da-time">${r.link.lastSyncedAt ? timeAgo(r.link.lastSyncedAt) : "未同步"}</td>
    <td class="da-actions">
      <button class="btn ghost sm" data-refresh="${r.link.id}">${icon("refresh", 12)} 检测</button>
      <a class="link-btn" href="${esc(r.link.url)}" target="_blank" rel="noopener noreferrer">${icon("external", 12)}</a>
    </td>
  </tr>`;
}

export const analyticsView = {
  render(root) {
    syncExistingPublishedAssets();
    const draw = () => {
      const rowsAll = analyticsRows();
      const rows = rowsAll.filter(r => {
        if (filter === "all") return true;
        if (filter === "todo") return !r.latest && r.link.status !== "unsupported";
        if (filter === "synced") return !!r.latest;
        if (filter === "risk") return r.link.status === "failed" || r.link.status === "unsupported";
        return r.link.platform === filter;
      });
      const s = analyticsSummary(rowsAll);
      const latestReport = state.insightReports.find(r => (r.linkedSnapshotIds || []).length) || null;
      const mem = memoryStats();
      root.innerHTML = `
        <div class="analytics-page">
          <div class="page-head">
            <div><div class="eyebrow">数据分析</div><h2>发布回链检测 · 复盘建议 · 创作记忆</h2></div>
            <div class="head-actions">
              <button class="btn ghost" id="daSyncHistory">${icon("link", 14)} 同步历史回链</button>
              <button class="btn ghost" id="daRefreshAll">${icon("refresh", 14)} 同步数据</button>
              <button class="btn primary" id="daReport">${icon("bot", 14)} 生成复盘</button>
            </div>
          </div>

          <section class="ov-stats da-stats">
            ${statCard("回传链接", s.total, `${s.synced} 条已检测`)}
            ${statCard("总阅读", fmt(s.totalViews), "来自已同步样本", "run")}
            ${statCard("互动率", pct(s.engagementRate), `${fmt(s.totalEngagement)} 次互动`, "review")}
            ${statCard("平均质量分", s.avgScore || "-", "0-100 综合评分")}
            ${statCard("异常/待处理", s.failed, `${s.pending} 条待检测`, s.failed ? "fail" : "")}
          </section>

          <section class="da-grid">
            <div class="card da-panel da-trend">
              <div class="card-head"><b>阅读趋势</b><em>最近 12 条已同步内容</em></div>
              ${sparkline(rowsAll)}
            </div>
            <div class="card da-panel">
              <div class="card-head"><b>账号排行</b><em>按质量分</em></div>
              ${rankingHtml(s.accounts)}
            </div>
            <div class="card da-panel">
              <div class="card-head"><b>标签表现</b><em>复盘素材</em></div>
              ${rankingHtml(s.tags, "tag")}
            </div>
          </section>

          <section class="da-workspace">
            <div class="card da-panel da-bot-panel">
              <div class="card-head"><b>${icon("bot", 14)} 检测机器人</b><button class="link-btn" id="daCommit" ${latestReport ? "" : "disabled"}>${icon("spark", 12)} 写入创作记忆</button></div>
              ${reportHtml(latestReport)}
            </div>
            <div class="card da-panel">
              <div class="card-head"><b>${icon("archive", 14)} 创作记忆</b><em>${mem.active} 条生效</em></div>
              ${memoryHtml()}
            </div>
          </section>

          <section class="card da-table-card">
            <div class="da-table-head">
              <div class="mode-tabs slim">
                ${[
                  ["all", "全部"], ["todo", "待检测"], ["synced", "已同步"], ["risk", "异常"]
                ].map(([k, label]) => `<button class="mode-tab ${filter === k ? "is-active" : ""}" data-f="${k}">${label}<span>${countFor(rowsAll, k)}</span></button>`).join("")}
              </div>
            </div>
            ${rows.length ? `<div class="da-table-wrap"><table class="da-table">
              <thead><tr><th>内容</th><th>状态</th><th>阅读</th><th>赞</th><th>藏</th><th>评</th><th>互动率</th><th>质量</th><th>同步</th><th></th></tr></thead>
              <tbody>${rows.map(rowHtml).join("")}</tbody>
            </table></div>` : emptyState("pulse", "还没有可分析的数据", "供应商在发布清单回传小红书链接后，会自动进入这里。")}
          </section>
        </div>`;
      wire(root, draw);
    };
    draw();
  }
};

function countFor(rows, key) {
  if (key === "all") return rows.length;
  if (key === "todo") return rows.filter(r => !r.latest && r.link.status !== "unsupported").length;
  if (key === "synced") return rows.filter(r => r.latest).length;
  if (key === "risk") return rows.filter(r => r.link.status === "failed" || r.link.status === "unsupported").length;
  return 0;
}

function wire(root, redraw) {
  $("[data-f=\"" + filter + "\"]", root)?.closest(".mode-tabs")?.setAttribute("data-active", filter);
  $$("[data-f]", root).forEach(b => b.addEventListener("click", () => { filter = b.dataset.f; redraw(); }));
  $("#daSyncHistory", root)?.addEventListener("click", () => {
    const n = syncExistingPublishedAssets();
    toast(n ? `已补入 ${n} 条历史回链` : "历史回链已是最新");
    redraw();
  });
  $("#daRefreshAll", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
    const r = await refreshAllAnalytics();
    toast(r.total ? `已同步 ${r.ok}/${r.total} 条数据` : "没有需要同步的链接");
    redraw();
  }, "同步中…"));
  $("#daReport", root)?.addEventListener("click", e => withLoading(e.currentTarget, async () => {
    if (!analyticsRows().some(r => r.latest)) {
      toast("先同步至少一条小红书数据，再生成复盘");
      return;
    }
    const report = buildLocalInsight(analyticsRows());
    saveInsightReport(report);
    toast("检测机器人已生成复盘");
    redraw();
  }, "复盘中…"));
  $("#daCommit", root)?.addEventListener("click", () => {
    const n = commitReportToMemory(state.insightReports[0]);
    toast(n ? `已写入 ${n} 条创作记忆` : "没有新的记忆需要写入");
    redraw();
  });
  $$("[data-refresh]", root).forEach(b => b.addEventListener("click", e => withLoading(e.currentTarget, async () => {
    const snap = await refreshAnalyticsLink(b.dataset.refresh);
    toast(snap ? "检测完成" : "检测未产生新数据");
    redraw();
  }, "检测中…")));
  $$("[data-mem-off]", root).forEach(b => b.addEventListener("click", () => {
    const m = state.creativeMemory.find(x => x.id === b.dataset.memOff);
    if (!m) return;
    m.status = "deprecated";
    m.updatedAt = Date.now();
    save("creativeMemory");
    toast("已停用这条创作记忆");
    redraw();
  }));
}
