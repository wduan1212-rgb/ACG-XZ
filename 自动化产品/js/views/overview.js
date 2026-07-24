/* 首页：待办导向 + 底部数据问答（只读数据助手，不执行操作） */

import { $, $$, esc, gradFor, timeAgo } from "../core/util.js";
import { icon, agentAvatar } from "../ui/icons.js";
import { state, save, accountById, ownedBy, assetById } from "../core/store.js";
import { platChip, groupOf } from "../domain/accounts.js";
import { STAGES, statusPill } from "../domain/productions.js";
import { deliveredAssets } from "../domain/delivery.js?v=20260724-v117-21";
import { analyticsRows, analyticsSummary } from "../domain/analytics.js?v=20260724-v117-21";
import { urlFor } from "../domain/assets.js";
import { AI } from "../api/ai.js?v=20260724-v117-21";
import { LLM_CONFIG } from "../api/llm.js?v=20260724-v117-21";
import { openProductionDrawer, stagePage } from "./prodDrawer.js?v=20260724-v117-21";
import { openDeliveryRemarks } from "./deliveryView.js?v=20260723-v117-8";
import { emptyState, openModal } from "../ui/components.js?v=20260724-v117-21";
import { go } from "../core/router.js";
import { renderSupplierOverview } from "./supplierViews.js?v=20260724-v117-21";

/* ---------- 数据问答（会话仅存内存，问的是库里的真实数据） ---------- */
let chatLog = [];   // {role:"user"|"agent", text}
let chatBusy = false;
let accountCarouselPage = 0;
let accountCarouselTimer = null;
let accountCarouselTransitionTimer = null;
let overviewTrendWindow = { kind: "days", days: 7, start: "", end: "" };

const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
function overviewTrendModel(delivered = []) {
  const trendEnd = new Date();
  trendEnd.setHours(0, 0, 0, 0);
  const customTrendStart = overviewTrendWindow.start ? new Date(`${overviewTrendWindow.start}T00:00:00`) : null;
  const customTrendEnd = overviewTrendWindow.end ? new Date(`${overviewTrendWindow.end}T00:00:00`) : null;
  const trendStart = overviewTrendWindow.kind === "custom" && customTrendStart && customTrendEnd && customTrendStart <= customTrendEnd
    ? customTrendStart
    : new Date(trendEnd.getTime() - ((overviewTrendWindow.days || 7) - 1) * 864e5);
  const trendDayCount = Math.max(1, Math.round((trendEnd - trendStart) / 864e5) + 1);
  const recentDays = Array.from({ length: trendDayCount }, (_, index) => {
    const ts = trendStart.getTime() + index * 864e5;
    const key = dayKey(ts);
    const dayDeliveries = delivered.filter(({ asset }) => dayKey(asset.deliveredAt || asset.createdAt) === key);
    const video = dayDeliveries.filter(({ asset, acc }) => acc?.mode === "视频" || asset?.type === "视频").length;
    return { key, label: new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }), value: dayDeliveries.length, video, image: Math.max(0, dayDeliveries.length - video) };
  });
  const trendMax = Math.max(1, ...recentDays.map(item => item.value));
  const trendPoints = recentDays.map((item, index) => ({ ...item, x: 24 + index * 80, y: 94 - Math.round(item.value / trendMax * 70) }));
  const trendCurve = trendPoints.reduce((path, point, index, points) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1]; const before = points[index - 2] || previous; const after = points[index + 1] || point;
    return `${path} C ${(previous.x + (point.x - before.x) / 6).toFixed(2)} ${(previous.y + (point.y - before.y) / 6).toFixed(2)}, ${(point.x - (after.x - previous.x) / 6).toFixed(2)} ${(point.y - (after.y - previous.y) / 6).toFixed(2)}, ${point.x} ${point.y}`;
  }, "");
  const trendChartWidth = Math.max(564, trendPoints.length * 80);
  const trendArea = trendPoints.length ? `${trendCurve} L ${trendPoints.at(-1).x} 94 L ${trendPoints[0].x} 94 Z` : "";
  return { recentDays, trendPoints, trendCurve, trendChartWidth, trendArea };
}

function overviewTrendCardContent(model) {
  const { trendPoints, trendCurve, trendChartWidth, trendArea } = model;
  const title = overviewTrendWindow.kind === "custom" ? "自定义时间交付" : `近 ${overviewTrendWindow.days} 日交付`;
  return `<header><span class="overview-trend-title"><b>${title}</b><em>总交付 · 图文 / 视频</em></span><span class="overview-trend-actions"><button class="overview-trend-detail" type="button" data-overview-trend-window="7">7日</button><button class="overview-trend-detail" type="button" data-overview-trend-window="30">30日</button><button class="overview-trend-detail" type="button" data-overview-trend-window="custom">自定义</button><button class="overview-trend-nav" type="button" data-trend-scroll-by="-260" aria-label="向左查看日期">‹</button><button class="overview-trend-nav" type="button" data-trend-scroll-by="260" aria-label="向右查看日期">›</button><button class="overview-trend-detail" type="button" data-overview-trend-detail>查看明细</button></span></header><div class="overview-trend-scroll" data-trend-scroll tabindex="0" aria-label="交付趋势，可横向查看日期"><div class="overview-trend-line" style="--trend-points:${trendPoints.length}; --trend-chart-width:${trendChartWidth}px"><svg viewBox="0 0 ${trendChartWidth} 106" preserveAspectRatio="xMidYMid meet" role="img"><defs><linearGradient id="overviewTrendFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e5485d" stop-opacity=".28"/><stop offset="1" stop-color="#e5485d" stop-opacity="0"/></linearGradient></defs><path class="grid" d="M24 18H540 M24 56H540 M24 94H540"/><path class="trend-area" d="${trendArea}"/><path class="trend-curve" d="${trendCurve}"/>${trendPoints.map(item => `<circle cx="${item.x}" cy="${item.y}" r="3.4" tabindex="0" role="button" aria-label="${esc(item.key)} · 总交付 ${item.value} 条，图文 ${item.image} 条，视频 ${item.video} 条，查看当天明细" data-chart-tip="${esc(item.label)} · 总交付 ${item.value} · 图文 ${item.image} · 视频 ${item.video}" data-trend-date="${esc(item.key)}"><title>${esc(item.key)} · 总交付 ${item.value} · 图文 ${item.image} · 视频 ${item.video}</title></circle>`).join("")}</svg><div>${trendPoints.map(item => `<button type="button" data-trend-date="${esc(item.key)}"><b>${item.value}</b><em>${esc(item.label)}</em></button>`).join("")}</div></div></div>`;
}
const weekRange = ts => {
  const d = new Date(ts || Date.now());
  d.setHours(0, 0, 0, 0);
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    key: dayKey(monday.getTime()),
    label: `${monday.getMonth() + 1}/${monday.getDate()}-${sunday.getMonth() + 1}/${sunday.getDate()}`
  };
};
const safeAccount = a => ({
  ...(a || {}),
  id: (a && a.id) || "",
  name: (a && a.name) || "未命名账号",
  platform: (a && a.platform) || "小红书",
  mode: (a && a.mode) || "图文",
  subType: (a && a.subType) || "",
  styleProfile: (a && a.styleProfile) || "",
  monthlyDone: (a && a.monthlyDone) || 0
});
const safeGroup = a => {
  try { return groupOf(safeAccount(a)); } catch (e) { return "未分组"; }
};
const safeChip = (platform, sm = true) => {
  try { return platChip(platform || "小红书", sm); } catch (e) { return `<span class="plat-chip sm">小红书</span>`; }
};
const visibleWorkProductions = () => state.productions.filter(p => p.stage === "delivered" || ownedBy(p));
const visiblePrivateAssets = () => state.assets.filter(a => !a.delivered && !a.shared && ownedBy(a));

