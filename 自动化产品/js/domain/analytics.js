/* 小红书数据闭环：链接登记、指标快照、复盘报告、创作记忆 */

import { uid } from "../core/util.js";
import { state, save, notify, accountById, assetById, productionById } from "../core/store.js";
import { analyticsApi } from "../api/analytics.js";

export function platformFromUrl(url, fallback = "") {
  const s = String(url || "").toLowerCase();
  if (/xiaohongshu|xhslink|xhs/.test(s)) return "小红书";
  if (/weixin|channels/.test(s)) return "视频号";
  if (/douyin|iesdouyin/.test(s)) return "抖音";
  return fallback || "未知平台";
}

export function isAnalyticsSupported(url, platform = "") {
  return platformFromUrl(url, platform) === "小红书";
}

export function linkByAsset(assetId) {
  return state.analyticsLinks.find(x => x.assetId === assetId) || null;
}

export function snapshotsOf(linkId) {
  return state.metricSnapshots
    .filter(x => x.linkId === linkId)
    .sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0));
}

export function latestSnapshot(linkId) {
  const list = snapshotsOf(linkId);
  return list[list.length - 1] || null;
}

export function ensureAnalyticsForAsset(asset, acc = null) {
  if (!asset?.publishedUrl) return null;
  const account = acc || accountById(asset.accountId);
  const platform = platformFromUrl(asset.publishedUrl, account?.platform);
  let link = linkByAsset(asset.id) || state.analyticsLinks.find(x => x.url === asset.publishedUrl);
  const base = {
    url: asset.publishedUrl,
    platform,
    accountId: asset.accountId || account?.id || null,
    productionId: asset.productionId || null,
    assetId: asset.id,
    title: asset.publishedTitle || asset.title || asset.name || "",
    tags: asset.tags || [],
    publishedAt: asset.publishedAt || asset.deliveredAt || Date.now()
  };
  if (link) {
    Object.assign(link, base, { updatedAt: Date.now(), status: link.status || "pending" });
  } else {
    link = {
      id: uid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      noteId: "",
      status: isAnalyticsSupported(asset.publishedUrl, platform) ? "pending" : "unsupported",
      error: "",
      source: "supplier-return",
      ...base
    };
    state.analyticsLinks.unshift(link);
  }
  save("analyticsLinks");
  return link;
}

export function syncExistingPublishedAssets() {
  let n = 0;
  state.assets.forEach(asset => {
    if (!asset.publishedUrl) return;
    const before = linkByAsset(asset.id);
    const link = ensureAnalyticsForAsset(asset);
    if (link && !before) n++;
  });
  if (n) notify("analytics", "已同步历史发布链接", `${n} 条已进入数据分析池`);
  return n;
}

export async function refreshAnalyticsLink(linkId) {
  const link = state.analyticsLinks.find(x => x.id === linkId);
  if (!link) return null;
  if (!isAnalyticsSupported(link.url, link.platform)) {
    link.status = "unsupported";
    link.error = "当前仅内置小红书数据检测适配器";
    link.updatedAt = Date.now();
    save("analyticsLinks");
    return null;
  }
  link.status = "syncing";
  link.error = "";
  link.updatedAt = Date.now();
  save("analyticsLinks");
  try {
    const resolved = await analyticsApi.resolve(link.url);
    link.noteId = resolved.noteId || link.noteId;
    link.canonicalUrl = resolved.canonicalUrl || link.url;
    link.title = resolved.title || link.title;
    link.provider = resolved.provider || link.provider || "server";
    const prev = latestSnapshot(link.id)?.metrics || null;
    const data = await analyticsApi.fetchMetrics(link, prev);
    link.title = data.title || link.title;
    const snap = {
      id: uid(),
      linkId: link.id,
      assetId: link.assetId,
      accountId: link.accountId,
      productionId: link.productionId,
      provider: data.provider || "server",
      noteId: data.noteId || link.noteId,
      fetchedAt: data.fetchedAt || Date.now(),
      metrics: normalizeMetrics(data.metrics),
      commentsSample: data.commentsSample || [],
      raw: data.raw || null
    };
    state.metricSnapshots.push(snap);
    link.status = "synced";
    link.lastSnapshotId = snap.id;
    link.lastSyncedAt = snap.fetchedAt;
    link.updatedAt = Date.now();
    save("analyticsLinks", "metricSnapshots");
    return snap;
  } catch (e) {
    link.status = "failed";
    link.error = e.message || String(e);
    link.updatedAt = Date.now();
    save("analyticsLinks");
    return null;
  }
}

function normalizeMetrics(m = {}) {
  const views = Number(m.views || m.reads || m.impressions || 0);
  const likes = Number(m.likes || m.like || 0);
  const collects = Number(m.collects || m.favorites || m.favs || 0);
  const comments = Number(m.comments || m.comment || 0);
  const shares = Number(m.shares || m.share || 0);
  const engagementRate = Number.isFinite(m.engagementRate) ? m.engagementRate : (views ? (likes + collects + comments + shares) / views : 0);
  const qualityScore = Number.isFinite(m.qualityScore) ? m.qualityScore : Math.round(Math.min(96, Math.max(30, engagementRate * 520 + Math.log10(views + 10) * 12)));
  return { views, likes, collects, comments, shares, engagementRate, qualityScore };
}

export async function refreshAllAnalytics({ staleOnly = false } = {}) {
  const now = Date.now();
  const targets = state.analyticsLinks.filter(l => {
    if (!isAnalyticsSupported(l.url, l.platform)) return false;
    if (!staleOnly) return true;
    return !l.lastSyncedAt || now - l.lastSyncedAt > 3 * 3600_000;
  });
  let ok = 0;
  for (const link of targets) {
    const snap = await refreshAnalyticsLink(link.id);
    if (snap) ok++;
  }
  return { total: targets.length, ok };
}

export function analyticsRows() {
  return state.analyticsLinks.map(link => {
    const asset = assetById(link.assetId);
    const acc = accountById(link.accountId);
    const prod = productionById(link.productionId);
    const snaps = snapshotsOf(link.id);
    const latest = snaps[snaps.length - 1] || null;
    const first = snaps[0] || null;
    const growth = first && latest && first.id !== latest.id ? {
      views: latest.metrics.views - first.metrics.views,
      likes: latest.metrics.likes - first.metrics.likes,
      collects: latest.metrics.collects - first.metrics.collects,
      comments: latest.metrics.comments - first.metrics.comments
    } : { views: 0, likes: 0, collects: 0, comments: 0 };
    return { link, asset, acc, prod, latest, first, growth, snapshots: snaps };
  }).sort((a, b) => (b.link.publishedAt || b.link.createdAt || 0) - (a.link.publishedAt || a.link.createdAt || 0));
}

export function analyticsSummary(rows = analyticsRows()) {
  const synced = rows.filter(r => r.latest);
  const sum = (key) => synced.reduce((n, r) => n + (r.latest.metrics[key] || 0), 0);
  const totalViews = sum("views");
  const totalEngagement = sum("likes") + sum("collects") + sum("comments") + sum("shares");
  const top = [...synced].sort((a, b) => (b.latest.metrics.qualityScore || 0) - (a.latest.metrics.qualityScore || 0))[0] || null;
  const byAccount = new Map();
  synced.forEach(r => {
    const key = r.acc?.name || "未归属账号";
    const cur = byAccount.get(key) || { name: key, count: 0, views: 0, engagement: 0, score: 0 };
    cur.count++;
    cur.views += r.latest.metrics.views || 0;
    cur.engagement += (r.latest.metrics.likes || 0) + (r.latest.metrics.collects || 0) + (r.latest.metrics.comments || 0) + (r.latest.metrics.shares || 0);
    cur.score += r.latest.metrics.qualityScore || 0;
    byAccount.set(key, cur);
  });
  const accounts = [...byAccount.values()].map(x => ({ ...x, score: Math.round(x.score / Math.max(1, x.count)) }))
    .sort((a, b) => b.score - a.score || b.views - a.views);
  const tagMap = new Map();
  synced.forEach(r => (r.link.tags || []).forEach(tag => {
    const cur = tagMap.get(tag) || { tag, count: 0, score: 0 };
    cur.count++;
    cur.score += r.latest.metrics.qualityScore || 0;
    tagMap.set(tag, cur);
  }));
  const tags = [...tagMap.values()].map(x => ({ ...x, score: Math.round(x.score / Math.max(1, x.count)) }))
    .sort((a, b) => b.score - a.score).slice(0, 8);
  return {
    total: rows.length,
    synced: synced.length,
    pending: rows.filter(r => r.link.status === "pending" || r.link.status === "syncing").length,
    failed: rows.filter(r => r.link.status === "failed" || r.link.status === "unsupported").length,
    totalViews,
    totalEngagement,
    engagementRate: totalViews ? totalEngagement / totalViews : 0,
    avgScore: synced.length ? Math.round(synced.reduce((n, r) => n + (r.latest.metrics.qualityScore || 0), 0) / synced.length) : 0,
    top,
    accounts,
    tags
  };
}