function computeStats() {
  const today = dayKey(Date.now());
  const yest = dayKey(Date.now() - 864e5);
  const delivered = state.assets.filter(a => a.delivered);
  const privateAssets = visiblePrivateAssets();
  const visibleProds = visibleWorkProductions();
  const visibleProdIds = new Set(visibleProds.map(p => p.id));
  const stageCount = {};
  visibleProds.forEach(p => {
    const k = p.stage === "delivered" ? "已交付" : (STAGES[p.stage] || {}).label || p.stage;
    stageCount[k] = (stageCount[k] || 0) + 1;
  });
  const assetsToday = privateAssets.filter(a => dayKey(a.createdAt) === today).length;
  const assetsYest = privateAssets.filter(a => dayKey(a.createdAt) === yest).length;
  return {
    日期: { 今天: today, 昨天: yest },
    账号: state.accounts.filter(Boolean).map(a => {
      const acc = safeAccount(a);
      return { 名称: acc.name, 平台: acc.platform, 分组: safeGroup(acc), 本月交付: acc.monthlyDone || 0 };
    }),
    任务阶段分布: stageCount,
    待审核: visibleProds.filter(p => p.stage === "review" && p.stageStatus !== "failed").length,
    失败任务: visibleProds.filter(p => p.stageStatus === "failed").length,
    交付: {
      总数: delivered.length,
      今天交付: delivered.filter(a => dayKey(a.createdAt) === today).length,
      昨天交付: delivered.filter(a => dayKey(a.createdAt) === yest).length,
      已下载: delivered.filter(a => a.status === "已下载" || a.status === "已发布").length,
      未下载: delivered.filter(a => !a.status || a.status === "未下载").length,
      已上传发布链接: delivered.filter(a => a.publishedUrl).length,
      最新5条: delivered.slice(0, 5).map(a => ({ 名称: a.name, 标题: a.title, 状态: a.status, 链接: a.publishedUrl || "" }))
    },
    素材入库: { 今天: assetsToday, 昨天: assetsYest },
    渲染任务: {
      成功: state.jobs.filter(j => visibleProdIds.has(j.productionId) && j.status === "succeeded").length,
      失败: state.jobs.filter(j => visibleProdIds.has(j.productionId) && j.status === "failed").length,
      进行中: state.jobs.filter(j => visibleProdIds.has(j.productionId) && ["queued", "submitted", "running"].includes(j.status)).length
    }
  };
}

/* 离线规则问答（无 LLM Key 时兜底，常见问题直接算） */
function offlineAnswer(q, s) {
  if (/下载|领取/.test(q)) return `已交付 ${s.交付.总数} 个素材：已下载 ${s.交付.已下载} 个、未下载 ${s.交付.未下载} 个${s.交付.已上传发布链接 ? `，其中 ${s.交付.已上传发布链接} 个已上传发布链接` : ""}。`;
  if (/(昨天|今天).*(产出|素材|交付|多少)/.test(q) || /(产出|交付).*(昨天|今天)/.test(q)) {
    return `今天交付 ${s.交付.今天交付} 条、入库素材 ${s.素材入库.今天} 个；昨天交付 ${s.交付.昨天交付} 条、入库素材 ${s.素材入库.昨天} 个。`;
  }
  if (/产量|最高|最多|哪个账号/.test(q)) {
    const top = [...s.账号].sort((a, b) => b.本月交付 - a.本月交付).slice(0, 3);
    return top[0] ? `本月产量前三：${top.map(a => `${a.名称}（${a.本月交付} 条）`).join("、")}。` : "还没有交付记录。";
  }
  if (/审核/.test(q)) return `当前 ${s.待审核} 条内容等待审核${s.失败任务 ? `，另有 ${s.失败任务} 条任务失败待重试` : ""}。`;
  if (/发布|链接|上传/.test(q)) return `供应商已上传发布链接 ${s.交付.已上传发布链接} 条（共交付 ${s.交付.总数} 条）。`;
  if (/失败|出错/.test(q)) return `失败任务 ${s.失败任务} 条；渲染层面：成功 ${s.渲染任务.成功}、失败 ${s.渲染任务.失败}、进行中 ${s.渲染任务.进行中}。`;
  return `当前共 ${s.账号.length} 个账号；任务分布：${Object.entries(s.任务阶段分布).map(([k, v]) => `${k} ${v}`).join("、") || "暂无任务"}；累计交付 ${s.交付.总数} 条（已下载 ${s.交付.已下载}）。可以问我：昨天产出多少素材？供应商下载了多少？哪个账号产量最高？`;
}