export function buildLocalInsight(rows = analyticsRows()) {
  const summary = analyticsSummary(rows);
  const top = summary.top;
  const strongTag = summary.tags[0]?.tag || "效率痛点";
  const topAccount = summary.accounts[0]?.name || "表现较好的账号";
  const weakRows = rows.filter(r => r.latest && r.latest.metrics.qualityScore < 58).slice(0, 3);
  const rules = [
    {
      type: "topic",
      rule: `下一批优先做「${strongTag}」相关的清单、避坑、前后对比型选题。`,
      evidence: summary.tags[0] ? `${strongTag} 平均得分 ${summary.tags[0].score}` : "当前样本里清单/效率类反馈更稳定",
      confidence: 0.76
    },
    {
      type: "script",
      rule: "脚本前三秒直接给结果或反差结论，第二个画面进入产品界面或真实办公场景。",
      evidence: top ? `最高分内容「${top.link.title || top.asset?.name || "未命名"}」质量分 ${top.latest.metrics.qualityScore}` : "行业复盘规则",
      confidence: 0.72
    },
    {
      type: "copy",
      rule: "标题减少品牌名堆叠，优先用省时间、少踩坑、步骤数、对比结果表达价值。",
      evidence: "评论样本更关注可复制步骤和具体收益",
      confidence: 0.7
    }
  ];
  if (weakRows.length) {
    rules.push({
      type: "visual",
      rule: "低分内容优先检查封面信息密度，减少小字堆叠，第一屏只保留一个明确痛点。",
      evidence: `${weakRows.length} 条内容质量分低于 58`,
      confidence: 0.65
    });
  }
  return {
    id: uid(),
    createdAt: Date.now(),
    range: "latest",
    title: "小红书数据检测复盘",
    summary: summary.synced
      ? `${summary.synced} 条已检测内容，平均质量分 ${summary.avgScore}，总互动率 ${(summary.engagementRate * 100).toFixed(1)}%。${top ? `当前最好的是「${top.link.title || top.asset?.name || "未命名"}」。` : ""}`
      : "还没有可复盘的数据，先同步已回传的小红书链接。",
    nextTopics: [
      `${topAccount} 延展一批同类痛点的系列选题`,
      `围绕「${strongTag}」做 3 条清单/避坑/对比内容`,
      "把用户评论里的操作疑问转成步骤型脚本"
    ],
    scriptAdvice: [
      "开头 3 秒给结果，不先解释产品背景",
      "每条内容只打一个核心痛点",
      "中段加入具体数字、操作前后对比或真实文件场景"
    ],
    rules,
    source: "local-robot",
    linkedSnapshotIds: rows.map(r => r.latest?.id).filter(Boolean)
  };
}

export function saveInsightReport(report) {
  state.insightReports.unshift(report);
  if (state.insightReports.length > 40) state.insightReports.length = 40;
  save("insightReports");
  return report;
}

export function commitReportToMemory(report) {
  if (!report?.rules?.length) return 0;
  let n = 0;
  report.rules.forEach(rule => {
    const existing = state.creativeMemory.find(m => m.status === "active" && m.type === rule.type && m.rule === rule.rule);
    if (existing) {
      existing.updatedAt = Date.now();
      existing.confidence = Math.max(existing.confidence || 0, rule.confidence || 0.6);
      existing.evidence = rule.evidence || existing.evidence;
      return;
    }
    state.creativeMemory.unshift({
      id: uid(),
      scope: "platform",
      platform: "小红书",
      type: rule.type || "general",
      rule: rule.rule,
      evidence: rule.evidence || report.summary || "",
      confidence: rule.confidence || 0.6,
      sourceReportId: report.id,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    n++;
  });
  if (state.creativeMemory.length > 120) state.creativeMemory.length = 120;
  save("creativeMemory");
  if (n) notify("analytics", "创作记忆已更新", `${n} 条复盘规则会进入下一批创作上下文`);
  return n;
}

export function getCreativeMemoryContext({ account = null, platform = "" } = {}) {
  const plat = platform || account?.platform || "";
  const items = state.creativeMemory
    .filter(m => m.status !== "deprecated")
    .filter(m => !m.platform || !plat || m.platform === plat)
    .filter(m => !m.accountId || !account || m.accountId === account.id)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 6);
  if (!items.length) return "";
  return "【历史数据复盘记忆】\n" + items.map((m, i) => `${i + 1}. ${m.rule}（依据：${m.evidence || "历史表现"}；置信度：${Math.round((m.confidence || 0.6) * 100)}%）`).join("\n");
}

export function memoryStats() {
  const active = state.creativeMemory.filter(m => m.status !== "deprecated");
  return {
    active: active.length,
    topic: active.filter(m => m.type === "topic").length,
    script: active.filter(m => m.type === "script").length,
    copy: active.filter(m => m.type === "copy").length
  };
}