function plainAssistantText(value = "") {
  return String(value || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function assistantMessageHtml(value = "") {
  const source = plainAssistantText(value);
  const urlPattern = /https?:\/\/[^\s<>“”"']+/gi;
  let cursor = 0;
  let html = "";
  for (const match of source.matchAll(urlPattern)) {
    const start = match.index || 0;
    html += esc(source.slice(cursor, start)).replace(/\n/g, "<br/>");
    let url = match[0];
    const trailing = url.match(/[，。！？；：,!?;:)”》」]+$/)?.[0] || "";
    if (trailing) url = url.slice(0, -trailing.length);
    html += `<a class="ovc-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${esc(trailing)}`;
    cursor = start + match[0].length;
  }
  html += esc(source.slice(cursor)).replace(/\n/g, "<br/>");
  return html;
}

async function askData(q) {
  const stats = computeStats();
  if (!LLM_CONFIG.apiKey) return plainAssistantText(offlineAnswer(q, stats));
  try {
    const r = await AI.chat([
      { role: "system", content: `你是星阵内容工作台的数据助理，只负责"读数据回答问题"，绝不执行任何操作。只能依据下面这份 JSON 数据回答，数字必须与数据一致，数据里没有的就直说没有。回答用简洁中文，最多 3 行，不用 markdown。\n数据：${JSON.stringify(stats)}` },
      { role: "user", content: q }
    ]);
    return plainAssistantText((r || "").trim() || offlineAnswer(q, stats));
  } catch (e) {
    return plainAssistantText(offlineAnswer(q, stats));
  }
}

const CHAT_SUGS = ["昨天产出了多少素材？", "供应商下载了多少？", "哪个账号本月产量最高？", "还有多少在等审核？"];

function firstAccountImage(accountId) {
  return [...state.assets]
    .filter(a => a.accountId === accountId && a.type === "图片" && !a.delivered)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .find(a => urlFor(a)) || null;
}

function realDeliveryThumb(asset, acc) {
  const packCover = (asset.packAssetIds || []).map(id => assetById(id)).find(a => a && urlFor(a));
  const avatar = acc?.avatarAssetId ? assetById(acc.avatarAssetId) : null;
  const avatarCover = avatar && urlFor(avatar) ? avatar : null;
  const firstImage = firstAccountImage(asset.accountId);
  const cover = packCover || avatarCover || firstImage;
  const u = cover ? urlFor(cover) : "";
  if (u) return `<span class="ovr-cover real"><img src="${esc(u)}" alt="${esc(asset.title || acc?.name || "交付封面")}"/></span>`;
  return `<span class="ovr-cover fallback" style="background:${gradFor(asset.name)}">${asset.type === "图集" ? icon("image", 14) : icon("play", 14)}</span>`;
}

/* ---------- 视图 ---------- */
export const overviewView = {
  render(root) {
    if (["supplier", "supplier_parent"].includes(state.role)) { renderSupplierOverview(root); return; }
    const accounts = state.accounts.filter(Boolean).map(safeAccount);
    const prods = state.productions.filter(ownedBy);
    const inflight = prods.filter(p => p.stage !== "delivered");
    const waiting = inflight.filter(p => p.stageStatus === "needs_input");
    const rendering = inflight.filter(p => (p.stage === "render" || p.stage === "workshop") && p.stageStatus === "running");
    const inReview = inflight.filter(p => p.stage === "review");
    const failed = inflight.filter(p => p.stageStatus === "failed");
    const monthly = accounts.reduce((s, a) => s + (a.monthlyDone || 0), 0);
    const delivered = deliveredAssets();
    const published = delivered.filter(({ asset }) => !!asset.publishedUrl);
    const pendingDl = delivered.filter(x => !x.asset.status || x.asset.status === "未下载").length;
    const links = analyticsRows();
    const analytics = analyticsSummary(links);
    const analyticsByAssetId = new Map(links
      .filter(row => row.asset?.id)
      .map(row => [row.asset.id, row]));
    // 总播放量以供应商逐条保存的 viewCount 为唯一口径。接口快照只补充链接信息，
    // 不能让没有 analyticsLinks 的历史人工回填从总数和明细中消失。
    const viewRows = delivered.map(({ asset, acc }) => {
      const analyticsRow = analyticsByAssetId.get(asset.id);
      const manualViews = Math.max(0, Number(asset.viewCount || 0));
      const manualUpdatedAt = Number(asset.viewsUpdatedAt || 0);
      const hasUpdatedViews = manualUpdatedAt > 0 || manualViews > 0;
      return {
        asset,
        acc,
        link: analyticsRow?.link || (asset.publishedUrl ? {
          url: asset.publishedUrl,
          title: asset.publishedTitle || asset.title || asset.name || "",
          platform: acc?.platform || "未知平台",
          publishedAt: asset.publishedAt || asset.publishedUpdatedAt || 0
        } : null),
        latest: analyticsRow?.latest || null,
        views: manualViews,
        updatedAt: Number(asset.viewsUpdatedAt || asset.publishedUpdatedAt || asset.publishedAt || asset.deliveredAt || asset.createdAt || 0),
        sourceLabel: manualUpdatedAt > 0 ? "供应商填写" : "历史填写",
        hasUpdatedViews
      };
    }).filter(row => row.hasUpdatedViews);
    const totalViews = viewRows.reduce((sum, row) => sum + row.views, 0);
    const totalEngagement = Number(analytics.totalEngagement || 0);
    const fmt = value => Number(value || 0).toLocaleString("zh-CN");
    const memberId = state.ui.currentMemberId || "";
    const remarked = delivered.filter(({ asset }) => (asset.remarks || []).length);
    const unreadRemarks = remarked.filter(({ asset }) => Number(asset.latestRemarkAt || 0) > Number(asset.remarkReadAt?.[memberId] || 0));

    const stat = (key, label, n, sub, accent = "") => `
      <button class="ov-stat card ${accent}" data-ov-stat="${key}">
        <b>${n}</b><span>${label}</span><em>${sub}</em>
      </button>`;

    const taskGroups = {
      todo: { title: "待你处理", items: [...waiting, ...inReview, ...failed], type: "production" },
      waiting: { title: "等待上传", items: waiting, type: "production" },
      rendering: { title: "生成中", items: rendering, type: "production" },
      review: { title: "待审核", items: inReview, type: "production" },
      failed: { title: "失败待重试", items: failed, type: "production" },
      supplier: { title: "供应商待下载", items: delivered.filter(x => !x.asset.status || x.asset.status === "未下载"), type: "delivery" }
    };

    const openTaskGroup = key => {
      const group = taskGroups[key];
      if (!group) return;
      const rows = group.type === "production"
        ? group.items.map(p => {
          const acc = accountById(p.accountId);
          const [status] = statusPill(p);
          return `<div class="overview-task-row">
            <span class="overview-task-main"><b>${esc(p.artifacts?.copy?.title || p.title || p.topic || "未命名任务")}</b><em>${esc(acc?.name || "未命名账号")} · ${esc(groupOf(safeAccount(acc)))} · ${esc(status)}</em></span>
            <time>${timeAgo(p.updatedAt || p.createdAt)}</time>
            <button class="btn primary sm" data-ov-workbench="${p.id}">${icon("arrowRight", 12)} 进入工作台</button>
          </div>`;
        }).join("")
        : group.items.map(({ asset, acc }) => `<div class="overview-task-row">
            <span class="overview-task-main"><b>${esc(asset.title || asset.name || "未命名交付")}</b><em>${esc(acc?.name || "未命名账号")} · ${esc(acc?.platform || "")} · ${esc(asset.status || "未下载")}</em></span>
            <time>${timeAgo(asset.deliveredAt || asset.createdAt)}</time>
            <button class="btn primary sm" data-ov-delivery>${icon("arrowRight", 12)} 去发布清单</button>
          </div>`).join("");
      const html = `<div class="mp-head"><b>${esc(group.title)} · ${group.items.length} 项</b><button class="icon-btn ghost" data-close title="关闭">${icon("x", 15)}</button></div>
        <div class="overview-task-list">${rows || `<div class="overview-task-empty">当前没有${esc(group.title)}任务</div>`}</div>`;
      openModal(html, {
        wide: true,
        onMount(panel, close) {
          panel.classList.add("overview-task-panel");
          panel.addEventListener("click", e => {
            const workbench = e.target.closest("[data-ov-workbench]");
            if (workbench) {
              const p = state.productions.find(x => x.id === workbench.dataset.ovWorkbench);
              if (!p) return;
              state.ui.activeAccountId = p.accountId;
              state.ui.activeProductionId = p.id;
              save("meta");
              close();
              window.setTimeout(() => go("studio", stagePage(p)), 180);
              return;
            }
            if (e.target.closest("[data-ov-delivery]")) {
              close();
              window.setTimeout(() => go("delivery"), 180);
            }
          });
        }
      });
    };
    const todoCount = waiting.length + inReview.length + failed.length;
    const xhsCount = delivered.filter(({ acc }) => acc?.platform === "小红书").length;
    const videoCount = delivered.filter(({ acc }) => acc?.platform === "视频号").length;
    const xhsShare = Math.round(xhsCount / Math.max(1, xhsCount + videoCount) * 100);
    const todayKey = dayKey(Date.now());
    const todayPlatformMap = new Map();
    delivered
      .filter(({ asset }) => dayKey(asset?.deliveredAt || asset?.createdAt) === todayKey)
      .filter(({ acc }) => ["小红书", "视频号"].includes(acc?.platform))
      .forEach(({ acc }) => {
        const key = `${acc.id || acc.name}::${acc.platform}`;
        const current = todayPlatformMap.get(key) || { accountId: acc.id || "", name: acc.name || "未命名账号", platform: acc.platform, count: 0 };
        current.count += 1;
        todayPlatformMap.set(key, current);
      });
    const todayPlatformRows = [...todayPlatformMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
    const todayPlatformSummary = platform => {
      const rows = todayPlatformRows.filter(item => item.platform === platform);
      const preview = rows.slice(0, 6).map(item => `${item.name} ${item.count} 条`);
      return {
        rows,
        tooltip: preview.length
          ? `今日${platform}交付 · ${preview.join("；")}${rows.length > 6 ? "；… 点击查看全部" : ""}`
          : `今日暂无${platform}交付`
      };
    };
    const todayXhs = todayPlatformSummary("小红书");
    const todayVideo = todayPlatformSummary("视频号");
    let trendModel = overviewTrendModel(delivered);
    let { recentDays, trendPoints, trendCurve, trendChartWidth, trendArea } = trendModel;
    const accountPerformance = analytics.accounts.length
      ? analytics.accounts.map(item => ({
        ...item,
        accountId: links.find(row => row.acc?.name === item.name)?.acc?.id || accounts.find(account => account.name === item.name)?.id || ""
      }))
      : accounts.slice()
        .sort((a, b) => (b.monthlyDone || 0) - (a.monthlyDone || 0))
        .map(acc => ({ id: acc.id, accountId: acc.id, name: acc.name, count: acc.monthlyDone || 0, engagement: 0 }));
    const accountPages = Array.from({ length: Math.max(1, Math.ceil(accountPerformance.length / 4)) }, (_, page) => accountPerformance.slice(page * 4, page * 4 + 4));
    accountCarouselPage %= accountPages.length;
    const accountAvatarHtml = item => {
      const account = accounts.find(candidate => candidate.id === item.accountId) || accounts.find(candidate => candidate.name === item.name);
      const avatarUrl = account?.avatarAssetId ? urlFor(account.avatarAssetId) : (account?.avatarUrl || "");
      return `<span class="overview-account-avatar">${avatarUrl ? `<img src="${esc(avatarUrl)}" alt=""/>` : `<i>${esc(String(item.name || "账").trim().slice(0, 1) || "账")}</i>`}</span>`;
    };
    const accountPageHtml = page => (accountPages[page] || []).map((item, index) => `<button data-overview-account="${esc(item.name)}" data-overview-account-id="${esc(item.accountId || "")}">${accountAvatarHtml(item)}<span><b><i>${page * 4 + index + 1}</i>${esc(item.name)}</b><em>${item.count || 0} 条 · ${fmt(item.engagement || 0)} 互动</em></span></button>`).join("") || `<p>暂无账号数据</p>`;

    let refreshOverviewTrend = () => render(root);
    const openDataDetail = (key, accountName = "", initialRecentFilter = null, accountId = "", platform = "") => {
      if (["todo", "waiting", "rendering", "review", "failed", "supplier"].includes(key)) { openTaskGroup(key); return; }
      const metricText = row => {
        const m = row?.latest?.metrics || {};
        return `播放 ${fmt(m.views)} · 赞 ${fmt(m.likes)} · 藏 ${fmt(m.collects)} · 评 ${fmt(m.comments)}${Number(m.shares || 0) ? ` · 分享 ${fmt(m.shares)}` : ""}`;
      };
      const makeRow = (title, meta, action = "", metrics = "") => `<div class="overview-task-row${metrics ? " has-metrics" : ""}"><span class="overview-task-main"><b>${esc(title)}</b><em>${esc(meta)}</em>${metrics ? `<small>${esc(metrics)}</small>` : ""}</span>${action}</div>`;
      let title = "数据详情";
      let rows = "";
      let recentFilter = null;
      let recentDetailHtml = null;
      let viewFilter = null;
      let viewDetailHtml = null;
      if (key === "todayPlatforms") {
        const platformRows = platform ? todayPlatformRows.filter(item => item.platform === platform) : todayPlatformRows;
        title = platform ? `今日${platform}交付 · ${platformRows.length} 个账号` : `今日平台交付 · ${platformRows.length} 个账号`;
        rows = platformRows.map(item => makeRow(
          item.name,
          `${item.platform} · 今日交付 ${item.count} 条`
        )).join("") || `<div class="overview-task-empty">今日暂无${platform || "小红书或视频号"}交付</div>`;
      } else if (key === "recent" || key === "published") {
        const isPublished = key === "published";
        const source = isPublished ? published : delivered;
        const dayOptions = recentDays.slice().reverse();
        const monthOptions = [...new Set(source
          .map(({ asset }) => dayKey(asset?.deliveredAt || asset?.createdAt || 0).slice(0, 7))
          .filter(value => /^\d{4}-\d{2}$/.test(value)))].slice(0, 6);
        const weekOptions = [...new Map(source.map(({ asset }) => {
          const time = asset?.publishedUpdatedAt || asset?.publishedAt || asset?.deliveredAt || asset?.createdAt || 0;
          const range = weekRange(time);
          return [range.key, range];
        })).values()].sort((a, b) => b.key.localeCompare(a.key)).slice(0, 8);
        const allowedFilters = isPublished ? new Set(["day", "week"]) : new Set(["day", "month", "range"]);
        recentFilter = allowedFilters.has(initialRecentFilter?.type)
          ? initialRecentFilter
          : { type: "all", value: "" };
        recentDetailHtml = () => {
          const scoped = source.filter(({ asset }) => {
            const time = isPublished
              ? (asset?.publishedUpdatedAt || asset?.publishedAt || asset?.deliveredAt || asset?.createdAt || 0)
              : (asset?.deliveredAt || asset?.createdAt || 0);
            const date = dayKey(time);
            if (recentFilter.type === "day") return date === recentFilter.value;
            if (recentFilter.type === "month") return date.startsWith(recentFilter.value);
            if (recentFilter.type === "range") return (!recentFilter.start || date >= recentFilter.start) && (!recentFilter.end || date <= recentFilter.end);
            if (recentFilter.type === "week") return weekRange(time).key === recentFilter.value;
            return true;
          });
          const filterButton = (type, value, label) => `<button type="button" class="overview-detail-filter${recentFilter.type === type && recentFilter.value === value ? " is-active" : ""}" data-recent-filter-type="${type}" data-recent-filter-value="${esc(value)}">${esc(label)}</button>`;
          const dayFilters = dayOptions.map(item => filterButton("day", item.key, item.label)).join("");
          const monthFilters = monthOptions.map(value => filterButton("month", value, `${Number(value.slice(5))} 月`)).join("");
          const weekFilters = weekOptions.map(item => filterButton("week", item.key, item.label)).join("");
          const list = scoped.slice(0, 50).map(({ asset, acc }) => makeRow(
            asset.title || asset.name || "未命名交付",
            `${acc?.name || "未命名账号"} · ${isPublished ? "已发布" : (asset.status || "未下载")} · ${timeAgo(isPublished ? (asset.publishedUpdatedAt || asset.publishedAt || asset.deliveredAt || asset.createdAt) : (asset.deliveredAt || asset.createdAt))}`,
            asset.productionId ? `<button class="btn ghost sm" data-ov-prod="${esc(asset.productionId)}">查看</button>` : ""
          )).join("");
          const secondary = isPublished
            ? `<div><b>按周</b><span class="overview-detail-filter-tags">${weekFilters || `<em>暂无周发布</em>`}</span></div>`
            : `<div><b>按月份</b><span class="overview-detail-filter-tags">${monthFilters || `<em>暂无月度交付</em>`}</span></div>`;
          const customRange = !isPublished ? `<div class="overview-detail-custom-range"><b>自定义时间</b><label>开始<input type="date" data-recent-custom-date="start" value="${esc(recentFilter.start || "")}"/></label><label>结束<input type="date" data-recent-custom-date="end" value="${esc(recentFilter.end || "")}"/></label><button class="btn primary sm" type="button" data-apply-overview-trend-range>应用到趋势图</button></div>` : "";
          const scopeLabel = recentFilter.type === "all"
            ? (isPublished ? "全部发布" : "全部交付")
            : recentFilter.type === "month" ? `${recentFilter.value} 月`
              : recentFilter.type === "week" ? `本周起始 ${recentFilter.value}`
                : recentFilter.type === "range" ? `${recentFilter.start || "开始"} 至 ${recentFilter.end || "今天"}` : recentFilter.value;
          return `<section class="overview-detail-filter-section"><div><b>按日期</b><span class="overview-detail-filter-tags">${filterButton("all", "", "全部")}${dayFilters}</span></div>${secondary}${customRange}</section><div class="overview-detail-summary">${scopeLabel} · ${scoped.length} 条</div><div class="overview-task-list">${list || `<div class="overview-task-empty">该时间范围暂无${isPublished ? "发布" : "交付"}</div>`}</div>`;
        };
        title = isPublished ? "发布数量明细" : "交付明细";
        rows = `<div data-recent-detail-content>${recentDetailHtml()}</div>`;
      } else if (key === "views") {
        const platforms = [...new Set(viewRows.map(row => row.link?.platform || row.acc?.platform || "未知平台"))];
        viewFilter = { platform: "all", period: "all", start: "", end: "" };
        viewDetailHtml = () => {
          const now = Date.now();
          const scoped = viewRows.filter(row => {
            const platformName = row.link?.platform || row.acc?.platform || "未知平台";
            const date = dayKey(row.updatedAt || row.asset?.viewsUpdatedAt || row.asset?.publishedAt || row.asset?.deliveredAt || 0);
            if (viewFilter.platform !== "all" && platformName !== viewFilter.platform) return false;
            if (viewFilter.period === "7") return row.updatedAt >= now - 7 * 864e5;
            if (viewFilter.period === "30") return row.updatedAt >= now - 30 * 864e5;
            if (viewFilter.period === "custom") return (!viewFilter.start || date >= viewFilter.start) && (!viewFilter.end || date <= viewFilter.end);
            return true;
          });
          const total = scoped.reduce((sum, row) => sum + row.views, 0);
          const filterButton = (kind, value, label) => `<button type="button" class="overview-detail-filter${viewFilter[kind] === value ? " is-active" : ""}" data-view-filter-kind="${esc(kind)}" data-view-filter-value="${esc(value)}">${esc(label)}</button>`;
          const platformButtons = [filterButton("platform", "all", "全部平台"), ...platforms.map(platformName => filterButton("platform", platformName, platformName))].join("");
          const periodButtons = [filterButton("period", "all", "全部时间"), filterButton("period", "7", "近 7 天"), filterButton("period", "30", "近 30 天")].join("");
          const list = scoped.map(row => {
            const platformName = row.link?.platform || row.acc?.platform || "未知平台";
            const updated = row.updatedAt ? timeAgo(row.updatedAt) : "暂无更新时间";
            const sourceMetrics = `播放 ${fmt(row.views)} · ${row.sourceLabel}`;
            return makeRow(
              row.link?.title || row.asset?.title || row.asset?.name || "未命名内容",
              `${row.acc?.name || "未命名账号"} · ${platformName} · ${row.sourceLabel} · ${updated}`,
              row.link?.url
                ? `<a class="btn ghost sm" href="${esc(row.link.url)}" target="_blank" rel="noopener noreferrer">查看链接</a>`
                : `<span class="overview-detail-muted">未填写回传链接</span>`,
              sourceMetrics
            );
          }).join("");
          const scopeLabel = viewFilter.period === "all" ? "全部时间" : viewFilter.period === "custom" ? `${viewFilter.start || "开始"} 至 ${viewFilter.end || "今天"}` : `近 ${viewFilter.period} 天`;
          return `<section class="overview-detail-filter-section"><div><b>按平台</b><span class="overview-detail-filter-tags">${platformButtons}</span></div><div><b>按日期</b><span class="overview-detail-filter-tags">${periodButtons}</span></div><div class="overview-detail-custom-range"><b>自定义时间</b><label>开始<input type="date" data-view-custom-date="start" value="${esc(viewFilter.start)}"/></label><label>结束<input type="date" data-view-custom-date="end" value="${esc(viewFilter.end)}"/></label><button class="overview-detail-filter${viewFilter.period === "custom" ? " is-active" : ""}" type="button" data-view-filter-kind="period" data-view-filter-value="custom">应用</button></div></section><div class="overview-detail-summary">${scopeLabel} · ${scoped.length} 条供应商填写记录 · 播放 ${fmt(total)}</div><div class="overview-task-list">${list || `<div class="overview-task-empty">该筛选范围没有供应商填写的播放量</div>`}</div>`;
        };
        title = `总播放量明细 · ${viewRows.length} 条供应商填写记录`;
        rows = `<div data-view-detail-content>${viewDetailHtml()}</div>`;
      } else if (key === "links") {
        title = `回传链接 · ${links.length} 条`;
        rows = links.slice(0, 40).map(row => makeRow(
          row.link.title || row.asset?.title || row.asset?.name || "未命名内容",
          `${row.acc?.name || "未命名账号"} · ${row.link.platform || row.acc?.platform || "未知平台"} · ${row.latest ? "已有数据快照" : "仅回链"}`,
          row.link.url ? `<a class="btn ghost sm" href="${esc(row.link.url)}" target="_blank" rel="noopener noreferrer">打开链接</a>` : "",
          row.latest ? metricText(row) : "等待数据快照"
        )).join("");
      } else if (key === "remarks") {
        title = `发布沟通 · ${remarked.length} 条有备注`;
        rows = remarked.slice(0, 30).map(({ asset, acc }) => makeRow(asset.title || asset.name || "未命名交付", `${acc?.name || "未命名账号"} · ${(asset.remarks || []).length} 条消息${Number(asset.latestRemarkAt || 0) > Number(asset.remarkReadAt?.[memberId] || 0) ? " · 有未读" : ""}`, `<button class="btn ghost sm" data-ov-remarks="${esc(asset.id)}">查看沟通</button>`)).join("");
      } else if (key === "dataQuality") {
        const pendingRows = links.filter(row => !row.latest);
        title = `数据完整度 · ${analytics.synced}/${links.length}`;
        rows = pendingRows.slice(0, 40).map(row => makeRow(
          row.link.title || row.asset?.title || row.asset?.name || "未命名内容",
          `${row.acc?.name || "未命名账号"} · ${row.link.status === "failed" ? "同步失败" : "等待快照"}`,
          row.link.url ? `<a class="btn ghost sm" href="${esc(row.link.url)}" target="_blank" rel="noopener noreferrer">查看链接</a>` : ""
        )).join("");
      } else {
        const accountRows = accountName ? links.filter(row => (row.acc?.name || "未归属账号") === accountName) : links;
        const scoped = accountRows.filter(row => row.latest);
        const sum = field => scoped.reduce((total, row) => total + Number(row.latest?.metrics?.[field] || 0), 0);
        const account = accountId ? accounts.find(item => item.id === accountId) : accounts.find(item => item.name === accountName);
        const homepageUrl = account?.homepageUrl || "";
        const homepageAction = accountName ? `<div class="overview-account-detail-actions">${homepageUrl ? `<a class="btn primary sm" href="${esc(homepageUrl)}" target="_blank" rel="noopener noreferrer">${icon("link", 12)} 跳转主页</a>` : `<button class="btn ghost sm" type="button" disabled title="该账号尚未填写主页链接">${icon("link", 12)} 跳转主页</button>`}</div>` : "";
        title = accountName ? `${accountName} · 账号表现` : "互动与账号表现";
        rows = homepageAction + `<div class="overview-detail-metrics">
          <span><em>内容</em><b>${accountRows.length}</b></span><span><em>播放</em><b>${fmt(sum("views"))}</b></span>
          <span><em>点赞</em><b>${fmt(sum("likes"))}</b></span><span><em>收藏</em><b>${fmt(sum("collects"))}</b></span>
          <span><em>评论</em><b>${fmt(sum("comments"))}</b></span><span><em>分享</em><b>${fmt(sum("shares"))}</b></span>
        </div>` + accountRows.slice(0, 40).map(row => makeRow(
          row.link.title || row.asset?.title || row.asset?.name || "未命名内容",
          `${row.acc?.name || "未命名账号"} · ${row.link.platform || row.acc?.platform || "未知平台"}`,
          row.link.url ? `<a class="btn ghost sm" href="${esc(row.link.url)}" target="_blank" rel="noopener noreferrer">打开</a>` : "",
          row.latest ? metricText(row) : "暂无数据快照"
        )).join("");
      }
      openModal(`<div class="mp-head"><b>${esc(title)}</b><button class="icon-btn ghost" data-close title="关闭">${icon("x", 15)}</button></div><div class="overview-task-list">${rows || `<div class="overview-task-empty">暂无可展示的数据</div>`}</div>`, {
        wide: true,
        onMount(panel, close) {
          panel.classList.add("overview-task-panel");
          panel.addEventListener("click", event => {
            const viewFilterButton = event.target.closest("[data-view-filter-kind]");
            if (key === "views" && viewFilterButton && viewFilter && viewDetailHtml) {
              viewFilter = { ...viewFilter, [viewFilterButton.dataset.viewFilterKind]: viewFilterButton.dataset.viewFilterValue || "all" };
              const target = panel.querySelector("[data-view-detail-content]");
              if (target) target.innerHTML = viewDetailHtml();
              return;
            }
            const recentFilterButton = event.target.closest("[data-recent-filter-type]");
            if (["recent", "published"].includes(key) && recentFilterButton && recentFilter && recentDetailHtml) {
              recentFilter = {
                type: recentFilterButton.dataset.recentFilterType,
                value: recentFilterButton.dataset.recentFilterValue || ""
              };
              const target = panel.querySelector("[data-recent-detail-content]");
              if (target) target.innerHTML = recentDetailHtml();
              return;
            }
            const prodButton = event.target.closest("[data-ov-prod]");
            if (prodButton) { close(); window.setTimeout(() => openProductionDrawer(prodButton.dataset.ovProd), 180); }
            const remarksButton = event.target.closest("[data-ov-remarks]");
            if (remarksButton) {
              const asset = assetById(remarksButton.dataset.ovRemarks);
              if (asset) { close(); window.setTimeout(() => openDeliveryRemarks(asset), 160); }
            }
            const routeButton = event.target.closest("[data-ov-route]");
            if (routeButton) { close(); window.setTimeout(() => go(routeButton.dataset.ovRoute), 180); }
            const applyTrendRange = event.target.closest("[data-apply-overview-trend-range]");
            if (applyTrendRange && recentFilter?.start && recentFilter?.end) {
              if (recentFilter.start > recentFilter.end) return;
              overviewTrendWindow = { kind: "custom", days: 0, start: recentFilter.start, end: recentFilter.end };
              close();
              refreshOverviewTrend();
            }
          });
          panel.addEventListener("change", event => {
            const viewDate = event.target.closest("[data-view-custom-date]");
            if (key === "views" && viewDate && viewFilter && viewDetailHtml) {
              viewFilter = { ...viewFilter, [viewDate.dataset.viewCustomDate]: viewDate.value };
              const target = panel.querySelector("[data-view-detail-content]");
              if (target) target.innerHTML = viewDetailHtml();
              return;
            }
            const input = event.target.closest("[data-recent-custom-date]");
            if (!input || !recentFilter || !recentDetailHtml) return;
            recentFilter = { ...recentFilter, type: "range", [input.dataset.recentCustomDate]: input.value };
            const target = panel.querySelector("[data-recent-detail-content]");
            if (target) target.innerHTML = recentDetailHtml();
          });
        }
      });
    };

    root.innerHTML = `<div class="overview overview-dashboard overview-integrated">
      <div class="overview-dashboard-layout">
        <main class="overview-dashboard-main">
          <section class="overview-kpi-strip" aria-label="关键指标">
            <button class="overview-kpi-card" data-overview-detail="published"><span>发布数量</span><b>${fmt(published.length)}</b><em>${published.filter(({ asset }) => dayKey(asset.publishedUpdatedAt || asset.publishedAt || 0) === dayKey(Date.now())).length} 条今日发布</em></button>
            <button class="overview-kpi-card" data-overview-detail="interactions"><span>总互动</span><b>${fmt(totalEngagement)}</b><em>赞、藏、评与分享</em></button>
            <button class="overview-kpi-card" data-overview-detail="views"><span>总播放量</span><b>${fmt(totalViews)}</b><em>${viewRows.length} 条供应商填写记录</em></button>
            <button class="overview-kpi-card" data-overview-detail="recent"><span>累计交付</span><b>${fmt(delivered.length)}</b><em>${pendingDl} 条供应商待下载</em></button>
          </section>
          <section class="overview-viz-grid">
            <article class="overview-viz-card overview-donut-card" aria-label="平台分布，悬停或聚焦扇区查看今日账号交付，点击查看对应平台明细">
              <header><b>平台分布</b><em>${delivered.length} 条交付</em></header>
              <div class="overview-donut-wrap"><span class="overview-donut" style="--share:${xhsShare}%"><svg viewBox="0 0 140 140" aria-hidden="true"><circle class="overview-donut-track" cx="70" cy="70" r="51" pathLength="100"/><circle class="overview-donut-segment is-xhs" cx="70" cy="70" r="51" pathLength="100" style="--segment:${xhsShare};--offset:0" data-overview-detail="todayPlatforms" data-overview-platform="小红书" data-chart-tip="${esc(todayXhs.tooltip)}" tabindex="0" role="button" aria-label="小红书 ${xhsCount} 条交付，查看今日小红书交付明细"/><circle class="overview-donut-segment is-video" cx="70" cy="70" r="51" pathLength="100" style="--segment:${100 - xhsShare};--offset:${-xhsShare}" data-overview-detail="todayPlatforms" data-overview-platform="视频号" data-chart-tip="${esc(todayVideo.tooltip)}" tabindex="0" role="button" aria-label="视频号 ${videoCount} 条交付，查看今日视频号交付明细"/></svg><i><b>${delivered.length}</b><em>总交付</em></i></span><div><p><i class="is-dark"></i>小红书 <b>${xhsCount}</b></p><p><i></i>视频号 <b>${videoCount}</b></p></div></div>
            </article>
            <article class="overview-viz-card overview-trend-card">${overviewTrendCardContent(trendModel)}</article>
          </section>
          <section class="overview-action-grid">
            <button class="overview-action-card" data-overview-detail="todo"><span class="overview-action-icon is-check">${icon("checkCircle", 16)}</span><div><b>待你处理</b><em>${todoCount} 项 · 审核 ${inReview.length} / 失败 ${failed.length}</em></div><strong>${todoCount}</strong></button>
            <button class="overview-action-card" data-overview-detail="interactions"><span class="overview-action-icon is-pulse">${icon("pulse", 16)}</span><div><b>互动构成</b><em>逐条查看赞、藏、评与播放</em></div><strong>${fmt(totalEngagement)}</strong></button>
            <button class="overview-action-card" data-overview-detail="remarks"><span class="overview-action-icon is-note">${icon("fileText", 16)}</span><div><b>发布沟通</b><em>${unreadRemarks.length} 条有未读消息</em></div><strong>${remarked.length}</strong></button>
            <button class="overview-action-card" data-overview-detail="dataQuality"><span class="overview-action-icon is-link">${icon("link", 16)}</span><div><b>数据完整度</b><em>${analytics.pending} 条等待快照</em></div><strong>${analytics.synced}/${links.length}</strong></button>
          </section>
          <section class="overview-account-strip"><header><b>账号表现</b><em>${accountPerformance.length > 4 ? "每 4 秒切换下一组账号" : "点击查看逐条数据"}</em></header><div class="overview-account-viewport" data-account-carousel><div class="overview-account-page">${accountPageHtml(accountCarouselPage)}</div></div></section>
        </main>
        <aside class="overview-dashboard-assistant"><section class="ov-chat" id="ovChat"><div class="ovc-head"><span class="ovc-ava">${agentAvatar(24)}</span><div><b>星阵数据助手</b><em>独立问答区 · 只读真实数据</em></div></div><div class="ovc-msgs" id="ovcMsgs"></div><div class="ovc-input"><input id="ovcInput" name="overviewDataQuestion" autocomplete="off" aria-label="向数据助手提问" placeholder="问问数据：昨天产出多少素材？" /><button class="ovc-send" id="ovcSend" type="button" title="发送" aria-label="发送数据问题">${icon("send", 15)}</button></div></section></aside>
      </div>
      <div class="overview-chart-tooltip" id="overviewChartTooltip" role="status" aria-live="polite"></div>
    </div>`;

    root.querySelectorAll("[data-overview-detail]").forEach(button => {
      const openDetail = event => {
        event?.preventDefault();
        event?.stopPropagation();
        openDataDetail(button.dataset.overviewDetail, "", null, "", button.dataset.overviewPlatform || "");
      };
      button.addEventListener("click", openDetail);
      if (button.getAttribute("role") === "button") {
        button.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") openDetail(event);
        });
      }
    });
    const wireAccountButtons = host => host.querySelectorAll("[data-overview-account]").forEach(button => button.addEventListener("click", () => openDataDetail("interactions", button.dataset.overviewAccount, null, button.dataset.overviewAccountId || "")));
    wireAccountButtons(root);
    const chartTooltip = $("#overviewChartTooltip", root);
    const hideChartTooltip = () => chartTooltip?.classList.remove("is-visible");
    const showChartTooltip = target => {
      if (!chartTooltip || !target?.dataset.chartTip) return;
      const rect = target.getBoundingClientRect();
      chartTooltip.textContent = target.dataset.chartTip;
      chartTooltip.style.left = `${Math.min(window.innerWidth - 16, Math.max(16, rect.left + rect.width / 2))}px`;
      chartTooltip.style.top = `${Math.max(12, rect.top - 10)}px`;
      chartTooltip.classList.add("is-visible");
    };
    const wireOverviewTrend = () => {
      const chart = root.querySelector(".overview-trend-card");
      if (!chart) return;
      const range = { type: "range", start: trendModel.recentDays[0]?.key || "", end: trendModel.recentDays.at(-1)?.key || "" };
      chart.querySelectorAll("[data-overview-trend-window]").forEach(button => button.addEventListener("click", () => {
        const next = button.dataset.overviewTrendWindow;
        if (next === "custom") return openDataDetail("recent", "", { type: "range", start: overviewTrendWindow.start || range.start, end: overviewTrendWindow.end || range.end });
        overviewTrendWindow = { kind: "days", days: Number(next), start: "", end: "" };
        refreshOverviewTrend();
      }));
      chart.querySelector("[data-overview-trend-detail]")?.addEventListener("click", () => openDataDetail("recent", "", range));
      chart.querySelectorAll("[data-trend-date]").forEach(target => {
        const openTrendDate = event => { event.preventDefault(); event.stopPropagation(); openDataDetail("recent", "", { type: "day", value: target.dataset.trendDate }); };
        target.addEventListener("click", openTrendDate);
        target.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") openTrendDate(event); });
      });
      const trendScroller = chart.querySelector("[data-trend-scroll]");
      chart.querySelectorAll("[data-trend-scroll-by]").forEach(button => button.addEventListener("click", () => trendScroller?.scrollBy({ left: Number(button.dataset.trendScrollBy || 0), behavior: "smooth" })));
      chart.querySelectorAll("[data-chart-tip]").forEach(target => {
        target.addEventListener("pointerenter", () => showChartTooltip(target));
        target.addEventListener("pointerleave", hideChartTooltip);
        target.addEventListener("focus", () => showChartTooltip(target));
        target.addEventListener("blur", hideChartTooltip);
      });
    };
    refreshOverviewTrend = () => {
      const chart = root.querySelector(".overview-trend-card");
      if (!chart) return;
      trendModel = overviewTrendModel(delivered);
      ({ recentDays, trendPoints, trendCurve, trendChartWidth, trendArea } = trendModel);
      chart.innerHTML = overviewTrendCardContent(trendModel);
      chart.classList.remove("is-trend-switching");
      void chart.offsetWidth;
      chart.classList.add("is-trend-switching");
      wireOverviewTrend();
    };
    wireOverviewTrend();

    window.clearInterval(accountCarouselTimer);
    window.clearTimeout(accountCarouselTransitionTimer);
    accountCarouselTimer = null;
    accountCarouselTransitionTimer = null;
    const accountCarousel = root.querySelector("[data-account-carousel]");
    const rotateAccounts = () => {
      if (!accountCarousel || accountPages.length < 2) return;
      const page = accountCarousel.querySelector(".overview-account-page");
      if (!page) return;
      page.classList.add("is-switching");
      accountCarouselTransitionTimer = window.setTimeout(() => {
        accountCarouselPage = (accountCarouselPage + 1) % accountPages.length;
        page.innerHTML = accountPageHtml(accountCarouselPage);
        wireAccountButtons(page);
        page.classList.remove("is-switching");
        accountCarouselTransitionTimer = null;
      }, 150);
    };
    if (accountPages.length > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      accountCarouselTimer = window.setInterval(rotateAccounts, 4200);
    }
    root.__viewCleanup = () => {
      window.clearInterval(accountCarouselTimer);
      window.clearTimeout(accountCarouselTransitionTimer);
      accountCarouselTimer = null;
      accountCarouselTransitionTimer = null;
    };

    root.querySelectorAll("[data-ov-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.ovGo)));
    root.querySelectorAll("[data-ov-stat]").forEach(b => b.addEventListener("click", () => openTaskGroup(b.dataset.ovStat)));
    root.querySelectorAll("[data-prod]").forEach(b => b.addEventListener("click", () => openProductionDrawer(b.dataset.prod)));
    root.querySelectorAll("[data-acc]").forEach(b => b.addEventListener("click", () => {
      state.ui.activeAccountId = b.dataset.acc; save("meta");
      go("studio");
    }));
    /* 数据问答 */
    const msgsEl = $("#ovcMsgs", root);
    const inputEl = $("#ovcInput", root);
    const drawChat = () => {
      msgsEl.innerHTML = chatLog.length
        ? chatLog.map(m => `<div class="ovc-bubble ${m.role}">${assistantMessageHtml(m.text)}</div>`).join("") + (chatBusy ? `<div class="ovc-bubble agent typing"><i></i><i></i><i></i></div>` : "")
        : `<div class="ovc-sugs">${CHAT_SUGS.map(q => `<button class="chip" data-ovq="${esc(q)}">${esc(q)}</button>`).join("")}</div>`;
      msgsEl.scrollTop = msgsEl.scrollHeight;
      msgsEl.querySelectorAll("[data-ovq]").forEach(b => b.addEventListener("click", () => { inputEl.value = b.dataset.ovq; send(); }));
    };
    const send = async () => {
      const q = inputEl.value.trim();
      if (!q || chatBusy) return;
      inputEl.value = "";
      chatLog.push({ role: "user", text: q });
      if (chatLog.length > 20) chatLog = chatLog.slice(-20);
      chatBusy = true;
      drawChat();
      const a = await askData(q);
      chatBusy = false;
      chatLog.push({ role: "agent", text: plainAssistantText(a) });
      drawChat();
    };
    $("#ovcSend", root).addEventListener("click", send);
    inputEl.addEventListener("keydown", e => { if (e.key === "Enter") send(); });
    drawChat();
  }
};
